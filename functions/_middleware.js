// Middleware Cloudflare Pages
// Réécrit les meta tags OG/Twitter du index.html quand on charge avec ?p=<id>,
// pour que Discord/Twitter affichent une preview personnalisée par salon.

const ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;

const STRINGS = {
  fr: {
    contentLabel: { dungeon: 'Donjon', raid8: 'Raid', raid24: 'Raid Alliance', raid24chaotic: 'Raid Chaotic' },
    desc: (n) => `${n} ${n > 1 ? 'joueur·euse·s' : 'joueur·euse'} · clique pour rejoindre le salon et ajouter ta ligne.`
  },
  en: {
    contentLabel: { dungeon: 'Dungeon', raid8: 'Raid', raid24: 'Alliance Raid', raid24chaotic: 'Chaotic Raid' },
    desc: (n) => `${n} player${n > 1 ? 's' : ''} · click to join the room and add your line.`
  }
};

function pickLang(headers) {
  const al = (headers.get('accept-language') || '').toLowerCase();
  // On regarde le 1er token : "fr-FR,fr;q=0.9,en;q=0.8" -> "fr-FR"
  const first = al.split(',')[0].trim();
  if (first.startsWith('en')) return 'en';
  return 'fr';
}

function escAttr(s) {
  return String(s).replace(/[<>&"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;'
  }[c]));
}

// Version du layout OG. À incrémenter à chaque refonte visuelle du PNG
// (worker og/[id].js). Inclus dans la query string `?v=` de l'og:image
// pour qu'un re-scrape Discord après bump produise une URL différente,
// donc invalidate le cache image côté Discord. Doit suivre OG_LAYOUT_VERSION
// dans og/[id].js.
const OG_LAYOUT_VERSION = 2;

// Hash court (8 hex chars) du JSON stocké en KV. Sert de cache-buster pour
// Discord/Twitter : ils ré-utilisent leur cache tant que le hash ne change pas,
// et re-fetch l'OG image quand le salon a été modifié. Bien plus économique
// que `?t=Date.now()` qui forçait une re-rasterization à chaque scrape.
async function shortHash(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const arr = new Uint8Array(buf, 0, 4);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // On n'intercepte que la racine
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    return context.next();
  }

  const p = url.searchParams.get('p');
  if (!p || !ID_PATTERN.test(p) || !context.env.PARTY_KV) {
    return context.next();
  }

  // Récupère le salon avant de modifier la réponse, pour éviter de relire le body si KV échoue
  let data, raw;
  try {
    raw = await context.env.PARTY_KV.get(p);
    if (!raw) return context.next();
    data = JSON.parse(raw);
  } catch {
    return context.next();
  }

  const response = await context.next();
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;

  let html;
  try { html = await response.text(); }
  catch { return context.next(); }

  const lang = pickLang(context.request.headers);
  const dict = STRINGS[lang];
  const contentLabel = dict.contentLabel[data.c] || data.c || 'Party';
  const when = data.w ? ' · ' + data.w : '';
  const title = `Party Builder · ${contentLabel}${when}`;
  const playerCount = Array.isArray(data.p)
    ? data.p.filter(x => x && x.n && x.s !== 'out').length
    : 0;
  const desc = dict.desc(playerCount);
  // Cache-bust stable : hash du contenu KV + version du layout. Tant que ces
  // deux composantes restent identiques, l'URL og:image est la même
  // → Discord/Twitter ré-utilisent leur cache (pas de re-rasterization).
  // Quand le salon est édité OU qu'on bump OG_LAYOUT_VERSION, l'URL change
  // → re-fetch côté scrapers.
  const ogImage = `${url.origin}/og/${p}?v=${OG_LAYOUT_VERSION}_${await shortHash(raw)}`;

  html = html
    .replace(/<meta property="og:title" content="[^"]*">/i,
             `<meta property="og:title" content="${escAttr(title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/i,
             `<meta property="og:description" content="${escAttr(desc)}">`)
    .replace(/<meta property="og:image" content="[^"]*">/i,
             `<meta property="og:image" content="${escAttr(ogImage)}">`)
    .replace(/<meta property="og:image:secure_url" content="[^"]*">/i,
             `<meta property="og:image:secure_url" content="${escAttr(ogImage)}">`)
    .replace(/<meta property="og:url" content="[^"]*">/i,
             `<meta property="og:url" content="${escAttr(url.origin + '/?p=' + p)}">`)
    .replace(/<meta name="twitter:title" content="[^"]*">/i,
             `<meta name="twitter:title" content="${escAttr(title)}">`)
    .replace(/<meta name="twitter:description" content="[^"]*">/i,
             `<meta name="twitter:description" content="${escAttr(desc)}">`)
    .replace(/<meta name="twitter:image" content="[^"]*">/i,
             `<meta name="twitter:image" content="${escAttr(ogImage)}">`);

  // Nouveau Response avec body modifié, headers d'origine sauf content-length
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  // Cache court pour que les changements de titre/joueurs soient pris en compte
  headers.set('Cache-Control', 'public, max-age=60');
  return new Response(html, { status: response.status, headers });
}
