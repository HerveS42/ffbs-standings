// scrape-standings-u18.js
//
// Récupère la page de classement FFBS/WBSC (U18) via le relais
// Cloudflare Worker, repère le tableau des résultats, et écrit un
// fichier JSON exploitable (data/standings-u18.json).
//
// Même logique que les scripts des autres compétitions (D2, R1, R3) :
// le relais Worker contourne la protection CloudFront/WAF du site,
// l'extraction est générique (plus grand tableau trouvé, réalignement
// des colonnes si une cellule vide en trop est présente, nettoyage du
// nom d'équipe en retirant le code en début de texte).

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL =
  "https://ffbs.wbsc.org/fr/events/2026-coupe-de-france-baseball-18u/standings";

const OUTPUT_PATH = path.join(process.cwd(), "data", "standings-u18.json");

const WORKER_URL = process.env.WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

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

function extractStandingsTable(html) {
  const $ = cheerio.load(html);

  let bestTable = null;
  let bestRowCount = 0;

  $("table").each((_, table) => {
    const rowCount = $(table).find("tr").length;
    if (rowCount > bestRowCount) {
      bestRowCount = rowCount;
      bestTable = table;
    }
  });

  if (!bestTable) {
    throw new Error(
      "Aucun tableau trouvé sur la page. La structure du site a peut-être changé — vérifie le fichier de debug (debug/page-u18.html) pour diagnostiquer."
    );
  }

  const rows = $(bestTable).find("tr").toArray();
  if (rows.length < 2) {
    throw new Error("Tableau trouvé mais il ne contient pas assez de lignes.");
  }

  const headers = $(rows[0])
    .find("th, td")
    .map((_, cell) => $(cell).text().trim())
    .get();

  const teams = rows.slice(1).map((row) => {
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
      let value = cells[i] ?? "";

      if (key === "Equipe") {
        value = value.replace(/^[A-ZÀ-Ý0-9]{2,5}\s+/, "");
      }

      entry[key] = value;
    });
    return entry;
  });

  return { headers, teams };
}

async function saveDebugFile(html) {
  await mkdir("debug", { recursive: true });
  await writeFile("debug/page-u18.html", html, "utf-8");
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtmlViaWorker(SOURCE_URL);

  await saveDebugFile(html);

  const { headers, teams } = extractStandingsTable(html);

  const output = {
    source: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    headers,
    teams,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");

  console.log(`Classement écrit dans ${OUTPUT_PATH} (${teams.length} équipes)`);
}

main().catch((error) => {
  console.error("Erreur lors de la récupération du classement :", error);
  process.exit(1);
});
