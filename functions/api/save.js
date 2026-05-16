// POST /api/save
// Body: { id?, c, d, f, w?, bj?, p: [{ n, j, id (rowId), by?, s?, l? }], admins? }
//   - sans id : crée un nouveau salon, le user devient owner+admin
//   - avec id valide : upsert avec règles de permission
// Headers:
//   X-User-Id: identité du navigateur (UUID localStorage côté client)
//   X-Admin-Secret: secret de récupération admin (optionnel, depuis URL fragment)
// Resp: { id, isAdmin, ownerId, admins, recoverySecret? (sur création uniquement) }

const VALID_CONTENT = new Set(['dungeon', 'raid8', 'raid24']);
const VALID_DPS_MODE = new Set(['unified', 'split']);
const VALID_JOBS = new Set([
  'PLD','WAR','DRK','GNB',
  'WHM','AST','SCH','SGE',
  'MNK','DRG','NIN','SAM','RPR','VPR',
  'BRD','MCH','DNC',
  'BLM','SMN','RDM','PCT'
]);
const VALID_PRESENCE = new Set(['in', 'maybe', 'out']);
const MAX_BODY_BYTES = 8192; // élargi pour inclure les nouveaux champs (rowId, claimedBy, admins…)
const MAX_PLAYERS = 24;
const MAX_NAME_LEN = 32;
const MAX_NOTE_LEN = 200;
const MAX_WHEN_LEN = 80;
const MAX_ADMINS = 24;
const ID_LEN = 6;
const TTL_SECONDS = 31536000; // 1 year

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_PATTERN = /^[A-Za-z0-9]{4,12}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const ROW_ID_PATTERN = /^[A-Za-z0-9_-]{4,16}$/;
const SECRET_PATTERN = /^[A-Fa-f0-9]{32,128}$/;

// Rate-limit : max N saves/heure par userId. KV est eventually-consistent donc
// best-effort (deux saves quasi-simultanés peuvent passer ensemble), mais
// suffit pour bloquer un client qui boucle.
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

async function checkRateLimit(env, userId) {
  const key = 'rl:' + userId;
  const current = parseInt(await env.PARTY_KV.get(key) || '0', 10);
  if (current >= RATE_LIMIT_MAX) return { allowed: false, current };
  // expirationTtl s'applique à la NOUVELLE entrée ; chaque save prolonge la
  // fenêtre. Pour une vraie fenêtre glissante il faudrait une approche
  // différente, mais c'est OK pour notre usage.
  await env.PARTY_KV.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return { allowed: true, current: current + 1 };
}

function generateId() {
  const bytes = new Uint8Array(ID_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < ID_LEN; i++) out += BASE62[bytes[i] % 62];
  return out;
}

function generateRowId() {
  const bytes = new Uint8Array(7);
  crypto.getRandomValues(bytes);
  let out = 'r';
  for (let i = 0; i < 7; i++) out += BASE62[bytes[i] % 62];
  return out;
}

function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Admin-Secret',
      ...extraHeaders
    }
  });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Invalid payload object';
  if (typeof payload.c !== 'string' || !VALID_CONTENT.has(payload.c)) return 'Invalid content type';
  if (typeof payload.d !== 'string' || !VALID_DPS_MODE.has(payload.d)) return 'Invalid DPS mode';
  if (payload.f !== undefined) {
    if (typeof payload.f !== 'number' || !Number.isFinite(payload.f) || payload.f < 0 || payload.f > 100) return 'Invalid fairness weight';
  }
  if (payload.w !== undefined) {
    if (typeof payload.w !== 'string' || payload.w.length > MAX_WHEN_LEN) return 'Invalid raidWhen';
  }
  if (payload.bj !== undefined) {
    if (!Array.isArray(payload.bj) || payload.bj.length > VALID_JOBS.size) return 'Invalid banned jobs array';
    for (const id of payload.bj) {
      if (typeof id !== 'string' || !VALID_JOBS.has(id)) return 'Invalid banned job id';
    }
  }
  if (!Array.isArray(payload.p) || payload.p.length > MAX_PLAYERS) return 'Invalid players array';
  for (const raw of payload.p) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Invalid player entry';
    if (typeof raw.n !== 'string' || raw.n.length > MAX_NAME_LEN) return 'Invalid player name';
    if (!Array.isArray(raw.j) || raw.j.length > VALID_JOBS.size) return 'Invalid preferences array';
    for (const jobId of raw.j) {
      if (typeof jobId !== 'string' || !VALID_JOBS.has(jobId)) return 'Invalid job id';
    }
    if (raw.s !== undefined && (typeof raw.s !== 'string' || !VALID_PRESENCE.has(raw.s))) return 'Invalid presence';
    if (raw.l !== undefined && (typeof raw.l !== 'string' || !VALID_JOBS.has(raw.l))) return 'Invalid locked job';
    if (raw.id !== undefined && (typeof raw.id !== 'string' || !ROW_ID_PATTERN.test(raw.id))) return 'Invalid row id';
    if (raw.by !== undefined && raw.by !== null && (typeof raw.by !== 'string' || !USER_ID_PATTERN.test(raw.by))) return 'Invalid claimedBy';
    if (raw.nt !== undefined && (typeof raw.nt !== 'string' || raw.nt.length > MAX_NOTE_LEN)) return 'Invalid note';
    if (raw.pt !== undefined) {
      if (!Array.isArray(raw.pt) || raw.pt.length !== raw.j.length) return 'Invalid pref tiers length';
      for (const tval of raw.pt) {
        if (typeof tval !== 'number' || !Number.isFinite(tval) || tval < 0 || tval > 50) return 'Invalid tier value';
      }
    }
  }
  if (payload.admins !== undefined) {
    if (!Array.isArray(payload.admins) || payload.admins.length > MAX_ADMINS) return 'Invalid admins array';
    for (const a of payload.admins) {
      if (typeof a !== 'string' || !USER_ID_PATTERN.test(a)) return 'Invalid admin user id';
    }
  }
  return null;
}

