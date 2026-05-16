// GET /og/:id
// Image PNG personnalisée pour le salon. Reproduit l'algorithme d'affectation
// optimale du client puis dispose les joueurs assignés sur 4 lignes par rôle.
// Rendu : workers-og (satori + resvg-wasm), HTML/CSS flexbox uniquement.

import { ImageResponse } from 'workers-og';

const VALID_ID = /^[A-Za-z0-9]{4,12}$/;

// ============================================================
// JOBS & CONTENU — miroir de l'index.html
// ============================================================

const JOBS = [
  { id: 'PLD', name: 'Paladin',     role: 'tank',   icon: 'paladin'     },
  { id: 'WAR', name: 'Warrior',     role: 'tank',   icon: 'warrior'     },
  { id: 'DRK', name: 'Dark Knight', role: 'tank',   icon: 'darkknight'  },
  { id: 'GNB', name: 'Gunbreaker',  role: 'tank',   icon: 'gunbreaker'  },
  { id: 'WHM', name: 'White Mage',  role: 'heal',   icon: 'whitemage'   },
  { id: 'AST', name: 'Astrologian', role: 'heal',   icon: 'astrologian' },
  { id: 'SCH', name: 'Scholar',     role: 'heal',   icon: 'scholar'     },
  { id: 'SGE', name: 'Sage',        role: 'heal',   icon: 'sage'        },
  { id: 'MNK', name: 'Monk',        role: 'melee',  icon: 'monk'        },
  { id: 'DRG', name: 'Dragoon',     role: 'melee',  icon: 'dragoon'     },
  { id: 'NIN', name: 'Ninja',       role: 'melee',  icon: 'ninja'       },
  { id: 'SAM', name: 'Samurai',     role: 'melee',  icon: 'samurai'     },
  { id: 'RPR', name: 'Reaper',      role: 'melee',  icon: 'reaper'      },
  { id: 'VPR', name: 'Viper',       role: 'melee',  icon: 'viper'       },
  { id: 'BRD', name: 'Bard',        role: 'ranged', icon: 'bard'        },
  { id: 'MCH', name: 'Machinist',   role: 'ranged', icon: 'machinist'   },
  { id: 'DNC', name: 'Dancer',      role: 'ranged', icon: 'dancer'      },
  { id: 'BLM', name: 'Black Mage',  role: 'caster', icon: 'blackmage'   },
  { id: 'SMN', name: 'Summoner',    role: 'caster', icon: 'summoner'    },
  { id: 'RDM', name: 'Red Mage',    role: 'caster', icon: 'redmage'     },
  { id: 'PCT', name: 'Pictomancer', role: 'caster', icon: 'pictomancer' }
];

const JOB_BY_ID = Object.fromEntries(JOBS.map(j => [j.id, j]));
const JOBS_BY_ROLE = JOBS.reduce((acc, j) => {
  (acc[j.role] ||= []).push(j);
  return acc;
}, {});

const ICON_BASE = 'https://cdn.jsdelivr.net/gh/xivapi/classjob-icons@master/icons/';
const iconUrl = (job) => ICON_BASE + job.icon + '.png';

const ROLE_COLOR = {
  tank: '#2b9eff', heal: '#4ade80', melee: '#ff4f6e',
  ranged: '#ffb547', caster: '#c084fc'
};

const CONTENT_BASE = {
  dungeon: { label: 'Donjon',  size: 4,  comp: { tank: 1, heal: 1, dps: 2  } },
  raid8:   { label: 'Raid 8',  size: 8,  comp: { tank: 2, heal: 2, dps: 4  } },
  raid24:  { label: 'Raid 24', size: 24, comp: { tank: 3, heal: 6, dps: 15 } }
};

// ============================================================
// OPTIMIZER — branch & bound (top-1), miroir de computeOptimalAssignment
// ============================================================

const SCORING = {
  FIRST_CHOICE: 100, PREF_STEP: 10, FORCED_BASE: -50, BENCH: -30,
  FRUST_PER_RANK: 30, FRUST_FORCED: 400, FRUST_BENCH: 150
};

