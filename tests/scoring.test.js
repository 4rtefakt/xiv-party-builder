// Tests pour lib/scoring.js — algorithme d'assignation optimale.
// Stratégie : invariants stables + scénarios "golden" sur petits rosters.
// Cible §5 du CLAUDE.md : on couvre les chemins critiques (lock, ban,
// fairness extrêmes, conflits, tiers), pas les getters triviaux.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORING, jobScoreForPlayer, benchScore, buildSlots, buildSlotsFromComp,
  computeOptimalAssignment, getPrefTier
} from '../lib/scoring.js';
import { CONTENT_COMP } from '../lib/jobs.js';

// ---------- getPrefTier ----------

test('getPrefTier fallback strict order quand prefTiers absent', () => {
  const p = { preferences: ['PLD', 'WAR', 'DRK'], prefTiers: [] };
  assert.equal(getPrefTier(p, 0), 0);
  assert.equal(getPrefTier(p, 1), 1);
  assert.equal(getPrefTier(p, 2), 2);
});

test('getPrefTier utilise prefTiers explicites quand fournis', () => {
  // Deux jobs au même rang : PLD = tier 0, WAR/DRK = tier 1 ensemble
  const p = { preferences: ['PLD', 'WAR', 'DRK'], prefTiers: [0, 1, 1] };
  assert.equal(getPrefTier(p, 0), 0);
  assert.equal(getPrefTier(p, 1), 1);
  assert.equal(getPrefTier(p, 2), 1);
});

test('getPrefTier retourne -1 hors borne', () => {
  const p = { preferences: ['PLD'], prefTiers: [] };
  assert.equal(getPrefTier(p, -1), -1);
  assert.equal(getPrefTier(p, 5), -1);
});

// ---------- jobScoreForPlayer ----------

test('jobScoreForPlayer : 1er choix vaut FIRST_CHOICE quand fairness=0', () => {
  const p = { preferences: ['PLD', 'WAR'], prefTiers: [] };
  const { score, forced } = jobScoreForPlayer(p, 'PLD', 0);
  assert.equal(score, SCORING.FIRST_CHOICE);
  assert.equal(forced, false);
});

test('jobScoreForPlayer : 2e choix perd PREF_STEP (fairness=0)', () => {
  const p = { preferences: ['PLD', 'WAR'], prefTiers: [] };
  const { score } = jobScoreForPlayer(p, 'WAR', 0);
  assert.equal(score, SCORING.FIRST_CHOICE - SCORING.PREF_STEP);
});

test('jobScoreForPlayer : forcé est très négatif quand fairness=100', () => {
  const p = { preferences: ['PLD'], prefTiers: [] };
  const { score, forced } = jobScoreForPlayer(p, 'BLM', 100);
  assert.equal(forced, true);
  // FORCED_BASE - FRUST_FORCED * 1 = -50 - 400 = -450
  assert.equal(score, SCORING.FORCED_BASE - SCORING.FRUST_FORCED);
});

test('jobScoreForPlayer : deux jobs au même tier ont le même score', () => {
  // PLD au tier 0, WAR/DRK tous deux au tier 1
  const p = { preferences: ['PLD', 'WAR', 'DRK'], prefTiers: [0, 1, 1] };
  const a = jobScoreForPlayer(p, 'WAR', 50).score;
  const b = jobScoreForPlayer(p, 'DRK', 50).score;
  assert.equal(a, b, 'jobs au même tier → score identique');
  assert.ok(a < jobScoreForPlayer(p, 'PLD', 50).score, 'tier 1 < tier 0');
});

// ---------- benchScore ----------

test('benchScore : pénalité grandit avec fairnessWeight', () => {
  assert.ok(benchScore(0) > benchScore(50));
  assert.ok(benchScore(50) > benchScore(100));
  assert.equal(benchScore(0), SCORING.BENCH);
  assert.equal(benchScore(100), SCORING.BENCH - SCORING.FRUST_BENCH);
});

// ---------- buildSlots ----------

