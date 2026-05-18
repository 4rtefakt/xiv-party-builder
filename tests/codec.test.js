// Tests pour lib/codec.js — encode/decode du roster en URL longue + validation.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeState, decodeState, validateImportedPayload, makePlayer, encodePayload,
  PRESENCE_VALUES, VALID_DPS_MODES, DEFAULT_CLAIM_LIMIT
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

test('validateImportedPayload : cl absent → claimLimit = 2 (défaut)', () => {
  const r = validateImportedPayload(validPayload());
  assert.equal(r.claimLimit, 2);
});

test('validateImportedPayload : cl=1 / 3 / 4 / 0 préservés', () => {
  for (const v of [1, 3, 4, 0]) {
    const r = validateImportedPayload(validPayload({ cl: v }));
    assert.equal(r.claimLimit, v);
  }
});

test('validateImportedPayload : cl=99 / cl="2" → fallback 2', () => {
  for (const v of [99, '2', null]) {
    const r = validateImportedPayload(validPayload({ cl: v }));
    assert.equal(r.claimLimit, 2, `cl=${v} doit fallback à 2`);
  }
});

test('validateImportedPayload : lg absent → lang = null', () => {
  const r = validateImportedPayload(validPayload());
  assert.equal(r.lang, null);
});

test('validateImportedPayload : lg="fr"/"en" préservés', () => {
  assert.equal(validateImportedPayload(validPayload({ lg: 'fr' })).lang, 'fr');
  assert.equal(validateImportedPayload(validPayload({ lg: 'en' })).lang, 'en');
});

test('validateImportedPayload : lg invalide → lang = null', () => {
  for (const v of ['de', 'es', 42, '', null]) {
    const r = validateImportedPayload(validPayload({ lg: v }));
    assert.equal(r.lang, null, `lg=${v} doit fallback à null`);
  }
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

// ---------- encodePayload (state-like → API payload "court") ----------

test('encodePayload : payload minimum (state vide)', () => {
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: []
  });
  assert.deepEqual(out, { c: 'raid8', d: 'unified', f: 50, p: [] });
});

test('encodePayload : omet les champs optionnels avec valeur par défaut', () => {
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50,
    players: [{
      name: 'Alice', preferences: ['PLD'], rowId: 'r123',
      presence: 'in', lockedJob: null, claimedBy: null, note: ''
    }]
  });
  // presence='in' → omis ; lockedJob/claimedBy/note vides → omis ; pas de pt
  assert.deepEqual(out.p[0], { n: 'Alice', j: ['PLD'], id: 'r123' });
});

test('encodePayload : émet tous les champs player quand non-défaut', () => {
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50,
    players: [{
      name: '  Alice  ',  // trim
      preferences: ['PLD', 'WAR'],
      rowId: 'r123',
      presence: 'maybe',
      lockedJob: 'PLD',
      claimedBy: 'u_alice',
      note: 'Premier essai',
      prefTiers: [0, 0]  // non-strict → émis
    }]
  });
  assert.deepEqual(out.p[0], {
    n: 'Alice',
    j: ['PLD', 'WAR'],
    id: 'r123',
    s: 'maybe',
    l: 'PLD',
    by: 'u_alice',
    nt: 'Premier essai',
    pt: [0, 0]
  });
});

test('encodePayload : prefTiers strict (0..n-1) est omis', () => {
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50,
    players: [{
      name: 'Alice', preferences: ['PLD', 'WAR', 'DRK'], prefTiers: [0, 1, 2]
    }]
  });
  assert.equal(out.p[0].pt, undefined);
});

test('encodePayload : note tronquée à 200 chars', () => {
  const longNote = 'x'.repeat(500);
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50,
    players: [{ name: 'A', preferences: [], note: longNote }]
  });
  assert.equal(out.p[0].nt.length, 200);
});

test('encodePayload : raidWhen trimmé et tronqué à 80 chars', () => {
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: [],
    raidWhen: '  ' + 'x'.repeat(100) + '  '
  });
  assert.equal(out.w.length, 80);
});

test('encodePayload : raidWhen vide (whitespace only) omis', () => {
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: [],
    raidWhen: '   '
  });
  assert.equal(out.w, undefined);
});

