# Déploiement Cloudflare Pages

Procédure complète pour passer le projet de GitHub Pages à Cloudflare Pages avec Functions + KV.

## 1. Pré-requis

- Compte Cloudflare (gratuit suffit)
- Accès au repo GitHub `4rtefakt/xiv-party-builder`
- Optionnel : `wrangler` installé localement pour le dev/debug (`npm i -g wrangler`)

## 2. Créer le projet Cloudflare Pages

1. Dashboard Cloudflare → **Workers & Pages** → **Create application** → onglet **Pages** → **Connect to Git**
2. Sélectionne le repo GitHub. Si besoin, autorise Cloudflare sur ton compte GitHub.
3. **Build settings** :
   - Framework preset : **None**
   - Build command : *laisser vide*
   - Build output directory : `/` (racine)
   - Root directory : `/`
4. Clique **Save and Deploy**. Le premier déploiement démarre — il échouera peut-être à exécuter les Functions tant que le binding KV n'est pas en place. C'est normal, on le branche ensuite.

L'URL du projet sera de la forme `https://xiv-party-builder.pages.dev` (ou un sous-domaine choisi).

## 3. Créer le namespace KV

Deux méthodes possibles :

### Via le dashboard (recommandé)

1. Dashboard Cloudflare → **Workers & Pages** → **KV** → **Create namespace**
2. Nom : `xiv-party-builder-kv` (ou autre, peu importe — c'est le **binding** qui doit s'appeler `PARTY_KV`)
3. Note l'ID du namespace si tu veux utiliser `wrangler` en local.

### Via wrangler (alternative)

```sh
wrangler kv namespace create PARTY_KV
wrangler kv namespace create PARTY_KV --preview
```

Note les deux IDs renvoyés et reporte-les dans `wrangler.toml`.

## 4. Lier le KV au projet Pages

1. Projet Pages → **Settings** → **Functions** → **KV namespace bindings**
2. **Add binding** :
   - **Variable name** : `PARTY_KV` *(impératif — c'est ce nom que les Functions utilisent)*
   - **KV namespace** : sélectionner celui créé à l'étape 3
3. Sauvegarder.

## 5. Redéployer

Pour que le binding soit pris en compte par les Functions, il faut un nouveau déploiement :

- Soit pousser un commit (même trivial) sur `main`
- Soit aller dans **Deployments** → **Retry deployment**

## 6. Vérifier

Une fois déployé :

```sh
# Test save
curl -X POST https://xiv-party-builder.pages.dev/api/save \
  -H 'Content-Type: application/json' \
  -d '{"c":"raid8","d":"unified","f":50,"p":[]}'
# → { "id": "xxxxxx" }

# Test load
curl https://xiv-party-builder.pages.dev/api/load/xxxxxx
# → { "c":"raid8", "d":"unified", "f":50, "p":[] }
```

Puis ouvre l'app dans le navigateur, clique **Partager**, copie le lien court, recharge dans un onglet privé → le roster doit se charger.

## 7. Custom domain (optionnel)

Projet Pages → **Custom domains** → **Set up a custom domain** → renseigner le DNS proposé.

## Dev local

Pour tester Functions + KV en local sans toucher à la prod :

```sh
npm i -g wrangler
# Si ce n'est pas déjà fait : créer les namespaces et reporter les IDs dans wrangler.toml
wrangler pages dev .
```

L'app + les Functions sont servies sur `http://localhost:8788`.

> Note : `wrangler pages dev` utilise par défaut un KV local (Miniflare). Les données ne touchent pas la prod.

## Migration depuis GitHub Pages

- Désactiver GitHub Pages dans **Settings → Pages** du repo une fois Cloudflare Pages stable.
- Mettre à jour les liens dans le README et les éventuels embeds Discord/OG (le `og:image` reste relatif, OK).
- Les anciens liens GitHub Pages avec `?p=<base64>` continueront de fonctionner si on garde GH Pages en parallèle ; sinon ils sont morts. Les utilisateurs qui ont sauvé un base64 long peuvent toujours le coller dans **Importer** sur la nouvelle URL CF Pages.

## Pricing — tier gratuit Cloudflare

- **Pages** : 500 builds/mois, requêtes illimitées, bande passante illimitée.
- **Pages Functions** : 100 000 invocations/jour gratuites.
- **KV** : 100 000 reads/jour, 1 000 writes/jour, 1 GB stockage gratuits.

Largement au-dessus du besoin pour un outil communautaire de ~20 personnes.
