// Tests pour lib/local-store.js — helpers localStorage purs (sans sync cloud).
//
// Node n'a pas window.localStorage : on polyfill globalThis.localStorage avec
// un Map en mémoire. Reset entre chaque test pour l'isolation.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS_KEY, TEMPLATES_KEY, RECENT_ROOMS_KEY,
  MAX_PRESETS, MAX_TEMPLATES, MAX_RECENT_ROOMS,
  getPresets, writePresetsLocal,
  getTemplates, writeTemplatesLocal,
  getRecentRooms, writeRecentRoomsLocal
} from '../lib/local-store.js';

// Polyfill localStorage en mémoire — minimal mais fidèle au sous-ensemble
// utilisé : getItem / setItem / removeItem / clear.
function installLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
  };
  return store;
}

function uninstallLocalStorage() {
  delete globalThis.localStorage;
}

// --- Presets ---

test('getPresets : LS vide → []', () => {
  installLocalStorage();
  assert.deepEqual(getPresets(), []);
  uninstallLocalStorage();
});

test('getPresets : JSON invalide → []', () => {
  installLocalStorage();
  localStorage.setItem(PRESETS_KEY, 'not-json');
  assert.deepEqual(getPresets(), []);
  uninstallLocalStorage();
});

test('getPresets : pas un array → []', () => {
  installLocalStorage();
  localStorage.setItem(PRESETS_KEY, JSON.stringify({ foo: 'bar' }));
  assert.deepEqual(getPresets(), []);
  uninstallLocalStorage();
});

test('getPresets : presets valides conservés, invalides filtrés', () => {
  installLocalStorage();
  localStorage.setItem(PRESETS_KEY, JSON.stringify([
    { name: 'Tanks', jobs: ['PLD'] },
    { name: null, jobs: ['WAR'] },         // nom invalide → filtré
    { jobs: ['DRK'] },                      // pas de nom → filtré
    { name: 'Healers', jobs: 'WHM' },       // jobs pas un array → filtré
    { name: 'OK', jobs: ['SCH'] }
  ]));
  const r = getPresets();
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'Tanks');
  assert.equal(r[1].name, 'OK');
});

test('getPresets : cap à MAX_PRESETS', () => {
  installLocalStorage();
  const many = Array.from({ length: 20 }, (_, i) => ({ name: 'P' + i, jobs: ['PLD'] }));
  localStorage.setItem(PRESETS_KEY, JSON.stringify(many));
  assert.equal(getPresets().length, MAX_PRESETS);
  uninstallLocalStorage();
});

test('writePresetsLocal : sérialise + cap à MAX_PRESETS', () => {
  installLocalStorage();
  const many = Array.from({ length: 20 }, (_, i) => ({ name: 'P' + i, jobs: ['PLD'] }));
  writePresetsLocal(many);
  const raw = JSON.parse(localStorage.getItem(PRESETS_KEY));
  assert.equal(raw.length, MAX_PRESETS);
  uninstallLocalStorage();
});

test('writePresetsLocal : no-op si localStorage indispo (Node sans polyfill)', () => {
  // Sans installLocalStorage : doit pas throw
  uninstallLocalStorage();
  writePresetsLocal([{ name: 'x', jobs: [] }]);
  // Pas d'assertion : on vérifie juste que ça n'a pas levé
});

test('getPresets : pas de polyfill → []', () => {
  uninstallLocalStorage();
  assert.deepEqual(getPresets(), []);
});

// --- Templates ---

test('getTemplates : filtre les entrées sans contentType', () => {
  installLocalStorage();
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify([
    { name: 'Standard', contentType: 'raid8' },
    { name: 'Sans CT' },                          // pas de contentType → filtré
    { contentType: 'raid24' },                    // pas de nom → filtré
    { name: 'Other', contentType: 'dungeon' }
  ]));
  const r = getTemplates();
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'Standard');
});

test('writeTemplatesLocal + getTemplates : roundtrip', () => {
  installLocalStorage();
  const arr = [{ name: 'A', contentType: 'raid8', bannedJobs: ['BLM'] }];
  writeTemplatesLocal(arr);
  const r = getTemplates();
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'A');
  assert.deepEqual(r[0].bannedJobs, ['BLM']);
  uninstallLocalStorage();
});

test('getTemplates : cap à MAX_TEMPLATES', () => {
  installLocalStorage();
  const many = Array.from({ length: 30 }, (_, i) => ({ name: 'T' + i, contentType: 'raid8' }));
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(many));
  assert.equal(getTemplates().length, MAX_TEMPLATES);
  uninstallLocalStorage();
});

// --- Salons récents ---

test('getRecentRooms : filtre les entrées sans id', () => {
  installLocalStorage();
  localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify([
    { id: 'abc123' },
    { when: 'samedi' },                            // pas d'id → filtré
    null,                                          // null → filtré
    { id: 'xyz789', when: 'dimanche' }
  ]));
  const r = getRecentRooms();
  assert.equal(r.length, 2);
  assert.equal(r[0].id, 'abc123');
});

test('getRecentRooms : cap à MAX_RECENT_ROOMS', () => {
  installLocalStorage();
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i }));
  localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(many));
  assert.equal(getRecentRooms().length, MAX_RECENT_ROOMS);
  uninstallLocalStorage();
});

test('writeRecentRoomsLocal : sérialise + cap', () => {
  installLocalStorage();
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i }));
  writeRecentRoomsLocal(many);
  const raw = JSON.parse(localStorage.getItem(RECENT_ROOMS_KEY));
  assert.equal(raw.length, MAX_RECENT_ROOMS);
  uninstallLocalStorage();
});
