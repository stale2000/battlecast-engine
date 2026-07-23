import type { Abilities } from '../types/monster.js';

export const ARENA_SRD_VERSION = '5.2.1';

export const ARENA_SPECIES = [
  'Dragonborn', 'Dwarf', 'Elf', 'Gnome', 'Goliath', 'Halfling', 'Human', 'Orc', 'Tiefling',
] as const;
export type ArenaSpecies = typeof ARENA_SPECIES[number];

export const ARENA_BACKGROUNDS = ['Acolyte', 'Criminal', 'Sage', 'Soldier'] as const;
export type ArenaBackground = typeof ARENA_BACKGROUNDS[number];
export type AbilityName = keyof Abilities;

export interface BackgroundDefinition {
  abilities: readonly AbilityName[];
  originFeat: 'Alert' | 'Magic Initiate (Cleric)' | 'Magic Initiate (Wizard)' | 'Savage Attacker';
  skills: readonly string[];
  tool: string;
  equipment: readonly string[];
}

export const BACKGROUNDS: Record<ArenaBackground, BackgroundDefinition> = {
  Acolyte: {
    abilities: ['int', 'wis', 'cha'], originFeat: 'Magic Initiate (Cleric)', skills: ['Insight', 'Religion'], tool: 'Calligrapher’s Supplies',
    equipment: ['Calligrapher’s Supplies', 'Book', 'Holy Symbol', 'Parchment', 'Robe'],
  },
  Criminal: {
    abilities: ['dex', 'con', 'int'], originFeat: 'Alert', skills: ['Sleight of Hand', 'Stealth'], tool: 'Thieves’ Tools',
    equipment: ['Dagger', 'Thieves’ Tools', 'Crowbar', 'Pouch', 'Traveler’s Clothes'],
  },
  Sage: {
    abilities: ['con', 'int', 'wis'], originFeat: 'Magic Initiate (Wizard)', skills: ['Arcana', 'History'], tool: 'Calligrapher’s Supplies',
    equipment: ['Quarterstaff', 'Calligrapher’s Supplies', 'Book', 'Parchment', 'Robe'],
  },
  Soldier: {
    abilities: ['str', 'dex', 'con'], originFeat: 'Savage Attacker', skills: ['Athletics', 'Intimidation'], tool: 'Gaming Set',
    equipment: ['Spear', 'Shortbow', 'Arrows', 'Gaming Set', 'Healer’s Kit', 'Quiver', 'Traveler’s Clothes'],
  },
};

export interface SpeciesDefinition {
  size: 'Small' | 'Medium';
  speed: number;
  resistances?: readonly string[];
  maxHpBonusAtLevel5?: number;
}

/** Static species traits that the state engine can represent directly. Dynamic
 * traits are added only when their action/reaction resolver exists. */
export const SPECIES: Record<ArenaSpecies, SpeciesDefinition> = {
  Dragonborn: { size: 'Medium', speed: 30 },
  Dwarf: { size: 'Medium', speed: 30, resistances: ['poison'], maxHpBonusAtLevel5: 5 },
  Elf: { size: 'Medium', speed: 30 },
  Gnome: { size: 'Small', speed: 30 },
  Goliath: { size: 'Medium', speed: 35 },
  Halfling: { size: 'Small', speed: 30 },
  Human: { size: 'Medium', speed: 30 },
  Orc: { size: 'Medium', speed: 30 },
  Tiefling: { size: 'Medium', speed: 30 },
};

export function applyBackgroundIncreases(
  base: Abilities,
  background: ArenaBackground,
  increases: Partial<Record<AbilityName, 0 | 1 | 2>>,
): Abilities {
  const entries = Object.entries(increases) as Array<[AbilityName, 0 | 1 | 2]>;
  if (!entries.length || entries.some(([ability, value]) => !BACKGROUNDS[background].abilities.includes(ability) || value < 1 || value > 2)) {
    throw new Error(`${background} ability increases must apply to its listed abilities.`);
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  const validShape = total === 3 && (entries.length === 2 && entries.some(([, value]) => value === 2) || entries.length === 3 && entries.every(([, value]) => value === 1));
  if (!validShape) throw new Error('Background ability increases must be +2/+1 or +1/+1/+1.');
  const result = { ...base };
  for (const [ability, value] of entries) {
    result[ability] += value;
    if (result[ability] > 20) throw new Error('Background ability increases cannot raise an ability above 20.');
  }
  return result;
}
