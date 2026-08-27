// diagnose-stats-api.js
//
// Script de DIAGNOSTIC (temporaire). La page stats charge en fait
// ses données via un appel à une API JSON classique :
//   https://ffbs.wbsc.org/api/v1/stats/events/<event>/index
// avec des paramètres GET (section, stats-section, team, round,
// split, language). Ce script interroge cette API pour les 3
// sections demandées (batting, pitching, fielding), filtrées sur
// l'équipe Meyzieu-Décines Cards (team=40182), tous tours confondus,
// et affiche la structure JSON obtenue pour qu'on puisse écrire le
// script d'extraction définitif.

import { writeFile, mkdir } from "node:fs/promises";

const API_BASE_URL =
  "https://ffbs.wbsc.org/api/v1/stats/events/2026-championnat-de-france-division-2-baseball/index";

const TEAM_ID = "40182"; // Meyzieu-Décines Cards

const SECTIONS = ["batting", "pitching", "fielding"];

const WORKER_URL = process.env.WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

function buildApiUrl(statsSection) {
  const url = new URL(API_BASE_URL);
  url.searchParams.set("section", "players");
  url.searchParams.set("stats-section", statsSection);
  url.searchParams.set("team", TEAM_ID);
  url.searchParams.set("round", "");
  url.searchParams.set("split", "");
  url.searchParams.set("language", "fr");
  return url.toString();
}

async function fetchViaWorker(url) {
  if (!WORKER_URL || !WORKER_SECRET) {
    throw new Error(
      "Les variables d'environnement WORKER_URL et/ou WORKER_SECRET ne sont pas définies."
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

  return response.text();
}

async function main() {
  await mkdir("debug", { recursive: true });

  for (const section of SECTIONS) {
    const apiUrl = buildApiUrl(section);
    console.log(`\n=== Section: ${section} ===`);
    console.log(`URL interrogée : ${apiUrl}`);

    const raw = await fetchViaWorker(apiUrl);

    await writeFile(`debug/stats-api-${section}.json`, raw, "utf-8");
    console.log(`Réponse brute sauvegardée dans debug/stats-api-${section}.json`);

    try {
      const parsed = JSON.parse(raw);
      console.log("Type de la réponse :", Array.isArray(parsed) ? "tableau" : typeof parsed);
      if (Array.isArray(parsed)) {
        console.log(`Nombre d'éléments : ${parsed.length}`);
        console.log("Premier élément :", JSON.stringify(parsed[0], null, 2));
      } else {
        console.log("Clés de premier niveau :", Object.keys(parsed));
        console.log(
          "Aperçu (2000 premiers caractères) :\n",
          JSON.stringify(parsed, null, 2).slice(0, 2000)
        );
      }
    } catch (error) {
      console.log("❌ La réponse n'est pas du JSON valide.");
      console.log("Aperçu brut (500 premiers caractères) :\n", raw.slice(0, 500));
    }
  }
}

main().catch((error) => {
  console.error("Erreur lors du diagnostic :", error);
  process.exit(1);
});
