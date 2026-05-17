# Déploiement Cloudflare Pages

Setup complet : compte CF → projet Pages → namespace KV → build command → live.

## Pré-requis

- Compte Cloudflare (le tier gratuit suffit)
- Accès au repo GitHub (le projet est sur `4rtefakt/xiv-party-builder`, à adapter si fork)
- Optionnel : `wrangler` installé localement (`npm i -g wrangler`) pour le dev local

## 1. Créer le projet Cloudflare Pages

1. Dashboard CF → **Workers & Pages** → **Create application** → onglet **Pages** → **Connect to Git**
2. Sélectionne le repo. Autorise CF sur GitHub si demandé.
3. Build settings :
   - **Framework preset** : None
   - **Build command** : `npm install`  ⚠ **important** (cf section 4)
   - **Build output directory** : `/` (racine)
   - **Root directory** : `/`
4. **Save and Deploy**. Premier déploiement → échouera tant que le KV n'est pas branché. C'est normal.

L'URL générée sera `https://<projet>.pages.dev`.

## 2. Créer le namespace KV

### Via dashboard (recommandé)

1. CF Dashboard → **Storage & Databases** → **KV** → **Create namespace**
2. Nom : `xiv-party-builder-kv` (libre — c'est le **binding** qui doit s'appeler `PARTY_KV`, pas le namespace)
3. Note l'ID du namespace (32 chars hex) pour le mettre dans `wrangler.toml` si tu veux dev en local.

### Via wrangler

```sh
wrangler kv namespace create PARTY_KV
wrangler kv namespace create PARTY_KV --preview
```

Reporte les deux IDs renvoyés dans `wrangler.toml`.

## 3. Lier le KV au projet Pages

**Cloudflare Pages utilise `wrangler.toml` comme source de vérité dès qu'il est présent dans le repo.** Le dashboard est ignoré.

Édite `wrangler.toml` à la racine du repo :

```toml
[[kv_namespaces]]
binding = "PARTY_KV"
id = "<ID-du-namespace-créé-à-l'étape-2>"
preview_id = "<même ID, ou un autre>"
```

Push le commit.

## 4. Configurer la build command via le dashboard

⚠ **Étape critique** : sans ça, les Functions ne trouvent pas `workers-og` (lib npm utilisée pour générer le PNG OG image dynamique).

CF Pages refuse explicitement la section `[build]` dans `wrangler.toml`. Donc ça se passe **uniquement via le dashboard** :

1. Projet Pages → **Settings** → **Builds & deployments** → **Build configuration** → **Edit configurations**
2. **Build command** : `npm install`
3. Save
4. Va dans **Deployments** → sur le dernier deploy → **⋯** → **Retry deployment** (ou push un commit trivial)

Le log de build doit afficher :
```
Detected the following tools from environment: npm@10.x, nodejs@22.x
Installing project dependencies: npm install --progress=false
... 25 packages installed ...
Executing user command: npm install
✨ Compiled Worker successfully
```

## 5. Vérifier en prod

```sh
# Crée un salon
curl -X POST https://<projet>.pages.dev/api/save \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: u_smoke_test_123' \
  -d '{"c":"raid8","d":"unified","f":50,"p":[]}'
# → { "id": "abc123", "isAdmin": true, ..., "recoverySecret": "..." }

# Récupère le PNG OG
curl -o /tmp/og.png https://<projet>.pages.dev/og/abc123
file /tmp/og.png  # → PNG image data, 1200 x 630
```

Puis ouvre `https://<projet>.pages.dev` dans le navigateur, clique **Partager**, et vérifie le flow complet (création de salon, copie du lien, ouverture dans un onglet privé, etc.).

## 6. Custom domain (optionnel)

Projet Pages → **Custom domains** → **Set up a custom domain** → renseigner le DNS proposé.

## Dev local

```sh
npm install                             # une fois, à la racine
wrangler pages dev . --kv PARTY_KV
```

Servi sur `http://localhost:8788`. Miniflare crée un KV éphémère (les données ne touchent pas la prod).

## Tier gratuit Cloudflare

| Ressource | Quota gratuit |
|---|---|
| **Pages requests** | Illimité |
| **Pages bandwidth** | Illimité |
| **Pages builds** | 500/mois |
| **Pages Functions invocations** | 100 000/jour |
| **KV reads** | 100 000/jour |
| **KV writes** | 1 000/jour |
| **KV storage** | 1 GB |

Pour un groupe communautaire d'une vingtaine de personnes, on est très loin des limites.

## Common gotchas

- **`wrangler.toml` + `[build]` section** : CF Pages refuse → "Configuration file for Pages projects does not support 'build'". La build command DOIT être dans le dashboard.
- **KV binding non détecté** : vérifier que le binding s'appelle exactement `PARTY_KV` (sensible à la casse) et que l'ID dans `wrangler.toml` est valide (32 hex chars).
- **`workers-og` introuvable au runtime** : le `nodejs_compat` flag manque dans `wrangler.toml` (la lib importe `node:buffer`). Présent par défaut dans le repo.
- **Build cassé après ajout de dep** : penser à pusher `package.json` ET `package-lock.json` après modification (la CI utilise `npm ci` qui exige le lockfile).
- **Discord cache l'OG image** : Discord cache les embeds par URL exacte avec un TTL ~24h+. Le middleware réécrit l'`og:image` en `?v=<OG_LAYOUT_VERSION>_<hash(KV)>` → le hash change à chaque modif de salon (cache image refetch) et la version change quand on bump le layout (cache invalidate global). Pour forcer un re-scrape Discord *immédiat*, utiliser le bouton **"↻ Forcer le refresh Discord"** dans la modale Partager (ajoute `&dr=<timestamp>` à l'URL collée).
- **Cache KV des OG PNG** : clé `og:v<N>:<id>:<lang>:<hash(KV)>`, TTL 7j. Bumper `OG_LAYOUT_VERSION` dans `functions/og/[id].js` ET `functions/_middleware.js` invalide les caches précédents en une fois.
- **CI bloquée par tests** : `.github/workflows/test.yml` lance `npm test` sur push + PR. Un fail bloque le merge (mais pas le deploy CF Pages, qui suit son propre rythme).
