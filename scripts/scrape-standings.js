// scrape-standings.js
//
// Récupère la page de classement FFBS/WBSC via un navigateur headless
// (Playwright), repère le tableau des résultats, et écrit un fichier
// JSON exploitable (data/standings.json).
//
// Pourquoi un navigateur headless et pas une simple requête HTTP ?
// Le site FFBS/WBSC bloque les requêtes qui ne ressemblent pas à un
// vrai visiteur (protection anti-robot, erreur "403 Forbidden").
// Playwright ouvre une page comme le ferait Chrome, ce qui contourne
// ce blocage.
//
// Le script reste "générique" : il ne cible pas des classes CSS
// précises (qui peuvent changer sans prévenir) mais cherche le plus
// grand tableau HTML de la page, en supposant que la première ligne
// contient les en-têtes de colonnes.
//
// Si le site change de structure (ex: classement affiché autrement
// qu'avec une balise <table>), il faudra adapter la fonction
// extractStandingsTable().

import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL =
  "https://ffbs.wbsc.org/fr/events/2026-championnat-de-france-division-2-baseball/standings";

const OUTPUT_PATH = path.join(process.cwd(), "data", "standings.json");

async function fetchHtmlViaBrowser(url) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      locale: "fr-FR",
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // On attend qu'au moins un tableau soit présent sur la page
    // (le classement est probablement chargé dynamiquement en JS).
    await page.waitForSelector("table", { timeout: 15000 }).catch(() => {
      // Si aucun tableau n'apparaît, on continue quand même : le
      // message d'erreur plus bas sera plus clair pour diagnostiquer.
    });

    return await page.content();
  } finally {
    await browser.close();
  }
}

function extractStandingsTable(html) {
  // On réutilise cheerio pour parser le HTML final (après exécution JS).
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
      "Aucun tableau trouvé sur la page. La structure du site a peut-être changé — vérifie manuellement l'URL source."
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
    const cells = $(row)
      .find("th, td")
      .map((_, cell) => $(cell).text().trim())
      .get();

    const entry = {};
    headers.forEach((header, i) => {
      const key = header || `colonne_${i + 1}`;
      entry[key] = cells[i] ?? "";
    });
    return entry;
  });

  return { headers, teams };
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtmlViaBrowser(SOURCE_URL);

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