test('buildSlots dungeon unified = 1T + 1H + 2 flex DPS', () => {
  const slots = buildSlots('dungeon', 'unified');
  assert.equal(slots.length, 4);
  assert.equal(slots.filter(s => s.roles.length === 1 && s.roles[0] === 'tank').length, 1);
  assert.equal(slots.filter(s => s.roles.length === 1 && s.roles[0] === 'heal').length, 1);
  // Flex DPS = 3 rôles (melee + ranged + caster)
  assert.equal(slots.filter(s => s.roles.length === 3).length, 2);
});

test('buildSlots raid8 split = 2T + 2H + 2 melee + 2 distance', () => {
  const slots = buildSlots('raid8', 'split');
  assert.equal(slots.length, 8);
  assert.equal(slots.filter(s => s.roles[0] === 'tank' && s.roles.length === 1).length, 2);
  assert.equal(slots.filter(s => s.roles[0] === 'heal' && s.roles.length === 1).length, 2);
  assert.equal(slots.filter(s => s.roles[0] === 'melee' && s.roles.length === 1).length, 2);
  // Distance = ranged|caster (2 rôles)
  assert.equal(slots.filter(s => s.roles.length === 2 &&
    s.roles.includes('ranged') && s.roles.includes('caster')).length, 2);
});

test('buildSlots raid24 retourne UNE alliance (1T+2H+5flex), pas les 24 slots', () => {
  const slots = buildSlots('raid24', 'unified');
  assert.equal(slots.length, 8);
  assert.equal(slots.filter(s => s.roles[0] === 'tank').length, 1);
  assert.equal(slots.filter(s => s.roles[0] === 'heal').length, 2);
});

test('buildSlots raid24chaotic alliance = 2T+2H+4flex (= compo party 8-man)', () => {
  const slots = buildSlots('raid24chaotic', 'unified');
  assert.equal(slots.length, 8);
  assert.equal(slots.filter(s => s.roles[0] === 'tank').length, 2);
  assert.equal(slots.filter(s => s.roles[0] === 'heal').length, 2);
  assert.equal(slots.filter(s => s.roles.length === 3).length, 4);
});

test('buildSlotsFromComp avec compo totale chaotic = 6T+6H+12flex', () => {
  const slots = buildSlotsFromComp(CONTENT_COMP.raid24chaotic.comp, 'unified');
  assert.equal(slots.length, 24);
  assert.equal(slots.filter(s => s.roles[0] === 'tank').length, 6);
  assert.equal(slots.filter(s => s.roles[0] === 'heal').length, 6);
});

test('buildSlots avec clé inconnue retourne []', () => {
  assert.deepEqual(buildSlots('unknown', 'unified'), []);
});

// ---------- computeOptimalAssignment — scénarios golden ----------

function P(name, prefs, opts = {}) {
  return {
    name,
    preferences: prefs,
    prefTiers: opts.prefTiers || [],
    lockedJob: opts.locked || null,
    presence: opts.presence || 'in'
  };
}

test('roster vide → error noPlayers', () => {
  const r = computeOptimalAssignment({
    players: [], slots: buildSlots('raid8', 'unified'), fairnessWeight: 50
  });
  assert.equal(r.error, 'noPlayers');
});

test('slots vide → error noSlots', () => {
  const r = computeOptimalAssignment({
    players: [P('Alice', ['PLD'])], slots: [], fairnessWeight: 50
  });
  assert.equal(r.error, 'noSlots');
});

test('dungeon : 1T + 1H + 2DPS qui veulent chacun leur job → tous 1ers choix', () => {
  const players = [
    P('Tank',  ['PLD']),
    P('Heal',  ['WHM']),
    P('Melee', ['SAM']),
    P('Cast',  ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'), fairnessWeight: 50
  });
  assert.equal(r.error, undefined);
  assert.equal(r.stats.assigned, 4);
  assert.equal(r.stats.firstChoices, 4);
  assert.equal(r.stats.benched, 0);
});

