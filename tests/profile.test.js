// Tests pour functions/api/profile.js — endpoint cloud du profil utilisateur.
// On teste les helpers purs (normalize*, validateProfile) directement, et le
// handler GET/PUT avec un mock KV pour les chemins critiques.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePreset, normalizeTemplate, normalizeRecent,
  normalizeDefaultAvailability, validateProfile,
  onRequestGet, onRequestPut
} from '../functions/api/profile.js';

// ---------- normalizePreset ----------

test('normalizePreset : preset valide → conservé tel quel', () => {
  const r = normalizePreset({ name: 'Mes tanks', jobs: ['PLD', 'WAR'] });
  assert.deepEqual(r, { name: 'Mes tanks', jobs: ['PLD', 'WAR'] });
});

test('normalizePreset : jobs invalides filtrés silencieusement', () => {
  const r = normalizePreset({ name: 'mix', jobs: ['PLD', 'BLU', 'foo', 'WAR'] });
  assert.deepEqual(r.jobs, ['PLD', 'WAR']);
});

test('normalizePreset : doublons dédupliqués (1ʳᵉ occurrence gagne)', () => {
  const r = normalizePreset({ name: 'dup', jobs: ['PLD', 'WAR', 'PLD'] });
  assert.deepEqual(r.jobs, ['PLD', 'WAR']);
});

test('normalizePreset : nom tronqué à 30 chars', () => {
  const r = normalizePreset({ name: 'a'.repeat(50), jobs: ['PLD'] });
  assert.equal(r.name.length, 30);
});

test('normalizePreset : nom vide → null', () => {
  assert.equal(normalizePreset({ name: '', jobs: ['PLD'] }), null);
});

test('normalizePreset : jobs pas un tableau → null', () => {
  assert.equal(normalizePreset({ name: 'X', jobs: 'PLD' }), null);
});

// ---------- normalizeTemplate ----------

test('normalizeTemplate : template valide', () => {
  const r = normalizeTemplate({
    name: 'EX Trial',
    contentType: 'raid8',
    bannedJobs: ['BLM'],
    fairnessWeight: 50,
    savedAt: 1234567890
  });
  assert.equal(r.name, 'EX Trial');
  assert.equal(r.contentType, 'raid8');
  assert.deepEqual(r.bannedJobs, ['BLM']);
});

test('normalizeTemplate : contentType inconnu → null', () => {
  assert.equal(normalizeTemplate({ name: 'X', contentType: 'foo' }), null);
});

test('normalizeTemplate : raid24chaotic accepté', () => {
  const r = normalizeTemplate({ name: 'CAR', contentType: 'raid24chaotic' });
  assert.equal(r.contentType, 'raid24chaotic');
});

test('normalizeTemplate : fairnessWeight hors borne ignoré', () => {
  const r = normalizeTemplate({ name: 'X', contentType: 'raid8', fairnessWeight: 999 });
  assert.equal(r.fairnessWeight, undefined);
});

// ---------- normalizeRecent ----------

test('normalizeRecent : recent valide', () => {
  const r = normalizeRecent({ id: 'aBc123', contentType: 'raid8', when: 'mardi 21h', savedAt: 1 });
  assert.equal(r.id, 'aBc123');
  assert.equal(r.contentType, 'raid8');
});

test('normalizeRecent : id avec mauvais format → null', () => {
  assert.equal(normalizeRecent({ id: 'too-long-id-with-dashes-123' }), null);
  assert.equal(normalizeRecent({ id: 'no' }), null);  // trop court
  assert.equal(normalizeRecent({ id: '*invalid*' }), null);
});

test('normalizeRecent : when tronqué à 80 chars', () => {
  const r = normalizeRecent({ id: 'aBc123', when: 'x'.repeat(200) });
  assert.equal(r.when.length, 80);
});

// ---------- validateProfile ----------

test('validateProfile : payload vide accepté (profil neuf)', () => {
  const r = validateProfile({});
  assert.equal(r.error, undefined);
  assert.equal(r.stored.v, 1);
  assert.ok(typeof r.stored.updatedAt === 'number');
});

