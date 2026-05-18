// GET /og/:id
// Image PNG personnalisée pour le salon. Importe le scoring depuis lib/
// (source de vérité partagée avec le front) puis dispose les joueurs
// assignés sur 4 lignes par rôle.
// Rendu : workers-og (satori + resvg-wasm), HTML/CSS flexbox uniquement.

import { ImageResponse } from 'workers-og';
import { JOB_BY_ID, CONTENT_COMP, ROLE_COLOR } from '../../lib/jobs.js';
import { buildSlotsFromComp, computeOptimalAssignment } from '../../lib/scoring.js';
import { analyzeAvailability, bestSlotWithTail } from '../../lib/availability.js';
import { assignStratRoles, assignDpsGridPositions, getDpsLayout } from '../../lib/strat-roles.js';

const VALID_ID = /^[A-Za-z0-9]{4,12}$/;

// Cache PNG en KV : la rasterization workers-og (satori + resvg-wasm) coûte
// 300-500ms CPU par scrape. La sortie est déterministe pour un (id, contenu)
// donné → on cache l'output sous `og:<id>:<lang>:<hash(KV)>` avec TTL 7j.
// Le hash change quand le salon est modifié → cache stale auto.
// VERSION : à incrémenter quand on change le layout du rendu (sinon les
// vieux PNG cachés restent servis tant que le salon n'est pas modifié).
const OG_CACHE_TTL = 7 * 86400;
const OG_LAYOUT_VERSION = 21; // v21 : seed tie-break par room id (algo scoring) → l'attribution job→joueur en cas d'égalité change vs v20

