import { Encounter, EncounterError, type Team } from './encounter.js';
import {
  checkBattleComplete,
  applyHealing,
  consumeResource,
  creatureDistance,
  getAliveCreatures,
  executeSpell,
  bestDirectionalTargets,
  getAoETargets,
  getEffectiveMoveSpeed,
  hasResource,
  isPositionBlocked,
  isInLine,
  pickRangedSphereCenter,
  processHydraEndOfTurn,
  processTargetTurnEndOngoingEffects,
  pushLog,
  resolveAttack,
  resolveAoE,
  triggerPersistentZones,
  moveConcentrationAura,
  tryUseBonusActionDamageBuff,
  useSpiritualWeaponAttack,
  escapeGrapple,
  escapeBuff,
  isCreatureSilenced,
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
const SIZE_STEPS = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'] as const;

function canChangeSize(state: NonNullable<Encounter['state']>, target: Creature, direction: 'enlarge' | 'reduce'): boolean {
  const index = SIZE_STEPS.indexOf((target.temporarySize ?? target.monsterData.size) as typeof SIZE_STEPS[number]);
  const next = SIZE_STEPS[index + (direction === 'enlarge' ? 1 : -1)];
  return next !== undefined && (direction !== 'enlarge' || !isPositionBlocked(target.position, next, state.creatures, target.id, state.terrainBlocked));
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
  return action.spellLevel !== undefined || action.layOnHands !== undefined || action.heal !== undefined || action.temporaryHp !== undefined || action.removesConditions !== undefined || action.grantsFlight !== undefined || action.buff !== undefined || action.savingThrow !== undefined || action.autoDarts !== undefined || action.powerWord !== undefined || action.summon !== undefined || action.teleport !== undefined;
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
  if (creature.activeBuffs?.some(buff => buff.limitAttacksToOne)) return 1;
  const multiattack = getActiveActions(creature).find(action => action.type === 'multiattack')?.description.toLowerCase() ?? '';
  const count = multiattack.match(/\b(one|two|three|four|five|six)\b/)?.[1];
  return ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 } as const)[count as 'one' | 'two' | 'three' | 'four' | 'five' | 'six'] ?? 1;
}

function attacksUsed(creature: Creature): number {
  return Object.keys(creature.turnFlags).filter(key => key.startsWith('arena-attack-')).length;
}

function hasUnusedHasteAction(creature: Creature): boolean {
  return !creature.turnFlags.arenaHasteActionUsed
    && (creature.activeBuffs ?? []).some(buff => buff.hasteAction);
}

function mountingCost(creature: Creature, state: NonNullable<Encounter['state']>): number {
  return Math.ceil(getEffectiveMoveSpeed(creature, state) / 2);
}

function isIncapacitated(creature: Creature): boolean {
  return creature.conditions.includes('incapacitated') || creature.conditions.includes('unconscious') || creature.conditions.includes('paralyzed') || creature.conditions.includes('stunned');
}

function mountActions(state: NonNullable<Encounter['state']>, active: Creature): ArenaAction[] {
  const gridSize = state.gridSize ?? 20;
  const cost = mountingCost(active, state);
  if (active.mountedOnId) {
    const mount = state.creatures.find(candidate => candidate.id === active.mountedOnId);
    if (!mount || !mount.isAlive || active.movementRemaining < cost) return [];
    const size = active.wildShape?.size ?? active.temporarySize ?? active.monsterData.size;
    const footprint = getFootprintSize(size);
    const choices: ArenaAction[] = [];
    for (let y = Math.max(0, mount.position.y - 1); y <= Math.min(gridSize - footprint, mount.position.y + 1); y++) for (let x = Math.max(0, mount.position.x - 1); x <= Math.min(gridSize - footprint, mount.position.x + 1); x++) {
      if (isPositionBlocked({ x, y }, size, state.creatures.filter(candidate => candidate.id !== mount.id), active.id, state.terrainBlocked)) continue;
      choices.push({ id: `dismount:${mount.id}:${x},${y}`, type: 'dismount', mountId: mount.id, destination: { x, y } });
    }
    return choices;
  }
  if (active.movementRemaining < cost) return [];
  return state.creatures
    .filter(candidate => candidate.isAlive && candidate.team === active.team && candidate.controlledMountForId === active.id && !candidate.riderId && creatureDistance(active, candidate) <= 5)
    .map(candidate => ({ id: `mount:${candidate.id}`, type: 'mount' as const, mountId: candidate.id }));
}

function monkUnarmedAction(active: Creature): [number, MonsterAction] | undefined {
  const entries = getActiveActions(active).entries();
  return Array.from(entries).find(([, action]) => action.type === 'melee' && action.attackBonus !== undefined && action.name === 'Martial Arts (Unarmed)')
    ?? Array.from(getActiveActions(active).entries()).find(([, action]) => action.type === 'melee' && action.attackBonus !== undefined);
}

