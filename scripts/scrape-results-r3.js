// scrape-results-r3.js
//
// Récupère la page "schedule-and-results" de la Régionale 3. Cette
// page est construite avec Inertia.js : au lieu d'un tableau HTML
// classique ou de blocs répétés, TOUTES les données de la saison
// (chaque match, avec équipes, scores, date, identifiant) sont
// embarquées dans un attribut data-page (au format JSON) sur la
// balise <div id="app">. C'est une source de données bien plus
// fiable que du HTML à parser : pas de risque de ne récupérer que
// les matchs d'une seule date affichée par défaut.
//
// On extrait ce JSON, on lit props.games (liste de tous les matchs
// de la compétition), puis on filtre pour ne garder que ceux
// impliquant l'équipe dont le code est "ALB".
//
// Même logique que les autres scripts : passage par ScraperAPI pour
// contourner la protection CloudFront/WAF du site.

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL =
  "https://ffbs.wbsc.org/en/events/2026-auvergne-rhone-alpes-championnat-r3-baseball-2026/schedule-and-results";

const TEAM_CODE = "ALB";

const RESULTS_OUTPUT_PATH = path.join(
  process.cwd(),
  "data",
  "results-r3.json"
);

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

// Extrait le JSON Inertia embarqué dans l'attribut data-page de
// <div id="app">. Cheerio décode automatiquement les entités HTML
// (&quot; etc.) lorsqu'on lit un attribut avec .attr(), donc le
// texte récupéré est directement du JSON valide.
function extractInertiaGames(html) {
  const $ = cheerio.load(html);
  const dataPageRaw = $("#app").attr("data-page");

  if (!dataPageRaw) {
    throw new Error(
      "Impossible de trouver l'attribut data-page sur #app. La structure de la page a peut-être changé — vérifie le fichier de debug (debug/results-r3-page.html) pour diagnostiquer."
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(dataPageRaw);
  } catch (error) {
    throw new Error(
      `Le contenu de data-page n'est pas du JSON valide : ${error.message}`
    );
  }

  const games = parsed?.props?.games;
  if (!Array.isArray(games)) {
    throw new Error(
      "La structure JSON attendue (props.games) est introuvable — le format de la page a peut-être changé."
    );
  }

  return games;
}

function formatDate(startDate) {
  // startDate est au format "YYYY-MM-DD HH:MM:SS" -> on ne garde que
  // la date, au format DD/MM/YYYY (cohérent avec les autres pages).
  const datePart = (startDate || "").split(" ")[0];
  const [year, month, day] = datePart.split("-");
  if (!year || !month || !day) return startDate || "";
  return `${day}/${month}/${year}`;
}

function toResultEntry(game, sourceUrl) {
  const boxScoreUrl = `${sourceUrl}/box-score/${game.id}`;

  return {
    Date: formatDate(game.start_date || game.start),
    Match: `#${game.gamenumber ?? ""} ${game.gamecode ?? ""}`.trim(),
    Visiteurs: game.awaylabel || game.awayioc || "",
    "Score visiteurs":
      game.awayruns !== undefined && game.awayruns !== null
        ? String(game.awayruns)
        : "",
    Recevant: game.homelabel || game.homeioc || "",
    "Score recevant":
      game.homeruns !== undefined && game.homeruns !== null
        ? String(game.homeruns)
        : "",
    Lien: boxScoreUrl,
  };
}

function filterByTeam(games, teamCode) {
  return games.filter(
    (game) => game.homeioc === teamCode || game.awayioc === teamCode
  );
}

async function saveDebugFile(html) {
  await mkdir("debug", { recursive: true });
  await writeFile("debug/results-r3-page.html", html, "utf-8");
}

async function writeResultsOutput(entries, sourceUrl) {
  await mkdir(path.dirname(RESULTS_OUTPUT_PATH), { recursive: true });

  if (entries.length === 0) {
    console.warn(
      `Aucune rencontre trouvée pour l'équipe ${TEAM_CODE} — fichier results-r3.json non mis à jour.`
    );
    return;
  }

  const output = {
    source: sourceUrl,
    updatedAt: new Date().toISOString(),
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

  await writeFile(
    RESULTS_OUTPUT_PATH,
    JSON.stringify(output, null, 2),
    "utf-8"
  );
  console.log(
    `Écrit dans ${RESULTS_OUTPUT_PATH} (${entries.length} rencontres pour ${TEAM_CODE})`
  );
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtmlViaWorker(SOURCE_URL);

  await saveDebugFile(html);

  const allGames = extractInertiaGames(html);
  console.log(`Total de rencontres trouvées dans la saison : ${allGames.length}`);

  const teamGames = filterByTeam(allGames, TEAM_CODE);
  console.log(`Rencontres impliquant ${TEAM_CODE} : ${teamGames.length}`);

  // On trie par date pour un affichage chronologique.
  teamGames.sort((a, b) => {
    const dateA = a.start_date || a.start || "";
    const dateB = b.start_date || b.start || "";
    return dateA.localeCompare(dateB);
  });

  const entries = teamGames.map((game) => toResultEntry(game, SOURCE_URL));

  await writeResultsOutput(entries, SOURCE_URL);
}

main().catch((error) => {
  console.error("Erreur lors de la récupération des résultats R3 :", error);
  process.exit(1);
});
