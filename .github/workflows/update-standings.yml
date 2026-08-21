name: Mise à jour du classement FFBS

on:
  schedule:
    # 06h00 et 18h00 heure de Paris (UTC+1 ou UTC+2 selon l'heure d'été).
    # Les horaires ci-dessous sont en UTC : 05h00 et 17h00 UTC.
    - cron: "0 5 * * *"
    - cron: "0 17 * * *"
  # Permet aussi de déclencher le script manuellement depuis l'onglet
  # "Actions" du dépôt GitHub, pratique pour tester.
  workflow_dispatch:

permissions:
  contents: write

jobs:
  update-standings:
    runs-on: ubuntu-latest
    steps:
      - name: Récupérer le dépôt
        uses: actions/checkout@v4

      - name: Installer Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Installer les dépendances
        run: npm install

      - name: Installer le navigateur Chromium (pour Playwright)
        run: npx playwright install --with-deps chromium

      - name: Récupérer le classement
        run: npm run scrape

      - name: Publier les fichiers de debug (capture d'écran + HTML)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: debug-page
          path: debug/
          if-no-files-found: ignore

      - name: Publier le fichier JSON s'il a changé
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/standings.json
          git diff --staged --quiet || git commit -m "Mise à jour automatique du classement"
          git push