function buildSlots(contentKey, dpsMode) {
  const base = CONTENT_BASE[contentKey];
  if (!base) return [];
  const slots = [];
  for (let i = 0; i < base.comp.tank; i++) slots.push({ roles: ['tank'] });
  for (let i = 0; i < base.comp.heal; i++) slots.push({ roles: ['heal'] });
  const dpsCount = base.comp.dps;
  if (dpsMode === 'unified') {
    for (let i = 0; i < dpsCount; i++) slots.push({ roles: ['melee', 'ranged', 'caster'] });
  } else {
    const melee = Math.ceil(dpsCount / 2);
    const distance = dpsCount - melee;
    for (let i = 0; i < melee; i++) slots.push({ roles: ['melee'] });
    for (let i = 0; i < distance; i++) slots.push({ roles: ['ranged', 'caster'] });
  }
  return slots;
}

function jobScoreForPlayer(player, jobId, fairnessWeight) {
  const idx = player.preferences.indexOf(jobId);
  const w = fairnessWeight / 100;
  if (idx === -1) {
    return { score: SCORING.FORCED_BASE - SCORING.FRUST_FORCED * w, forced: true };
  }
  const baseScore = SCORING.FIRST_CHOICE - idx * SCORING.PREF_STEP;
  return { score: baseScore - idx * SCORING.FRUST_PER_RANK * w, forced: false };
}

function benchScore(fairnessWeight) {
  return SCORING.BENCH - SCORING.FRUST_BENCH * (fairnessWeight / 100);
}

function computeAssignment(data) {
  const fairnessWeight = typeof data.f === 'number' ? data.f : 50;
  const slots = buildSlots(data.c, data.d);
  const banned = new Set(Array.isArray(data.bj) ? data.bj : []);
  const players = (Array.isArray(data.p) ? data.p : [])
    .filter(p => p && typeof p.n === 'string' && p.n.trim() !== '' && p.s !== 'out')
    .map(p => ({
      name: p.n.trim(),
      preferences: (Array.isArray(p.j) ? p.j : []).filter(id => !banned.has(id))
    }));

  if (players.length === 0 || slots.length === 0) {
    return { players, assignment: new Array(players.length).fill(null) };
  }

  const n = players.length;
  const m = slots.length;
  const benchSc = benchScore(fairnessWeight);

  const bestPerPlayer = players.map(p => p.preferences.length === 0
    ? Math.max(jobScoreForPlayer(p, '__none__', fairnessWeight).score, benchSc)
    : SCORING.FIRST_CHOICE);

  const upperBoundFrom = i => {
    let s = 0;
    for (let k = i; k < n; k++) s += bestPerPlayer[k];
    return s;
  };

  let bestScore = -Infinity;
  let bestAssignment = null;
  const current = new Array(n).fill(null);
  const slotTaken = new Array(m).fill(false);

  function recurse(playerIdx, currentScore) {
    if (currentScore + upperBoundFrom(playerIdx) <= bestScore) return;
    if (playerIdx === n) {
      bestScore = currentScore;
      bestAssignment = current.map(a => a ? { ...a } : null);
      return;
    }
    const player = players[playerIdx];
    const options = [];
    const seen = new Set();
    for (let slotIdx = 0; slotIdx < m; slotIdx++) {
      if (slotTaken[slotIdx]) continue;
      const slot = slots[slotIdx];
      const candidates = new Set();
      for (const role of slot.roles) {
        for (const job of JOBS_BY_ROLE[role]) {
          if (banned.has(job.id)) continue;
          if (player.preferences.includes(job.id)) candidates.add(job.id);
        }
        const hasPref = JOBS_BY_ROLE[role].some(j => !banned.has(j.id) && player.preferences.includes(j.id));
        if (!hasPref) {
          const fallback = JOBS_BY_ROLE[role].find(j => !banned.has(j.id));
          if (fallback) candidates.add(fallback.id);
        }
      }
      for (const jobId of candidates) {
        const key = slotIdx + ':' + jobId;
        if (seen.has(key)) continue;
        seen.add(key);
        const { score } = jobScoreForPlayer(player, jobId, fairnessWeight);
        options.push({ slotIdx, jobId, score });
      }
    }
    options.push({ slotIdx: null, jobId: null, score: benchSc });
    options.sort((a, b) => b.score - a.score);
    for (const opt of options) {
      if (opt.slotIdx !== null) {
        slotTaken[opt.slotIdx] = true;
        current[playerIdx] = { slotIdx: opt.slotIdx, jobId: opt.jobId };
        recurse(playerIdx + 1, currentScore + opt.score);
        slotTaken[opt.slotIdx] = false;
        current[playerIdx] = null;
      } else {
        current[playerIdx] = null;
        recurse(playerIdx + 1, currentScore + opt.score);
      }
    }
  }

  recurse(0, 0);

  return { players, assignment: bestAssignment || new Array(n).fill(null) };
}

