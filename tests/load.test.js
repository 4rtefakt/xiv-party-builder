// Tests pour functions/api/load/[id].js — le endpoint GET complet, et le
// roundtrip save → load → codec client. Régression : load omettait cl / rs /
// lg, le client retombait sur les défauts (cl=2, rs=[]) et le save admin
// suivant réécrivait ces défauts en KV (perte silencieuse des raid slots et
// de la claim limit à chaque reload).

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/save.js';
import { onRequestGet } from '../functions/api/load/[id].js';
import { validateImportedPayload, encodePayload } from '../lib/codec.js';

function mockKV(initialData = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(initialData)) store.set(k, v);
  return {
    async get(key) { return store.get(key) || null; },
    async put(key, value) { store.set(key, value); },
    _store: store
  };
}

const USER = 'user-admin-0001';

async function createRoom(env, payload) {
  const req = new Request('https://x.test/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': USER },
    body: JSON.stringify(payload)
  });
  const res = await onRequestPost({ request: req, env, waitUntil() {} });
  assert.equal(res.status, 200);
  return res.json();
}

async function loadRoom(env, id, userId = USER) {
  const req = new Request(`https://x.test/api/load/${id}`, {
    headers: userId ? { 'X-User-Id': userId } : {}
  });
  const res = await onRequestGet({ params: { id }, env, request: req });
  return { status: res.status, body: await res.json() };
}

test('load : renvoie cl, lg et rs stockés à la création', async () => {
  const env = { PARTY_KV: mockKV() };
  const created = await createRoom(env, {
    c: 'raid8', d: 'split', f: 40,
    p: [{ n: 'Alice', j: ['PLD'] }],
    cl: 1, lg: 'en',
    rs: [{ d: 'tue', h: 21, l: 2.5 }, { d: 'sat', h: 14, l: 4 }]
  });
  const { status, body } = await loadRoom(env, created.id);
  assert.equal(status, 200);
  assert.equal(body.cl, 1);
  assert.equal(body.lg, 'en');
  assert.deepEqual(body.rs, [{ d: 'tue', h: 21, l: 2.5 }, { d: 'sat', h: 14, l: 4 }]);
  assert.equal(body.isAdmin, true);
});

test('load : cl / lg / rs absents du store → champs omis (rétrocompat vieux salons)', async () => {
  const env = { PARTY_KV: mockKV() };
  const created = await createRoom(env, {
    c: 'dungeon', d: 'unified',
    p: [{ n: 'Solo', j: ['WAR'] }]
  });
  const { body } = await loadRoom(env, created.id);
  assert.equal('cl' in body, false);
  assert.equal('lg' in body, false);
  assert.equal('rs' in body, false);
});

test('roundtrip complet : save(create) → load → codec client → re-save admin ne perd ni cl ni rs', async () => {
  const env = { PARTY_KV: mockKV() };
  const created = await createRoom(env, {
    c: 'raid8', d: 'split', f: 50,
    p: [{ n: 'Alice', j: ['PLD'], id: 'rAAAAAAA' }],
    cl: 3, lg: 'fr',
    rs: [{ d: 'wed', h: 20, l: 3 }]
  });

  // Le client recharge la page : load → validateImportedPayload (comme
  // fetchPayloadById côté front) → state → encodePayload → save admin.
  const loaded = (await loadRoom(env, created.id)).body;
  const state = validateImportedPayload(loaded);
  assert.equal(state.claimLimit, 3, 'la claim limit doit survivre au load');
  assert.equal(state.lang, 'fr');
  assert.deepEqual(state.raidSlots, [{ day: 'wed', hour: 20, duration: 3 }]);

  const resave = encodePayload({
    contentType: state.contentType, dpsMode: state.dpsMode,
    fairnessWeight: state.fairnessWeight, players: state.players,
    raidWhen: state.raidWhen, bannedJobs: state.bannedJobs,
    claimLimit: state.claimLimit, lang: state.lang, raidSlots: state.raidSlots
  });
  const req = new Request('https://x.test/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': USER },
    body: JSON.stringify({ ...resave, id: created.id })
  });
  const res = await onRequestPost({ request: req, env, waitUntil() {} });
  assert.equal(res.status, 200);

  const stored = JSON.parse(await env.PARTY_KV.get(created.id));
  assert.equal(stored.cl, 3, 'le re-save ne doit pas réécrire le défaut');
  assert.deepEqual(stored.rs, [{ d: 'wed', h: 20, l: 3 }], 'les raid slots ne doivent pas être perdus');
});

test('création : rs du payload est stocké dès le premier save', async () => {
  const env = { PARTY_KV: mockKV() };
  const created = await createRoom(env, {
    c: 'raid8', d: 'unified',
    p: [{ n: 'Alice', j: ['PLD'] }],
    rs: [{ d: 'mon', h: 20, l: 1.5 }]
  });
  const stored = JSON.parse(await env.PARTY_KV.get(created.id));
  assert.deepEqual(stored.rs, [{ d: 'mon', h: 20, l: 1.5 }]);
});

test('load : ne fuite jamais recoveryHash', async () => {
  const env = { PARTY_KV: mockKV() };
  const created = await createRoom(env, {
    c: 'raid8', d: 'unified', p: [{ n: 'Alice', j: ['PLD'] }]
  });
  const { body } = await loadRoom(env, created.id);
  assert.equal('recoveryHash' in body, false);
});
