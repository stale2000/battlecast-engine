import { Encounter, EncounterError, type AddCreatureOptions, type SerializedEncounter, type Team } from './api/encounter.js';
import { applyLegalAction, getActiveCreature, getLegalActions, sameArenaAction, startArena, type ArenaAction } from './api/arena.js';
import { HERO_CLASS_NAMES } from './data/heroes.js';
import type { Abilities, Creature } from './types/monster.js';

export const ARENA_PROTOCOL_VERSION = 1;

type SlotCharacter = { slot: 1 | 2 | 3 | 4 };
type ArenaHero = { heroClass: string; abilities: Abilities; subclass?: string };
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
    if (!Object.keys(character).every(key => key === 'heroClass' || key === 'abilities' || key === 'subclass')) {
      throw new EncounterError(`${team}Party.characters[${index}] contains unsupported build choices.`);
    }
    const abilities = parseAbilities(character.abilities, `${team}Party.characters[${index}].abilities`);
    if (character.subclass !== undefined && (character.heroClass !== 'Druid' || (character.subclass !== 'Circle of the Land' && character.subclass !== 'Circle of the Moon'))) {
      throw new EncounterError(`${team}Party.characters[${index}].subclass is not supported.`);
    }
    return {
      heroClass: character.heroClass,
      heroLevel: 5,
      heroOverrides: { abilities, subclass: character.subclass as 'Circle of the Land' | 'Circle of the Moon' | undefined },
      team,
    };
  });
}

function status(creature: Creature): 'ok' | 'bloodied' | 'dying' | 'dead' {
  if (!creature.isAlive) return 'dead';
  if (creature.deathSaves) return 'dying';
  return creature.currentHp * 2 <= creature.maxHp ? 'bloodied' : 'ok';
}

function observation(encounter: Encounter, team: Team) {
  const state = encounter.state!;
  const active = getActiveCreature(encounter);
  const complete = encounter.phase === 'complete';
  const creature = (c: Creature) => c.team === team
    ? {
        id: c.id, name: c.displayName, team: c.team, hp: `${c.currentHp}/${c.maxHp}`, temporaryHp: c.temporaryHp ?? 0,
        position: { ...c.position }, size: c.monsterData.size, conditions: [...c.conditions], status: status(c), resources: { ...c.resources },
        build: { heroClass: c.monsterData.heroClass, heroLevel: c.monsterData.heroLevel, heroSubclass: c.monsterData.heroSubclass, abilities: { ...c.monsterData.abilities }, ac: c.monsterData.ac, speed: { ...c.monsterData.speed } },
      }
    : {
        id: c.id, name: c.displayName, team: c.team, position: { ...c.position }, size: c.monsterData.size,
        conditions: [...c.conditions], status: status(c),
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
    if (!Number.isInteger(request.seed) || !Number.isInteger(request.roundCap) || request.roundCap < 1 || request.mapId !== 'open-arena') {
      throw new EncounterError('init requires an integer seed, a positive integer roundCap, and mapId "open-arena".');
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
