import { Encounter, EncounterError, type Team } from './encounter.js';
import {
  checkBattleComplete,
  creatureDistance,
  getAliveCreatures,
  executeSpell,
  hasResource,
  processHydraEndOfTurn,
  processTargetTurnEndOngoingEffects,
  pushLog,
  resolveAttack,
} from '../engine/combat.js';
import { canSee, getActiveActions } from '../engine/ai-targeting.js';
import { moveToDestination, reachableMovementDestinations } from '../engine/ai-movement.js';
import { executeLegendaryAction, handlePassiveAuras, processTurnStart, runOpportunityAttacks } from '../engine/ai-turn.js';
import type { Creature, MonsterAction } from '../types/monster.js';

export type ArenaAction =
  | { id: string; type: 'attack'; actionName: string; actionIndex: number; targetId: string }
  | { id: string; type: 'spell'; actionName: string; actionIndex: number; targetId: string }
  | { id: 'move_to'; type: 'move_to'; destination?: { x: number; y: number } }
  | { id: 'end_turn'; type: 'end_turn' };

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function sameArenaAction(left: ArenaAction, right: ArenaAction): boolean {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}

export function getActiveCreature(encounter: Encounter): Creature | undefined {
  const state = encounter.state;
  if (!state || state.isComplete || state.initiativeOrder.length === 0) return undefined;
  return state.creatures.find(c => c.id === state.initiativeOrder[state.turnIndex % state.initiativeOrder.length]);
}

function attackInRange(attacker: Creature, target: Creature, action: MonsterAction): boolean {
  const distance = creatureDistance(attacker, target);
  return action.type === 'melee'
    ? distance <= (action.reach ?? 5)
    : distance <= (action.range?.long ?? action.range?.normal ?? 0);
}

function isSpellAction(action: MonsterAction): boolean {
  return action.spellLevel !== undefined || action.resourceCost !== undefined || action.layOnHands !== undefined;
}

function canCastArenaSpell(active: Creature, action: MonsterAction): boolean {
  if (action.isBonusAction && active.bonusActionUsed) return false;
  if (active.turnFlags?.bonusActionSpellCast && (action.spellLevel ?? 0) > 0 && !action.isBonusAction) return false;
  if (action.resourceCost && !hasResource(active, action.resourceCost.key, action.resourceCost.amount)) return false;
  if ((action.spellLevel ?? 0) > 0 && !action.resourceCost && !action.atWill) {
    return Array.from({ length: 9 }, (_, index) => index + 1).some(level => level >= (action.spellLevel ?? 0) && hasResource(active, `slot-${level}`));
  }
  return true;
}

function spellTargets(active: Creature, state: NonNullable<Encounter['state']>, action: MonsterAction): Creature[] {
  if (action.autoDarts || action.savingThrow?.area || action.targetScope === 'all_allies_in_area') return [];
  const living = state.creatures.filter(c => c.isAlive && !c.dying);
  if (action.targetScope === 'self') return [active];
  const inRange = (target: Creature) => {
    const range = action.range?.normal;
    return range === undefined || creatureDistance(active, target) <= range;
  };
  if (action.targetScope === 'one_ally' || action.heal || action.layOnHands) {
    return living.filter(c => c.team === active.team && inRange(c) && (action.heal || action.layOnHands ? c.currentHp < c.maxHp || c.dying : true));
  }
  return living.filter(c => c.team !== active.team && attackInRange(active, c, action) && (action.type !== 'ranged' || canSee(state, active, c)));
}

