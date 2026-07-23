import { Encounter, EncounterError, type SerializedEncounter, type Team } from './api/encounter.js';
import { applyLegalAction, getActiveCreature, getLegalActions, sameArenaAction, startArena, type ArenaAction } from './api/arena.js';
import { assertArenaObject, parseArenaParty } from './api/arena-construction.js';
export { validateArenaParty } from './api/arena-construction.js';
import type { Creature } from './types/monster.js';
import { getActiveSize } from './engine/combat.js';

export const ARENA_PROTOCOL_VERSION = 1;
export const ARENA_ROUND_CAP = 20;

type Party = { characters: unknown[] };
type Request =
  | { version: 1; mode: 'init'; seed: number; mapId: string; roundCap: number; redParty: Party; blueParty: Party }
  | { version: 1; mode: 'step'; state: SerializedEncounter; team: Team; action: string | ArenaAction };


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
    .map(action => action.name).concat(creature.monsterData.speciesPreparedSpells ?? []))];
}

function observation(encounter: Encounter, team: Team) {
  const state = encounter.state!;
  const active = getActiveCreature(encounter);
  const complete = encounter.phase === 'complete';
  const creature = (c: Creature) => c.team === team
    ? {
        id: c.id, name: c.displayName, team: c.team, hp: `${c.currentHp}/${c.maxHp}`, temporaryHp: c.temporaryHp ?? 0,
        position: { ...c.position }, size: getActiveSize(c), conditions: [...c.conditions], status: status(c), resources: { ...c.resources },
        build: {
          heroClass: c.monsterData.heroClass, heroLevel: c.monsterData.heroLevel, heroSubclass: c.monsterData.heroSubclass,
          species: c.monsterData.heroSpecies, speciesChoice: c.monsterData.heroSpeciesChoice, speciesCastingAbility: c.monsterData.heroSpeciesCastingAbility, background: c.monsterData.heroBackground, originFeat: c.monsterData.originFeat, originFeats: c.monsterData.originFeats,
          abilities: { ...c.monsterData.abilities }, ac: c.monsterData.ac, speed: { ...c.monsterData.speed },
          equipment: visibleEquipment(c), cantrips: c.monsterData.speciesCantrips, preparedSpells: preparedSpells(c),
        },
      }
    : {
        id: c.id, name: c.displayName, team: c.team, position: { ...c.position }, size: getActiveSize(c),
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
  const action = assertArenaObject(value, 'action');
  if (typeof action.id !== 'string') throw new EncounterError('action must be a legal action id or action object with an id.');
  if (action.id === 'move_to') {
    if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) throw new EncounterError('move_to requires integer x and y.');
    return { id: 'move_to', type: 'move_to', destination: { x: action.x as number, y: action.y as number } };
  }
  if (action.id === 'species:cloud_jaunt') {
    if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) throw new EncounterError("Cloud's Jaunt requires integer x and y.");
    return { id: 'species:cloud_jaunt', type: 'species_teleport', destination: { x: action.x as number, y: action.y as number } };
  }
  return action as ArenaAction;
}

/** Handles one versioned, trusted-host Kaggle request without process I/O. */
export function kaggleStep(value: unknown) {
  const request = assertArenaObject(value, 'request') as Request;
  if (request.version !== ARENA_PROTOCOL_VERSION) throw new EncounterError(`Unsupported arena protocol version ${String(request.version)}.`);
  if (request.mode === 'init') {
    if (!Number.isInteger(request.seed) || request.roundCap !== ARENA_ROUND_CAP || request.mapId !== 'open-arena') {
      throw new EncounterError(`init requires an integer seed, roundCap ${ARENA_ROUND_CAP}, and mapId "open-arena".`);
    }
    const red = parseArenaParty(request.redParty, 'red');
    const blue = parseArenaParty(request.blueParty, 'blue');
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
    if (!legal || (legal.type !== 'move_to' && legal.type !== 'species_teleport' && typeof request.action === 'object' && !sameArenaAction(legal, requested))) throw new EncounterError(`Illegal or stale arena action "${requested.id}".`);
    applyLegalAction(encounter, legal.type === 'move_to' || legal.type === 'species_teleport' ? requested : legal);
    return response(encounter);
  }
  throw new EncounterError('mode must be init or step.');
}
