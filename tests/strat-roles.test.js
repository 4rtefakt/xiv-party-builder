// Tests pour lib/strat-roles.js — étiquetage MT/OT/H1/H2/M1/M2/R1/R2.
// Le mapping DPS est PUREMENT POSITIONNEL (selon sous-grille 2 col) :
//   col 0 (gauche) → M(row+1), col 1 (droite) → R(row+1)
// Donc dps[0] → M1, dps[1] → R1, dps[2] → M2, dps[3] → R2, etc.

import test from 'node:test';
import assert from 'node:assert/strict';
import { assignStratRoles, reorderResultsForDpsLayout } from '../lib/strat-roles.js';

function r(name, role) { return { name, role, assigned: true }; }
function bench(name) { return { name, assigned: false }; }

// --- Tanks ---

test('tanks : 1 → T', () => {
  const out = assignStratRoles([r('A', 'tank'), r('B', 'heal'), r('C', 'melee'), r('D', 'ranged')], 'dungeon');
  assert.equal(out[0].stratRole, 'T');
});

test('tanks : 2 → MT, OT (dans l\'ordre)', () => {
  const out = assignStratRoles([r('A', 'tank'), r('B', 'tank')], 'raid8');
  assert.equal(out[0].stratRole, 'MT');
  assert.equal(out[1].stratRole, 'OT');
});

test('tanks : 3+ → T1, T2, T3', () => {
  const results = [r('A', 'tank'), r('B', 'tank'), r('C', 'tank')];
  assignStratRoles(results, 'raid24chaotic');
  assert.deepEqual(results.map(t => t.stratRole), ['T1', 'T2', 'T3']);
});

// --- Heals ---

test('heals : 1 → H', () => {
  const out = assignStratRoles([r('A', 'heal')], 'dungeon');
  assert.equal(out[0].stratRole, 'H');
});

test('heals : 2 → H1, H2', () => {
  const out = assignStratRoles([r('A', 'heal'), r('B', 'heal')], 'raid8');
  assert.equal(out[0].stratRole, 'H1');
  assert.equal(out[1].stratRole, 'H2');
});

// --- DPS positionnel ---

test('DPS : 4 DPS → M1 R1 M2 R2 (ordre sous-grille L→R, top→bottom)', () => {
  const results = [
    r('A', 'tank'), r('B', 'tank'), r('C', 'heal'), r('D', 'heal'),
    r('D1', 'melee'), r('D2', 'melee'),
    r('D3', 'ranged'), r('D4', 'caster')
  ];
  assignStratRoles(results, 'raid8');
  // dps array = [D1, D2, D3, D4] dans l'ordre des results
  // dps[0] → M1 (top-left), dps[1] → R1 (top-right)
  // dps[2] → M2 (bottom-left), dps[3] → R2 (bottom-right)
  assert.equal(results[4].stratRole, 'M1');
  assert.equal(results[5].stratRole, 'R1');
  assert.equal(results[6].stratRole, 'M2');
  assert.equal(results[7].stratRole, 'R2');
});

test('DPS : le label suit la POSITION même si la composition est inhabituelle', () => {
  // 3 rangeds + 1 melee : si le melee est à la position 2 (dps[2]), il est
  // labellisé M2 (pas M1). C'est l'inverse du job-based.
  const results = [
    r('A', 'tank'), r('B', 'tank'), r('C', 'heal'), r('D', 'heal'),
    r('R1pl', 'ranged'), r('R2pl', 'caster'),
    r('Mpl', 'melee'), r('R3pl', 'ranged')
  ];
  assignStratRoles(results, 'raid8');
  assert.equal(results[4].stratRole, 'M1', 'ranged en pos 0 → M1 par position');
  assert.equal(results[5].stratRole, 'R1');
  assert.equal(results[6].stratRole, 'M2', 'le melee en pos 2 → M2 (et non M1)');
  assert.equal(results[7].stratRole, 'R2');
});

test('DPS : swap de positions → swap de labels', () => {
  // Pose la "compo de base" puis swap dps[0] ↔ dps[2] et vérifie les labels.
  const A = r('A', 'melee');
  const B = r('B', 'ranged');
  const C = r('C', 'caster');
  const D = r('D', 'melee');
  const results1 = [r('T1', 'tank'), r('T2', 'tank'), r('H1', 'heal'), r('H2', 'heal'), A, B, C, D];
  assignStratRoles(results1, 'raid8');
  assert.equal(A.stratRole, 'M1');
  assert.equal(C.stratRole, 'M2');
  // Reset les labels et essaie l'ordre permuté
  delete A.stratRole; delete B.stratRole; delete C.stratRole; delete D.stratRole;
  const results2 = [r('T1', 'tank'), r('T2', 'tank'), r('H1', 'heal'), r('H2', 'heal'), C, B, A, D];
  assignStratRoles(results2, 'raid8');
  assert.equal(C.stratRole, 'M1', 'après swap, C est en pos 0 → M1');
  assert.equal(A.stratRole, 'M2', 'A est passé en pos 2 → M2');
});

test('DPS : 2 DPS (dungeon) → M1 R1', () => {
  const results = [
    r('T', 'tank'), r('H', 'heal'),
    r('D1', 'melee'), r('D2', 'caster')
  ];
  assignStratRoles(results, 'dungeon');
  assert.equal(results[2].stratRole, 'M1');
  assert.equal(results[3].stratRole, 'R1');
});

