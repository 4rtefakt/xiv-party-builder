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

const HOME_OG_VERSION = 6;  // v6 : compo en colonnes TANKS|HEALERS|DPS (sous-grille 2×2) comme la page web
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
    heatmapTitle: 'CRÉNEAUX COMMUNS · 7 RÉPONSES',
    heatmapBest: 'Best : Mardi 21h → 23h (7/7)',
    dayLabels: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'],
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
    heatmapTitle: 'COMMON SLOTS · 7 RESPONSES',
    heatmapBest: 'Best : Tuesday 21h → 23h (7/7)',
    dayLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    footerHint: 'free · open source · cloudflare pages'
  }
};

// Données démo de la heatmap : reflète une compo de raid hebdo typique
// (soirées de semaine 19h-23h + plus de couverture en weekend). Mardi 21h/22h
// = max 7/7 → cellules en cyan pour matcher le "best slot" mis en avant.
const HEATMAP_HOURS = ['8h','10h','14h','16h','18h','19h','20h','21h','22h','23h'];
const HEATMAP_COUNTS = [
  [0, 0, 0, 0, 0, 0, 3, 5, 5, 4],  // Mon
  [0, 0, 0, 0, 0, 0, 4, 7, 7, 5],  // Tue
  [0, 0, 0, 0, 0, 0, 4, 5, 5, 4],  // Wed
  [0, 0, 0, 0, 0, 0, 0, 4, 5, 4],  // Thu
  [0, 0, 0, 0, 0, 0, 3, 5, 5, 5],  // Fri
  [0, 2, 4, 4, 4, 4, 5, 5, 5, 4],  // Sat
  [0, 2, 4, 4, 3, 4, 5, 5, 5, 4]   // Sun
];
const HEATMAP_MAX = 7;

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

// Couleur d'une cellule heatmap selon son count (0 → max).
// Max = cyan (best slot, matches le surlignage de l'UI), gradient de vert
// pour les autres. Texte sombre sur fonds intenses, clair sur fonds faibles.
function heatmapCellColor(count) {
  if (count === 0) return { bg: 'rgba(255,255,255,0.04)', fg: 'transparent' };
  if (count >= HEATMAP_MAX) return { bg: 'rgba(0,229,255,0.45)', fg: '#062b30' };
  const t = count / HEATMAP_MAX;
  if (t >= 0.7) return { bg: 'rgba(74,222,128,0.55)', fg: '#062114' };
  if (t >= 0.45) return { bg: 'rgba(74,222,128,0.35)', fg: '#062114' };
  if (t >= 0.25) return { bg: 'rgba(74,222,128,0.18)', fg: '#a7e8c0' };
  return { bg: 'rgba(74,222,128,0.10)', fg: '#a7e8c0' };
}

// Mini heatmap dispos pour l'OG. Layout : header (titre vert), grille 10 cols
// × 7 lignes (colonne 0 = labels jours), footer (best slot en cyan).
// Dimensions : label 36px + 10 × 34px cells = 376px ; total avec border ≈ 410px.
function renderHeatmap(dict) {
  const CELL_W = 34;
  const CELL_H = 22;
  const LABEL_W = 36;

  const headerCells = HEATMAP_HOURS.map(h =>
    `<div style="display:flex; align-items:center; justify-content:center; width:${CELL_W}px; height:18px; color:#5a6a7c; font-size:10px; font-family:monospace;">${esc(h)}</div>`
  ).join('');

  const dayRows = HEATMAP_COUNTS.map((counts, di) => {
    const cells = counts.map(c => {
      const col = heatmapCellColor(c);
      return `<div style="display:flex; align-items:center; justify-content:center; width:${CELL_W}px; height:${CELL_H}px; background:${col.bg}; color:${col.fg}; font-size:10px; font-weight:700; font-family:monospace; border:1px solid rgba(0,0,0,0.5);">${c > 0 ? c : ''}</div>`;
    }).join('');
    return `
      <div style="display:flex; flex-direction:row; align-items:center;">
        <div style="display:flex; align-items:center; justify-content:flex-start; width:${LABEL_W}px; height:${CELL_H}px; color:#5a6a7c; font-size:11px;">${esc(dict.dayLabels[di])}</div>
        ${cells}
      </div>
    `;
  }).join('');

  return `
    <div style="display:flex; flex-direction:column; padding:10px 12px; border:1px solid rgba(74,222,128,0.25); background:rgba(74,222,128,0.04);">
      <div style="display:flex; font-size:11px; color:#4ade80; letter-spacing:2px; font-weight:700; margin-bottom:8px;">📅 ${esc(dict.heatmapTitle)}</div>
      <div style="display:flex; flex-direction:row; margin-bottom:2px;">
        <div style="display:flex; width:${LABEL_W}px;"></div>
        ${headerCells}
      </div>
      <div style="display:flex; flex-direction:column;">
        ${dayRows}
      </div>
      <div style="display:flex; font-size:12px; color:#00e5ff; margin-top:8px; font-weight:600;">${esc(dict.heatmapBest)}</div>
    </div>
  `;
}