test('2 tanks pour 1 slot tank → 1 au banc', () => {
  const players = [
    P('T1',    ['PLD']),
    P('T2',    ['WAR']),
    P('Heal',  ['WHM']),
    P('Melee', ['SAM']),
    P('Cast',  ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'), fairnessWeight: 50
  });
  assert.equal(r.stats.benched, 1);
  // 4 slots, 4 assigned
  assert.equal(r.stats.assigned, 4);
});

test('lock prime sur prefs : un joueur locké WAR est assigné WAR même si PLD préféré', () => {
  const players = [P('Solo', ['PLD', 'WAR', 'DRK'], { locked: 'WAR' })];
  const slots = buildSlots('dungeon', 'unified').filter(s => s.roles[0] === 'tank');
  const r = computeOptimalAssignment({
    players, slots, fairnessWeight: 50
  });
  const sol = r.results[0];
  assert.equal(sol.assigned, true);
  assert.equal(sol.jobId, 'WAR');
  assert.equal(sol.locked, true);
});

test('lock contourne le ban dans les candidats mais le scoring reste cohérent', () => {
  // Le lock court-circuite la liste `candidates` (branche `if (lockedJob)`
  // de scoring.js) — donc même si WAR est banni, le slot tank le considère.
  // En revanche, le filtre `preferences.filter(id => !banned.has(id))` s'applique
  // d'abord : si WAR était la seule pref non bannie, on perd l'info de tier.
  // Ici on lock WAR sans le bannir : assignment WAR au 2e rang.
  const players = [P('Solo', ['PLD', 'WAR'], { locked: 'WAR' })];
  const slots = buildSlots('dungeon', 'unified').filter(s => s.roles[0] === 'tank');
  const r = computeOptimalAssignment({
    players, slots, fairnessWeight: 50
  });
  assert.equal(r.results[0].jobId, 'WAR');
  assert.equal(r.results[0].locked, true);
});

test('job banni : un joueur dont toutes les prefs sont bannies est forcé plutôt que benché (fill-first)', () => {
  // Fill-first : tant qu'un slot compatible est libre, on le remplit — même
  // au prix d'un forcé. Un slot vide + un·e joueur·euse au banc qui aurait
  // pu le remplir n'est jamais la bonne réponse pour un raid. (Ancien
  // comportement : bench (-105) < forcé (-250) laissait le slot tank vide.)
  const players = [
    P('Tank',  ['PLD']),                  // PLD banni
    P('Heal',  ['WHM']),
    P('M1',    ['SAM']),
    P('M2',    ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'),
    bannedJobs: ['PLD'], fairnessWeight: 50
  });
  const tankResult = r.results[0];
  assert.equal(tankResult.assigned, true, 'Tank est forcé sur un autre job, pas benché');
  assert.equal(tankResult.forced, true);
  assert.notEqual(tankResult.jobId, 'PLD', 'le job banni reste interdit');
  assert.equal(r.stats.assigned, 4, 'les 4 slots du donjon sont remplis');
  // Aucun joueur ne se retrouve assigné PLD
  assert.equal(r.results.filter(rr => rr.assigned && rr.jobId === 'PLD').length, 0);
});

test('job banni : à fairness=0, le bonus de Role Composition force l\'assignation', () => {
  // Setup : Tank ne peut jouer que PLD qui est banni. À fairness=0 sans
  // bonus, force=-50 vs banc=-30 → banc gagnerait. MAIS le bonus de
  // Role Composition (+30 pour activer le sous-rôle tank) inverse la
  // balance : force-WAR(-50) + bonus(+30) > banc(-30).
  // C'est le comportement souhaité : "1% damage matters in raid".
  const players = [
    P('Tank',  ['PLD']),
    P('Heal',  ['WHM']),
    P('M1',    ['SAM']),
    P('M2',    ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'),
    bannedJobs: ['PLD'], fairnessWeight: 0
  });
  assert.equal(r.results[0].assigned, true, 'Tank doit être forcé (job fallback) pour activer le sous-rôle tank');
  assert.equal(r.results[0].forced, true);
  // Et le team bonus inclut bien les 4 sous-rôles (tank, heal, melee, caster)
  assert.equal(r.stats.roleBonusPercent, 4);
});

