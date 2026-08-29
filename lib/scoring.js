// Algorithme d'assignation optimale joueur·euse → job.
// Backtracking avec branch & bound + collecte top-K solutions distinctes.
//
// Pur : ne lit aucun état global. Toutes les entrées passent par les args.
// Source de vérité unique pour le front (index.html) et l'OG worker.

import { JOB_BY_ID, JOBS_BY_ROLE, CONTENT_COMP } from './jobs.js';

export const SCORING = {
  FIRST_CHOICE: 100,
  PREF_STEP: 10,
  FORCED_BASE: -50,
  BENCH: -30,
  // Pénalités de frustration (multipliées par fairnessWeight/100)
  FRUST_PER_RANK: 30,    // chaque rang en dessous du 1er coûte ça
  FRUST_FORCED: 400,     // bonus de pénalité si vraiment forcé
  FRUST_BENCH: 150,      // bonus si benché
  // Bonus de "Role Composition" FFXIV : +1% de dégâts par sous-rôle
  // (tank, heal, melee, ranged physique, caster) présent dans la party.
  // Modélisé ici comme +N pts au score TOTAL de la team par sous-rôle
  // distinct présent (max = 5 sous-rôles).
  //
  // Tradeoff : à 10 pts (= 1 rang à fairness=0) c'était trop faible, le
  // solver ne sacrifiait jamais une 1ʳᵉ pref pour activer un sous-rôle.
  // À 30 pts (= 1 vrai rank shift à fairness=50, ou 3 à fairness=0), le
  // solver accepte qu'un joueur prenne son 2ᵉ choix pour qu'un caster
  // soit présent — ce qui matche l'intuition "1% c'est BIG en raid". À
  // fairness=100 (anti-frustration max), 30 pts < cost d'un rank (40),
  // donc les vraies préférences restent prioritaires.
  SUBROLE_BONUS: 30,
  // Bonus "fill-first" ajouté à CHAQUE assignation (vs bench) dans le solver.
  // Assez grand pour dominer strictement toute combinaison de pénalités de
  // préférence/frustration (pire swing par joueur ≈ 550, × 32 joueurs max
  // ≈ 17600) : le solver maximise D'ABORD le nombre de slots remplis, PUIS
  // optimise les préférences. Sans ça, bench (-30) > forcé (-50) faisait
  // laisser un slot VIDE avec un·e joueur·euse au banc qui aurait pu le
  // remplir — et le comportement basculait selon le slider fairness.
  // Un·e joueur·euse n'est donc benché·e que s'il n'existe VRAIMENT aucun
  // slot compatible libre (roster > taille du contenu, lock incompatible).
  FILL_BONUS: 100000
};

// Les 5 sous-rôles qui contribuent au bonus de Role Composition.
// Ordre arbitraire mais stable pour les tests.
const SUBROLES = ['tank', 'heal', 'melee', 'ranged', 'caster'];
const MAX_SUBROLE_BONUS = SUBROLES.length * SCORING.SUBROLE_BONUS;

// ---- Tie-break random stable (seed = room id) ----------------------------
// Quand plusieurs assignments ont le même score (ex: deux joueurs·euses avec
// les mêmes prefs sur deux slots équivalents), l'algo retient le premier
// rencontré, ce qui par défaut favorise le 1er du roster. Pour éviter cet
// effet de bord, on permute l'ordre d'itération de façon déterministe avec
// un PRNG seedé. Conséquence : même room → même résultat (OG cache, partage,
// alternatives top-K restent cohérents), mais l'ordre du roster n'a plus
// d'impact sur les tie-breaks. Les labels strat (MT/OT/H1/H2/M1/M2) suivent
// toujours l'ordre roster car on remappe l'assignment AVANT de construire
// les results.

