// Tests pour lib/codec.js — encode/decode du roster en URL longue + validation.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeState, decodeState, validateImportedPayload, makePlayer,
  PRESENCE_VALUES, VALID_DPS_MODES
} from '../lib/codec.js';

// ---------- Roundtrip encode/decode ----------

test('roundtrip : payload simple encode → decode donne le même objet JSON', () => {
  const original = {
    c: 'raid8',
    d: 'unified',
    f: 50,
    p: [
      { n: 'Alice', j: ['WHM', 'SCH'] },
      { n: 'Bob', j: ['PLD'] }
    ]
  };
  const code = encodeState(original);
  const decoded = decodeState(code);
  assert.deepEqual(decoded, original);
});

test('roundtrip : caractères Unicode (accents, ·, emoji) survivent', () => {
  const original = {
    c: 'raid8',
    d: 'unified',
    p: [
      { n: 'Élise · héaler', j: ['WHM'], nt: '⚠ note avec emoji 🎯' }
    ]
  };
  const code = encodeState(original);
  const decoded = decodeState(code);
  assert.deepEqual(decoded, original);
});

test('encodeState : pas de + ni / ni = (base64url-safe)', () => {
  // Forcer un payload qui produit naturellement des + et / en base64 standard
  const original = { c: 'raid8', d: 'unified', p: [{ n: '🎉🎊🎁', j: ['PLD'] }] };
  const code = encodeState(original);
  assert.ok(!code.includes('+'), 'pas de +');
  assert.ok(!code.includes('/'), 'pas de /');
  assert.ok(!code.includes('='), 'pas de padding =');
});

test('decodeState : code invalide jette INVALID_CODE', () => {
  assert.throws(() => decodeState('not!!!base64!!!'), /INVALID_CODE/);
  assert.throws(() => decodeState(''), /INVALID_CODE/);
});

// ---------- validateImportedPayload ----------

function validPayload(over = {}) {
  return {
    c: 'raid8',
    d: 'unified',
    p: [{ n: 'Alice', j: ['PLD'] }],
    ...over
  };
}

test('validateImportedPayload : payload valide minimal', () => {
  const r = validateImportedPayload(validPayload());
  assert.equal(r.contentType, 'raid8');
  assert.equal(r.dpsMode, 'unified');
  assert.equal(r.fairnessWeight, 50);
  assert.equal(r.players.length, 1);
  assert.equal(r.players[0].name, 'Alice');
  assert.deepEqual(r.players[0].preferences, ['PLD']);
});

test('validateImportedPayload : null jette INVALID_FORMAT', () => {
  assert.throws(() => validateImportedPayload(null), /INVALID_FORMAT/);
  assert.throws(() => validateImportedPayload([]), /INVALID_FORMAT/);
  assert.throws(() => validateImportedPayload('string'), /INVALID_FORMAT/);
});

test('validateImportedPayload : content type inconnu jette UNKNOWN_CONTENT', () => {
  assert.throws(() => validateImportedPayload(validPayload({ c: 'foo' })), /UNKNOWN_CONTENT/);
});

test('validateImportedPayload : raid24chaotic est reconnu', () => {
  const r = validateImportedPayload(validPayload({ c: 'raid24chaotic' }));
  assert.equal(r.contentType, 'raid24chaotic');
});

test('validateImportedPayload : dpsMode invalide jette INVALID_DPS', () => {
  assert.throws(() => validateImportedPayload(validPayload({ d: 'wat' })), /INVALID_DPS/);
});

test('validateImportedPayload : p pas un tableau jette INVALID_PLAYERS', () => {
  assert.throws(() => validateImportedPayload(validPayload({ p: 'string' })), /INVALID_PLAYERS/);
  assert.throws(() => validateImportedPayload(validPayload({ p: null })), /INVALID_PLAYERS/);
});

test('validateImportedPayload : jobs inconnus filtrés silencieusement', () => {
  const r = validateImportedPayload({
    c: 'raid8', d: 'unified',
    p: [{ n: 'X', j: ['PLD', 'BLU', 'foo', 'BST'] }]
  });
  // BLU et BST sont des jobs FFXIV mais EXCLUS de la liste valide ; 'foo' inconnu
  assert.deepEqual(r.players[0].preferences, ['PLD']);
});

