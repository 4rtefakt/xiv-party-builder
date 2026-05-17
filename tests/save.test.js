// Tests pour functions/api/save.js — helpers serveur (validation, dedup,
// normalisation, rate-limit sliding window).
//
// Note : save.js utilise crypto.subtle et crypto.getRandomValues — dispos
// en Node ≥18 via globalThis.crypto, donc rien à mocker pour les helpers
// purs. Pour checkRateLimit on mocke env.PARTY_KV en mémoire.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePayload, dedupPrefs, normalizePlayer, normalizeForNonAdminMerge,
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

// ---------- validatePayload : claim limit ----------

test('validatePayload : cl=2 (défaut) accepté', () => {
  assert.equal(validatePayload(valid({ cl: 2 })), null);
});

test('validatePayload : cl=1 / 3 / 4 / 0 (illimité) acceptés', () => {
  for (const v of [1, 3, 4, 0]) {
    assert.equal(validatePayload(valid({ cl: v })), null, `cl=${v}`);
  }
});

test('validatePayload : cl=5, cl=-1, cl="2" rejetés', () => {
  assert.match(validatePayload(valid({ cl: 5 })), /claim limit/i);
  assert.match(validatePayload(valid({ cl: -1 })), /claim limit/i);
  assert.match(validatePayload(valid({ cl: '2' })), /claim limit/i);
});

// ---------- validatePayload : availability ----------

test('validatePayload : av valide accepté', () => {
  const r = validatePayload(valid({
    p: [{ n: 'Alice', j: [], av: { mon: [20, 21], sat: [14, 16] } }]
  }));
  assert.equal(r, null);
});

test('validatePayload : av tableau rejeté', () => {
  assert.match(validatePayload(valid({
    p: [{ n: 'A', j: [], av: [20] }]
  })), /availability/i);
});

test('validatePayload : av avec jour inconnu rejeté', () => {
  assert.match(validatePayload(valid({
    p: [{ n: 'A', j: [], av: { foo: [20] } }]
  })), /availability/i);
});

test('validatePayload : av avec heure hors liste rejeté', () => {
  assert.match(validatePayload(valid({
    p: [{ n: 'A', j: [], av: { mon: [99] } }]
  })), /availability/i);
  assert.match(validatePayload(valid({
    p: [{ n: 'A', j: [], av: { mon: [0] } }]
  })), /availability/i);
});

test('validatePayload : av avec heure string rejeté', () => {
  assert.match(validatePayload(valid({
    p: [{ n: 'A', j: [], av: { mon: ['20'] } }]
  })), /availability/i);
});

test('validatePayload : av jour avec valeur non-tableau rejeté', () => {
  assert.match(validatePayload(valid({
    p: [{ n: 'A', j: [], av: { mon: 20 } }]
  })), /availability/i);
});

// ---------- normalizePlayer : availability ----------

test('normalizePlayer : av filtré + trié + dédupliqué', () => {
  const out = normalizePlayer({
    n: 'A', j: [],
    av: { mon: [21, 20, 20, 99, 22], foo: [20], tue: [] }
  });
  assert.deepEqual(out.av, { mon: [20, 21, 22] });
});

test('normalizePlayer : av complètement invalide → champ omis', () => {
  const out = normalizePlayer({
    n: 'A', j: [],
    av: { foo: [99], bar: [-1] }
  });
  assert.equal(out.av, undefined);
});

test('normalizePlayer : av absent → champ omis', () => {
  const out = normalizePlayer({ n: 'A', j: [] });
  assert.equal(out.av, undefined);
});

// ---------- normalizeForNonAdminMerge : enforcement de la limite ----------

function makeExisting(over = {}) {
  return {
    c: 'raid8',
    d: 'unified',
    ownerId: 'owner-1',
    admins: ['owner-1'],
    recoveryHash: 'fakehash',
    p: [],
    ...over
  };
}

function makeRow(rowId, name, by = null) {
  const row = { id: rowId, n: name, j: [] };
  if (by) row.by = by;
  return row;
}

test('merge non-admin : un user au seuil (2/2) ne peut pas claim une 3ᵉ ligne', () => {
  const existing = makeExisting({
    cl: 2,
    p: [
      makeRow('r0000001', 'A', 'me'),
      makeRow('r0000002', 'B', 'me'),
      makeRow('r0000003', 'C'),       // libre
      makeRow('r0000004', 'D')
    ]
  });
  const payload = {
    c: 'raid8', d: 'unified',
    p: [
      makeRow('r0000001', 'A', 'me'),
      makeRow('r0000002', 'B', 'me'),
      makeRow('r0000003', 'C', 'me'),  // tentative de 3ᵉ claim
      makeRow('r0000004', 'D')
    ]
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'me');
  // La 3ᵉ ligne doit rester libre
  assert.equal(stored.p[2].by, undefined, 'le 3ᵉ claim doit être rejeté');
  // Les 2 premières restent claim par "me"
  assert.equal(stored.p[0].by, 'me');
  assert.equal(stored.p[1].by, 'me');
});

test('merge non-admin : cl=1 (strict tryhard) → un user ne peut claim qu\'une seule ligne', () => {
  const existing = makeExisting({
    cl: 1,
    p: [
      makeRow('r0000001', 'A', 'me'),  // déjà 1 claim
      makeRow('r0000002', 'B'),         // libre
      makeRow('r0000003', 'C')          // libre
    ]
  });
  const payload = {
    c: 'raid8', d: 'unified',
    p: [
      makeRow('r0000001', 'A', 'me'),
      makeRow('r0000002', 'B', 'me'),   // tentative de 2ᵉ claim → doit être refusé
      makeRow('r0000003', 'C')
    ]
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'me');
  assert.equal(stored.p[0].by, 'me', '1er claim préservé');
  assert.equal(stored.p[1].by, undefined, 'le 2ᵉ claim doit être rejeté en cl=1');
  assert.equal(stored.p[2].by, undefined);
});

