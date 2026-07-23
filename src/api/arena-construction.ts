import { EncounterError, type AddCreatureOptions, type Team } from './encounter.js';
import { buildHero, getAvailableSpells, HERO_CLASS_NAMES } from '../data/heroes.js';
import {
  ARENA_BACKGROUNDS,
  ARENA_SPECIES,
  BACKGROUNDS,
  SPECIES,
  applyBackgroundIncreases,
  type AbilityName,
  type ArenaBackground,
  type ArenaSpecies,
} from '../data/arena-origins.js';
import type { Abilities, MonsterAction } from '../types/monster.js';

type DragonAncestry = 'acid' | 'cold' | 'fire' | 'lightning' | 'poison';
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const POINT_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
const DRAGON_DAMAGE_TYPES = ['acid', 'cold', 'fire', 'lightning', 'poison'] as const;

const SLOT_PARTY: Record<1 | 2 | 3 | 4, AddCreatureOptions> = {
  1: { heroClass: 'Fighter', heroLevel: 5, team: 'red' },
  2: { heroClass: 'Cleric', heroLevel: 5, team: 'red' },
  3: { heroClass: 'Wizard', heroLevel: 5, team: 'red' },
  4: { heroClass: 'Rogue', heroLevel: 5, team: 'red' },
};

export function assertArenaObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EncounterError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function parseAbilities(value: unknown, label: string): Abilities {
  const abilities = assertArenaObject(value, label);
  if (Object.keys(abilities).length !== ABILITIES.length || !ABILITIES.every(key => typeof abilities[key] === 'number' && Number.isInteger(abilities[key]) && abilities[key] in POINT_COST)) {
    throw new EncounterError(`${label} must contain each ability from 8 through 15.`);
  }
  const total = ABILITIES.reduce((sum, key) => sum + POINT_COST[abilities[key] as number], 0);
  if (total !== 27) throw new EncounterError(`${label} must use exactly 27-point buy.`);
  return Object.fromEntries(ABILITIES.map(key => [key, abilities[key]])) as unknown as Abilities;
}

function parseSpells(value: unknown, heroClass: typeof HERO_CLASS_NAMES[number], label: string): string[] | undefined {
  const expected = buildHero(heroClass, 5).actions.filter(action => (action.spellLevel ?? 0) > 0).length;
  if (value === undefined) {
    if (expected) throw new EncounterError(`${label}.spells must select exactly ${expected} engine-supported spells.`);
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== expected || value.some(spell => typeof spell !== 'string') || new Set(value).size !== value.length) {
    throw new EncounterError(`${label}.spells must select exactly ${expected} distinct spells.`);
  }
  const available = new Set(getAvailableSpells(heroClass, 5).filter(spell => spell.spellLevel > 0).map(spell => spell.name));
  if (value.some(spell => !available.has(spell))) throw new EncounterError(`${label}.spells contains an unavailable spell.`);
  return value as string[];
}

function dragonbornBreath(ancestry: DragonAncestry, abilities: Abilities): MonsterAction {
  const dc = 8 + Math.floor((abilities.con - 10) / 2) + 3;
  return {
    name: 'Breath Weapon', type: 'special', description: `15-foot cone or 30-foot line, DEX save DC ${dc}, 2d10 ${ancestry} damage (half on success).`,
    damageType: ancestry, resourceCost: { key: 'dragonborn-breath', amount: 1 },
    replacesAttack: true,
    savingThrow: { ability: 'dex', dc, damageOnFail: '2d10', damageOnSuccess: 'half', area: '15-foot cone or 30-foot line' },
  };
}

