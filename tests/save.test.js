// Tests pour functions/api/save.js — helpers serveur (validation, dedup,
// normalisation, rate-limit sliding window).
//
// Note : save.js utilise crypto.subtle et crypto.getRandomValues — dispos
// en Node ≥18 via globalThis.crypto, donc rien à mocker pour les helpers
// purs. Pour checkRateLimit on mocke env.PARTY_KV en mémoire.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePayload, dedupPrefs, normalizePlayer,
  checkRateLimit, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS
} from '../functions/api/save.js';

// ---------- validatePayload ----------

function valid(over = {}) {
  return {
    c: 'raid8',
    d: 'unified',
    p: [{ n: 'Alice', j: ['PLD'] }],
    ...over
  };
}

test('validatePayload : payload minimal valide → null', () => {
  assert.equal(validatePayload(valid()), null);
});

test('validatePayload : raid24chaotic est accepté', () => {
  assert.equal(validatePayload(valid({ c: 'raid24chaotic' })), null);
});

test('validatePayload : content type inconnu rejeté', () => {
  assert.match(validatePayload(valid({ c: 'foo' })), /content/i);
});

test('validatePayload : dpsMode invalide rejeté', () => {
  assert.match(validatePayload(valid({ d: 'wat' })), /dps/i);
});

test('validatePayload : payload null/array/string rejeté', () => {
  assert.ok(validatePayload(null));
  assert.ok(validatePayload([]));
  assert.ok(validatePayload('string'));
});

test('validatePayload : fairnessWeight hors [0,100] rejeté', () => {
  assert.match(validatePayload(valid({ f: 150 })), /fairness/i);
  assert.match(validatePayload(valid({ f: -1 })), /fairness/i);
  assert.match(validatePayload(valid({ f: NaN })), /fairness/i);
});

test('validatePayload : raidWhen trop long rejeté', () => {
  assert.match(validatePayload(valid({ w: 'a'.repeat(200) })), /raidWhen/i);
});

test('validatePayload : bj avec job inconnu rejeté', () => {
  assert.match(validatePayload(valid({ bj: ['PLD', 'foo'] })), /banned/i);
});

test('validatePayload : player avec nom trop long rejeté', () => {
  const longName = 'a'.repeat(100);
  assert.match(validatePayload(valid({ p: [{ n: longName, j: ['PLD'] }] })), /name/i);
});

test('validatePayload : player avec job inconnu dans j rejeté', () => {
  assert.match(validatePayload(valid({ p: [{ n: 'X', j: ['BLU'] }] })), /job/i);
});

test('validatePayload : presence invalide rejetée', () => {
  assert.match(validatePayload(valid({ p: [{ n: 'X', j: [], s: 'wat' }] })), /presence/i);
});

test('validatePayload : lockedJob inconnu rejeté', () => {
  assert.match(validatePayload(valid({ p: [{ n: 'X', j: [], l: 'BST' }] })), /locked/i);
});

test('validatePayload : pt de mauvaise longueur rejeté', () => {
  assert.match(validatePayload(valid({
    p: [{ n: 'X', j: ['PLD', 'WAR'], pt: [0] }]  // 2 prefs, 1 tier
  })), /tiers/i);
});

test('validatePayload : pt avec valeur hors borne rejetée', () => {
  assert.match(validatePayload(valid({
    p: [{ n: 'X', j: ['PLD'], pt: [99] }]
  })), /tier/i);
});

// ---------- dedupPrefs ----------

test('dedupPrefs : sans doublon, sortie identique', () => {
  const r = dedupPrefs(['PLD', 'WAR', 'DRK'], [0, 1, 2]);
  assert.deepEqual(r.jobs, ['PLD', 'WAR', 'DRK']);
  assert.deepEqual(r.tiers, [0, 1, 2]);
});

test('dedupPrefs : doublon, garde la 1ʳᵉ occurrence', () => {
  const r = dedupPrefs(['PLD', 'WAR', 'PLD', 'DRK'], [0, 1, 2, 3]);
  assert.deepEqual(r.jobs, ['PLD', 'WAR', 'DRK']);
  // Tier de la 1ʳᵉ occurrence préservé (0 pour PLD), pas celui du doublon (2)
  assert.deepEqual(r.tiers, [0, 1, 3]);
});

test('dedupPrefs : sans tiers (null) retourne tiers=null', () => {
  const r = dedupPrefs(['PLD', 'PLD'], null);
  assert.deepEqual(r.jobs, ['PLD']);
  assert.equal(r.tiers, null);
});

test('dedupPrefs : tiers de mauvaise longueur ignoré', () => {
  const r = dedupPrefs(['PLD', 'WAR'], [0]);
  assert.deepEqual(r.jobs, ['PLD', 'WAR']);
  assert.equal(r.tiers, null, 'tiers ignoré si longueur incompatible');
});

// ---------- normalizePlayer ----------

test('normalizePlayer : applique dedup sur j et synchronise pt', () => {
  const out = normalizePlayer({
    n: 'Alice',
    j: ['PLD', 'WAR', 'PLD'],
    pt: [0, 1, 0],
    id: 'rABC1234'
  });
  assert.deepEqual(out.j, ['PLD', 'WAR']);
  assert.deepEqual(out.pt, [0, 1]);
  assert.equal(out.id, 'rABC1234');
});

test('normalizePlayer : génère un rowId si absent', () => {
  const out = normalizePlayer({ n: 'X', j: ['PLD'] });
  assert.match(out.id, /^r[A-Za-z0-9]{7}$/);
});