test('validateImportedPayload : presence invalide → fallback "in"', () => {
  const r = validateImportedPayload({
    c: 'raid8', d: 'unified',
    p: [{ n: 'X', j: ['PLD'], s: 'wat' }]
  });
  assert.equal(r.players[0].presence, 'in');
});

test('validateImportedPayload : prefTiers mal formé (mauvaise longueur) → ignoré', () => {
  const r = validateImportedPayload({
    c: 'raid8', d: 'unified',
    p: [{ n: 'X', j: ['PLD', 'WAR'], pt: [0] }]  // 2 prefs, 1 tier
  });
  assert.deepEqual(r.players[0].prefTiers, [], 'tier silencieusement ignoré');
});

test('validateImportedPayload : prefTiers valides sont préservés', () => {
  const r = validateImportedPayload({
    c: 'raid8', d: 'unified',
    p: [{ n: 'X', j: ['PLD', 'WAR'], pt: [0, 1] }]
  });
  assert.deepEqual(r.players[0].prefTiers, [0, 1]);
});

test('validateImportedPayload : fairnessWeight hors borne → fallback 50', () => {
  const r = validateImportedPayload(validPayload({ f: 999 }));
  assert.equal(r.fairnessWeight, 50);
  const r2 = validateImportedPayload(validPayload({ f: -10 }));
  assert.equal(r2.fairnessWeight, 50);
});

test('validateImportedPayload : raidWhen tronqué à 80 chars', () => {
  const longStr = 'a'.repeat(200);
  const r = validateImportedPayload(validPayload({ w: longStr }));
  assert.equal(r.raidWhen.length, 80);
});

test('validateImportedPayload : note tronquée à 200 chars', () => {
  const longNote = 'b'.repeat(500);
  const r = validateImportedPayload({
    c: 'raid8', d: 'unified',
    p: [{ n: 'X', j: ['PLD'], nt: longNote }]
  });
  assert.equal(r.players[0].note.length, 200);
});

test('validateImportedPayload : bj filtre les job IDs inconnus', () => {
  const r = validateImportedPayload(validPayload({
    bj: ['PLD', 'BLU', 'foo', 'WAR']
  }));
  assert.deepEqual(r.bannedJobs.sort(), ['PLD', 'WAR']);
});

test('roundtrip avec validation : encode → decode → validate', () => {
  const original = {
    c: 'raid24chaotic',
    d: 'unified',
    f: 75,
    w: 'Cloud of Darkness Chaotic',
    bj: ['BLM'],
    p: [
      { n: 'Tank', j: ['PLD', 'WAR'], pt: [0, 0], l: 'PLD' },
      { n: 'Heal', j: ['WHM'], s: 'maybe', nt: 'peut-être dispo' }
    ]
  };
  const validated = validateImportedPayload(decodeState(encodeState(original)));
  assert.equal(validated.contentType, 'raid24chaotic');
  assert.equal(validated.fairnessWeight, 75);
  assert.equal(validated.raidWhen, 'Cloud of Darkness Chaotic');
  assert.deepEqual(validated.bannedJobs, ['BLM']);
  assert.equal(validated.players[0].lockedJob, 'PLD');
  assert.deepEqual(validated.players[0].prefTiers, [0, 0]);
  assert.equal(validated.players[1].presence, 'maybe');
  assert.equal(validated.players[1].note, 'peut-être dispo');
});

// ---------- makePlayer + helpers ----------

test('makePlayer retourne un player initialisé', () => {
  const p = makePlayer('Alice');
  assert.equal(p.name, 'Alice');
  assert.deepEqual(p.preferences, []);
  assert.deepEqual(p.prefTiers, []);
  assert.equal(p.presence, 'in');
  assert.equal(p.lockedJob, null);
  assert.equal(p.claimedBy, null);
  assert.equal(p.note, '');
});

test('constantes exportées', () => {
  assert.deepEqual(PRESENCE_VALUES.slice().sort(), ['in', 'maybe', 'out'].sort());
  assert.deepEqual(VALID_DPS_MODES.slice().sort(), ['split', 'unified'].sort());
});
