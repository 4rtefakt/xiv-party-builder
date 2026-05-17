// Analyse des disponibilités du roster : agrège qui peut jouer à quel
// créneau (jour × heure-de-début). Pur : pas de DOM, pas d'i18n.
//
// Vocabulaire :
//   - "respondent" = un·e joueur·euse qui a rempli au moins une case
//     (donc qui a un signal). Les autres sont exclu·e·s du dénominateur.
//   - "matrix[day][hour]" = liste des noms (string) dispos sur ce créneau.
//   - "missing[day][hour]" = liste des noms respondents NON dispos sur
//     ce créneau, utile pour le hover ("manque : Alice, Bob").

import { VALID_AVAIL_DAYS, VALID_AVAIL_HOURS, normalizeAvail } from './codec.js';

// Compte le nombre total de cases cochées dans un objet availability.
// Utilisé pour le badge "🕐 N" sur le bouton dispos de chaque ligne.
export function countAvailCells(av) {
  if (!av || typeof av !== 'object') return 0;
  let n = 0;
  for (const day of VALID_AVAIL_DAYS) {
    if (Array.isArray(av[day])) n += av[day].length;
  }
  return n;
}

// Presets prédéfinis appliqués au click d'un bouton dans le popover.
// Stockés comme des matrices day → hours qu'on merge dans l'avail
// courant (additif : on n'écrase pas les cases déjà cochées à la main).
export const AVAIL_PRESETS = {
  weekdayEvening: { mon: [20, 21, 22], tue: [20, 21, 22], wed: [20, 21, 22], thu: [20, 21, 22], fri: [20, 21, 22] },
  weekendAfternoon: { sat: [14, 16, 18], sun: [14, 16, 18] },
  weekendAll: {
    sat: [14, 16, 18, 19, 20, 21, 22, 23],
    sun: [14, 16, 18, 19, 20, 21, 22]
  }
};

// Applique un preset à un player en mutant son availability. Le preset
// spécial 'clear' réinitialise à null (= pas de signal).
// Renvoie le nouvel objet availability pour faciliter les tests.
export function applyAvailPreset(player, presetKey) {
  if (presetKey === 'clear') {
    player.availability = null;
    return null;
  }
  const preset = AVAIL_PRESETS[presetKey];
  if (!preset) return player.availability;
  const cur = player.availability || {};
  const merged = { ...cur };
  for (const day of Object.keys(preset)) {
    const existing = new Set(merged[day] || []);
    for (const h of preset[day]) existing.add(h);
    merged[day] = [...existing].sort((a, b) => a - b);
  }
  player.availability = normalizeAvail(merged);
  return player.availability;
}

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

// Calcule la longueur de la "queue" d'un slot : nombre d'heures STRICTEMENT
// CONSECUTIVES (h+1, h+2, …) dans le même jour où la densité reste >=
// threshold. Aide à départager des slots ex-æquo en privilégiant ceux qui
// permettent un raid plus long avec le même nombre de personnes.
//
// Le check "h+1 strict" garantit qu'un trou dans la liste curée (ex: 14h
// puis 16h sans 15h dans VALID_AVAIL_HOURS) NE compte PAS comme une plage
// continue de jeu — chaque slot représente 1h de play à partir de sa start.
function tailLength(analysis, day, hour, threshold) {
  const hourIdx = analysis.hours.indexOf(hour);
  if (hourIdx < 0) return 0;
  let tail = 0;
  let prevH = hour;
  for (let i = hourIdx + 1; i < analysis.hours.length; i++) {
    const nextH = analysis.hours[i];
    if (nextH !== prevH + 1) break; // gap horaire → chaîne rompue
    if (analysis.matrix[day][nextH].length >= threshold) {
      tail++;
      prevH = nextH;
    } else break;
  }
  return tail;
}

// Renvoie LE meilleur créneau unique en départageant les ex-æquo par la
// queue (durée consécutive avec densité conservée). Critères de tri :
//   1. Densité max (count de personnes dispos)
//   2. Tail max (parmi ceux à densité max)
//   3. Ordre du jour (Lun → Dim)
//   4. Heure croissante
//
// Exemple :
//   Tue 20h : 5/7 dispos, mais 21h tombe à 3/7  → tail = 0
//   Wed 20h : 5/7 dispos, 21h+22h+23h restent à 5/7+ → tail = 3
//   → On choisit Wed 20h.
//
// Renvoie { day, hour, count, tail } ou null si aucune donnée.
export function bestSlotWithTail(analysis) {
  if (!analysis || analysis.respondentCount === 0) return null;
  const all = bestSlots(analysis, { limit: Infinity });
  if (all.length === 0) return null;
  const maxCount = all[0].count;
  const tied = all.filter(s => s.count === maxCount);
  const withTails = tied.map(s => ({
    ...s,
    tail: tailLength(analysis, s.day, s.hour, maxCount)
  }));
  withTails.sort((a, b) => {
    if (b.tail !== a.tail) return b.tail - a.tail;
    const di = analysis.days.indexOf(a.day) - analysis.days.indexOf(b.day);
    if (di !== 0) return di;
    return a.hour - b.hour;
  });
  const best = withTails[0];
  // endHour : fin EXCLUSIVE de la plage jouable. Chaque slot représente 1h
  // de jeu à partir de sa start hour, donc :
  //   - best.hour=21h, tail=0       → joue 21-22, endHour=22
  //   - best.hour=21h, tail=2 (22h+23h aussi) → joue 21-24, endHour=24
  // C'est ce qu'on veut afficher en "21h → 24h" plutôt que "21h → 23h"
  // (qui couperait artificiellement le créneau du 23h à 23h).
  const hourIdx = analysis.hours.indexOf(best.hour);
  const lastStart = hourIdx >= 0 ? analysis.hours[hourIdx + best.tail] : best.hour;
  best.endHour = lastStart + 1;
  return best;
}
