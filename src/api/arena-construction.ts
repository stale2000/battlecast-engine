import { EncounterError, type AddCreatureOptions, type Team } from './encounter.js';
import { buildHero, getAvailableSpells, HERO_CLASS_NAMES, type HeroSubclassName, type WeaponOverride } from '../data/heroes.js';
import {
  ARENA_BACKGROUNDS,
  ARENA_ARMOR,
  ARENA_SPECIES,
  ARENA_WEAPONS,
  BACKGROUNDS,
  SPECIES,
  applyBackgroundIncreases,
  type AbilityName,
  type ArenaBackground,
  type ArenaSpecies,
} from '../data/arena-origins.js';
import type { Abilities, MonsterAction } from '../types/monster.js';
import { bless, burningHands, cureWounds, entangle, guidingBolt, healingWord, holdPerson, magicMissile, shieldOfFaith, sleep, thunderwave } from '../data/spells.js';

type DragonAncestry = 'acid' | 'cold' | 'fire' | 'lightning' | 'poison';
type CastingAbility = 'int' | 'wis' | 'cha';
type TieflingLegacy = 'Abyssal' | 'Chthonic' | 'Infernal';
type ElfLineage = 'Drow' | 'High Elf' | 'Wood Elf';
type GnomeLineage = 'Forest Gnome' | 'Rock Gnome';
type GoliathAncestry = 'Cloud' | 'Fire' | 'Frost' | 'Hill' | 'Stone' | 'Storm';
const SRD_SUBCLASSES: Record<typeof HERO_CLASS_NAMES[number], readonly string[]> = {
  Barbarian: ['Path of the Berserker'], Bard: ['College of Lore'], Cleric: ['Life Domain'], Druid: ['Circle of the Land', 'Circle of the Moon'], Fighter: ['Champion'], Monk: ['Warrior of the Open Hand'], Paladin: ['Oath of Devotion'], Ranger: ['Hunter'], Rogue: ['Thief'], Sorcerer: ['Draconic Sorcery'], Warlock: ['Fiend Patron'], Wizard: ['Evoker'],
};
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const POINT_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
const DRAGON_DAMAGE_TYPES = ['acid', 'cold', 'fire', 'lightning', 'poison'] as const;
const SKILLS = ['Acrobatics', 'Animal Handling', 'Arcana', 'Athletics', 'Deception', 'History', 'Insight', 'Intimidation', 'Investigation', 'Medicine', 'Nature', 'Perception', 'Performance', 'Persuasion', 'Religion', 'Sleight of Hand', 'Stealth', 'Survival'] as const;
const TOOLS = ['Alchemist’s Supplies', 'Brewer’s Supplies', 'Calligrapher’s Supplies', 'Carpenter’s Tools', 'Cartographer’s Tools', 'Cobbler’s Tools', 'Cook’s Utensils', 'Disguise Kit', 'Forgery Kit', 'Gaming Set', 'Glassblower’s Tools', 'Herbalism Kit', 'Jeweler’s Tools', 'Leatherworker’s Tools', 'Mason’s Tools', 'Musical Instrument', 'Navigator’s Tools', 'Painter’s Supplies', 'Poisoner’s Kit', 'Potter’s Tools', 'Smith’s Tools', 'Thieves’ Tools', 'Tinker’s Tools', 'Weaver’s Tools', 'Woodcarver’s Tools'] as const;
const LANGUAGES = ['Common Sign Language', 'Draconic', 'Dwarvish', 'Elvish', 'Giant', 'Gnomish', 'Goblin', 'Halfling', 'Orc', 'Abyssal', 'Celestial', 'Deep Speech', 'Druidic', 'Infernal', 'Primordial', 'Sylvan', 'Thieves’ Cant', 'Undercommon'] as const;
const ALIGNMENTS = ['Lawful Good', 'Neutral Good', 'Chaotic Good', 'Lawful Neutral', 'Neutral', 'Chaotic Neutral', 'Lawful Evil', 'Neutral Evil', 'Chaotic Evil'] as const;
const ARMOR_TRAINING: Record<typeof HERO_CLASS_NAMES[number], readonly ('light' | 'medium' | 'heavy')[]> = {
  Barbarian: ['light', 'medium'], Bard: ['light'], Cleric: ['light', 'medium', 'heavy'], Druid: ['light', 'medium'], Fighter: ['light', 'medium', 'heavy'], Monk: [], Paladin: ['light', 'medium', 'heavy'], Ranger: ['light', 'medium'], Rogue: ['light'], Sorcerer: [], Warlock: ['light'], Wizard: [],
};
const SHIELD_TRAINING = new Set<typeof HERO_CLASS_NAMES[number]>(['Barbarian', 'Cleric', 'Druid', 'Fighter', 'Paladin', 'Ranger']);

