// GET /api/load/:id
// Headers (optionnels) :
//   X-User-Id : pour calculer isAdmin
//   X-Admin-Secret : pour valider la récupération
// Resp: payload + { isAdmin, ownerId, admins } ; pas le hash de récupération

const ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const SECRET_PATTERN = /^[A-Fa-f0-9]{32,128}$/;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'X-User-Id, X-Admin-Secret',
      ...extraHeaders
    }
  });
}

export async function onRequestGet(context) {
  const { params, env, request } = context;
  if (!env.PARTY_KV) return jsonResponse({ error: 'KV binding PARTY_KV not configured' }, 500);

  const id = params.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return jsonResponse({ error: 'Invalid id' }, 400);

  let raw;
  try { raw = await env.PARTY_KV.get(id); }
  catch { return jsonResponse({ error: 'Storage failure' }, 500); }
  if (raw === null) return jsonResponse({ error: 'Not found' }, 404);

  let data;
  try { data = JSON.parse(raw); }
  catch { return jsonResponse({ error: 'Bad data' }, 500); }

  // Calcule isAdmin si headers présents
  const userId = (request.headers.get('x-user-id') || '').trim();
  const adminSecret = (request.headers.get('x-admin-secret') || '').trim();

  let isAdmin = false;
  if (userId && USER_ID_PATTERN.test(userId)) {
    if (Array.isArray(data.admins) && data.admins.includes(userId)) {
      isAdmin = true;
    }
    // Note : ancien path "legacy salon sans ownerId → isAdmin=true pour tout
    // visiteur" supprimé. Il faisait passer n'importe quel visiteur d'un vieux
    // salon pour admin (et ses lignes sans `by` s'affichaient toutes comme
    // OWNER côté front à cause d'une comparaison null===null). Les rares
    // salons sans ownerId sont désormais orphelins en lecture seule ; pour les
    // récupérer, leur créateur·rice doit utiliser le secret de récupération.
  }
  if (!isAdmin && SECRET_PATTERN.test(adminSecret) && data.recoveryHash) {
    const hash = await sha256Hex(adminSecret);
    if (hash === data.recoveryHash) isAdmin = true;
  }

  // Construit la réponse sans le hash interne
  const response = {
    c: data.c,
    d: data.d,
    p: Array.isArray(data.p) ? data.p : [],
    ownerId: data.ownerId || null,
    admins: Array.isArray(data.admins) ? data.admins : [],
    isAdmin
  };
  if (data.f !== undefined) response.f = data.f;
  if (data.w) response.w = data.w;
  if (data.bj && data.bj.length > 0) response.bj = data.bj.slice();
  // cl / lg / rs : sans eux, le client retombe sur les défauts (cl=2, rs=[])
  // et le prochain save admin réécrirait ces défauts en KV (perte silencieuse).
  if (data.cl !== undefined) response.cl = data.cl;
  if (data.lg !== undefined) response.lg = data.lg;
  if (Array.isArray(data.rs) && data.rs.length > 0) response.rs = data.rs.slice();

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store' // doit refléter l'état exact pour les permissions
    }
  });
}
