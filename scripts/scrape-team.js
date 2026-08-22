// scrape-team.js
//
// Récupère la page d'une équipe FFBS/WBSC. Cette page contient trois
// tableaux : le roster des joueurs, les entraîneurs, et les
// résultats des rencontres. Le script identifie automatiquement
// chaque tableau (grâce à des mots-clés dans les en-têtes de
// colonnes) et écrit deux fichiers JSON :
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

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;

// Mots-clés (en minuscules, sans accents) utilisés pour deviner à
// quelle catégorie appartient chaque tableau de la page. Si la
// détection automatique se trompe, il suffit d'ajuster ces listes.
const KEYWORD_SETS = {
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
  results: [
    "date",
    "adversaire",
    "score",
    "lieu",
    "resultat",
    "domicile",
    "exterieur",
    "match",
  ],
};

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // retire les accents
}

async function fetchHtmlViaScraperApi(url) {
  if (!SCRAPER_API_KEY) {
    throw new Error(
      "La variable d'environnement SCRAPER_API_KEY n'est pas définie. Vérifie qu'elle est bien configurée dans les secrets GitHub Actions."
    );
  }

  const apiUrl = new URL("https://api.scraperapi.com/");
  apiUrl.searchParams.set("api_key", SCRAPER_API_KEY);
  apiUrl.searchParams.set("url", url);
  apiUrl.searchParams.set("render", "true");

  const response = await fetch(apiUrl.toString());

  if (!response.ok) {
    throw new Error(
      `Échec du chargement de la page via ScraperAPI (${response.status} ${response.statusText})`
    );
  }

  return response.text();
}

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

    // Réalignement en cas de cellule vide en trop (ex: colonne
    // logo/icône sans en-tête correspondant), même logique que pour
    // le classement.
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

// Associe chaque tableau candidat à la catégorie (players / coaches /
// results) pour laquelle il obtient le meilleur score, sans jamais
// assigner deux catégories différentes au même tableau ni la même
// catégorie à deux tableaux différents.
function assignTablesToCategories(candidates) {
  const categories = Object.keys(KEYWORD_SETS);

  const scores = candidates.map((candidate) => {
    const perCategory = {};
    for (const category of categories) {
      perCategory[category] = scoreHeadersAgainstKeywords(
        candidate.headers,
        KEYWORD_SETS[category]
      );
    }
    return perCategory;
  });

  const assignment = {};
  const usedTableIndexes = new Set();

  for (const category of categories) {
    let bestIndex = -1;
    let bestScore = 0; // en dessous de 1, on considère qu'il n'y a pas de correspondance

    candidates.forEach((_, index) => {
      if (usedTableIndexes.has(index)) return;
      if (scores[index][category] > bestScore) {
        bestScore = scores[index][category];
        bestIndex = index;
      }
    });

    if (bestIndex !== -1) {
      assignment[category] = candidates[bestIndex];
      usedTableIndexes.add(bestIndex);
    } else {
      assignment[category] = null;
    }
  }

  return assignment;
}

function extractAllTables(html) {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();

  if (tables.length === 0) {
    throw new Error(
      "Aucun tableau trouvé sur la page. La structure du site a peut-être changé — vérifie le fichier de debug (debug/team-page.html) pour diagnostiquer."
    );
  }

  const candidates = tables
    .map((table) => extractTableData($, table))
    .filter((data) => data !== null);

  return assignTablesToCategories(candidates);
}

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
      "Aucune correspondance trouvée pour les résultats — fichier non mis à jour."
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
  const html = await fetchHtmlViaScraperApi(SOURCE_URL);

  await saveDebugFile(html);

  const { players, coaches, results } = extractAllTables(html);

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
