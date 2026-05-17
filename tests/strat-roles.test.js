// Tests pour lib/strat-roles.js — étiquetage MT/OT/H1/H2/M1/M2/R1/R2.
// Le mapping DPS est PUREMENT POSITIONNEL (selon sous-grille 2 col) :
//   col 0 (gauche) → M(row+1), col 1 (droite) → R(row+1)
// Donc dps[0] → M1, dps[1] → R1, dps[2] → M2, dps[3] → R2, etc.

import test from 'node:test';
import assert from 'node:assert/strict';
import { assignStratRoles, assignDpsGridPositions, getDpsLayout } from '../lib/strat-roles.js';

function r(name, role) { return { name, role, assigned: true }; }
function bench(name) { return { name, assigned: false }; }

// --- Tanks ---

test('tanks : 1 → MT (par défaut)', () => {
  const out = assignStratRoles([r('A', 'tank'), r('B', 'heal'), r('C', 'melee'), r('D', 'ranged')], 'dungeon');
  assert.equal(out[0].stratRole, 'MT');
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

test('heals : 1 → H1 (toujours numéroté)', () => {
  const out = assignStratRoles([r('A', 'heal')], 'dungeon');
  assert.equal(out[0].stratRole, 'H1');
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
  assert.equal(results[0].stratRole, 'MT', 'seul tank assigné → MT');
  assert.equal(results[1].stratRole, undefined, 'pas de label sur benched');
  assert.equal(results[2].stratRole, 'H1');
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
  assert.equal(results[0].stratRole, 'MT');
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

// --- assignDpsGridPositions ---

test('grid positions : 2 mêlées + 2 autres → toutes positions remplies dans l\'ordre M-R-M-R', () => {
  const m1 = r('M1', 'melee');
  const c1 = r('C1', 'caster');
  const m2 = r('M2', 'melee');
  const r1 = r('R1', 'ranged');
  // Order solver arbitraire
  const results = [r('T', 'tank'), c1, m1, r1, m2];
  assignDpsGridPositions(results, 4);
  // Phase 1 : i=0 M→m1 (1ère mêlée), i=1 R→c1 (1ère non-mêlée), i=2 M→m2, i=3 R→r1
  assert.equal(m1.gridPosition, 0);
  assert.equal(c1.gridPosition, 1);
  assert.equal(m2.gridPosition, 2);
  assert.equal(r1.gridPosition, 3);
});

test('grid positions : 1 mêlée + 2 non-mêlées → M2 vide (cas user)', () => {
  // Cas concret du screenshot : Silaron (DRG mêlée), Rhesh'a (DNC ranged),
  // Sionra (RDM caster). Layout attendu :
  //   M1=Silaron, R1=Rhesh'a, M2=VIDE, R2=Sionra
  const sil = r('Silaron', 'melee');
  const rhe = r('Rhesh\'a', 'ranged');
  const sio = r('Sionra', 'caster');
  const results = [r('T', 'tank'), r('H', 'heal'), sil, rhe, sio];
  assignDpsGridPositions(results, 4);
  assert.equal(sil.gridPosition, 0, 'Silaron mêlée → M1');
  assert.equal(rhe.gridPosition, 1, 'Rhesh\'a ranged → R1');
  assert.equal(sio.gridPosition, 3, 'Sionra caster → R2 (pas M2)');
});

test('grid positions : 3 mêlées + 1 non-mêlée → overflow mêlée en R2', () => {
  // 3 mêlées : remplissent M1, M2, et déborde en R2.
  // 1 non-mêlée : en R1.
  const m1 = r('M1', 'melee');
  const m2 = r('M2', 'melee');
  const m3 = r('M3', 'melee');
  const o = r('O', 'ranged');
  const results = [m1, m2, m3, o];
  assignDpsGridPositions(results, 4);
  assert.equal(m1.gridPosition, 0);
  assert.equal(o.gridPosition, 1);
  assert.equal(m2.gridPosition, 2);
  assert.equal(m3.gridPosition, 3, 'mêlée en excédent → R2 par spillover');
});

test('grid positions : 0 mêlée + 3 non-mêlées → 1 overflow en M', () => {
  // Symétrique : 3 non-mêlées remplissent R1 et R2, et 1 déborde en M1.
  const c = r('C', 'caster');
  const r1 = r('R1', 'ranged');
  const r2 = r('R2', 'ranged');
  const results = [c, r1, r2];
  assignDpsGridPositions(results, 4);
  // Phase 1 : R1=c, R2=r1 (M1 et M2 restent null par manque de mêlées)
  // Phase 2 : M1 vide → spillover r2 (non-mêlée restante)
  assert.equal(c.gridPosition, 1, 'caster → R1');
  assert.equal(r1.gridPosition, 3, 'ranged → R2');
  assert.equal(r2.gridPosition, 0, 'ranged excédentaire → M1 par spillover');
});

test('grid positions : 0 mêlée + 2 non-mêlées (dungeon) → R1 + M1 (spillover)', () => {
  // Dungeon : slotCount = 2 (1 M, 1 R). 2 non-mêlées.
  const c = r('C', 'caster');
  const r1 = r('R', 'ranged');
  const results = [c, r1];
  assignDpsGridPositions(results, 2);
  assert.equal(c.gridPosition, 1, 'caster → R1');
  assert.equal(r1.gridPosition, 0, 'ranged excédentaire → M1 par spillover');
});

test('grid positions : couplé à assignStratRoles → labels matchent les positions', () => {
  // Cas user concret reproduit
  const sil = r('Silaron', 'melee');
  const rhe = r('Rhesh\'a', 'ranged');
  const sio = r('Sionra', 'caster');
  const results = [r('T', 'tank'), r('H', 'heal'), sil, rhe, sio];
  assignDpsGridPositions(results, 4);
  assignStratRoles(results, 'raid8');
  assert.equal(sil.stratRole, 'M1');
  assert.equal(rhe.stratRole, 'R1');
  assert.equal(sio.stratRole, 'R2', 'caster en pos 3 → R2 (pas M2)');
});

test('grid positions : sans DPS → no-op', () => {
  const results = [r('T', 'tank'), r('H', 'heal'), bench('B')];
  assignDpsGridPositions(results, 4);
  // Rien ne devrait avoir gridPosition
  results.forEach(r => assert.equal(r.gridPosition, undefined));
});

// --- getDpsLayout ---

test('getDpsLayout : 1 mêlée + 2 non-mêlées → layout [mel, oth, null, oth]', () => {
  const sil = r('Silaron', 'melee');
  const rhe = r('Rhesh\'a', 'ranged');
  const sio = r('Sionra', 'caster');
  const results = [r('T', 'tank'), r('H', 'heal'), sil, rhe, sio];
  assignDpsGridPositions(results, 4);
  const layout = getDpsLayout(results, 4);
  assert.equal(layout.length, 4);
  assert.equal(layout[0], sil);
  assert.equal(layout[1], rhe);
  assert.equal(layout[2], null, 'M2 vide');
  assert.equal(layout[3], sio);
});

test('getDpsLayout : sans gridPosition (fallback) → layout vide', () => {
  // Si on n'a pas appelé assignDpsGridPositions, les DPS n'ont pas de
  // gridPosition → layout reste tout null (on n'invente pas).
  const results = [r('T', 'tank'), r('M', 'melee')];
  const layout = getDpsLayout(results, 4);
  assert.deepEqual(layout, [null, null, null, null]);
});
