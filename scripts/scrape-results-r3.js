// scrape-results-r3.js
//
// Récupère la page "schedule-and-results" de la Régionale 3 (page à
// navigation par date, différente de la page équipe utilisée pour
// la Division 2 et la Régionale 1) et en extrait uniquement les
// rencontres de l'équipe dont le code est "ALB".
//
// Cette page utilise la même structure de blocs <div class="game-row">
// que la page équipe des autres compétitions (même plateforme WBSC),
// mais liste TOUTES les équipes de la compétition, réparties par
// date. On filtre donc après extraction pour ne garder que les
// matchs impliquant ALB.
//
// Important : si la navigation par date charge les rencontres de
// façon dynamique (une date à la fois, sans tout mettre dans le HTML
// initial), ce script ne récupérera que ce qui est présent dans le
// HTML renvoyé par ScraperAPI (render=true, donc après exécution du
// JavaScript de la page). Si des rencontres manquent, il faudra
// probablement parcourir plusieurs URLs (une par date) — à ajuster
// une fois qu'on aura vu le résultat réel.
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
  apiUrl.searchParams.set("render", "true");

  const response = await fetch(apiUrl.toString());

  if (!response.ok) {
    throw new Error(
      `Échec du chargement de la page via ScraperAPI (${response.status} ${response.statusText})`
    );
  }

  return response.text();
}

// Même logique d'extraction que pour la page équipe (blocs
// div.game-row), mais sans filtrer par équipe à ce stade — on
// récupère tous les matchs de la compétition, puis on filtre après.
function extractAllGames($) {
  const gameRows = $(".game-row").toArray();
  if (gameRows.length === 0) return [];

  return gameRows
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

      // On garde le label anglais/français tel que présent sur la
      // page (cette compétition étant consultée en anglais, les
      // labels peuvent être "Visitor"/"Home" au lieu de
      // "Visiteurs"/"Recevant" — on gère les deux).
      const visitorTeam = teams["Visiteurs"] || teams["Visitor"] || "";
      const homeTeam = teams["Recevant"] || teams["Home"] || "";

      return {
        Date: date,
        Match: matchLabel,
        Visiteurs: visitorTeam,
        "Score visiteurs": awayScore,
        Recevant: homeTeam,
        "Score recevant": homeScore,
        Lien: link,
      };
    })
    .filter((entry) => entry.Visiteurs || entry.Recevant);
}

function filterByTeam(games, teamCode) {
  return games.filter(
    (game) =>
      game.Visiteurs.includes(teamCode) || game.Recevant.includes(teamCode)
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
  const html = await fetchHtmlViaScraperApi(SOURCE_URL);

  await saveDebugFile(html);

  const $ = cheerio.load(html);
  const allGames = extractAllGames($);

  console.log(`Total de rencontres trouvées sur la page : ${allGames.length}`);

  const teamGames = filterByTeam(allGames, TEAM_CODE);

  await writeResultsOutput(teamGames, SOURCE_URL);
}

main().catch((error) => {
  console.error("Erreur lors de la récupération des résultats R3 :", error);
  process.exit(1);
});