// FNV-1a 32-bit. Pur, suffisant pour seeder un PRNG.
function hashString(s) {
  let h = 2166136261 >>> 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 : PRNG 32-bit, déterministe à partir d'un entier de seed.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates avec PRNG seedé. Retourne une copie ; ne mute pas `arr`.
function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Tier effectif d'un job dans les prefs d'un·e joueur·euse :
// `prefTiers` (parallèle à `preferences`) permet à plusieurs jobs de partager
// le même rang. Quand absent ou mal formé, on retombe sur l'index strict.
export function getPrefTier(player, idx) {
  if (idx < 0 || idx >= player.preferences.length) return -1;
  if (player.prefTiers && player.prefTiers.length === player.preferences.length &&
      typeof player.prefTiers[idx] === 'number') {
    return player.prefTiers[idx];
  }
  return idx;
}

export function jobScoreForPlayer(player, jobId, fairnessWeight) {
  const idx = player.preferences.indexOf(jobId);
  const w = fairnessWeight / 100;
  if (idx === -1) {
    const baseScore = SCORING.FORCED_BASE;
    const frustration = SCORING.FRUST_FORCED * w;
    return { score: baseScore - frustration, forced: true, rank: -1 };
  }
  const tier = getPrefTier(player, idx);
  const baseScore = SCORING.FIRST_CHOICE - tier * SCORING.PREF_STEP;
  const frustration = tier * SCORING.FRUST_PER_RANK * w;
  return { score: baseScore - frustration, forced: false, rank: tier };
}

export function benchScore(fairnessWeight) {
  const w = fairnessWeight / 100;
  return SCORING.BENCH - SCORING.FRUST_BENCH * w;
}

// Construit des slots à partir d'une compo arbitraire { tank, heal, dps }.
// Utile pour générer la party complète (OG worker, raid24 vue d'ensemble)
// par opposition à `buildSlots` qui choisit allianceComp pour les contenus
// segmentés en alliances.
export function buildSlotsFromComp(comp, dpsMode) {
  const slots = [];
  for (let i = 0; i < comp.tank; i++) slots.push({ roles: ['tank'] });
  for (let i = 0; i < comp.heal; i++) slots.push({ roles: ['heal'] });
  const dpsCount = comp.dps;
  if (dpsMode === 'unified') {
    for (let i = 0; i < dpsCount; i++) {
      slots.push({ roles: ['melee', 'ranged', 'caster'] });
    }
  } else {
    const melee = Math.ceil(dpsCount / 2);
    const distance = dpsCount - melee;
    for (let i = 0; i < melee; i++)    slots.push({ roles: ['melee'] });
    for (let i = 0; i < distance; i++) slots.push({ roles: ['ranged', 'caster'] });
  }
  return slots;
}

// Construit la liste des slots d'UNE alliance (raid24 / chaotic) ou de la
// party entière (dungeon / raid8). Caller responsable d'itérer sur les
// alliances pour les contenus alliancés.
export function buildSlots(contentKey, dpsMode) {
  const base = CONTENT_COMP[contentKey];
  if (!base) return [];
  return buildSlotsFromComp(base.allianceComp || base.comp, dpsMode);
}

// Calcule l'assignation optimale. Pur.
//
// args :
//   players       : [{ name, preferences: [jobId], prefTiers?: [int],
//                     lockedJob?: jobId, presence?: 'in'|'maybe'|'out' }]
//   slots         : tableau de { roles: [string] } (utilise buildSlots)
//   bannedJobs    : Set<jobId> | jobId[] | undefined
//   fairnessWeight: 0..100 (0 = full satisfaction, 100 = full anti-frustration)
//   topK          : nb de solutions distinctes à retourner (défaut 1)
//   seed          : string|number|null — quand fourni, permute l'ordre
//                   d'itération de l'algo de façon déterministe pour casser
//                   les égalités de score sans favoriser le 1er du roster.
//                   Le résultat reste stable pour un même seed (ex: room id).
//                   Les results renvoyés restent en ordre roster.
//
// retour : { solutions: [{ results, stats }], fairnessWeight } ou { error }
export function computeOptimalAssignment({
  players: rawPlayers,
  slots,
  bannedJobs,
  fairnessWeight = 50,
  topK = 1,
  seed = null
}) {
  const banned = bannedJobs instanceof Set
    ? bannedJobs
    : new Set(Array.isArray(bannedJobs) ? bannedJobs : []);

  const rosterPlayers = rawPlayers
    .filter(p => p && typeof p.name === 'string' && p.name.trim() !== '' && (p.presence || 'in') !== 'out')
    .map(p => ({
      ...p,
      preferences: (Array.isArray(p.preferences) ? p.preferences : []).filter(id => !banned.has(id))
    }));

  if (rosterPlayers.length === 0) return { error: 'noPlayers' };
  if (!Array.isArray(slots) || slots.length === 0) return { error: 'noSlots' };

  const n = rosterPlayers.length;

  // Permutation déterministe seed→shuffle pour casser les égalités de score
  // sans biais d'ordre roster. permutation[algoIdx] = rosterIdx.
  const permutation = (seed !== null && seed !== undefined && n > 1)
    ? seededShuffle(rosterPlayers.map((_, i) => i), hashString(seed))
    : rosterPlayers.map((_, i) => i);
  const players = permutation.map(i => rosterPlayers[i]);
  const m = slots.length;
  const benchSc = benchScore(fairnessWeight);

  // Upper bound par joueur : son meilleur score atteignable (FILL_BONUS
  // inclus pour les options d'assignation, cf. construction des options).
  const bestPerPlayer = players.map(p => {
    if (p.lockedJob) {
      const { score } = jobScoreForPlayer(p, p.lockedJob, fairnessWeight);
      return Math.max(score + SCORING.FILL_BONUS, benchSc);
    }
    if (p.preferences.length === 0) {
      const forcedScore = jobScoreForPlayer(p, '__none__', fairnessWeight).score;
      return Math.max(forcedScore + SCORING.FILL_BONUS, benchSc);
    }
    return SCORING.FIRST_CHOICE + SCORING.FILL_BONUS;
  });

  // Somme suffixe précalculée : upperBoundFrom est appelé à chaque nœud de
  // la récursion, O(1) au lieu de O(n).
  const boundSuffix = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) boundSuffix[i] = boundSuffix[i + 1] + bestPerPlayer[i];
  const upperBoundFrom = i => boundSuffix[i];

  const topSolutions = [];

  function signature(assignment) {
    return players.map((p, i) => {
      const a = assignment[i];
      return p.name + '=' + (a ? a.jobId : '_bench');
    }).join('|');
  }

  // Bonus de diversité de sous-rôles : +SUBROLE_BONUS par sous-rôle
  // distinct présent dans l'assignment. Calculé à la fin (assignment complet).
  // Modélise le buff de "Role Composition" du jeu (+1% dégâts par sous-rôle).
  function diversityBonus(assignment) {
    const present = new Set();
    for (const a of assignment) {
      if (!a) continue;
      const job = JOB_BY_ID[a.jobId];
      if (job) present.add(job.role);
    }
    return present.size * SCORING.SUBROLE_BONUS;
  }

  function tryAddSolution(individualScore, forcedCount, assignment) {
    const sig = signature(assignment);
    if (topSolutions.some(s => s.signature === sig)) return;
    const bonus = diversityBonus(assignment);
    const totalScore = individualScore + bonus;
    const solution = {
      score: totalScore,            // utilisé pour le tri (top-K)
      individualScore,
      diversityBonus: bonus,
      forcedCount,
      assignment: assignment.map(a => a ? { ...a } : null),
      signature: sig
    };
    topSolutions.push(solution);
    topSolutions.sort((a, b) => b.score - a.score);
    if (topSolutions.length > topK) topSolutions.length = topK;
  }

  const current = new Array(n).fill(null);
  const slotTaken = new Array(m).fill(false);

  function pruneThreshold() {
    if (topSolutions.length < topK) return -Infinity;
    return topSolutions[topSolutions.length - 1].score;
  }

  // Budget de nœuds : garde-fou contre l'explosion combinatoire (rosters
  // larges avec beaucoup de joueurs aux prefs identiques → symétrie joueur
  // que le pruning ne casse pas). Les options étant triées par score
  // décroissant, la descente greedy trouve une très bonne solution tôt ;
  // au-delà du budget on rend le meilleur trouvé au lieu de bloquer le
  // thread (front) ou d'exploser la limite CPU (OG worker). Déterministe :
  // même roster + même seed → même traversal → même résultat.
  const MAX_NODES = 2_000_000;
  let nodes = 0;

  function recurse(playerIdx, currentScore, forcedCount) {
    if (++nodes > MAX_NODES) return;
    // Bound corrigé : on ajoute le BONUS DE DIVERSITÉ MAX possible (5 sous-rôles)
    // sur les players restants. Surestime un peu (= pruning + permissif) mais
    // ne casse pas la correction. Une borne plus serrée tracker'ait les sous-
    // rôles déjà présents et soustrairait, mais le coût de tracking pendant
    // la récursion n'en vaut probablement pas la peine.
    if (currentScore + upperBoundFrom(playerIdx) + MAX_SUBROLE_BONUS <= pruneThreshold()) return;

    if (playerIdx === n) {
      tryAddSolution(currentScore, forcedCount, current);
      return;
    }

    const player = players[playerIdx];
    const options = [];
    const seen = new Set();
    // Brisure de symétrie : deux slots libres avec le MÊME set de rôles sont
    // interchangeables (le résultat final ne retient que slotRoles, jamais
    // l'index du slot, et les signatures top-K ignorent les slots). On ne
    // propose donc que le PREMIER slot libre de chaque classe d'équivalence.
    // Sans ça, les compos 24 slots (3 tanks, 6 heals, 8 distance…) font
    // exploser le backtracking en permutations de slots identiques à score
    // égal : >2 min dès ~16 joueurs — fatal pour l'OG worker (limite CPU).
    const seenRoleSets = new Set();

    for (let slotIdx = 0; slotIdx < m; slotIdx++) {
      if (slotTaken[slotIdx]) continue;
      const slot = slots[slotIdx];
      const roleKey = slot.roles.join(',');
      if (seenRoleSets.has(roleKey)) continue;
      seenRoleSets.add(roleKey);
      const candidates = new Set();
      const lockedJobId = player.lockedJob;
      const lockedJob = lockedJobId ? JOB_BY_ID[lockedJobId] : null;

      if (lockedJob) {
        // Lock : on ignore les bans (le verrou prime).
        if (slot.roles.includes(lockedJob.role)) candidates.add(lockedJob.id);
      } else {
        for (const role of slot.roles) {
          for (const job of JOBS_BY_ROLE[role]) {
            if (banned.has(job.id)) continue;
            if (player.preferences.includes(job.id)) candidates.add(job.id);
          }
          const hasPref = JOBS_BY_ROLE[role].some(j => !banned.has(j.id) && player.preferences.includes(j.id));
          if (!hasPref) {
            const fallback = JOBS_BY_ROLE[role].find(j => !banned.has(j.id));
            if (fallback) candidates.add(fallback.id);
          }
        }
      }

      for (const jobId of candidates) {
        const key = slotIdx + ':' + jobId;
        if (seen.has(key)) continue;
        seen.add(key);
        const { score, forced } = jobScoreForPlayer(player, jobId, fairnessWeight);
        // FILL_BONUS : remplir un slot domine toujours le bench (fill-first).
        options.push({ slotIdx, jobId, score: score + SCORING.FILL_BONUS, forced });
      }
    }

    // Lock = contrainte dure : si un joueur est locké et qu'au moins un slot
    // peut accueillir son job, on RETIRE l'option bench du panier. Sinon
    // l'algo benchait parfois un joueur locké quand son lock pointait sur
    // une pref basse (ex: 3e choix) pour préserver le bonus de Role Composition
    // ou éviter une frustration — contre-intuitif pour l'user qui a explicitement
    // lock le job. Le lock devient "hard" : tu joues ton lock, ou tu bench si
    // vraiment aucun slot n'est disponible (cas du 5e mêlée pour 4 slots DPS).
    const lockedJobFits = !!player.lockedJob
      && options.some(o => o.jobId === player.lockedJob);
    if (!lockedJobFits) {
      options.push({ slotIdx: null, jobId: null, score: benchSc, forced: false });
    }
    options.sort((a, b) => b.score - a.score);

    for (const opt of options) {
      if (opt.slotIdx !== null) {
        slotTaken[opt.slotIdx] = true;
        current[playerIdx] = { slotIdx: opt.slotIdx, jobId: opt.jobId };
        recurse(playerIdx + 1, currentScore + opt.score, forcedCount + (opt.forced ? 1 : 0));
        slotTaken[opt.slotIdx] = false;
        current[playerIdx] = null;
      } else {
        current[playerIdx] = null;
        recurse(playerIdx + 1, currentScore + opt.score, forcedCount);
      }
    }
  }

  recurse(0, 0, 0);

  if (topSolutions.length === 0) return { error: 'noComp' };

  // Remap l'assignment de l'ordre algo (shuffled) vers l'ordre roster, pour
  // que `buildResultFromAssignment` produise des results en ordre roster.
  // C'est ce qui permet aux labels strat (MT/OT/H1/H2/M1/M2/R1/R2) de suivre
  // l'ordre du roster même quand l'algo a été seedé.
  const solutions = topSolutions.map(sol => {
    const rosterAssignment = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      rosterAssignment[permutation[i]] = sol.assignment[i];
    }
    return buildResultFromAssignment(rosterPlayers, slots, rosterAssignment);
  });

  return {
    solutions,
    fairnessWeight,
    // Rétrocompat : `results` et `stats` du best (callers existants d'index.html)
    results: solutions[0].results,
    stats: solutions[0].stats
  };
}