// Construit l'objet player tel qu'il sera stocké
function normalizePlayer(raw, existingRowId) {
  const obj = { n: raw.n, j: raw.j.slice() };
  if (raw.s !== undefined && raw.s !== 'in') obj.s = raw.s;
  if (raw.l !== undefined) obj.l = raw.l;
  if (raw.by !== undefined && raw.by !== null && raw.by !== '') obj.by = raw.by;
  if (raw.nt !== undefined && raw.nt !== '') obj.nt = raw.nt.slice(0, MAX_NOTE_LEN);
  if (raw.pt !== undefined && Array.isArray(raw.pt) && raw.pt.length === (raw.j ? raw.j.length : 0)) {
    obj.pt = raw.pt.slice();
  }
  obj.id = (raw.id && ROW_ID_PATTERN.test(raw.id)) ? raw.id : (existingRowId || generateRowId());
  return obj;
}

// Pour un admin : full overwrite (avec garde-fou pour ownerId et admins)
function normalizeForAdminUpdate(payload, existing) {
  const ownerId = existing.ownerId;
  // Liste admins : on garde l'incoming si fourni, sinon l'existant ; toujours forcer ownerId dedans
  let admins = Array.isArray(payload.admins) ? payload.admins.slice() : (Array.isArray(existing.admins) ? existing.admins.slice() : []);
  // dédupliquer + forcer owner
  admins = [...new Set(admins.filter(a => typeof a === 'string' && USER_ID_PATTERN.test(a)))];
  if (ownerId && !admins.includes(ownerId)) admins.unshift(ownerId);
  admins = admins.slice(0, MAX_ADMINS);

  const stored = {
    c: payload.c,
    d: payload.d,
    p: payload.p.map(raw => normalizePlayer(raw)),
    ownerId,
    admins,
    recoveryHash: existing.recoveryHash
  };
  if (payload.f !== undefined) stored.f = payload.f;
  if (payload.w !== undefined && payload.w !== '') stored.w = payload.w;
  if (payload.bj !== undefined && payload.bj.length > 0) stored.bj = payload.bj.slice();
  return stored;
}

