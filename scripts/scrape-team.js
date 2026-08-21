// scrape-team.js
//
// Récupère la page d'une équipe FFBS/WBSC (roster + résultats des
// rencontres), identifie automatiquement quel tableau est le roster
// et lequel est les résultats (grâce à des mots-clés dans les
// en-têtes de colonnes), et écrit deux fichiers JSON séparés :
// data/roster.json et data/results.json.
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

// Mots-clés (en minuscules, sans accents) utilisés pour deviner quel
// tableau correspond au roster et lequel correspond aux résultats.
// Si la détection automatique se trompe, il suffit d'ajuster ces
// listes.
const ROSTER_KEYWORDS = [
  "nom",
  "poste",
  "position",
  "taille",
  "poids",
  "naissance",
  "numero",
  "bat",
  "lance",
  "joueur",
];

const RESULTS_KEYWORDS = [
  "date",
  "adversaire",
  "score",
  "lieu",
  "resultat",
  "domicile",
  "exterieur",
  "match",
];

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

function extractRosterAndResults(html) {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();

  if (tables.length === 0) {
    throw new Error(
      "Aucun tableau trouvé sur la page. La structure du site a peut-être changé — vérifie le fichier de debug (debug/team-page.html) pour diagnostiquer."
    );
  }

  // On extrait toutes les tables, puis on classe chacune selon son
  // score de correspondance avec les mots-clés roster / résultats.
  const candidates = tables
    .map((table) => extractTableData($, table))
    .filter((data) => data !== null);

  let bestRoster = null;
  let bestRosterScore = -1;
  let bestResults = null;
  let bestResultsScore = -1;

  for (const candidate of candidates) {
    const rosterScore = scoreHeadersAgainstKeywords(
      candidate.headers,
      ROSTER_KEYWORDS
    );
    const resultsScore = scoreHeadersAgainstKeywords(
      candidate.headers,
      RESULTS_KEYWORDS
    );

    if (rosterScore > bestRosterScore) {
      bestRosterScore = rosterScore;
      bestRoster = candidate;
    }
    if (resultsScore > bestResultsScore) {
      bestResultsScore = resultsScore;
      bestResults = candidate;
    }
  }

  return {
    roster: bestRosterScore > 0 ? bestRoster : null,
    results: bestResultsScore > 0 ? bestResults : null,
  };
}

async function saveDebugFile(html) {
  await mkdir("debug", { recursive: true });
  await writeFile("debug/team-page.html", html, "utf-8");
}

async function writeJsonOutput(outputPath, table, sourceUrl) {
  await mkdir(path.dirname(outputPath), { recursive: true });

  if (!table) {
    console.warn(
      `Aucune correspondance trouvée pour ${outputPath} — fichier non mis à jour.`
    );
    return;
  }

  const output = {
    source: sourceUrl,
    updatedAt: new Date().toISOString(),
    headers: table.headers,
    entries: table.entries,
  };

  await writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Écrit dans ${outputPath} (${table.entries.length} lignes)`);
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtmlViaScraperApi(SOURCE_URL);

  await saveDebugFile(html);

  const { roster, results } = extractRosterAndResults(html);

  await writeJsonOutput(ROSTER_OUTPUT_PATH, roster, SOURCE_URL);
  await writeJsonOutput(RESULTS_OUTPUT_PATH, results, SOURCE_URL);
}

main().catch((error) => {
  console.error(
    "Erreur lors de la récupération du roster/des résultats :",
    error
  );
  process.exit(1);
});
