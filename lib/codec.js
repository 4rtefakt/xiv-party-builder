// Encodage / décodage du roster pour l'URL longue (lien autoporté offline)
// et validation des payloads importés. Pur : ni `state` global, ni i18n.
// Les erreurs jetées portent des codes courts en majuscules — le caller
// (index.html) les traduit via son i18n.

import { JOBS, VALID_JOB_IDS, VALID_CONTENT_KEYS } from './jobs.js';

export const PRESENCE_VALUES = ['in', 'maybe', 'out'];

export const VALID_DPS_MODES = ['unified', 'split'];

// Factory utilisée par le front et les tests. Garde le même shape que celui
// d'index.html (la signature des champs est utilisée par l'algo de scoring).
export function makePlayer(name = '') {
  return {
    rowId: null,
    name,
    preferences: [],
    prefTiers: [],
    presence: 'in',
    lockedJob: null,
    claimedBy: null,
    note: ''
  };
}

// base64url (sans padding) — compatible URL.
export function encodeState(payload) {
  const json = JSON.stringify(payload);
  // btoa + escape : pattern Web standard pour gérer l'UTF-8 ; dispo aussi
  // en Node ≥18 via globals.
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Renvoie le payload brut JSON. Jette `Error('INVALID_CODE')` si décodage KO.
export function decodeState(code) {
  let b64 = String(code || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  try {
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  } catch (e) {
    throw new Error('INVALID_CODE');
  }
}

// Valide + normalise un payload importé (URL longue OU réponse serveur).
// Jette `Error(<CODE>)` pour les erreurs structurelles. Les valeurs
// inconnues (job IDs, presence, etc.) sont filtrées silencieusement.
//
// CODES :
//   INVALID_FORMAT     — pas un objet
//   UNKNOWN_CONTENT    — payload.c absent / inconnu
//   INVALID_DPS        — payload.d inattendu
//   INVALID_PLAYERS    — payload.p pas un tableau
export function validateImportedPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('INVALID_FORMAT');
  }
  if (!VALID_CONTENT_KEYS.has(payload.c)) throw new Error('UNKNOWN_CONTENT');
  if (!VALID_DPS_MODES.includes(payload.d)) throw new Error('INVALID_DPS');
  if (!Array.isArray(payload.p)) throw new Error('INVALID_PLAYERS');

  const players = payload.p.map(raw => {
    const player = makePlayer(typeof raw.n === 'string' ? raw.n : '');
    if (typeof raw.id === 'string' && raw.id.length <= 16) {
      player.rowId = raw.id;
    }
    if (Array.isArray(raw.j)) {
      player.preferences = raw.j.filter(id => VALID_JOB_IDS.has(id));
    }
    if (typeof raw.s === 'string' && PRESENCE_VALUES.includes(raw.s)) {
      player.presence = raw.s;
    }
    if (typeof raw.l === 'string' && VALID_JOB_IDS.has(raw.l)) {
      player.lockedJob = raw.l;
    }
    if (typeof raw.by === 'string' && raw.by.length >= 4 && raw.by.length <= 64) {
      player.claimedBy = raw.by;
    }
    if (typeof raw.nt === 'string') {
      player.note = raw.nt.slice(0, 200);
    }
    if (Array.isArray(raw.pt) && raw.pt.length === player.preferences.length) {
      const validTiers = raw.pt.every(t => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t < 50);
      if (validTiers) player.prefTiers = raw.pt.slice();
    }
    return player;
  });

  let fairnessWeight = 50;
  if (typeof payload.f === 'number' && payload.f >= 0 && payload.f <= 100) {
    fairnessWeight = payload.f;
  }

  const raidWhen = (typeof payload.w === 'string' ? payload.w : '').slice(0, 80);

  let bannedJobs = [];
  if (Array.isArray(payload.bj)) {
    bannedJobs = payload.bj.filter(id => typeof id === 'string' && VALID_JOB_IDS.has(id));
  }

  return {
    contentType: payload.c,
    dpsMode: payload.d,
    fairnessWeight,
    raidWhen,
    bannedJobs,
    players,
    ownerId: typeof payload.ownerId === 'string' ? payload.ownerId : null,
    admins: Array.isArray(payload.admins) ? payload.admins.slice() : [],
    isAdmin: !!payload.isAdmin
  };
}

// Réexport pratique pour les tests
export { VALID_JOB_IDS, VALID_CONTENT_KEYS };
// JOBS réexporté pour permettre `import { JOBS } from './codec.js'` côté tests
export { JOBS };
