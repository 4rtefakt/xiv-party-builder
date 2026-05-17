// POST /api/save
// Body: { id?, c, d, f, w?, bj?, p: [{ n, j, id (rowId), by?, s?, l? }], admins? }
//   - sans id : crée un nouveau salon, le user devient owner+admin
//   - avec id valide : upsert avec règles de permission
// Headers:
//   X-User-Id: identité du navigateur (UUID localStorage côté client)
//   X-Admin-Secret: secret de récupération admin (optionnel, depuis URL fragment)
// Resp: { id, isAdmin, ownerId, admins, recoverySecret? (sur création uniquement) }

const VALID_CONTENT = new Set(['dungeon', 'raid8', 'raid24', 'raid24chaotic']);
// Claim limit : nb max de lignes qu'un·e non-admin peut réserver. 0 = illimité.
// Dupliqué de lib/codec.js (pattern existant : save.js a sa propre liste de
// jobs valides aussi, pour éviter un import inter-projet en runtime worker).
const VALID_CLAIM_LIMITS = new Set([0, 1, 2, 3, 4]);
const DEFAULT_CLAIM_LIMIT = 2;
const VALID_DPS_MODE = new Set(['unified', 'split']);
const VALID_JOBS = new Set([
  'PLD','WAR','DRK','GNB',
  'WHM','AST','SCH','SGE',
  'MNK','DRG','NIN','SAM','RPR','VPR',
  'BRD','MCH','DNC',
  'BLM','SMN','RDM','PCT'
]);
const VALID_PRESENCE = new Set(['in', 'maybe', 'out']);
// Dispos : mêmes valeurs que lib/codec.js (dupliquées pour éviter un import
// inter-projet en runtime worker, pattern existant)
const VALID_AVAIL_HOURS = new Set([8, 10, 14, 16, 18, 19, 20, 21, 22, 23]);
const VALID_AVAIL_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const MAX_BODY_BYTES = 32768; // 32ko : couvre 32 joueurs avec prefs + dispos + notes
// 32 = taille raid24 (24) + ~8 absent·es de réserve. Couvre le cas réel des
// raid statiques qui notent les dispos de + de monde que la taille effective.
const MAX_PLAYERS = 32;
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

// Rate-limit : max N saves/heure par userId, en fenêtre glissante.
//
// Algorithme "sliding window counter" : deux buckets contigus de WINDOW
// secondes. Le bucket actuel et le précédent. À l'instant t, l'estimation
// du nombre de saves dans la dernière WINDOW seconde est :
//   estimated = prev * (1 - elapsed/WINDOW) + current
// où `elapsed` est le temps écoulé depuis le début du bucket courant.
// Cela évite les "edge bursts" de la version naïve (où on pouvait faire
// MAX saves à t=59:59 puis MAX à t=60:00, soit 2×MAX en 1s).
//
// KV n'a pas d'increment atomique → race possible entre deux saves
// simultanés du même userId (best-effort, comme la version précédente).
export const RATE_LIMIT_MAX = 100;
export const RATE_LIMIT_WINDOW_SECONDS = 3600;

