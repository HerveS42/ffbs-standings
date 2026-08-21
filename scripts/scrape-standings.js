// scrape-standings.js
//
// Récupère la page de classement FFBS/WBSC, repère le tableau des
// résultats, et écrit un fichier JSON exploitable (data/standings.json).
//
// Le script est volontairement "générique" : il ne cible pas des
// classes CSS précises (qui peuvent changer sans prévenir) mais
// cherche le plus grand tableau HTML de la page, en supposant que
// la première ligne contient les en-têtes de colonnes.
//
// Si le site change de structure (ex: classement affiché autrement
// qu'avec une balise <table>), il faudra adapter la fonction
// extractStandingsTable().

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL =
  "https://ffbs.wbsc.org/fr/events/2026-championnat-de-france-division-2-baseball/standings";

const OUTPUT_PATH = path.join(process.cwd(), "data", "standings.json");

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      // Certains sites bloquent les requêtes sans en-tête "navigateur".
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      "Accept-Language": "fr-FR,fr;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Échec du chargement de la page (${response.status} ${response.statusText})`
    );
  }

  return response.text();
}

function extractStandingsTable(html) {
  const $ = cheerio.load(html);

  // On récupère tous les tableaux de la page et on garde le plus
  // "riche" (le plus de lignes) : c'est en général le classement.
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
      "Aucun tableau trouvé sur la page. La structure du site a peut-être changé — vérifie manuellement l'URL source."
    );
  }

  const rows = $(bestTable).find("tr").toArray();
  if (rows.length < 2) {
    throw new Error("Tableau trouvé mais il ne contient pas assez de lignes.");
  }

  // Première ligne = en-têtes de colonnes
  const headers = $(rows[0])
    .find("th, td")
    .map((_, cell) => $(cell).text().trim())
    .get();

  const teams = rows.slice(1).map((row) => {
    const cells = $(row)
      .find("th, td")
      .map((_, cell) => $(cell).text().trim())
      .get();

    const entry = {};
    headers.forEach((header, i) => {
      // Si l'en-tête est vide (icône, logo...), on nomme la colonne colonne_N
      const key = header || `colonne_${i + 1}`;
      entry[key] = cells[i] ?? "";
    });
    return entry;
  });

  return { headers, teams };
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtml(SOURCE_URL);

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

