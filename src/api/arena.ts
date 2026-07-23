import { Encounter, EncounterError, type Team } from './encounter.js';
import {
  checkBattleComplete,
  applyHealing,
  consumeResource,
  creatureDistance,
  getAliveCreatures,
  executeSpell,
  getAoETargets,
  getEffectiveMoveSpeed,
  hasResource,
  isPositionBlocked,
  pickRangedSphereCenter,
  processHydraEndOfTurn,
  processTargetTurnEndOngoingEffects,
  pushLog,
  resolveAttack,
  escapeGrapple,
} from '../engine/combat.js';
import { canSee, getActiveActions } from '../engine/ai-targeting.js';
import { canDetectWithTremorsense, canSeePoint, revealVisibleHiddenCreatures } from '../engine/visibility.js';
import { moveToDestination, reachableMovementDestinations } from '../engine/ai-movement.js';
import { executeLegendaryAction, handlePassiveAuras, processTurnStart, runOpportunityAttacks } from '../engine/ai-turn.js';
import { getEligibleWildShapeBeasts } from '../data/heroes.js';
import { abilityModifier, rollD20, rollDice } from '../engine/dice.js';
import { getFootprintSize } from '../engine/combat-geometry.js';
import { lineOfSightBlocked } from '../types/terrain.js';
import type { Creature, MonsterAction } from '../types/monster.js';
import { applyGoliathAttackFeature, applyOriginLegalAction, getGoliathAttackFeatures, getOriginLegalActions } from './arena-origin-actions.js';
import { applyClassFeatureLegalAction, getClassFeatureLegalActions } from './arena-class-actions.js';
import { sameArenaAction, type ArenaAction } from './arena-actions.js';
export { sameArenaAction, type ArenaAction } from './arena-actions.js';

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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
  return action.spellLevel !== undefined || action.layOnHands !== undefined || action.heal !== undefined || action.temporaryHp !== undefined || action.buff !== undefined || action.savingThrow !== undefined || action.autoDarts !== undefined || action.powerWord !== undefined;
}

function canHideFrom(state: NonNullable<Encounter['state']>, active: Creature, observer: Creature): boolean {
  if (!canSee(state, observer, active)) return true;
  if (active.monsterData.heroSpecies !== 'Halfling') return false;
  const activeFootprint = getFootprintSize(active.monsterData.size);
  const creatureCover = new Set<string>();
  for (const creature of state.creatures) {
    if (!creature.isAlive || creature.id === active.id || creature.id === observer.id) continue;
    const footprint = getFootprintSize(creature.monsterData.size);
    if (footprint <= activeFootprint) continue;
    for (let y = 0; y < footprint; y++) for (let x = 0; x < footprint; x++) creatureCover.add(`${creature.position.x + x},${creature.position.y + y}`);
  }
  return lineOfSightBlocked(observer.position, active.position, getFootprintSize(observer.monsterData.size), activeFootprint, creatureCover);
}

function attackRollBudget(creature: Creature): number {
  const multiattack = getActiveActions(creature).find(action => action.type === 'multiattack')?.description.toLowerCase() ?? '';
  const count = multiattack.match(/\b(one|two|three|four|five|six)\b/)?.[1];
  return ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 } as const)[count as 'one' | 'two' | 'three' | 'four' | 'five' | 'six'] ?? 1;
}

function attacksUsed(creature: Creature): number {
  return Object.keys(creature.turnFlags).filter(key => key.startsWith('arena-attack-')).length;
}

function monkUnarmedAction(active: Creature): [number, MonsterAction] | undefined {
  const entries = getActiveActions(active).entries();
  return Array.from(entries).find(([, action]) => action.type === 'melee' && action.attackBonus !== undefined && action.name === 'Martial Arts (Unarmed)')
    ?? Array.from(getActiveActions(active).entries()).find(([, action]) => action.type === 'melee' && action.attackBonus !== undefined);
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
  return living.filter(c => c.team !== active.team && attackInRange(active, c, action) && (!action.range || canSee(state, active, c)));
}

function areaSpellActions(state: NonNullable<Encounter['state']>, active: Creature, action: MonsterAction, actionIndex: number): ArenaAction[] {
  const originalArea = action.savingThrow?.area?.toLowerCase() ?? '';
  const areas = originalArea.includes('cone or') && originalArea.includes('line')
    ? ['15-foot cone', '30-foot line']
    : [originalArea];
  return areas.flatMap(area => areaSpellAction(state, active, action, actionIndex, area));
}