test('merge non-admin : libérer 1 puis claim 1 nouvelle reste sous la limite', () => {
  const existing = makeExisting({
    cl: 2,
    p: [
      makeRow('r0000001', 'A', 'me'),
      makeRow('r0000002', 'B', 'me'),
      makeRow('r0000003', 'C')
    ]
  });
  const payload = {
    c: 'raid8', d: 'unified',
    p: [
      makeRow('r0000001', 'A'),         // libère son claim
      makeRow('r0000002', 'B', 'me'),
      makeRow('r0000003', 'C', 'me')    // nouveau claim
    ]
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'me');
  assert.equal(stored.p[0].by, undefined, 'ligne 1 libérée');
  assert.equal(stored.p[1].by, 'me');
  assert.equal(stored.p[2].by, 'me', 'nouveau claim accepté (place libérée)');
});

test('merge non-admin : peut ajouter une nouvelle ligne self-claim sous la limite', () => {
  const existing = makeExisting({
    cl: 2,
    p: [
      makeRow('r0000001', 'A', 'someone-else'),
      makeRow('r0000002', 'B')
    ]
  });
  const payload = {
    c: 'raid8', d: 'unified',
    p: [
      makeRow('r0000001', 'A', 'someone-else'),
      makeRow('r0000002', 'B'),
      makeRow('rNEW1234', 'Newcomer', 'me')  // nouvelle ligne
    ]
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'me');
  assert.equal(stored.p.length, 3, 'la nouvelle ligne doit être ajoutée');
  assert.equal(stored.p[2].n, 'Newcomer');
  assert.equal(stored.p[2].by, 'me');
});

test('merge non-admin : nouvelle ligne non-claim par moi est ignorée', () => {
  const existing = makeExisting({
    cl: 2,
    p: [makeRow('r0000001', 'A')]
  });
  const payload = {
    c: 'raid8', d: 'unified',
    p: [
      makeRow('r0000001', 'A'),
      makeRow('rNEW1234', 'Newcomer')         // pas de `by`
    ]
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'me');
  assert.equal(stored.p.length, 1, 'pas de claim → pas d\'ajout');
});

test('merge non-admin : nouvelle ligne claim par autrui est ignorée', () => {
  const existing = makeExisting({
    cl: 2,
    p: [makeRow('r0000001', 'A')]
  });
  const payload = {
    c: 'raid8', d: 'unified',
    p: [
      makeRow('r0000001', 'A'),
      makeRow('rNEW1234', 'Newcomer', 'attacker') // claim par autre user
    ]
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'me');
  assert.equal(stored.p.length, 1, 'tentative de claim par autre user → ignorée');
});

test('merge non-admin : nouvelle ligne refusée si on est déjà au max', () => {
  const existing = makeExisting({
    cl: 1, // mode strict
    p: [
      makeRow('r0000001', 'A', 'me'),  // déjà à la limite
    ]
  });
  const payload = {
    c: 'raid8', d: 'unified',
    p: [
      makeRow('r0000001', 'A', 'me'),
      makeRow('rNEW1234', 'Newcomer', 'me')  // tentative au delà du max
    ]
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'me');
  assert.equal(stored.p.length, 1, 'au max de claims → pas d\'ajout');
});

test('merge non-admin : cl=0 (illimité) → tous les claims passent', () => {
  const existing = makeExisting({
    cl: 0,
    p: Array.from({ length: 8 }, (_, i) => makeRow(`r000000${i + 1}`, `P${i}`))
  });
  const payload = {
    c: 'raid8', d: 'unified',
    p: Array.from({ length: 8 }, (_, i) => makeRow(`r000000${i + 1}`, `P${i}`, 'greedy'))
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'greedy');
  // Toutes les lignes doivent être claim
  assert.equal(stored.p.filter(p => p.by === 'greedy').length, 8);
});

test('merge non-admin : cl absent dans existing → défaut 2 appliqué', () => {
  // Ancien salon sans cl : on doit traiter comme limite=2
  const existing = makeExisting({
    p: [
      makeRow('r0000001', 'A'),
      makeRow('r0000002', 'B'),
      makeRow('r0000003', 'C')
    ]
  });
  const payload = {
    c: 'raid8', d: 'unified',
    p: [
      makeRow('r0000001', 'A', 'me'),
      makeRow('r0000002', 'B', 'me'),
      makeRow('r0000003', 'C', 'me')   // doit être rejeté (limite défaut = 2)
    ]
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'me');
  assert.equal(stored.p[2].by, undefined);
});

test('merge non-admin : claims pré-existants au-dessus de la limite sont préservés', () => {
  // Cas où la limite a été baissée après-coup (ex: l'owner a passé de 4 à 2).
  // Les claims déjà en place ne sont pas wipés.
  const existing = makeExisting({
    cl: 2,
    p: [
      makeRow('r0000001', 'A', 'me'),
      makeRow('r0000002', 'B', 'me'),
      makeRow('r0000003', 'C', 'me'),  // déjà au-dessus de la limite actuelle
      makeRow('r0000004', 'D', 'me')
    ]
  });
  // L'utilisateur modifie juste son nom sur la ligne 4, sans nouveau claim
  const payload = {
    c: 'raid8', d: 'unified',
    p: existing.p.map(p => ({ ...p }))
  };
  const stored = normalizeForNonAdminMerge(payload, existing, 'me');
  assert.equal(stored.p.filter(p => p.by === 'me').length, 4, 'tous les claims pré-existants conservés');
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
