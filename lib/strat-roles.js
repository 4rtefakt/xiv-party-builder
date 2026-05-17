// Étiquette les assignments d'une compo finale avec les "rôles strat"
// FFXIV (MT/OT/H1/H2/M1/M2/R1/R2). Ces noms sont les conventions
// communautaires utilisées dans les guides et stratégies écrites :
//
//   - MT = Main Tank, OT = Off Tank (raid 8)
//   - H1, H2 = Healers (premier et second en ordre d'assignment)
//   - M1, M2 = "Melee 1 et 2" — slots mêlée d'une strat 8-man
//   - R1, R2 = "Ranged 1 et 2" — slots distance (physical + caster)
//
// Les strats étant souvent écrites pour 2M + 2R en raid 8, on rééquilibre
// les labels quand la compo réelle est asymétrique (3 ranged + 1 melee,
// 4 melees, etc.) : les excédents ranged débordent sur M2, les excédents
// melee débordent sur R2.
//
// Pour les autres contenus (dungeon 4-man, raid24 standard 1T/2H/5DPS),
// pas de convention forte → numérotation naturelle.

// "Melee" au sens strat = la sous-classe melee uniquement (MNK, DRG, NIN,
// SAM, RPR, VPR). Casters et ranged physiques sont groupés sous R parce
// que les strats les positionnent ensemble (max melee ou maxmelee dérivé).
const isMelee = (role) => role === 'melee';

// Décrit la "balance" cible des labels DPS par type de contenu.
// null = pas de rééquilibrage, on numérote les melees et les autres
// séparément (M1..Mn, R1..Rn).
const STRAT_BALANCE = {
  raid8:          { mDps: 2, rDps: 2 },   // 2T/2H/4DPS, strat 8-man classique
  raid24chaotic:  { mDps: 2, rDps: 2 },   // 2T/2H/4DPS par alliance
  dungeon:        { mDps: 1, rDps: 1 },   // 1T/1H/2DPS, M1 + R1
  raid24:         null                     // 1T/2H/5DPS, numérotation naturelle
};

// Mute les results en ajoutant un champ `stratRole` à chaque assignment.
// Renvoie le tableau (chainable).
// `contentType` est la clé de CONTENT_COMP (raid8 / dungeon / raid24 /
// raid24chaotic). Pour raid24 / chaotic, ce sont les results d'UNE
// alliance à la fois (le caller boucle sur les 3 alliances).
export function assignStratRoles(results, contentType) {
  if (!Array.isArray(results)) return results;
  const tanks = results.filter(r => r && r.assigned && r.role === 'tank');
  const heals = results.filter(r => r && r.assigned && r.role === 'heal');
  const dps   = results.filter(r => r && r.assigned && (r.role === 'melee' || r.role === 'ranged' || r.role === 'caster'));

  // Tanks
  if (tanks.length === 1) tanks[0].stratRole = 'T';
  else if (tanks.length === 2) {
    tanks[0].stratRole = 'MT';
    tanks[1].stratRole = 'OT';
  } else {
    tanks.forEach((t, i) => { t.stratRole = 'T' + (i + 1); });
  }

  // Heals
  if (heals.length === 1) heals[0].stratRole = 'H';
  else {
    heals.forEach((h, i) => { h.stratRole = 'H' + (i + 1); });
  }

  // DPS — soit rééquilibrage vers (mDps, rDps), soit numérotation naturelle
  const balance = STRAT_BALANCE[contentType];
  const melees = dps.filter(r => isMelee(r.role));
  const others = dps.filter(r => !isMelee(r.role));

  if (balance) {
    // Cible explicite : remplir mDps slots M en priorité avec des melees,
    // puis emprunter sur others. Le reste va sur rDps slots R, others
    // d'abord (préserve la "naturel-ité") puis melees résiduels.
    const meleeQ = melees.slice();
    const otherQ = others.slice();
    const mAssigned = [];
    for (let i = 0; i < balance.mDps; i++) {
      const next = meleeQ.length > 0 ? meleeQ.shift()
                 : otherQ.length > 0 ? otherQ.shift()
                 : null;
      if (next) mAssigned.push(next);
    }
    const rAssigned = otherQ.concat(meleeQ).slice(0, balance.rDps);
    mAssigned.forEach((r, i) => { r.stratRole = 'M' + (i + 1); });
    rAssigned.forEach((r, i) => { r.stratRole = 'R' + (i + 1); });
  } else {
    // Pas de balance définie → numérotation naturelle :
    // melees → M1..Mn, autres → R1..Rn.
    melees.forEach((r, i) => { r.stratRole = 'M' + (i + 1); });
    others.forEach((r, i) => { r.stratRole = 'R' + (i + 1); });
  }

  return results;
}
