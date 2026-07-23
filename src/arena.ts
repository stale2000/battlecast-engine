import { Encounter, EncounterError, type AddCreatureOptions, type SerializedEncounter, type Team } from './api/encounter.js';
import { applyLegalAction, getActiveCreature, getLegalActions, sameArenaAction, startArena, type ArenaAction } from './api/arena.js';
import { buildHero, getAvailableSpells, HERO_CLASS_NAMES } from './data/heroes.js';
import { ARENA_BACKGROUNDS, ARENA_SPECIES, BACKGROUNDS, SPECIES, applyBackgroundIncreases, type AbilityName, type ArenaBackground, type ArenaSpecies } from './data/arena-origins.js';
import type { Abilities, Creature, MonsterAction } from './types/monster.js';

export const ARENA_PROTOCOL_VERSION = 1;
export const ARENA_ROUND_CAP = 20;

type SlotCharacter = { slot: 1 | 2 | 3 | 4 };
type DragonAncestry = 'acid' | 'cold' | 'fire' | 'lightning' | 'poison';
type ArenaHero = { heroClass: string; abilities: Abilities; subclass?: string; spells?: string[]; species?: ArenaSpecies; background?: ArenaBackground; abilityIncreases?: Partial<Record<AbilityName, 0 | 1 | 2>>; dragonAncestry?: DragonAncestry };
type Character = SlotCharacter | ArenaHero;
type Party = { characters: Character[] };
type Request =
  | { version: 1; mode: 'init'; seed: number; mapId: string; roundCap: number; redParty: Party; blueParty: Party }
  | { version: 1; mode: 'step'; state: SerializedEncounter; team: Team; action: string | ArenaAction };

const SLOT_PARTY: Record<1 | 2 | 3 | 4, AddCreatureOptions> = {
  1: { heroClass: 'Fighter', heroLevel: 5, team: 'red' },
  2: { heroClass: 'Cleric', heroLevel: 5, team: 'red' },
  3: { heroClass: 'Wizard', heroLevel: 5, team: 'red' },
  4: { heroClass: 'Rogue', heroLevel: 5, team: 'red' },
};
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const POINT_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
const DRAGON_DAMAGE_TYPES = ['acid', 'cold', 'fire', 'lightning', 'poison'] as const;

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EncounterError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function parseAbilities(value: unknown, label: string): Abilities {
  const abilities = assertObject(value, label);
  if (Object.keys(abilities).length !== ABILITIES.length || !ABILITIES.every(key => typeof abilities[key] === 'number' && Number.isInteger(abilities[key]) && abilities[key] in POINT_COST)) {
    throw new EncounterError(`${label} must contain each ability from 8 through 15.`);
  }
  const total = ABILITIES.reduce((sum, key) => sum + POINT_COST[abilities[key] as number], 0);
  if (total !== 27) throw new EncounterError(`${label} must use exactly 27-point buy.`);
  return Object.fromEntries(ABILITIES.map(key => [key, abilities[key]])) as unknown as Abilities;
}

export function validateArenaParty(value: unknown, team: Team): void {
  parseParty(value, team);
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
    savingThrow: { ability: 'dex', dc, damageOnFail: '2d10', damageOnSuccess: 'half', area: '15-foot cone' },
  };
}

