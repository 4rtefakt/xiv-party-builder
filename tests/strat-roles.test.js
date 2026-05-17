// Tests pour lib/strat-roles.js — étiquetage MT/OT/H1/H2/M1/M2/R1/R2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { assignStratRoles } from '../lib/strat-roles.js';

// Helper : un result minimal avec les champs utilisés par assignStratRoles.
function r(name, role) {
  return { name, role, assigned: true };
}
function bench(name) {
  return { name, assigned: false };
}

function roles(results) {
  return results.map(r => r.stratRole || null);
}

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

test('tanks : 3+ → T1, T2, T3 (raid24 chaotic-like si appelé en global)', () => {
  // Cas pathologique (raid24 par alliance = 1T ou 2T), mais on couvre quand même
  const results = [r('A', 'tank'), r('B', 'tank'), r('C', 'tank')];
  assignStratRoles(results, 'raid24chaotic');
  // raid24chaotic est défini comme 2T/2H/4DPS, mais ici on a 3 tanks
  // → fallback T1/T2/T3
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

// --- DPS raid8 (balance 2M + 2R) ---

test('raid8 DPS : 2 melees + 2 others (caster/ranged) → M1/M2/R1/R2 naturel', () => {
  const results = [
    r('A', 'tank'), r('B', 'tank'), r('C', 'heal'), r('D', 'heal'),
    r('M1pl', 'melee'), r('M2pl', 'melee'),
    r('Rpl', 'ranged'), r('Cpl', 'caster')
  ];
  assignStratRoles(results, 'raid8');
  assert.equal(results[4].stratRole, 'M1');
  assert.equal(results[5].stratRole, 'M2');
  assert.equal(results[6].stratRole, 'R1');
  assert.equal(results[7].stratRole, 'R2');
});

test('raid8 DPS : 1 melee + 3 ranged → 1 ranged borrowe M2', () => {
  const results = [
    r('A', 'tank'), r('B', 'tank'), r('C', 'heal'), r('D', 'heal'),
    r('Mpl', 'melee'),
    r('R1pl', 'ranged'), r('R2pl', 'ranged'), r('Cpl', 'caster')
  ];
  assignStratRoles(results, 'raid8');
  assert.equal(results[4].stratRole, 'M1', 'le melee prend M1');
  assert.equal(results[5].stratRole, 'M2', 'le 1er ranged borrowe M2');
  assert.equal(results[6].stratRole, 'R1');
  assert.equal(results[7].stratRole, 'R2');
});

test('raid8 DPS : 0 melee + 4 ranged → 2 rangeds borrowent M1/M2', () => {
  const results = [
    r('A', 'tank'), r('B', 'tank'), r('C', 'heal'), r('D', 'heal'),
    r('Rpl1', 'ranged'), r('Rpl2', 'caster'), r('Rpl3', 'ranged'), r('Rpl4', 'caster')
  ];
  assignStratRoles(results, 'raid8');
  assert.equal(results[4].stratRole, 'M1');
  assert.equal(results[5].stratRole, 'M2');
  assert.equal(results[6].stratRole, 'R1');
  assert.equal(results[7].stratRole, 'R2');
});

test('raid8 DPS : 3 melees + 1 ranged → 1 melee borrowe R1', () => {
  const results = [
    r('A', 'tank'), r('B', 'tank'), r('C', 'heal'), r('D', 'heal'),
    r('Mpl1', 'melee'), r('Mpl2', 'melee'), r('Mpl3', 'melee'),
    r('Rpl', 'ranged')
  ];
  assignStratRoles(results, 'raid8');
  assert.equal(results[4].stratRole, 'M1');
  assert.equal(results[5].stratRole, 'M2');
  // Ordre : les rangeds vont en R1 d'abord, puis les melees résiduels en R2
  assert.equal(results[6].stratRole, 'R2', 'le 3ᵉ melee qui déborde → R2');
  assert.equal(results[7].stratRole, 'R1', 'le ranged → R1 (priorité naturel)');
});

test('raid8 DPS : 4 melees + 0 ranged → 2 melees borrowent R1/R2', () => {
  const results = [
    r('A', 'tank'), r('B', 'tank'), r('C', 'heal'), r('D', 'heal'),
    r('Mpl1', 'melee'), r('Mpl2', 'melee'), r('Mpl3', 'melee'), r('Mpl4', 'melee')
  ];
  assignStratRoles(results, 'raid8');
  assert.equal(results[4].stratRole, 'M1');
  assert.equal(results[5].stratRole, 'M2');
  assert.equal(results[6].stratRole, 'R1');
  assert.equal(results[7].stratRole, 'R2');
});

// --- DPS dungeon (balance 1M + 1R) ---

test('dungeon DPS : 1 melee + 1 caster → M1, R1', () => {
  const results = [
    r('T', 'tank'), r('H', 'heal'),
    r('M', 'melee'), r('C', 'caster')
  ];
  assignStratRoles(results, 'dungeon');
  assert.equal(results[2].stratRole, 'M1');
  assert.equal(results[3].stratRole, 'R1');
});

test('dungeon DPS : 2 melees → 1 borrowe R1', () => {
  const results = [
    r('T', 'tank'), r('H', 'heal'),
    r('M1pl', 'melee'), r('M2pl', 'melee')
  ];
  assignStratRoles(results, 'dungeon');
  assert.equal(results[2].stratRole, 'M1');
  assert.equal(results[3].stratRole, 'R1', 'le 2ᵉ melee déborde sur R1');
});

test('dungeon DPS : 2 rangeds → 1 borrowe M1', () => {
  const results = [
    r('T', 'tank'), r('H', 'heal'),
    r('R', 'ranged'), r('C', 'caster')
  ];
  assignStratRoles(results, 'dungeon');
  assert.equal(results[2].stratRole, 'M1', 'le 1er ranged borrowe M1');
  assert.equal(results[3].stratRole, 'R1');
});

// --- DPS raid24 standard (1T/2H/5DPS, numérotation naturelle) ---

test('raid24 alliance : 2 melees + 3 others → M1/M2 + R1/R2/R3', () => {
  const results = [
    r('T', 'tank'), r('H1', 'heal'), r('H2', 'heal'),
    r('M1pl', 'melee'), r('M2pl', 'melee'),
    r('R1pl', 'ranged'), r('R2pl', 'caster'), r('R3pl', 'ranged')
  ];
  assignStratRoles(results, 'raid24');
  assert.equal(results[0].stratRole, 'T');
  assert.equal(results[1].stratRole, 'H1');
  assert.equal(results[2].stratRole, 'H2');
  assert.equal(results[3].stratRole, 'M1');
  assert.equal(results[4].stratRole, 'M2');
  assert.equal(results[5].stratRole, 'R1');
  assert.equal(results[6].stratRole, 'R2');
  assert.equal(results[7].stratRole, 'R3');
});

test('raid24 alliance : 1 melee + 4 others → M1 + R1..R4 (pas de borrowing)', () => {
  const results = [
    r('T', 'tank'), r('H1', 'heal'), r('H2', 'heal'),
    r('Mpl', 'melee'),
    r('R1pl', 'ranged'), r('R2pl', 'caster'), r('R3pl', 'ranged'), r('R4pl', 'caster')
  ];
  assignStratRoles(results, 'raid24');
  assert.equal(results[3].stratRole, 'M1');
  assert.equal(results[4].stratRole, 'R1');
  assert.equal(results[5].stratRole, 'R2');
  assert.equal(results[6].stratRole, 'R3');
  assert.equal(results[7].stratRole, 'R4');
});

// --- Edge cases ---

test('benched / unassigned : pas de stratRole', () => {
  // 1 tank assigné + 1 benched : tanks.length === 1 → label "T" (pas "MT"
  // qui suppose 2 tanks assignés). Le benched reste sans stratRole.
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

test('contentType inconnu → fallback "natural" pour les DPS', () => {
  const results = [
    r('A', 'tank'),
    r('M1pl', 'melee'), r('R1pl', 'ranged')
  ];
  assignStratRoles(results, 'mystery-content');
  assert.equal(results[0].stratRole, 'T');
  assert.equal(results[1].stratRole, 'M1');
  assert.equal(results[2].stratRole, 'R1');
});

test('roster vide → no-op (pas de throw)', () => {
  const r = assignStratRoles([], 'raid8');
  assert.deepEqual(r, []);
});

test('Array null/undefined → renvoie tel quel', () => {
  assert.equal(assignStratRoles(null, 'raid8'), null);
  assert.equal(assignStratRoles(undefined, 'raid8'), undefined);
});
