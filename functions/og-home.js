// GET /og-home
// OG image dynamique pour la page d'accueil (/). Contrairement à /og/<id>
// qui affiche une compo réelle, celui-ci montre une COMPO DÉMO + les
// features clés pour donner aux scrapers Discord/Twitter/LinkedIn une
// preview qui explique ce que fait l'outil.
//
// Cache : très long (le contenu est figé, hash dans la clé). On peut
// servir le même PNG des jours d'affilée → Cloudflare Pages le mettra
// en cache edge sans souci.

import { ImageResponse } from 'workers-og';
import { JOB_BY_ID, ROLE_COLOR } from '../lib/jobs.js';

const HOME_OG_VERSION = 4;  // v4 : layout vertical (features full-width au-dessus des cards) + retire '&' littéral non décodé par satori
const ICON_BASE = 'https://cdn.jsdelivr.net/gh/xivapi/classjob-icons@master/icons/';
const iconUrl = (jobId) => {
  const j = JOB_BY_ID[jobId];
  return j ? ICON_BASE + j.icon + '.png' : '';
};

// Compo démo : un sample raid 8 typique pour illustrer le rendu réel.
// Choisi pour montrer la diversité des sous-rôles (full +5% bonus).
const DEMO_COMPO = [
  { stratRole: 'MT', jobId: 'PLD' },
  { stratRole: 'OT', jobId: 'WAR' },
  { stratRole: 'H1', jobId: 'WHM' },
  { stratRole: 'H2', jobId: 'SCH' },
  { stratRole: 'M1', jobId: 'SAM' },
  { stratRole: 'M2', jobId: 'DRG' },
  { stratRole: 'R1', jobId: 'BRD' },
  { stratRole: 'R2', jobId: 'BLM' }
];

const STRINGS = {
  fr: {
    title: 'Compose ta party FFXIV',
    subtitle: 'Optimise les jobs selon les préférences de chacun·e',
    features: [
      'Préférences ordonnées · algo branch and bound',
      'Dispos hebdo · meilleur créneau auto',
      'Bonus Role Composition · +5% si tous les sous-rôles',
      'Partage 1-clic Discord · zéro compte'
    ],
    footerHint: 'gratuit · open source · cloudflare pages'
  },
  en: {
    title: 'Build your FFXIV party',
    subtitle: 'Optimise jobs based on everyone\'s preferences',
    features: [
      'Ranked preferences · branch and bound solver',
      'Weekly availability · auto best slot',
      'Role Composition bonus · +5% with all sub-roles',
      '1-click Discord share · no account needed'
    ],
    footerHint: 'free · open source · cloudflare pages'
  }
};

function pickLang(headers) {
  const al = (headers.get('accept-language') || '').toLowerCase();
  const first = al.split(',')[0].trim();
  return first.startsWith('en') ? 'en' : 'fr';
}

// Échappe '<' et '>' seulement. PAS '&' : satori rend les entités HTML
// littéralement (`&amp;` apparaît tel quel dans la sortie), donc on garde le
// '&' raw et on évite simplement de mettre des '<' ou '>' bruts qui
// casseraient le parsing.
function esc(s) {
  return String(s).replace(/[<>]/g, c => ({ '<':'&lt;','>':'&gt;' }[c]));
}

function renderDemoCard(player) {
  const job = JOB_BY_ID[player.jobId];
  if (!job) return '';
  const roleColor = ROLE_COLOR[job.role];
  return `
    <div style="display:flex; align-items:center; height:50px; width:240px; padding:0 10px 0 8px; border-left:3px solid ${roleColor}; background:rgba(255,255,255,0.03);">
      <img src="${iconUrl(player.jobId)}" width="36" height="36" style="margin-right:10px; flex-shrink:0;" />
      <div style="display:flex; flex-direction:row; align-items:center; flex:1;">
        <div style="display:flex; align-items:center; justify-content:center; height:18px; padding:0 5px; margin-right:6px; border:1px solid ${roleColor}99; color:${roleColor}; background:rgba(0,0,0,0.4); font-size:11px; font-weight:700; letter-spacing:1px; font-family:monospace; flex-shrink:0;">${esc(player.stratRole)}</div>
        <span style="display:flex; font-size:18px; font-weight:600; color:${roleColor}; font-family:monospace;">${esc(job.id)}</span>
      </div>
    </div>
  `;
}