function parseParty(value: unknown, team: Team): AddCreatureOptions[] {
  const party = assertObject(value, `${team}Party`);
  if (!Array.isArray(party.characters) || party.characters.length !== 4) {
    throw new EncounterError(`${team}Party.characters must contain exactly four characters.`);
  }
  const slots = new Set<number>();
  return party.characters.map((value, index) => {
    const character = assertObject(value, `${team}Party.characters[${index}]`);
    if (typeof character.slot === 'number') {
      if (Object.keys(character).length !== 1 || !Number.isInteger(character.slot) || character.slot < 1 || character.slot > 4 || slots.has(character.slot)) {
        throw new EncounterError(`${team}Party slot characters must use each slot 1 through 4 once.`);
      }
      slots.add(character.slot);
      return { ...SLOT_PARTY[character.slot as 1 | 2 | 3 | 4], team };
    }
    if (typeof character.heroClass !== 'string' || !HERO_CLASS_NAMES.includes(character.heroClass as typeof HERO_CLASS_NAMES[number])) {
      throw new EncounterError(`${team}Party.characters[${index}].heroClass must be a supported hero class.`);
    }
    if (!Object.keys(character).every(key => key === 'heroClass' || key === 'abilities' || key === 'subclass' || key === 'spells' || key === 'species' || key === 'background' || key === 'abilityIncreases' || key === 'dragonAncestry')) {
      throw new EncounterError(`${team}Party.characters[${index}] contains unsupported build choices.`);
    }
    const baseAbilities = parseAbilities(character.abilities, `${team}Party.characters[${index}].abilities`);
    const hasOrigin = character.species !== undefined || character.background !== undefined || character.abilityIncreases !== undefined;
    if (hasOrigin && (typeof character.species !== 'string' || !ARENA_SPECIES.includes(character.species as ArenaSpecies) || typeof character.background !== 'string' || !ARENA_BACKGROUNDS.includes(character.background as ArenaBackground))) {
      throw new EncounterError(`${team}Party.characters[${index}] must use an SRD species and background together.`);
    }
    const species = character.species as ArenaSpecies | undefined;
    const background = character.background as ArenaBackground | undefined;
    if (species === 'Dragonborn' && (typeof character.dragonAncestry !== 'string' || !DRAGON_DAMAGE_TYPES.includes(character.dragonAncestry as DragonAncestry))) {
      throw new EncounterError(`${team}Party.characters[${index}].dragonAncestry must be an SRD damage type.`);
    }
    if (species !== 'Dragonborn' && character.dragonAncestry !== undefined) throw new EncounterError(`${team}Party.characters[${index}].dragonAncestry requires Dragonborn.`);
    let abilities = baseAbilities;
    if (hasOrigin) {
      const increases = assertObject(character.abilityIncreases, `${team}Party.characters[${index}].abilityIncreases`) as Partial<Record<AbilityName, 0 | 1 | 2>>;
      try {
        abilities = applyBackgroundIncreases(baseAbilities, background!, increases);
      } catch (error) {
        throw new EncounterError(error instanceof Error ? error.message : String(error));
      }
    }
    if (character.subclass !== undefined && (character.heroClass !== 'Druid' || (character.subclass !== 'Circle of the Land' && character.subclass !== 'Circle of the Moon'))) {
      throw new EncounterError(`${team}Party.characters[${index}].subclass is not supported.`);
    }
    const heroClass = character.heroClass as typeof HERO_CLASS_NAMES[number];
    const spells = parseSpells(character.spells, heroClass, `${team}Party.characters[${index}]`);
    return {
      heroClass: character.heroClass,
      heroLevel: 5,
      heroOverrides: {
        abilities, subclass: character.subclass as 'Circle of the Land' | 'Circle of the Moon' | undefined, spells,
        ...(species && background ? {
          species, background, originFeat: BACKGROUNDS[background].originFeat, originSkills: [...BACKGROUNDS[background].skills], originTool: BACKGROUNDS[background].tool,
          originEquipment: [...BACKGROUNDS[background].equipment], sizeOverride: SPECIES[species].size, speedOverride: SPECIES[species].speed,
          hitPointBonus: SPECIES[species].maxHpBonusAtLevel5, additionalResistances: SPECIES[species].resistances ? [...SPECIES[species].resistances] : undefined,
          additionalResources: species === 'Orc' ? { 'orc-adrenaline-rush': 3 } : undefined,
          additionalActions: species === 'Dragonborn' ? [dragonbornBreath(character.dragonAncestry as DragonAncestry, abilities)] : undefined,
          ...(species === 'Dragonborn' ? { additionalResistances: [character.dragonAncestry as DragonAncestry], additionalResources: { 'dragonborn-breath': 3, 'dragonborn-flight': 1 } } : {}),
        } : {}),
      },
      team,
    };
  });
}

function status(creature: Creature): 'ok' | 'bloodied' | 'dying' | 'dead' {
  if (!creature.isAlive) return 'dead';
  if (creature.deathSaves) return 'dying';
  return creature.currentHp * 2 <= creature.maxHp ? 'bloodied' : 'ok';
}

function visibleEquipment(creature: Creature): string[] {
  return [...new Set(creature.monsterData.actions
    .filter(action => action.attackBonus !== undefined && action.spellLevel === undefined)
    .map(action => action.name))];
}

function preparedSpells(creature: Creature): string[] {
  return [...new Set(creature.monsterData.actions
    .filter(action => (action.spellLevel ?? 0) > 0)
    .map(action => action.name))];
}

