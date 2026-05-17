# Contributing

Guide rapide pour quiconque veut bidouiller le code, déployer, ou ajouter une feature.

## Structure du projet

```
xiv-party-builder/
├── index.html                  # toute l'app : HTML + CSS + JS embarqués (~4200 lignes JS)
├── og.png                      # OG image statique (fallback hors salon)
├── lib/                        # JS partagé front + Functions + tests (pur, sans DOM)
│   ├── jobs.js                 #   catalogue jobs + content types
│   ├── scoring.js              #   algo de backtracking + branch & bound
│   ├── coverage.js             #   analyse couverture des rôles
│   ├── codec.js                #   encode/decode + validation payload
│   ├── availability.js         #   agrégation dispos + heatmap + meilleur créneau
│   ├── strat-roles.js          #   étiquetage MT/OT/H1/H2/M1/M2/R1/R2
│   ├── discord.js              #   builders Discord (lazy-loadé côté front)
│   └── local-store.js          #   wrappers localStorage (presets/templates/recents)
├── tests/                      # Suite Node test runner (`npm test`)
│   └── *.test.js               #   ~250 tests sur les libs + handlers serveur
├── functions/                  # Cloudflare Pages Functions
│   ├── _middleware.js          #   SSR : réécrit meta og:* quand on charge ?p=ID
│   ├── api/
│   │   ├── save.js             #   POST : upsert + permissions + rate-limit
│   │   ├── load/[id].js        #   GET : renvoie le salon + flag isAdmin
│   │   └── profile.js          #   GET/PUT profil cloud user (presets, dispos…)
│   └── og/[id].js              #   GET : génère le PNG OG via workers-og + cache KV
├── .github/workflows/test.yml  # CI : npm test sur push/PR main
├── package.json                # déps npm pour les Functions (workers-og)
├── wrangler.toml               # config CF Pages (binding KV, nodejs_compat)
├── README.md
├── CONTRIBUTING.md             # ← ce fichier
└── DEPLOYMENT.md               # setup Cloudflare Pages + KV
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
- **Lazy-load** : `lib/discord.js` est chargé via dynamic `import()` au premier click sur une action Discord (économise ~3KB de parse au load initial). Pour ajouter un nouveau module lazy : `let _modPromise = null; function loadMod() { if (!_modPromise) _modPromise = import('./lib/foo.js'); return _modPromise; }`

### Lib partagée (`lib/`)

- **Pure JS**, aucune dépendance DOM ou state global
- Imports inter-libs autorisés (ex: `availability.js` importe `codec.js` pour les constantes)
- Toute fonction nouvellement extraite **doit** avoir des tests dans `tests/`
- Patterns testables : passer en arg les dépendances de fonctions impures (ex: `t` i18n, `state.players` snapshot), retourner des objets enrichis plutôt que muter

### Backend (Cloudflare Pages Functions)

- Modules ES (`export async function onRequestGet`, `onRequestPost`)
- Validation stricte des inputs côté serveur (whitelist > blacklist)
- KV : binding `PARTY_KV` requis. Cf [DEPLOYMENT.md](DEPLOYMENT.md).
- Constantes "magic" dupliquées entre `lib/` et `functions/` (ex: `VALID_AVAIL_HOURS`) : choix volontaire pour éviter un import inter-projet au runtime worker.
- npm deps installés au build : `workers-og` pour la rasterisation PNG.

### Git & CI

- Branche principale : `main`
- Commits en français OK (le projet est francophone à l'origine), conventional commits non requis
- Pas de hooks pre-commit
- Mentionner Claude dans `Co-Authored-By` est pratique vu l'historique
- **CI GitHub Actions** : `.github/workflows/test.yml` lance `npm test` sur push + PR `main`. Les merges qui cassent les tests bloquent.

## Dev local

### Prérequis

- Node.js ≥ 22 (pour le test runner natif `node --test`)
- `wrangler` CLI : `npm install -g wrangler`

### Lancer en local

```sh
# Une seule fois, à la racine du repo :
npm install

# Lance les tests :
npm test                                  # 240+ tests Node

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

### Salon en KV (clé = `<id>`)

