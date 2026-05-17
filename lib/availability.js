// Analyse des disponibilités du roster : agrège qui peut jouer à quel
// créneau (jour × heure-de-début). Pur : pas de DOM, pas d'i18n.
//
// Vocabulaire :
//   - "respondent" = un·e joueur·euse qui a rempli au moins une case
//     (donc qui a un signal). Les autres sont exclu·e·s du dénominateur.
//   - "matrix[day][hour]" = liste des noms (string) dispos sur ce créneau.
//   - "missing[day][hour]" = liste des noms respondents NON dispos sur
//     ce créneau, utile pour le hover ("manque : Alice, Bob").

import { VALID_AVAIL_DAYS, VALID_AVAIL_HOURS } from './codec.js';

// Construit l'index { matrix, missing, respondentCount, hours, days }.
// Considère seulement les joueur·euses avec name non vide ET availability
// non null (signal explicite). Les players "out" (présence) sont aussi
// exclus — pas pertinent de compter leurs dispos s'ils ont déjà dit absent.
export function analyzeAvailability(rawPlayers) {
  const players = (Array.isArray(rawPlayers) ? rawPlayers : [])
    .filter(p => p && typeof p.name === 'string' && p.name.trim() !== '')
    .filter(p => (p.presence || 'in') !== 'out')
    .filter(p => p.availability && typeof p.availability === 'object');

  const matrix = {};
  const missing = {};
  for (const day of VALID_AVAIL_DAYS) {
    matrix[day] = {};
    missing[day] = {};
    for (const h of VALID_AVAIL_HOURS) {
      matrix[day][h] = [];
      missing[day][h] = [];
    }
  }

  for (const p of players) {
    const name = p.name.trim();
    const av = p.availability;
    for (const day of VALID_AVAIL_DAYS) {
      const hours = Array.isArray(av[day]) ? av[day] : [];
      const hoursSet = new Set(hours);
      for (const h of VALID_AVAIL_HOURS) {
        if (hoursSet.has(h)) {
          matrix[day][h].push(name);
        } else {
          missing[day][h].push(name);
        }
      }
    }
  }

  return {
    matrix,
    missing,
    respondentCount: players.length,
    hours: VALID_AVAIL_HOURS.slice(),
    days: VALID_AVAIL_DAYS.slice()
  };
}

// Trouve le ou les meilleurs créneaux (jour, heure) avec le plus grand
// nombre de respondents dispos. Renvoie un tableau (ex-æquo possibles)
// trié par densité décroissante, puis par jour de la semaine, puis par
// heure croissante. Vide si personne n'a répondu.
export function bestSlots(analysis, { limit = 3 } = {}) {
  const out = [];
  for (const day of analysis.days) {
    for (const h of analysis.hours) {
      const count = analysis.matrix[day][h].length;
      if (count > 0) out.push({ day, hour: h, count });
    }
  }
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    // Stable secondary keys : day order, then hour
    const di = analysis.days.indexOf(a.day) - analysis.days.indexOf(b.day);
    if (di !== 0) return di;
    return a.hour - b.hour;
  });
  return out.slice(0, limit);
}