export async function onRequestGet({ request }) {
  const lang = pickLang(request.headers);
  const dict = STRINGS[lang];

  // Layout vertical (toutes les sections empilées full-width). Le précédent
  // essai en 2 colonnes échouait parce que les 4 cartes (240px × 4 + gaps =
  // ~970px) ne laissaient ~100px à la colonne features, qui wrappait à un
  // mot par ligne. Plus simple, plus lisible :
  //   1. header brand + titre + sous-titre
  //   2. 4 features (1 par ligne, font-size resserrée)
  //   3. compo démo 2 rows × 4 cards + badge +5%
  //   4. footer
  //
  // Total vertical attendu (sans padding) :
  //   header  ~140  (22 + 62 + 22 + margins)
  //   feat    ~140  (4 lignes × 28px + margins)
  //   compo   ~120  (2 × 50 + gap + badge 30)
  //   footer  ~30
  //   total   ~430 + 92 padding = 522. Tient dans 630.

  const featureLines = dict.features.map(f =>
    `<div style="display:flex; flex-direction:row; align-items:center; font-size:22px; color:#d7e6f2; margin-bottom:6px;">
       <span style="display:flex; color:#00e5ff; font-family:monospace; font-weight:700; margin-right:10px;">▸</span>
       <span style="display:flex;">${esc(f)}</span>
     </div>`
  ).join('');

  const row1 = DEMO_COMPO.slice(0, 4).map(renderDemoCard).join('');
  const row2 = DEMO_COMPO.slice(4, 8).map(renderDemoCard).join('');

  const html = `
    <div style="display:flex; flex-direction:column; width:100%; height:100%; background:#050810; padding:42px 56px; font-family:sans-serif;">
      <div style="display:flex; font-size:22px; color:#00e5ff; letter-spacing:6px; margin-bottom:10px;">◆ PARTY // BUILDER</div>
      <div style="display:flex; font-size:56px; font-weight:700; color:#d7e6f2; line-height:1.05; margin-bottom:4px;">${esc(dict.title)}</div>
      <div style="display:flex; font-size:22px; color:#ff2e9a; margin-bottom:22px;">${esc(dict.subtitle)}</div>

      <div style="display:flex; flex-direction:column; margin-bottom:22px;">
        ${featureLines}
      </div>

      <div style="display:flex; flex-direction:column;">
        <div style="display:flex; flex-direction:row; gap:8px; margin-bottom:6px;">${row1}</div>
        <div style="display:flex; flex-direction:row; gap:8px;">${row2}</div>
      </div>

      <div style="display:flex; margin-top:auto; justify-content:space-between; align-items:flex-end;">
        <div style="display:flex; font-size:18px; color:#3a4a5c; letter-spacing:2px;">${esc(dict.footerHint)}</div>
        <div style="display:flex; font-size:22px; color:#00e5ff; font-weight:600;">party-builder.pages.dev</div>
      </div>
    </div>
  `;

  // ImageResponse est paresseux : le body est généré au moment où on le lit.
  // Si satori échoue côté workers-og, le constructor sync ne throw pas →
  // on récupère un PNG 0 byte. On force le rendu en buffer ici pour capter
  // les erreurs (et pouvoir les retourner en text/plain pour debug).
  try {
    const response = new ImageResponse(html, {
      width: 1200,
      height: 630,
      format: 'png'
    });
    const bytes = await response.arrayBuffer();
    if (!bytes || bytes.byteLength === 0) {
      return new Response('OG home render returned empty body (satori probably choked silently)', {
        status: 500, headers: { 'Content-Type': 'text/plain' }
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.byteLength),
        // Cache long : ce visuel ne dépend pas de l'état d'un salon.
        // Bumper HOME_OG_VERSION quand on change le design pour invalider.
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-OG-Home-Version': String(HOME_OG_VERSION)
      }
    });
  } catch (e) {
    return new Response('OG home render error: ' + (e && e.message ? e.message : 'unknown') + (e && e.stack ? '\n' + e.stack : ''), {
      status: 500, headers: { 'Content-Type': 'text/plain' }
    });
  }
}
