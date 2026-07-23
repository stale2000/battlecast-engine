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
import { bless, burningHands, cureWounds, guidingBolt, healingWord, magicMissile, shieldOfFaith, sleep, thunderwave } from '../data/spells.js';

type DragonAncestry = 'acid' | 'cold' | 'fire' | 'lightning' | 'poison';
type CastingAbility = 'int' | 'wis' | 'cha';
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

function magicInitiateActions(
  feat: string | undefined,
  cantrips: unknown,
  spell: unknown,
  castingAbility: unknown,
  abilities: Abilities,
  label: string,
): { actions: MonsterAction[]; resources: Record<string, number> } | undefined {
  if (feat !== 'Magic Initiate (Cleric)' && feat !== 'Magic Initiate (Wizard)') return undefined;
  const list = feat === 'Magic Initiate (Cleric)' ? 'Cleric' : 'Wizard';
  const allowedCantrips = list === 'Cleric' ? ['Sacred Flame', 'Toll the Dead'] : ['Fire Bolt', 'Ray of Frost'];
  const allowedSpells = list === 'Cleric'
    ? ['Bless', 'Cure Wounds', 'Healing Word', 'Shield of Faith', 'Guiding Bolt']
    : ['Magic Missile', 'Burning Hands', 'Thunderwave', 'Sleep'];
  if (!Array.isArray(cantrips) || cantrips.length !== 2 || cantrips.some(value => typeof value !== 'string') || new Set(cantrips).size !== 2 || cantrips.some(value => !allowedCantrips.includes(value))) {
    throw new EncounterError(`${label}.originCantrips must select the two engine-supported ${list} cantrips.`);
  }
  if (typeof spell !== 'string' || !allowedSpells.includes(spell)) throw new EncounterError(`${label}.originSpell must select an engine-supported level-1 ${list} spell.`);
  if (castingAbility !== 'int' && castingAbility !== 'wis' && castingAbility !== 'cha') throw new EncounterError(`${label}.originCastingAbility must be Intelligence, Wisdom, or Charisma.`);
  const mod = Math.floor((abilities[castingAbility as CastingAbility] - 10) / 2);
  const pb = 3;
  const makeCantrip = (name: string): MonsterAction => name === 'Sacred Flame'
    ? { name, type: 'special', description: `DEX save DC ${8 + mod + pb}; 2d8 radiant damage.`, spellLevel: 0, castingAbility: castingAbility as CastingAbility, damageType: 'radiant', savingThrow: { ability: 'dex', dc: 8 + mod + pb, damageOnFail: '2d8' }, range: { normal: 60, long: 60 }, targetScope: 'one_enemy' }
    : name === 'Toll the Dead'
      ? { name, type: 'special', description: `WIS save DC ${8 + mod + pb}; 2d8 necrotic damage.`, spellLevel: 0, castingAbility: castingAbility as CastingAbility, damageType: 'necrotic', savingThrow: { ability: 'wis', dc: 8 + mod + pb, damageOnFail: '2d8' }, range: { normal: 60, long: 60 }, targetScope: 'one_enemy' }
      : name === 'Fire Bolt'
        ? { name, type: 'ranged', description: `Ranged spell attack, 2d10 fire damage.`, spellLevel: 0, castingAbility: castingAbility as CastingAbility, attackBonus: mod + pb, damage: '2d10', damageType: 'fire', range: { normal: 120, long: 120 }, magical: true, targetScope: 'one_enemy' }
        : { name, type: 'ranged', description: `Ranged spell attack, 2d8 cold damage.`, spellLevel: 0, castingAbility: castingAbility as CastingAbility, attackBonus: mod + pb, damage: '2d8', damageType: 'cold', range: { normal: 60, long: 60 }, magical: true, targetScope: 'one_enemy' };
  const levelOne = spell === 'Bless' ? bless() : spell === 'Cure Wounds' ? cureWounds(castingAbility as CastingAbility, mod, pb) : spell === 'Healing Word' ? healingWord(castingAbility as CastingAbility, mod, pb) : spell === 'Shield of Faith' ? shieldOfFaith() : spell === 'Guiding Bolt' ? guidingBolt(castingAbility as CastingAbility, mod, pb) : spell === 'Magic Missile' ? magicMissile() : spell === 'Burning Hands' ? burningHands(castingAbility as CastingAbility, mod, pb) : spell === 'Thunderwave' ? thunderwave(castingAbility as CastingAbility, mod, pb) : sleep(castingAbility as CastingAbility, mod, pb);
  return { actions: [...cantrips.map(makeCantrip), { ...levelOne, resourceCost: { key: 'magic-initiate', amount: 1 } }], resources: { 'magic-initiate': 1 } };
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
    if (!Object.keys(character).every(key => ['heroClass', 'abilities', 'subclass', 'spells', 'species', 'background', 'abilityIncreases', 'dragonAncestry', 'size', 'originCantrips', 'originSpell', 'originCastingAbility'].includes(key))) {
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
    const hasOriginSpellChoice = character.originCantrips !== undefined || character.originSpell !== undefined || character.originCastingAbility !== undefined;
    if (hasOriginSpellChoice && (!background || !['Magic Initiate (Cleric)', 'Magic Initiate (Wizard)'].includes(BACKGROUNDS[background].originFeat))) {
      throw new EncounterError(`${label} origin spell choices require a Magic Initiate background.`);
    }
    const origin = species && background ? magicInitiateActions(BACKGROUNDS[background].originFeat, character.originCantrips, character.originSpell, character.originCastingAbility, abilities, label) : undefined;
    return {
      heroClass, heroLevel: 5, team,
      heroOverrides: {
        abilities, subclass: character.subclass as 'Circle of the Land' | 'Circle of the Moon' | undefined, spells,
        ...(species && background ? {
          species, background, originFeat: BACKGROUNDS[background].originFeat, originSkills: [...BACKGROUNDS[background].skills], originTool: BACKGROUNDS[background].tool,
          originEquipment: [...BACKGROUNDS[background].equipment], sizeOverride: size ?? SPECIES[species].size, speedOverride: SPECIES[species].speed,
          hitPointBonus: SPECIES[species].maxHpBonusAtLevel5, additionalResistances: SPECIES[species].resistances ? [...SPECIES[species].resistances] : undefined,
          additionalResources: { ...(species === 'Orc' ? { 'orc-adrenaline-rush': 3 } : {}), ...(origin?.resources ?? {}) },
          additionalActions: [...(species === 'Dragonborn' ? [dragonbornBreath(character.dragonAncestry as DragonAncestry, abilities)] : []), ...(origin?.actions ?? [])],
          ...(species === 'Dragonborn' ? { additionalResistances: [character.dragonAncestry as DragonAncestry], additionalResources: { ...(origin?.resources ?? {}), 'dragonborn-breath': 3, 'dragonborn-flight': 1 } } : {}),
        } : {}),
      },
    };
  });
}

export function validateArenaParty(value: unknown, team: Team): void {
  parseArenaParty(value, team);
}
