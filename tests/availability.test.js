// Tests pour lib/availability.js — agrégat des dispos du roster en heatmap.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeAvailability, bestSlots, bestSlotWithTail,
  countAvailCells, AVAIL_PRESETS, applyAvailPreset,
  cellInSlots, slotsIntersect,
  MAX_RAID_SLOTS, MIN_SLOT_DURATION, MAX_SLOT_DURATION
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

test('bestSlotWithTail : un seul slot max → retourné direct avec tail et endHour', () => {
  const a = analyzeAvailability([p('Alice', { mon: [20, 21, 22] })]);
  const b = bestSlotWithTail(a);
  assert.equal(b.day, 'mon');
  assert.equal(b.hour, 20);
  assert.equal(b.count, 1);
  assert.equal(b.tail, 2, '21h et 22h ont la même densité → tail = 2');
  assert.equal(b.endHour, 23, 'endHour = last_start + 1 = 22+1 = 23 (fin du créneau 22h)');
});

test('bestSlotWithTail : tail = 0 → endHour = hour + 1 (1h de jeu)', () => {
  const a = analyzeAvailability([p('Alice', { mon: [20] })]);
  const b = bestSlotWithTail(a);
  assert.equal(b.tail, 0);
  assert.equal(b.endHour, 21, 'créneau 20h → on joue jusqu\'à 21h');
});