function canCastArenaSpell(active: Creature, action: MonsterAction): boolean {
  if (active.activeBuffs?.some(buff => buff.restrictActionBonusCombination) && active.bonusActionUsed && !action.isBonusAction) return false;
  if (action.isBonusAction && active.bonusActionUsed) return false;
  if (active.turnFlags?.bonusActionSpellCast && (action.spellLevel ?? 0) > 0 && !action.isBonusAction) return false;
  if (action.resourceCost && !hasResource(active, action.resourceCost.key, action.resourceCost.amount)) return false;
  if ((action.spellLevel ?? 0) > 0 && !action.resourceCost && !action.atWill) {
    return Array.from({ length: 9 }, (_, index) => index + 1).some(level => level >= (action.spellLevel ?? 0) && hasResource(active, `slot-${level}`));
  }
  return true;
}

function spellTargets(active: Creature, state: NonNullable<Encounter['state']>, action: MonsterAction): Creature[] {
  if (action.autoDarts || action.savingThrow?.area || action.persistentZone || (action.targetScope === 'all_allies_in_area' && !action.multiTargetBuff && !action.multiTargetHeal)) return [];
  const living = action.revive
    ? state.creatures.filter(c => !c.isAlive && c.team === active.team && c.stats.deathRound !== undefined && state.round - c.stats.deathRound <= action.revive!.maxDeathRounds)
    : state.creatures.filter(c => c.isAlive && (!c.dying || action.heal !== undefined || action.stabilize));
  if (action.targetScope === 'self') return [active];
  const inRange = (target: Creature) => {
    const range = action.range?.normal;
    return (range === undefined || creatureDistance(active, target) <= range)
      && (!action.targetTypeRestriction || target.monsterData.type.toLowerCase() === action.targetTypeRestriction.toLowerCase());
  };
  if (action.targetScope === 'one_ally' || action.targetScope === 'all_allies_in_area' || action.heal || action.layOnHands || action.removesConditions || action.grantsFlight || action.stabilize) {
    return living.filter(c => c.team === active.team && inRange(c) && !((action.requiresNoHeavyArmor ?? false) && c.monsterData.wearingHeavyArmor) && (action.stabilize ? c.dying : action.heal || action.layOnHands ? c.currentHp < c.maxHp || c.dying : action.removesConditions && !action.buff ? action.removesConditions.some(condition => c.conditions.includes(condition)) : true));
  }
  if (action.targetScope === 'any_one') {
    return living.filter(target => inRange(target) && (!action.range || canSee(state, active, target)));
  }
  return living.filter(c => c.team !== active.team && inRange(c) && attackInRange(active, c, action) && (!action.range || canSee(state, active, c)));
}

function areaSpellActions(state: NonNullable<Encounter['state']>, active: Creature, action: MonsterAction, actionIndex: number): ArenaAction[] {
  const areaText = originalArea(action);
  const areas = areaText.includes('cone or') && areaText.includes('line')
    ? ['15-foot cone', '30-foot line']
    : [areaText];
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
        id: `spell:${actionIndex}:${slug(action.name)}:point:${x},${y}`,
        type: 'spell', actionName: action.name, actionIndex, targetId: active.id, center,
      });
    }
  }
  return actions;
}

function summonSpellActions(state: NonNullable<Encounter['state']>, active: Creature, action: MonsterAction, actionIndex: number): ArenaAction[] {
  if (!action.summon) return [];
  const gridSize = state.gridSize ?? 20;
  return action.summon.variants.flatMap(({ key, monsterData }) => {
    const size = getFootprintSize(monsterData.size);
    const choices: ArenaAction[] = [];
    for (let y = 0; y <= gridSize - size; y++) for (let x = 0; x <= gridSize - size; x++) {
      const destination = { x, y };
      if (Math.max(Math.abs(active.position.x - x), Math.abs(active.position.y - y)) * 5 > action.summon!.rangeFt
        || !canSeePoint(state, active, destination)
        || isPositionBlocked(destination, monsterData.size, state.creatures, undefined, state.terrainBlocked)) continue;
      choices.push({
        id: `spell:${actionIndex}:${slug(action.name)}:summon:${key}:${x},${y}`,
        type: 'spell_summon', actionName: action.name, actionIndex, variantKey: key, destination,
      });
    }
    return choices;
  });
}

function areaSpellAction(state: NonNullable<Encounter['state']>, active: Creature, action: MonsterAction, actionIndex: number, area: string): ArenaAction[] {
  const radius = Number(area.match(/(\d+)-foot/)?.[1] ?? 20);
  const rangedPointArea = Boolean(action.range && (area.includes('sphere') || area.includes('cylinder') || area.includes('cube') || area.includes('radius')));
  const shapedAction = area === originalArea(action) ? action : { ...action, savingThrow: { ...action.savingThrow!, area } };
  const pick = rangedPointArea ? pickRangedSphereCenter(state, active, shapedAction, radius) : undefined;
  const directional = area.includes('line') ? bestDirectionalTargets(state, active, radius, isInLine) : undefined;
  const targets = pick?.targets ?? directional?.targets ?? getAoETargets(state, active, shapedAction);
  if (!targets.length) return [];
  const targetIds = targets.map(target => target.id).sort();
  return [{
    id: `spell:${actionIndex}:${slug(action.name)}:area:${slug(area)}:${targetIds.join(',')}`,
    type: 'spell', actionName: action.name, actionIndex, targetId: targetIds[0]!, targetIds, center: pick?.center ?? directional?.direction, areaShape: area,
  }];
}