// ============================================================
// RENDERING
// ============================================================

function esc(s) {
  return String(s).replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
}

function fallback(text) {
  return new Response(text, { status: 500, headers: { 'Content-Type': 'text/plain' } });
}

function renderRow(roleKey, members) {
  if (members.length === 0) return '';
  const cards = members.map(m => `
    <div style="display:flex; align-items:center; height:54px; padding:0 12px 0 8px; background:rgba(255,255,255,0.03); border-left:3px solid ${ROLE_COLOR[m.job.role]}; margin-right:14px;">
      <img src="${iconUrl(m.job)}" width="40" height="40" style="margin-right:12px;" />
      <div style="display:flex; flex-direction:column;">
        <div style="display:flex; font-size:22px; font-weight:600; color:#d7e6f2; line-height:1.1;">${esc(m.name)}</div>
        <div style="display:flex; font-size:16px; color:${ROLE_COLOR[m.job.role]}; line-height:1.1; margin-top:2px;">${esc(m.job.name)}</div>
      </div>
    </div>
  `).join('');
  return `<div style="display:flex; flex-direction:row; flex-wrap:wrap; align-items:center; margin-bottom:10px;">${cards}</div>`;
}

export async function onRequestGet({ params, env }) {
  if (!env.PARTY_KV) return new Response('KV missing', { status: 500 });
  const id = params.id;
  if (!VALID_ID.test(id)) return new Response('Invalid id', { status: 400 });

  const raw = await env.PARTY_KV.get(id);
  if (!raw) return new Response('Not found', { status: 404 });

  let data;
  try { data = JSON.parse(raw); }
  catch { return new Response('Bad data', { status: 500 }); }

  const { players, assignment } = computeAssignment(data);

  // Regroupe les joueurs assignés par rôle pour l'affichage.
  // ranged ET caster vont sur la même ligne ("Distance").
  const rows = { tank: [], heal: [], melee: [], ranged: [] };
  const bench = [];
  assignment.forEach((a, i) => {
    const playerName = players[i] ? players[i].name : '';
    if (!a) { bench.push({ name: playerName }); return; }
    const job = JOB_BY_ID[a.jobId];
    if (!job) return;
    const rowKey = job.role === 'caster' ? 'ranged' : job.role;
    (rows[rowKey] || rows.ranged).push({ name: playerName, job });
  });

  const ct = CONTENT_BASE[data.c] || { label: 'Party' };
  const when = data.w ? String(data.w).slice(0, 70) : '';
  const titleText = when || ct.label;
  // Auto-shrink font size if title is long
  const titleSize = titleText.length > 38 ? 48 : titleText.length > 28 ? 56 : 68;
  const playerCount = players.length;
  const subtitle = `${ct.label} · ${playerCount} joueur${playerCount > 1 ? 's' : ''}${bench.length > 0 ? ` · ${bench.length} au banc` : ''}`;

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
        <div style="display:flex; font-size:20px; color:#3a4a5c;">salon ${esc(id)}</div>
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
