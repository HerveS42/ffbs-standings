// scrape-standings-u18.js
//
// Récupère la page de classement FFBS/WBSC (U18) via le relais
// Cloudflare Worker. Contrairement aux autres compétitions (D2, R1,
// R3) qui n'ont qu'un seul tableau de classement, cette page U18 est
// divisée en plusieurs POULES (Nord-Ouest, Nord-Est, Sud-Ouest,
// Sud-Est), chacune avec son propre tableau. On extrait donc TOUS les
// tableaux de la page, pas seulement le plus grand, en identifiant le
// nom de chaque poule via le titre de section qui précède son
// tableau.
//
// Notre équipe (Meyzieu/Clermont-Ferrand) évolue dans la poule
// Sud-Est : on le signale explicitement dans le JSON de sortie
// (teamPool: "Sud-Est") pour que la page du site puisse la mettre en
// avant par défaut.

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL =
  "https://ffbs.wbsc.org/fr/events/2026-coupe-de-france-baseball-18u/standings";

const OUTPUT_PATH = path.join(process.cwd(), "data", "standings-u18.json");

// Nom (tel qu'affiché sur le site) de la poule de notre équipe.
const TEAM_POOL_NAME = "Sud-Est";

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

// Repère, pour chaque <table> de la page, le titre de section le plus
// proche qui le précède (ex: un <h3> "Poule Sud-Est"). Même logique
// que celle utilisée pour distinguer Roster / Entraîneurs sur les
// pages équipe.
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

function extractOneTable($, table) {
  const rows = $(table).find("tr").toArray();
  if (rows.length < 2) return null;

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

function extractAllPools(html) {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();

  if (tables.length === 0) {
    throw new Error(
      "Aucun tableau trouvé sur la page. La structure du site a peut-être changé — vérifie le fichier de debug (debug/page-u18.html) pour diagnostiquer."
    );
  }

  const headingsByTable = findPrecedingHeadingForEachTable($);

  const pools = [];
  for (const table of tables) {
    const extracted = extractOneTable($, table);
    if (!extracted) continue;

    const poolName = headingsByTable.get(table) || `Poule ${pools.length + 1}`;
    pools.push({
      name: poolName,
      headers: extracted.headers,
      teams: extracted.teams,
    });
  }

  return pools;
}

async function saveDebugFile(html) {
  await mkdir("debug", { recursive: true });
  await writeFile("debug/page-u18.html", html, "utf-8");
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtmlViaWorker(SOURCE_URL);

  await saveDebugFile(html);

  const pools = extractAllPools(html);

  console.log(`${pools.length} poule(s) trouvée(s) :`);
  pools.forEach((pool) => {
    console.log(`  - "${pool.name}" (${pool.teams.length} équipes)`);
  });

  const output = {
    source: SOURCE_URL,
    updatedAt: new Date().toISOString(),
    teamPool: TEAM_POOL_NAME,
    pools,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");

  console.log(`\nClassement écrit dans ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("Erreur lors de la récupération du classement :", error);
  process.exit(1);
});
