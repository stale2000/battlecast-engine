import type { Abilities, WeaponMasteryProperty } from '../types/monster.js';

export interface ArenaWeapon {
  name: string;
  category: 'simple' | 'martial';
  die: string;
  damageType: string;
  type: 'melee' | 'ranged';
  reach?: number;
  range?: { normal: number; long: number };
  thrownRange?: { normal: number; long: number };
  versatileDie?: string;
  loading?: boolean;
  light?: boolean;
  heavy?: boolean;
  closeRangeDisadvantage?: boolean;
  mastery?: WeaponMasteryProperty;
  attackAbility?: keyof Abilities;
  finesse?: boolean;
  twoHanded?: boolean;
}

/** Server-owned mundane equipment prices, in gp, for the arena budget. */
export const ARENA_WEAPON_COST_GP: Record<string, number> = {
  Club: 0.1, Sickle: 1, LightHammer: 2, Dagger: 2, Greatclub: 0.2, Handaxe: 5,
  Javelin: 0.5, Mace: 5, Morningstar: 15, Quarterstaff: 0.2, Spear: 1,
  LightCrossbow: 25, Dart: 0.05, Sling: 0.1, Shortbow: 25, Flail: 10, Glaive: 20,
  Greataxe: 30, Halberd: 20, Longsword: 15, Longbow: 50, Lance: 10, Maul: 10,
  Pike: 5, Rapier: 25, Scimitar: 25, Shortsword: 10, Trident: 5, Greatsword: 50,
  Battleaxe: 10, Warhammer: 15, Whip: 2, Blowgun: 10, HandCrossbow: 75,
  HeavyCrossbow: 50, Pistol: 50, Musket: 500,
};

export const ARENA_ARMOR_COST_GP: Record<string, number> = {
  Padded: 5, Leather: 10, 'Studded Leather': 45, Hide: 10, 'Chain Shirt': 50,
  'Scale Mail': 50, Breastplate: 400, 'Half Plate': 750, 'Ring Mail': 30,
  'Chain Mail': 75, Splint: 200, Plate: 1500,
};

export const ARENA_SHIELD_COST_GP = 10;
/** A fixed tier-2 arena allowance; enough for plate, shield, and a martial weapon. */
export const ARENA_EQUIPMENT_BUDGET_GP = 1600;

export interface ArenaArmor {
  category: 'light' | 'medium' | 'heavy';
  armorBase: number;
  dexCap: number;
  minimumStrength?: number;
}

export const ARENA_ARMOR: Record<string, ArenaArmor> = {
  Padded: { category: 'light', armorBase: 11, dexCap: Infinity },
  Leather: { category: 'light', armorBase: 11, dexCap: Infinity },
  'Studded Leather': { category: 'light', armorBase: 12, dexCap: Infinity },
  Hide: { category: 'medium', armorBase: 12, dexCap: 2 },
  'Chain Shirt': { category: 'medium', armorBase: 13, dexCap: 2 },
  'Scale Mail': { category: 'medium', armorBase: 14, dexCap: 2 },
  Breastplate: { category: 'medium', armorBase: 14, dexCap: 2 },
  'Half Plate': { category: 'medium', armorBase: 15, dexCap: 2 },
  'Ring Mail': { category: 'heavy', armorBase: 14, dexCap: 0 },
  'Chain Mail': { category: 'heavy', armorBase: 16, dexCap: 0, minimumStrength: 13 },
  Splint: { category: 'heavy', armorBase: 17, dexCap: 0, minimumStrength: 15 },
  Plate: { category: 'heavy', armorBase: 18, dexCap: 0, minimumStrength: 15 },
};