test('encodePayload : bannedJobs vide omis, non-vide émis', () => {
  const empty = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: [],
    bannedJobs: []
  });
  assert.equal(empty.bj, undefined);
  const filled = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: [],
    bannedJobs: ['BLM', 'PCT']
  });
  assert.deepEqual(filled.bj, ['BLM', 'PCT']);
});

test('encodePayload : claimLimit invalide ignoré', () => {
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: [],
    claimLimit: 99
  });
  assert.equal(out.cl, undefined);
});

test('encodePayload : claimLimit valide (0/1/2/3/4) émis', () => {
  for (const cl of [0, 1, 2, 3, 4]) {
    const out = encodePayload({
      contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: [],
      claimLimit: cl
    });
    assert.equal(out.cl, cl, `claimLimit ${cl} doit être émis`);
  }
});

test('encodePayload : admins vide omis, non-vide émis', () => {
  const empty = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: [],
    admins: []
  });
  assert.equal(empty.admins, undefined);
  const filled = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: [],
    admins: ['u_owner']
  });
  assert.deepEqual(filled.admins, ['u_owner']);
});

test('encodePayload → validateImportedPayload : roundtrip stable', () => {
  const s = {
    contentType: 'raid24chaotic',
    dpsMode: 'unified',
    fairnessWeight: 75,
    raidWhen: 'Cloud of Darkness · Samedi 21h',
    bannedJobs: ['BLM'],
    claimLimit: 3,
    players: [
      {
        name: 'Alice', preferences: ['PLD', 'WAR'], rowId: 'rABC1234',
        presence: 'in', lockedJob: 'PLD', claimedBy: 'u_alice',
        note: 'Premier essai', prefTiers: [0, 0]
      },
      {
        name: 'Bob', preferences: ['WHM'], rowId: 'rXYZ5678',
        presence: 'maybe', lockedJob: null, claimedBy: null, note: ''
      }
    ]
  };
  const validated = validateImportedPayload(encodePayload(s));
  assert.equal(validated.contentType, s.contentType);
  assert.equal(validated.dpsMode, s.dpsMode);
  assert.equal(validated.fairnessWeight, s.fairnessWeight);
  assert.equal(validated.raidWhen, s.raidWhen);
  assert.deepEqual(validated.bannedJobs, s.bannedJobs);
  assert.equal(validated.claimLimit, s.claimLimit);
  assert.equal(validated.players.length, 2);
  assert.equal(validated.players[0].name, 'Alice');
  assert.equal(validated.players[0].lockedJob, 'PLD');
  assert.equal(validated.players[0].claimedBy, 'u_alice');
  assert.deepEqual(validated.players[0].prefTiers, [0, 0]);
  assert.equal(validated.players[1].presence, 'maybe');
});

test('encodePayload : availability roundtrip (encode → validate)', () => {
  const s = {
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50,
    players: [{
      name: 'Alice', preferences: [], rowId: 'rABC',
      availability: { mon: [20, 21], sat: [14, 16, 18, 19, 20] }
    }]
  };
  const out = encodePayload(s);
  assert.deepEqual(out.p[0].av, { mon: [20, 21], sat: [14, 16, 18, 19, 20] });
  const validated = validateImportedPayload(out);
  assert.deepEqual(validated.players[0].availability, s.players[0].availability);
});

test('encodePayload : availability nulle ou vide → champ av omis', () => {
  for (const av of [null, undefined, {}, { foo: [99] }]) {
    const out = encodePayload({
      contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50,
      players: [{ name: 'A', preferences: [], availability: av }]
    });
    assert.equal(out.p[0].av, undefined, `av=${JSON.stringify(av)} doit être omis`);
  }
});

test('encodePayload : availability avec heures invalides nettoyée à l\'émission', () => {
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50,
    players: [{
      name: 'A', preferences: [],
      availability: { mon: [20, 99, 21, 0], foo: [20] }
    }]
  });
  assert.deepEqual(out.p[0].av, { mon: [20, 21] });
});

test('encodePayload : claimLimit pas dans payload → roundtrip donne défaut', () => {
  // Quand l'admin ne fournit pas cl, l'importer applique DEFAULT_CLAIM_LIMIT
  const out = encodePayload({
    contentType: 'raid8', dpsMode: 'unified', fairnessWeight: 50, players: []
    // pas de claimLimit
  });
  assert.equal(out.cl, undefined);
  const validated = validateImportedPayload(out);
  assert.equal(validated.claimLimit, DEFAULT_CLAIM_LIMIT);
});
