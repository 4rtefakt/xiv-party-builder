# CLAUDE.md

Contexte court pour Claude. Détails complets : [CONTRIBUTING.md](CONTRIBUTING.md).

## Stack

- **Pas de build step, pas de bundler, pas de framework.** Le front est `index.html` (~4200 lignes JS embarquées, vanilla).
- **`lib/`** = JS pur partagé front + Cloudflare Functions + tests. Aucune dépendance DOM ou state global. Toute nouvelle fonction doit avoir des tests.
- **Backend** = Cloudflare Pages Functions (`functions/`), KV binding `PARTY_KV` (cf [wrangler.toml](wrangler.toml)).
- **Tests** = `node --test` natif (Node ≥ 22), ~250 tests. Lancement : `npm test`.

## Conventions

- Indentation 2 espaces, `const`/`let`, arrow functions, `'use strict'`.
- Commits en français OK, conventional commits non requis.
- i18n FR/EN via dictionnaire `STRINGS` + `t(key, params)` dans `index.html`.
- État front = un seul objet `state`, mutations directes, DOM rebuilt à chaque `renderXxx()`.

## Gotchas à ne pas oublier

### OG image (`functions/og/[id].js` + `functions/_middleware.js`)
- Pour toute évolution visuelle de l'OG, **bumper `OG_LAYOUT_VERSION` dans LES DEUX fichiers** (sinon le cache KV ne s'invalide pas correctement).
- `workers-og` / `satori` a des comportements silencieux : si tu ajoutes une feature CSS non supportée (ex: `box-sizing`), pas d'erreur, juste un layout cassé. Voir mémoire `reference_workers_og_satori.md`.

### Cloudflare Pages
- Build command (`npm install`) doit être configurée dans le **dashboard Cloudflare**, pas dans `wrangler.toml` (qui refuse la section `[build]` pour les projets Pages).
- `nodejs_compat` requis (pour `workers-og` qui importe `node:buffer`).

### Front
- `renderPlayers()` rebuild le DOM → perte de focus. Utiliser `scheduleLiveCompute` (debounce) ou re-render au `blur`.
- `el.hidden = true` perd face à `display: flex/inline-flex` explicite en CSS. Ajouter `.X[hidden] { display: none; }` si besoin.
- Drag & drop HTML5 ne marche pas sur touch — masqué via `@media (hover: none)`, fallback flèches ↑↓.

### Permissions serveur
- Validation stricte côté serveur (whitelist > blacklist) dans `functions/api/save.js`.
- Constantes "magic" volontairement dupliquées entre `lib/` et `functions/` (ex: `VALID_AVAIL_HOURS`) — pas d'import inter-projet au runtime worker.

## Workflow

1. Logique pure → `lib/` + test dans `tests/`
2. Persistance d'un nouveau champ → adapter `lib/codec.js` (encode/validate) + `functions/api/save.js`
3. UI → `renderPlayers` / `renderSegments` / `renderSolution`
4. Push sur `main` → déploiement Cloudflare auto + CI tests en parallèle
