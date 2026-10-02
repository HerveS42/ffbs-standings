// scrape-team-u18.js
//
// Récupère la page d'une équipe FFBS/WBSC (U18) : roster, entraîneurs
// (tableaux <table>, repérés via le titre de section précédent), et
// rencontres (blocs <div class="game-row">, pas un tableau).
//
// Écrit deux fichiers JSON :
//   - data/roster-u18.json   → { players: {...}, coaches: {...} }
//   - data/results-u18.json  → { headers, entries }
//
// Particularité pour cette équipe : son nom officiel sur le site FFBS
// ("Clermont/Meyzieu/Nord Isère") est renommé en "Meyzieu/Clermont-
// Ferrand" partout où il apparaît dans les résultats (équipe
// visiteuse/recevante).
//
// Même logique que les autres scripts : passage par le relais
// Cloudflare Worker pour contourner la protection CloudFront/WAF du
// site.

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL =
  "https://ffbs.wbsc.org/fr/events/2026-coupe-de-france-baseball-18u/teams/45415";

const ROSTER_OUTPUT_PATH = path.join(process.cwd(), "data", "roster-u18.json");
const RESULTS_OUTPUT_PATH = path.join(process.cwd(), "data", "results-u18.json");

const WORKER_URL = process.env.WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

// Nom officiel sur le site FFBS -> nom à afficher sur notre site.
// On compare sur un extrait du nom ("Nord Isère") plutôt que sur le
// texte exact, au cas où la ponctuation/les espaces diffèrent
// légèrement d'une page à l'autre.
function renameTeam(name) {
  if (typeof name === "string" && name.includes("Nord Isère")) {
    return "Meyzieu/Clermont-Ferrand";
  }
  return name;
}

const HEADING_KEYWORD_SETS = {
  players: ["roster"],
  coaches: ["entraineur", "coach"],
};

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
    .replace(/[\u0300-\u036f]/g, "");
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

// --- Extraction des rencontres (blocs div.game-row) ---

function extractResults($) {
  const gameRows = $(".game-row").toArray();
  if (gameRows.length === 0) return null;

  const entries = gameRows
    .map((row) => {
      const $row = $(row);

      const link = $row.find("a").first().attr("href") || "";

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

      const visitorTeam = teams["Visiteurs"] || teams["Visitor"] || "";
      const homeTeam = teams["Recevant"] || teams["Home"] || "";

      return {
        Date: date,
        Match: matchLabel,
        Visiteurs: renameTeam(visitorTeam),
        "Score visiteurs": awayScore,
        Recevant: renameTeam(homeTeam),
        "Score recevant": homeScore,
        Lien: link,
      };
    })
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
  await writeFile("debug/team-page-u18.html", html, "utf-8");
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
      "Aucune rencontre trouvée — fichier results-u18.json non mis à jour."
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