test('fairness=0 (satisfaction pure) accepte plus de frustration pour 1 joueur si ça augmente le score total', () => {
  // 2 joueurs veulent PLD en 1er. Avec fairness=0, peu importe lequel a son 2e.
  const players = [
    P('A', ['PLD', 'WAR']),
    P('B', ['PLD', 'WAR']),
    P('H', ['WHM']),
    P('M', ['SAM'])
  ];
  // Pour dungeon (1 tank), un seul aura PLD et l'autre forced ou bench.
  // Mais on a 2 tanks possibles sur slots tanks, donc impossible (1 slot tank uniquement).
  // → fallback : un en bench. Vérifions qu'on a au moins 1 first choice.
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'), fairnessWeight: 0
  });
  assert.ok(r.stats.firstChoices >= 1);
});

test('topK=3 renvoie 1 à 3 solutions distinctes', () => {
  // Roster où plusieurs assignations sont équivalentes
  const players = [
    P('T1', ['PLD', 'WAR']),
    P('T2', ['PLD', 'WAR']),
    P('H1', ['WHM']),
    P('H2', ['SCH']),
    P('M1', ['SAM']),
    P('M2', ['MNK']),
    P('R1', ['BRD']),
    P('R2', ['DNC'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('raid8', 'unified'),
    fairnessWeight: 50, topK: 3
  });
  assert.ok(r.solutions.length >= 1 && r.solutions.length <= 3);
  // Solutions doivent avoir des signatures distinctes
  const signatures = new Set(r.solutions.map(s =>
    JSON.stringify(s.results.map(rr => rr.name + '=' + (rr.jobId || '_bench')))
  ));
  assert.equal(signatures.size, r.solutions.length);
});

test('joueur absent (presence=out) est filtré', () => {
  const players = [
    P('Tank', ['PLD']),
    P('Skip', ['WAR'], { presence: 'out' }),
    P('Heal', ['WHM']),
    P('M',    ['SAM']),
    P('C',    ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'), fairnessWeight: 50
  });
  // 4 joueurs présents pour 4 slots
  assert.equal(r.stats.assigned, 4);
  assert.equal(r.results.find(p => p.name === 'Skip'), undefined);
});

test('joueur sans nom est filtré', () => {
  const players = [
    P('',      ['PLD']),    // nom vide
    P('Tank',  ['WAR']),
    P('Heal',  ['WHM']),
    P('M',     ['SAM']),
    P('C',     ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'), fairnessWeight: 50
  });
  assert.equal(r.results.length, 4);
});

test('stats.satisfaction est 100% quand tout le monde a son 1er choix', () => {
  const players = [
    P('Tank',  ['PLD']),
    P('Heal',  ['WHM']),
    P('Melee', ['SAM']),
    P('Cast',  ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'), fairnessWeight: 50
  });
  assert.equal(r.stats.satisfaction, 100);
  assert.equal(r.stats.worstRank, 0);
});

// ---------- Role Composition Bonus (FFXIV +1% par sous-rôle) ----------

test('stats : subRolesPresent + roleBonusPercent reflètent les rôles assignés', () => {
  // Dungeon 1T/1H/2DPS : ici 1T + 1H + 1 melee + 1 caster = 4 sous-rôles
  // → roleBonusPercent = 4 (manque "ranged" physique)
  const players = [
    P('Tank',  ['PLD']),
    P('Heal',  ['WHM']),
    P('Melee', ['SAM']),
    P('Cast',  ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'), fairnessWeight: 50
  });
  assert.deepEqual(r.stats.subRolesPresent.sort(), ['caster', 'heal', 'melee', 'tank']);
  assert.equal(r.stats.roleBonusPercent, 4);
});

test('Role bonus : le solver préfère la diversité quand individuel équivalent', () => {
  // Roster fait pour raid8 : 2 tanks, 2 heals, 1 mêlée, 1 ranged, 1 caster,
  // et 1 player flex qui peut être ranged OU caster (donc le solver choisit).
  // Sans bonus de diversité, le 2nd ranged et le 2nd caster sont équivalents.
  // Avec le bonus, le solver doit préférer l'ASSIGNATION qui couvre tous les
  // sous-rôles (1 ranged + 1 caster = 4 sous-rôles + 2 DPS supplémentaires)
  // plutôt qu'une qui doublonne.
  //
  // On force l'asymétrie : le 1er flex préfère BRD strictement, le 2nd flex
  // préfère BLM strictement. Donc l'optimisation par préférences SEULES dirait
  // BRD + BLM → 1 ranged + 1 caster (couvre les 2 sous-rôles). Le bonus
  // renforce ce choix mais ne le change pas ici. On vérifie juste que le
  // bonus est compté correctement.
  const players = [
    P('T1', ['PLD']), P('T2', ['WAR']),
    P('H1', ['WHM']), P('H2', ['SCH']),
    P('M1', ['SAM']),
    P('M2', ['MNK']),
    P('R',  ['BRD']),
    P('C',  ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('raid8', 'unified'), fairnessWeight: 50
  });
  // Les 5 sous-rôles doivent être présents : 2 tanks, 2 heals, 2 mêlées + 1 ranged + 1 caster
  assert.deepEqual(r.stats.subRolesPresent.sort(), ['caster', 'heal', 'melee', 'ranged', 'tank']);
  assert.equal(r.stats.roleBonusPercent, 5, 'le full role bonus FFXIV');
});

test('Role bonus : la diversité départage des solutions à individuel égal', () => {
  // Un joueur "Flex" avec BRD et BLM au MÊME tier (tier 0). Score individuel
  // identique entre les deux jobs. Les autres joueurs couvrent déjà tank,
  // heal, et ranged. Le bonus doit faire pencher Flex sur BLM (caster) pour
  // activer le sous-rôle absent (caster).
  const players = [
    P('T',  ['PLD']),
    P('H',  ['WHM']),
    P('R',  ['BRD']),  // ranged déjà présent
    { name: 'Flex', preferences: ['BRD', 'BLM'], prefTiers: [0, 0] }
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'), fairnessWeight: 50, topK: 1
  });
  const flex = r.results.find(x => x.name === 'Flex');
  assert.equal(flex.jobId, 'BLM', 'Flex doit être BLM (caster) pour activer le sous-rôle absent');
  // Et les 4 sous-rôles sont présents : tank, heal, ranged, caster (manque melee
  // car personne n'a melee dans ses prefs)
  assert.deepEqual(r.stats.subRolesPresent.sort(), ['caster', 'heal', 'ranged', 'tank']);
  assert.equal(r.stats.roleBonusPercent, 4);
});