test('bestSlotWithTail : gap dans la liste curée casse la chaîne (14h+16h → tail=0)', () => {
  // Alice dispo à 14h ET 16h. Dans VALID_AVAIL_HOURS, 14 et 16 sont
  // array-consecutive mais ne sont PAS strictement consécutifs en heure
  // (15h n'existe pas dans la liste). On NE doit PAS les regrouper en
  // "14h → 17h" qui suggérerait à tort qu'on peut jouer continûment.
  const a = analyzeAvailability([p('Alice', { sat: [14, 16] })]);
  const b = bestSlotWithTail(a);
  assert.equal(b.hour, 14);
  assert.equal(b.tail, 0, '14h et 16h ne sont pas h et h+1 → pas de tail');
  assert.equal(b.endHour, 15);
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

// ---------- cellInSlots / slotsIntersect / bestSlot avec exclusions ----------

test('cellInSlots : true si cellule couverte par un slot (même jour, hour ∈ [hour, hour+dur[)', () => {
  const slots = [{ day: 'mon', hour: 21, duration: 2 }];
  assert.equal(cellInSlots('mon', 21, slots), true,  '21h start ∈ [21, 23[ ✓');
  assert.equal(cellInSlots('mon', 22, slots), true,  '22h start ∈ [21, 23[ ✓');
  assert.equal(cellInSlots('mon', 23, slots), false, '23h start = 21+2 → exclu (semi-ouvert)');
  assert.equal(cellInSlots('mon', 20, slots), false, '20h avant le slot');
  assert.equal(cellInSlots('tue', 21, slots), false, 'jour différent');
});

test('cellInSlots : duration manquante → traité comme 1', () => {
  const slots = [{ day: 'wed', hour: 19 }]; // pas de duration
  assert.equal(cellInSlots('wed', 19, slots), true);
  assert.equal(cellInSlots('wed', 20, slots), false);
});

test('cellInSlots : empty/falsy slots → toujours false', () => {
  assert.equal(cellInSlots('mon', 21, []), false);
  assert.equal(cellInSlots('mon', 21, null), false);
  assert.equal(cellInSlots('mon', 21, undefined), false);
});

test('slotsIntersect : symétrique, true ssi même jour + ranges chevauchent', () => {
  const a = { day: 'mon', hour: 20, duration: 3 }; // [20, 23[
  const b = { day: 'mon', hour: 22, duration: 2 }; // [22, 24[ → chevauche en 22
  const c = { day: 'mon', hour: 23, duration: 1 }; // [23, 24[ → ne chevauche PAS a (a finit à 23 exclus)
  const d = { day: 'tue', hour: 20, duration: 3 }; // autre jour
  assert.equal(slotsIntersect(a, b), true);
  assert.equal(slotsIntersect(b, a), true);
  assert.equal(slotsIntersect(a, c), false, 'a finit à 23 (exclu), c démarre à 23 → adjacent, pas chevauchant');
  assert.equal(slotsIntersect(a, d), false, 'jour différent → pas d\'intersection');
});

test('bestSlots avec excludedSlots : retire les cellules couvertes', () => {
  const a = analyzeAvailability([
    { name: 'A', availability: { mon: [20, 21], tue: [20] } },
    { name: 'B', availability: { mon: [20, 21], tue: [20] } }
  ]);
  // Sans exclusion : mon 20h et mon 21h et tue 20h tous à 2/2
  const noExcl = bestSlots(a, { limit: 5 });
  assert.equal(noExcl.length, 3);
  // Avec mon 20h locké pour 2h → mon 20-22 exclu, reste tue 20h
  const withExcl = bestSlots(a, { limit: 5, excludedSlots: [{ day: 'mon', hour: 20, duration: 2 }] });
  assert.equal(withExcl.length, 1);
  assert.deepEqual(withExcl[0], { day: 'tue', hour: 20, count: 2 });
});

test('bestSlotWithTail avec excludedSlots : propose un slot disjoint', () => {
  const a = analyzeAvailability([
    { name: 'A', availability: { mon: [20, 21, 22, 23], tue: [19, 20] } },
    { name: 'B', availability: { mon: [20, 21, 22, 23], tue: [19, 20] } }
  ]);
  // Sans exclusion : mon 20h (tail=3, joue 20-24, 2/2 partout)
  const noExcl = bestSlotWithTail(a);
  assert.equal(noExcl.day, 'mon');
  assert.equal(noExcl.hour, 20);
  // Avec mon 20h locké pour 4h → tout le lundi exclu, reste mardi 19h (tail=1)
  const withExcl = bestSlotWithTail(a, { excludedSlots: [{ day: 'mon', hour: 20, duration: 4 }] });
  assert.equal(withExcl.day, 'tue');
  assert.equal(withExcl.hour, 19);
  assert.equal(withExcl.tail, 1);
});

test('bestSlotWithTail : tail s\'arrête si l\'heure suivante chevauche un excluded slot', () => {
  const a = analyzeAvailability([
    { name: 'A', availability: { mon: [20, 21, 22, 23] } },
    { name: 'B', availability: { mon: [20, 21, 22, 23] } }
  ]);
  // mon 21h locké pour 1h → 20h candidate avec tail=0 (s'arrête à 21h exclu),
  // 22h candidate avec tail=1 (s'étend à 23h), 23h candidate avec tail=0.
  // Tie-break tail max → 22h gagne.
  const withExcl = bestSlotWithTail(a, { excludedSlots: [{ day: 'mon', hour: 21, duration: 1 }] });
  assert.equal(withExcl.hour, 22);
  assert.equal(withExcl.tail, 1, 'tail = 1 (extend à 23h, qui n\'est pas dans l\'excluded)');

  // Vérifie aussi le cas 20h : si on exclut 22h, le candidat 20h doit avoir tail=0
  // car l'heure suivante (21h) est libre mais 22h est exclu → tail s'arrête à 21h (tail=1)
  const withExcl2 = bestSlots(a, { limit: 10, excludedSlots: [{ day: 'mon', hour: 22, duration: 1 }] });
  const slot20 = withExcl2.find(s => s.hour === 20);
  assert.ok(slot20, '20h doit être candidat');
});

test('bestSlotWithTail : retourne null si tous les créneaux possibles sont exclus', () => {
  const a = analyzeAvailability([
    { name: 'A', availability: { mon: [20, 21] } },
    { name: 'B', availability: { mon: [20, 21] } }
  ]);
  const allExcluded = bestSlotWithTail(a, {
    excludedSlots: [{ day: 'mon', hour: 20, duration: 2 }]
  });
  assert.equal(allExcluded, null);
});

test('MAX_RAID_SLOTS / MIN_SLOT_DURATION / MAX_SLOT_DURATION : exports cohérents', () => {
  assert.equal(MAX_RAID_SLOTS, 7);
  assert.equal(MIN_SLOT_DURATION, 1);
  assert.ok(MAX_SLOT_DURATION >= 2, 'au moins 2h pour un raid utile');
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