function isWeaponProficient(heroClass: typeof HERO_CLASS_NAMES[number], weapon: typeof ARENA_WEAPONS[string]): boolean {
  if (heroClass === 'Barbarian' || heroClass === 'Cleric' || heroClass === 'Fighter' || heroClass === 'Paladin' || heroClass === 'Ranger') return true;
  if (heroClass === 'Bard') return weapon.category === 'simple' || weapon.finesse === true;
  if (heroClass === 'Monk') return weapon.category === 'simple' || weapon.light === true;
  if (heroClass === 'Rogue') return weapon.category === 'simple' || weapon.finesse === true || weapon.light === true;
  return weapon.category === 'simple';
}

function toWeaponOverrides(weapons: readonly (typeof ARENA_WEAPONS[string])[] | undefined, useTwoHanded: boolean): WeaponOverride[] | undefined {
  return weapons?.flatMap<WeaponOverride>(weapon => {
    const base = { name: weapon.name, die: weapon.die, damageType: weapon.damageType, attackAbility: weapon.attackAbility, finesse: weapon.finesse, loading: weapon.loading, heavy: weapon.heavy, closeRangeDisadvantage: weapon.closeRangeDisadvantage, mastery: weapon.mastery };
    const melee = weapon.thrownRange
      ? [
        { ...base, name: `${weapon.name} (Melee)`, type: 'melee' as const, reach: weapon.reach },
        { ...base, name: `${weapon.name} (Thrown)`, type: 'ranged' as const, range: weapon.thrownRange },
      ]
      : [{ ...base, type: weapon.type, reach: weapon.reach, range: weapon.range } as WeaponOverride];
    if (useTwoHanded && weapon.versatileDie) melee.push({ ...base, name: `${weapon.name} (Two-Handed)`, die: weapon.versatileDie, type: 'melee', reach: weapon.reach });
    return melee;
  });
}

function speciesDarkvision(species: ArenaSpecies, elfLineage?: ElfLineage): string | undefined {
  const range = species === 'Dwarf' || species === 'Orc' || (species === 'Elf' && elfLineage === 'Drow') ? 120
    : ['Dragonborn', 'Elf', 'Gnome', 'Tiefling'].includes(species) ? 60 : undefined;
  return range ? `Darkvision ${range} ft.` : undefined;
}

function lineageSpells(species: ArenaSpecies, choice?: string, highElfCantrip?: string): { cantrips?: string[]; prepared?: string[] } {
  if (species === 'Elf') {
    if (choice === 'Drow') return { cantrips: ['Dancing Lights'], prepared: ['Faerie Fire', 'Darkness'] };
    if (choice === 'High Elf') return { cantrips: [highElfCantrip ?? 'Prestidigitation'], prepared: ['Detect Magic', 'Misty Step'] };
    return { cantrips: ['Druidcraft'], prepared: ['Longstrider', 'Pass without Trace'] };
  }
  if (species === 'Gnome') return choice === 'Forest Gnome'
    ? { cantrips: ['Minor Illusion'], prepared: ['Speak with Animals'] }
    : { cantrips: ['Mending', 'Prestidigitation'] };
  if (species === 'Tiefling') {
    const legacy = choice as TieflingLegacy;
    return legacy === 'Abyssal' ? { cantrips: ['Thaumaturgy', 'Poison Spray'], prepared: ['Ray of Sickness', 'Hold Person'] }
      : legacy === 'Chthonic' ? { cantrips: ['Thaumaturgy', 'Chill Touch'], prepared: ['False Life', 'Ray of Enfeeblement'] }
      : { cantrips: ['Thaumaturgy', 'Fire Bolt'], prepared: ['Hellish Rebuke', 'Darkness'] };
  }
  return {};
}

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

function drowFaerieFire(castingAbility: CastingAbility, abilities: Abilities): MonsterAction {
  const dc = 8 + Math.floor((abilities[castingAbility] - 10) / 2) + 3;
  return {
    name: 'Faerie Fire', type: 'special', description: `20-foot Cube, DEX save DC ${dc}; failed targets grant Advantage on attacks against them for 1 minute.`,
    spellLevel: 1, castingAbility, resourceCost: { key: 'drow-faerie-fire', amount: 1 }, range: { normal: 60, long: 60 }, targetScope: 'area_enemies',
    savingThrow: { ability: 'dex', dc, area: '20-foot Cube' },
    durationRounds: 10,
    buffOnFailedSave: { name: 'Faerie Fire', key: 'drow-faerie-fire', requiresConcentration: true, advantageForAllAttackers: true },
  };
}

