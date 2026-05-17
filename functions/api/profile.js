// GET  /api/profile  → renvoie le profil cloud du X-User-Id (vide si absent)
// PUT  /api/profile  → écrase le profil cloud du X-User-Id
//
// Profil = preferences + templates + recent rooms (le webhook Discord reste
// volontairement local côté client : trop critique pour transiter en cloud).
// Stocké sous la clé KV `prof:<userId>` avec TTL 1 an, renouvelé à chaque PUT.
//
// Sécurité : la clé KV est strictement dérivée du `X-User-Id` header. Pas de
// path/param qui permettrait de lire le profil d'un autre user. Le userId
// est lui-même un "secret" client (UUID localStorage), donc connaître un
// userId = être ce user (modèle de sécurité identique à save.js).

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const ROOM_ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;
const VALID_JOBS = new Set([
  'PLD','WAR','DRK','GNB',
  'WHM','AST','SCH','SGE',
  'MNK','DRG','NIN','SAM','RPR','VPR',
  'BRD','MCH','DNC',
  'BLM','SMN','RDM','PCT'
]);
const VALID_CONTENT = new Set(['dungeon', 'raid8', 'raid24', 'raid24chaotic']);
// Dispos : mêmes valeurs que lib/codec.js (dupliquées pour éviter un import
// inter-projet en runtime worker).
const VALID_AVAIL_HOURS = new Set([8, 10, 14, 16, 18, 19, 20, 21, 22, 23]);
const VALID_AVAIL_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const TTL_SECONDS = 31536000; // 1 an
const MAX_BODY_BYTES = 8192;

const MAX_PRESETS = 5;
const MAX_PRESET_NAME_LEN = 30;
const MAX_TEMPLATES = 10;
const MAX_TEMPLATE_NAME_LEN = 40;
const MAX_RECENTS = 5;
const MAX_WHEN_LEN = 80;

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-User-Id',
      ...extra
    }
  });
}

function getUserId(request) {
  const id = (request.headers.get('x-user-id') || '').trim();
  return USER_ID_PATTERN.test(id) ? id : null;
}

// ---------- Validation du payload PUT ----------

// Normalise un preset, retourne null si invalide.
export function normalizePreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null;
  if (!Array.isArray(raw.jobs)) return null;
  const jobs = [];
  const seen = new Set();
  for (const j of raw.jobs) {
    if (typeof j !== 'string' || !VALID_JOBS.has(j) || seen.has(j)) continue;
    seen.add(j);
    jobs.push(j);
    if (jobs.length >= VALID_JOBS.size) break;
  }
  return { name: raw.name.slice(0, MAX_PRESET_NAME_LEN), jobs };
}

// Normalise un template.
export function normalizeTemplate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null;
  if (typeof raw.contentType !== 'string' || !VALID_CONTENT.has(raw.contentType)) return null;
  const out = {
    name: raw.name.slice(0, MAX_TEMPLATE_NAME_LEN),
    contentType: raw.contentType
  };
  if (Array.isArray(raw.bannedJobs)) {
    const seen = new Set();
    const banned = [];
    for (const j of raw.bannedJobs) {
      if (typeof j !== 'string' || !VALID_JOBS.has(j) || seen.has(j)) continue;
      seen.add(j);
      banned.push(j);
    }
    out.bannedJobs = banned;
  }
  if (typeof raw.fairnessWeight === 'number' && raw.fairnessWeight >= 0 && raw.fairnessWeight <= 100) {
    out.fairnessWeight = raw.fairnessWeight;
  }
  if (typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt)) {
    out.savedAt = raw.savedAt;
  }
  return out;
}

// Normalise un recent room.
export function normalizeRecent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !ROOM_ID_PATTERN.test(raw.id)) return null;
  const out = { id: raw.id };
  if (typeof raw.when === 'string') out.when = raw.when.slice(0, MAX_WHEN_LEN);
  if (typeof raw.contentType === 'string' && VALID_CONTENT.has(raw.contentType)) {
    out.contentType = raw.contentType;
  }
  if (typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt)) {
    out.savedAt = raw.savedAt;
  }
  return out;
}