function renderDemoCard(player, width) {
  const job = JOB_BY_ID[player.jobId];
  if (!job) return '';
  const roleColor = ROLE_COLOR[job.role];
  return `
    <div style="display:flex; align-items:center; height:50px; width:${width}px; padding:0 10px 0 8px; border-left:3px solid ${roleColor}; background:rgba(255,255,255,0.03);">
      <img src="${iconUrl(player.jobId)}" width="36" height="36" style="margin-right:10px; flex-shrink:0;" />
      <div style="display:flex; flex-direction:row; align-items:center; flex:1;">
        <div style="display:flex; align-items:center; justify-content:center; height:18px; padding:0 5px; margin-right:6px; border:1px solid ${roleColor}99; color:${roleColor}; background:rgba(0,0,0,0.4); font-size:11px; font-weight:700; letter-spacing:1px; font-family:monospace; flex-shrink:0;">${esc(player.stratRole)}</div>
        <span style="display:flex; font-size:18px; font-weight:600; color:${roleColor}; font-family:monospace;">${esc(job.id)}</span>
      </div>
    </div>
  `;
}

// Compo en 3 sections (TANKS | HEALERS | DPS), reproduit la mise en page de
// la page web et de /og/[id].js. La section DPS contient une sous-grille 2×2
// (M1/R1 sur row 0, M2/R2 sur row 1).
//
//   TANKS    HEALERS         DPS
//   [MT]     [H1]      [M1]    [R1]
//   [OT]     [H2]      [M2]    [R2]
//
// Largeurs : tank/heal col = CARD_W ; dps block = 2 × CARD_W + COL_GAP.
function renderCompoGrid() {
  const CARD_W = 230;
  const COL_GAP = 12;
  const ROW_GAP = 6;
  const HDR_COLORS = { tank: '#2b9eff', heal: '#4ade80', dps: '#ff4f6e' };

  function header(label, color, width) {
    return `<div style="display:flex; align-items:center; justify-content:center; width:${width}px; height:22px; color:${color}; font-size:12px; letter-spacing:3px; font-weight:700; border-bottom:1px solid ${color}66; margin-bottom:8px;">${esc(label)}</div>`;
  }

  function stackedCol(headerLabel, color, width, cards) {
    return `
      <div style="display:flex; flex-direction:column; width:${width}px;">
        ${header(headerLabel, color, width)}
        <div style="display:flex; flex-direction:column; gap:${ROW_GAP}px;">
          ${cards.join('')}
        </div>
      </div>
    `;
  }

  // DEMO_COMPO indices : 0=MT 1=OT 2=H1 3=H2 4=M1 5=M2 6=R1 7=R2
  const tankCards = [renderDemoCard(DEMO_COMPO[0], CARD_W), renderDemoCard(DEMO_COMPO[1], CARD_W)];
  const healCards = [renderDemoCard(DEMO_COMPO[2], CARD_W), renderDemoCard(DEMO_COMPO[3], CARD_W)];
  // DPS = sous-grille 2 col × 2 row (M slots à gauche, R à droite)
  const dpsRow0 = `<div style="display:flex; flex-direction:row; gap:${COL_GAP}px;">${renderDemoCard(DEMO_COMPO[4], CARD_W)}${renderDemoCard(DEMO_COMPO[6], CARD_W)}</div>`;
  const dpsRow1 = `<div style="display:flex; flex-direction:row; gap:${COL_GAP}px;">${renderDemoCard(DEMO_COMPO[5], CARD_W)}${renderDemoCard(DEMO_COMPO[7], CARD_W)}</div>`;

  const dpsBlockW = CARD_W * 2 + COL_GAP;

  return `
    <div style="display:flex; flex-direction:row; gap:${COL_GAP}px;">
      ${stackedCol('TANKS', HDR_COLORS.tank, CARD_W, tankCards)}
      ${stackedCol('HEALERS', HDR_COLORS.heal, CARD_W, healCards)}
      <div style="display:flex; flex-direction:column; width:${dpsBlockW}px;">
        ${header('DPS', HDR_COLORS.dps, dpsBlockW)}
        <div style="display:flex; flex-direction:column; gap:${ROW_GAP}px;">
          ${dpsRow0}
          ${dpsRow1}
        </div>
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

  // Layout :
  //   1. Header brand + titre + sous-titre
  //   2. Row : [features] | [heatmap]   ← side by side
  //   3. Compo démo en colonnes TANKS | HEALERS | DPS (DPS = sous-grille 2×2)
  //   4. Footer
  // Largeurs row 2 : features 560 + gap 28 + heatmap ~430 ≈ 1018 / 1088 dispo.
  // Largeurs row 3 (compo) : 4 × 230 + 3 × 12 = 956 / 1088 dispo.
  const html = `
    <div style="display:flex; flex-direction:column; width:100%; height:100%; background:#050810; padding:32px 56px; font-family:sans-serif;">
      <div style="display:flex; font-size:22px; color:#00e5ff; letter-spacing:6px; margin-bottom:8px;">◆ PARTY // BUILDER</div>
      <div style="display:flex; font-size:52px; font-weight:700; color:#d7e6f2; line-height:1.05; margin-bottom:4px;">${esc(dict.title)}</div>
      <div style="display:flex; font-size:21px; color:#ff2e9a; margin-bottom:18px;">${esc(dict.subtitle)}</div>

      <div style="display:flex; flex-direction:row; align-items:flex-start; gap:28px; margin-bottom:18px;">
        <div style="display:flex; flex-direction:column; width:560px;">
          ${featureLines}
        </div>
        ${renderHeatmap(dict)}
      </div>

      ${renderCompoGrid()}

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
