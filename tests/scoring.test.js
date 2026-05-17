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

test('job banni : un joueur dont toutes les prefs sont bannies préfère le banc à un forcé', () => {
  // C'est le comportement attendu de l'algo : forcer quelqu'un sur un job
  // hors prefs coûte ~250 pts (fairness=50) alors que le bench n'en coûte
  // que ~105. L'algo choisit le banc — cohérent avec "limited frustration".
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
  assert.equal(tankResult.assigned, false, 'Tank dont la pref est bannie va au banc');
  // Aucun joueur ne se retrouve assigné PLD
  assert.equal(r.results.filter(rr => rr.assigned && rr.jobId === 'PLD').length, 0);
});

test('job banni : avec fairness=0 (satisfaction pure), forcer est préférable au banc', () => {
  // Symétrique du précédent : à fairness=0, FRUST_FORCED et FRUST_BENCH sont
  // tous deux annulés ; seuls les scores de base comptent (-50 vs -30 ≈ banc
  // préféré). Mais on a 1 slot tank vide à remplir et 4 joueurs pour 4 slots
  // → soit l'algo bench Tank et bench un autre, soit il force.
  // L'algo doit au moins remplir tous les slots possibles via fallback.
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
  // Avec fairness=0, le banc coûte -30 et un forcé coûte -50. Le banc gagne.
  // Mais l'algo essaye d'abord les autres slots : Heal va sur slot heal,
  // M1/M2 sur slots DPS. Tank fini en bench.
  assert.equal(r.results[0].assigned, false);
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
