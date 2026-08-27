// diagnose-stats.js
//
// Script de DIAGNOSTIC (temporaire) pour comprendre comment la page
// de statistiques FFBS/WBSC est construite, avant d'écrire le script
// d'extraction définitif. Il sauvegarde le HTML brut et affiche des
// indices sur la présence éventuelle d'un JSON Inertia (comme pour
// la page résultats R3) ou de tableaux HTML classiques.

import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";

const SOURCE_URL =
  "https://ffbs.wbsc.org/fr/events/2026-championnat-de-france-division-2-baseball/stats";

const WORKER_URL = process.env.WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;

async function fetchHtmlViaWorker(url) {
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
      `Échec du chargement de la page via le relais Cloudflare (${response.status} ${response.statusText})`
    );
  }

  return response.text();
}

async function main() {
  console.log(`Récupération de la page : ${SOURCE_URL}`);
  const html = await fetchHtmlViaWorker(SOURCE_URL);

  await mkdir("debug", { recursive: true });
  await writeFile("debug/stats-page.html", html, "utf-8");
  console.log("HTML brut sauvegardé dans debug/stats-page.html");

  const $ = cheerio.load(html);

  // Indice n°1 : présence d'un JSON Inertia (comme pour la page
  // résultats R3).
  const dataPage = $("#app").attr("data-page");
  if (dataPage) {
    console.log(
      `\n✅ Attribut data-page trouvé sur #app (${dataPage.length} caractères).`
    );
    try {
      const parsed = JSON.parse(dataPage);
      console.log(
        "Clés présentes dans props :",
        Object.keys(parsed?.props || {})
      );
      // On affiche un aperçu tronqué pour éviter de noyer les logs.
      console.log(
        "Aperçu de props (premiers 2000 caractères) :\n",
        JSON.stringify(parsed?.props, null, 2).slice(0, 2000)
      );
    } catch (error) {
      console.log("Le contenu de data-page n'est pas un JSON valide.");
    }
  } else {
    console.log("\n❌ Pas d'attribut data-page trouvé sur #app.");
  }

  // Indice n°2 : présence de tableaux HTML classiques.
  const tableCount = $("table").length;
  console.log(`\nNombre de balises <table> trouvées : ${tableCount}`);
  $("table").each((i, table) => {
    const headers = $(table)
      .find("tr")
      .first()
      .find("th, td")
      .map((_, cell) => $(cell).text().trim())
      .get();
    console.log(`  Table ${i + 1} — ${headers.length} colonnes :`, headers);
  });

  // Indice n°3 : présence du nom de l'équipe recherchée quelque part
  // dans la page (pour confirmer que ses données sont bien incluses).
  const teamMention = html.includes("Meyzieu");
  console.log(
    `\nLe texte "Meyzieu" apparaît dans la page : ${teamMention ? "oui" : "non"}`
  );
}

main().catch((error) => {
  console.error("Erreur lors du diagnostic :", error);
  process.exit(1);
});