function observation(encounter: Encounter, team: Team) {
  const state = encounter.state!;
  const active = getActiveCreature(encounter);
  const complete = encounter.phase === 'complete';
  const creature = (c: Creature) => c.team === team
    ? {
        id: c.id, name: c.displayName, team: c.team, hp: `${c.currentHp}/${c.maxHp}`, temporaryHp: c.temporaryHp ?? 0,
        position: { ...c.position }, size: c.monsterData.size, conditions: [...c.conditions], status: status(c), resources: { ...c.resources },
        build: {
          heroClass: c.monsterData.heroClass, heroLevel: c.monsterData.heroLevel, heroSubclass: c.monsterData.heroSubclass,
          species: c.monsterData.heroSpecies, background: c.monsterData.heroBackground, originFeat: c.monsterData.originFeat,
          abilities: { ...c.monsterData.abilities }, ac: c.monsterData.ac, speed: { ...c.monsterData.speed },
          equipment: visibleEquipment(c), preparedSpells: preparedSpells(c),
        },
      }
    : {
        id: c.id, name: c.displayName, team: c.team, position: { ...c.position }, size: c.monsterData.size,
        conditions: [...c.conditions], status: status(c), creatureType: c.monsterData.type, visibleEquipment: visibleEquipment(c),
      };
  return {
    phase: complete ? 'complete' : 'combat',
    round: state.round,
    activeCreatureIds: active?.team === team ? [active.id] : [],
    publicCombatState: {
      teams: {
        red: { alive: state.creatures.filter(c => c.team === 'red' && c.isAlive).length, total: state.creatures.filter(c => c.team === 'red').length },
        blue: { alive: state.creatures.filter(c => c.team === 'blue' && c.isAlive).length, total: state.creatures.filter(c => c.team === 'blue').length },
      },
      creatures: state.creatures.map(creature),
      winner: state.winner,
    },
    legalActions: active?.team === team ? getLegalActions(encounter, active.id) : [],
  };
}

function response(encounter: Encounter) {
  const active = getActiveCreature(encounter);
  const complete = encounter.phase === 'complete';
  const reward = (team: Team) => !complete || encounter.state!.winner === 'draw' ? 0 : encounter.state!.winner === team ? 1 : -1;
  return {
    state: encounter.toJSON(),
    observations: { red: observation(encounter, 'red'), blue: observation(encounter, 'blue') },
    statuses: complete ? { red: 'DONE', blue: 'DONE' } : { red: active?.team === 'red' ? 'ACTIVE' : 'INACTIVE', blue: active?.team === 'blue' ? 'ACTIVE' : 'INACTIVE' },
    rewards: { red: reward('red'), blue: reward('blue') },
  };
}

function parseAction(value: unknown): ArenaAction {
  if (typeof value === 'string') return { id: value, type: 'end_turn' } as ArenaAction;
  const action = assertObject(value, 'action');
  if (typeof action.id !== 'string') throw new EncounterError('action must be a legal action id or action object with an id.');
  if (action.id === 'move_to') {
    if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) throw new EncounterError('move_to requires integer x and y.');
    return { id: 'move_to', type: 'move_to', destination: { x: action.x as number, y: action.y as number } };
  }
  return action as ArenaAction;
}

/** Handles one versioned, trusted-host Kaggle request without process I/O. */
export function kaggleStep(value: unknown) {
  const request = assertObject(value, 'request') as Request;
  if (request.version !== ARENA_PROTOCOL_VERSION) throw new EncounterError(`Unsupported arena protocol version ${String(request.version)}.`);
  if (request.mode === 'init') {
    if (!Number.isInteger(request.seed) || request.roundCap !== ARENA_ROUND_CAP || request.mapId !== 'open-arena') {
      throw new EncounterError(`init requires an integer seed, roundCap ${ARENA_ROUND_CAP}, and mapId "open-arena".`);
    }
    const red = parseParty(request.redParty, 'red');
    const blue = parseParty(request.blueParty, 'blue');
    const encounter = new Encounter({ seed: request.seed, gridSize: 20 });
    for (const character of [...red, ...blue]) encounter.addCreature(character);
    encounter.setArenaRoundCap(request.roundCap);
    encounter.start();
    startArena(encounter);
    return response(encounter);
  }
  if (request.mode === 'step') {
    if (request.team !== 'red' && request.team !== 'blue') throw new EncounterError('step.team must be red or blue.');
    const encounter = Encounter.fromJSON(request.state);
    if (encounter.getArenaRoundCap() !== ARENA_ROUND_CAP) {
      throw new EncounterError(`Arena state must use roundCap ${ARENA_ROUND_CAP}.`);
    }
    const active = getActiveCreature(encounter);
    if (!active || active.team !== request.team) throw new EncounterError('The submitted team does not own the active creature.');
    const requested = parseAction(request.action);
    const legal = getLegalActions(encounter, active.id).find(action => action.id === requested.id);
    if (!legal || (legal.type !== 'move_to' && typeof request.action === 'object' && !sameArenaAction(legal, requested))) throw new EncounterError(`Illegal or stale arena action "${requested.id}".`);
    applyLegalAction(encounter, legal.type === 'move_to' ? requested : legal);
    return response(encounter);
  }
  throw new EncounterError('mode must be init or step.');
}
