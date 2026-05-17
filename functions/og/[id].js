// GET /og/:id
// Image PNG personnalisée pour le salon. Importe le scoring depuis lib/
// (source de vérité partagée avec le front) puis dispose les joueurs
// assignés sur 4 lignes par rôle.
// Rendu : workers-og (satori + resvg-wasm), HTML/CSS flexbox uniquement.

import { ImageResponse } from 'workers-og';
import { JOB_BY_ID, CONTENT_COMP, ROLE_COLOR } from '../../lib/jobs.js';
import { buildSlotsFromComp, computeOptimalAssignment } from '../../lib/scoring.js';
import { analyzeAvailability, bestSlotWithTail } from '../../lib/availability.js';
import { assignStratRoles, reorderResultsForDpsLayout } from '../../lib/strat-roles.js';

const VALID_ID = /^[A-Za-z0-9]{4,12}$/;

// Cache PNG en KV : la rasterization workers-og (satori + resvg-wasm) coûte
// 300-500ms CPU par scrape. La sortie est déterministe pour un (id, contenu)
// donné → on cache l'output sous `og:<id>:<lang>:<hash(KV)>` avec TTL 7j.
// Le hash change quand le salon est modifié → cache stale auto.
// VERSION : à incrémenter quand on change le layout du rendu (sinon les
// vieux PNG cachés restent servis tant que le salon n'est pas modifié).
const OG_CACHE_TTL = 7 * 86400;
const OG_LAYOUT_VERSION = 10; // v10 : DPS reorder mêlées→col M, ranged/casters→col R

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
function computeForOg(data) {
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
    topK: 1
  });

  if (out.error) {
    return { players: rawPlayers, assignment: new Array(rawPlayers.length).fill(null), results: [] };
  }

  // Réorganise les DPS (mêlées en col M, autres en col R) avant de
  // reconstruire l'assignment côté caller — l'order des entries détermine
  // les positions dans la sous-grille DPS de l'OG.
  const reordered = reorderResultsForDpsLayout(out.results);

  const assignment = reordered.map(r => {
    if (!r.assigned) return null;
    return { jobId: r.jobId };
  });
  // Le caller doit aussi récupérer `players` reordonné (les noms doivent
  // matcher les nouvelles positions). On reconstruit players via name.
  const playersByName = new Map(rawPlayers.map(p => [p.name, p]));
  const reorderedPlayers = reordered.map(r => playersByName.get(r.name) || { name: r.name });
  return { players: reorderedPlayers, assignment, results: reordered };
}

function esc(s) {
  return String(s).replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
}