test('DPS : 5 DPS (raid24 alliance) → M1 R1 M2 R2 M3', () => {
  const results = [
    r('T', 'tank'), r('H1', 'heal'), r('H2', 'heal'),
    r('D1', 'melee'), r('D2', 'melee'),
    r('D3', 'ranged'), r('D4', 'caster'), r('D5', 'ranged')
  ];
  assignStratRoles(results, 'raid24');
  assert.equal(results[3].stratRole, 'M1');
  assert.equal(results[4].stratRole, 'R1');
  assert.equal(results[5].stratRole, 'M2');
  assert.equal(results[6].stratRole, 'R2');
  assert.equal(results[7].stratRole, 'M3', '5ème DPS orphelin de sa row → M3 (col 0)');
});

// --- Edge cases ---

test('benched / unassigned : pas de stratRole', () => {
  const results = [
    r('A', 'tank'), bench('B'), r('C', 'heal'),
    bench('D'), r('E', 'melee')
  ];
  assignStratRoles(results, 'raid8');
  assert.equal(results[0].stratRole, 'T', 'seul tank assigné → T');
  assert.equal(results[1].stratRole, undefined, 'pas de label sur benched');
  assert.equal(results[2].stratRole, 'H');
  assert.equal(results[3].stratRole, undefined);
  assert.equal(results[4].stratRole, 'M1');
});

test('contentType ignoré → mapping inchangé', () => {
  // Le contentType n'influence plus le mapping (purement positionnel)
  const results = [
    r('A', 'tank'),
    r('M1pl', 'melee'), r('R1pl', 'ranged')
  ];
  assignStratRoles(results, 'mystery-content');
  assert.equal(results[0].stratRole, 'T');
  assert.equal(results[1].stratRole, 'M1');
  assert.equal(results[2].stratRole, 'R1');
});

test('roster vide → no-op', () => {
  assert.deepEqual(assignStratRoles([], 'raid8'), []);
});

test('Array null/undefined → renvoie tel quel', () => {
  assert.equal(assignStratRoles(null, 'raid8'), null);
  assert.equal(assignStratRoles(undefined, 'raid8'), undefined);
});

// --- reorderResultsForDpsLayout ---

test('reorder : 2 mêlées + 2 autres → mêlées en col 0, autres en col 1', () => {
  // Solver order arbitraire : [caster, melee, ranged, melee]
  // Après reorder : [melee, caster, melee, ranged]
  const results = [
    r('T1', 'tank'), r('T2', 'tank'), r('H1', 'heal'), r('H2', 'heal'),
    r('C', 'caster'),
    r('M1', 'melee'),
    r('R', 'ranged'),
    r('M2', 'melee')
  ];
  const out = reorderResultsForDpsLayout(results);
  // Les DPS aux mêmes index (4,5,6,7), réorganisés
  assert.equal(out[4].role, 'melee', 'M1 slot = première mêlée');
  assert.equal(out[5].role, 'caster', 'R1 slot = première non-mêlée');
  assert.equal(out[6].role, 'melee', 'M2 slot = deuxième mêlée');
  assert.equal(out[7].role, 'ranged', 'R2 slot = deuxième non-mêlée');
});

test('reorder : 3 mêlées + 1 autre → 2 mêlées en M, 1 mêlée en R + 1 autre', () => {
  const results = [
    r('M1', 'melee'), r('M2', 'melee'), r('M3', 'melee'),
    r('C', 'caster')
  ];
  const out = reorderResultsForDpsLayout(results);
  // i=0 (M): mêlée. i=1 (R): autre. i=2 (M): mêlée. i=3 (R): mêlée (fallback, plus d'autres).
  assert.equal(out[0].name, 'M1');
  assert.equal(out[1].name, 'C');
  assert.equal(out[2].name, 'M2');
  assert.equal(out[3].name, 'M3', 'mêlée résiduelle en R2');
});

test('reorder : seulement des non-mêlées → ordre original préservé', () => {
  const results = [
    r('R', 'ranged'), r('C1', 'caster'), r('C2', 'caster')
  ];
  const out = reorderResultsForDpsLayout(results);
  // Pas de mêlées, tous les positions M et R sont remplies par des non-mêlées
  // dans l'ordre où elles arrivent.
  assert.equal(out[0].name, 'R');
  assert.equal(out[1].name, 'C1');
  assert.equal(out[2].name, 'C2');
});

test('reorder : couplé à assignStratRoles → labels matchent les rôles', () => {
  // Cas typique : solver donne [caster, melee, melee]. Reorder puis labels
  // donnent M1=melee, R1=caster, M2=melee.
  const cas = r('Onyxis', 'caster'); cas.jobId = 'RDM';
  const me1 = r('Sionra', 'melee');  me1.jobId = 'VPR';
  const me2 = r('Silaron', 'melee'); me2.jobId = 'DRG';
  const results = [r('T', 'tank'), r('H', 'heal'), cas, me1, me2];

  const reordered = reorderResultsForDpsLayout(results);
  assignStratRoles(reordered, 'raid8');

  assert.equal(reordered[2].name, 'Sionra', 'M1 = première mêlée (pas le caster)');
  assert.equal(reordered[2].stratRole, 'M1');
  assert.equal(reordered[3].name, 'Onyxis', 'R1 = caster');
  assert.equal(reordered[3].stratRole, 'R1');
  assert.equal(reordered[4].name, 'Silaron', 'M2 = deuxième mêlée');
  assert.equal(reordered[4].stratRole, 'M2');
});

test('reorder : roster sans DPS → renvoyé inchangé', () => {
  const results = [r('T', 'tank'), r('H', 'heal'), bench('B')];
  const out = reorderResultsForDpsLayout(results);
  assert.deepEqual(out, results);
});

test('reorder : null/undefined → renvoie tel quel', () => {
  assert.equal(reorderResultsForDpsLayout(null), null);
  assert.equal(reorderResultsForDpsLayout(undefined), undefined);
});