```js
{
  c: 'raid8',                        // contentType (dungeon/raid8/raid24/raid24chaotic)
  d: 'unified',                      // dpsMode (toujours 'unified' désormais)
  f: 50,                             // fairnessWeight 0..100
  w: 'Shinryu EX · samedi 21h',      // raidWhen (optionnel)
  bj: ['BLM', 'PCT'],                // bannedJobs (optionnel)
  cl: 2,                             // claimLimit (0/1/2/3/4, défaut 2)
  p: [{                              // players
    id: 'rA1b2c3',                   //   rowId stable
    n: 'Alice',                      //   name
    j: ['PLD', 'WAR'],               //   preferences ordered
    pt: [0, 1],                      //   prefTiers parallèle (optionnel si strict)
    s: 'in',                         //   presence: in/maybe/out
    l: 'PLD',                        //   lockedJob (optionnel)
    by: 'u_alice_xyz',               //   claimedBy userId (optionnel)
    nt: 'Premier essai sur ce fight',//   note (optionnel, max 200)
    av: { mon: [20, 21, 22],         //   availability (optionnel)
          sat: [14, 16, 18] }        //     { day: [hour, hour, …] }
  }],
  ownerId: 'u_owner_abc',
  admins: ['u_owner_abc', 'u_promoted_def'],
  recoveryHash: 'sha256-hex...'      // hash du secret de récupération admin
}
```

### Profil utilisateur·ice en KV (clé = `prof:<userId>`)

```js
{
  v: 1,
  presets: [{ name, jobs: [jobId, ...] }, ...],        // max 5
  templates: [{ name, contentType, bannedJobs, fairnessWeight, savedAt }, ...],  // max 10
  recents: [{ id, when, contentType, savedAt }, ...],  // max 5
  defaultAvailability: { mon: [20, 21], … } | null,    // dispos par défaut user
  updatedAt: 1715912345000
}
```

### Rate limit en KV (clé = `rl:<userId>:<bucket>`)

Compteur sliding-window de 2 buckets contigus. Cf `functions/api/save.js#checkRateLimit`.

### Cache OG en KV (clé = `og:v<N>:<id>:<lang>:<hash(KV)>`)