function lineageDarkness(resourceKey: string): MonsterAction {
  return {
    name: 'Darkness', type: 'special', description: 'Magical Darkness fills a 15-foot-radius Sphere at a visible point within 60 feet for 10 minutes. Concentration.',
    spellLevel: 2, range: { normal: 60, long: 60 }, targetScope: 'self', resourceCost: { key: resourceKey, amount: 1 },
    darkness: { radius: 15, durationRounds: 100, requiresConcentration: true },
  };
}

type SupportedDamageCantrip = 'Fire Bolt' | 'Ray of Frost' | 'Poison Spray' | 'Chill Touch' | 'Produce Flame' | 'Shocking Grasp';

function damagingCantrip(name: SupportedDamageCantrip, castingAbility: CastingAbility, abilities: Abilities): MonsterAction {
  const mod = Math.floor((abilities[castingAbility] - 10) / 2);
  const attackBonus = mod + 3;
  if (name === 'Fire Bolt') return { name, type: 'ranged', description: 'Ranged spell attack, 2d10 fire damage.', spellLevel: 0, castingAbility, attackBonus, damage: '2d10', damageType: 'fire', range: { normal: 120, long: 120 }, magical: true, targetScope: 'one_enemy' };
  if (name === 'Ray of Frost') return { name, type: 'ranged', description: 'Ranged spell attack, 2d8 cold damage and the target’s Speed is reduced by 10 feet until your next turn.', spellLevel: 0, castingAbility, attackBonus, damage: '2d8', damageType: 'cold', range: { normal: 60, long: 60 }, magical: true, targetScope: 'one_enemy', buffOnHit: { name: 'Ray of Frost', key: 'ray-of-frost', speedPenalty: 10, expiresOnSourceTurnStart: true } };
  if (name === 'Poison Spray') return { name, type: 'special', description: `CON save DC ${8 + attackBonus}; 2d12 poison damage.`, spellLevel: 0, castingAbility, damageType: 'poison', savingThrow: { ability: 'con', dc: 8 + attackBonus, damageOnFail: '2d12' }, range: { normal: 10, long: 10 }, targetScope: 'one_enemy' };
  if (name === 'Produce Flame') return { name, type: 'ranged', description: 'Ranged spell attack, 2d8 fire damage.', spellLevel: 0, castingAbility, attackBonus, damage: '2d8', damageType: 'fire', range: { normal: 60, long: 60 }, magical: true, targetScope: 'one_enemy' };
  if (name === 'Shocking Grasp') return { name, type: 'melee', description: 'Melee spell attack, 2d8 lightning damage. The target cannot take Reactions until your next turn.', spellLevel: 0, castingAbility, attackBonus, damage: '2d8', damageType: 'lightning', reach: 5, magical: true, targetScope: 'one_enemy', buffOnHit: { name: 'Shocking Grasp', key: 'shocking-grasp', preventsReactions: true, expiresOnSourceTurnStart: true } };
  return { name, type: 'ranged', description: 'Ranged spell attack, 2d8 necrotic damage. The target cannot regain HP until your next turn.', spellLevel: 0, castingAbility, attackBonus, damage: '2d8', damageType: 'necrotic', range: { normal: 120, long: 120 }, magical: true, targetScope: 'one_enemy', effects: [{ kind: 'blocksHealing', key: 'Chill Touch', tick: 'sourceTurnStart', expiresAfterRounds: 1 }] };
}

function tieflingCantrip(legacy: TieflingLegacy, castingAbility: CastingAbility, abilities: Abilities): MonsterAction {
  return damagingCantrip(legacy === 'Infernal' ? 'Fire Bolt' : legacy === 'Abyssal' ? 'Poison Spray' : 'Chill Touch', castingAbility, abilities);
}

function highElfCantrip(name: Exclude<SupportedDamageCantrip, 'Produce Flame'>, castingAbility: CastingAbility, abilities: Abilities): MonsterAction {
  return damagingCantrip(name, castingAbility, abilities);
}

function chthonicFalseLife(castingAbility: CastingAbility): MonsterAction {
  return { name: 'False Life', type: 'special', description: 'Gain 2d4 plus spellcasting ability modifier temporary HP.', spellLevel: 1, castingAbility, resourceCost: { key: 'chthonic-false-life', amount: 1 }, temporaryHp: { dice: '2d4', addCastingMod: true }, targetScope: 'self' };
}