function originalArea(action: MonsterAction): string {
  return action.savingThrow?.area?.toLowerCase() ?? (action.persistentZone ? `${action.persistentZone.radiusFt}-foot sphere` : '');
}

function withCurseChoice(spell: MonsterAction, choice: NonNullable<ArenaAction & { type: 'spell' }>['curseChoice']): MonsterAction {
  if (!spell.curseChoice || !spell.buffOnFailedSave || !choice) return spell;
  const ability = choice.startsWith('ability_') ? choice.slice('ability_'.length) as keyof Creature['monsterData']['abilities'] : undefined;
  return {
    ...spell,
    curseChoice: { ...spell.curseChoice, selected: choice },
    buffOnFailedSave: {
      ...spell.buffOnFailedSave,
      attackDisadvantage: choice === 'attack_disadvantage' ? true : undefined,
      attackDisadvantageAgainstCaster: choice === 'attack_disadvantage' ? true : undefined,
      damageRider: choice === 'damage_rider' ? '1d8 necrotic' : undefined,
      saveDisadvantageAbilities: ability ? [ability] : undefined,
      abilityCheckDisadvantageAbilities: ability ? [ability] : undefined,
      forcedDodgeSave: choice === 'forced_dodge' && spell.savingThrow ? { ability: 'wis', dc: spell.savingThrow.dc } : undefined,
    },
  };
}

