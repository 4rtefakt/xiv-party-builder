// Tests pour lib/availability.js — agrégat des dispos du roster en heatmap.

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAvailability, bestSlots } from '../lib/availability.js';
import { normalizeAvail, VALID_AVAIL_HOURS, VALID_AVAIL_DAYS } from '../lib/codec.js';

// ---------- normalizeAvail ----------

test('normalizeAvail : null/undefined/non-objet → null', () => {
  assert.equal(normalizeAvail(null), null);
  assert.equal(normalizeAvail(undefined), null);
  assert.equal(normalizeAvail('foo'), null);
  assert.equal(normalizeAvail(42), null);
  assert.equal(normalizeAvail([1, 2]), null);
});

test('normalizeAvail : objet vide → null (pas de signal)', () => {
  assert.equal(normalizeAvail({}), null);
});

test('normalizeAvail : jours inconnus filtrés', () => {
  const r = normalizeAvail({ mon: [20], foo: [20], abc: [21] });
  assert.deepEqual(r, { mon: [20] });
});

test('normalizeAvail : heures hors liste filtrées', () => {
  const r = normalizeAvail({ mon: [20, 99, 0, 21, -1] });
  assert.deepEqual(r, { mon: [20, 21] });
});

test('normalizeAvail : doublons déduits + tri croissant', () => {
  const r = normalizeAvail({ mon: [21, 20, 20, 22, 21] });
  assert.deepEqual(r, { mon: [20, 21, 22] });
});

test('normalizeAvail : jour avec tableau vide après filtre → omis', () => {
  const r = normalizeAvail({ mon: [99, -1], tue: [20] });
  assert.deepEqual(r, { tue: [20] });
});

test('normalizeAvail : non-tableau → ignoré', () => {
  const r = normalizeAvail({ mon: 'foo', tue: [20] });
  assert.deepEqual(r, { tue: [20] });
});

test('normalizeAvail : tous les jours et heures valides', () => {
  const all = {};
  for (const d of VALID_AVAIL_DAYS) all[d] = VALID_AVAIL_HOURS.slice();
  const r = normalizeAvail(all);
  for (const d of VALID_AVAIL_DAYS) {
    assert.deepEqual(r[d], VALID_AVAIL_HOURS, `jour ${d}`);
  }
});

// ---------- analyzeAvailability ----------

function p(name, availability = null, presence = 'in') {
  return { name, availability, presence };
}

test('analyzeAvailability : roster vide → matrice vide partout, 0 répondants', () => {
  const a = analyzeAvailability([]);
  assert.equal(a.respondentCount, 0);
  for (const d of VALID_AVAIL_DAYS) {
    for (const h of VALID_AVAIL_HOURS) {
      assert.deepEqual(a.matrix[d][h], []);
    }
  }
});

test('analyzeAvailability : joueurs sans availability exclus du count', () => {
  const a = analyzeAvailability([
    p('Alice', null),
    p('Bob', null),
    p('Charlie', { mon: [20] })
  ]);
  assert.equal(a.respondentCount, 1);
  assert.deepEqual(a.matrix.mon[20], ['Charlie']);
});

test('analyzeAvailability : présence "out" exclue même avec availability', () => {
  const a = analyzeAvailability([
    p('Alice', { mon: [20] }, 'out'),
    p('Bob', { mon: [20] })
  ]);
  assert.equal(a.respondentCount, 1);
  assert.deepEqual(a.matrix.mon[20], ['Bob']);
});

test('analyzeAvailability : "maybe" est inclus', () => {
  const a = analyzeAvailability([
    p('Alice', { mon: [20] }, 'maybe'),
    p('Bob', { mon: [20] })
  ]);
  assert.equal(a.respondentCount, 2);
  assert.deepEqual(a.matrix.mon[20], ['Alice', 'Bob']);
});

test('analyzeAvailability : nom vide exclu', () => {
  const a = analyzeAvailability([
    p('  ', { mon: [20] }),
    p('Bob', { mon: [20] })
  ]);
  assert.equal(a.respondentCount, 1);
  assert.deepEqual(a.matrix.mon[20], ['Bob']);
});

test('analyzeAvailability : matrix + missing complémentaires (count = respondentCount)', () => {
  const a = analyzeAvailability([
    p('Alice', { mon: [20] }),
    p('Bob', { mon: [21] }),
    p('Charlie', { mon: [20, 21] })
  ]);
  assert.deepEqual(a.matrix.mon[20].sort(), ['Alice', 'Charlie']);
  assert.deepEqual(a.matrix.mon[21].sort(), ['Bob', 'Charlie']);
  assert.deepEqual(a.missing.mon[20], ['Bob']);
  assert.deepEqual(a.missing.mon[21], ['Alice']);
  // partout, available + missing = respondentCount = 3
  assert.equal(a.matrix.mon[20].length + a.missing.mon[20].length, 3);
  assert.equal(a.matrix.mon[22].length + a.missing.mon[22].length, 3);
});

test('analyzeAvailability : nom trimmé avant insertion', () => {
  const a = analyzeAvailability([p('  Alice  ', { mon: [20] })]);
  assert.deepEqual(a.matrix.mon[20], ['Alice']);
});

// ---------- bestSlots ----------

test('bestSlots : tableau vide quand personne n\'a rempli', () => {
  assert.deepEqual(bestSlots(analyzeAvailability([])), []);
});

test('bestSlots : ordonnés par count décroissant', () => {
  const a = analyzeAvailability([
    p('Alice', { mon: [20] }),
    p('Bob', { mon: [20], tue: [21] }),
    p('Charlie', { mon: [20] })
  ]);
  const best = bestSlots(a, { limit: 5 });
  assert.equal(best[0].day, 'mon');
  assert.equal(best[0].hour, 20);
  assert.equal(best[0].count, 3);
  // Le 2ème = Mardi 21h avec count=1
  assert.equal(best[1].day, 'tue');
  assert.equal(best[1].hour, 21);
});

test('bestSlots : limit respecté', () => {
  const a = analyzeAvailability([
    p('Alice', { mon: [20, 21], tue: [20], wed: [20] })
  ]);
  const best = bestSlots(a, { limit: 2 });
  assert.equal(best.length, 2);
});

test('bestSlots : ex-æquo tri stable (jour puis heure)', () => {
  const a = analyzeAvailability([
    p('Alice', { sat: [22], mon: [20] }),
    p('Bob', { sat: [22], mon: [20] })
  ]);
  const best = bestSlots(a);
  // Lundi vient avant samedi → 1er = mon 20h
  assert.equal(best[0].day, 'mon');
  assert.equal(best[0].hour, 20);
  assert.equal(best[1].day, 'sat');
  assert.equal(best[1].hour, 22);
});
