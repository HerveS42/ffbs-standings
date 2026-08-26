// scrape-standings.js
//
// Récupère la page de classement FFBS/WBSC via un relais Cloudflare
// Worker (qui contourne la protection CloudFront/WAF du site en
// passant par une adresse IP différente de celles de GitHub
// Actions), repère le tableau des résultats, et écrit un fichier
// JSON exploitable (data/standings.json).
//
// Pourquoi un relais Cloudflare Worker et pas une requête directe ?
// Le site FFBS/WBSC bloque toutes les requêtes provenant d'adresses
// IP de datacenter (dont celles de GitHub Actions). Le Worker fait
// office d'intermédiaire : c'est lui qui va chercher la page, depuis
// l'infrastructure Cloudflare.
//
// Attention : contrairement à ScraperAPI (utilisé auparavant), ce
// relais NE PEUT PAS exécuter de JavaScript — il renvoie le HTML brut
// tel que le serveur l'envoie initialement. Ça fonctionne pour cette
// page de classement (les données sont présentes dès le chargement
// initial), mais si ce n'était pas le cas, il faudrait une autre
// solution.
//
// L'URL du Worker et son secret sont lus depuis les variables
// d'environnement WORKER_URL et WORKER_SECRET (configurées comme
// "secrets" GitHub, jamais écrites en clair dans ce fichier).
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
  "https://ffbs.wbsc.org/fr/events/2026-auvergne-rhone-alpes-championnat-r1-baseball/standings";

const OUTPUT_PATH = path.join(process.cwd(), "data", "standings-r1.json");

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
      "Aucun tableau trouvé sur la page. La structure du site a peut-être changé — vérifie le fichier de debug (debug/page-r1.html) pour diagnostiquer."
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
      let value = cells[i] ?? "";

      // La colonne "Equipe" contient le code d'équipe (ex: "MET")
      // suivi du nom complet (ex: "Metz Cometz"). On retire ce code
      // pour ne garder que le nom.
      if (key === "Equipe") {
        value = value.replace(/^[A-ZÀ-Ý0-9]{2,5}\s+/, "");
      }

      entry[key] = value;
    });
    return entry;
  });

  return { headers, teams };
}

async function saveDebugFiles(html) {
  await mkdir("debug", { recursive: true });
  await writeFile("debug/page-r1.html", html, "utf-8");
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtmlViaWorker(SOURCE_URL);

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
