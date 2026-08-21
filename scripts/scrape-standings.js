// scrape-standings.js
//
// Récupère la page de classement FFBS/WBSC (via ScraperAPI, qui
// contourne la protection CloudFront/WAF du site en passant par une
// adresse IP "normale"), repère le tableau des résultats, et écrit
// un fichier JSON exploitable (data/standings.json).
//
// Pourquoi ScraperAPI et pas une requête directe ?
// Le site FFBS/WBSC bloque toutes les requêtes provenant d'adresses
// IP de datacenter (dont celles de GitHub Actions), quel que soit le
// navigateur utilisé. ScraperAPI route la requête via des IP
// résidentielles/non bloquées et gère l'affichage complet de la page
// (y compris le JavaScript) à notre place.
//
// La clé API est lue depuis la variable d'environnement
// SCRAPER_API_KEY (configurée comme "secret" GitHub, jamais écrite
// en clair dans ce fichier).
//
// Le script reste "générique" pour l'extraction : il ne cible pas
// des classes CSS précises (qui peuvent changer sans prévenir) mais
// cherche le plus grand tableau HTML de la page, en supposant que la
// première ligne contient les en-têtes de colonnes.
//
// Si le site change de structure (ex: classement affiché autrement
// qu'avec une balise <table>), il faudra adapter la fonction
// extractStandingsTable() — les fichiers de debug (capture d'écran +
// HTML) générés à chaque exécution en échec aident à diagnostiquer.

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL =
  "https://ffbs.wbsc.org/fr/events/2026-championnat-de-france-division-2-baseball/standings";

const OUTPUT_PATH = path.join(process.cwd(), "data", "standings.json");

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;

async function fetchHtmlViaScraperApi(url) {
  if (!SCRAPER_API_KEY) {
    throw new Error(
      "La variable d'environnement SCRAPER_API_KEY n'est pas définie. Vérifie qu'elle est bien configurée dans les secrets GitHub Actions."
    );
  }

  const apiUrl = new URL("https://api.scraperapi.com/");
  apiUrl.searchParams.set("api_key", SCRAPER_API_KEY);
  apiUrl.searchParams.set("url", url);
  // render=true : ScraperAPI exécute le JavaScript de la page avant
  // de nous renvoyer le HTML final (nécessaire si le classement est
  // chargé dynamiquement).
  apiUrl.searchParams.set("render", "true");

  const response = await fetch(apiUrl.toString());

  if (!response.ok) {
    throw new Error(
      `Échec du chargement de la page via ScraperAPI (${response.status} ${response.statusText})`
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
      "Aucun tableau trouvé sur la page. La structure du site a peut-être changé — vérifie le fichier de debug (debug/page.html) pour diagnostiquer."
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

    // Certaines lignes du tableau contiennent une cellule "cachée"
    // sans équivalent dans l'en-tête (ex: une colonne logo d'équipe,
    // sans texte). Si on a plus de cellules que d'en-têtes, on
    // retire la première cellule vide en trop pour réaligner les
    // colonnes correctement.
    while (cells.length > headers.length) {
      const emptyIndex = cells.findIndex((cell) => cell === "");
      if (emptyIndex === -1) {
        // Aucune cellule vide identifiable : on tronque la fin par
        // sécurité plutôt que de mal aligner toute la ligne.
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

  return { headers, teams };
}

async function saveDebugFiles(html) {
  await mkdir("debug", { recursive: true });
  await writeFile("debug/page.html", html, "utf-8");
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtmlViaScraperApi(SOURCE_URL);

  // On sauvegarde toujours le HTML brut reçu, pratique pour
  // diagnostiquer si l'extraction échoue.
  await saveDebugFiles(html);

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