// Normalise un objet defaultAvailability { mon: [20, 21], sat: [...] }.
// Filtre jours/heures inconnus, dédup + tri stable. Renvoie null si rien
// de valide (champ sera omis du stockage).
export function normalizeDefaultAvailability(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const day of Object.keys(raw)) {
    if (!VALID_AVAIL_DAYS.has(day)) continue;
    const hours = raw[day];
    if (!Array.isArray(hours)) continue;
    const seen = new Set();
    const valid = [];
    for (const h of hours) {
      if (typeof h !== 'number' || !VALID_AVAIL_HOURS.has(h) || seen.has(h)) continue;
      seen.add(h);
      valid.push(h);
    }
    if (valid.length === 0) continue;
    valid.sort((a, b) => a - b);
    out[day] = valid;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Valide le payload entier, renvoie l'objet à stocker ou { error: string }.
export function validateProfile(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'Invalid profile object' };
  }
  const out = { v: 1 };

  if (payload.presets !== undefined) {
    if (!Array.isArray(payload.presets)) return { error: 'Invalid presets array' };
    out.presets = payload.presets
      .map(normalizePreset)
      .filter(p => p !== null)
      .slice(0, MAX_PRESETS);
  }

  if (payload.templates !== undefined) {
    if (!Array.isArray(payload.templates)) return { error: 'Invalid templates array' };
    out.templates = payload.templates
      .map(normalizeTemplate)
      .filter(t => t !== null)
      .slice(0, MAX_TEMPLATES);
  }

  if (payload.recents !== undefined) {
    if (!Array.isArray(payload.recents)) return { error: 'Invalid recents array' };
    out.recents = payload.recents
      .map(normalizeRecent)
      .filter(r => r !== null)
      .slice(0, MAX_RECENTS);
  }

  if (payload.defaultAvailability !== undefined) {
    if (payload.defaultAvailability === null) {
      // Permet d'effacer en POST avec null explicite (vs absence du champ)
      out.defaultAvailability = null;
    } else {
      const cleaned = normalizeDefaultAvailability(payload.defaultAvailability);
      if (cleaned) out.defaultAvailability = cleaned;
    }
  }

  out.updatedAt = Date.now();
  return { stored: out };
}

// ---------- Handlers ----------

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-User-Id',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.PARTY_KV) return jsonResponse({ error: 'KV missing' }, 500);
  const userId = getUserId(request);
  if (!userId) return jsonResponse({ error: 'Invalid or missing X-User-Id' }, 400);

  const raw = await env.PARTY_KV.get('prof:' + userId);
  if (!raw) return jsonResponse({ v: 1, presets: [], templates: [], recents: [] });
  try {
    return jsonResponse(JSON.parse(raw));
  } catch {
    // Profil corrompu → on traite comme vide (le client repartira à zéro
    // et le prochain PUT remplacera la valeur).
    return jsonResponse({ v: 1, presets: [], templates: [], recents: [] });
  }
}

export async function onRequestPut({ request, env }) {
  if (!env.PARTY_KV) return jsonResponse({ error: 'KV missing' }, 500);
  const userId = getUserId(request);
  if (!userId) return jsonResponse({ error: 'Invalid or missing X-User-Id' }, 400);

  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_BYTES) return jsonResponse({ error: 'Payload too large' }, 413);

  let body;
  try { body = await request.text(); }
  catch { return jsonResponse({ error: 'Cannot read body' }, 400); }
  if (body.length > MAX_BODY_BYTES) return jsonResponse({ error: 'Payload too large' }, 413);

  let payload;
  try { payload = JSON.parse(body); }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const v = validateProfile(payload);
  if (v.error) return jsonResponse({ error: v.error }, 400);

  try {
    await env.PARTY_KV.put('prof:' + userId, JSON.stringify(v.stored), { expirationTtl: TTL_SECONDS });
  } catch {
    return jsonResponse({ error: 'Storage failure' }, 500);
  }
  return jsonResponse({ ok: true, updatedAt: v.stored.updatedAt });
}