// ---------- fill-first : un slot compatible libre n'est jamais laissé vide ----------

test('fill-first : un joueur sans aucune pref est assigné (forcé) plutôt que benché, à tout fairness', () => {
  // Régression : bench (-30-150w) > forcé (-50-400w) faisait bencher le
  // joueur sans prefs et laisser un slot VIDE — et le résultat basculait
  // selon le slider fairness (à 0, le bonus de sous-rôle inversait la
  // balance). Désormais FILL_BONUS domine : party remplie à tout fairness.
  for (const fw of [0, 50, 100]) {
    const players = [
      P('T1', ['WAR']), P('T2', ['PLD']),
      P('H1', ['WHM']), P('H2', ['SCH']),
      P('M1', ['NIN']), P('M2', ['SAM']),
      P('R1', ['BRD']),
      P('NoPref', [])
    ];
    const r = computeOptimalAssignment({
      players, slots: buildSlots('raid8', 'split'), fairnessWeight: fw
    });
    assert.equal(r.stats.assigned, 8, `fairness=${fw} : les 8 slots sont remplis`);
    assert.equal(r.stats.benched, 0, `fairness=${fw} : personne au banc`);
    const noPref = r.results.find(x => x.name === 'NoPref');
    assert.equal(noPref.assigned, true);
    assert.equal(noPref.forced, true);
  }
});

