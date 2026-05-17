// Helpers localStorage pour les "magasins" de profil utilisateur·ice :
// presets de prefs, templates de compo, salons récents.
//
// Volontairement isolé du sync cloud (functions/api/profile.js) : les
// fonctions d'écriture ici ne déclenchent PAS le push cloud. Les callers
// d'index.html wrappent ces helpers via writeX() qui appelle aussi
// pushProfileToCloud(). Cette séparation permet :
//   - les tests sans dépendre du réseau / d'un mock KV
//   - hydrater le LS depuis le cloud (loadProfileFromCloud) sans déclencher
//     une boucle de push retour
//
// Côté Node (tests), `localStorage` n'est pas défini. Le try/catch attrape
// silencieusement la ReferenceError et retourne [] (read) / no-op (write).
// Pour tester les chemins read/write, le test polyfill `globalThis.localStorage`.

export const PRESETS_KEY = 'xiv-pref-presets';
export const MAX_PRESETS = 5;
export const MAX_PRESET_NAME_LEN = 30;

export const TEMPLATES_KEY = 'xiv-comp-templates';
export const MAX_TEMPLATES = 10;
export const MAX_TEMPLATE_NAME_LEN = 40;

export const RECENT_ROOMS_KEY = 'xiv-recent-rooms';
export const MAX_RECENT_ROOMS = 5;

// --- Helpers internes ---

function readArray(key) {
  try {
    const v = localStorage.getItem(key);
    if (!v) return null;
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

function writeArray(key, arr, cap) {
  try { localStorage.setItem(key, JSON.stringify(arr.slice(0, cap))); }
  catch { /* quota / mode privé / Node : on ignore silencieusement */ }
}

// --- Presets de préférences ---

export function getPresets() {
  const arr = readArray(PRESETS_KEY);
  if (!arr) return [];
  return arr
    .filter(p => p && typeof p.name === 'string' && Array.isArray(p.jobs))
    .slice(0, MAX_PRESETS);
}

export function writePresetsLocal(arr) {
  writeArray(PRESETS_KEY, arr, MAX_PRESETS);
}

// --- Templates de compo ---

export function getTemplates() {
  const arr = readArray(TEMPLATES_KEY);
  if (!arr) return [];
  return arr
    .filter(tp => tp && typeof tp.name === 'string' && typeof tp.contentType === 'string')
    .slice(0, MAX_TEMPLATES);
}

export function writeTemplatesLocal(arr) {
  writeArray(TEMPLATES_KEY, arr, MAX_TEMPLATES);
}

// --- Salons récents ---

export function getRecentRooms() {
  const arr = readArray(RECENT_ROOMS_KEY);
  if (!arr) return [];
  return arr
    .filter(r => r && typeof r.id === 'string')
    .slice(0, MAX_RECENT_ROOMS);
}

export function writeRecentRoomsLocal(arr) {
  writeArray(RECENT_ROOMS_KEY, arr, MAX_RECENT_ROOMS);
}