function darknessSpellActions(state: NonNullable<Encounter['state']>, active: Creature, action: MonsterAction, actionIndex: number): ArenaAction[] {
  const range = action.range?.normal ?? action.range?.long ?? 0;
  const gridSize = state.gridSize ?? 20;
  const actions: ArenaAction[] = [];
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const center = { x, y };
      if (Math.max(Math.abs(active.position.x - x), Math.abs(active.position.y - y)) * 5 > range || !canSeePoint(state, active, center)) continue;
      actions.push({
        id: `spell:${actionIndex}:${slug(action.name)}:darkness:${x},${y}`,
        type: 'spell', actionName: action.name, actionIndex, targetId: active.id, center,
      });
    }
  }
  return actions;
}

function areaSpellAction(state: NonNullable<Encounter['state']>, active: Creature, action: MonsterAction, actionIndex: number, area: string): ArenaAction[] {
  const radius = Number(area.match(/(\d+)-foot/)?.[1] ?? 20);
  const rangedPointArea = Boolean(action.range && (area.includes('sphere') || area.includes('cylinder') || area.includes('radius')));
  const shapedAction = area === originalArea(action) ? action : { ...action, savingThrow: { ...action.savingThrow!, area } };
  const pick = rangedPointArea ? pickRangedSphereCenter(state, active, shapedAction, radius) : undefined;
  const targets = pick?.targets ?? getAoETargets(state, active, shapedAction);
  if (!targets.length) return [];
  const targetIds = targets.map(target => target.id).sort();
  return [{
    id: `spell:${actionIndex}:${slug(action.name)}:area:${slug(area)}:${targetIds.join(',')}`,
    type: 'spell', actionName: action.name, actionIndex, targetId: targetIds[0]!, targetIds, center: pick?.center, areaShape: area,
  }];
}

function originalArea(action: MonsterAction): string {
  return action.savingThrow?.area?.toLowerCase() ?? '';
}

function hasOriginFeat(creature: Creature, feat: string): boolean {
  return creature.monsterData.originFeats?.includes(feat) || creature.monsterData.originFeat === feat;
}

function heroHitDie(creature: Creature): number | undefined {
  const match = creature.monsterData.hpFormula.match(/^\d+d(6|8|10|12)/i);
  return match ? Number(match[1]) : undefined;
}

