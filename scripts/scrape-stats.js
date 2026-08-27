// scrape-stats.js
//
// Récupère les statistiques Batting, Pitching et Fielding de la
// Division 2, via l'API JSON utilisée par la page "Statistiques" du
// site FFBS/WBSC :
//   https://ffbs.wbsc.org/api/v1/stats/events/<event>/index
//
// Important : le paramètre "team" de cette API ne filtre PAS
// réellement les résultats côté serveur (vérifié : la réponse
// contient des joueurs de toutes les équipes). On récupère donc
// TOUTES les statistiques puis on filtre nous-mêmes pour ne garder
// que l'équipe Meyzieu-Décines Cards (code "MDC", teamid 40182).
//
// Les statistiques sont demandées "toute la saison" (round et split
// laissés vides = tous les tours confondus, pas seulement le tour en
// cours).
//
// Même logique que les autres scripts : passage par le relais
// Cloudflare Worker pour contourner la protection CloudFront/WAF du
// site.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const API_BASE_URL =
  "https://ffbs.wbsc.org/api/v1/stats/events/2026-championnat-de-france-division-2-baseball/index";

const TEAM_CODE = "MDC";
const TEAM_ID = 40182;

const STATS_SECTIONS = ["batting", "pitching", "fielding"];

const OUTPUT_PATH = path.join(process.cwd(), "data", "stats.json");

const WORKER_URL = process.env.WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

function buildApiUrl(statsSection) {
  const url = new URL(API_BASE_URL);
  url.searchParams.set("section", "players");
  url.searchParams.set("stats-section", statsSection);
  url.searchParams.set("round", "");
  url.searchParams.set("split", "");
  url.searchParams.set("language", "fr");
  return url.toString();
}

async function fetchJsonViaWorker(url) {
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
      `Échec du chargement via le relais Cloudflare (${response.status} ${response.statusText})`
    );
  }

  const text = await response.text();
  return JSON.parse(text);
}

// Le champ "name" de l'API contient du HTML brut, ex :
// <span class="lastname">ANDUSE</span><br><span class="firstname">Matéis</span>
// On en extrait le nom complet lisible "ANDUSE Matéis".
function cleanPlayerName(rawName) {
  const lastnameMatch = rawName.match(
    /class="lastname">([^<]*)</
  );
  const firstnameMatch = rawName.match(
    /class="firstname">([^<]*)</
  );
  const lastname = lastnameMatch ? lastnameMatch[1].trim() : "";
  const firstname = firstnameMatch ? firstnameMatch[1].trim() : "";
  return [lastname, firstname].filter(Boolean).join(" ") || rawName;
}

function filterAndCleanTeamPlayers(data) {
  return data
    .filter((player) => player.teamid === TEAM_ID || player.teamcode === TEAM_CODE)
    .map((player) => {
      const cleaned = { ...player };
      if (typeof cleaned.name === "string") {
        cleaned.name = cleanPlayerName(cleaned.name);
      }
      return cleaned;
    });
}

async function fetchSection(statsSection) {
  const apiUrl = buildApiUrl(statsSection);
  console.log(`Récupération de la section "${statsSection}"...`);

  const json = await fetchJsonViaWorker(apiUrl);
  const allPlayers = Array.isArray(json?.data) ? json.data : [];

  console.log(
    `  ${allPlayers.length} joueurs au total (toutes équipes) sur cette section.`
  );

  const teamPlayers = filterAndCleanTeamPlayers(allPlayers);
  console.log(`  ${teamPlayers.length} joueurs pour ${TEAM_CODE}.`);

  const headers = teamPlayers.length > 0 ? Object.keys(teamPlayers[0]) : [];

  return { headers, entries: teamPlayers };
}

async function main() {
  const output = {
    source: API_BASE_URL,
    updatedAt: new Date().toISOString(),
    team: { code: TEAM_CODE, id: TEAM_ID },
  };

  for (const section of STATS_SECTIONS) {
    output[section] = await fetchSection(section);
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`\nÉcrit dans ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("Erreur lors de la récupération des statistiques :", error);
  process.exit(1);
});
