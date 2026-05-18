// Encodage / décodage du roster pour l'URL longue (lien autoporté offline)
// et validation des payloads importés. Pur : ni `state` global, ni i18n.
// Les erreurs jetées portent des codes courts en majuscules — le caller
// (index.html) les traduit via son i18n.

import { JOBS, VALID_JOB_IDS, VALID_CONTENT_KEYS } from './jobs.js';

export const PRESENCE_VALUES = ['in', 'maybe', 'out'];

export const VALID_DPS_MODES = ['unified', 'split'];

// Langue d'affichage stockée par salon : c'est la langue de l'admin au moment
// de la création. Utilisée pour les meta OG et l'image OG (preview Discord)
// indépendamment de la langue du scrapeur Discord/Twitter.
export const VALID_LANGS = new Set(['fr', 'en']);
export const DEFAULT_LANG = 'en';

// Nombre max de lignes qu'un·e non-admin peut réserver dans un salon.
// 2 par défaut : couvre le cas légitime "moi + un proche" (frère/sœur,
// conjoint) sans permettre à une personne de bloquer tout un raid.
// L'owner peut bouger ce nombre :
//   1 = strict (raids tryhard, statique sérieux, BiS race…)
//   2 = défaut (frère/sœur, couple)
//   3 / 4 = groupes pratiques avec familles élargies
//   0 = illimité (compos test, brouillon)
export const DEFAULT_CLAIM_LIMIT = 2;
export const CLAIM_LIMIT_UNLIMITED = 0;
export const VALID_CLAIM_LIMITS = new Set([0, 1, 2, 3, 4]);

// Disponibilités par joueur·euse : grille jour × heure-de-début.
// Liste curée d'heures de début typiques en raid FFXIV (centré FR/EU,
// matin couvert pour les groupes "petit-déj raid") :
//   - 8h, 10h  → groupes du matin (rares mais existent)
//   - 14h, 16h → week-end aprèm
//   - 18h, 19h → "on commence tôt après le taf"
//   - 20h, 21h → prime time semaine
//   - 22h, 23h → late / nuit
// On skip volontairement 11h, 12h, 13h, 15h, 17h, 0h+ : quasi-jamais
// des starts FFXIV en pratique. Si demande terrain, on étendra.
export const VALID_AVAIL_HOURS = [8, 10, 14, 16, 18, 19, 20, 21, 22, 23];
export const VALID_AVAIL_HOURS_SET = new Set(VALID_AVAIL_HOURS);
export const VALID_AVAIL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const VALID_AVAIL_DAYS_SET = new Set(VALID_AVAIL_DAYS);

