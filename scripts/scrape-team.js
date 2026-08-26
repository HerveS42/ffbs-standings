// scrape-team.js
//
// Récupère la page d'une équipe FFBS/WBSC. Cette page contient :
//   - un tableau <table> "Roster" (joueurs)
//   - un tableau <table> "Entraineurs"
//   - une liste de blocs <div class="game-row"> "Rencontres" (PAS un
//     tableau HTML, structure différente à extraire spécifiquement)
//
// Le script écrit deux fichiers JSON :
//   - data/roster.json   → { players: {...}, coaches: {...} }
//   - data/results.json  → { headers, entries }
//
// Joueurs et entraîneurs sont regroupés dans le même fichier
// roster.json (deux sections distinctes) car ils s'affichent sur la
// même page côté site : le roster, avec les entraîneurs juste en
// dessous.
//
// Même logique que scrape-standings.js : passage par ScraperAPI pour
// contourner la protection CloudFront/WAF du site, une seule requête
// par exécution (1x/jour) pour économiser les crédits API.
//
// La clé API est lue depuis la variable d'environnement
// SCRAPER_API_KEY (secret GitHub Actions).

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL =
  "https://ffbs.wbsc.org/fr/events/2026-championnat-de-france-division-2-baseball/teams/40182";

const ROSTER_OUTPUT_PATH = path.join(process.cwd(), "data", "roster.json");
const RESULTS_OUTPUT_PATH = path.join(process.cwd(), "data", "results.json");

const WORKER_URL = process.env.WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

// Mots-clés (en minuscules, sans accents) recherchés dans les titres
// de section qui précèdent chaque tableau sur la page (ex: "Roster",
// "Entraîneurs"). C'est la méthode principale de détection, plus
// fiable que les en-têtes de colonnes.
const HEADING_KEYWORD_SETS = {
  players: ["roster"],
  coaches: ["entraineur", "coach"],
};

// Mots-clés de repli, recherchés dans les en-têtes de colonnes si
// aucun titre de section n'a pu être associé à un tableau.
const COLUMN_KEYWORD_SETS = {
  players: [
    "poste",
    "position",
    "taille",
    "poids",
    "naissance",
    "numero",
    "bat",
    "lance",
    "joueur",
  ],
  coaches: ["entraineur", "coach", "role", "fonction", "staff"],
};

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // retire les accents
}

async function fetchHtmlViaWorker(url) {
  if (!WORKER_URL || !WORKER_SECRET) {
    throw new Error(
      "Les variables d'environnement WORKER_URL et/ou WORKER_SECRET ne sont pas définies. Vérifie qu'elles sont bien configurées dans les secrets GitHub Actions."
    );
  }

  const relayUrl = new URL(WORKER_URL);
  relayUrl.searchParams.set("url", url);
  relayUrl.searchParams.set("key", WORKER_SECRET);

  const response = await fetch(relayUrl.toString());

  if (!response.ok) {
    throw new Error(
      `Échec du chargement de la page via le relais Cloudflare (${response.status} ${response.statusText})`
    );
  }

  return response.text();
}

// --- Extraction du roster et des entraîneurs (tableaux <table>) ---