/** The exact, intentionally small set of player-selectable engine actions. */
export function getLegalActions(encounter: Encounter, creatureId: string): ArenaAction[] {
  const state = encounter.state;
  const active = getActiveCreature(encounter);
  if (!state || !active || active.id !== creatureId) return [];
  const enemies = state.creatures.filter(c => c.team !== active.team && c.isAlive && !c.dying);
  const actions: ArenaAction[] = [];
  if (!active.hasActed) {
    for (const [actionIndex, action] of getActiveActions(active).entries()) {
      if (action.legendaryOnly || action.type === 'multiattack') continue;
      if (isSpellAction(action)) {
        if (!canCastArenaSpell(active, action)) continue;
        for (const target of spellTargets(active, state, action)) {
          actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:${target.id}`, type: 'spell', actionName: action.name, actionIndex, targetId: target.id });
        }
        continue;
      }
      if (action.attackBonus === undefined) continue;
      for (const target of enemies) {
        if (!attackInRange(active, target, action) || (action.type === 'ranged' && !canSee(state, active, target))) continue;
        actions.push({ id: `attack:${actionIndex}:${slug(action.name)}:${target.id}`, type: 'attack', actionName: action.name, actionIndex, targetId: target.id });
      }
    }
  }
  if (reachableMovementDestinations(active, state).length) actions.push({ id: 'move_to', type: 'move_to' });
  actions.push({ id: 'end_turn', type: 'end_turn' });
  if (new Set(actions.map(action => action.id)).size !== actions.length) {
    throw new EncounterError(`Arena legal-action id collision for ${active.id}.`);
  }
  return actions;
}

function beginTurn(state: NonNullable<Encounter['state']>, creature: Creature): boolean {
  if (!creature.isAlive) return false;
  if (!processTurnStart(state, creature)) {
    processTargetTurnEndOngoingEffects(state, creature);
    return false;
  }
  handlePassiveAuras(state, creature);
  checkBattleComplete(state);
  return creature.isAlive && !state.isComplete;
}

function advanceTurn(encounter: Encounter): void {
  const state = encounter.state!;
  while (!state.isComplete) {
    state.turnIndex += 1;
    if (state.turnIndex >= state.initiativeOrder.length) {
      state.turnIndex = 0;
      state.round += 1;
      if (state.round > (encounter.getArenaRoundCap() ?? Infinity)) {
        const hp = (team: Team) => state.creatures.filter(c => c.team === team && c.isAlive).reduce((sum, c) => sum + Math.max(c.currentHp, 0), 0);
        state.isComplete = true;
        state.winner = hp('red') === hp('blue') ? 'draw' : hp('red') > hp('blue') ? 'red' : 'blue';
        return;
      }
      for (const creature of getAliveCreatures(state)) {
        if (creature.monsterData.legendaryActions?.length) {
          creature.legendaryActionsRemaining = creature.monsterData.legendaryActionUses || 3;
        }
      }
    }
    const next = getActiveCreature(encounter);
    if (next && beginTurn(state, next)) return;
  }
}

function endTurn(encounter: Encounter, active: Creature): void {
  const state = encounter.state!;
  pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'End Turn', details: `${active.displayName} ends their turn.`, type: 'info' });
  processHydraEndOfTurn(state, active);
  processTargetTurnEndOngoingEffects(state, active);
  checkBattleComplete(state);
  if (state.isComplete) return;
  for (const legend of getAliveCreatures(state)) {
    if (legend.id !== active.id && legend.monsterData.legendaryActions?.length && (legend.legendaryActionsRemaining ?? 0) > 0) {
      executeLegendaryAction(state, legend);
    }
  }
  if (!state.isComplete) advanceTurn(encounter);
}

/** Applies only an action generated by getLegalActions for the current turn. */
export function applyLegalAction(encounter: Encounter, action: ArenaAction): void {
  const state = encounter.state;
  const active = getActiveCreature(encounter);
  if (!state || !active) throw new EncounterError('No active creature.');
  const legal = getLegalActions(encounter, active.id).find(candidate => candidate.id === action.id);
  if (!legal || (legal.type !== 'move_to' && !sameArenaAction(legal, action))) {
    throw new EncounterError(`Illegal or stale arena action "${action.id}".`);
  }
  encounter.runWithRng(() => {
    if (legal.type === 'attack') {
      const target = state.creatures.find(c => c.id === legal.targetId)!;
      const attack = getActiveActions(active)[legal.actionIndex];
      if (!attack || attack.name !== legal.actionName) throw new EncounterError(`Stale arena attack "${legal.id}".`);
      resolveAttack(state, active, target, attack);
      active.hasActed = true;
      checkBattleComplete(state);
    } else if (legal.type === 'spell') {
      const target = state.creatures.find(c => c.id === legal.targetId)!;
      const spell = getActiveActions(active)[legal.actionIndex];
      if (!spell || spell.name !== legal.actionName || !isSpellAction(spell)) throw new EncounterError(`Stale arena spell "${legal.id}".`);
      if (!executeSpell(state, active, spell, target)) throw new EncounterError(`Illegal or stale arena spell "${legal.id}".`);
      if (spell.isBonusAction) active.bonusActionUsed = true;
      else active.hasActed = true;
      checkBattleComplete(state);
    } else if (legal.type === 'move_to') {
      const destination = action.type === 'move_to' ? action.destination : undefined;
      if (!destination || !Number.isInteger(destination.x) || !Number.isInteger(destination.y)) throw new EncounterError('move_to requires an integer destination.');
      if (!reachableMovementDestinations(active, state).some(cell => cell.x === destination.x && cell.y === destination.y)) throw new EncounterError('Illegal or stale move destination.');
      const oldPosition = { ...active.position };
      moveToDestination(active, destination, state);
      if ((active.position.x !== oldPosition.x || active.position.y !== oldPosition.y) && runOpportunityAttacks(state, active, oldPosition)) {
        checkBattleComplete(state);
        if (!state.isComplete) endTurn(encounter, active);
      }
    } else {
      endTurn(encounter, active);
    }
  });
}

/** Starts the first arena turn after Encounter.start(). */
export function startArena(encounter: Encounter): void {
  const state = encounter.state;
  const active = getActiveCreature(encounter);
  if (!state || !active) throw new EncounterError('Arena battle did not produce an active creature.');
  encounter.runWithRng(() => {
    if (!beginTurn(state, active)) advanceTurn(encounter);
  });
}