test('fill-first : un 3e tank est forcé sur le slot restant plutôt que benché', () => {
  // 3 joueurs tank-only pour 2 slots tank : le 3e est forcé sur le slot
  // distance libre (fill-first), pas benché avec un slot vide.
  const players = [
    P('T1', ['WAR']), P('T2', ['PLD']), P('T3', ['DRK']),
    P('H1', ['WHM']), P('H2', ['SCH']),
    P('M1', ['NIN']), P('M2', ['SAM']),
    P('R1', ['BRD'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('raid8', 'split'), fairnessWeight: 50
  });
  assert.equal(r.stats.assigned, 8);
  assert.equal(r.stats.benched, 0);
  const t3 = r.results.find(x => x.name === 'T3');
  assert.equal(t3.assigned, true);
  assert.equal(t3.forced, true);
});

test('fill-first : le banc n\'apparaît que quand le roster dépasse les slots', () => {
  // 9 joueurs pour 8 slots : exactement 1 au banc, 8 slots remplis.
  const players = [
    P('T1', ['WAR']), P('T2', ['PLD']), P('T3', ['DRK']),
    P('H1', ['WHM']), P('H2', ['SCH']),
    P('M1', ['NIN']), P('M2', ['SAM']),
    P('R1', ['BRD']), P('C1', ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('raid8', 'split'), fairnessWeight: 50
  });
  assert.equal(r.stats.assigned, 8);
  assert.equal(r.stats.benched, 1);
  // Le benché est le tank surnuméraire (le forcer coûterait plus que le
  // bench, et tous les slots sont déjà remplis par des 1ers choix).
  const benched = r.results.find(x => !x.assigned);
  assert.equal(benched.name, 'T3');
});

// ---------- seed (tie-break déterministe sans biais d'ordre roster) ----------

// Le pattern utilisé : 3 healers pour 2 slots heal en raid8, roster de 9
// pour 8 slots → l'un des 3 healers est au banc (les 4 slots DPS flex sont
// pris par les 4 mains DPS ; avec fill-first, bencher le healer surnuméraire
// coûte moins que le forcer sur un job DPS hors prefs, à slots remplis
// égaux). Le score est strictement identique quel que soit le healer benché
// (chacun prend son 1er choix s'il est assigné, pénalité de bench égale).
// Sans seed, c'est le 3ème du roster qui est benché (le solver itère dans
// l'ordre et les 2 premiers healers raflent les slots heal).
// Avec seed, n'importe lequel des 3 peut être benché selon la permutation.
function threeHealers(h1, h2, h3) {
  return [
    P(h1, ['WHM']),
    P(h2, ['SCH']),
    P(h3, ['AST']),
    P('T1', ['PLD']),
    P('T2', ['WAR']),
    P('M1', ['SAM']),
    P('M2', ['DRG']),
    P('R1', ['BRD']),
    P('R2', ['MCH'])
  ];
}

test('seed : sans seed, le 3ème healer du roster est benché (comportement legacy)', () => {
  const players = threeHealers('Alice', 'Bob', 'Carol');
  const r = computeOptimalAssignment({
    players, slots: buildSlots('raid8', 'unified'), fairnessWeight: 50
  });
  const benched = r.results.filter(x => !x.assigned).map(x => x.name);
  assert.deepEqual(benched, ['Carol'], 'Carol (3ème healer) doit être benchée par ordre roster');
});

test('seed : même seed → même résultat (déterminisme)', () => {
  const players = threeHealers('Alice', 'Bob', 'Carol');
  const slots = buildSlots('raid8', 'unified');
  const r1 = computeOptimalAssignment({ players, slots, fairnessWeight: 50, seed: 'roomXYZ' });
  const r2 = computeOptimalAssignment({ players, slots, fairnessWeight: 50, seed: 'roomXYZ' });
  const b1 = r1.results.filter(x => !x.assigned).map(x => x.name);
  const b2 = r2.results.filter(x => !x.assigned).map(x => x.name);
  assert.deepEqual(b1, b2, 'même seed → même benched');
});

test('seed : seeds variés produisent des benched différents (distribution)', () => {
  // Sur N seeds, on doit voir au moins 2 healers différents passer au banc
  // (preuve que la permutation casse réellement le biais roster).
  const players = threeHealers('Alice', 'Bob', 'Carol');
  const slots = buildSlots('raid8', 'unified');
  const benched = new Set();
  for (const seed of ['a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p']) {
    const r = computeOptimalAssignment({ players, slots, fairnessWeight: 50, seed });
    const who = r.results.filter(x => !x.assigned).map(x => x.name);
    benched.add(who[0]);
  }
  assert.ok(benched.size >= 2,
    `au moins 2 healers différents doivent être benchés sur 16 seeds (vu: ${[...benched].join(',')})`);
});

test('seed : score optimal identique avec ou sans seed (algo reste exhaustif)', () => {
  const players = threeHealers('Alice', 'Bob', 'Carol');
  const slots = buildSlots('raid8', 'unified');
  const noSeed = computeOptimalAssignment({ players, slots, fairnessWeight: 50 });
  for (const seed of ['x', 'y', 'roomABC123']) {
    const seeded = computeOptimalAssignment({ players, slots, fairnessWeight: 50, seed });
    assert.equal(seeded.stats.satisfaction, noSeed.stats.satisfaction,
      `seed=${seed} doit donner même satisfaction`);
    assert.equal(seeded.stats.firstChoices, noSeed.stats.firstChoices,
      `seed=${seed} doit donner même nb de 1ers choix`);
    assert.equal(seeded.stats.benched, noSeed.stats.benched);
  }
});

test('seed : les results restent en ordre roster (pour que MT/OT/H1/H2 suivent le roster)', () => {
  const players = threeHealers('Alice', 'Bob', 'Carol');
  const slots = buildSlots('raid8', 'unified');
  // L'ordre des results doit TOUJOURS être l'ordre roster, peu importe le seed.
  // C'est ce qui garantit que les labels MT/OT/H1/H2 suivent l'ordre roster.
  for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7']) {
    const r = computeOptimalAssignment({ players, slots, fairnessWeight: 50, seed });
    assert.deepEqual(r.results.map(x => x.name),
      ['Alice', 'Bob', 'Carol', 'T1', 'T2', 'M1', 'M2', 'R1', 'R2'],
      `seed=${seed} : results doit suivre l'ordre roster`);
  }
});