test('validateProfile : null/array rejeté', () => {
  assert.match(validateProfile(null).error, /profile/i);
  assert.match(validateProfile([]).error, /profile/i);
});

test('validateProfile : tableau invalide pour presets rejeté', () => {
  assert.match(validateProfile({ presets: 'not array' }).error, /presets/i);
});

test('validateProfile : presets coupés à 5', () => {
  const presets = Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, jobs: ['PLD'] }));
  const r = validateProfile({ presets });
  assert.equal(r.stored.presets.length, 5);
});

test('validateProfile : templates coupés à 10', () => {
  const templates = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, contentType: 'raid8' }));
  const r = validateProfile({ templates });
  assert.equal(r.stored.templates.length, 10);
});

test('validateProfile : recents coupés à 5', () => {
  const recents = Array.from({ length: 20 }, (_, i) => ({
    id: 'r' + String(i).padStart(5, '0')
  }));
  const r = validateProfile({ recents });
  assert.equal(r.stored.recents.length, 5);
});

test('validateProfile : items invalides drop sans casser tout le profil', () => {
  const r = validateProfile({
    presets: [
      { name: 'good', jobs: ['PLD'] },
      { name: '', jobs: ['WAR'] },          // nom vide → drop
      null,                                  // pas un objet → drop
      { name: 'good2', jobs: ['WHM'] }
    ]
  });
  assert.deepEqual(r.stored.presets.map(p => p.name), ['good', 'good2']);
});

// ---------- onRequestGet (avec mock KV) ----------

function mockKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(key) { return store.get(key) || null; },
    async put(key, value, opts) { store.set(key, value); },
    _store: store
  };
}

function makeReq({ headers = {}, body = null } = {}) {
  const h = new Headers(headers);
  return new Request('http://localhost/api/profile', {
    method: body ? 'PUT' : 'GET',
    headers: h,
    body: body
  });
}

test('GET : sans X-User-Id → 400', async () => {
  const kv = mockKV();
  const r = await onRequestGet({ request: makeReq(), env: { PARTY_KV: kv } });
  assert.equal(r.status, 400);
});