async function shortHash(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const arr = new Uint8Array(buf, 0, 4);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

const ICON_BASE = 'https://cdn.jsdelivr.net/gh/xivapi/classjob-icons@master/icons/';
const iconUrl = (job) => ICON_BASE + job.icon + '.png';

const OG_STRINGS = {
  fr: {
    contentLabels: { dungeon: 'Donjon',  raid8: 'Raid', raid24: 'Raid Alliance', raid24chaotic: 'Raid Chaotic' },
    playerLabel: (n) => n > 1 ? 'joueur·euse·s' : 'joueur·euse',
    bench: ({ n }) => ` · ${n} au banc`,
    locked: ({ n }) => ` · ${n} verrouillé·e·s`,
    validated: '◆ COMPO VALIDÉE',
    salon: ({ id }) => `salon ${id}`,
    colTanks: 'TANKS', colHeals: 'HEALERS', colDps: 'DPS',
    bestSlot: ({ day, hour, endHour, count, total }) => {
      const range = endHour > hour ? `${hour}h → ${endHour}h` : `${hour}h`;
      return `📅 ${day} ${range} · ${count}/${total} dispos`;
    },
    daysLong: { mon: 'Lundi', tue: 'Mardi', wed: 'Mercredi', thu: 'Jeudi', fri: 'Vendredi', sat: 'Samedi', sun: 'Dimanche' }
  },
  en: {
    contentLabels: { dungeon: 'Dungeon', raid8: 'Raid', raid24: 'Alliance Raid', raid24chaotic: 'Chaotic Raid' },
    playerLabel: (n) => n > 1 ? 'players' : 'player',
    bench: ({ n }) => ` · ${n} on bench`,
    locked: ({ n }) => ` · ${n} locked`,
    validated: '◆ COMP VALIDATED',
    salon: ({ id }) => `room ${id}`,
    colTanks: 'TANKS', colHeals: 'HEALERS', colDps: 'DPS',
    bestSlot: ({ day, hour, endHour, count, total }) => {
      const range = endHour > hour ? `${hour}h → ${endHour}h` : `${hour}h`;
      return `📅 ${day} ${range} · ${count}/${total} available`;
    },
    daysLong: { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }
  }
};

function pickLang(headers) {
  const al = (headers.get('accept-language') || '').toLowerCase();
  const first = al.split(',')[0].trim();
  if (first.startsWith('en')) return 'en';
  return 'fr';
}

// Adapte la sortie du scoring lib/ pour l'OG : reproduit l'ancien retour
// { players, assignment } à partir du nouveau format { results }.
// Pour raid24 / chaotic on optimise sur la party totale (pas par alliance),
// même comportement que l'ancienne version embarquée.
function computeForOg(data, roomId) {
  const base = CONTENT_COMP[data.c];
  if (!base) return { players: [], assignment: [] };

  const slots = buildSlotsFromComp(base.comp, data.d);
  const rawPlayers = (Array.isArray(data.p) ? data.p : [])
    .filter(p => p && typeof p.n === 'string' && p.n.trim() !== '' && p.s !== 'out')
    .map(p => ({
      name: p.n.trim(),
      preferences: Array.isArray(p.j) ? p.j : [],
      prefTiers: Array.isArray(p.pt) ? p.pt : [],
      lockedJob: typeof p.l === 'string' && JOB_BY_ID[p.l] ? p.l : null,
      presence: p.s || 'in'
    }));

  const out = computeOptimalAssignment({
    players: rawPlayers,
    slots,
    bannedJobs: Array.isArray(data.bj) ? data.bj : [],
    fairnessWeight: typeof data.f === 'number' ? data.f : 50,
    topK: 1,
    // Seed = room id : tie-break stable par salon, cohérent avec le front.
    seed: roomId || null
  });

  if (out.error) {
    return { players: rawPlayers, assignment: new Array(rawPlayers.length).fill(null), results: [], comp: null };
  }

  // L'assignment et les players gardent l'ordre solver. La reorganisation
  // DPS pour le layout (mêlées en col M, autres en col R) se fait via
  // gridPosition annotée sur chaque DPS, le rendu utilise getDpsLayout
  // pour placer dans la sous-grille en respectant les positions / vides.
  const assignment = out.results.map(r => {
    if (!r.assigned) return null;
    return { jobId: r.jobId };
  });
  return { players: rawPlayers, assignment, results: out.results, comp: base.comp };
}

function esc(s) {
  return String(s).replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
}

// Compacte un nom FFXIV "Prénom Nom" en "Prénom N." pour les cartes de
// l'OG image — UNIQUEMENT si le nom complet dépasse MAX chars. Les noms
// courts (≤ 12 chars) passent intacts. Sinon : abrégement "Prénom N." pour
// les 2+ mots, troncature avec ellipsis pour les noms 1 mot.
function shortenName(name) {
  const MAX = 12;               // seuil au-dessus duquel on raccourcit
  const FIRST_MAX = 9;          // cap pour le 1er token quand on abrège
  const trimmed = String(name || '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.length <= MAX) return trimmed;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) {
    return trimmed.slice(0, MAX - 1) + '…';
  }
  const first = tokens[0];
  const initials = tokens.slice(1).map(t => t.charAt(0).toUpperCase() + '.').join(' ');
  const compactFirst = first.length <= FIRST_MAX
    ? first
    : first.slice(0, FIRST_MAX - 1) + '…';
  return compactFirst + ' ' + initials;
}

function fallback(text) {
  return new Response(text, { status: 500, headers: { 'Content-Type': 'text/plain' } });
}

// Layout par lignes (legacy) : utilisé pour raid24 / chaotic 24 (jusqu'à 24
// cartes, ça ne rentre pas dans une grille 4-col × 2-row).
const CARD_WIDTH = 280;

function renderCard(m, width) {
  const roleColor = ROLE_COLOR[m.job.role];
  const lockBorder = m.locked
    ? `border:1px solid #ffb547; background:rgba(255,181,71,0.08); box-shadow:0 0 8px rgba(255,181,71,0.25);`
    : `background:rgba(255,255,255,0.03);`;
  const lockGlyph = m.locked
    ? `<div style="display:flex; align-items:center; justify-content:center; width:18px; height:18px; color:#ffb547; font-size:14px; font-weight:700; margin-left:auto; padding:0 2px;">◆</div>`
    : '';
  // Sous-label sous le nom : badge style strat role (MT/OT/H1/H2/M1…) pour le
  // layout colonnes dungeon/raid8. Fallback sur le nom de job en texte simple
  // pour raid24 (où le strat role global n'est pas significatif sans split par
  // alliance, cf. handler principal).
  const subRow = m.stratRole
    ? `<div style="display:flex; align-self:flex-start; align-items:center; justify-content:center; height:18px; padding:0 6px; margin-top:3px; border:1px solid ${roleColor}99; color:${roleColor}; background:rgba(0,0,0,0.4); font-size:11px; font-weight:700; letter-spacing:1.5px; font-family:monospace;">${esc(m.stratRole)}</div>`
    : `<div style="display:flex; font-size:15px; color:${roleColor}; line-height:1.1; margin-top:3px;">${esc(m.job.name)}</div>`;
  return `
    <div style="box-sizing:border-box; display:flex; align-items:center; height:54px; width:${width}px; padding:0 10px 0 8px; border-left:3px solid ${roleColor}; ${lockBorder}">
      <img src="${iconUrl(m.job)}" width="40" height="40" style="margin-right:12px; flex-shrink:0;" />
      <div style="display:flex; flex-direction:column; overflow:hidden;">
        <div style="display:flex; font-size:22px; font-weight:600; color:#d7e6f2; line-height:1.1; white-space:nowrap;">${esc(shortenName(m.name))}</div>
        ${subRow}
      </div>
      ${lockGlyph}
    </div>
  `;
}

function renderRow(roleKey, members) {
  if (members.length === 0) return '';
  const cards = members.map(m => renderCard(m, CARD_WIDTH)).join('');
  return `<div style="display:flex; flex-direction:row; flex-wrap:wrap; align-items:center; gap:12px; margin-bottom:10px;">${cards}</div>`;
}

// Placeholder pour un slot DPS vide dans la sous-grille (ex: 1 mêlée +
// 2 non-mêlées en raid8 → M2 vide). Préserve l'alignement sans imiter
// une vraie carte.
function renderEmptyDpsCard(width) {
  return `
    <div style="box-sizing:border-box; display:flex; align-items:center; justify-content:center; height:54px; width:${width}px; border:1px dashed rgba(255,255,255,0.1); background:rgba(0,0,0,0.15); color:#3a4a5c; font-size:18px; font-family:monospace;">—</div>
  `;
}

// Layout en colonnes (TANKS | HEALERS | DPS 2×2) — mime la composition finale
// affichée en bas de la page web. Utilisé pour les contenus ≤ 8 joueurs
// (dungeon, raid8) où la grille tient confortablement dans 1200×630.
//
// Largeurs :
//   tank/heal col  = COL_W (260px) chacune
//   dps col bloc   = 2 × COL_W (520px) découpé en sous-grille 2 cartes/ligne
//   3 colonnes + 2 gaps de 20px = 1080px, tient dans 1200 - 2*56 padding.
// `dpsLayout` est un tableau sparse (size = slotCount, certains items
// peuvent être null = slot vide). On itère dans l'ordre des positions.
function renderColumnLayout(rows, dict, dpsLayout) {
  // Layout 4 colonnes égales : Tanks | Heals | M-DPS | R-DPS.
  // Avant on rendait DPS comme un bloc 2-cards/row imbriqué (sub-grid avec
  // width:dpsWidth=520), ce qui forçait satori à écraser les 2 sub-cards
  // (visuellement 271px chacune avec padding+border) pour rentrer dans 520.
  // Maintenant les sub-cards DPS sont 2 colonnes sœurs des tanks/heals →
  // aucune contrainte de largeur nested → toutes les cards rendent pareil.
  //
  // Largeur utile = 1200 - 56*2 = 1088.
  // Total visuel : 4 × CARD_VISUAL_W + 3 × COL_GAP.
  // Satori ignore box-sizing:border-box → width sur la card = CONTENU.
  // Une card avec padding 0 10 0 8 + border-left 3 = 21px de débord.
  // Donc renderCard(m, 229) → visuel 250. Total : 4×250 + 3×20 = 1060 ≤ 1088.
  const COL_W = 250;            // largeur visuelle voulue par colonne
  const COL_GAP = 20;
  const CARD_BOX_EXTRA = 21;    // 8 + 10 padding + 3 border-left
  const CARD_W = COL_W - CARD_BOX_EXTRA;  // 229 (passé à renderCard)
  const HDR_COLORS = {
    tank: '#2b9eff', heal: '#4ade80', dps: '#ff4f6e'
  };

  function header(label, color, width) {
    return `<div style="display:flex; align-items:center; justify-content:center; width:${width}px; height:30px; color:${color}; font-size:14px; letter-spacing:3px; font-weight:700; border-bottom:1px solid ${color}66;">${esc(label)}</div>`;
  }

  function columnCards(cards) {
    return `
      <div style="display:flex; flex-direction:column; width:${COL_W}px; gap:8px;">
        ${cards.join('')}
      </div>
    `;
  }

  // Sépare le dpsLayout en M (positions paires) et R (positions impaires)
  // pour rendre 2 colonnes sœurs au lieu d'un sub-grid imbriqué.
  const dpsSource = Array.isArray(dpsLayout) && dpsLayout.length > 0 ? dpsLayout : rows.dps;
  const mCards = [];
  const rCards = [];
  dpsSource.forEach((item, i) => {
    const target = (i % 2 === 0) ? mCards : rCards;
    target.push(item ? renderCard(item, CARD_W) : renderEmptyDpsCard(CARD_W));
  });

  // DPS header span sur 2 colonnes (M + R) pour ne pas en avoir 2 séparés.
  const dpsHeaderWidth = COL_W * 2 + COL_GAP;

  return `
    <div style="display:flex; flex-direction:column;">
      <div style="display:flex; flex-direction:row; gap:${COL_GAP}px; margin-bottom:12px;">
        ${header(dict.colTanks,  HDR_COLORS.tank, COL_W)}
        ${header(dict.colHeals,  HDR_COLORS.heal, COL_W)}
        ${header(dict.colDps,    HDR_COLORS.dps,  dpsHeaderWidth)}
      </div>
      <div style="display:flex; flex-direction:row; gap:${COL_GAP}px; align-items:flex-start;">
        ${columnCards(rows.tank.map(m => renderCard(m, CARD_W)))}
        ${columnCards(rows.heal.map(m => renderCard(m, CARD_W)))}
        ${columnCards(mCards)}
        ${columnCards(rCards)}
      </div>
    </div>
  `;
}

export async function onRequestGet({ params, env, request }) {
  if (!env.PARTY_KV) return new Response('KV missing', { status: 500 });
  const id = params.id;
  if (!VALID_ID.test(id)) return new Response('Invalid id', { status: 400 });

  const lang = pickLang(request.headers);
  const dict = OG_STRINGS[lang];

  const raw = await env.PARTY_KV.get(id);
  if (!raw) return new Response('Not found', { status: 404 });

  // Cache hit ? La langue fait partie de la clé (titre "Donjon" vs "Dungeon")
  // et la version du layout aussi (bump = invalidate global).
  const contentHash = await shortHash(raw);
  const cacheKey = `og:v${OG_LAYOUT_VERSION}:${id}:${lang}:${contentHash}`;
  const cached = await env.PARTY_KV.get(cacheKey, 'arrayBuffer');
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        // L'URL exposée par le middleware contient déjà le hash → immutable
        // pour les CDN/scrapers, mais on garde max-age=60 pour le cas où
        // quelqu'un hit /og/<id> sans ?v= (curl, test direct).
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
        'X-OG-Cache': 'hit'
      }
    });
  }

  let data;
  try { data = JSON.parse(raw); }
  catch { return new Response('Bad data', { status: 500 }); }

  const { players, assignment, results } = computeForOg(data, id);

  // Layout 3-col (TANKS | HEALERS | DPS 2×2) pour les contenus ≤ 8 joueurs,
  // miroir de la composition finale affichée en bas de la page web. Pour
  // raid24 / chaotic 24, on retombe sur le layout par lignes (`rows.melee` +
  // `rows.ranged` mêlant ranged et caster) parce que 24 cartes ne tiennent
  // pas en 4 col × 2 row dans 1200×630.
  const useColumnLayout = data.c === 'dungeon' || data.c === 'raid8';

  // Étiquetage strat (MT/OT/H1/H2/M1/M2/R1/R2) seulement sur dungeon/raid8.
  // Pour raid24, le compute est global (24 joueur·euses ensemble, pas par
  // alliance) → un label "M1" globalement n'a pas le même sens qu'un "M1"
  // d'alliance, et le layout par lignes ne distingue pas les alliances :
  // afficher les labels serait trompeur. On les omet ici, ils restent
  // visibles sur la page (rendue par alliance, cf. renderRaid24Result).
  let dpsLayout = null;
  if (useColumnLayout && Array.isArray(results) && results.length > 0) {
    const compRaw = CONTENT_COMP[data.c];
    const dpsSlotCount = (compRaw && compRaw.comp && compRaw.comp.dps) || 4;
    // Annote gridPosition sur chaque DPS pour placement positionnel
    // (mêlées en col M, autres en col R, gaps possibles)
    assignDpsGridPositions(results, dpsSlotCount);
    assignStratRoles(results, data.c);
    dpsLayout = new Array(dpsSlotCount).fill(null);
  }

  const rows = useColumnLayout
    ? { tank: [], heal: [], dps: [] }                       // 3 buckets
    : { tank: [], heal: [], melee: [], ranged: [] };        // 4 lignes legacy
  const bench = [];
  let lockedCount = 0;
  assignment.forEach((a, i) => {
    const p = players[i];
    const playerName = p ? p.name : '';
    if (!a) { bench.push({ name: playerName }); return; }
    const job = JOB_BY_ID[a.jobId];
    if (!job) return;
    const locked = !!(p && p.lockedJob && p.lockedJob === a.jobId);
    if (locked) lockedCount++;
    const stratRole = results && results[i] ? results[i].stratRole : undefined;
    const card = { name: playerName, job, locked, stratRole };
    if (useColumnLayout) {
      if (job.role === 'tank' || job.role === 'heal') {
        rows[job.role].push(card);
      } else {
        // DPS : placement positionnel via gridPosition annotée par
        // assignDpsGridPositions (mêlées en col M, autres en col R).
        const pos = results[i] && typeof results[i].gridPosition === 'number'
          ? results[i].gridPosition
          : -1;
        if (dpsLayout && pos >= 0 && pos < dpsLayout.length) {
          dpsLayout[pos] = card;
        } else {
          rows.dps.push(card); // fallback (ne devrait pas arriver)
        }
      }
    } else {
      const rowKey = job.role === 'caster' ? 'ranged' : job.role;
      (rows[rowKey] || rows.ranged).push(card);
    }
  });

  const contentLabel = dict.contentLabels[data.c] || 'Party';
  const when = data.w ? String(data.w).slice(0, 70) : '';
  const titleText = when || contentLabel;
  const titleSize = titleText.length > 38 ? 48 : titleText.length > 28 ? 56 : 68;
  const playerCount = players.length;
  const assignedCount = playerCount - bench.length;
  const playerLabel = dict.playerLabel(playerCount);
  let validationLabel = '';
  if (assignedCount > 0 && lockedCount === assignedCount) {
    validationLabel = ' · ' + dict.validated;
  } else if (lockedCount > 0) {
    validationLabel = dict.locked({ n: lockedCount });
  }
  const benchLabel = bench.length > 0 ? dict.bench({ n: bench.length }) : '';
  const subtitle = `${contentLabel} · ${playerCount} ${playerLabel}${benchLabel}${validationLabel}`;

  // Meilleur créneau (dispos) — affiché sur tous les types de contenu si
  // ≥2 personnes ont rempli leurs dispos. Pour raid24, c'est l'agrégat des
  // 24 joueur·euses (la planification du jour J = quand le plus de monde
  // peut, indépendamment de l'alliance, qui est une question opérationnelle
  // du jour J et pas de scheduling).
  let bestSlotLine = '';
  {
    const playersWithAvail = (Array.isArray(data.p) ? data.p : []).map(p => ({
      name: typeof p.n === 'string' ? p.n : '',
      presence: p.s || 'in',
      availability: p.av || null
    }));
    const avAnalysis = analyzeAvailability(playersWithAvail);
    const best = bestSlotWithTail(avAnalysis);
    if (best && best.count > 0 && avAnalysis.respondentCount >= 2) {
      const dayName = (dict.daysLong && dict.daysLong[best.day]) || best.day;
      const text = dict.bestSlot({
        day: dayName, hour: best.hour, endHour: best.endHour,
        count: best.count, total: avAnalysis.respondentCount
      });
      bestSlotLine = `<div style="display:flex; font-size:18px; color:#4ade80; margin-bottom:14px;">${esc(text)}</div>`;
    }
  }

  const html = `
    <div style="display:flex; flex-direction:column; width:100%; height:100%; background:#050810; padding:46px 56px; font-family:sans-serif;">
      <div style="display:flex; font-size:22px; color:#00e5ff; letter-spacing:6px; margin-bottom:14px;">◆ PARTY // BUILDER</div>
      <div style="display:flex; font-size:${titleSize}px; font-weight:700; color:#d7e6f2; line-height:1.05; margin-bottom:6px;">${esc(titleText)}</div>
      <div style="display:flex; font-size:22px; color:#ff2e9a; margin-bottom:${bestSlotLine ? '12' : '26'}px;">${esc(subtitle)}</div>
      ${bestSlotLine}

      ${useColumnLayout ? renderColumnLayout(rows, dict, dpsLayout) : (
        renderRow('tank', rows.tank) +
        renderRow('heal', rows.heal) +
        renderRow('melee', rows.melee) +
        renderRow('ranged', rows.ranged)
      )}

      <div style="display:flex; margin-top:auto; justify-content:space-between; align-items:flex-end;">
        <div style="display:flex; font-size:20px; color:#3a4a5c;">${esc(dict.salon({ id }))}</div>
        <div style="display:flex; font-size:20px; color:#3a4a5c;">party-builder.pages.dev</div>
      </div>
    </div>
  `;

  try {
    const response = new ImageResponse(html, {
      width: 1200,
      height: 630,
      format: 'png',
      headers: {
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
        'X-OG-Cache': 'miss'
      }
    });
    // Stocke le PNG en KV pour les scrapes suivants du même hash. On clone
    // pour ne pas consommer le body du response qu'on retourne. Best-effort :
    // si KV échoue (rare), on continue, le worst case c'est qu'on re-rasterize
    // au prochain hit.
    try {
      const bytes = await response.clone().arrayBuffer();
      await env.PARTY_KV.put(cacheKey, bytes, { expirationTtl: OG_CACHE_TTL });
    } catch { /* swallow */ }
    return response;
  } catch (e) {
    return fallback('OG render error: ' + (e && e.message ? e.message : 'unknown'));
  }
}