function extractTableData($, table) {
  const rows = $(table).find("tr").toArray();
  if (rows.length < 2) return null;

  const headers = $(rows[0])
    .find("th, td")
    .map((_, cell) => $(cell).text().replace(/\s+/g, " ").trim())
    .get();

  const entries = rows.slice(1).map((row) => {
    let cells = $(row)
      .find("th, td")
      .map((_, cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .get();

    while (cells.length > headers.length) {
      const emptyIndex = cells.findIndex((cell) => cell === "");
      if (emptyIndex === -1) {
        cells = cells.slice(0, headers.length);
        break;
      }
      cells.splice(emptyIndex, 1);
    }

    const entry = {};
    headers.forEach((header, i) => {
      const key = header || `colonne_${i + 1}`;
      entry[key] = cells[i] ?? "";
    });
    return entry;
  });

  return { headers, entries };
}

function scoreHeadersAgainstKeywords(headers, keywords) {
  const normalizedHeaders = headers.map(normalize).join(" ");
  return keywords.reduce(
    (score, keyword) => score + (normalizedHeaders.includes(keyword) ? 1 : 0),
    0
  );
}

function scoreTextAgainstKeywords(text, keywords) {
  const normalizedText = normalize(text);
  return keywords.reduce(
    (score, keyword) => score + (normalizedText.includes(keyword) ? 1 : 0),
    0
  );
}

// Parcourt le document dans l'ordre et associe à chaque <table> le
// titre de section le plus proche qui le précède (ex: un <h3>
// "Roster", "Entraineurs"...).
function findPrecedingHeadingForEachTable($) {
  const relevantSelector =
    "h1, h2, h3, h4, h5, h6, strong, b, legend, caption, table";
  const elements = $(relevantSelector).toArray();

  const tableToHeading = new Map();
  let currentHeadingText = "";

  for (const el of elements) {
    if (el.tagName === "table") {
      tableToHeading.set(el, currentHeadingText);
    } else {
      const text = $(el).text().trim();
      if (text && text.length < 60) {
        currentHeadingText = text;
      }
    }
  }

  return tableToHeading;
}

// Associe chaque tableau candidat à la catégorie (players / coaches)
// pour laquelle il obtient le meilleur score, sans jamais assigner
// deux catégories différentes au même tableau ni la même catégorie à
// deux tableaux différents. On priorise le titre de section précédent
// (plus fiable), et on se rabat sur les en-têtes de colonnes si aucun
// titre ne correspond.
function assignTablesToCategories(candidates, headingsByTable) {
  const categories = Object.keys(HEADING_KEYWORD_SETS);

  const scores = candidates.map(({ table, data }) => {
    const headingText = headingsByTable.get(table) || "";
    const perCategory = {};
    for (const category of categories) {
      const headingScore = scoreTextAgainstKeywords(
        headingText,
        HEADING_KEYWORD_SETS[category]
      );
      const columnScore = scoreHeadersAgainstKeywords(
        data.headers,
        COLUMN_KEYWORD_SETS[category]
      );
      perCategory[category] = headingScore * 10 + columnScore;
    }
    return perCategory;
  });

  const assignment = {};
  const usedTableIndexes = new Set();

  for (const category of categories) {
    let bestIndex = -1;
    let bestScore = 0;

    candidates.forEach((_, index) => {
      if (usedTableIndexes.has(index)) return;
      if (scores[index][category] > bestScore) {
        bestScore = scores[index][category];
        bestIndex = index;
      }
    });

    if (bestIndex !== -1) {
      assignment[category] = candidates[bestIndex].data;
      usedTableIndexes.add(bestIndex);
    } else {
      assignment[category] = null;
    }
  }

  return assignment;
}

function extractPlayersAndCoaches($) {
  const tables = $("table").toArray();
  if (tables.length === 0) return { players: null, coaches: null };

  const headingsByTable = findPrecedingHeadingForEachTable($);

  const candidates = tables
    .map((table) => ({ table, data: extractTableData($, table) }))
    .filter(({ data }) => data !== null);

  return assignTablesToCategories(candidates, headingsByTable);
}

// --- Extraction des rencontres (blocs div.game-row, pas un tableau) ---

function extractResults($) {
  const gameRows = $(".game-row").toArray();
  if (gameRows.length === 0) return null;

  const entries = gameRows
    .map((row) => {
      const $row = $(row);

      const link = $row.find("a").first().attr("href") || "";

      // Les deux blocs "équipe" (visiteurs / recevant), en excluant
      // le bloc central qui affiche le score (il partage certaines
      // classes CSS avec les blocs équipe).
      const teamBlocks = $row
        .find(".text-center.col-xs-4")
        .filter((_, el) => !$(el).hasClass("game-score"))
        .toArray();

      const teams = {};
      teamBlocks.forEach((block) => {
        const label = $(block).find(".home-away-label").text().trim();
        const teamName = $(block).find(".team-name").text().trim();
        if (label) teams[label] = teamName;
      });

      // Dans le bloc central : un texte de match (ex: "#1 D20101"),
      // le score (deux <span> avec des classes commençant par "away"
      // et "home"), et la date.
      const scoreBlock = $row.find(".game-score");
      const scoreParagraphs = scoreBlock
        .find("p")
        .map((_, el) => $(el).text().trim())
        .get();
      const matchLabel = scoreParagraphs[0] || "";
      const date = scoreParagraphs[1] || "";

      const awayScore = scoreBlock
        .find('span[class^="away"]')
        .first()
        .text()
        .trim();
      const homeScore = scoreBlock
        .find('span[class^="home"]')
        .first()
        .text()
        .trim();

      return {
        Date: date,
        Match: matchLabel,
        Visiteurs: teams["Visiteurs"] || "",
        "Score visiteurs": awayScore,
        Recevant: teams["Recevant"] || "",
        "Score recevant": homeScore,
        Lien: link,
      };
    })
    // On ignore les lignes qui n'ont visiblement pas pu être lues
    // correctement (aucune équipe identifiée).
    .filter((entry) => entry.Visiteurs || entry.Recevant);

  if (entries.length === 0) return null;

  return {
    headers: [
      "Date",
      "Match",
      "Visiteurs",
      "Score visiteurs",
      "Recevant",
      "Score recevant",
      "Lien",
    ],
    entries,
  };
}

// --- Sauvegarde ---

async function saveDebugFile(html) {
  await mkdir("debug", { recursive: true });
  await writeFile("debug/team-page.html", html, "utf-8");
}

async function writeRosterOutput(players, coaches, sourceUrl) {
  await mkdir(path.dirname(ROSTER_OUTPUT_PATH), { recursive: true });

  const output = {
    source: sourceUrl,
    updatedAt: new Date().toISOString(),
    players: players
      ? { headers: players.headers, entries: players.entries }
      : { headers: [], entries: [] },
    coaches: coaches
      ? { headers: coaches.headers, entries: coaches.entries }
      : { headers: [], entries: [] },
  };

  if (!players) {
    console.warn("Aucune correspondance trouvée pour le roster des joueurs.");
  }
  if (!coaches) {
    console.warn("Aucune correspondance trouvée pour les entraîneurs.");
  }

  await writeFile(
    ROSTER_OUTPUT_PATH,
    JSON.stringify(output, null, 2),
    "utf-8"
  );
  console.log(
    `Écrit dans ${ROSTER_OUTPUT_PATH} (${output.players.entries.length} joueurs, ${output.coaches.entries.length} entraîneurs)`
  );
}

async function writeResultsOutput(results, sourceUrl) {
  await mkdir(path.dirname(RESULTS_OUTPUT_PATH), { recursive: true });

  if (!results) {
    console.warn(
      "Aucune rencontre trouvée — fichier results.json non mis à jour."
    );
    return;
  }

  const output = {
    source: sourceUrl,
    updatedAt: new Date().toISOString(),
    headers: results.headers,
    entries: results.entries,
  };

  await writeFile(
    RESULTS_OUTPUT_PATH,
    JSON.stringify(output, null, 2),
    "utf-8"
  );
  console.log(
    `Écrit dans ${RESULTS_OUTPUT_PATH} (${results.entries.length} rencontres)`
  );
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtmlViaWorker(SOURCE_URL);

  await saveDebugFile(html);

  const $ = cheerio.load(html);

  const { players, coaches } = extractPlayersAndCoaches($);
  const results = extractResults($);

  await writeRosterOutput(players, coaches, SOURCE_URL);
  await writeResultsOutput(results, SOURCE_URL);
}

main().catch((error) => {
  console.error(
    "Erreur lors de la récupération du roster/des résultats :",
    error
  );
  process.exit(1);
});
