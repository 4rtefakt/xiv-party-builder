// Middleware Cloudflare Pages
// Réécrit les meta tags OG/Twitter du index.html quand on charge avec ?p=<id>,
// pour que Discord/Twitter affichent une preview personnalisée par salon.

const ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;

const STRINGS = {
  fr: {
    contentLabel: { dungeon: 'Donjon', raid8: 'Raid 8', raid24: 'Alliance 24' },
    desc: (n) => `${n} ${n > 1 ? 'joueur·euse·s' : 'joueur·euse'} · clique pour rejoindre le salon et ajouter ta ligne.`
  },
  en: {
    contentLabel: { dungeon: 'Dungeon', raid8: 'Raid 8', raid24: 'Alliance 24' },
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
  let data;
  try {
    const raw = await context.env.PARTY_KV.get(p);
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
  // Cache-bust pour Discord/Twitter qui cachent les og:image par URL. Le
  // timestamp change à chaque scrape → ils re-fetch l'image fraîche.
  const ogImage = `${url.origin}/og/${p}?t=${Date.now()}`;

  html = html
    .replace(/<meta property="og:title" content="[^"]*">/i,
             `<meta property="og:title" content="${escAttr(title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/i,
             `<meta property="og:description" content="${escAttr(desc)}">`)
    .replace(/<meta property="og:image" content="[^"]*">/i,
             `<meta property="og:image" content="${escAttr(ogImage)}">`)
    .replace(/<meta name="twitter:title" content="[^"]*">/i,
             `<meta name="twitter:title" content="${escAttr(title)}">`)
    .replace(/<meta name="twitter:description" content="[^"]*">/i,
             `<meta name="twitter:description" content="${escAttr(desc)}">`)
    .replace(/<meta name="twitter:image" content="[^"]*">/i,
             `<meta name="twitter:image" content="${escAttr(ogImage)}">`)
    .replace(/<meta property="og:image:width" content="[^"]*">\s*<meta property="og:image:height" content="[^"]*">/i,
             '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:type" content="image/png">');

  // Nouveau Response avec body modifié, headers d'origine sauf content-length
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  // Cache court pour que les changements de titre/joueurs soient pris en compte
  headers.set('Cache-Control', 'public, max-age=60');
  return new Response(html, { status: response.status, headers });
}
