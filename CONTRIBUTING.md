# Contributing

Guide rapide pour quiconque veut bidouiller le code, déployer, ou ajouter une feature.

## Structure du projet

```
xiv-party-builder/
├── index.html              # toute l'app : HTML + CSS + JS embarqués
├── og.png                  # OG image statique (fallback hors salon)
├── functions/              # Cloudflare Pages Functions
│   ├── _middleware.js      # SSR : réécrit meta og:* quand on charge ?p=ID
│   ├── api/
│   │   ├── save.js         # POST : upsert + permissions + rate-limit
│   │   └── load/[id].js    # GET : renvoie le salon + flag isAdmin
│   └── og/[id].js          # GET : génère le PNG OG via workers-og
├── package.json            # déps npm pour les Functions (workers-og)
├── wrangler.toml           # config CF Pages (binding KV, nodejs_compat)
├── README.md
├── CONTRIBUTING.md         # ← ce fichier
└── DEPLOYMENT.md           # setup Cloudflare Pages + KV
```

## Stack & conventions

### Front (`index.html`)

- **Vanilla JavaScript**, pas de framework, pas de bundler, pas de build step
- Indentation **2 espaces**
- `'use strict'`, `const`/`let`, arrow functions
- État global dans un seul objet `state` ; mutations directes (pas d'immutabilité forcée)
- Le DOM est rebuilt à chaque `renderXxx()` (pas de diff, pas de virtual DOM) — c'est OK vu la taille
- CSS : single `<style>` au début, variables CSS pour les couleurs/palette
- i18n : dictionnaire `STRINGS` au début du `<script>`, fonction `t(key, params)`. Détection via `navigator.language`.

### Backend (Cloudflare Pages Functions)

- Modules ES (`export async function onRequestGet`, `onRequestPost`)
- Validation stricte des inputs côté serveur (whitelist > blacklist)
- KV : binding `PARTY_KV` requis. Cf [DEPLOYMENT.md](DEPLOYMENT.md).
- npm deps installés au build : `workers-og` pour la rasterisation PNG.

### Git

- Branche principale : `main`
- Commits en français OK (le projet est francophone à l'origine), conventional commits non requis
- Pas de hooks pre-commit
- Mentionner Claude dans `Co-Authored-By` est pratique vu l'historique

## Dev local

### Prérequis

- Node.js + npm (pour wrangler et workers-og)
- `wrangler` CLI : `npm install -g wrangler`

### Lancer en local

```sh
# Une seule fois, à la racine du repo :
npm install

# Lance le dev server (Functions + KV éphémère via Miniflare) :
wrangler pages dev . --kv PARTY_KV
```

L'app + les Functions sont servies sur `http://localhost:8788`.

Miniflare crée un KV local éphémère pour le binding `PARTY_KV` — les données ne touchent pas la prod.

### Tester l'OG endpoint

```sh
# Crée un salon en local (POST sans id)
curl -X POST http://localhost:8788/api/save \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: u_test_12345' \
  -d '{"c":"raid8","d":"unified","f":50,"w":"Test","p":[{"n":"Alice","j":["PLD"],"id":"r12345A"}]}'
# → { "id": "abc123", "isAdmin": true, "ownerId": "u_test_12345", ... }

# Fetch le PNG OG
curl -o /tmp/og.png http://localhost:8788/og/abc123

# Le middleware SSR (sur ?p=)
curl 'http://localhost:8788/?p=abc123' | grep og:
```

## Modèle de données

### En KV (per-room)

```js
{
  c: 'raid8',                        // contentType
  d: 'unified',                      // dpsMode (toujours 'unified' désormais)
  f: 50,                             // fairnessWeight 0..100
  w: 'Shinryu EX · samedi 21h',      // raidWhen (optionnel)
  bj: ['BLM', 'PCT'],                // bannedJobs (optionnel)
  p: [{                              // players
    id: 'rA1b2c3',                   // rowId stable
    n: 'Alice',                      // name
    j: ['PLD', 'WAR'],               // preferences ordered
    pt: [0, 1],                      // prefTiers parallèle (optionnel si strict)
    s: 'in',                         // presence: in/maybe/out
    l: 'PLD',                        // lockedJob (optionnel)
    by: 'u_alice_xyz',               // claimedBy userId (optionnel)
    nt: 'Premier essai sur ce fight' // note (optionnel)
  }],
  ownerId: 'u_owner_abc',
  admins: ['u_owner_abc', 'u_promoted_def'],
  recoveryHash: 'sha256-hex...'      // hash du secret de récupération admin
}
```

### Côté client (state.players[i])

Mêmes champs avec aliases :
- `id` ↔ rowId
- `n` ↔ name
- `j` ↔ preferences
- `pt` ↔ prefTiers
- `s` ↔ presence
- `l` ↔ lockedJob
- `by` ↔ claimedBy
- `nt` ↔ note

Le mapping court ↔ long est dans `buildPayload()` et `validateAndNormalizePayload()`.

## Permissions

### Identité

- Chaque navigateur a un `USER_ID` (UUID) en localStorage (`xiv-user-id`)
- Envoyé via header `X-User-Id` sur chaque appel API
- Pas d'auth cryptographique : c'est de l'identité "faible" basée sur le secret de l'UUID (128 bits → ingéniable)

### Lien de récupération admin

- À la création d'un salon, le serveur génère un `recoverySecret` aléatoire (256 bits hex)
- Stocké en KV sous forme **hashée SHA-256** (`recoveryHash`)
- Le secret en clair est renvoyé **une seule fois** au créateur, qui le stocke en localStorage sous `xiv-admin-secret-<roomId>`
- L'admin peut copier le lien `?p=ID#admin=SECRET` pour récupération depuis un autre appareil (le fragment est local, jamais envoyé au serveur dans les logs)
- À l'ouverture, le client extrait le fragment et l'envoie via header `X-Admin-Secret` ; le serveur valide en re-hashant et comparant

### Règles de save serveur

- **Admin** (userId ∈ `admins[]`, OU secret valide) → overwrite complet du salon
- **Non-admin** → merge per-row par `rowId` :
  - Settings (`c`, `d`, `f`, `w`, `bj`) figés
  - Ligne avec `by === userId` : update full autorisé
  - Ligne avec `by` vide : claim si `incoming.by === userId`
  - Ligne avec `by !== userId` : conservée telle quelle (non modifiable)
  - Pas d'ajout / suppression de lignes

## Common gotchas

### Cloudflare Pages config

- **Build command** : `npm install` doit être configuré dans **Settings → Builds & deployments → Build configuration** du projet Pages. Sans ça, les Functions ne trouvent pas `workers-og`. **Pas configurable via `wrangler.toml`** (qui refuse la section `[build]`).
- **KV binding** : nom obligatoire `PARTY_KV` (dur-codé dans les Functions). Configurer via le dashboard OU via `wrangler.toml` (avec l'ID du namespace).
- **`nodejs_compat`** : requis pour que `workers-og` puisse importer `node:buffer`. Présent dans `wrangler.toml`.

### Front

- Le drag & drop HTML5 ne marche pas sur touch. Sur écrans tactiles (`@media (hover: none)`), les drag handles sont masqués. Les flèches ↑↓ servent alors d'unique moyen de réordonner.
- Quand `renderPlayers()` rebuild le DOM, **le focus des inputs est perdu**. Évite de l'appeler pendant la saisie (utilise `scheduleLiveCompute` qui debounce, ou re-render au `blur`).
- L'OG image est cachée par Discord par URL exacte. On ajoute un `?t=Date.now()` aux URLs pour cache-buster lors du publish webhook.

### Tests

Il n'y a **pas de suite de tests automatisés** pour l'instant. Tests manuels :
- Smoke test des endpoints via `curl` (voir plus haut)
- Tester un flow complet via `wrangler pages dev`
- Tester l'embed Discord en repostant un lien (avec `&v=N` pour buster son cache)

## Ajouter une feature

Workflow typique :

1. Ajout des chaînes i18n dans le dictionnaire `STRINGS` (FR + EN)
2. Modification du `state` et de `makePlayer` si besoin
3. Adaptation de `buildPayload` ↔ `validateAndNormalizePayload` (front)
4. Adaptation de `save.js` (validation + storage)
5. UI dans `renderPlayers` / `renderSegments` / `renderSolution` / etc.
6. CSS dans le `<style>` au début de `index.html`
7. Commit, push, le déploiement Cloudflare est automatique sur `main`

## Roadmap (idées non implémentées)

Pas de roadmap formelle. Suggestions ouvertes :

- **PWA installable** (manifest + service worker)
- **Test webhook** Discord (envoyer un ping de validation)
- **Stats endpoint** `/api/stats` (admin only, total salons + breakdown)
- **Calendar export** : `.ics` à partir de Quand?
- **Bot Discord** (avec slash commands) : tout autre projet

## Licence

Pas de licence formelle pour l'instant — par défaut tous droits réservés.
Ouvre une issue si tu veux faire quelque chose avec.