function repeatAreaSpellActions(state: NonNullable<Encounter['state']>, active: Creature): ArenaAction[] {
  const repeat = active.repeatableAreaSpell;
  if (!repeat || repeat.endRound <= state.round || active.hasActed) return [];
  const action: MonsterAction = {
    name: repeat.name, type: 'special', description: `Repeat ${repeat.name}.`, damageType: repeat.damageType,
    savingThrow: { ability: repeat.saveAbility, dc: repeat.saveDC, damageOnFail: repeat.damageDice, damageOnSuccess: 'half', area: repeat.area },
    range: { normal: 120, long: 120 }, targetScope: 'area_enemies',
  };
  return areaSpellActions(state, active, action, -1).flatMap(choice => choice.type === 'spell'
    ? [{ id: choice.id.replace('spell:-1:', 'repeat_area_spell:'), type: 'repeat_area_spell' as const, spellName: repeat.name, targetId: choice.targetId, targetIds: choice.targetIds ?? [], center: choice.center, areaShape: choice.areaShape }]
    : []);
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
  const darts = Math.max(1, action.autoDarts ?? action.multiTargetAttack?.count ?? 1);
  const kind = action.autoDarts ? 'darts' : 'rays';
  const result: ArenaAction[] = [];
  const counts = Array.from({ length: targets.length }, () => 0);
  const visit = (index: number, remaining: number): void => {
    if (index === targets.length - 1) {
      counts[index] = remaining;
      const targetIds = targets.flatMap((target, targetIndex) => Array.from({ length: counts[targetIndex] }, () => target.id));
      if (targetIds.length) result.push({ id: `spell:${actionIndex}:${slug(action.name)}:${kind}:${targetIds.join(',')}`, type: 'spell', actionName: action.name, actionIndex, targetId: targetIds[0]!, targetIds });
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

function multiTargetSaveSpellActions(active: Creature, state: NonNullable<Encounter['state']>, action: MonsterAction, actionIndex: number): ArenaAction[] {
  const targets = spellTargets(active, state, action).sort((left, right) => left.id.localeCompare(right.id));
  const result: ArenaAction[] = [];
  const choose = (start: number, chosen: Creature[]): void => {
    if (chosen.length) result.push({ id: `spell:${actionIndex}:${slug(action.name)}:targets:${chosen.map(target => target.id).join(',')}`, type: 'spell', actionName: action.name, actionIndex, targetId: chosen[0]!.id, targetIds: chosen.map(target => target.id) });
    if (chosen.length === (action.multiTargetSave?.maxTargets ?? action.multiTargetBuff?.maxTargets ?? action.multiTargetHeal?.maxTargets ?? 1)) return;
    for (let index = start; index < targets.length; index++) choose(index + 1, [...chosen, targets[index]!]);
  };
  choose(0, []);
  return result;
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
  if (state.pendingHit) {
    if (state.pendingHit.attackerId !== active.id) return [];
    const activeActions = getActiveActions(active);
    const pendingTarget = state.creatures.find(candidate => candidate.id === state.pendingHit!.targetId);
    const pendingActions = state.pendingHit.actionIndexes.map(index => ({ index, action: activeActions[index] })).filter(({ action }) => action?.postHit?.trigger === 'weapon_hit' || action?.postHit?.trigger === 'melee_hit');
    if (!pendingTarget || !pendingTarget.isAlive || !pendingActions.length) return [{ id: `post_hit:${active.id}:decline`, type: 'post_hit', actionName: 'post-hit', actionIndex: -1, targetId: state.pendingHit.targetId, decline: true }];
    const actions: ArenaAction[] = [{ id: `post_hit:${active.id}:decline`, type: 'post_hit', actionName: 'post-hit', actionIndex: -1, targetId: pendingTarget.id, decline: true }];
    for (const { index, action } of pendingActions) if (action && canCastArenaSpell(active, action) && action.isBonusAction && !active.bonusActionUsed) {
      actions.push({ id: `post_hit:${active.id}:${index}:${slug(action.name)}:${pendingTarget.id}`, type: 'post_hit', actionName: action.name, actionIndex: index, targetId: pendingTarget.id, decline: false });
    }
    return actions;
  }
  const enemies = state.creatures.filter(c => c.team !== active.team && c.isAlive && !c.dying);
  const actions: ArenaAction[] = [];
  // ponytail: movement reachability is an O(grid * pathfinding) scan; reuse it
  // for this immutable catalogue instead of recalculating it per branch.
  const reachable = reachableMovementDestinations(active, state);
  const rider = active.riderId ? state.creatures.find(candidate => candidate.id === active.riderId) : undefined;
  if (active.controlledMountForId && rider?.mountedOnId === active.id && !isIncapacitated(rider)) {
    if (reachable.length) actions.push({ id: 'move_to', type: 'move_to' });
    if (active.movementRemaining > 0) actions.push({ id: 'dash', type: 'dash', isBonusAction: false });
    actions.push({ id: 'dodge', type: 'dodge' });
    actions.push({ id: 'disengage', type: 'disengage', isBonusAction: false });
    actions.push({ id: 'end_turn', type: 'end_turn' });
    return actions;
  }
  const attackInProgress = attacksUsed(active) > 0;
  const hasteOnly = active.hasActed && hasUnusedHasteAction(active);
  if (!active.hasActed || hasteOnly) {
    for (const [actionIndex, action] of getActiveActions(active).entries()) {
      if (action.legendaryOnly || action.reactionOnly || action.type === 'multiattack') continue;
      if (isSpellAction(action)) {
        if (isCreatureSilenced(state, active)) continue;
        if (action.postHit) continue;
        if (hasteOnly) continue;
        if (action.attackThenArea) {
          const targets = enemies.filter(target => attackInRange(active, target, action));
          actions.push(...targets.map(target => ({
            id: `spell:${actionIndex}:${slug(action.name)}:target:${target.id}`,
            type: 'spell' as const, actionName: action.name, actionIndex, targetId: target.id,
          })));
          continue;
        }
        if (action.spiritualWeapon && active.spiritualWeapon && active.spiritualWeapon.endRound > state.round) continue;
        if (action.repeatableAreaSpell && active.repeatableAreaSpell && active.repeatableAreaSpell.endRound > state.round) continue;
        if ((!action.replacesAttack && attackInProgress) || (action.replacesAttack && attacksUsed(active) >= attackRollBudget(active)) || !canCastArenaSpell(active, action)) continue;
        if (action.autoDarts || action.multiTargetAttack) {
          actions.push(...autoDartSpellActions(active, state, action, actionIndex));
          continue;
        }
        if (action.multiTargetSave || action.multiTargetBuff || action.multiTargetHeal) {
          actions.push(...multiTargetSaveSpellActions(active, state, action, actionIndex));
          continue;
        }
        if (action.teleport) {
          actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:teleport`, type: 'spell_teleport', actionName: action.name, actionIndex });
          continue;
        }
        if (action.summon) {
          actions.push(...summonSpellActions(state, active, action, actionIndex));
          continue;
        }
        if (action.darkness || action.daylight) {
          actions.push(...darknessSpellActions(state, active, action, actionIndex));
          continue;
        }
        if (action.targetScope === 'all_allies_in_area') {
          actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:allies`, type: 'spell', actionName: action.name, actionIndex, targetId: active.id });
          continue;
        }
        if (action.savingThrow?.area || action.persistentZone) {
          actions.push(...areaSpellActions(state, active, action, actionIndex));
          continue;
        }
        if (action.dispelMagic) {
          for (const target of spellTargets(active, state, action)) {
            for (const effect of target.activeBuffs
              .filter(buff => buff.spellLevel !== undefined && buff.spellLevel <= action.dispelMagic!.maxSpellLevel)
              .sort((left, right) => left.key.localeCompare(right.key))) {
              actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:${target.id}:${slug(effect.key)}`, type: 'spell', actionName: action.name, actionIndex, targetId: target.id, effectKey: effect.key });
            }
          }
          continue;
        }
        if (action.damageResistanceChoice) {
          for (const target of spellTargets(active, state, action)) {
            for (const damageResistance of action.damageResistanceChoice.choices) {
              actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:${target.id}:${damageResistance}`, type: 'spell', actionName: action.name, actionIndex, targetId: target.id, damageResistance });
            }
          }
          continue;
        }
        if (action.damageTypeChoice) {
          for (const target of spellTargets(active, state, action)) {
            for (const damageType of action.damageTypeChoice.choices) {
              actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:${target.id}:${damageType}`, type: 'spell', actionName: action.name, actionIndex, targetId: target.id, damageType });
            }
          }
          continue;
        }
        if (action.sizeChangeChoice) {
          for (const target of spellTargets(active, state, action)) {
            for (const sizeChange of action.sizeChangeChoice.choices) {
              if (!canChangeSize(state, target, sizeChange)) continue;
              actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:${target.id}:${sizeChange}`, type: 'spell', actionName: action.name, actionIndex, targetId: target.id, sizeChange });
            }
          }
          continue;
        }
        if (action.curseChoice) {
          for (const target of spellTargets(active, state, action)) {
            for (const curseChoice of action.curseChoice.choices) {
              actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:${target.id}:${curseChoice}`, type: 'spell', actionName: action.name, actionIndex, targetId: target.id, curseChoice });
            }
          }
          continue;
        }
        for (const target of spellTargets(active, state, action)) {
          actions.push({ id: `spell:${actionIndex}:${slug(action.name)}:${target.id}`, type: 'spell', actionName: action.name, actionIndex, targetId: target.id });
        }
        continue;
      }
      if (action.attackBonus === undefined || (!hasteOnly && attacksUsed(active) >= attackRollBudget(active))) continue;
      if (action.loading && active.turnFlags[`arena-loading-${actionIndex}`]) continue;
      for (const target of enemies) {
        if (!attackInRange(active, target, action) || (action.type === 'ranged' && !canSee(state, active, target) && !canDetectWithTremorsense(active, target))) continue;
        actions.push({ id: `attack:${actionIndex}:${slug(action.name)}:${target.id}${hasteOnly ? ':haste' : ''}`, type: 'attack', actionName: action.name, actionIndex, targetId: target.id, ...(hasteOnly ? { hasteAction: true } : {}) });
        if (hasteOnly) continue;
        for (const feature of getGoliathAttackFeatures(active, target)) {
          actions.push({ id: `attack:${actionIndex}:${slug(action.name)}:${target.id}:goliath-${feature}`, type: 'attack', actionName: action.name, actionIndex, targetId: target.id, goliathFeature: feature });
        }
      }
    }
  }
  if (!active.bonusActionUsed) {
    for (const target of enemies) {
      for (const buff of target.activeBuffs ?? []) {
        if (buff.casterId !== active.id || !buff.bonusActionDamage || buff.appliedRound >= state.round || creatureDistance(active, target) > (buff.bonusActionDamageRange ?? Infinity)) continue;
        actions.push({ id: `repeat_spell:${slug(buff.key)}:${target.id}`, type: 'repeat_spell', buffKey: buff.key, targetId: target.id });
      }
    }
    if (active.spiritualWeapon && active.spiritualWeapon.endRound > state.round) {
      for (const target of enemies) {
        const distance = Math.max(Math.abs(target.position.x - active.spiritualWeapon.position.x), Math.abs(target.position.y - active.spiritualWeapon.position.y)) * 5;
        if (distance <= active.spiritualWeapon.moveFt + 5) actions.push({ id: `spiritual_weapon:${target.id}`, type: 'spiritual_weapon', targetId: target.id });
      }
    }
  }
  if (!active.hasActed && active.repeatableActionSpell && active.repeatableActionSpell.endRound > state.round) {
    for (const target of enemies.filter(target => creatureDistance(active, target) <= 5)) actions.push({ id: `repeat_action_spell:${slug(active.repeatableActionSpell.name)}:${target.id}`, type: 'repeat_action_spell', spellName: active.repeatableActionSpell.name, targetId: target.id });
  }
  actions.push(...repeatAreaSpellActions(state, active));
  actions.push(...mountActions(state, active));
  if (!active.hasActed && active.concentrationAura?.origin === 'point' && active.concentrationAura.moveFt && active.concentrationAura.endRound > state.round
    && !active.concentrationAura.movedThisTurn && (!active.concentrationAura.moveRequiresCasterMove || active.hasMovedThisTurn)) actions.push({ id: 'move_aura', type: 'move_aura' });
  if (reachable.length) actions.push({ id: 'move_to', type: 'move_to' });
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
    for (const buff of active.activeBuffs.filter(buff => buff.escapeAction)) {
      actions.push({ id: `escape_condition:${buff.key}`, type: 'escape_condition', buffKey: buff.key });
    }
  }
  if (hasteOnly) {
    if (active.movementRemaining > 0) actions.push({ id: 'haste_dash', type: 'dash', isBonusAction: false, hasteAction: true });
    if (enemies.some(target => creatureDistance(active, target) <= 5)) actions.push({ id: 'haste_disengage', type: 'disengage', isBonusAction: false, hasteAction: true });
    if (enemies.some(target => canHideFrom(state, active, target))) actions.push({ id: 'haste_hide', type: 'hide', isBonusAction: false, hasteAction: true });
  }
  if (active.monsterData.heroClass === 'Rogue' && !active.bonusActionUsed && !active.hasMovedThisTurn && !active.turnFlags.steadyAim) {
    if (active.movementRemaining > 0) actions.push({ id: 'bonus_dash', type: 'dash', isBonusAction: true });
  }
  if (!active.bonusActionUsed && active.movementRemaining > 0 && active.activeBuffs.some(buff => buff.bonusActionDash)) {
    actions.push({ id: 'spell_bonus_dash', type: 'dash', isBonusAction: true });
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

function applyArenaMove(encounter: Encounter, state: NonNullable<Encounter['state']>, active: Creature, action: ArenaAction): void {
  const destination = action.type === 'move_to' ? action.destination : undefined;
  if (!destination || !Number.isInteger(destination.x) || !Number.isInteger(destination.y)) throw new EncounterError('move_to requires an integer destination.');
  if (!reachableMovementDestinations(active, state).some(cell => cell.x === destination.x && cell.y === destination.y)) throw new EncounterError('Illegal or stale move destination.');
  const oldPosition = { ...active.position };
  moveToDestination(active, destination, state);
  if (active.position.x !== oldPosition.x || active.position.y !== oldPosition.y) triggerPersistentZones(state, active, 'entry');
  revealVisibleHiddenCreatures(state);
  active.hasMovedThisTurn = active.position.x !== oldPosition.x || active.position.y !== oldPosition.y;
  if ((active.position.x !== oldPosition.x || active.position.y !== oldPosition.y) && !active.turnFlags.arenaDisengaged && runOpportunityAttacks(state, active, oldPosition)) {
    checkBattleComplete(state);
    if (!state.isComplete) endTurn(encounter, active);
  }
}

function applyArenaMount(state: NonNullable<Encounter['state']>, active: Creature, action: Extract<ArenaAction, { type: 'mount' | 'dismount' }>): void {
  const mount = state.creatures.find(candidate => candidate.id === action.mountId);
  const cost = mountingCost(active, state);
  if (action.type === 'mount') {
    if (!mount || active.mountedOnId || !mount.isAlive || mount.team !== active.team || mount.controlledMountForId !== active.id || mount.riderId || creatureDistance(active, mount) > 5 || active.movementRemaining < cost) throw new EncounterError('Illegal or stale arena mount.');
    active.mountedOnId = mount.id;
    mount.riderId = active.id;
    active.position = { ...mount.position };
    active.movementRemaining -= cost;
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Mount', details: `${active.displayName} mounts ${mount.displayName}.`, type: 'move' });
    return;
  }
  const size = active.wildShape?.size ?? active.temporarySize ?? active.monsterData.size;
  const destination = action.destination;
  if (!mount || active.mountedOnId !== mount.id || mount.riderId !== active.id || active.movementRemaining < cost || Math.max(Math.abs(destination.x - mount.position.x), Math.abs(destination.y - mount.position.y)) > 1 || isPositionBlocked(destination, size, state.creatures.filter(candidate => candidate.id !== mount.id), active.id, state.terrainBlocked)) throw new EncounterError('Illegal or stale arena dismount.');
  active.mountedOnId = undefined;
  mount.riderId = undefined;
  active.position = { ...destination };
  active.movementRemaining -= cost;
  pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Dismount', details: `${active.displayName} dismounts ${mount.displayName}.`, type: 'move' });
}

function applyArenaAttack(state: NonNullable<Encounter['state']>, active: Creature, activeActions: MonsterAction[], legal: Extract<ArenaAction, { type: 'attack' }>): void {
  const target = state.creatures.find(c => c.id === legal.targetId)!;
  const attack = activeActions[legal.actionIndex];
  if (!attack || attack.name !== legal.actionName) throw new EncounterError(`Stale arena attack "${legal.id}".`);
  const damageBefore = target.stats.damageTaken;
  const eventCountBefore = state.events.length;
  const attackToResolve = attack.postHit ? { ...attack, postHit: undefined } : attack;
  resolveAttack(state, active, target, attackToResolve);
  if (attack.loading) active.turnFlags[`arena-loading-${legal.actionIndex}`] = true;
  if (legal.goliathFeature && target.stats.damageTaken > damageBefore) {
    try {
      applyGoliathAttackFeature(state, active, target, legal.goliathFeature);
    } catch (error) {
      throw new EncounterError(error instanceof Error ? error.message : 'Illegal or stale Goliath Giant Ancestry.');
    }
  }
  if (legal.hasteAction) active.turnFlags.arenaHasteActionUsed = true;
  else {
    active.turnFlags[`arena-attack-${attacksUsed(active)}`] = true;
    active.hasActed = attacksUsed(active) >= attackRollBudget(active);
  }
  if (target.isAlive && state.events.slice(eventCountBefore).some(event => event.kind === 'hit' && event.targetId === target.id)) {
    const postHit = activeActions.map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => (candidate.postHit?.trigger === 'weapon_hit' || (candidate.postHit?.trigger === 'melee_hit' && attack.type === 'melee')) && candidate.isBonusAction && canCastArenaSpell(active, candidate));
    if (postHit.length) state.pendingHit = { attackerId: active.id, targetId: target.id, actionIndexes: postHit.map(({ index }) => index), actionNames: postHit.map(({ candidate }) => candidate.name) };
  }
  checkBattleComplete(state);
}

/** Applies only an action generated by getLegalActions for the current turn. */
export function applyLegalAction(encounter: Encounter, action: ArenaAction): void {
  const state = encounter.state;
  const active = getActiveCreature(encounter);
  if (!state || !active) throw new EncounterError('No active creature.');
  const activeActions = getActiveActions(active);
  const legal = getLegalActions(encounter, active.id).find(candidate => candidate.id === action.id);
  if (!legal || (legal.type !== 'move_to' && legal.type !== 'move_aura' && legal.type !== 'species_teleport' && legal.type !== 'spell_teleport' && !sameArenaAction(legal, action))) {
    throw new EncounterError(`Illegal or stale arena action "${action.id}".`);
  }
  encounter.runWithRng(() => {
    if (legal.type === 'attack') {
      applyArenaAttack(state, active, activeActions, legal);
    } else if (legal.type === 'post_hit') {
      const pending = state.pendingHit;
      if (!pending || pending.attackerId !== active.id || (legal.actionIndex >= 0 && !pending.actionIndexes.includes(legal.actionIndex)) || pending.targetId !== legal.targetId) throw new EncounterError(`Illegal or stale post-hit action "${legal.id}".`);
      if (!legal.decline) {
        const spell = activeActions[legal.actionIndex];
        const target = state.creatures.find(candidate => candidate.id === pending.targetId);
        if (!spell || !target || !spell.postHit || !spell.isBonusAction || !canCastArenaSpell(active, spell) || !executeSpell(state, active, spell, target)) throw new EncounterError(`Illegal or stale post-hit spell "${legal.id}".`);
        active.bonusActionUsed = true;
      }
      state.pendingHit = undefined;
      checkBattleComplete(state);
    } else if (legal.type === 'spell') {
      const targets = (legal.targetIds ?? [legal.targetId]).map(id => state.creatures.find(c => c.id === id)).filter((target): target is Creature => Boolean(target));
      const target = targets[0];
      const baseSpell = activeActions[legal.actionIndex];
      const spell = baseSpell && legal.areaShape && baseSpell.savingThrow
        ? { ...baseSpell, savingThrow: { ...baseSpell.savingThrow!, area: legal.areaShape } }
        : baseSpell && legal.effectKey && baseSpell.dispelMagic
          ? { ...baseSpell, dispelMagic: { ...baseSpell.dispelMagic, selectedKey: legal.effectKey } }
          : baseSpell && legal.damageResistance && baseSpell.damageResistanceChoice && baseSpell.buff
            ? { ...baseSpell, damageResistanceChoice: { ...baseSpell.damageResistanceChoice, selected: legal.damageResistance }, buff: { ...baseSpell.buff, resistDamageTypes: [legal.damageResistance] } }
          : baseSpell && legal.damageType && baseSpell.damageTypeChoice
            ? {
              ...baseSpell,
              damageTypeChoice: { ...baseSpell.damageTypeChoice, selected: legal.damageType },
              damageType: legal.damageType,
              buff: baseSpell.buff?.grantsAction
                ? { ...baseSpell.buff, grantsAction: { ...baseSpell.buff.grantsAction, damageType: legal.damageType, damageTypeChoice: { choices: baseSpell.buff.grantsAction.damageTypeChoice?.choices ?? [], selected: legal.damageType } } }
                : baseSpell.buff,
            }
              : baseSpell && legal.sizeChange && baseSpell.sizeChangeChoice
                ? {
                    ...baseSpell,
                    sizeChangeChoice: { ...baseSpell.sizeChangeChoice, selected: legal.sizeChange },
                    buff: legal.sizeChange === 'enlarge'
                      ? { name: 'Enlarge', key: 'enlarge-reduce', requiresConcentration: true, strengthTestAdvantage: true, weaponDamageBonusDice: '1d4' }
                      : { name: 'Reduce', key: 'enlarge-reduce', requiresConcentration: true, strengthTestDisadvantage: true, weaponDamagePenaltyDice: '1d4' },
                  }
              : baseSpell && legal.curseChoice ? withCurseChoice(baseSpell, legal.curseChoice)
          : baseSpell;
      if (!spell || spell.name !== legal.actionName || !isSpellAction(spell)) throw new EncounterError(`Stale arena spell "${legal.id}".`);
      if (!target || !executeSpell(state, active, spell, target, spell.autoDarts || spell.multiTargetAttack || spell.multiTargetSave || spell.multiTargetBuff || spell.multiTargetHeal || spell.attackThenArea || spell.savingThrow?.area || spell.persistentZone ? targets : undefined, legal.center)) throw new EncounterError(`Illegal or stale arena spell "${legal.id}".`);
      if (spell.isBonusAction) active.bonusActionUsed = true;
      else if (spell.replacesAttack) {
        active.turnFlags[`arena-attack-${attacksUsed(active)}`] = true;
        active.hasActed = attacksUsed(active) >= attackRollBudget(active);
      } else active.hasActed = true;
      checkBattleComplete(state);
    } else if (legal.type === 'spell_teleport') {
      const destination = action.type === 'spell_teleport' ? action.destination : undefined;
      const spell = activeActions[legal.actionIndex];
      if (!destination || !Number.isInteger(destination.x) || !Number.isInteger(destination.y) || !spell || spell.name !== legal.actionName || !spell.teleport || !executeSpell(state, active, spell, active, undefined, destination)) {
        throw new EncounterError(`Illegal or stale arena spell "${legal.id}".`);
      }
      if (spell.isBonusAction) active.bonusActionUsed = true;
      else active.hasActed = true;
      checkBattleComplete(state);
    } else if (legal.type === 'spell_summon') {
      const destination = legal.destination;
      const baseSpell = activeActions[legal.actionIndex];
      const variant = baseSpell?.summon?.variants.find(candidate => candidate.key === legal.variantKey);
      const spell = baseSpell && variant ? { ...baseSpell, summon: { ...baseSpell.summon!, variants: [variant] } } : undefined;
      if (!destination || !Number.isInteger(destination.x) || !Number.isInteger(destination.y) || !spell || spell.name !== legal.actionName || !executeSpell(state, active, spell, active, undefined, destination)) {
        throw new EncounterError(`Illegal or stale arena summon "${legal.id}".`);
      }
      if (spell.isBonusAction) active.bonusActionUsed = true;
      else active.hasActed = true;
      checkBattleComplete(state);
    } else if (legal.type === 'repeat_spell') {
      if (!tryUseBonusActionDamageBuff(state, active, legal.targetId)) throw new EncounterError(`Illegal or stale repeated spell "${legal.id}".`);
      checkBattleComplete(state);
    } else if (legal.type === 'spiritual_weapon') {
      const target = state.creatures.find(creature => creature.id === legal.targetId);
      if (!target || !useSpiritualWeaponAttack(state, active, target)) throw new EncounterError(`Illegal or stale Spiritual Weapon action "${legal.id}".`);
      checkBattleComplete(state);
    } else if (legal.type === 'repeat_area_spell') {
      const repeat = active.repeatableAreaSpell;
      const targets = legal.targetIds.map(id => state.creatures.find(creature => creature.id === id)).filter((target): target is Creature => Boolean(target));
      if (!repeat || repeat.name !== legal.spellName || !targets.length) throw new EncounterError(`Illegal or stale repeated area spell "${legal.id}".`);
      resolveAoE(state, active, {
        name: repeat.name, type: 'special', description: `Repeat ${repeat.name}.`, damageType: repeat.damageType,
        savingThrow: { ability: repeat.saveAbility, dc: repeat.saveDC, damageOnFail: repeat.damageDice, damageOnSuccess: 'half', area: legal.areaShape },
      }, targets, legal.center, undefined, true);
      active.hasActed = true;
      checkBattleComplete(state);
    } else if (legal.type === 'repeat_action_spell') {
      const repeat = active.repeatableActionSpell;
      const target = state.creatures.find(creature => creature.id === legal.targetId);
      if (!repeat || repeat.name !== legal.spellName || !target || target.team === active.team || !target.isAlive || creatureDistance(active, target) > 5) throw new EncounterError(`Illegal or stale repeated action spell "${legal.id}".`);
      const before = target.currentHp;
      resolveAttack(state, active, target, { name: repeat.name, type: 'melee', description: `Repeat ${repeat.name}.`, attackBonus: repeat.attackBonus, damage: repeat.damageDice, damageType: repeat.damageType, magical: true });
      if (repeat.healFromDamage) applyHealing(state, active, Math.floor(Math.max(0, before - target.currentHp) / 2), active, repeat.name);
      active.hasActed = true;
      checkBattleComplete(state);
    } else if (legal.type === 'move_aura') {
      const destination = action.type === 'move_aura' ? action.destination : undefined;
      if (!destination || !moveConcentrationAura(state, active, destination)) throw new EncounterError('Illegal or stale concentration-aura destination.');
      if (active.concentrationAura?.moveUsesAction !== false) active.hasActed = true;
      checkBattleComplete(state);
    } else if (legal.type === 'move_to') {
      applyArenaMove(encounter, state, active, action);
    } else if (legal.type === 'mount' || legal.type === 'dismount') {
      applyArenaMount(state, active, legal);
    } else if (legal.type === 'dash') {
      active.movementRemaining += getEffectiveMoveSpeed(active, state);
      if (legal.isBonusAction) active.bonusActionUsed = true;
      else if (legal.hasteAction) active.turnFlags.arenaHasteActionUsed = true;
      else active.hasActed = true;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Dash', details: `${active.displayName} dashes.`, type: 'move' });
    } else if (legal.type === 'dodge') {
      active.turnFlags.dodge = true;
      active.hasActed = true;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Dodge', details: `${active.displayName} dodges.`, type: 'special' });
    } else if (legal.type === 'disengage') {
      active.turnFlags.arenaDisengaged = true;
      if (legal.isBonusAction) active.bonusActionUsed = true;
      else if (legal.hasteAction) active.turnFlags.arenaHasteActionUsed = true;
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
      else if (legal.hasteAction) active.turnFlags.arenaHasteActionUsed = true;
      else active.hasActed = true;
      pushLog(state, {
        round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Hide',
        details: successes ? `${active.displayName} hides from ${successes} foe${successes === 1 ? '' : 's'}.` : `${active.displayName} fails to hide.`, type: 'special',
      });
    } else if (legal.type === 'escape_grapple') {
      if (!escapeGrapple(state, active, legal.sourceId, legal.ability)) throw new EncounterError('Illegal or stale arena grapple escape.');
      active.hasActed = true;
    } else if (legal.type === 'escape_condition') {
      if (!escapeBuff(state, active, legal.buffKey)) throw new EncounterError('Illegal or stale arena condition escape.');
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
      const strike = activeActions[legal.actionIndex];
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
