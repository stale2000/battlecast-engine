import { Encounter, EncounterError, type AddCreatureOptions, type SerializedEncounter, type Team } from './api/encounter.js';
import { applyLegalAction, getActiveCreature, getLegalActions, sameArenaAction, startArena, type ArenaAction } from './api/arena.js';
import { observeEncounter } from './api/observation.js';

export const ARENA_PROTOCOL_VERSION = 1;

type Character = { slot: 1 | 2 | 3 | 4 } | { heroClass: string; heroLevel?: number } | { monster: string };
type Party = { characters: Character[] };
type Request =
  | { version: 1; mode: 'init'; seed: number; mapId: string; roundCap: number; redParty: Party; blueParty: Party }
  | { version: 1; mode: 'step'; state: SerializedEncounter; team: Team; action: string | ArenaAction };

const SLOT_PARTY: Record<1 | 2 | 3 | 4, AddCreatureOptions> = {
  1: { heroClass: 'Fighter', heroLevel: 1, team: 'red' },
  2: { heroClass: 'Cleric', heroLevel: 1, team: 'red' },
  3: { heroClass: 'Wizard', heroLevel: 1, team: 'red' },
  4: { heroClass: 'Rogue', heroLevel: 1, team: 'red' },
};

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EncounterError(`${label} must be an object.`);
  return value as Record<string, unknown>;
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
      if (!Number.isInteger(character.slot) || character.slot < 1 || character.slot > 4 || slots.has(character.slot)) {
        throw new EncounterError(`${team}Party slot characters must use each slot 1 through 4 once.`);
      }
      slots.add(character.slot);
      return { ...SLOT_PARTY[character.slot as 1 | 2 | 3 | 4], team };
    }
    if (typeof character.monster === 'string' && Object.keys(character).length === 1) return { monster: character.monster, team };
    if (typeof character.heroClass === 'string' && (character.heroLevel === undefined || Number.isInteger(character.heroLevel)) &&
        Object.keys(character).every(key => key === 'heroClass' || key === 'heroLevel')) {
      return { heroClass: character.heroClass, heroLevel: character.heroLevel as number | undefined, team };
    }
    throw new EncounterError(`${team}Party.characters[${index}] must be a slot, heroClass, or monster definition.`);
  });
}

function response(encounter: Encounter) {
  const view = observeEncounter(encounter);
  const active = getActiveCreature(encounter);
  const complete = encounter.phase === 'complete';
  const teamObservation = (team: Team) => ({
    phase: complete ? 'complete' : 'combat',
    round: view.round,
    activeCreatureIds: active?.team === team ? [active.id] : [],
    publicCombatState: { teams: view.teams, creatures: view.creatures, winner: view.winner },
    legalActions: active?.team === team ? getLegalActions(encounter, active.id) : [],
  });
  const reward = (team: Team) => !complete || view.winner === 'draw' ? 0 : view.winner === team ? 1 : -1;
  return {
    state: encounter.toJSON(),
    observations: { red: teamObservation('red'), blue: teamObservation('blue') },
    statuses: complete
      ? { red: 'DONE', blue: 'DONE' }
      : { red: active?.team === 'red' ? 'ACTIVE' : 'INACTIVE', blue: active?.team === 'blue' ? 'ACTIVE' : 'INACTIVE' },
    rewards: { red: reward('red'), blue: reward('blue') },
  };
}

function parseAction(value: unknown): ArenaAction {
  if (typeof value === 'string') return { id: value, type: 'end_turn' } as ArenaAction;
  const action = assertObject(value, 'action');
  if (typeof action.id !== 'string') throw new EncounterError('action must be a legal action id or action object with an id.');
  return action as ArenaAction;
}

/** Handles one versioned Kaggle request without process I/O. */
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
    if (!legal || (typeof request.action === 'object' && !sameArenaAction(legal, requested))) {
      throw new EncounterError(`Illegal or stale arena action "${requested.id}".`);
    }
    applyLegalAction(encounter, legal);
    return response(encounter);
  }
  throw new EncounterError('mode must be init or step.');
}
