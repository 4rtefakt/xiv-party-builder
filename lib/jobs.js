// Catalogue des jobs FFXIV Dawntrail + métadonnées de contenu.
// Source de vérité partagée par index.html (front), functions/og/[id].js
// (OG image) et les tests. Pas de dépendance UI / i18n ici — les labels
// affichés vivent côté front.
//
// Limited jobs (BLU, BST) exclus : ils ne sont pas autorisés dans le
// contenu raid standard ni dans le matchmaker.

export const JOBS = [
  { id: 'PLD', name: 'Paladin',     role: 'tank',   icon: 'paladin'     },
  { id: 'WAR', name: 'Warrior',     role: 'tank',   icon: 'warrior'     },
  { id: 'DRK', name: 'Dark Knight', role: 'tank',   icon: 'darkknight'  },
  { id: 'GNB', name: 'Gunbreaker',  role: 'tank',   icon: 'gunbreaker'  },
  { id: 'WHM', name: 'White Mage',  role: 'heal',   icon: 'whitemage'   },
  { id: 'AST', name: 'Astrologian', role: 'heal',   icon: 'astrologian' },
  { id: 'SCH', name: 'Scholar',     role: 'heal',   icon: 'scholar'     },
  { id: 'SGE', name: 'Sage',        role: 'heal',   icon: 'sage'        },
  { id: 'MNK', name: 'Monk',        role: 'melee',  icon: 'monk'        },
  { id: 'DRG', name: 'Dragoon',     role: 'melee',  icon: 'dragoon'     },
  { id: 'NIN', name: 'Ninja',       role: 'melee',  icon: 'ninja'       },
  { id: 'SAM', name: 'Samurai',     role: 'melee',  icon: 'samurai'     },
  { id: 'RPR', name: 'Reaper',      role: 'melee',  icon: 'reaper'      },
  { id: 'VPR', name: 'Viper',       role: 'melee',  icon: 'viper'       },
  { id: 'BRD', name: 'Bard',        role: 'ranged', icon: 'bard'        },
  { id: 'MCH', name: 'Machinist',   role: 'ranged', icon: 'machinist'   },
  { id: 'DNC', name: 'Dancer',      role: 'ranged', icon: 'dancer'      },
  { id: 'BLM', name: 'Black Mage',  role: 'caster', icon: 'blackmage'   },
  { id: 'SMN', name: 'Summoner',    role: 'caster', icon: 'summoner'    },
  { id: 'RDM', name: 'Red Mage',    role: 'caster', icon: 'redmage'     },
  { id: 'PCT', name: 'Pictomancer', role: 'caster', icon: 'pictomancer' }
];

export const JOB_BY_ID = Object.fromEntries(JOBS.map(j => [j.id, j]));

export const JOBS_BY_ROLE = JOBS.reduce((acc, j) => {
  (acc[j.role] ||= []).push(j);
  return acc;
}, {});

export const VALID_JOB_IDS = new Set(JOBS.map(j => j.id));

export const ROLE_COLOR = {
  tank: '#2b9eff',
  heal: '#4ade80',
  melee: '#ff4f6e',
  ranged: '#ffb547',
  caster: '#c084fc'
};

// Structure des contenus, sans labels (qui vivent dans l'i18n côté front).
// `comp` = composition TOTALE (utilisée par l'OG worker et les tests
// d'invariants). `allianceComp` = composition d'UNE alliance, utilisée par
// le front qui optimise alliance par alliance pour raid24 / chaotic.
export const CONTENT_COMP = {
  dungeon:       { size: 4,  comp: { tank: 1, heal: 1, dps: 2  } },
  raid8:         { size: 8,  comp: { tank: 2, heal: 2, dps: 4  } },
  raid24:        { size: 24, comp: { tank: 3, heal: 6, dps: 15 },
                   alliances: 3, allianceComp: { tank: 1, heal: 2, dps: 5 } },
  // Chaotic Alliance Raid (depuis Cloud of Darkness Chaotic) :
  // 3 alliances × 2T/2H/4DPS = compo party 8-man répétée 3 fois.
  raid24chaotic: { size: 24, comp: { tank: 6, heal: 6, dps: 12 },
                   alliances: 3, allianceComp: { tank: 2, heal: 2, dps: 4 } }
};

export const VALID_CONTENT_KEYS = new Set(Object.keys(CONTENT_COMP));