// Plafond pour le calcul de satisfaction : au-delà du 5ᵉ choix (rang 4),
// on ne pénalise plus davantage. Évite que des préférences longues écrasent
// artificiellement le score.
const SAT_RANK_CAP = 4;

export function buildResultFromAssignment(players, slots, assignment) {
  const results = players.map((p, i) => {
    const a = assignment[i];
    if (a === null) {
      return { name: p.name, assigned: false, preferences: p.preferences, locked: false, lockedJob: p.lockedJob || null };
    }
    const job = JOB_BY_ID[a.jobId];
    const prefRank = p.preferences.indexOf(a.jobId);
    const locked = !!p.lockedJob && p.lockedJob === a.jobId;
    return {
      name: p.name,
      assigned: true,
      jobName: job.name,
      jobId: job.id,
      role: job.role,
      slotRoles: slots[a.slotIdx].roles,
      prefRank,
      forced: prefRank === -1,
      preferences: p.preferences,
      totalPrefs: p.preferences.length,
      locked,
      lockedJob: p.lockedJob || null
    };
  });

  const assigned = results.filter(r => r.assigned);
  const firstChoices = assigned.filter(r => r.prefRank === 0).length;
  const forced = assigned.filter(r => r.forced).length;
  const benched = results.filter(r => !r.assigned).length;
  const worstRank = assigned.length === 0 ? null : Math.max(...assigned.map(r => r.forced ? 999 : r.prefRank));
  const satisfaction = assigned.length === 0 ? 0 :
    Math.round(assigned.reduce((sum, r) => {
      if (r.forced) return sum;
      const cappedRank = Math.min(r.prefRank, SAT_RANK_CAP);
      return sum + (1 - cappedRank / Math.max(r.preferences.length, 1)) * 100;
    }, 0) / assigned.length);

  // Sous-rôles présents (pour le bonus de Role Composition FFXIV)
  const subRolesPresent = new Set();
  for (const r of assigned) {
    if (SUBROLES.includes(r.role)) subRolesPresent.add(r.role);
  }
  // Le pourcentage de bonus dégâts correspondant côté jeu : 1% par sous-rôle.
  const roleBonusPercent = subRolesPresent.size;

  return {
    results,
    stats: {
      total: results.length, assigned: assigned.length, benched,
      firstChoices, forced, satisfaction, slotsTotal: slots.length,
      worstRank,
      subRolesPresent: [...subRolesPresent],
      roleBonusPercent
    }
  };
}