// Normalise un objet avail brut → { mon: [20, 21], sat: [...] } trié.
// Filtre : jours inconnus ignorés, heures hors liste ignorées, doublons
// déduits, ordre stable (croissant) pour roundtrip propre.
// Renvoie null si rien de valide.
export function normalizeAvail(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const day of VALID_AVAIL_DAYS) {
    const hours = raw[day];
    if (!Array.isArray(hours)) continue;
    const seen = new Set();
    const valid = [];
    for (const h of hours) {
      if (typeof h !== 'number' || !VALID_AVAIL_HOURS_SET.has(h) || seen.has(h)) continue;
      seen.add(h);
      valid.push(h);
    }
    if (valid.length === 0) continue;
    valid.sort((a, b) => a - b);
    out[day] = valid;
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
    note: '',
    availability: null   // { mon: [20, 21], sat: [...] } ou null = pas de signal
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
    if (raw.av !== undefined) {
      player.availability = normalizeAvail(raw.av);
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

  // Claim limit : absent ou invalide → on retombe sur le défaut. 0 = illimité.
  let claimLimit = DEFAULT_CLAIM_LIMIT;
  if (typeof payload.cl === 'number' && VALID_CLAIM_LIMITS.has(payload.cl)) {
    claimLimit = payload.cl;
  }

  // Langue d'affichage du salon (pour les meta OG / image OG). Absente sur
  // les anciens salons → null, le middleware/og worker fallback sur le
  // pickLang(Accept-Language) du scrapeur.
  const lang = (typeof payload.lg === 'string' && VALID_LANGS.has(payload.lg)) ? payload.lg : null;

  // Raid slots : créneaux verrouillés comme dates de raid. Max 7. Chaque slot
  // = { day, hour, duration }. Filtré silencieusement : entrées mal formées
  // (jour invalide, hour hors VALID_AVAIL_HOURS, duration hors borne) ignorées.
  // Servi par lib/availability.js#bestSlotWithTail({excludedSlots}).
  const raidSlots = [];
  if (Array.isArray(payload.rs)) {
    for (const raw of payload.rs.slice(0, 7)) {
      if (!raw || typeof raw !== 'object') continue;
      if (!VALID_AVAIL_DAYS_SET.has(raw.d)) continue;
      if (!VALID_AVAIL_HOURS_SET.has(raw.h)) continue;
      const dur = typeof raw.l === 'number' && raw.l >= 1 && raw.l <= 12 ? raw.l : 1;
      raidSlots.push({ day: raw.d, hour: raw.h, duration: dur });
    }
  }

  return {
    contentType: payload.c,
    dpsMode: payload.d,
    fairnessWeight,
    raidWhen,
    bannedJobs,
    claimLimit,
    lang,
    players,
    raidSlots,
    ownerId: typeof payload.ownerId === 'string' ? payload.ownerId : null,
    admins: Array.isArray(payload.admins) ? payload.admins.slice() : [],
    isAdmin: !!payload.isAdmin
  };
}

// Encode l'état d'un salon vers le payload "court" envoyé à /api/save
// ou utilisé pour les liens base64 autoportés. Pur : caller en charge de
// décider quels champs admin (claimLimit, admins) passer.
//
// Entrée attendue (shape "state-like") :
//   contentType, dpsMode, fairnessWeight, players: [{ name, preferences, ... }]
//   raidWhen?, bannedJobs?, claimLimit?, admins?
//
// Champs omis du player en sortie (économise les bytes en KV/URL) :
//   presence='in', preferences vide, lockedJob falsy, claimedBy falsy,
//   note vide, prefTiers strict (0..n-1).
//
// Inverse de validateImportedPayload : roundtrip-stable pour tout payload
// valide.
export function encodePayload(s) {
  const payload = {
    c: s.contentType,
    d: s.dpsMode,
    f: s.fairnessWeight,
    p: (Array.isArray(s.players) ? s.players : []).map(p => {
      const obj = {
        n: typeof p.name === 'string' ? p.name.trim() : '',
        j: Array.isArray(p.preferences) ? p.preferences.slice() : []
      };
      if (typeof p.rowId === 'string' && p.rowId) obj.id = p.rowId;
      if (p.presence && p.presence !== 'in') obj.s = p.presence;
      if (p.lockedJob) obj.l = p.lockedJob;
      if (p.claimedBy) obj.by = p.claimedBy;
      if (p.note && p.note.trim()) obj.nt = p.note.trim().slice(0, 200);
      if (Array.isArray(p.prefTiers) && p.prefTiers.length === obj.j.length) {
        const isStrict = p.prefTiers.every((t, i) => t === i);
        if (!isStrict) obj.pt = p.prefTiers.slice();
      }
      // Dispos : passe par normalizeAvail pour produire une forme stable
      // (tri + dédup + filtre). null si rien d'utile → champ absent.
      const av = normalizeAvail(p.availability);
      if (av) obj.av = av;
      return obj;
    })
  };
  if (typeof s.raidWhen === 'string' && s.raidWhen.trim() !== '') {
    payload.w = s.raidWhen.trim().slice(0, 80);
  }
  if (Array.isArray(s.bannedJobs) && s.bannedJobs.length > 0) {
    payload.bj = s.bannedJobs.slice();
  }
  if (typeof s.claimLimit === 'number' && VALID_CLAIM_LIMITS.has(s.claimLimit)) {
    payload.cl = s.claimLimit;
  }
  if (typeof s.lang === 'string' && VALID_LANGS.has(s.lang)) {
    payload.lg = s.lang;
  }
  if (Array.isArray(s.admins) && s.admins.length > 0) {
    payload.admins = s.admins.slice();
  }
  // Raid slots : encodés compact { d, h, l }. Filtre les invalides pour ne
  // pas polluer le KV avec des données mal formées (cap à 7 comme côté front).
  if (Array.isArray(s.raidSlots) && s.raidSlots.length > 0) {
    const rs = [];
    for (const slot of s.raidSlots.slice(0, 7)) {
      if (!slot || !VALID_AVAIL_DAYS_SET.has(slot.day)) continue;
      if (!VALID_AVAIL_HOURS_SET.has(slot.hour)) continue;
      const dur = typeof slot.duration === 'number' && slot.duration >= 1 && slot.duration <= 12 ? slot.duration : 1;
      rs.push({ d: slot.day, h: slot.hour, l: dur });
    }
    if (rs.length > 0) payload.rs = rs;
  }
  return payload;
}

// Réexport pratique pour les tests
export { VALID_JOB_IDS, VALID_CONTENT_KEYS };
// JOBS réexporté pour permettre `import { JOBS } from './codec.js'` côté tests
export { JOBS };