function autoDartSpellActions(active: Creature, state: NonNullable<Encounter['state']>, action: MonsterAction, actionIndex: number): ArenaAction[] {
  const targets = state.creatures
    .filter(target => target.team !== active.team && target.isAlive && !target.dying && attackInRange(active, target, action) && (!action.range || canSee(state, active, target)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const darts = Math.max(1, action.autoDarts ?? 1);
  const result: ArenaAction[] = [];
  const counts = Array.from({ length: targets.length }, () => 0);
  const visit = (index: number, remaining: number): void => {
    if (index === targets.length - 1) {
      counts[index] = remaining;
      const targetIds = targets.flatMap((target, targetIndex) => Array.from({ length: counts[targetIndex] }, () => target.id));
      if (targetIds.length) result.push({ id: `spell:${actionIndex}:${slug(action.name)}:darts:${targetIds.join(',')}`, type: 'spell', actionName: action.name, actionIndex, targetId: targetIds[0]!, targetIds });
      return;
    }
    for (let count = 0; count <= remaining; count++) {
      counts[index] = count;
      visit(index + 1, remaining - count);
    }
  };
  if (targets.length) visit(0, darts);
  return result.slice(0, 32);
}

function wildShapeActions(active: Creature, state: NonNullable<Encounter['state']>): ArenaAction[] {
  const level = active.monsterData.heroLevel ?? 0;
  if (active.monsterData.heroClass !== 'Druid' || level < 2 || active.wildShape || active.bonusActionUsed || active.concentratingOn || !hasResource(active, 'wild-shape')) return [];
  const gridSize = state.gridSize ?? 20;
  return getEligibleWildShapeBeasts({ level, subclass: active.monsterData.heroSubclass })
    .filter(beast => !active.monsterData.preferredWildShapeBeast || beast.name === active.monsterData.preferredWildShapeBeast)
    .filter(beast => active.position.x + getFootprintSize(beast.size) <= gridSize && active.position.y + getFootprintSize(beast.size) <= gridSize && !isPositionBlocked(active.position, beast.size, state.creatures, active.id, state.terrainBlocked))
    .map(beast => ({ id: `class_feature:wild_shape:${slug(beast.name)}`, type: 'wild_shape' as const, beastName: beast.name }));
}

/** The exact server-owned set of player-selectable engine actions. */
export function getLegalActions(encounter: Encounter, creatureId: string): ArenaAction[] {
  const state = encounter.state;
  const active = getActiveCreature(encounter);
  if (!state || !active || active.id !== creatureId) return [];
  const enemies = state.creatures.filter(c => c.team !== active.team && c.isAlive && !c.dying);
  const actions: ArenaAction[] = [];
  const attackInProgress = attacksUsed(active) > 0;
  if (!active.hasActed) {
    for (const [actionIndex, action] of getActiveActions(active).entries()) {
      if (action.legendaryOnly || action.type === 'multiattack') continue;
      if (isSpellAction(action)) {
        if ((!action.replacesAttack && attackInProgress) || (action.replacesAttack && attacksUsed(active) >= attackRollBudget(active)) || !canCastArenaSpell(active, action)) continue;
        if (action.autoDarts) {
          actions.push(...autoDartSpellActions(active, state, action, actionIndex));
          continue;
        }
        if (action.darkness) {
          actions.push(...darknessSpellActions(state, active, action, actionIndex));
          continue;
        }
        if (action.targetScope === 'all_allies_in_area') {
          actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:allies`, type: 'spell', actionName: action.name, actionIndex, targetId: active.id });
          continue;
        }
        if (action.savingThrow?.area) {
          actions.push(...areaSpellActions(state, active, action, actionIndex));
          continue;
        }
        for (const target of spellTargets(active, state, action)) {
          actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:${target.id}`, type: 'spell', actionName: action.name, actionIndex, targetId: target.id });
        }
        continue;
      }
      if (action.attackBonus === undefined || attacksUsed(active) >= attackRollBudget(active)) continue;
      for (const target of enemies) {
        if (!attackInRange(active, target, action) || (action.type === 'ranged' && !canSee(state, active, target) && !canDetectWithTremorsense(active, target))) continue;
        actions.push({ id: `attack:${actionIndex}:${slug(action.name)}:${target.id}`, type: 'attack', actionName: action.name, actionIndex, targetId: target.id });
        for (const feature of getGoliathAttackFeatures(active, target)) {
          actions.push({ id: `attack:${actionIndex}:${slug(action.name)}:${target.id}:goliath-${feature}`, type: 'attack', actionName: action.name, actionIndex, targetId: target.id, goliathFeature: feature });
        }
      }
    }
  }
  if (reachableMovementDestinations(active, state).length) actions.push({ id: 'move_to', type: 'move_to' });
  actions.push(...getClassFeatureLegalActions(active));
  if (!active.hasActed && !attackInProgress) {
    if (active.movementRemaining > 0) actions.push({ id: 'dash', type: 'dash', isBonusAction: false });
    actions.push({ id: 'dodge', type: 'dodge' });
    for (const target of enemies.filter(target => creatureDistance(active, target) <= 5)) {
      actions.push({ id: `help:${target.id}`, type: 'help', targetId: target.id });
    }
    if (enemies.some(target => creatureDistance(active, target) <= 5)) {
      actions.push({ id: 'disengage', type: 'disengage', isBonusAction: false });
      if (active.monsterData.heroClass === 'Rogue' && !active.bonusActionUsed) actions.push({ id: 'bonus_disengage', type: 'disengage', isBonusAction: true });
    }
    if (enemies.some(target => canHideFrom(state, active, target))) {
      actions.push({ id: 'hide', type: 'hide', isBonusAction: false });
      if (active.monsterData.heroClass === 'Rogue' && !active.bonusActionUsed) actions.push({ id: 'bonus_hide', type: 'hide', isBonusAction: true });
    }
    for (const timer of active.conditionTimers.filter(timer => timer.condition === 'grappled')) {
      actions.push({ id: `escape_grapple:${timer.sourceId}:str`, type: 'escape_grapple', sourceId: timer.sourceId, ability: 'str' });
      actions.push({ id: `escape_grapple:${timer.sourceId}:dex`, type: 'escape_grapple', sourceId: timer.sourceId, ability: 'dex' });
    }
  }
  if (active.monsterData.heroClass === 'Rogue' && !active.bonusActionUsed && !active.hasMovedThisTurn && !active.turnFlags.steadyAim) {
    if (active.movementRemaining > 0) actions.push({ id: 'bonus_dash', type: 'dash', isBonusAction: true });
  }
  if (!active.hasActed && hasOriginFeat(active, 'Healer') && hasResource(active, 'healer-kit')) {
    for (const target of state.creatures.filter(candidate => candidate.team === active.team && candidate.isAlive && !candidate.dying && candidate.currentHp < candidate.maxHp && creatureDistance(active, candidate) <= 5 && hasResource(candidate, 'hit-die') && !candidate.activeBuffs?.some(buff => buff.key === 'healer-battle-medic'))) {
      if (heroHitDie(target)) actions.push({ id: `healer_battle_medic:${target.id}`, type: 'healer_battle_medic', targetId: target.id });
    }
  }
  actions.push(...getOriginLegalActions(active));
  actions.push(...wildShapeActions(active, state));
  const monk = monkUnarmedAction(active);
  const flurryStrikes = Object.keys(active.turnFlags).filter(key => key.startsWith('arena-flurry-')).length;
  if (active.monsterData.heroClass === 'Monk' && monk && attacksUsed(active) > 0) {
    for (const target of enemies.filter(target => attackInRange(active, target, monk[1]))) {
      if (flurryStrikes > 0 && flurryStrikes < 2) actions.push({ id: `class_feature:flurry:${target.id}`, type: 'monk_strike', actionIndex: monk[0], targetId: target.id, flurry: true });
      else if (flurryStrikes === 0 && !active.bonusActionUsed) {
        actions.push({ id: `class_feature:martial_arts:${target.id}`, type: 'monk_strike', actionIndex: monk[0], targetId: target.id, flurry: false });
        if (hasResource(active, 'ki')) actions.push({ id: `class_feature:flurry:${target.id}`, type: 'monk_strike', actionIndex: monk[0], targetId: target.id, flurry: true });
      }
    }
  }
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
  if (!legal || (legal.type !== 'move_to' && legal.type !== 'species_teleport' && !sameArenaAction(legal, action))) {
    throw new EncounterError(`Illegal or stale arena action "${action.id}".`);
  }
  encounter.runWithRng(() => {
    if (legal.type === 'attack') {
      const target = state.creatures.find(c => c.id === legal.targetId)!;
      const attack = getActiveActions(active)[legal.actionIndex];
      if (!attack || attack.name !== legal.actionName) throw new EncounterError(`Stale arena attack "${legal.id}".`);
      const damageBefore = target.stats.damageTaken;
      resolveAttack(state, active, target, attack);
      if (legal.goliathFeature && target.stats.damageTaken > damageBefore) {
        try {
          applyGoliathAttackFeature(state, active, target, legal.goliathFeature);
        } catch (error) {
          throw new EncounterError(error instanceof Error ? error.message : 'Illegal or stale Goliath Giant Ancestry.');
        }
      }
      active.turnFlags[`arena-attack-${attacksUsed(active)}`] = true;
      active.hasActed = attacksUsed(active) >= attackRollBudget(active);
      checkBattleComplete(state);
    } else if (legal.type === 'spell') {
      const targets = (legal.targetIds ?? [legal.targetId]).map(id => state.creatures.find(c => c.id === id)).filter((target): target is Creature => Boolean(target));
      const target = targets[0];
      const baseSpell = getActiveActions(active)[legal.actionIndex];
      const spell = baseSpell && legal.areaShape
        ? { ...baseSpell, savingThrow: { ...baseSpell.savingThrow!, area: legal.areaShape } }
        : baseSpell;
      if (!spell || spell.name !== legal.actionName || !isSpellAction(spell)) throw new EncounterError(`Stale arena spell "${legal.id}".`);
      if (!target || !executeSpell(state, active, spell, target, spell.autoDarts || spell.savingThrow?.area ? targets : undefined, legal.center)) throw new EncounterError(`Illegal or stale arena spell "${legal.id}".`);
      if (spell.isBonusAction) active.bonusActionUsed = true;
      else if (spell.replacesAttack) {
        active.turnFlags[`arena-attack-${attacksUsed(active)}`] = true;
        active.hasActed = attacksUsed(active) >= attackRollBudget(active);
      } else active.hasActed = true;
      checkBattleComplete(state);
    } else if (legal.type === 'move_to') {
      const destination = action.type === 'move_to' ? action.destination : undefined;
      if (!destination || !Number.isInteger(destination.x) || !Number.isInteger(destination.y)) throw new EncounterError('move_to requires an integer destination.');
      if (!reachableMovementDestinations(active, state).some(cell => cell.x === destination.x && cell.y === destination.y)) throw new EncounterError('Illegal or stale move destination.');
      const oldPosition = { ...active.position };
      moveToDestination(active, destination, state);
      revealVisibleHiddenCreatures(state);
      active.hasMovedThisTurn = active.position.x !== oldPosition.x || active.position.y !== oldPosition.y;
      if ((active.position.x !== oldPosition.x || active.position.y !== oldPosition.y) && !active.turnFlags.arenaDisengaged && runOpportunityAttacks(state, active, oldPosition)) {
        checkBattleComplete(state);
        if (!state.isComplete) endTurn(encounter, active);
      }
    } else if (legal.type === 'dash') {
      active.movementRemaining += getEffectiveMoveSpeed(active, state);
      if (legal.isBonusAction) active.bonusActionUsed = true;
      else active.hasActed = true;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Dash', details: `${active.displayName} dashes.`, type: 'move' });
    } else if (legal.type === 'dodge') {
      active.turnFlags.dodge = true;
      active.hasActed = true;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Dodge', details: `${active.displayName} dodges.`, type: 'special' });
    } else if (legal.type === 'disengage') {
      active.turnFlags.arenaDisengaged = true;
      if (legal.isBonusAction) active.bonusActionUsed = true;
      else active.hasActed = true;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Disengage', details: `${active.displayName} disengages.`, type: 'move' });
    } else if (legal.type === 'hide') {
      const stealth = (active.monsterData.skills?.Stealth ?? abilityModifier(active.monsterData.abilities.dex))
        + Math.max(0, ...(active.activeBuffs ?? []).map(buff => buff.stealthBonus ?? 0));
      const hiddenFrom = state.creatures.filter(target => target.team !== active.team && target.isAlive && !target.dying && canHideFrom(state, active, target));
      let successes = 0;
      for (const target of hiddenFrom) {
        const passivePerception = 10 + (target.monsterData.skills?.Perception ?? abilityModifier(target.monsterData.abilities.wis));
        let roll = rollD20().total;
        if (active.monsterData.heroSpecies === 'Halfling' && roll === 1) roll = rollD20().total;
        if (roll + stealth < passivePerception) continue;
        active.activeBuffs = active.activeBuffs.filter(buff => buff.key !== `hidden-from:${target.id}`);
        active.activeBuffs.push({ name: 'Hidden', key: `hidden-from:${target.id}`, casterId: active.id, appliedRound: state.round, endRound: state.round + 600 });
        successes++;
      }
      if (legal.isBonusAction) active.bonusActionUsed = true;
      else active.hasActed = true;
      pushLog(state, {
        round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Hide',
        details: successes ? `${active.displayName} hides from ${successes} foe${successes === 1 ? '' : 's'}.` : `${active.displayName} fails to hide.`, type: 'special',
      });
    } else if (legal.type === 'escape_grapple') {
      if (!escapeGrapple(state, active, legal.sourceId, legal.ability)) throw new EncounterError('Illegal or stale arena grapple escape.');
      active.hasActed = true;
    } else if (legal.type === 'help') {
      const target = state.creatures.find(creature => creature.id === legal.targetId);
      if (!target || !target.isAlive || target.team === active.team || creatureDistance(active, target) > 5) throw new EncounterError(`Illegal or stale arena help "${legal.id}".`);
      target.activeBuffs = (target.activeBuffs ?? []).filter(buff => buff.key !== `help:${active.id}:${target.id}`);
      target.activeBuffs.push({ name: 'Help', key: `help:${active.id}:${target.id}`, casterId: active.id, appliedRound: state.round, endRound: state.round + 2, advantageForAllAttackers: true, expiresOnSourceTurnStart: true });
      active.hasActed = true;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Help', details: `${active.displayName} helps against ${target.displayName}.`, type: 'special' });
    } else if (legal.type === 'healer_battle_medic') {
      const target = state.creatures.find(creature => creature.id === legal.targetId);
      const die = target ? heroHitDie(target) : undefined;
      if (!target || !die || !consumeResource(active, 'healer-kit') || !consumeResource(target, 'hit-die')) throw new EncounterError('Illegal or stale arena Battle Medic.');
      applyHealing(state, target, rollDice(`1d${die}`, active.monsterData.healingRerollOnes === true).total + active.monsterData.proficiencyBonus, active, 'Battle Medic');
      target.activeBuffs.push({ name: 'Battle Medic', key: 'healer-battle-medic', casterId: active.id, appliedRound: state.round, endRound: Infinity });
      active.hasActed = true;
    } else if (legal.type === 'action_surge' || legal.type === 'steady_aim') {
      try {
        applyClassFeatureLegalAction(state, active, legal);
      } catch (error) {
        throw new EncounterError(error instanceof Error ? error.message : 'Illegal or stale arena class feature.');
      }
    } else if (legal.type === 'species_dash' || legal.type === 'species_flight' || legal.type === 'species_large_form' || legal.type === 'species_tremorsense' || legal.type === 'species_teleport') {
      try {
        applyOriginLegalAction(state, active, legal.type === 'species_teleport' && action.type === 'species_teleport' ? action : legal);
      } catch (error) {
        throw new EncounterError(error instanceof Error ? error.message : 'Illegal or stale arena origin action.');
      }
    } else if (legal.type === 'wild_shape') {
      const level = active.monsterData.heroLevel ?? 0;
      const beast = getEligibleWildShapeBeasts({ level, subclass: active.monsterData.heroSubclass }).find(candidate => candidate.name === legal.beastName);
      if (active.monsterData.heroClass !== 'Druid' || !beast || active.wildShape || active.bonusActionUsed || active.concentratingOn || !hasResource(active, 'wild-shape') || isPositionBlocked(active.position, beast.size, state.creatures, active.id, state.terrainBlocked)) throw new EncounterError('Illegal or stale arena Wild Shape.');
      if (!consumeResource(active, 'wild-shape')) throw new EncounterError('Illegal or stale arena Wild Shape.');
      const isMoon = active.monsterData.heroSubclass === 'Circle of the Moon';
      const tempHp = isMoon ? level * 3 : level;
      active.wildShape = { beastName: beast.name, tempHp, maxTempHp: tempHp, formHp: beast.formHp, cr: beast.cr, ac: isMoon ? Math.max(beast.ac, 13 + abilityModifier(active.monsterData.abilities.wis)) : beast.ac, speed: beast.speed, actions: beast.actions, size: beast.size, traits: beast.traits, saves: beast.saves, abilities: beast.abilities, isMoon };
      for (const [key, value] of Object.entries(beast.initialResources ?? {})) active.resources[key] = value;
      active.bonusActionUsed = true;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Wild Shape', details: `${active.displayName} transforms into a ${beast.name}.`, type: 'special' });
    } else if (legal.type === 'monk_strike') {
      const strike = getActiveActions(active)[legal.actionIndex];
      const target = state.creatures.find(creature => creature.id === legal.targetId);
      const flurryStrikes = Object.keys(active.turnFlags).filter(key => key.startsWith('arena-flurry-')).length;
      if (active.monsterData.heroClass !== 'Monk' || !strike || !target || !target.isAlive || !attackInRange(active, target, strike)) throw new EncounterError('Illegal or stale arena Monk strike.');
      if (legal.flurry) {
        if (flurryStrikes === 0) {
          if (active.bonusActionUsed || !consumeResource(active, 'ki')) throw new EncounterError('Illegal or stale arena Flurry of Blows.');
          active.bonusActionUsed = true;
        } else if (flurryStrikes >= 2) throw new EncounterError('Illegal or stale arena Flurry of Blows.');
        active.turnFlags[`arena-flurry-${flurryStrikes}`] = true;
      } else {
        if (active.bonusActionUsed || flurryStrikes) throw new EncounterError('Illegal or stale arena Martial Arts strike.');
        active.bonusActionUsed = true;
      }
      resolveAttack(state, active, target, strike);
      checkBattleComplete(state);
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