// Compacte un nom FFXIV "Prénom Nom" en "Prénom N." pour les cartes de
// l'OG image. Satori ne mesure pas le texte de façon prévisible (la
// largeur des chars en Chakra Petch varie beaucoup : "Alice Erisia" tient
// alors que "Daga Arken" wrap, à longueur égale) → on ne se fie pas au
// nombre de chars mais à la STRUCTURE du nom :
//   - 1 seul mot → kept tel quel (cap large avec ellipsis si très long)
//   - 2+ mots (cas FFXIV "Prénom Nom") → TOUJOURS abrégé "Prénom N."
// Le prénom est tronqué à FIRST_MAX chars si très long.
function shortenName(name) {
  const FIRST_MAX = 9;          // cap pour le 1er token quand on a 2+ mots
  const SINGLE_WORD_MAX = 14;   // cap pour les noms à 1 seul mot
  const trimmed = String(name || '').trim();
  if (!trimmed) return trimmed;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) {
    return trimmed.length <= SINGLE_WORD_MAX
      ? trimmed
      : trimmed.slice(0, SINGLE_WORD_MAX - 1) + '…';
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
  // Badge rôle strat (MT/OT/H1/H2/M1/M2/R1/R2). Affiché seulement si fourni
  // par le caller (donc dungeon/raid8 uniquement, pas raid24 où l'agrégat
  // global serait trompeur sans split par alliance).
  const stratBadge = m.stratRole
    ? `<div style="display:flex; align-items:center; justify-content:center; height:20px; padding:0 6px; margin-right:8px; border:1px solid ${roleColor}99; color:${roleColor}; background:rgba(0,0,0,0.4); font-size:12px; font-weight:700; letter-spacing:1px; font-family:monospace; flex-shrink:0;">${esc(m.stratRole)}</div>`
    : '';
  return `
    <div style="display:flex; align-items:center; height:54px; width:${width}px; padding:0 10px 0 8px; border-left:3px solid ${roleColor}; ${lockBorder}">
      <img src="${iconUrl(m.job)}" width="40" height="40" style="margin-right:12px; flex-shrink:0;" />
      <div style="display:flex; flex-direction:column; overflow:hidden;">
        <div style="display:flex; flex-direction:row; align-items:center; font-size:22px; font-weight:600; color:#d7e6f2; line-height:1.1; white-space:nowrap;">
          ${stratBadge}
          <span style="display:flex;">${esc(shortenName(m.name))}</span>
        </div>
        <div style="display:flex; font-size:16px; color:${roleColor}; line-height:1.1; margin-top:2px;">${esc(m.job.name)}</div>
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

// Layout en colonnes (TANKS | HEALERS | DPS 2×2) — mime la composition finale
// affichée en bas de la page web. Utilisé pour les contenus ≤ 8 joueurs
// (dungeon, raid8) où la grille tient confortablement dans 1200×630.
//
// Largeurs :
//   tank/heal col  = COL_W (260px) chacune
//   dps col bloc   = 2 × COL_W (520px) découpé en sous-grille 2 cartes/ligne
//   3 colonnes + 2 gaps de 20px = 1080px, tient dans 1200 - 2*56 padding.
function renderColumnLayout(rows, dict) {
  const COL_W = 260;
  const COL_GAP = 20;
  const HDR_COLORS = {
    tank: '#2b9eff', heal: '#4ade80', dps: '#ff4f6e'
  };

  function header(label, color, width) {
    return `<div style="display:flex; align-items:center; justify-content:center; width:${width}px; height:30px; color:${color}; font-size:14px; letter-spacing:3px; font-weight:700; border-bottom:1px solid ${color}66; margin-bottom:12px;">${esc(label)}</div>`;
  }

  function column(headerLabel, color, width, cards) {
    return `
      <div style="display:flex; flex-direction:column; width:${width}px;">
        ${header(headerLabel, color, width)}
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${cards.join('')}
        </div>
      </div>
    `;
  }

  // DPS = colonne large avec sous-grille 2 cartes / ligne. Satori est
  // imprévisible avec `flex-wrap` (il rend souvent en colonne stretched
  // même quand le container fait la bonne largeur), donc on découpe nous-
  // mêmes en sous-rows explicites de 2 cartes.
  const dpsWidth = COL_W * 2 + COL_GAP;
  const dpsRows = [];
  for (let i = 0; i < rows.dps.length; i += 2) dpsRows.push(rows.dps.slice(i, i + 2));
  const dpsGrid = dpsRows.map(rowItems => `
    <div style="display:flex; flex-direction:row; gap:${COL_GAP}px;">
      ${rowItems.map(m => renderCard(m, COL_W)).join('')}
    </div>
  `).join('');

  return `
    <div style="display:flex; flex-direction:row; gap:${COL_GAP}px; align-items:flex-start;">
      ${column(dict.colTanks, HDR_COLORS.tank, COL_W, rows.tank.map(m => renderCard(m, COL_W)))}
      ${column(dict.colHeals, HDR_COLORS.heal, COL_W, rows.heal.map(m => renderCard(m, COL_W)))}
      <div style="display:flex; flex-direction:column; width:${dpsWidth}px;">
        ${header(dict.colDps, HDR_COLORS.dps, dpsWidth)}
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${dpsGrid}
        </div>
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

  const { players, assignment, results } = computeForOg(data);

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
  if (useColumnLayout && Array.isArray(results) && results.length > 0) {
    assignStratRoles(results, data.c);
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
    if (useColumnLayout) {
      // Tank / Heal séparés, tout le reste (melee + ranged + caster) dans dps,
      // dans l'ordre des joueurs assignés (= ordre du résultat scoring).
      if (job.role === 'tank' || job.role === 'heal') {
        rows[job.role].push({ name: playerName, job, locked, stratRole });
      } else {
        rows.dps.push({ name: playerName, job, locked, stratRole });
      }
    } else {
      const rowKey = job.role === 'caster' ? 'ranged' : job.role;
      (rows[rowKey] || rows.ranged).push({ name: playerName, job, locked, stratRole });
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

      ${useColumnLayout ? renderColumnLayout(rows, dict) : (
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
