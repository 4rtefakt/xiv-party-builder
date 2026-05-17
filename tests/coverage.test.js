// Tests pour lib/coverage.js — analyse des gaps de rôles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getRoleRequirements, analyzeCoverage, PRIMARY_DEPTH } from '../lib/coverage.js';

function P(name, prefs, opts = {}) {
  return { name, preferences: prefs, presence: opts.presence || 'in' };
}

// ---------- getRoleRequirements ----------

test('getRoleRequirements dungeon unified = 1T + 1H + 2 flex_dps', () => {
  const r = getRoleRequirements('dungeon', 'unified');
  assert.equal(r.tank, 1);
  assert.equal(r.heal, 1);
  assert.equal(r.flex_dps, 2);
  assert.equal(r.melee, 0);
});

test('getRoleRequirements raid8 split = 2T + 2H + 2 melee + 2 distance', () => {
  const r = getRoleRequirements('raid8', 'split');
  assert.equal(r.tank, 2);
  assert.equal(r.heal, 2);
  assert.equal(r.melee, 2);
  assert.equal(r.distance, 2);
});

test('getRoleRequirements raid24 = 3T + 6H + 15 DPS (multiplié par alliances)', () => {
  const r = getRoleRequirements('raid24', 'unified');
  assert.equal(r.tank, 3);
  assert.equal(r.heal, 6);
  assert.equal(r.flex_dps, 15);
});

test('getRoleRequirements raid24chaotic = 6T + 6H + 12 DPS', () => {
  const r = getRoleRequirements('raid24chaotic', 'unified');
  assert.equal(r.tank, 6);
  assert.equal(r.heal, 6);
  assert.equal(r.flex_dps, 12);
});

// ---------- analyzeCoverage ----------

test('analyzeCoverage : roster vide → gaps pour chaque rôle requis', () => {
  const r = analyzeCoverage([], 'raid8', 'unified');
  assert.equal(r.coverage.tank, 0);
  // raid8 unified : 2T + 2H + 4 flex_dps. Gaps doivent inclure tank, heal,
  // flex_dps (mais pas melee/distance/caster qui sont 0 requis en unified).
  const roles = r.gaps.map(g => g.role).sort();
  assert.deepEqual(roles, ['flex_dps', 'heal', 'tank']);
});

test('analyzeCoverage : roster qui couvre tout → 0 gaps', () => {
  const players = [
    P('T1', ['PLD']), P('T2', ['WAR']),
    P('H1', ['WHM']), P('H2', ['SCH']),
    P('M1', ['SAM']), P('M2', ['MNK']),
    P('R1', ['BRD']), P('C1', ['BLM'])
  ];
  const r = analyzeCoverage(players, 'raid8', 'unified');
  assert.deepEqual(r.gaps, []);
});

test('analyzeCoverage : joueurs absents (out) sont exclus', () => {
  const players = [
    P('T1', ['PLD'], { presence: 'out' }),  // absent
    P('H1', ['WHM']),
    P('M1', ['SAM']),
    P('M2', ['MNK']),
    P('M3', ['BRD']),
    P('M4', ['BLM'])
  ];
  const r = analyzeCoverage(players, 'raid8', 'unified');
  // Tank manquant car T1 absent
  assert.ok(r.gaps.some(g => g.role === 'tank'));
  assert.equal(r.playersWithName.length, 5);
});

test('analyzeCoverage : profondeur PRIMARY_DEPTH respectée (top-2 prefs comptent)', () => {
  // Un joueur avec PLD en 1er + WHM en 2e couvre tank ET heal.
  const players = [
    P('Versatile1', ['PLD', 'WHM', 'SAM']),
    P('Versatile2', ['WAR', 'SCH', 'MNK']),
    // Compléter pour ne pas avoir des manques DPS
    P('M1', ['SAM']),
    P('M2', ['MNK']),
    P('M3', ['BRD']),
    P('M4', ['BLM'])
  ];
  const r = analyzeCoverage(players, 'raid8', 'unified');
  // Coverage tank = 2 (Versatile1 + Versatile2 ont tank en top-2)
  assert.equal(r.coverage.tank, 2);
  // Coverage heal = 2 (Versatile1 + Versatile2 ont heal en top-2)
  assert.equal(r.coverage.heal, 2);
  assert.deepEqual(r.gaps, []);
});

test('analyzeCoverage : prefs au-delà de PRIMARY_DEPTH ne comptent pas', () => {
  // PLD en 3e position : ne compte PAS pour la couverture tank
  const players = [
    P('NotReallyTank', ['SAM', 'MNK', 'PLD']),
    P('H1', ['WHM']),
    P('M1', ['DRG']),
    P('M2', ['BLM'])
  ];
  const r = analyzeCoverage(players, 'dungeon', 'unified');
  // Tank ressort comme gap car PLD est trop bas dans les prefs de NotReallyTank
  assert.ok(r.gaps.some(g => g.role === 'tank'));
});

test('analyzeCoverage : bannedJobs sont filtrés des prefs avant analyse', () => {
  // PLD banni : NotReallyTank ne couvre plus tank
  const players = [P('NotReallyTank', ['PLD'])];
  const r = analyzeCoverage(players, 'dungeon', 'unified', ['PLD']);
  // Tank gap toujours présent car PLD filtré → 0 prefs effectives
  assert.equal(r.coverage.tank, 0);
  assert.equal(r.playersWithPrefs.length, 0);
});

test('analyzeCoverage raid24chaotic : reqs.tank=6 et gap calculé correctement', () => {
  // 3 tanks dispo → gap = 3
  const players = [P('T1', ['PLD']), P('T2', ['WAR']), P('T3', ['DRK'])];
  const r = analyzeCoverage(players, 'raid24chaotic', 'unified');
  const tankGap = r.gaps.find(g => g.role === 'tank');
  assert.ok(tankGap);
  assert.equal(tankGap.missing, 3);
});

test('PRIMARY_DEPTH est exporté pour cohérence avec le front', () => {
  assert.equal(typeof PRIMARY_DEPTH, 'number');
  assert.ok(PRIMARY_DEPTH >= 1);
});
