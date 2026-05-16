// POST /api/save
// Body: { id?, c, d, f, w?, bj?, p: [{ n, j: [...] }] }
//   - sans id : crée un nouveau salon, renvoie l'ID généré
//   - avec id valide : upsert (écrase l'entrée), renvoie le même ID
// Resp: { id }

const VALID_CONTENT = new Set(['dungeon', 'raid8', 'raid24']);
const VALID_DPS_MODE = new Set(['unified', 'split']);
const VALID_JOBS = new Set([
  'PLD','WAR','DRK','GNB',
  'WHM','AST','SCH','SGE',
  'MNK','DRG','NIN','SAM','RPR','VPR',
  'BRD','MCH','DNC',
  'BLM','SMN','RDM','PCT'
]);
const MAX_BODY_BYTES = 4096;
const MAX_PLAYERS = 24;
const MAX_NAME_LEN = 32;
const MAX_WHEN_LEN = 80;
const ID_LEN = 6;
const TTL_SECONDS = 31536000; // 1 year

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;

function generateId() {
  const bytes = new Uint8Array(ID_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < ID_LEN; i++) {
    out += BASE62[bytes[i] % 62];
  }
  return out;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      ...extraHeaders
    }
  });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'Invalid payload object';
  }
  if (typeof payload.c !== 'string' || !VALID_CONTENT.has(payload.c)) {
    return 'Invalid content type';
  }
  if (typeof payload.d !== 'string' || !VALID_DPS_MODE.has(payload.d)) {
    return 'Invalid DPS mode';
  }
  // f (fairnessWeight) est optionnel pour rétrocompat ; si présent doit être un entier 0..100
  if (payload.f !== undefined) {
    if (typeof payload.f !== 'number' || !Number.isFinite(payload.f) || payload.f < 0 || payload.f > 100) {
      return 'Invalid fairness weight';
    }
  }
  // w (raidWhen) optionnel
  if (payload.w !== undefined) {
    if (typeof payload.w !== 'string' || payload.w.length > MAX_WHEN_LEN) {
      return 'Invalid raidWhen';
    }
  }
  // bj (banned jobs) optionnel
  if (payload.bj !== undefined) {
    if (!Array.isArray(payload.bj) || payload.bj.length > VALID_JOBS.size) {
      return 'Invalid banned jobs array';
    }
    for (const id of payload.bj) {
      if (typeof id !== 'string' || !VALID_JOBS.has(id)) return 'Invalid banned job id';
    }
  }
  if (!Array.isArray(payload.p) || payload.p.length > MAX_PLAYERS) {
    return 'Invalid players array';
  }
  for (const raw of payload.p) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return 'Invalid player entry';
    }
    if (typeof raw.n !== 'string' || raw.n.length > MAX_NAME_LEN) {
      return 'Invalid player name';
    }
    if (!Array.isArray(raw.j) || raw.j.length > VALID_JOBS.size) {
      return 'Invalid preferences array';
    }
    for (const jobId of raw.j) {
      if (typeof jobId !== 'string' || !VALID_JOBS.has(jobId)) {
        return 'Invalid job id';
      }
    }
  }
  return null;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.PARTY_KV) {
    return jsonResponse({ error: 'KV binding PARTY_KV not configured' }, 500);
  }

  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'Payload too large' }, 413);
  }

  let bodyText;
  try {
    bodyText = await request.text();
  } catch {
    return jsonResponse({ error: 'Cannot read body' }, 400);
  }

  if (bodyText.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'Payload too large' }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const validationError = validatePayload(payload);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400);
  }

  // ID optionnel : upsert si fourni et valide ; sinon génère un nouveau
  let id;
  if (payload.id !== undefined) {
    if (typeof payload.id !== 'string' || !ID_PATTERN.test(payload.id)) {
      return jsonResponse({ error: 'Invalid id' }, 400);
    }
    id = payload.id;
  } else {
    id = generateId();
  }

  // Re-serialize from validated structure (drops any unknown keys, normalizes shape)
  const normalized = {
    c: payload.c,
    d: payload.d,
    p: payload.p.map(raw => ({ n: raw.n, j: raw.j.slice() }))
  };
  if (payload.f !== undefined) normalized.f = payload.f;
  if (payload.w !== undefined && payload.w !== '') normalized.w = payload.w;
  if (payload.bj !== undefined && payload.bj.length > 0) normalized.bj = payload.bj.slice();
  const stored = JSON.stringify(normalized);

  try {
    await env.PARTY_KV.put(id, stored, { expirationTtl: TTL_SECONDS });
  } catch (e) {
    return jsonResponse({ error: 'Storage failure' }, 500);
  }

  return jsonResponse({ id });
}
