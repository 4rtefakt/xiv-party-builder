# XIV Party Builder

Outil web statique d'optimisation de composition de groupe pour **Final Fantasy XIV — Dawntrail**.
Saisis chaque joueur avec ses préférences ordonnées de jobs ; l'app calcule la composition optimale (donjon 4, raid 8, alliance 24) via backtracking + branch & bound.

**App déployée :** _à compléter après le 1er déploiement Cloudflare Pages_ (ex : `https://xiv-party-builder.pages.dev`)

## Fonctionnalités

- 21 jobs Dawntrail (BLU et BST exclus)
- Modes DPS : "unifié" (toutes catégories au même slot) ou "split" (mêlée/distance/caster séparés)
- Suggestions automatiques, slider de balance, alternatives
- Export / import de groupe via URL partageable
- Aucun compte, aucun stockage personnel

## Partage : IDs courts

Quand tu cliques sur **Partager**, l'app appelle une Cloudflare Pages Function (`POST /api/save`) qui stocke le roster dans Workers KV et renvoie un **ID court de 6 caractères** base62. L'URL produite ressemble à :

```
https://xiv-party-builder.pages.dev/?p=ab3c9X
```

L'ouverture d'une URL avec `?p=<id>` déclenche un `GET /api/load/<id>` pour récupérer le roster.

### Rétention

Les entrées KV ont une **TTL de 1 an** (`expirationTtl: 31536000`). Au-delà, l'ID est purgé automatiquement.

### Rétrocompatibilité

Les anciens liens base64 longs continuent de fonctionner sans appel API : le client détecte la longueur (≤ 12 chars alphanumériques = ID court ; sinon décodage base64 local). Le bouton **"Copier le code seul"** copie toujours le payload base64 autoportant, utilisable hors-ligne via le bouton **Importer**.

### Fallback

Si l'API `/api/save` est indisponible (réseau, KV down), l'app retombe automatiquement sur l'URL longue base64 et affiche un toast d'information. Le partage continue de fonctionner.

## Stack

- `index.html` — toute l'app (HTML/CSS/JS embarqués, vanilla)
- `functions/api/save.js` — Cloudflare Pages Function (POST, génère ID + écrit KV)
- `functions/api/load/[id].js` — Cloudflare Pages Function (GET, lit KV)
- `wrangler.toml` — config locale pour `wrangler pages dev`
- Pas de bundler, pas de build step

## Développement local

```sh
npm i -g wrangler
wrangler kv namespace create PARTY_KV --preview
# copie l'id renvoyé dans wrangler.toml
wrangler pages dev .
```

Ouvre `http://localhost:8788`.

## Déploiement

Voir [DEPLOYMENT.md](DEPLOYMENT.md) pour la procédure Cloudflare Pages + binding KV.
