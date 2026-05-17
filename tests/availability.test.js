// Tests pour lib/availability.js — agrégat des dispos du roster en heatmap.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeAvailability, bestSlots, bestSlotWithTail,
  countAvailCells, AVAIL_PRESETS, applyAvailPreset
} from '../lib/availability.js';
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

// ---------- countAvailCells ----------

test('countAvailCells : null/undefined → 0', () => {
  assert.equal(countAvailCells(null), 0);
  assert.equal(countAvailCells(undefined), 0);
  assert.equal(countAvailCells('not-an-object'), 0);
});

test('countAvailCells : compte sur tous les jours valides', () => {
  assert.equal(countAvailCells({ mon: [20, 21], sat: [14, 16, 18] }), 5);
});

test('countAvailCells : jour inconnu ignoré (defensive)', () => {
  // Ne compte que les jours dans VALID_AVAIL_DAYS, pas la fantaisie.
  assert.equal(countAvailCells({ foo: [20, 21, 22], mon: [20] }), 1);
});

// ---------- applyAvailPreset ----------

test('applyAvailPreset : clear → availability null', () => {
  const pl = { availability: { mon: [20] } };
  applyAvailPreset(pl, 'clear');
  assert.equal(pl.availability, null);
});

test('applyAvailPreset : weekdayEvening sur player vierge → coche lun-ven', () => {
  const pl = { availability: null };
  applyAvailPreset(pl, 'weekdayEvening');
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri']) {
    assert.deepEqual(pl.availability[day], [20, 21, 22], `jour ${day}`);
  }
  assert.equal(pl.availability.sat, undefined);
});

test('applyAvailPreset : weekendAll sur player vierge → coche sam+dim', () => {
  const pl = { availability: null };
  applyAvailPreset(pl, 'weekendAll');
  assert.ok(pl.availability.sat.length > 0);
  assert.ok(pl.availability.sun.length > 0);
  assert.equal(pl.availability.mon, undefined);
});

test('applyAvailPreset : merge additif (ne remplace pas ce qui existe)', () => {
  const pl = { availability: { mon: [10], sat: [14] } };
  applyAvailPreset(pl, 'weekdayEvening');
  // Le 10h existant reste, + les 20-22h ajoutés
  assert.deepEqual(pl.availability.mon, [10, 20, 21, 22]);
  // Le sat 14h n'est pas touché par weekdayEvening
  assert.deepEqual(pl.availability.sat, [14]);
});

test('applyAvailPreset : preset inconnu → no-op', () => {
  const pl = { availability: { mon: [20] } };
  applyAvailPreset(pl, 'inexistant');
  assert.deepEqual(pl.availability, { mon: [20] });
});

// ---------- bestSlotWithTail ----------

test('bestSlotWithTail : null si pas de répondants', () => {
  assert.equal(bestSlotWithTail(analyzeAvailability([])), null);
});

test('bestSlotWithTail : un seul slot max → retourné direct avec tail', () => {
  const a = analyzeAvailability([p('Alice', { mon: [20, 21, 22] })]);
  const b = bestSlotWithTail(a);
  assert.equal(b.day, 'mon');
  assert.equal(b.hour, 20);
  assert.equal(b.count, 1);
  assert.equal(b.tail, 2, '21h et 22h ont la même densité → tail = 2');
});

test('bestSlotWithTail : départage 2 ex-æquo par la longueur de tail', () => {
  // Mardi : tous dispos uniquement à 20h, rien après
  // Mercredi : tous dispos de 20h à 22h
  // → Mercredi gagne malgré le tri "jour" qui ferait gagner mardi
  const a = analyzeAvailability([
    p('Alice', { tue: [20], wed: [20, 21, 22] }),
    p('Bob',   { tue: [20], wed: [20, 21, 22] })
  ]);
  const b = bestSlotWithTail(a);
  assert.equal(b.day, 'wed');
  assert.equal(b.hour, 20);
  assert.equal(b.count, 2);
  assert.equal(b.tail, 2);
});

test('bestSlotWithTail : la chaîne se rompt sur un trou dans les heures consécutives', () => {
  // 20h : 2/2 dispos
  // 21h : 1/2 (chaîne rompue ici)
  // 22h : 2/2 mais on a déjà cassé
  const a = analyzeAvailability([
    p('Alice', { mon: [20, 22] }),
    p('Bob',   { mon: [20, 21, 22] })  // mais Alice manque 21h
  ]);
  const b = bestSlotWithTail(a);
  assert.equal(b.day, 'mon');
  assert.equal(b.hour, 20);
  assert.equal(b.tail, 0, '21h tombe à 1/2 → chaîne rompue, tail=0');
});

test('bestSlotWithTail : ex-æquo en tail ET densité → départage par jour puis heure', () => {
  // Lun 20h et Mar 20h ont mêmes count + tail. Lun gagne (jour avant).
  const a = analyzeAvailability([
    p('Alice', { mon: [20, 21], tue: [20, 21] }),
    p('Bob',   { mon: [20, 21], tue: [20, 21] })
  ]);
  const b = bestSlotWithTail(a);
  assert.equal(b.day, 'mon');
  assert.equal(b.hour, 20);
});

test('AVAIL_PRESETS : chaque preset utilise des heures valides', () => {
  // Garde-fou : si on étend la liste d'heures valides, les presets ne doivent
  // pas avoir d'heures qui passent en dehors silencieusement.
  for (const presetKey of Object.keys(AVAIL_PRESETS)) {
    const preset = AVAIL_PRESETS[presetKey];
    for (const day of Object.keys(preset)) {
      for (const hour of preset[day]) {
        assert.ok(VALID_AVAIL_HOURS.includes(hour), `preset ${presetKey} jour ${day} → heure invalide ${hour}`);
      }
    }
  }
});