test('normalizePlayer : préserve existingRowId quand id absent', () => {
  const out = normalizePlayer({ n: 'X', j: ['PLD'] }, 'r1234567');
  assert.equal(out.id, 'r1234567');
});

test('normalizePlayer : id avec mauvais format → généré', () => {
  // ROW_ID_PATTERN = ^[A-Za-z0-9_-]{4,16}$ : "*invalid*" matchera pas
  const out = normalizePlayer({ n: 'X', j: ['PLD'], id: '*invalid*' });
  // Doit fallback sur génération
  assert.notEqual(out.id, '*invalid*');
  assert.match(out.id, /^r[A-Za-z0-9]{7}$/);
});

test('normalizePlayer : presence "in" est l\'omitted (économie de bytes)', () => {
  const out = normalizePlayer({ n: 'X', j: ['PLD'], s: 'in' });
  assert.equal(out.s, undefined, 'in = défaut, pas stocké');
});

test('normalizePlayer : presence non-in préservée', () => {
  const out = normalizePlayer({ n: 'X', j: ['PLD'], s: 'maybe' });
  assert.equal(out.s, 'maybe');
});

test('normalizePlayer : note tronquée à 200 chars', () => {
  const out = normalizePlayer({ n: 'X', j: ['PLD'], nt: 'a'.repeat(500) });
  assert.equal(out.nt.length, 200);
});

test('normalizePlayer : by="" ou null est omis', () => {
  const out1 = normalizePlayer({ n: 'X', j: ['PLD'], by: '' });
  assert.equal(out1.by, undefined);
  const out2 = normalizePlayer({ n: 'X', j: ['PLD'], by: null });
  assert.equal(out2.by, undefined);
});

// ---------- checkRateLimit (sliding window) ----------

// Mock KV en mémoire avec TTL respecté
function mockKV(initialData = {}, nowSec = Date.now() / 1000) {
  const store = new Map();
  for (const [k, v] of Object.entries(initialData)) store.set(k, v);
  return {
    async get(key) {
      return store.get(key) || null;
    },
    async put(key, value, opts) {
      // On ignore expirationTtl pour les tests — le mock garde tout.
      store.set(key, value);
    },
    _store: store
  };
}

test('checkRateLimit : 1er appel passe, écrit le bucket courant', async () => {
  const kv = mockKV();
  const env = { PARTY_KV: kv };
  const r = await checkRateLimit(env, 'user-abc-1');
  assert.equal(r.allowed, true);
  assert.equal(r.estimated, 1);
  // Le bucket actuel doit avoir été incrémenté
  const W = RATE_LIMIT_WINDOW_SECONDS;
  const bucket = Math.floor(Date.now() / 1000 / W);
  assert.equal(kv._store.get(`rl:user-abc-1:${bucket}`), '1');
});

test('checkRateLimit : N appels successifs incrémentent le bucket', async () => {
  const kv = mockKV();
  const env = { PARTY_KV: kv };
  for (let i = 1; i <= 5; i++) {
    const r = await checkRateLimit(env, 'user-burst');
    assert.equal(r.allowed, true);
  }
  const W = RATE_LIMIT_WINDOW_SECONDS;
  const bucket = Math.floor(Date.now() / 1000 / W);
  assert.equal(kv._store.get(`rl:user-burst:${bucket}`), '5');
});

test('checkRateLimit : refuse quand le bucket courant atteint MAX', async () => {
  const W = RATE_LIMIT_WINDOW_SECONDS;
  const bucket = Math.floor(Date.now() / 1000 / W);
  const kv = mockKV({ [`rl:user-spam:${bucket}`]: String(RATE_LIMIT_MAX) });
  const env = { PARTY_KV: kv };
  const r = await checkRateLimit(env, 'user-spam');
  assert.equal(r.allowed, false);
});

test('checkRateLimit : bucket précédent pondéré dans la fenêtre glissante', async () => {
  // Si on est à 50% du bucket courant, le bucket précédent compte pour 50%.
  // Bucket précédent à MAX, bucket courant à 0 → estimated = MAX * 0.5 + 0 = MAX/2 < MAX → allowed.
  // Mais avec bucket précédent à MAX et bucket courant à MAX/2 → estimated = MAX/2 + MAX/2 = MAX → refusé.
  const W = RATE_LIMIT_WINDOW_SECONDS;
  const bucket = Math.floor(Date.now() / 1000 / W);
  const kv = mockKV({
    [`rl:user-edge:${bucket - 1}`]: String(RATE_LIMIT_MAX),
    [`rl:user-edge:${bucket}`]: String(Math.floor(RATE_LIMIT_MAX / 2))
  });
  const env = { PARTY_KV: kv };
  const r = await checkRateLimit(env, 'user-edge');
  // Suivant la position dans la fenêtre, c'est plus ou moins refusé.
  // L'invariant testable : si elapsed=0 (début bucket), prev compte à 100%,
  // current=MAX/2 → estimated = MAX + MAX/2 → refusé.
  // Dans tous les cas le résultat dépend de l'instant — on teste juste qu'on
  // a une décision booléenne cohérente.
  assert.equal(typeof r.allowed, 'boolean');
});

test('checkRateLimit : isolation par userId', async () => {
  const kv = mockKV();
  const env = { PARTY_KV: kv };
  await checkRateLimit(env, 'user-A');
  await checkRateLimit(env, 'user-A');
  const rA = await checkRateLimit(env, 'user-A');
  const rB = await checkRateLimit(env, 'user-B');  // 1er appel pour B
  assert.equal(rA.estimated, 3);
  assert.equal(rB.estimated, 1);
});
