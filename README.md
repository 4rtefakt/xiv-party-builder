# Party Builder · FFXIV

<p align="center">
  <img src="og.png" alt="Party Builder — outil de composition de groupe pour Final Fantasy XIV" width="700">
</p>

<p align="center">
  Outil web d'optimisation de composition de groupe pour <strong>Final Fantasy XIV — Dawntrail</strong>.<br>
  Chaque joueur·euse entre ses préférences de jobs, l'algo de backtracking + branch & bound calcule la meilleure répartition.
</p>

<p align="center">
  <a href="https://party-builder.pages.dev">▸ App en ligne</a> ·
  <a href="CONTRIBUTING.md">▸ Contribuer</a> ·
  <a href="DEPLOYMENT.md">▸ Déploiement</a>
</p>

---

## Fonctionnalités

### Compo
- **3 types de contenu** : Donjon (4), Raid 8, Raid 24 (3 alliances de 8)
- **21 jobs Dawntrail** (BLU et BST exclus, comme en raid contenu)
- **Préférences ordonnées par tier** : plusieurs jobs peuvent partager le même rang (ex: PLD favori, autres tanks tous équivalents)
- **Sélection en bloc par rôle** (T H M R C) : un clic pour cocher tous les jobs d'un rôle au même tier
- **Étoile dorée** sur le job favori (tier 0 unique)
- **Slider d'optimisation** : satisfaction globale ↔ frustration limitée
- **Jobs bannis** pour un raid donné (verrou content-level)
- **Verrouillage par joueur·euse** : tu peux trancher une position pour fixer une compo finale
- **Alternatives top-3** (raid 8 et donjon) avec onglets

### Collaboration
- **Salons partagés via lien court** : `?p=ab3c9X` (ID 6 chars base62, stocké en Cloudflare KV)
- **Auto-save** dès la 1ère modification (création automatique du salon)
- **Identité par navigateur** (userId UUID en localStorage), pas de compte
- **Permissions** :
  - **Owner / admin** : édition totale, peut promouvoir d'autres admins via la couronne 👑
  - **Non-admin** : peut réserver une ligne libre et n'éditer que sa propre ligne
- **Lien de récupération admin** (fragment URL `#admin=SECRET`, jamais transmis au serveur)
- **Synchronisation au focus** + auto-save debounce

### Identités joueur·euse
- **Présence** : OK / ? (peut-être) / ABS (absent·e)
- **Notes par joueur·euse** (200 chars max, lecture par tout·e·s)
- **Presets de préférences** (localStorage, jusqu'à 5 sauvegardés)
- **Drag & drop** ou flèches ↑↓ pour réordonner (intra-rôle pour la compo)

### Partage
- **Bouton "Partager"** : modale avec URL courte + URL longue (base64 autoporté, fonctionne offline)
- **Export pour Discord** : message markdown formaté avec icônes 🛡️💚⚔️🎯
- **Webhook Discord** : publication 1-clic d'un embed riche (avec image OG dynamique) dans un canal configuré
- **OG image PNG dynamique** générée à la volée (rasterized via workers-og) pour les previews Discord/Twitter

### Mémoire & confort
- **Salons récents** (chips localStorage en haut de page, max 5)
- **Templates de compo** (sauvegarde contenu + jobs bannis + fairness pour réutiliser)
- **Duplication** : refais un raid avec mêmes paramètres mais Quand?/claims vierges
- **Undo** sur les actions destructives (Réinitialiser, Retirer, Déverrouiller tout) + Ctrl+Z
- **Bilingue FR / EN** auto-détecté (`navigator.language`)
- **Mobile-friendly** (responsive + drag handles masqués sur touch)
- **Animations douces** (respecte `prefers-reduced-motion`)

---

## Quick start (côté utilisateur·ice)

### Créer et partager une compo

1. Va sur https://party-builder.pages.dev
2. Saisis les noms (ou clique direct sur les jobs : la ligne se nomme automatiquement)
3. Clique sur les icônes des jobs préférés, ou utilise **T / H / M / R / C** pour cocher tout un rôle d'un coup
4. (Optionnel) Renseigne "Quoi/Quand?", bannis des jobs, ajuste le slider
5. Clique **▸ Partager** → un salon est créé, l'URL est copiable
6. Partage le lien dans Discord ; chacun·e ouvre, **Réserve** une ligne, met ses prefs
7. Quand la compo te convient, clique **◆ Verrouiller tout** pour la valider

### Permissions

- **Toi (créateur·ice)** = owner + admin : tu vois la couronne 👑, tu peux tout modifier et promouvoir des admins
- **Les autres** ouvrent le lien : ils voient une bannière "Lecture seule", cliquent **Réserver** sur une ligne libre, ne peuvent éditer que celle-ci
- Pour donner les pleins pouvoirs à quelqu'un : clique 👑 à côté de leur ligne (une fois qu'iels ont réservé)
- Pour **conserver l'accès admin en cas de perte de localStorage** : clique **◆ Copier le lien admin** dans la modale Partager, sauvegarde ce lien (il contient un secret en fragment `#admin=...`)

### Discord webhook

Pour publier ta compo dans un canal Discord en 1 clic :

1. Dans Discord : **Paramètres du canal** → **Intégrations** → **Webhooks** → **Nouveau webhook**
2. Copie l'URL générée
3. Dans la modale Partager, clique **▸ Publier sur Discord** → colle l'URL au prompt
4. Le webhook est stocké uniquement dans **ton** localStorage (jamais sur le serveur)
5. Tous tes prochains raids peuvent être publiés en 1 clic dans ce même canal

---

## Architecture (TL;DR)

- **Front** : `index.html` monolithique, vanilla JS, pas de bundler ni de build step
- **Backend** : Cloudflare Pages Functions
  - `POST /api/save` — crée/upsert un salon (avec règles de permissions per-row)
  - `GET /api/load/[id]` — récupère un salon
  - `GET /og/[id]` — génère le PNG OG image via [workers-og](https://github.com/kvnang/workers-og)
  - `_middleware.js` — réécrit les meta tags OG/Twitter au scrape pour preview Discord
- **Storage** : Cloudflare Workers KV (binding `PARTY_KV`, TTL 1 an, free tier)
- **Rate-limit** : 100 saves/heure/userId via compteur KV

Tier gratuit Cloudflare largement suffisant pour un groupe ~20 personnes.

---

## Privacy & data

- Aucun compte, aucun email, aucun cookie tiers
- Identité = UUID aléatoire par navigateur, stocké dans `localStorage` (pas envoyé au serveur sauf en header sur les writes)
- Données stockées en KV : noms saisis, préférences de jobs, notes, claims (par userId)
- TTL automatique de 1 an sur chaque salon ; au-delà, suppression automatique
- Webhook Discord : URL stockée uniquement en localStorage, jamais sur le serveur

---

## Dev / contribuer

Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour la config locale, la structure du projet, et les conventions.
