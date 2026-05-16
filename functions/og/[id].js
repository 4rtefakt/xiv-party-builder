// GET /og/:id
// Renvoie une image PNG personnalisée pour le salon (utilisée comme og:image)
// Rendu via workers-og (satori + resvg-wasm), HTML/CSS-like syntax (flexbox only).

import { ImageResponse } from 'workers-og';

const VALID_ID = /^[A-Za-z0-9]{4,12}$/;

const JOB_LABELS = {
  PLD: 'Paladin', WAR: 'Warrior', DRK: 'Dark Knight', GNB: 'Gunbreaker',
  WHM: 'White Mage', AST: 'Astrologian', SCH: 'Scholar', SGE: 'Sage',
  MNK: 'Monk', DRG: 'Dragoon', NIN: 'Ninja', SAM: 'Samurai', RPR: 'Reaper', VPR: 'Viper',
  BRD: 'Bard', MCH: 'Machinist', DNC: 'Dancer',
  BLM: 'Black Mage', SMN: 'Summoner', RDM: 'Red Mage', PCT: 'Pictomancer'
};
const ROLE_OF = {
  PLD:'tank', WAR:'tank', DRK:'tank', GNB:'tank',
  WHM:'heal', AST:'heal', SCH:'heal', SGE:'heal',
  MNK:'melee', DRG:'melee', NIN:'melee', SAM:'melee', RPR:'melee', VPR:'melee',
  BRD:'ranged', MCH:'ranged', DNC:'ranged',
  BLM:'caster', SMN:'caster', RDM:'caster', PCT:'caster'
};
const ROLE_COLOR = {
  tank: '#2b9eff', heal: '#4ade80', melee: '#ff4f6e',
  ranged: '#ffb547', caster: '#c084fc'
};
const CONTENT_LABEL = { dungeon: 'Donjon · 4', raid8: 'Raid · 8', raid24: 'Alliance · 24' };

// Satori (workers-og) ne décode pas les entités HTML dans les nœuds texte :
// '&#39;' apparaîtrait littéralement à l'écran. On n'échappe donc que les
// caractères qui cassent la structure HTML (<, >, &). Les apostrophes et
// guillemets restent bruts (sans danger ici, on n'injecte rien dans des
// attributs avec du contenu utilisateur).
function esc(s) {
  return String(s).replace(/[<>&]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;'
  }[c]));
}

function fallback(text) {
  return new Response(text, { status: 500, headers: { 'Content-Type': 'text/plain' } });
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

  const title = CONTENT_LABEL[data.c] || data.c || 'Party';
  const when = data.w ? String(data.w).slice(0, 60) : '';

  const players = (Array.isArray(data.p) ? data.p : [])
    .filter(p => p && typeof p.n === 'string' && p.n.trim() && p.s !== 'out')
    .slice(0, 8);

  const playerCount = players.length;
  const countLabel = playerCount === 0
    ? 'aucun joueur encore'
    : `${playerCount} joueur${playerCount > 1 ? 's' : ''}`;

  const playerCards = players.map(p => {
    const firstJobId = Array.isArray(p.j) && p.j[0] ? p.j[0] : null;
    const firstJobName = firstJobId ? (JOB_LABELS[firstJobId] || firstJobId) : '—';
    const role = firstJobId ? (ROLE_OF[firstJobId] || 'tank') : null;
    const color = role ? ROLE_COLOR[role] : '#6a8094';
    const name = esc(String(p.n).slice(0, 18));
    const tag = p.s === 'maybe' ? ' (?)' : '';
    return `<div style="display:flex; align-items:center; width:520px; padding:6px 0;">
      <div style="display:flex; width:14px; height:14px; border-radius:7px; background:${color}; margin-right:16px;"></div>
      <div style="display:flex; flex-direction:column;">
        <div style="display:flex; font-size:28px; font-weight:600; color:#d7e6f2;">${name}${tag}</div>
        <div style="display:flex; font-size:20px; color:${color};">${esc(firstJobName)}</div>
      </div>
    </div>`;
  }).join('');

  const html = `
    <div style="display:flex; flex-direction:column; width:100%; height:100%; background:#050810; padding:60px; font-family:sans-serif;">
      <div style="display:flex; font-size:24px; color:#00e5ff; letter-spacing:6px; margin-bottom:24px;">◆ PARTY // BUILDER</div>
      <div style="display:flex; font-size:84px; font-weight:700; color:#d7e6f2; line-height:1; margin-bottom:14px;">${esc(title)}</div>
      ${when
        ? `<div style="display:flex; font-size:36px; color:#ff2e9a; font-weight:500; margin-bottom:34px;">${esc(when)}</div>`
        : `<div style="display:flex; height:50px;"></div>`}
      <div style="display:flex; flex-wrap:wrap; gap:6px 40px;">${playerCards}</div>
      <div style="display:flex; margin-top:auto; justify-content:space-between; align-items:flex-end;">
        <div style="display:flex; font-size:22px; color:#6a8094;">${esc(countLabel)} · salon ${esc(id)}</div>
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
