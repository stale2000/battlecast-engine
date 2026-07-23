import {
  consumeResource,
  getEffectiveMoveSpeed,
  hasResource,
  isPositionBlocked,
  pushLog,
} from '../engine/combat.js';
import type { BattleState } from '../engine/combat.js';
import type { Creature } from '../types/monster.js';

/** Player-selectable actions granted by an SRD species origin. */
export type OriginArenaAction =
  | { id: 'species:adrenaline_rush'; type: 'species_dash' }
  | { id: 'species:draconic_flight'; type: 'species_flight' }
  | { id: 'species:large_form'; type: 'species_large_form' };

/** Returns only origin features whose complete effect is supported by the engine. */
export function getOriginLegalActions(active: Creature): OriginArenaAction[] {
  const actions: OriginArenaAction[] = [];
  if (
    active.monsterData.heroSpecies === 'Orc'
    && !active.bonusActionUsed
    && active.movementRemaining > 0
    && hasResource(active, 'orc-adrenaline-rush')
  ) {
    actions.push({ id: 'species:adrenaline_rush', type: 'species_dash' });
  }
  if (
    active.monsterData.heroSpecies === 'Dragonborn'
    && (active.monsterData.heroLevel ?? 0) >= 5
    && !active.bonusActionUsed
    && !active.temporaryFlightSpeed
    && hasResource(active, 'dragonborn-flight')
  ) {
    actions.push({ id: 'species:draconic_flight', type: 'species_flight' });
  }
  if (
    active.monsterData.heroSpecies === 'Goliath'
    && (active.monsterData.heroLevel ?? 0) >= 5
    && !active.bonusActionUsed
    && !active.temporarySize
    && hasResource(active, 'goliath-large-form')
  ) {
    actions.push({ id: 'species:large_form', type: 'species_large_form' });
  }
  return actions;
}

/** Applies an origin action after the caller has matched it against its legal catalogue. */
export function applyOriginLegalAction(state: BattleState, active: Creature, action: OriginArenaAction): void {
  if (action.type === 'species_dash') {
    if (active.monsterData.heroSpecies !== 'Orc' || active.bonusActionUsed || !consumeResource(active, 'orc-adrenaline-rush')) {
      throw new Error('Illegal or stale arena Adrenaline Rush.');
    }
    active.movementRemaining += getEffectiveMoveSpeed(active, state);
    active.temporaryHp = Math.max(active.temporaryHp ?? 0, active.monsterData.proficiencyBonus);
    active.bonusActionUsed = true;
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Adrenaline Rush', details: `${active.displayName} dashes and gains temporary HP.`, type: 'move' });
    return;
  }

  if (action.type === 'species_large_form') {
    if (
      active.monsterData.heroSpecies !== 'Goliath'
      || (active.monsterData.heroLevel ?? 0) < 5
      || active.bonusActionUsed
      || active.temporarySize
      || !hasResource(active, 'goliath-large-form')
      || isPositionBlocked(active.position, 'Large', state.creatures, active.id, state.terrainBlocked)
    ) {
      throw new Error('Illegal or stale arena Large Form.');
    }
    consumeResource(active, 'goliath-large-form');
    active.temporarySize = 'Large';
    active.movementRemaining += 10;
    active.bonusActionUsed = true;
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Large Form', details: `${active.displayName} becomes Large and gains speed.`, type: 'special' });
    return;
  }

  if (
    active.monsterData.heroSpecies !== 'Dragonborn'
    || (active.monsterData.heroLevel ?? 0) < 5
    || active.bonusActionUsed
    || active.temporaryFlightSpeed
    || !consumeResource(active, 'dragonborn-flight')
  ) {
    throw new Error('Illegal or stale arena Draconic Flight.');
  }
  active.temporaryFlightSpeed = active.monsterData.speed.walk;
  active.airborne = true;
  active.bonusActionUsed = true;
  pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Draconic Flight', details: `${active.displayName} sprouts spectral wings and gains a Fly Speed.`, type: 'special' });
}