/** Server-owned SRD weapon facts. Public build requests select only these names. */
export const ARENA_WEAPONS: Record<string, ArenaWeapon> = {
  Club: { name: 'Club', category: 'simple', die: '1d4', damageType: 'bludgeoning', type: 'melee', mastery: 'slow' },
  Sickle: { name: 'Sickle', category: 'simple', die: '1d4', damageType: 'slashing', type: 'melee', mastery: 'nick' },
  LightHammer: { name: 'Light Hammer', category: 'simple', die: '1d4', damageType: 'bludgeoning', type: 'melee', thrownRange: { normal: 20, long: 60 }, mastery: 'nick' },
  Dagger: { name: 'Dagger', category: 'simple', die: '1d4', damageType: 'piercing', type: 'melee', finesse: true, thrownRange: { normal: 20, long: 60 }, mastery: 'nick' },
  Greatclub: { name: 'Greatclub', category: 'simple', die: '1d8', damageType: 'bludgeoning', type: 'melee', twoHanded: true, mastery: 'push' },
  Handaxe: { name: 'Handaxe', category: 'simple', die: '1d6', damageType: 'slashing', type: 'melee', thrownRange: { normal: 20, long: 60 }, mastery: 'vex' },
  Javelin: { name: 'Javelin', category: 'simple', die: '1d6', damageType: 'piercing', type: 'melee', thrownRange: { normal: 30, long: 120 }, attackAbility: 'str', mastery: 'slow' },
  Mace: { name: 'Mace', category: 'simple', die: '1d6', damageType: 'bludgeoning', type: 'melee', mastery: 'sap' },
  Morningstar: { name: 'Morningstar', category: 'martial', die: '1d8', damageType: 'piercing', type: 'melee', mastery: 'sap' },
  Quarterstaff: { name: 'Quarterstaff', category: 'simple', die: '1d6', versatileDie: '1d8', damageType: 'bludgeoning', type: 'melee', mastery: 'topple' },
  Spear: { name: 'Spear', category: 'simple', die: '1d6', versatileDie: '1d8', damageType: 'piercing', type: 'melee', thrownRange: { normal: 20, long: 60 }, attackAbility: 'str', mastery: 'sap' },
  LightCrossbow: { name: 'Light Crossbow', category: 'simple', die: '1d8', damageType: 'piercing', type: 'ranged', range: { normal: 80, long: 320 }, loading: true, twoHanded: true, mastery: 'slow' },
  Dart: { name: 'Dart', category: 'simple', die: '1d4', damageType: 'piercing', type: 'ranged', range: { normal: 20, long: 60 }, finesse: true, mastery: 'vex' },
  Sling: { name: 'Sling', category: 'simple', die: '1d4', damageType: 'bludgeoning', type: 'ranged', range: { normal: 30, long: 120 }, mastery: 'slow' },
  Shortbow: { name: 'Shortbow', category: 'simple', die: '1d6', damageType: 'piercing', type: 'ranged', range: { normal: 80, long: 320 }, twoHanded: true, mastery: 'vex' },
  Flail: { name: 'Flail', category: 'martial', die: '1d8', damageType: 'bludgeoning', type: 'melee', mastery: 'sap' },
  Glaive: { name: 'Glaive', category: 'martial', die: '1d10', damageType: 'slashing', type: 'melee', reach: 10, twoHanded: true, heavy: true, mastery: 'graze' },
  Greataxe: { name: 'Greataxe', category: 'martial', die: '1d12', damageType: 'slashing', type: 'melee', twoHanded: true, heavy: true, mastery: 'cleave' },
  Halberd: { name: 'Halberd', category: 'martial', die: '1d10', damageType: 'slashing', type: 'melee', reach: 10, twoHanded: true, heavy: true, mastery: 'cleave' },
  Longsword: { name: 'Longsword', category: 'martial', die: '1d8', versatileDie: '1d10', damageType: 'slashing', type: 'melee', mastery: 'sap' },
  Longbow: { name: 'Longbow', category: 'martial', die: '1d8', damageType: 'piercing', type: 'ranged', range: { normal: 150, long: 600 }, twoHanded: true, heavy: true, mastery: 'slow' },
  Lance: { name: 'Lance', category: 'martial', die: '1d10', damageType: 'piercing', type: 'melee', reach: 10, twoHanded: true, closeRangeDisadvantage: true, mastery: 'topple' },
  Maul: { name: 'Maul', category: 'martial', die: '2d6', damageType: 'bludgeoning', type: 'melee', twoHanded: true, heavy: true, mastery: 'topple' },
  Pike: { name: 'Pike', category: 'martial', die: '1d10', damageType: 'piercing', type: 'melee', reach: 10, twoHanded: true, heavy: true, mastery: 'push' },
  Rapier: { name: 'Rapier', category: 'martial', die: '1d8', damageType: 'piercing', type: 'melee', finesse: true, mastery: 'vex' },
  Scimitar: { name: 'Scimitar', category: 'martial', die: '1d6', damageType: 'slashing', type: 'melee', finesse: true, light: true, mastery: 'nick' },
  Shortsword: { name: 'Shortsword', category: 'martial', die: '1d6', damageType: 'piercing', type: 'melee', finesse: true, light: true, mastery: 'vex' },
  Trident: { name: 'Trident', category: 'martial', die: '1d8', versatileDie: '1d10', damageType: 'piercing', type: 'melee', thrownRange: { normal: 20, long: 60 }, attackAbility: 'str', mastery: 'topple' },
  Greatsword: { name: 'Greatsword', category: 'martial', die: '2d6', damageType: 'slashing', type: 'melee', twoHanded: true, heavy: true, mastery: 'graze' },
  Battleaxe: { name: 'Battleaxe', category: 'martial', die: '1d8', versatileDie: '1d10', damageType: 'slashing', type: 'melee', mastery: 'topple' },
  Warhammer: { name: 'Warhammer', category: 'martial', die: '1d8', versatileDie: '1d10', damageType: 'bludgeoning', type: 'melee', mastery: 'push' },
  Whip: { name: 'Whip', category: 'martial', die: '1d4', damageType: 'slashing', type: 'melee', reach: 10, finesse: true, mastery: 'slow' },
  Blowgun: { name: 'Blowgun', category: 'martial', die: '1', damageType: 'piercing', type: 'ranged', range: { normal: 25, long: 100 }, loading: true, mastery: 'vex' },
  HandCrossbow: { name: 'Hand Crossbow', category: 'martial', die: '1d6', damageType: 'piercing', type: 'ranged', range: { normal: 30, long: 120 }, loading: true, light: true, mastery: 'vex' },
  HeavyCrossbow: { name: 'Heavy Crossbow', category: 'martial', die: '1d10', damageType: 'piercing', type: 'ranged', range: { normal: 100, long: 400 }, loading: true, twoHanded: true, heavy: true, mastery: 'push' },
  Pistol: { name: 'Pistol', category: 'martial', die: '1d10', damageType: 'piercing', type: 'ranged', range: { normal: 30, long: 90 }, loading: true, mastery: 'vex' },
  Musket: { name: 'Musket', category: 'martial', die: '1d12', damageType: 'piercing', type: 'ranged', range: { normal: 40, long: 120 }, loading: true, twoHanded: true, mastery: 'slow' },
};

export const ARENA_SRD_VERSION = '5.2.1';

export const ARENA_SPECIES = [
  'Dragonborn', 'Dwarf', 'Elf', 'Gnome', 'Goliath', 'Halfling', 'Human', 'Orc', 'Tiefling',
] as const;
export type ArenaSpecies = typeof ARENA_SPECIES[number];

// SRD 5.2 publishes these four backgrounds. The wider 2024 PHB catalogue
// is not SRD content and must not enter the deterministic arena allowlist.
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
