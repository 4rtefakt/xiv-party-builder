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

// Réorganise les DPS dans `results` pour qu'ils apparaissent dans l'ordre
// [mêlée, non-mêlée, mêlée, non-mêlée, …] = couleur "M-R-M-R" de la sous-grille.
// Préserve l'ordre dans chaque sous-bucket (mêlées et autres). Les tanks
// et heals ne sont pas touchés.
//
// Pourquoi : sans ça, les labels positionnels (M1=col 0, R1=col 1) peuvent
// tomber sur un caster en M1 et un mêlée en R1 selon l'ordre arbitraire
// du solver. Avec ce reorder, les mêlées vont naturellement dans les slots
// M et les autres dans les slots R. Pour un swap manuel (drag/↑↓), l'user
// modifie state.players → re-solve → re-reorder, donc le reorder s'applique
// systématiquement (c'est la default placement, pas une lock).
export function reorderResultsForDpsLayout(results) {
  if (!Array.isArray(results)) return results;
  const dpsIdx = [];
  const dpsItems = [];
  results.forEach((r, i) => {
    if (r && r.assigned && (r.role === 'melee' || r.role === 'ranged' || r.role === 'caster')) {
      dpsIdx.push(i);
      dpsItems.push(r);
    }
  });
  if (dpsItems.length === 0) return results;

  const meleeQ = dpsItems.filter(r => r.role === 'melee');
  const otherQ = dpsItems.filter(r => r.role !== 'melee');
  const reordered = [];
  for (let i = 0; i < dpsItems.length; i++) {
    const isMPos = (i % 2) === 0;  // col 0 = M, col 1 = R
    if (isMPos) {
      reordered.push(meleeQ.length > 0 ? meleeQ.shift() : otherQ.shift());
    } else {
      reordered.push(otherQ.length > 0 ? otherQ.shift() : meleeQ.shift());
    }
  }

  const out = results.slice();
  dpsIdx.forEach((origIdx, k) => { out[origIdx] = reordered[k]; });
  return out;
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

  // DPS : labels purement positionnels selon la sous-grille 2 colonnes
  //   col 0 (gauche) → M(row+1) ; col 1 (droite) → R(row+1)
  // L'index dans le tableau dps[] correspond à la position de lecture
  // gauche→droite, top→bottom (cf. layout de la sous-grille côté front).
  dps.forEach((d, i) => {
    const row = Math.floor(i / 2);
    const col = i % 2;
    d.stratRole = (col === 0 ? 'M' : 'R') + (row + 1);
  });

  return results;
}