test('GET : userId valide, pas de profil → 200 avec profil vide', async () => {
  const kv = mockKV();
  const r = await onRequestGet({
    request: makeReq({ headers: { 'X-User-Id': 'abc-user-1' } }),
    env: { PARTY_KV: kv }
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.v, 1);
  assert.deepEqual(body.presets, []);
  assert.deepEqual(body.templates, []);
  assert.deepEqual(body.recents, []);
});

test('GET : profil existant retourné', async () => {
  const kv = mockKV({
    'prof:abc-user-1': JSON.stringify({ v: 1, presets: [{ name: 'X', jobs: ['PLD'] }] })
  });
  const r = await onRequestGet({
    request: makeReq({ headers: { 'X-User-Id': 'abc-user-1' } }),
    env: { PARTY_KV: kv }
  });
  const body = await r.json();
  assert.equal(body.presets.length, 1);
  assert.equal(body.presets[0].name, 'X');
});

test('GET : profil corrompu → fallback profil vide', async () => {
  const kv = mockKV({ 'prof:abc-user-1': 'not-json-{{{' });
  const r = await onRequestGet({
    request: makeReq({ headers: { 'X-User-Id': 'abc-user-1' } }),
    env: { PARTY_KV: kv }
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.presets, []);
});

test('GET : isolation par userId — un user ne voit pas le profil d\'un autre', async () => {
  const kv = mockKV({
    'prof:alice-uid': JSON.stringify({ v: 1, presets: [{ name: 'secret', jobs: ['PLD'] }] })
  });
  // Bob essaie de lire avec son propre userId (jamais provisionné en KV)
  const r = await onRequestGet({
    request: makeReq({ headers: { 'X-User-Id': 'bob-uid' } }),
    env: { PARTY_KV: kv }
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.presets, [], 'Bob ne doit pas voir le profil d\'Alice');
});

// ---------- onRequestPut ----------

test('PUT : écrit le profil pour le userId fourni', async () => {
  const kv = mockKV();
  const body = JSON.stringify({ presets: [{ name: 'X', jobs: ['PLD'] }] });
  const req = new Request('http://localhost/api/profile', {
    method: 'PUT',
    headers: { 'X-User-Id': 'abc-user-1', 'Content-Length': String(body.length) },
    body
  });
  const r = await onRequestPut({ request: req, env: { PARTY_KV: kv } });
  assert.equal(r.status, 200);
  // Le stockage doit être sous prof:<userId> et pas autre part
  const stored = kv._store.get('prof:abc-user-1');
  assert.ok(stored, 'profil écrit sous la bonne clé');
  const parsed = JSON.parse(stored);
  assert.equal(parsed.presets.length, 1);
});

test('PUT : payload invalide rejeté avec 400', async () => {
  const kv = mockKV();
  const body = JSON.stringify({ presets: 'not-an-array' });
  const req = new Request('http://localhost/api/profile', {
    method: 'PUT',
    headers: { 'X-User-Id': 'abc-user-1', 'Content-Length': String(body.length) },
    body
  });
  const r = await onRequestPut({ request: req, env: { PARTY_KV: kv } });
  assert.equal(r.status, 400);
});

test('PUT : body trop large → 413', async () => {
  const kv = mockKV();
  // Construire un payload > 8KB
  const huge = 'x'.repeat(9000);
  const body = JSON.stringify({ presets: [{ name: huge, jobs: ['PLD'] }] });
  const req = new Request('http://localhost/api/profile', {
    method: 'PUT',
    headers: { 'X-User-Id': 'abc-user-1', 'Content-Length': String(body.length) },
    body
  });
  const r = await onRequestPut({ request: req, env: { PARTY_KV: kv } });
  assert.equal(r.status, 413);
});

test('PUT : JSON malformé → 400', async () => {
  const kv = mockKV();
  const body = 'not-json{{{';
  const req = new Request('http://localhost/api/profile', {
    method: 'PUT',
    headers: { 'X-User-Id': 'abc-user-1', 'Content-Length': String(body.length) },
    body
  });
  const r = await onRequestPut({ request: req, env: { PARTY_KV: kv } });
  assert.equal(r.status, 400);
});

// ---------- normalizeDefaultAvailability ----------

test('normalizeDefaultAvailability : objet valide → trié + dédupliqué', () => {
  const r = normalizeDefaultAvailability({ mon: [21, 20, 20, 22], sat: [14, 16] });
  assert.deepEqual(r, { mon: [20, 21, 22], sat: [14, 16] });
});

test('normalizeDefaultAvailability : jours/heures invalides filtrés', () => {
  const r = normalizeDefaultAvailability({ mon: [20, 99, 0], foo: [20], sat: [14] });
  assert.deepEqual(r, { mon: [20], sat: [14] });
});

test('normalizeDefaultAvailability : non-objet / vide → null', () => {
  assert.equal(normalizeDefaultAvailability(null), null);
  assert.equal(normalizeDefaultAvailability({}), null);
  assert.equal(normalizeDefaultAvailability([1, 2]), null);
  assert.equal(normalizeDefaultAvailability('foo'), null);
});

test('validateProfile : defaultAvailability inclus en sortie quand valide', () => {
  const r = validateProfile({ defaultAvailability: { mon: [20, 21] } });
  assert.deepEqual(r.stored.defaultAvailability, { mon: [20, 21] });
});

test('validateProfile : defaultAvailability null permet l\'effacement', () => {
  const r = validateProfile({ defaultAvailability: null });
  assert.equal(r.stored.defaultAvailability, null);
});

test('validateProfile : defaultAvailability absent → champ omis', () => {
  const r = validateProfile({ presets: [] });
  assert.equal(r.stored.defaultAvailability, undefined);
});
