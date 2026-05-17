// Analyse de couverture des rôles par le roster :
// répond à "ai-je assez de tanks / healers / DPS pour ce contenu ?"
//
// Pur : aucune dépendance UI, ni state global.

import { JOB_BY_ID, CONTENT_COMP } from './jobs.js';
import { buildSlots } from './scoring.js';

// Profondeur considérée comme "prêt à jouer ce rôle" : un job dans les
// `PRIMARY_DEPTH` premiers d'une pref → on compte la personne comme
// couvrant ce rôle.
const PRIMARY_DEPTH = 2;

export function getRoleRequirements(contentType, dpsMode) {
  const slots = buildSlots(contentType, dpsMode);
  const reqs = { tank: 0, heal: 0, melee: 0, ranged: 0, caster: 0, flex_dps: 0, distance: 0 };
  const base = CONTENT_COMP[contentType] || {};
  // buildSlots renvoie 1 alliance → on multiplie quand le contenu est en N alliances
  const factor = base.alliances || 1;
  slots.forEach(slot => {
    if (slot.roles.length === 1) {
      reqs[slot.roles[0]] += factor;
    } else if (slot.roles.includes('melee') && slot.roles.includes('ranged') && slot.roles.includes('caster')) {
      reqs.flex_dps += factor;
    } else if (slot.roles.includes('ranged') && slot.roles.includes('caster')) {
      reqs.distance += factor;
    }
  });
  return reqs;
}

// players : [{ name, preferences, presence? }]
// Retourne { coverage, reqs, gaps, playersWithName, playersWithPrefs }.
export function analyzeCoverage(players, contentType, dpsMode, bannedJobs) {
  const banned = bannedJobs instanceof Set
    ? bannedJobs
    : new Set(Array.isArray(bannedJobs) ? bannedJobs : []);

  const playersWithName = (players || [])
    .filter(p => p && typeof p.name === 'string' && p.name.trim() !== '' && (p.presence || 'in') !== 'out')
    .map(p => ({ ...p, preferences: (p.preferences || []).filter(id => !banned.has(id)) }));

  const playersWithPrefs = playersWithName.filter(p => p.preferences.length > 0);
  const reqs = getRoleRequirements(contentType, dpsMode);

  const coverage = { tank: 0, heal: 0, melee: 0, ranged: 0, caster: 0 };
  playersWithPrefs.forEach(p => {
    const seenRoles = new Set();
    const top = p.preferences.slice(0, PRIMARY_DEPTH);
    top.forEach(jobId => {
      const job = JOB_BY_ID[jobId];
      if (job && !seenRoles.has(job.role)) {
        seenRoles.add(job.role);
        coverage[job.role]++;
      }
    });
  });

  const gaps = [];
  if (coverage.tank < reqs.tank) gaps.push({ role: 'tank', missing: reqs.tank - coverage.tank });
  if (coverage.heal < reqs.heal) gaps.push({ role: 'heal', missing: reqs.heal - coverage.heal });
  if (coverage.melee < reqs.melee) gaps.push({ role: 'melee', missing: reqs.melee - coverage.melee });

  const distanceCoverage = coverage.ranged + coverage.caster;
  if (distanceCoverage < reqs.distance) {
    gaps.push({ role: 'distance', missing: reqs.distance - distanceCoverage });
  }

  const flexCoverage = coverage.melee + coverage.ranged + coverage.caster;
  if (reqs.flex_dps > 0 && flexCoverage < reqs.flex_dps) {
    gaps.push({ role: 'flex_dps', missing: reqs.flex_dps - flexCoverage });
  }

  return { coverage, reqs, gaps, playersWithName, playersWithPrefs };
}

// Exposé pour les tests / réutilisation
export { PRIMARY_DEPTH };
