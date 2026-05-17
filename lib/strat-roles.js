// Étiquette les assignments d'une compo finale avec les "rôles strat"
// FFXIV (MT/OT/H1/H2/M1/M2/R1/R2). Ces noms sont les conventions
// communautaires utilisées dans les guides et stratégies écrites :
//
//   - MT = Main Tank, OT = Off Tank (raid 8)
//   - H1, H2 = Healers (premier et second en ordre d'assignment)
//   - M1, M2 = "Melee 1 et 2" — slots gauche de la sous-grille DPS
//   - R1, R2 = "Ranged 1 et 2" — slots droite de la sous-grille DPS
//
// Important : le label est tributaire de la POSITION dans la grille,
// pas du job. Si un BLM se retrouve en slot M1, il prend la strat M1
// (pratique courante quand la compo réelle ne match pas la "compo
// canonique 2M+2R"). Et si l'utilisateur·ice swappe deux joueurs dans
// la grille, leurs labels suivent — le label appartient à la position.
//
// Layout de référence (sous-grille DPS, 2 cartes par row) :
//   col 0   col 1
//   [M1]    [R1]    ← row 0
//   [M2]    [R2]    ← row 1
//   [M3]    [R3]    ← row 2 (raid24 standard 5 DPS : M1 R1 M2 R2 M3)
//
// Pour les tanks et heals, l'ordre vertical donne MT/OT et H1/H2.

// Assigne à chaque DPS sa `gridPosition` (0-indexed) dans la sous-grille
// 2-colonnes : col 0 (paires) = M slots, col 1 (impaires) = R slots.
//
// Règles (slotCount = nb total de slots DPS du contenu, ex: 4 raid8) :
//   - Mêlées remplissent d'abord les M slots dans l'ordre.
//   - Non-mêlées (ranged + caster) remplissent les R slots dans l'ordre.
//   - Excédent : si plus de mêlées que de M slots, l'excédent va en R
//     (et inversement) — pour ne pas bencher un·e joueur·euse juste pour
//     un alignement visuel.
//   - Sous-effectif : si on n'a pas assez d'un type pour remplir ses
//     slots, on LAISSE la position vide plutôt que de bourrer avec
//     l'autre type. Ex: 1 mêlée + 2 non-mêlées en raid 8 → M1=mêlée,
//     R1=non-mêlée, M2=vide, R2=non-mêlée.
//
// Mute results : ajoute r.gridPosition à chaque DPS assigné. Les items
// pour lesquels aucune position n'a pu être trouvée gardent gridPosition
// undefined (ne devrait jamais arriver dans la pratique vu que le solver
// ne renvoie que des assignés qui ont un slot).
export function assignDpsGridPositions(results, slotCount) {
  if (!Array.isArray(results) || !slotCount) return results;
  const dps = results.filter(r =>
    r && r.assigned && (r.role === 'melee' || r.role === 'ranged' || r.role === 'caster')
  );
  if (dps.length === 0) return results;

  const mQ = dps.filter(r => r.role === 'melee').slice();
  const oQ = dps.filter(r => r.role !== 'melee').slice();
  const positions = new Array(slotCount).fill(null);

  // Phase 1 : positions préférées (M=mêlée, R=non-mêlée)
  for (let i = 0; i < slotCount; i++) {
    if ((i % 2) === 0 && mQ.length > 0)      positions[i] = mQ.shift();
    else if ((i % 2) === 1 && oQ.length > 0) positions[i] = oQ.shift();
  }
  // Phase 2 : spillover (uniquement si l'autre type est en excédent)
  // Important : on remplit en sens "complémentaire" pour préserver les
  // gaps quand il n'y a plus rien à mettre.
  for (let i = 0; i < slotCount; i++) {
    if (positions[i] !== null) continue;
    if ((i % 2) === 0) {
      // M slot vide → on accepte l'excédent de non-mêlées si y'en a
      if (oQ.length > 0) positions[i] = oQ.shift();
    } else {
      // R slot vide → on accepte l'excédent de mêlées
      if (mQ.length > 0) positions[i] = mQ.shift();
    }
  }

  // Annote chaque DPS avec sa position
  positions.forEach((item, pos) => {
    if (item) item.gridPosition = pos;
  });
  return results;
}

// Construit le layout de rendu : tableau de taille `slotCount` indexé par
// position de grille, avec les DPS placés à leur gridPosition (ou null
// pour les slots vides). Caller responsable de gérer les nulls (rendre
// un placeholder).
export function getDpsLayout(results, slotCount) {
  if (!Array.isArray(results) || !slotCount) return [];
  const layout = new Array(slotCount).fill(null);
  results.forEach(r => {
    if (!r || !r.assigned) return;
    if (r.role !== 'melee' && r.role !== 'ranged' && r.role !== 'caster') return;
    const pos = typeof r.gridPosition === 'number' ? r.gridPosition : -1;
    if (pos >= 0 && pos < slotCount) layout[pos] = r;
  });
  return layout;
}

// Mute les results en ajoutant un champ `stratRole` à chaque assignment.
// Renvoie le tableau (chainable).
// `_contentType` est conservé en signature pour compat / debugging mais
// n'influence plus le mapping (purement positionnel maintenant).
export function assignStratRoles(results, _contentType) {
  if (!Array.isArray(results)) return results;
  const tanks = results.filter(r => r && r.assigned && r.role === 'tank');
  const heals = results.filter(r => r && r.assigned && r.role === 'heal');
  const dps   = results.filter(r => r && r.assigned && (r.role === 'melee' || r.role === 'ranged' || r.role === 'caster'));

  // Tanks : T (1 seul), MT/OT (2), T1..Tn (3+)
  if (tanks.length === 1) tanks[0].stratRole = 'T';
  else if (tanks.length === 2) {
    tanks[0].stratRole = 'MT';
    tanks[1].stratRole = 'OT';
  } else {
    tanks.forEach((t, i) => { t.stratRole = 'T' + (i + 1); });
  }

  // Heals : H (1 seul), H1..Hn sinon
  if (heals.length === 1) heals[0].stratRole = 'H';
  else {
    heals.forEach((h, i) => { h.stratRole = 'H' + (i + 1); });
  }

  // DPS : labels selon la GRID POSITION (renseignée par
  // assignDpsGridPositions). Si pas renseignée, fallback sur l'index
  // d'itération (comportement legacy pour callers qui n'appellent pas
  // assignDpsGridPositions).
  dps.forEach((d, i) => {
    const pos = typeof d.gridPosition === 'number' ? d.gridPosition : i;
    const row = Math.floor(pos / 2);
    const col = pos % 2;
    d.stratRole = (col === 0 ? 'M' : 'R') + (row + 1);
  });

  return results;
}