// Pour un non-admin : merge per-row par rowId
function normalizeForNonAdminMerge(payload, existing, userId) {
  // Tout le top-level (c, d, f, w, bj) : on garde l'existant
  const stored = {
    c: existing.c,
    d: existing.d,
    ownerId: existing.ownerId,
    admins: Array.isArray(existing.admins) ? existing.admins.slice() : [],
    recoveryHash: existing.recoveryHash
  };
  if (existing.f !== undefined) stored.f = existing.f;
  if (existing.w) stored.w = existing.w;
  if (existing.bj && existing.bj.length > 0) stored.bj = existing.bj.slice();

  // Players : on conserve l'ordre et le nombre existants. Pour chaque row, on
  // applique les modifs incoming SI permises.
  const existingPlayers = Array.isArray(existing.p) ? existing.p : [];
  const incomingByRowId = new Map();
  for (const ip of (Array.isArray(payload.p) ? payload.p : [])) {
    if (typeof ip.id === 'string') incomingByRowId.set(ip.id, ip);
  }
  stored.p = existingPlayers.map(ep => {
    const ip = incomingByRowId.get(ep.id);
    if (!ip) return ep;
    const epBy = ep.by;
    if (epBy === userId) {
      // Sa ligne : peut tout changer, sauf le rowId et le claimedBy (ne peut pas transférer)
      // (un re-claim avec autre userId est ignoré ; clearer son claim = ok)
      const stillOwned = (typeof ip.by === 'string' && ip.by === userId);
      return normalizePlayer({ ...ip, by: stillOwned ? userId : null }, ep.id);
    }
    if (!epBy) {
      // Ligne libre : peut être claim si l'incoming demande claim
      if (typeof ip.by === 'string' && ip.by === userId) {
        return normalizePlayer({ ...ip, by: userId }, ep.id);
      }
      return ep;
    }
    // Ligne claimée par quelqu'un d'autre : on garde
    return ep;
  });
  return stored;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Admin-Secret',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.PARTY_KV) return jsonResponse({ error: 'KV binding PARTY_KV not configured' }, 500);

  const userId = (request.headers.get('x-user-id') || '').trim();
  if (!USER_ID_PATTERN.test(userId)) return jsonResponse({ error: 'Invalid or missing X-User-Id' }, 400);

  // Rate-limit : bloque les clients qui spamment (max N saves/heure/userId)
  const rl = await checkRateLimit(env, userId);
  if (!rl.allowed) {
    return jsonResponse({ error: 'Trop de sauvegardes — réessaie dans 1h' }, 429);
  }

  const adminSecret = (request.headers.get('x-admin-secret') || '').trim();
  const adminSecretValid = SECRET_PATTERN.test(adminSecret);

  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_BYTES) return jsonResponse({ error: 'Payload too large' }, 413);

  let bodyText;
  try { bodyText = await request.text(); }
  catch { return jsonResponse({ error: 'Cannot read body' }, 400); }
  if (bodyText.length > MAX_BODY_BYTES) return jsonResponse({ error: 'Payload too large' }, 413);

  let payload;
  try { payload = JSON.parse(bodyText); }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const validationError = validatePayload(payload);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  // Détermine l'ID cible et tente de lire l'existant
  let id, existing = null;
  if (payload.id !== undefined) {
    if (typeof payload.id !== 'string' || !ID_PATTERN.test(payload.id)) {
      return jsonResponse({ error: 'Invalid id' }, 400);
    }
    id = payload.id;
    const raw = await env.PARTY_KV.get(id);
    if (raw) {
      try { existing = JSON.parse(raw); } catch { /* corrompu → on traite comme nouveau */ }
    }
  } else {
    id = generateId();
  }

  let stored, response;

  if (!existing) {
    // Création : ce user devient owner + admin, génère un secret de récupération
    const recoverySecret = generateSecret();
    const recoveryHash = await sha256Hex(recoverySecret);
    stored = {
      c: payload.c,
      d: payload.d,
      p: payload.p.map(raw => normalizePlayer(raw)),
      ownerId: userId,
      admins: [userId],
      recoveryHash
    };
    if (payload.f !== undefined) stored.f = payload.f;
    if (payload.w !== undefined && payload.w !== '') stored.w = payload.w;
    if (payload.bj !== undefined && payload.bj.length > 0) stored.bj = payload.bj.slice();
    response = {
      id, isAdmin: true, ownerId: userId, admins: [userId],
      recoverySecret // renvoyé UNE seule fois, sur la création
    };
  } else {
    // Backward-compat : salon legacy sans ownerId → premier saver prend l'ownership
    let isLegacyUpgrade = false;
    if (!existing.ownerId) {
      isLegacyUpgrade = true;
      existing.ownerId = userId;
      existing.admins = [userId];
      // Pas de recoveryHash pour les anciens salons : on en génère un et on le renvoie
      // au saver pour qu'iel puisse le sauver
    }

    let isAdmin = Array.isArray(existing.admins) && existing.admins.includes(userId);

    // Récupération via secret : si le secret matche, on promeut ce userId admin
    let promotedViaSecret = false;
    if (!isAdmin && adminSecretValid && existing.recoveryHash) {
      const hash = await sha256Hex(adminSecret);
      if (hash === existing.recoveryHash) {
        isAdmin = true;
        promotedViaSecret = true;
        if (!Array.isArray(existing.admins)) existing.admins = [];
        if (!existing.admins.includes(userId)) existing.admins.push(userId);
      }
    }

    let recoveryToReturn;
    if (isLegacyUpgrade) {
      // Génère un secret pour ce salon nouvellement claimé
      const sec = generateSecret();
      existing.recoveryHash = await sha256Hex(sec);
      recoveryToReturn = sec;
    }

    if (isAdmin) {
      stored = normalizeForAdminUpdate(payload, existing);
    } else {
      stored = normalizeForNonAdminMerge(payload, existing, userId);
    }

    response = {
      id,
      isAdmin,
      ownerId: stored.ownerId,
      admins: stored.admins,
      promotedViaSecret: promotedViaSecret || undefined,
      recoverySecret: recoveryToReturn // uniquement si legacy upgrade
    };
  }

  try {
    await env.PARTY_KV.put(id, JSON.stringify(stored), { expirationTtl: TTL_SECONDS });
  } catch (e) {
    return jsonResponse({ error: 'Storage failure' }, 500);
  }

  return jsonResponse(response);
}