function chthonicRayOfEnfeeblement(castingAbility: CastingAbility, abilities: Abilities): MonsterAction {
  const dc = 8 + Math.floor((abilities[castingAbility] - 10) / 2) + 3;
  return {
    name: 'Ray of Enfeeblement', type: 'special', description: `60-foot ray, CON save DC ${dc}. A failed save gives Disadvantage on Strength tests and subtracts 1d8 from damage rolls; it repeats the save at the end of each turn.`,
    spellLevel: 2, spellSchool: 'necromancy', castingAbility, range: { normal: 60, long: 60 }, targetScope: 'one_enemy', savingThrow: { ability: 'con', dc }, durationRounds: 10,
    buffOnFailedSave: { name: 'Ray of Enfeeblement', key: 'chthonic-ray-of-enfeeblement', requiresConcentration: true, strengthTestDisadvantage: true, damageRollPenalty: '1d8', saveEnds: { ability: 'con', dc, at: 'targetTurnEnd' } },
    buffOnSuccessfulSave: { name: 'Ray of Enfeeblement', key: 'chthonic-ray-of-enfeeblement-success', attackDisadvantage: true, expiresOnSourceTurnStart: true },
  };
}

function woodElfLongstrider(castingAbility: CastingAbility): MonsterAction {
  return { name: 'Longstrider', type: 'special', description: 'Your Speed increases by 10 feet for 1 hour.', spellLevel: 1, castingAbility, resourceCost: { key: 'wood-elf-longstrider', amount: 1 }, targetScope: 'self', durationRounds: 600, buff: { name: 'Longstrider', key: 'wood-elf-longstrider', speedBonus: 10 } };
}

function woodElfPassWithoutTrace(castingAbility: CastingAbility): MonsterAction {
  return { name: 'Pass without Trace', type: 'special', description: 'You and allies within 30 feet gain +10 to Dexterity (Stealth) checks for 1 hour. Concentration.', spellLevel: 2, castingAbility, resourceCost: { key: 'wood-elf-pass-without-trace', amount: 1 }, range: { normal: 30, long: 30 }, targetScope: 'all_allies_in_area', durationRounds: 600, buff: { name: 'Pass without Trace', key: 'wood-elf-pass-without-trace', requiresConcentration: true, stealthBonus: 10 } };
}

function abyssalRayOfSickness(castingAbility: CastingAbility, abilities: Abilities): MonsterAction {
  const attackBonus = Math.floor((abilities[castingAbility] - 10) / 2) + 3;
  return { name: 'Ray of Sickness', type: 'ranged', description: 'Ranged spell attack, 2d8 poison damage. On a hit, the target is Poisoned until the end of your next turn.', spellLevel: 1, castingAbility, attackBonus, damage: '2d8', damageType: 'poison', magical: true, range: { normal: 60, long: 60 }, targetScope: 'one_enemy', resourceCost: { key: 'abyssal-ray-of-sickness', amount: 1 }, conditionOnHit: { condition: 'poisoned', duration: 'end_of_next_turn' } };
}

/** A lineage's daily free cast remains available as a normal slot cast. */
function lineageSpellActions(action: MonsterAction): MonsterAction[] {
  return [action, { ...action, resourceCost: undefined }];
}

