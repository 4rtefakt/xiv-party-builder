// GET /og/:id
// Renvoie une image SVG personnalisée pour le salon (utilisée comme og:image)

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

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
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

  const W = 1200, H = 630;
  const rowsCount = Math.ceil(players.length / 2);
  const rowH = 56;
  const playersStartY = when ? 290 : 250;

  const playerSvg = players.map((p, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 60 + col * 560;
    const y = playersStartY + row * rowH;
    const firstJobId = Array.isArray(p.j) && p.j[0] ? p.j[0] : null;
    const firstJobName = firstJobId ? (JOB_LABELS[firstJobId] || firstJobId) : '—';
    const role = firstJobId ? (ROLE_OF[firstJobId] || 'tank') : null;
    const color = role ? ROLE_COLOR[role] : '#6a8094';
    const name = escapeXml(String(p.n).slice(0, 18));
    const tag = p.s === 'maybe' ? ' (?)' : '';
    return `
      <circle cx="${x + 8}" cy="${y - 10}" r="6" fill="${color}"/>
      <text x="${x + 28}" y="${y - 4}" font-family="'Chakra Petch', sans-serif" font-size="26" font-weight="500" fill="#d7e6f2">${name}${tag}</text>
      <text x="${x + 28}" y="${y + 22}" font-family="'Chakra Petch', sans-serif" font-size="18" fill="${color}" opacity="0.85">${escapeXml(firstJobName)}</text>
    `;
  }).join('');

  const playerCount = players.length;
  const playerCountLabel = playerCount === 0
    ? 'aucun joueur encore'
    : `${playerCount} joueur${playerCount > 1 ? 's' : ''}`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#020308"/>
      <stop offset="50%" stop-color="#050810"/>
      <stop offset="100%" stop-color="#0a0f1a"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(0,229,255,0.06)" stroke-width="1"/>
    </pattern>
    <radialGradient id="glow" cx="20%" cy="0%" r="60%">
      <stop offset="0%" stop-color="rgba(0,229,255,0.18)"/>
      <stop offset="100%" stop-color="rgba(0,229,255,0)"/>
    </radialGradient>
    <radialGradient id="glow2" cx="100%" cy="100%" r="60%">
      <stop offset="0%" stop-color="rgba(255,46,154,0.15)"/>
      <stop offset="100%" stop-color="rgba(255,46,154,0)"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glow2)"/>

  <text x="60" y="80" font-family="'Chakra Petch', sans-serif" font-size="24" font-weight="500" fill="#00e5ff" letter-spacing="8">◆ PARTY // BUILDER</text>
  <text x="60" y="180" font-family="'Chakra Petch', sans-serif" font-size="84" font-weight="700" fill="#d7e6f2">${escapeXml(title)}</text>
  ${when ? `<text x="60" y="240" font-family="'Chakra Petch', sans-serif" font-size="36" font-weight="500" fill="#ff2e9a">${escapeXml(when)}</text>` : ''}

  ${playerSvg}

  <text x="60" y="${H - 50}" font-family="'Chakra Petch', sans-serif" font-size="22" fill="#6a8094">${escapeXml(playerCountLabel)} · salon ${escapeXml(id)}</text>
  <text x="${W - 60}" y="${H - 50}" text-anchor="end" font-family="'JetBrains Mono', monospace" font-size="20" fill="#3a4a5c">party-builder.pages.dev</text>
</svg>`;

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