export async function checkRateLimit(env, userId) {
  const now = Math.floor(Date.now() / 1000);
  const W = RATE_LIMIT_WINDOW_SECONDS;
  const bucket = Math.floor(now / W);
  const elapsed = now - bucket * W;          // 0..W-1
  const weightPrev = 1 - elapsed / W;        // poids du bucket précédent

  const curKey = `rl:${userId}:${bucket}`;
  const prevKey = `rl:${userId}:${bucket - 1}`;

  const [curRaw, prevRaw] = await Promise.all([
    env.PARTY_KV.get(curKey),
    env.PARTY_KV.get(prevKey)
  ]);
  const cur = parseInt(curRaw || '0', 10);
  const prev = parseInt(prevRaw || '0', 10);

  const estimated = prev * weightPrev + cur;
  if (estimated >= RATE_LIMIT_MAX) {
    return { allowed: false, estimated };
  }

  // TTL = 2×W pour que le bucket reste lisible comme "précédent" pendant
  // la fenêtre suivante. Au-delà, il s'auto-expire (pas de cleanup à faire).
  await env.PARTY_KV.put(curKey, String(cur + 1), { expirationTtl: 2 * W });
  return { allowed: true, estimated: estimated + 1 };
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

export function validatePayload(payload) {
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
  if (payload.cl !== undefined) {
    if (typeof payload.cl !== 'number' || !VALID_CLAIM_LIMITS.has(payload.cl)) return 'Invalid claim limit';
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
    if (raw.av !== undefined) {
      if (!raw.av || typeof raw.av !== 'object' || Array.isArray(raw.av)) return 'Invalid availability';
      // Pour chaque jour fourni : doit être une liste d'heures valides (≤ 10)
      for (const day of Object.keys(raw.av)) {
        if (!VALID_AVAIL_DAYS.has(day)) return 'Invalid availability day';
        const hours = raw.av[day];
        if (!Array.isArray(hours) || hours.length > VALID_AVAIL_HOURS.size) return 'Invalid availability hours';
        for (const h of hours) {
          if (typeof h !== 'number' || !VALID_AVAIL_HOURS.has(h)) return 'Invalid availability hour';
        }
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

// Déduplique les préférences en préservant l'ordre (1ʳᵉ occurrence gagne) et
// en synchronisant les tiers `pt` associés. L'algo de scoring lit indexOf(j),
// donc l'ordre est sémantiquement signifiant (rang de préférence).
export function dedupPrefs(jobs, tiers) {
  const seen = new Set();
  const outJ = [];
  const outT = (Array.isArray(tiers) && tiers.length === jobs.length) ? [] : null;
  for (let i = 0; i < jobs.length; i++) {
    const id = jobs[i];
    if (seen.has(id)) continue;
    seen.add(id);
    outJ.push(id);
    if (outT) outT.push(tiers[i]);
  }
  return { jobs: outJ, tiers: outT };
}

// Construit l'objet player tel qu'il sera stocké
export function normalizePlayer(raw, existingRowId) {
  // Dedup les prefs + tiers de façon synchro avant de stocker, sinon un
  // client buggé / malicieux peut envoyer `j: ['PLD','PLD',...]` qui ne
  // casse rien fonctionnellement mais pollue le stockage et fausse les
  // longueurs perçues côté front.
  const { jobs: dedJ, tiers: dedT } = dedupPrefs(raw.j, raw.pt);
  const obj = { n: raw.n, j: dedJ };
  if (raw.s !== undefined && raw.s !== 'in') obj.s = raw.s;
  if (raw.l !== undefined) obj.l = raw.l;
  if (raw.by !== undefined && raw.by !== null && raw.by !== '') obj.by = raw.by;
  if (raw.nt !== undefined && raw.nt !== '') obj.nt = raw.nt.slice(0, MAX_NOTE_LEN);
  if (dedT !== null) obj.pt = dedT;
  // Dispos : on filtre + dédup + tri à la volée. Si rien ne reste après
  // filtrage, on omet le champ (économise les bytes).
  if (raw.av && typeof raw.av === 'object' && !Array.isArray(raw.av)) {
    const cleanAv = {};
    for (const day of Object.keys(raw.av)) {
      if (!VALID_AVAIL_DAYS.has(day)) continue;
      const hours = Array.isArray(raw.av[day]) ? raw.av[day] : [];
      const seen = new Set();
      const valid = [];
      for (const h of hours) {
        if (typeof h !== 'number' || !VALID_AVAIL_HOURS.has(h) || seen.has(h)) continue;
        seen.add(h);
        valid.push(h);
      }
      if (valid.length > 0) {
        valid.sort((a, b) => a - b);
        cleanAv[day] = valid;
      }
    }
    if (Object.keys(cleanAv).length > 0) obj.av = cleanAv;
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
  if (payload.bj !== undefined && payload.bj.length > 0) stored.bj = [...new Set(payload.bj)];
  if (payload.cl !== undefined) stored.cl = payload.cl;
  return stored;
}

// Pour un non-admin : merge per-row par rowId
export function normalizeForNonAdminMerge(payload, existing, userId) {
  // Tout le top-level (c, d, f, w, bj, cl) : on garde l'existant
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
  if (existing.cl !== undefined) stored.cl = existing.cl;

  // Limite de claims : on lit depuis existing (les non-admins ne peuvent pas
  // la modifier). 0 = illimité, undefined → défaut (2).
  const claimLimit = existing.cl !== undefined ? existing.cl : DEFAULT_CLAIM_LIMIT;
  // On compte les claims du userId DÉJÀ présents dans existing pour
  // initialiser le compteur — on n'augmente que si un nouveau claim est
  // accepté pendant ce merge.
  const existingPlayers = Array.isArray(existing.p) ? existing.p : [];
  let userClaims = existingPlayers.filter(p => p.by === userId).length;
  const limitReached = () => claimLimit !== 0 && userClaims >= claimLimit;

  // Players : on conserve l'ordre et le nombre existants. Pour chaque row, on
  // applique les modifs incoming SI permises.
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
      if (!stillOwned) userClaims--;  // libération
      return normalizePlayer({ ...ip, by: stillOwned ? userId : null }, ep.id);
    }
    if (!epBy) {
      // Ligne libre : peut être claim si l'incoming demande claim ET si la
      // limite n'est pas atteinte. Sinon, on ignore silencieusement le claim
      // (la ligne reste libre côté serveur, le front re-synchro au save+1).
      if (typeof ip.by === 'string' && ip.by === userId && !limitReached()) {
        userClaims++;
        return normalizePlayer({ ...ip, by: userId }, ep.id);
      }
      return ep;
    }
    // Ligne claimée par quelqu'un d'autre : on garde
    return ep;
  });

  // Ajout de nouvelles lignes par un non-admin : autorisé si claim par
  // ce userId ET sous la limite ET on reste sous MAX_PLAYERS global.
  // Permet aux participant·es de s'ajouter dans un salon en cours (utile
  // pour les statics qui notent +/- de monde que la taille du contenu).
  const existingIds = new Set(existingPlayers.map(ep => ep.id));
  for (const ip of (Array.isArray(payload.p) ? payload.p : [])) {
    if (typeof ip.id !== 'string') continue;
    if (existingIds.has(ip.id)) continue;       // déjà traitée dans le map
    if (typeof ip.by !== 'string' || ip.by !== userId) continue; // doit être self-claim
    if (limitReached()) continue;
    if (stored.p.length >= MAX_PLAYERS) break;  // garde-fou global
    stored.p.push(normalizePlayer({ ...ip, by: userId }, ip.id));
    userClaims++;
  }

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
    if (payload.bj !== undefined && payload.bj.length > 0) stored.bj = [...new Set(payload.bj)];
    if (payload.cl !== undefined) stored.cl = payload.cl;
    response = {
      id, isAdmin: true, ownerId: userId, admins: [userId],
      recoverySecret // renvoyé UNE seule fois, sur la création
    };
  } else {
    // Note : ancien path "legacy salon sans ownerId → premier saver prend
    // l'ownership" supprimé pour fermer un trou de sécu (n'importe quel
    // visiteur d'un vieux salon devenait owner via un auto-claim). Les
    // rares salons sans ownerId sont désormais figés en read-only ; seul
    // le secret de récupération (s'il existe) permet de regagner l'admin.
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
      promotedViaSecret: promotedViaSecret || undefined
    };
  }

  try {
    await env.PARTY_KV.put(id, JSON.stringify(stored), { expirationTtl: TTL_SECONDS });
  } catch (e) {
    return jsonResponse({ error: 'Storage failure' }, 500);
  }

  return jsonResponse(response);
}