function magicInitiateActions(
  feat: string | undefined,
  cantrips: unknown,
  spell: unknown,
  castingAbility: unknown,
  abilities: Abilities,
  label: string,
  resourceKey: string,
): { actions: MonsterAction[]; resources: Record<string, number> } | undefined {
  if (feat !== 'Magic Initiate (Cleric)' && feat !== 'Magic Initiate (Druid)' && feat !== 'Magic Initiate (Wizard)') return undefined;
  const list = feat === 'Magic Initiate (Cleric)' ? 'Cleric' : feat === 'Magic Initiate (Druid)' ? 'Druid' : 'Wizard';
  const allowedCantrips = list === 'Cleric' ? ['Sacred Flame', 'Toll the Dead'] : list === 'Druid' ? ['Poison Spray', 'Produce Flame'] : ['Chill Touch', 'Fire Bolt', 'Poison Spray', 'Ray of Frost', 'Shocking Grasp'];
  const allowedSpells = list === 'Cleric'
    ? ['Bless', 'Cure Wounds', 'Healing Word', 'Shield of Faith', 'Guiding Bolt']
    : list === 'Druid'
      ? ['Cure Wounds', 'Healing Word', 'Entangle', 'Thunderwave']
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
    : damagingCantrip(name as SupportedDamageCantrip, castingAbility as CastingAbility, abilities);
  const levelOne = spell === 'Bless' ? bless() : spell === 'Cure Wounds' ? cureWounds(castingAbility as CastingAbility, mod, pb) : spell === 'Healing Word' ? healingWord(castingAbility as CastingAbility, mod, pb) : spell === 'Shield of Faith' ? shieldOfFaith() : spell === 'Guiding Bolt' ? guidingBolt(castingAbility as CastingAbility, mod, pb) : spell === 'Entangle' ? entangle(castingAbility as CastingAbility, mod, pb) : spell === 'Magic Missile' ? magicMissile() : spell === 'Burning Hands' ? burningHands(castingAbility as CastingAbility, mod, pb) : spell === 'Thunderwave' ? thunderwave(castingAbility as CastingAbility, mod, pb) : sleep(castingAbility as CastingAbility, mod, pb);
  return {
    actions: [
      ...cantrips.map(makeCantrip),
      { ...levelOne, resourceCost: { key: resourceKey, amount: 1 } },
      { ...levelOne, name: `${levelOne.name} (Spell Slot)` },
    ],
    resources: { [resourceKey]: 1 },
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
    if (!Object.keys(character).every(key => ['heroClass', 'abilities', 'subclass', 'spells', 'weapons', 'armor', 'shield', 'species', 'background', 'abilityIncreases', 'alignment', 'dragonAncestry', 'elfLineage', 'highElfCantrip', 'gnomeLineage', 'goliathAncestry', 'tieflingLegacy', 'speciesCastingAbility', 'size', 'languages', 'elfKeenSense', 'humanSkill', 'originCantrips', 'originSpell', 'originCastingAbility', 'humanOriginFeat', 'humanOriginSkills', 'humanOriginTools', 'humanOriginCantrips', 'humanOriginSpell', 'humanOriginCastingAbility'].includes(key))) {
      throw new EncounterError(`${label} contains unsupported build choices.`);
    }
    const baseAbilities = parseAbilities(character.abilities, `${label}.abilities`);
    const hasOrigin = character.species !== undefined || character.background !== undefined || character.abilityIncreases !== undefined;
    if (hasOrigin && (typeof character.species !== 'string' || !ARENA_SPECIES.includes(character.species as ArenaSpecies) || typeof character.background !== 'string' || !ARENA_BACKGROUNDS.includes(character.background as ArenaBackground))) {
      throw new EncounterError(`${label} must use an SRD species and background together.`);
    }
    const species = character.species as ArenaSpecies | undefined;
    const background = character.background as ArenaBackground | undefined;
    if (character.alignment !== undefined && (typeof character.alignment !== 'string' || !ALIGNMENTS.includes(character.alignment as typeof ALIGNMENTS[number]))) throw new EncounterError(`${label}.alignment must be an SRD alignment.`);
    const alignment = character.alignment as string | undefined;
    if (character.languages !== undefined && (!Array.isArray(character.languages) || character.languages.length !== 2 || character.languages.some(language => typeof language !== 'string' || !LANGUAGES.includes(language as typeof LANGUAGES[number])) || new Set(character.languages).size !== 2)) {
      throw new EncounterError(`${label}.languages must select two distinct SRD languages other than Common.`);
    }
    const languages = character.languages as string[] | undefined;
    const elfKeenSense = character.elfKeenSense as string | undefined;
    const humanSkill = character.humanSkill as string | undefined;
    if (species === 'Elf' && (typeof elfKeenSense !== 'string' || !['Insight', 'Perception', 'Survival'].includes(elfKeenSense))) throw new EncounterError(`${label}.elfKeenSense must be Insight, Perception, or Survival.`);
    if (species !== 'Elf' && elfKeenSense !== undefined) throw new EncounterError(`${label}.elfKeenSense requires Elf.`);
    if (species === 'Human' && (typeof humanSkill !== 'string' || !SKILLS.includes(humanSkill as typeof SKILLS[number]))) throw new EncounterError(`${label}.humanSkill must be an SRD skill.`);
    if (species !== 'Human' && humanSkill !== undefined) throw new EncounterError(`${label}.humanSkill requires Human.`);
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
    const elfLineage = character.elfLineage as ElfLineage | undefined;
    if (species === 'Elf' && !['Drow', 'High Elf', 'Wood Elf'].includes(elfLineage ?? '')) throw new EncounterError(`${label}.elfLineage must be Drow, High Elf, or Wood Elf.`);
    if (species !== 'Elf' && character.elfLineage !== undefined) throw new EncounterError(`${label}.elfLineage requires Elf.`);
    const selectedHighElfCantrip = character.highElfCantrip as string | undefined;
    if (elfLineage === 'High Elf' && selectedHighElfCantrip !== undefined && !['Prestidigitation', 'Chill Touch', 'Fire Bolt', 'Poison Spray', 'Ray of Frost', 'Shocking Grasp'].includes(selectedHighElfCantrip)) throw new EncounterError(`${label}.highElfCantrip must be an engine-supported Wizard cantrip.`);
    if (elfLineage !== 'High Elf' && selectedHighElfCantrip !== undefined) throw new EncounterError(`${label}.highElfCantrip requires High Elf.`);
    const gnomeLineage = character.gnomeLineage as GnomeLineage | undefined;
    if (species === 'Gnome' && !['Forest Gnome', 'Rock Gnome'].includes(gnomeLineage ?? '')) throw new EncounterError(`${label}.gnomeLineage must be Forest Gnome or Rock Gnome.`);
    if (species !== 'Gnome' && character.gnomeLineage !== undefined) throw new EncounterError(`${label}.gnomeLineage requires Gnome.`);
    const goliathAncestry = character.goliathAncestry as GoliathAncestry | undefined;
    if (species === 'Goliath' && !['Cloud', 'Fire', 'Frost', 'Hill', 'Stone', 'Storm'].includes(goliathAncestry ?? '')) throw new EncounterError(`${label}.goliathAncestry must be an SRD Giant Ancestry.`);
    if (species !== 'Goliath' && character.goliathAncestry !== undefined) throw new EncounterError(`${label}.goliathAncestry requires Goliath.`);
    const tieflingLegacy = character.tieflingLegacy as TieflingLegacy | undefined;
    if (species === 'Tiefling' && !['Abyssal', 'Chthonic', 'Infernal'].includes(tieflingLegacy ?? '')) throw new EncounterError(`${label}.tieflingLegacy must be Abyssal, Chthonic, or Infernal.`);
    if (species !== 'Tiefling' && character.tieflingLegacy !== undefined) throw new EncounterError(`${label}.tieflingLegacy requires Tiefling.`);
    const speciesCastingAbility = character.speciesCastingAbility as CastingAbility | undefined;
    if ((species === 'Elf' || species === 'Gnome' || species === 'Tiefling') && !['int', 'wis', 'cha'].includes(speciesCastingAbility ?? '')) throw new EncounterError(`${label}.speciesCastingAbility must be Intelligence, Wisdom, or Charisma.`);
    if (species !== 'Elf' && species !== 'Gnome' && species !== 'Tiefling' && character.speciesCastingAbility !== undefined) throw new EncounterError(`${label}.speciesCastingAbility requires Elf, Gnome, or Tiefling.`);
    const humanOriginFeat = character.humanOriginFeat as string | undefined;
    if (species === 'Human' && !['Alert', 'Magic Initiate (Cleric)', 'Magic Initiate (Druid)', 'Magic Initiate (Wizard)', 'Savage Attacker', 'Skilled'].includes(humanOriginFeat ?? '')) {
      throw new EncounterError(`${label}.humanOriginFeat must be an SRD Origin Feat.`);
    }
    if (species !== 'Human' && (humanOriginFeat !== undefined || character.humanOriginCantrips !== undefined || character.humanOriginSpell !== undefined || character.humanOriginCastingAbility !== undefined)) {
      throw new EncounterError(`${label}.humanOriginFeat requires Human.`);
    }
    const hasHumanOriginSpellChoice = character.humanOriginCantrips !== undefined || character.humanOriginSpell !== undefined || character.humanOriginCastingAbility !== undefined;
    if (hasHumanOriginSpellChoice && (!humanOriginFeat || !['Magic Initiate (Cleric)', 'Magic Initiate (Druid)', 'Magic Initiate (Wizard)'].includes(humanOriginFeat))) {
      throw new EncounterError(`${label} human origin spell choices require a Magic Initiate feat.`);
    }
    const humanOriginSkills = character.humanOriginSkills as string[] | undefined;
    const humanOriginTools = character.humanOriginTools as string[] | undefined;
    if (humanOriginSkills !== undefined && !Array.isArray(humanOriginSkills)) throw new EncounterError(`${label}.humanOriginSkills must be an array.`);
    if (humanOriginTools !== undefined && !Array.isArray(humanOriginTools)) throw new EncounterError(`${label}.humanOriginTools must be an array.`);
    const selectedOriginSkills = humanOriginSkills ?? [];
    const selectedOriginTools = humanOriginTools ?? [];
    if (humanOriginFeat === 'Skilled' && (selectedOriginSkills.length + selectedOriginTools.length !== 3 || new Set(selectedOriginSkills).size !== selectedOriginSkills.length || new Set(selectedOriginTools).size !== selectedOriginTools.length || selectedOriginSkills.some(skill => !SKILLS.includes(skill as typeof SKILLS[number])) || selectedOriginTools.some(tool => !TOOLS.includes(tool as typeof TOOLS[number])))) {
      throw new EncounterError(`${label}.humanOriginSkills and .humanOriginTools must select three distinct SRD skills or tools for Skilled.`);
    }
    if (humanOriginFeat !== 'Skilled' && humanOriginSkills !== undefined) throw new EncounterError(`${label}.humanOriginSkills requires Skilled.`);
    if (humanOriginFeat !== 'Skilled' && humanOriginTools !== undefined) throw new EncounterError(`${label}.humanOriginTools requires Skilled.`);
    let abilities = baseAbilities;
    if (hasOrigin) {
      const increases = assertArenaObject(character.abilityIncreases, `${label}.abilityIncreases`) as Partial<Record<AbilityName, 0 | 1 | 2>>;
      try {
        abilities = applyBackgroundIncreases(baseAbilities, background!, increases);
      } catch (error) {
        throw new EncounterError(error instanceof Error ? error.message : String(error));
      }
    }
    const heroClass = character.heroClass as typeof HERO_CLASS_NAMES[number];
    if (character.armor !== undefined && (typeof character.armor !== 'string' || !(character.armor in ARENA_ARMOR))) throw new EncounterError(`${label}.armor must select catalog armor.`);
    const armor = character.armor as keyof typeof ARENA_ARMOR | undefined;
    if (character.shield !== undefined && typeof character.shield !== 'boolean') throw new EncounterError(`${label}.shield must be boolean.`);
    if (character.shield === true && !SHIELD_TRAINING.has(heroClass)) throw new EncounterError(`${label}.shield requires shield proficiency.`);
    if (armor && !ARMOR_TRAINING[heroClass].includes(ARENA_ARMOR[armor].category)) throw new EncounterError(`${label}.armor includes armor your class is not proficient with.`);
    if (character.weapons !== undefined && (!Array.isArray(character.weapons) || character.weapons.length < 1 || character.weapons.length > 2 || character.weapons.some(name => typeof name !== 'string' || !ARENA_WEAPONS[name]))) throw new EncounterError(`${label}.weapons must select one or two catalog weapons.`);
    const weapons = (character.weapons as string[] | undefined)?.map(name => ARENA_WEAPONS[name]!);
    if (weapons?.some(weapon => !isWeaponProficient(heroClass, weapon))) throw new EncounterError(`${label}.weapons includes a weapon your class is not proficient with.`);
    if (character.shield === true && weapons?.some(weapon => weapon.twoHanded)) throw new EncounterError(`${label}.shield cannot be used with a selected two-handed weapon.`);
    if (character.subclass !== undefined && (typeof character.subclass !== 'string' || !SRD_SUBCLASSES[heroClass].includes(character.subclass))) {
      throw new EncounterError(`${label}.subclass is not an SRD subclass for ${heroClass}.`);
    }
    const spells = parseSpells(character.spells, heroClass, label);
    const hasOriginSpellChoice = character.originCantrips !== undefined || character.originSpell !== undefined || character.originCastingAbility !== undefined;
    if (hasOriginSpellChoice && (!background || !['Magic Initiate (Cleric)', 'Magic Initiate (Wizard)'].includes(BACKGROUNDS[background].originFeat))) {
      throw new EncounterError(`${label} origin spell choices require a Magic Initiate background.`);
    }
    const origin = species && background ? magicInitiateActions(BACKGROUNDS[background].originFeat, character.originCantrips, character.originSpell, character.originCastingAbility, abilities, label, 'magic-initiate:background') : undefined;
    if (species === 'Human' && humanOriginFeat === BACKGROUNDS[background!]?.originFeat) throw new EncounterError(`${label}.humanOriginFeat must differ from the background Origin Feat.`);
    const humanOrigin = species === 'Human' ? magicInitiateActions(humanOriginFeat, character.humanOriginCantrips, character.humanOriginSpell, character.humanOriginCastingAbility, abilities, label, 'magic-initiate:human') : undefined;
    return {
      heroClass, heroLevel: 5, team,
      heroOverrides: {
        abilities, subclass: character.subclass as HeroSubclassName | undefined, spells, weapons: toWeaponOverrides(weapons, character.shield === false), ...(armor ? { armorBaseOverride: ARENA_ARMOR[armor].armorBase, armorDexCapOverride: ARENA_ARMOR[armor].dexCap, ...(ARENA_ARMOR[armor].minimumStrength && abilities.str < ARENA_ARMOR[armor].minimumStrength ? { speedPenaltyOverride: 10 } : {}) } : {}), ...(character.shield !== undefined ? { shieldOverride: character.shield as boolean } : {}),
        ...(species && background ? {
          species, speciesChoice: elfLineage ?? gnomeLineage ?? goliathAncestry ?? tieflingLegacy ?? character.dragonAncestry as string | undefined, speciesCastingAbility, background, originFeat: BACKGROUNDS[background].originFeat, originFeats: [BACKGROUNDS[background].originFeat, ...(humanOriginFeat ? [humanOriginFeat] : [])], originSkills: [...new Set([...BACKGROUNDS[background].skills, ...(elfKeenSense ? [elfKeenSense] : []), ...(humanSkill ? [humanSkill] : []), ...selectedOriginSkills])], originTool: BACKGROUNDS[background].tool, originTools: [...new Set([BACKGROUNDS[background].tool, ...selectedOriginTools])],
          originEquipment: [...BACKGROUNDS[background].equipment], alignmentOverride: alignment, additionalSenses: speciesDarkvision(species, elfLineage), additionalLanguages: languages, speciesCantrips: lineageSpells(species, elfLineage ?? gnomeLineage ?? tieflingLegacy, selectedHighElfCantrip).cantrips, speciesPreparedSpells: lineageSpells(species, elfLineage ?? gnomeLineage ?? tieflingLegacy).prepared, sizeOverride: size ?? SPECIES[species].size, speedOverride: elfLineage === 'Wood Elf' ? 35 : SPECIES[species].speed,
          hitPointBonus: SPECIES[species].maxHpBonusAtLevel5 ?? 0, additionalResistances: tieflingLegacy ? [{ Abyssal: 'poison', Chthonic: 'necrotic', Infernal: 'fire' }[tieflingLegacy]] : SPECIES[species].resistances ? [...SPECIES[species].resistances] : undefined,
          additionalResources: { 'hit-die': 5, ...(species === 'Human' ? { 'heroic-inspiration': 1 } : {}), ...(species === 'Dwarf' ? { 'dwarf-stonecunning': 3 } : {}), ...(species === 'Orc' ? { 'orc-adrenaline-rush': 3 } : {}), ...(species === 'Goliath' ? { 'goliath-large-form': 1, 'goliath-giant-ancestry': 3 } : {}), ...(species === 'Elf' && elfLineage === 'Drow' ? { 'drow-faerie-fire': 1, 'drow-darkness': 1 } : {}), ...(species === 'Elf' && elfLineage === 'High Elf' ? { 'high-elf-misty-step': 1 } : {}), ...(species === 'Elf' && elfLineage === 'Wood Elf' ? { 'wood-elf-longstrider': 1, 'wood-elf-pass-without-trace': 1 } : {}), ...(species === 'Tiefling' && tieflingLegacy === 'Abyssal' ? { 'abyssal-ray-of-sickness': 1, 'abyssal-hold-person': 1 } : {}), ...(species === 'Tiefling' && tieflingLegacy === 'Chthonic' ? { 'chthonic-false-life': 1, 'chthonic-ray-of-enfeeblement': 1 } : {}), ...(species === 'Tiefling' && tieflingLegacy === 'Infernal' ? { 'infernal-hellish-rebuke': 1, 'infernal-darkness': 1 } : {}), ...(origin?.resources ?? {}), ...(humanOrigin?.resources ?? {}) },
          additionalActions: [...(species === 'Dragonborn' ? [dragonbornBreath(character.dragonAncestry as DragonAncestry, abilities)] : []), ...(species === 'Elf' && elfLineage === 'High Elf' && selectedHighElfCantrip && selectedHighElfCantrip !== 'Prestidigitation' ? [highElfCantrip(selectedHighElfCantrip as Exclude<SupportedDamageCantrip, 'Produce Flame'>, speciesCastingAbility!, abilities)] : []), ...(species === 'Elf' && elfLineage === 'Drow' ? [...lineageSpellActions(drowFaerieFire(speciesCastingAbility!, abilities)), ...lineageSpellActions(lineageDarkness('drow-darkness'))] : []), ...(species === 'Elf' && elfLineage === 'Wood Elf' ? [...lineageSpellActions(woodElfLongstrider(speciesCastingAbility!)), ...lineageSpellActions(woodElfPassWithoutTrace(speciesCastingAbility!))] : []), ...(species === 'Tiefling' ? [tieflingCantrip(tieflingLegacy!, speciesCastingAbility!, abilities)] : []), ...(species === 'Tiefling' && tieflingLegacy === 'Abyssal' ? [...lineageSpellActions(abyssalRayOfSickness(speciesCastingAbility!, abilities)), ...lineageSpellActions({ ...holdPerson(speciesCastingAbility!, Math.floor((abilities[speciesCastingAbility!] - 10) / 2), 3), resourceCost: { key: 'abyssal-hold-person', amount: 1 } })] : []), ...(species === 'Tiefling' && tieflingLegacy === 'Chthonic' ? [...lineageSpellActions(chthonicFalseLife(speciesCastingAbility!)), ...lineageSpellActions(chthonicRayOfEnfeeblement(speciesCastingAbility!, abilities))] : []), ...(species === 'Tiefling' && tieflingLegacy === 'Infernal' ? lineageSpellActions(lineageDarkness('infernal-darkness')) : []), ...(origin?.actions ?? []), ...(humanOrigin?.actions ?? [])],
          ...(species === 'Dragonborn' ? { additionalResistances: [character.dragonAncestry as DragonAncestry], additionalResources: { 'hit-die': 5, ...(origin?.resources ?? {}), ...(humanOrigin?.resources ?? {}), 'dragonborn-breath': 3, 'dragonborn-flight': 1 } } : {}),
        } : {}),
      },
    };
  });
}

export function validateArenaParty(value: unknown, team: Team): void {
  parseArenaParty(value, team);
}
