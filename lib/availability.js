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

// Créneaux de raid verrouillés ("on raidera tel jour à telle heure pour N
// heures"). Limite à 7 pour couvrir un planning hebdo complet sans
// permettre de saturer artificiellement le KV. Le calcul de "prochain meilleur
// créneau" exclut les cellules couvertes par ces slots pour proposer un
// créneau qui n'entre pas en conflit avec ceux déjà planifiés.
export const MAX_RAID_SLOTS = 7;
// Durée en heures, peut être fractionnaire (multiple de 0.5). Borne à 6h
// max : pas de contenu FFXIV qui dure plus longtemps, et beaucoup
// d'instances font 1h30 (d'où le pas demi-heure).
export const MIN_SLOT_DURATION = 0.5;
export const MAX_SLOT_DURATION = 6;
export const SLOT_DURATION_STEP = 0.5;

// Vrai si d est un nombre fini multiple de 0.5 dans [MIN, MAX].
export function isValidSlotDuration(d) {
  if (typeof d !== 'number' || !Number.isFinite(d)) return false;
  if (d < MIN_SLOT_DURATION || d > MAX_SLOT_DURATION) return false;
  return (d * 2) === Math.round(d * 2);
}

// Formate une durée en heures (potentiellement fractionnaire) en string
// lisible : 0.5 → "30 min", 1 → "1h", 1.5 → "1h30", 2 → "2h", 2.5 → "2h30".
export function formatSlotDuration(hours) {
  const half = Math.round(hours * 2);
  const h = Math.floor(half / 2);
  const isHalf = half % 2 === 1;
  if (h === 0) return '30 min';
  return isHalf ? `${h}h30` : `${h}h`;
}

// Formate une heure de fin (potentiellement .5) en "Hh" ou "Hh30".
export function formatEndHour(hour) {
  const h = Math.floor(hour);
  const isHalf = (hour - h) >= 0.5;
  return isHalf ? `${h}h30` : `${h}h`;
}

// Un slot couvre les heures de DÉBUT [hour, hour + duration[. Ex : { hour:21,
// duration:2 } couvre les starts 21h et 22h (= 2h de play, 21-23). 23h n'est
// PAS couvert (un raid démarrant à 23h ne conflit pas avec ce slot).
// Avec un duration fractionnaire (ex 1.5), le bord supérieur tombe à 22.5 :
// la cell 22h est couverte (22 < 22.5), 23h ne l'est pas (23 ≥ 22.5).
export function cellInSlots(day, hour, slots) {
  if (!Array.isArray(slots) || slots.length === 0) return false;
  for (const s of slots) {
    if (!s || s.day !== day) continue;
    const dur = typeof s.duration === 'number' && s.duration > 0 ? s.duration : 1;
    if (hour >= s.hour && hour < s.hour + dur) return true;
  }
  return false;
}

// Deux slots intersectent si même jour ET leurs ranges de starts se
// chevauchent. Symétrique. Sert au front pour bloquer l'ajout d'un slot
// manuel qui conflit avec un existant.
export function slotsIntersect(a, b) {
  if (!a || !b || a.day !== b.day) return false;
  const dA = typeof a.duration === 'number' && a.duration > 0 ? a.duration : 1;
  const dB = typeof b.duration === 'number' && b.duration > 0 ? b.duration : 1;
  return a.hour < b.hour + dB && b.hour < a.hour + dA;
}

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
//
// excludedSlots : liste de { day, hour, duration } à exclure (créneaux
// déjà verrouillés comme dates de raid → on cherche un slot supplémentaire
// qui ne chevauche pas).
export function bestSlots(analysis, { limit = 3, excludedSlots = [] } = {}) {
  const out = [];
  for (const day of analysis.days) {
    for (const h of analysis.hours) {
      if (cellInSlots(day, h, excludedSlots)) continue;
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
function tailLength(analysis, day, hour, threshold, excludedSlots = []) {
  const hourIdx = analysis.hours.indexOf(hour);
  if (hourIdx < 0) return 0;
  let tail = 0;
  let prevH = hour;
  for (let i = hourIdx + 1; i < analysis.hours.length; i++) {
    const nextH = analysis.hours[i];
    if (nextH !== prevH + 1) break; // gap horaire → chaîne rompue
    // Si l'heure suivante chevauche un créneau déjà locké, le tail s'arrête —
    // on ne veut pas qu'un meilleur créneau "déborde" sur un raid planifié.
    if (cellInSlots(day, nextH, excludedSlots)) break;
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
//
// excludedSlots : liste de { day, hour, duration } à exclure. Utile pour
// proposer un "prochain meilleur créneau" qui ne chevauche pas les raids
// déjà planifiés.
export function bestSlotWithTail(analysis, { excludedSlots = [] } = {}) {
  if (!analysis || analysis.respondentCount === 0) return null;
  const all = bestSlots(analysis, { limit: Infinity, excludedSlots });
  if (all.length === 0) return null;
  const maxCount = all[0].count;
  const tied = all.filter(s => s.count === maxCount);
  const withTails = tied.map(s => ({
    ...s,
    tail: tailLength(analysis, s.day, s.hour, maxCount, excludedSlots)
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