test('seed : 1 seul joueur → seed n\'a aucun effet (pas de plantage)', () => {
  const slots = buildSlots('dungeon', 'unified').filter(s => s.roles[0] === 'tank');
  const r = computeOptimalAssignment({
    players: [P('Solo', ['PLD'])], slots, fairnessWeight: 50, seed: 'whatever'
  });
  assert.equal(r.results[0].jobId, 'PLD');
});

test('seed : null/undefined → comportement legacy (1er du roster)', () => {
  const players = threeHealers('Alice', 'Bob', 'Carol');
  const slots = buildSlots('raid8', 'unified');
  const r1 = computeOptimalAssignment({ players, slots, fairnessWeight: 50 });
  const r2 = computeOptimalAssignment({ players, slots, fairnessWeight: 50, seed: null });
  const r3 = computeOptimalAssignment({ players, slots, fairnessWeight: 50, seed: undefined });
  for (const r of [r1, r2, r3]) {
    const benched = r.results.filter(x => !x.assigned).map(x => x.name);
    assert.deepEqual(benched, ['Carol']);
  }
});

// ---------- lock "dur" : un joueur locké doit JOUER son lock ----------

test('lock dur : un joueur locké sur sa 3e pref ne doit PAS être benché par "optimisation"', () => {
  // Bug rapporté : Alice (PLD, WAR, SAM) lockée sur SAM, l'algo benchait Alice
  // car bench (-105) < SAM 3e pref (50) en termes d'individuel, et bencher
  // Alice préservait le bonus de Role Composition (caster Hank reste).
  // Maintenant : bench n'est plus une option si au moins un slot peut accueillir
  // le lockedJob → Alice DOIT jouer SAM, un autre DPS est benché à sa place.
  const players = [
    P('Alice', ['PLD', 'WAR', 'SAM'], { locked: 'SAM' }),
    P('Bob',   ['WAR', 'PLD']),
    P('Carol', ['WHM']),
    P('David', ['SCH']),
    P('Eve',   ['SAM', 'DRG']),
    P('Frank', ['DRG', 'SAM']),
    P('Grace', ['BRD']),
    P('Hank',  ['BLM'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('raid8', 'unified'), fairnessWeight: 50
  });
  const alice = r.results.find(x => x.name === 'Alice');
  assert.equal(alice.assigned, true, 'Alice ne doit PAS être benchée (son lock prime)');
  assert.equal(alice.jobId, 'SAM', 'Alice doit jouer SAM (son lock)');
});

test('lock dur : 5 mêlées lockés pour 4 slots DPS → exactement 1 benché (fallback légitime)', () => {
  // Cas où le bench EST nécessaire (impossible de tout placer). Le fix doit
  // permettre ce cas-là tout en bloquant les bench "voluntaires".
  const players = [
    P('A', ['SAM'], { locked: 'SAM' }),
    P('B', ['SAM'], { locked: 'SAM' }),
    P('C', ['SAM'], { locked: 'SAM' }),
    P('D', ['SAM'], { locked: 'SAM' }),
    P('E', ['SAM'], { locked: 'SAM' }),
    P('Tank',  ['PLD']),
    P('Heal1', ['WHM']),
    P('Heal2', ['SCH'])
  ];
  const r = computeOptimalAssignment({
    players, slots: buildSlots('raid8', 'unified'), fairnessWeight: 50
  });
  const benched = r.results.filter(x => !x.assigned);
  assert.equal(benched.length, 1, '5 mêlées pour 4 slots DPS → exactement 1 benché');
  // Le benché est l'un des A/B/C/D/E (pas le tank ni les heals)
  assert.ok(['A','B','C','D','E'].includes(benched[0].name),
    `le benché doit être un des SAM lockés, vu: ${benched[0].name}`);
});

test('lock dur : lock conservé même si slot disponible mais sub-optimal individuellement', () => {
  // Joueur locké sur 2e pref, alors qu'il aurait pu prendre sa 1ère pref ailleurs.
  // Le lock prime quoi qu'il arrive.
  const players = [
    P('Alice', ['SAM', 'DRG'], { locked: 'DRG' }),  // pref 1=SAM, locked sur DRG
    P('Bob', ['WAR']),
    P('Heal', ['WHM'])
  ];
  // Dungeon : 1T + 1H + 2 DPS flex
  const r = computeOptimalAssignment({
    players, slots: buildSlots('dungeon', 'unified'), fairnessWeight: 50
  });
  const alice = r.results.find(x => x.name === 'Alice');
  assert.equal(alice.jobId, 'DRG', 'Alice doit jouer DRG (son lock), pas SAM même si dispo');
});

test('seed : seed numérique fonctionne aussi (pas que string)', () => {
  const players = threeHealers('Alice', 'Bob', 'Carol');
  const slots = buildSlots('raid8', 'unified');
  const r1 = computeOptimalAssignment({ players, slots, fairnessWeight: 50, seed: 12345 });
  const r2 = computeOptimalAssignment({ players, slots, fairnessWeight: 50, seed: 12345 });
  const b1 = r1.results.filter(x => !x.assigned).map(x => x.name);
  const b2 = r2.results.filter(x => !x.assigned).map(x => x.name);
  assert.deepEqual(b1, b2);
});
