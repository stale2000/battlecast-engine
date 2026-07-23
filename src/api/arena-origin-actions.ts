import {
  applyCondition,
  applyDamage,
  consumeResource,
  getEffectiveMoveSpeed,
  getActiveSize,
  hasResource,
  isPositionBlocked,
  pushLog,
} from '../engine/combat.js';
import { rollDice } from '../engine/dice.js';
import { canSee } from '../engine/ai-targeting.js';
import { BASE_DURATIONS } from '../types/animation.js';
import type { BattleState } from '../engine/combat.js';
import type { Creature } from '../types/monster.js';

export type GoliathAttackFeature = 'fire' | 'frost' | 'hill';

/** Player-selectable actions granted by an SRD species origin. */
export type OriginArenaAction =
  | { id: 'species:adrenaline_rush'; type: 'species_dash' }
  | { id: 'species:draconic_flight'; type: 'species_flight' }
  | { id: 'species:large_form'; type: 'species_large_form' }
  | { id: 'species:cloud_jaunt' | 'species:high_elf_misty_step'; type: 'species_teleport'; destination?: { x: number; y: number } };

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
  if (
    active.monsterData.heroSpecies === 'Goliath'
    && active.monsterData.heroSpeciesChoice === 'Cloud'
    && !active.bonusActionUsed
    && hasResource(active, 'goliath-giant-ancestry')
  ) {
    actions.push({ id: 'species:cloud_jaunt', type: 'species_teleport' });
  }
  if (
    active.monsterData.heroSpecies === 'Elf'
    && active.monsterData.heroSpeciesChoice === 'High Elf'
    && (active.monsterData.heroLevel ?? 0) >= 5
    && !active.bonusActionUsed
    && hasResource(active, 'high-elf-misty-step')
  ) {
    actions.push({ id: 'species:high_elf_misty_step', type: 'species_teleport' });
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

  if (action.type === 'species_teleport') {
    const destination = action.destination;
    const gridSize = state.gridSize ?? 20;
    const size = getActiveSize(active);
    const footprint = size === 'Large' ? 2 : size === 'Huge' ? 3 : size === 'Gargantuan' ? 4 : 1;
    const cloudJaunt = action.id === 'species:cloud_jaunt'
      && active.monsterData.heroSpecies === 'Goliath'
      && active.monsterData.heroSpeciesChoice === 'Cloud';
    const mistyStep = action.id === 'species:high_elf_misty_step'
      && active.monsterData.heroSpecies === 'Elf'
      && active.monsterData.heroSpeciesChoice === 'High Elf'
      && (active.monsterData.heroLevel ?? 0) >= 5;
    const resourceKey = cloudJaunt ? 'goliath-giant-ancestry' : 'high-elf-misty-step';
    if (
      (!cloudJaunt && !mistyStep)
      || active.bonusActionUsed
      || !destination
      || !Number.isInteger(destination.x)
      || !Number.isInteger(destination.y)
      || Math.max(Math.abs(destination.x - active.position.x), Math.abs(destination.y - active.position.y)) > 6
      || destination.x < 0 || destination.y < 0 || destination.x + footprint > gridSize || destination.y + footprint > gridSize
      || isPositionBlocked(destination, size, state.creatures, active.id, state.terrainBlocked)
      || !canSee(state, active, { ...active, position: destination })
      || !consumeResource(active, resourceKey)
    ) {
      throw new Error(`Illegal or stale arena ${cloudJaunt ? "Cloud's Jaunt" : 'Misty Step'}.`);
    }
    const from = { ...active.position };
    active.position = { ...destination };
    active.bonusActionUsed = true;
    state.events.push({ kind: 'move', creatureId: active.id, from, to: { ...destination }, durationMs: 0 });
    const name = cloudJaunt ? "Cloud's Jaunt" : 'Misty Step';
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: name, details: `${active.displayName} teleports to (${destination.x}, ${destination.y}).`, type: 'move' });
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

/** Goliath hit riders are separate legal attack variants, and spend only on a damaging hit. */
export function getGoliathAttackFeatures(active: Creature, target: Creature): GoliathAttackFeature[] {
  if (active.monsterData.heroSpecies !== 'Goliath' || !hasResource(active, 'goliath-giant-ancestry')) return [];
  switch (active.monsterData.heroSpeciesChoice) {
    case 'Fire': return ['fire'];
    case 'Frost': return ['frost'];
    case 'Hill': return getActiveSize(target) === 'Huge' || getActiveSize(target) === 'Gargantuan' ? [] : ['hill'];
    default: return [];
  }
}

/** Applies an already-selected Goliath rider after its parent attack dealt damage. */
export function applyGoliathAttackFeature(
  state: BattleState,
  active: Creature,
  target: Creature,
  feature: GoliathAttackFeature,
): void {
  if (!getGoliathAttackFeatures(active, target).includes(feature)) throw new Error('Illegal or stale Goliath Giant Ancestry.');
  if (!consumeResource(active, 'goliath-giant-ancestry')) throw new Error('Illegal or stale Goliath Giant Ancestry.');
  if (feature === 'hill') {
    applyCondition(state, target, 'prone', active, 'end_of_next_turn');
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: "Hill's Tumble", details: `${active.displayName} knocks ${target.displayName} prone.`, type: 'condition' });
    return;
  }
  const damage = rollDice(feature === 'fire' ? '1d10' : '1d6').total;
  const damageType = feature === 'fire' ? 'fire' : 'cold';
  const before = target.currentHp;
  const event = { kind: 'hit' as const, targetId: target.id, damage, damageType, critical: false, targetHpBefore: before, targetHpAfter: before, durationMs: BASE_DURATIONS.hit };
  state.events.push(event);
  applyDamage(state, target, damage, damageType, active, false, true);
  event.targetHpAfter = target.currentHp;
  if (feature === 'frost') {
    target.activeBuffs = (target.activeBuffs ?? []).filter(buff => buff.key !== `goliath-frost:${active.id}`);
    target.activeBuffs.push({ name: "Frost's Chill", key: `goliath-frost:${active.id}`, casterId: active.id, appliedRound: state.round, endRound: state.round + 2, speedPenalty: 10, expiresOnSourceTurnStart: true });
  }
  pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: feature === 'fire' ? "Fire's Burn" : "Frost's Chill", details: `${active.displayName} deals ${damage} ${damageType} damage to ${target.displayName}${feature === 'frost' ? ' and slows it.' : '.'}`, damage, type: 'damage' });
  if (target.currentHp < before) active.stats.actionUsage[`Giant Ancestry: ${feature}`] = (active.stats.actionUsage[`Giant Ancestry: ${feature}`] || 0) + 1;
}
