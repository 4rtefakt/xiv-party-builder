// GET /og/:id
// Image PNG personnalisée pour le salon. Importe le scoring depuis lib/
// (source de vérité partagée avec le front) puis dispose les joueurs
// assignés sur 4 lignes par rôle.
// Rendu : workers-og (satori + resvg-wasm), HTML/CSS flexbox uniquement.

import { ImageResponse } from 'workers-og';
import { JOB_BY_ID, CONTENT_COMP, ROLE_COLOR } from '../../lib/jobs.js';
import { buildSlotsFromComp, computeOptimalAssignment } from '../../lib/scoring.js';

const VALID_ID = /^[A-Za-z0-9]{4,12}$/;

const ICON_BASE = 'https://cdn.jsdelivr.net/gh/xivapi/classjob-icons@master/icons/';
const iconUrl = (job) => ICON_BASE + job.icon + '.png';

const OG_STRINGS = {
  fr: {
    contentLabels: { dungeon: 'Donjon',  raid8: 'Raid 8', raid24: 'Raid 24', raid24chaotic: 'Chaotic 24' },
    playerLabel: (n) => n > 1 ? 'joueur·euse·s' : 'joueur·euse',
    bench: ({ n }) => ` · ${n} au banc`,
    locked: ({ n }) => ` · ${n} verrouillé·e·s`,
    validated: '◆ COMPO VALIDÉE',
    salon: ({ id }) => `salon ${id}`
  },
  en: {
    contentLabels: { dungeon: 'Dungeon', raid8: 'Raid 8', raid24: 'Raid 24', raid24chaotic: 'Chaotic 24' },
    playerLabel: (n) => n > 1 ? 'players' : 'player',
    bench: ({ n }) => ` · ${n} on bench`,
    locked: ({ n }) => ` · ${n} locked`,
    validated: '◆ COMP VALIDATED',
    salon: ({ id }) => `room ${id}`
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
    return { players: rawPlayers, assignment: new Array(rawPlayers.length).fill(null) };
  }

  // Reconstitue { players, assignment } à partir des results
  const assignment = out.results.map(r => {
    if (!r.assigned) return null;
    // slotIdx pas exposé dans les results ; on retrouve via le rôle + l'ordre
    // n'a pas d'importance pour le rendu (on regroupe par rôle ensuite).
    return { jobId: r.jobId };
  });
  return { players: rawPlayers, assignment };
}

function esc(s) {
  return String(s).replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
}

function fallback(text) {
  return new Response(text, { status: 500, headers: { 'Content-Type': 'text/plain' } });
}

const CARD_WIDTH = 280;

function renderRow(roleKey, members) {
  if (members.length === 0) return '';
  const cards = members.map(m => {
    const roleColor = ROLE_COLOR[m.job.role];
    const lockBorder = m.locked
      ? `border:1px solid #ffb547; background:rgba(255,181,71,0.08); box-shadow:0 0 8px rgba(255,181,71,0.25);`
      : `background:rgba(255,255,255,0.03);`;
    const lockGlyph = m.locked
      ? `<div style="display:flex; align-items:center; justify-content:center; width:18px; height:18px; color:#ffb547; font-size:14px; font-weight:700; margin-left:auto; padding:0 2px;">◆</div>`
      : '';
    return `
      <div style="display:flex; align-items:center; height:54px; width:${CARD_WIDTH}px; padding:0 10px 0 8px; border-left:3px solid ${roleColor}; ${lockBorder}">
        <img src="${iconUrl(m.job)}" width="40" height="40" style="margin-right:12px; flex-shrink:0;" />
        <div style="display:flex; flex-direction:column; overflow:hidden;">
          <div style="display:flex; font-size:22px; font-weight:600; color:#d7e6f2; line-height:1.1;">${esc(m.name)}</div>
          <div style="display:flex; font-size:16px; color:${roleColor}; line-height:1.1; margin-top:2px;">${esc(m.job.name)}</div>
        </div>
        ${lockGlyph}
      </div>
    `;
  }).join('');
  return `<div style="display:flex; flex-direction:row; flex-wrap:wrap; align-items:center; gap:12px; margin-bottom:10px;">${cards}</div>`;
}

export async function onRequestGet({ params, env, request }) {
  if (!env.PARTY_KV) return new Response('KV missing', { status: 500 });
  const id = params.id;
  if (!VALID_ID.test(id)) return new Response('Invalid id', { status: 400 });

  const lang = pickLang(request.headers);
  const dict = OG_STRINGS[lang];

  const raw = await env.PARTY_KV.get(id);
  if (!raw) return new Response('Not found', { status: 404 });

  let data;
  try { data = JSON.parse(raw); }
  catch { return new Response('Bad data', { status: 500 }); }

  const { players, assignment } = computeForOg(data);

  const rows = { tank: [], heal: [], melee: [], ranged: [] };
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
    const rowKey = job.role === 'caster' ? 'ranged' : job.role;
    (rows[rowKey] || rows.ranged).push({ name: playerName, job, locked });
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

  const html = `
    <div style="display:flex; flex-direction:column; width:100%; height:100%; background:#050810; padding:46px 56px; font-family:sans-serif;">
      <div style="display:flex; font-size:22px; color:#00e5ff; letter-spacing:6px; margin-bottom:14px;">◆ PARTY // BUILDER</div>
      <div style="display:flex; font-size:${titleSize}px; font-weight:700; color:#d7e6f2; line-height:1.05; margin-bottom:6px;">${esc(titleText)}</div>
      <div style="display:flex; font-size:22px; color:#ff2e9a; margin-bottom:26px;">${esc(subtitle)}</div>

      ${renderRow('tank', rows.tank)}
      ${renderRow('heal', rows.heal)}
      ${renderRow('melee', rows.melee)}
      ${renderRow('ranged', rows.ranged)}

      <div style="display:flex; margin-top:auto; justify-content:space-between; align-items:flex-end;">
        <div style="display:flex; font-size:20px; color:#3a4a5c;">${esc(dict.salon({ id }))}</div>
        <div style="display:flex; font-size:20px; color:#3a4a5c;">party-builder.pages.dev</div>
      </div>
    </div>
  `;

  try {
    return new ImageResponse(html, {
      width: 1200,
      height: 630,
      format: 'png',
      headers: {
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return fallback('OG render error: ' + (e && e.message ? e.message : 'unknown'));
  }
}