/** Validates a public arena party and converts it into trusted encounter options. */
export function parseArenaParty(value: unknown, team: Team): AddCreatureOptions[] {
  const party = assertArenaObject(value, `${team}Party`);
  if (!Array.isArray(party.characters) || party.characters.length !== 4) {
    throw new EncounterError(`${team}Party.characters must contain exactly four characters.`);
  }
  const slots = new Set<number>();
  return party.characters.map((value, index) => {
    const label = `${team}Party.characters[${index}]`;
    const character = assertArenaObject(value, label);
    if (typeof character.slot === 'number') {
      if (Object.keys(character).length !== 1 || !Number.isInteger(character.slot) || character.slot < 1 || character.slot > 4 || slots.has(character.slot)) {
        throw new EncounterError(`${team}Party slot characters must use each slot 1 through 4 once.`);
      }
      slots.add(character.slot);
      return { ...SLOT_PARTY[character.slot as 1 | 2 | 3 | 4], team };
    }
    if (typeof character.heroClass !== 'string' || !HERO_CLASS_NAMES.includes(character.heroClass as typeof HERO_CLASS_NAMES[number])) {
      throw new EncounterError(`${label}.heroClass must be a supported hero class.`);
    }
    if (!Object.keys(character).every(key => ['heroClass', 'abilities', 'subclass', 'spells', 'species', 'background', 'abilityIncreases', 'dragonAncestry', 'size'].includes(key))) {
      throw new EncounterError(`${label} contains unsupported build choices.`);
    }
    const baseAbilities = parseAbilities(character.abilities, `${label}.abilities`);
    const hasOrigin = character.species !== undefined || character.background !== undefined || character.abilityIncreases !== undefined;
    if (hasOrigin && (typeof character.species !== 'string' || !ARENA_SPECIES.includes(character.species as ArenaSpecies) || typeof character.background !== 'string' || !ARENA_BACKGROUNDS.includes(character.background as ArenaBackground))) {
      throw new EncounterError(`${label} must use an SRD species and background together.`);
    }
    const species = character.species as ArenaSpecies | undefined;
    const background = character.background as ArenaBackground | undefined;
    const size = character.size as 'Small' | 'Medium' | undefined;
    if (character.size !== undefined && (typeof character.size !== 'string' || !['Small', 'Medium'].includes(character.size))) {
      throw new EncounterError(`${label}.size must be Small or Medium.`);
    }
    if (size && species !== 'Human' && species !== 'Tiefling') {
      throw new EncounterError(`${label}.size is selectable only for Human and Tiefling.`);
    }
    if (species === 'Dragonborn' && (typeof character.dragonAncestry !== 'string' || !DRAGON_DAMAGE_TYPES.includes(character.dragonAncestry as DragonAncestry))) {
      throw new EncounterError(`${label}.dragonAncestry must be an SRD damage type.`);
    }
    if (species !== 'Dragonborn' && character.dragonAncestry !== undefined) throw new EncounterError(`${label}.dragonAncestry requires Dragonborn.`);
    let abilities = baseAbilities;
    if (hasOrigin) {
      const increases = assertArenaObject(character.abilityIncreases, `${label}.abilityIncreases`) as Partial<Record<AbilityName, 0 | 1 | 2>>;
      try {
        abilities = applyBackgroundIncreases(baseAbilities, background!, increases);
      } catch (error) {
        throw new EncounterError(error instanceof Error ? error.message : String(error));
      }
    }
    if (character.subclass !== undefined && (character.heroClass !== 'Druid' || (character.subclass !== 'Circle of the Land' && character.subclass !== 'Circle of the Moon'))) {
      throw new EncounterError(`${label}.subclass is not supported.`);
    }
    const heroClass = character.heroClass as typeof HERO_CLASS_NAMES[number];
    const spells = parseSpells(character.spells, heroClass, label);
    return {
      heroClass, heroLevel: 5, team,
      heroOverrides: {
        abilities, subclass: character.subclass as 'Circle of the Land' | 'Circle of the Moon' | undefined, spells,
        ...(species && background ? {
          species, background, originFeat: BACKGROUNDS[background].originFeat, originSkills: [...BACKGROUNDS[background].skills], originTool: BACKGROUNDS[background].tool,
          originEquipment: [...BACKGROUNDS[background].equipment], sizeOverride: size ?? SPECIES[species].size, speedOverride: SPECIES[species].speed,
          hitPointBonus: SPECIES[species].maxHpBonusAtLevel5, additionalResistances: SPECIES[species].resistances ? [...SPECIES[species].resistances] : undefined,
          additionalResources: species === 'Orc' ? { 'orc-adrenaline-rush': 3 } : undefined,
          additionalActions: species === 'Dragonborn' ? [dragonbornBreath(character.dragonAncestry as DragonAncestry, abilities)] : undefined,
          ...(species === 'Dragonborn' ? { additionalResistances: [character.dragonAncestry as DragonAncestry], additionalResources: { 'dragonborn-breath': 3, 'dragonborn-flight': 1 } } : {}),
        } : {}),
      },
    };
  });
}

export function validateArenaParty(value: unknown, team: Team): void {
  parseArenaParty(value, team);
}