PNG bytes (~50KB), TTL 7j. La version `v<N>` est incrémentée manuellement quand on change le layout du worker, pour invalider les caches précédents (le hash content-based seul ne suffirait pas si le salon n'a pas changé).

### Côté client (state.players[i])

Mêmes champs en long format avec aliases :
- `id` ↔ rowId
- `n` ↔ name
- `j` ↔ preferences
- `pt` ↔ prefTiers
- `s` ↔ presence
- `l` ↔ lockedJob
- `by` ↔ claimedBy
- `nt` ↔ note
- `av` ↔ availability

Le mapping court ↔ long vit dans `lib/codec.js` : `encodePayload()` pour l'écriture, `validateImportedPayload()` pour la lecture.

## Permissions

### Identité

- Chaque navigateur a un `USER_ID` (UUID) en localStorage (`xiv-user-id`)
- Envoyé via header `X-User-Id` sur chaque appel API
- Pas d'auth cryptographique : c'est de l'identité "faible" basée sur le secret de l'UUID (128 bits → ingéniable)
- Modale **Mon identité** permet de transférer le `USER_ID` cross-device via QR code ou lien `?import=<b64>`

### Lien de récupération admin

- À la création d'un salon, le serveur génère un `recoverySecret` aléatoire (256 bits hex)
- Stocké en KV sous forme **hashée SHA-256** (`recoveryHash`)
- Le secret en clair est renvoyé **une seule fois** au créateur, qui le stocke en localStorage sous `xiv-admin-secret-<roomId>`
- L'admin peut copier le lien `?p=ID#admin=SECRET` pour récupération depuis un autre appareil (le fragment est local, jamais envoyé au serveur dans les logs)
- À l'ouverture, le client extrait le fragment et l'envoie via header `X-Admin-Secret` ; le serveur valide en re-hashant et comparant

### Règles de save serveur

- **Admin** (userId ∈ `admins[]`, OU secret valide) → overwrite complet du salon
- **Non-admin** → merge per-row par `rowId` :
  - Settings (`c`, `d`, `f`, `w`, `bj`, `cl`) figés
  - Ligne avec `by === userId` : update full autorisé (sauf transfert claim)
  - Ligne avec `by` vide : claim si `incoming.by === userId` ET userClaims < claimLimit
  - Ligne avec `by !== userId` : conservée telle quelle (non modifiable)
  - **Ajout** d'une nouvelle ligne autorisé si self-claim ET sous claimLimit ET sous MAX_PLAYERS (32)
  - Suppression de lignes : non autorisée

### Check "réel" admin côté front

`isReallyAdminInRoom()` exige *à la fois* `state.isAdmin === true` (confirmé serveur) **et** une preuve côté client (USER_ID dans `state.admins` OU secret en LS). Defense-in-depth pour éviter qu'un state stale affiche les options admin par erreur.

## Rôles strat FFXIV (`lib/strat-roles.js`)

- Conventions FFXIV : `MT`/`OT` (tanks), `H1`/`H2` (heals), `M1`/`M2`/`R1`/`R2` (DPS raid8)
- **Mapping positionnel** : `dps[0]` = `M1`, `dps[1]` = `R1`, `dps[2]` = `M2`, `dps[3]` = `R2`, indépendamment du job sous-jacent. Si un BLM se retrouve en `M1` slot, il prend la strat `M1`.
- Pour raid24, appel par alliance (chacune reçoit son propre set de labels)
- Le label est volontairement tributaire de la POSITION, pas du job → swap UI = swap label

## Common gotchas

### Cloudflare Pages config

- **Build command** : `npm install` doit être configuré dans **Settings → Builds & deployments → Build configuration** du projet Pages. Sans ça, les Functions ne trouvent pas `workers-og`. **Pas configurable via `wrangler.toml`** (qui refuse la section `[build]`).
- **KV binding** : nom obligatoire `PARTY_KV` (dur-codé dans les Functions). Configurer via le dashboard OU via `wrangler.toml` (avec l'ID du namespace).
- **`nodejs_compat`** : requis pour que `workers-og` puisse importer `node:buffer`. Présent dans `wrangler.toml`.

### Front

- Le drag & drop HTML5 ne marche pas sur touch. Sur écrans tactiles (`@media (hover: none)`), les drag handles sont masqués. Les flèches ↑↓ servent alors d'unique moyen de réordonner.
- Quand `renderPlayers()` rebuild le DOM, **le focus des inputs est perdu**. Évite de l'appeler pendant la saisie (utilise `scheduleLiveCompute` qui debounce, ou re-render au `blur`).
- **`hidden` vs `display`** : si tu utilises `el.hidden = true` sur un élément qui a une règle CSS `display: flex/inline-flex/etc.`, le `display` explicite gagne. Ajouter une règle `.X[hidden] { display: none; }` si besoin (gotcha vécu sur `.btn-tool[hidden]`).
- **Cache OG Discord** : Discord cache les embeds par URL exacte avec TTL ~24h+. Bumper `OG_LAYOUT_VERSION` dans `functions/og/[id].js` ET `functions/_middleware.js` invalide notre cache KV, mais pour forcer Discord à re-scrape immédiatement, utiliser le bouton "↻ Forcer le refresh Discord" (qui ajoute `&dr=<ts>` à l'URL).

### Tests

- **Test runner natif Node** (`node --test`), pas de framework externe
- Tests groupés par lib dans `tests/<lib>.test.js`
- Polyfill `localStorage` en mémoire dans `tests/local-store.test.js` pour les helpers LS
- Mock KV en mémoire dans `tests/profile.test.js` + `tests/save.test.js` pour les handlers Functions
- Tests serveur exercent les helpers exportés (`validatePayload`, `normalizeForNonAdminMerge`, etc.) plus que le full request/response cycle

## Ajouter une feature

Workflow typique :

1. Ajout des chaînes i18n dans le dictionnaire `STRINGS` (FR + EN, attention au `data-i18n-html` si HTML)
2. Modification du `state` et de `makePlayer` si besoin
3. Si logique pure : ajout dans `lib/` + tests `tests/`
4. Adaptation de `encodePayload` (lib/codec.js) ↔ `validateImportedPayload` si nouveau champ persistant
5. Adaptation de `save.js` (validation + storage)
6. UI dans `renderPlayers` / `renderSegments` / `renderSolution` / etc.
7. CSS dans le `<style>` au début de `index.html`
8. Commit, push, le déploiement Cloudflare est automatique sur `main`, la CI tourne en parallèle

Pour les évolutions visuelles de l'OG image : **bumper `OG_LAYOUT_VERSION`** dans `functions/og/[id].js` ET `functions/_middleware.js` (les deux doivent rester en sync).

## Roadmap (idées non implémentées)

- **PWA installable** (manifest + service worker)
- **Stats endpoint** `/api/stats` (total salons + breakdown par content type)
- **Test webhook** Discord (envoyer un ping de validation)
- **Bot Discord** (avec slash commands) : tout autre projet
- **Migration `_middleware.js`** : passer des regex sur le HTML à un parsing plus robuste

## Licence

Pas de licence formelle pour l'instant — par défaut tous droits réservés.
Ouvre une issue si tu veux faire quelque chose avec.
