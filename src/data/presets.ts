import type { HeroClassName } from './heroes.js';

export type PresetMonsterEntry = { monster: string; count: number };
export type PresetHeroEntry = { heroClass: HeroClassName; level: number; count?: number };
export type PresetTeamEntry = PresetMonsterEntry | PresetHeroEntry;

export interface PresetBattle {
  id: string;
  title: string;
  description: string;
  flavour: string;
  icon: string;
  image?: string;
  difficulty: 'fair' | 'uphill' | 'mismatch' | 'chaos';
  redTeam: PresetTeamEntry[];
  blueTeam: PresetTeamEntry[];
  gridSize?: number;
  notes?: string;
  /**
   * Optional reference to a map preset in `src/data/maps.ts`. When a
   * scenario is loaded, this map gets painted under the battle grid.
   * Omit to leave the user's currently-selected map (if any) alone.
   */
  mapId?: string;
}

// Scenario lineup re-authored 2026-04-27 against the replacement maps
// (forest-clearing, stone-bridge, grass-plain, cave-floor). Difficulty labels were
// tuned via scripts/test-scenarios.ts at 200 MC trials each.
export const presets: PresetBattle[] = [
  // Featured
  {
    id: 'lichs-last-rite',
    title: "Lich's Last Rite",
    description: 'A lich faces six level-10 heroes on a stone cave floor: Fighter, Paladin, Cleric, Wizard, Rogue, and Ranger.',
    flavour: 'The phylactery is close. So is the end.',
    icon: '☠️',
    difficulty: 'fair',
    redTeam: [{ monster: 'Lich', count: 1 }],
    blueTeam: [
      { heroClass: 'Fighter', level: 10, count: 1 },
      { heroClass: 'Paladin', level: 10, count: 1 },
      { heroClass: 'Cleric', level: 10, count: 1 },
      { heroClass: 'Wizard', level: 10, count: 1 },
      { heroClass: 'Rogue', level: 10, count: 1 },
      { heroClass: 'Ranger', level: 10, count: 1 },
    ],
    gridSize: 20,
    mapId: 'cave-floor',
    notes: 'Tuned at ~63/37 for the lich over 500 MC trials. At-will Fireball and Lightning Bolt punish clusters, Disrupt Life breaks melee piles, Frightening Gaze buys space, and Deathly Teleport keeps the duel mobile.',
  },

  // Forest Clearing 16x16
  {
    id: 'goblin-ambush',
    title: 'Goblin Ambush',
    description: '8 Goblin Warriors spring on 2 Veterans in a forest clearing. Pack Tactics and pine cover give the goblins the edge.',
    flavour: 'They came from the treeline.',
    icon: '🗡️',
    difficulty: 'uphill',
    redTeam: [{ monster: 'Goblin Warrior', count: 8 }],
    blueTeam: [{ monster: 'Veteran', count: 2 }],
    gridSize: 16,
    mapId: 'forest-clearing',
    notes: 'Goblins win ~65% of the time on tuning runs. Numbers and Pack Tactics carry; veterans must funnel through the central boulders to avoid being flanked.',
  },
  {
    id: 'wolf-pack',
    title: 'Wolf Pack',
    description: 'A dire wolf and her pack stalk a druid and her bear allies through the trees.',
    flavour: 'Tooth and claw against staff and paw.',
    icon: '🐺',
    difficulty: 'fair',
    redTeam: [{ monster: 'Wolf', count: 5 }, { monster: 'Dire Wolf', count: 1 }],
    blueTeam: [{ monster: 'Druid', count: 1 }, { monster: 'Black Bear', count: 2 }],
    gridSize: 16,
    mapId: 'forest-clearing',
    notes: 'Coin-flip fight. Druid spell support vs pack-tactics rush. Bears tank, druid sustains.',
  },
  {
    id: 'no-healer-rescue',
    title: 'No-Healer Rescue',
    description: 'A level-1 martial party without a healer is rushed by wolves in a forest clearing. Heroes drop often, and nearby allies must decide whether to spend an action stabilising them.',
    flavour: 'No priest. No potion. Just seconds to act.',
    icon: '🩹',
    difficulty: 'uphill',
    redTeam: [{ monster: 'Wolf', count: 6 }, { monster: 'Dire Wolf', count: 1 }],
    blueTeam: [
      { heroClass: 'Fighter', level: 1, count: 1 },
      { heroClass: 'Barbarian', level: 1, count: 1 },
      { heroClass: 'Rogue', level: 1, count: 1 },
      { heroClass: 'Monk', level: 1, count: 1 },
    ],
    gridSize: 16,
    mapId: 'forest-clearing',
    notes: 'Built to surface the stabilise action. The heroes have no revive heal, so adjacent allies frequently have to choose between stopping death saves and attacking the pack.',
  },
  {
    id: 'bandit-camp',
    title: 'Bandit Camp',
    description: 'A patrolling knight and veteran stumble onto a brigand camp: a bandit captain, a berserker enforcer, and six bandit lookouts.',
    flavour: 'Outnumbered, but not outmatched.',
    icon: '🗝️',
    difficulty: 'uphill',
    redTeam: [
      { monster: 'Bandit Captain', count: 1 },
      { monster: 'Berserker', count: 1 },
      { monster: 'Bandit', count: 6 },
    ],
    blueTeam: [{ monster: 'Knight', count: 1 }, { monster: 'Veteran', count: 1 }],
    gridSize: 16,
    mapId: 'forest-clearing',
    notes: 'Bandits favored ~75/25. The captain and berserker are real threats; the knight and veteran must break the line before the bandits surround them.',
  },

  // Cave Floor 20x20
  {
    id: 'owlbears-den',
    title: "Owlbear's Den",
    description: 'Treasure hunters poke around a cave lair and stir up the family. One owlbear, one brown bear, and four wolves answer the call.',
    flavour: 'You should not have come here.',
    icon: '🐻',
    difficulty: 'uphill',
    redTeam: [
      { monster: 'Owlbear', count: 1 },
      { monster: 'Brown Bear', count: 1 },
      { monster: 'Wolf', count: 4 },
    ],
    blueTeam: [{ monster: 'Bandit Captain', count: 1 }, { monster: 'Bandit', count: 6 }],
    gridSize: 20,
    mapId: 'cave-floor',
    notes: 'The cave lair favors the residents ~70/30. Owlbear soaks the front line; wolves circle and pile on isolated bandits.',
  },

  // Stone Bridge 20x20
  {
    id: 'troll-bridge',
    title: 'Troll Bridge',
    description: '3 Trolls vs 10 Hobgoblins across a river. The arch bridge is the only crossing, and trolls regenerate.',
    flavour: 'You must pay the toll.',
    icon: '🌉',
    difficulty: 'mismatch',
    redTeam: [{ monster: 'Troll', count: 3 }],
    blueTeam: [{ monster: 'Hobgoblin', count: 10 }],
    gridSize: 20,
    mapId: 'stone-bridge',
    notes: 'Without fire or acid, hobgoblins lose 100% of MC trials. A showcase of why damage type matters - trolls regen faster than longbows kill.',
  },
  {
    id: 'bridge-defenders',
    title: 'Bridge Defenders',
    description: 'A knight and 2 veterans hold the stone arch against an orc warband - 2 ogres lead 8 orcs across.',
    flavour: 'Hold the line.',
    icon: '🛡️',
    difficulty: 'fair',
    redTeam: [{ monster: 'Knight', count: 1 }, { monster: 'Veteran', count: 2 }],
    blueTeam: [{ monster: 'Ogre', count: 2 }, { monster: 'Orc', count: 8 }],
    gridSize: 20,
    mapId: 'stone-bridge',
    notes: 'Coin-flip on the chokepoint. Ogres punch through if the defenders bunch; veterans win if they can pick off orcs at range first.',
  },
  {
    id: 'wyverns-crossing',
    title: "Wyvern's Crossing",
    description: '2 wyverns and 2 hippogriffs swoop the river crossing. 6 veterans and 2 town guards have to bring them down before they pick the column apart.',
    flavour: 'The shadow on the water has wings.',
    icon: '🐲',
    difficulty: 'fair',
    redTeam: [{ monster: 'Wyvern', count: 2 }, { monster: 'Hippogriff', count: 2 }],
    blueTeam: [{ monster: 'Veteran', count: 6 }, { monster: 'Guard', count: 2 }],
    gridSize: 20,
    mapId: 'stone-bridge',
    notes: 'Tight 50/50. Flyers cross the river freely; ground troops must concentrate fire on a single wyvern at a time.',
  },
  {
    id: 'river-crossing',
    title: 'River Crossing',
    description: 'A centaur cavalry patrol meets a hobgoblin column at the bridge. 4 centaur troopers vs 2 hobgoblin captains and 6 hobgoblins.',
    flavour: 'Hooves on stone, arrows in the air.',
    icon: '🏹',
    difficulty: 'fair',
    redTeam: [{ monster: 'Centaur Trooper', count: 4 }],
    blueTeam: [{ monster: 'Hobgoblin Captain', count: 2 }, { monster: 'Hobgoblin', count: 6 }],
    gridSize: 20,
    mapId: 'stone-bridge',
    notes: 'Mobile centaur archery vs disciplined hobgoblin volleys. The bridge bottleneck favors whoever sets up first.',
  },

  // Grass Plain 20x20
  {
    id: 'the-charge',
    title: 'The Charge',
    description: '3 mounted knights crash into a hobgoblin warband (1 captain + 10 hobgoblins) on the open plain. No cover, just steel.',
    flavour: 'For king and country.',
    icon: '🐎',
    difficulty: 'fair',
    redTeam: [{ monster: 'Knight', count: 3 }],
    blueTeam: [{ monster: 'Hobgoblin Captain', count: 1 }, { monster: 'Hobgoblin', count: 10 }],
    gridSize: 20,
    mapId: 'grass-plain',
    notes: 'Knights edge it ~60/40. Open ground means no LOS-breaking - hobgoblins must drop the knights with concentrated longbow fire before they close.',
  },
  {
    id: 'dragons-of-twilight',
    title: 'Dragons of Twilight',
    description: 'A young black dragon meets a young white dragon on the open plain. Acid line vs cold cone.',
    flavour: 'Two breaths, two wings, one survivor.',
    icon: '🐉',
    difficulty: 'fair',
    redTeam: [{ monster: 'Young Black Dragon', count: 1 }],
    blueTeam: [{ monster: 'Young White Dragon', count: 1 }],
    gridSize: 20,
    mapId: 'grass-plain',
    notes: 'Black has the slight edge (~55/45) - acid Breath has better range, and the white\'s cold breath is shorter cone. Both fly over the open plain.',
  },
  {
    id: 'last-stand',
    title: 'The Last Stand',
    description: 'An Adult Red Dragon descends on a village - 30 commoners with pitchforks are all that stands between it and the harvest.',
    flavour: 'The village musters its last defense.',
    icon: '🔥',
    difficulty: 'mismatch',
    redTeam: [{ monster: 'Adult Red Dragon', count: 1 }],
    blueTeam: [{ monster: 'Commoner', count: 30 }],
    gridSize: 20,
    mapId: 'grass-plain',
    notes: 'The dragon wins 100/100. Not a tactics scenario - a showcase of just how outclassed common folk are when a CR 17 wakes up nearby.',
  },

  // Cave Floor 20x20
  {
    id: 'pit-fiends-reckoning',
    title: "Pit Fiend's Reckoning",
    description: 'A Pit Fiend leads a small infernal warband across a stone cavern floor: 1 Barbed Devil, 4 Bearded Devils, and a heroic strike force of 4 Knights, 2 Mages, 2 Priests.',
    flavour: 'Signed in blood, collected in person.',
    icon: '\u{1F608}',
    difficulty: 'uphill',
    redTeam: [
      { monster: 'Pit Fiend', count: 1 },
      { monster: 'Barbed Devil', count: 1 },
      { monster: 'Bearded Devil', count: 4 },
    ],
    blueTeam: [
      { monster: 'Knight', count: 4 },
      { monster: 'Mage', count: 2 },
      { monster: 'Priest', count: 2 },
    ],
    gridSize: 20,
    mapId: 'cave-floor',
    notes: 'Devils favored ~85/15. Pit Fiend\'s magic resistance + flight + Fireball + Power Word: Pain make him the centerpiece; the bearded devils tie up melee while he picks off casters.',
  },
];
