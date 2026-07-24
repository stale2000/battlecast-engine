/**
 * Hero spell + ability execution.
 *
 * Phase 4d refactor: extracted from the original monolithic combat.ts.
 * This is the casting "dispatcher" - given a spell action and a target
 * (or target list), pick the right resolver:
 *
 *   autoDarts            -> applyAutoDarts        (Magic Missile)
 *   heal                 -> applyHealing          (Cure Wounds, Healing Word, Mass Cure)
 *   buff                 -> applyBuffFromSpell    (Bless, Hex, Hunter's Mark, Rage)
 *   savingThrow + targets -> resolveAoE          (Fireball, Sacred Flame)
 *   attackBonus + target  -> resolveAttack        (Fire Bolt, Guiding Bolt)
 *
 * Includes slot/resource consumption and concentration-aura attachment
 * for ongoing-effect spells (Moonbeam, Spirit Guardians, etc.).
 *
 * There is an ESM cycle: combat-spellcasting imports applyDamage /
 * pushLog / resolveAttack / getAliveCreatures from combat.ts; combat.ts
 * re-exports executeSpell / applyHealing / applyAutoDarts /
 * applyBuffFromSpell back from this module. Same lazy-binding pattern
 * as the other Phase 4 modules - all cross-module calls happen inside
 * function bodies, never at module init.
 */
import { ActiveBuff, Condition, Creature, MonsterAction } from '../types/monster.js';
import { BASE_DURATIONS } from '../types/animation.js';
import { rollDice, abilityModifier, maxDiceTotal } from './dice.js';
import { creatureDistance, getFootprintSize, isPositionBlocked } from './combat-geometry.js';
import { canSeePoint } from './visibility.js';
import {
  addBuff, dropConcentratedBuffsFrom, removeActiveBuff,
  hasResource, consumeResource,
  attachConcentrationAura, rollSaveWithBuffs, getSpellSaveDcBonus, applyDamageRollPenalty,
} from './combat-buffs.js';
import { pushTargetAwayFromCaster, resolveAoE } from './combat-aoe.js';
import {
  applyDamage, applyCondition, applyActionRuntimeEffects, gainHp, pushLog, resolveAttack, getAliveCreatures, createSummonedCreature,
  getEffectiveMoveSpeed, getEffectiveSaveModifier, resolveSpellReflection, createPersistentZone,
  type BattleState,
} from './combat.js';

const SIZE_STEPS = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'] as const;

function hasBoonOfSpellRecall(caster: Creature): boolean {
  const heroLevel = caster.monsterData.heroLevel ?? 0;
  return heroLevel >= 19 && (caster.monsterData.heroClass === 'Bard' || caster.monsterData.heroClass === 'Wizard');
}

function shouldPreserveSpellSlot(caster: Creature, slotLevel: number): boolean {
  if (!hasBoonOfSpellRecall(caster) || slotLevel < 1 || slotLevel > 4) return false;
  return rollDice('1d4').total === slotLevel;
}

function isLifeDomainCleric(caster: Creature, minLevel: number): boolean {
  return caster.monsterData.heroClass === 'Cleric' && (caster.monsterData.heroLevel ?? 0) >= minLevel;
}

function rollHealingTotal(caster: Creature, action: MonsterAction, slotLevelUsed: number | null, target?: Creature): number {
  const shouldMaximizeDice = isLifeDomainCleric(caster, 17) || target?.activeBuffs.some(buff => buff.maximizesHealing) === true;
  let amount = shouldMaximizeDice
    ? maxDiceTotal(action.heal!.dice)
    : rollDice(action.heal!.dice, caster.monsterData.healingRerollOnes === true).total;
  if (action.heal!.addCastingMod && action.castingAbility) {
    amount += abilityModifier(caster.monsterData.abilities[action.castingAbility]);
  }
  if (slotLevelUsed !== null && isLifeDomainCleric(caster, 3)) {
    amount += 2 + slotLevelUsed;
  }
  return amount;
}

function capHealingTotalForAction(action: MonsterAction, target: Creature, amount: number): number {
  const maxFraction = action.heal?.maxTargetHpFraction;
  if (maxFraction === undefined) return amount;
  const cap = Math.floor(target.maxHp * maxFraction);
  return Math.max(0, Math.min(amount, cap - target.currentHp));
}

function clearHealingSpellConditions(
  state: BattleState,
  caster: Creature,
  target: Creature,
  action: MonsterAction,
): void {
  const clears = action.heal?.clearsConditions ?? [];
  for (const condition of clears) {
    if (!target.conditions.includes(condition)) continue;
    target.conditions = target.conditions.filter(c => c !== condition);
    target.conditionTimers = target.conditionTimers.filter(t => t.condition !== condition);
    state.events.push({
      kind: 'condition',
      creatureId: target.id,
      condition,
      applied: false,
      durationMs: BASE_DURATIONS.condition,
    });
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: caster.displayName,
      action: action.name,
      details: `${target.displayName} is no longer ${condition}.`,
      type: 'condition',
    });
  }
}

/** Resolve a spell whose casting time is "immediately after you hit".
 * The arena has already resolved the weapon hit; this applies only the
 * spell's validated rider and never makes a second attack roll. */
function executePostHitSpell(state: BattleState, caster: Creature, action: MonsterAction, target: Creature, slotLevelUsed: number): boolean {
  if (!action.postHit || !['melee_hit', 'weapon_hit'].includes(action.postHit.trigger) || !target.isAlive || target.team === caster.team
    || state.pendingHit?.attackerId !== caster.id || state.pendingHit.targetId !== target.id
    || !state.pendingHit.actionNames.includes(action.name)) return false;
  if (action.concentration) {
    dropConcentratedBuffsFrom(state, caster.id);
    caster.concentratingOn = action.name;
  }
  if (action.damage) {
    const damage = applyDamageRollPenalty(caster, rollDice(action.damage).total);
    const before = target.currentHp;
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: caster.displayName, action: action.name, details: `${caster.displayName} adds ${damage} ${action.damageType ?? 'untyped'} damage with ${action.name}.`, damage, type: 'damage' });
    const event = { kind: 'hit' as const, targetId: target.id, damage, damageType: action.damageType ?? 'untyped', critical: false, targetHpBefore: before, targetHpAfter: before, durationMs: BASE_DURATIONS.hit };
    state.events.push(event);
    applyDamage(state, target, damage, action.damageType ?? 'untyped', caster, true, true, false);
    event.targetHpAfter = target.currentHp;
  }
  if (action.savingThrow && target.isAlive) {
    const dc = action.savingThrow.dc + getSpellSaveDcBonus(caster, action);
    const save = rollSaveWithBuffs(target, getEffectiveSaveModifier(target, action.savingThrow.ability, state), false, dc, action.savingThrow.ability);
    const success = save.total >= dc;
    state.events.push({ kind: 'save', targetId: target.id, success, durationMs: BASE_DURATIONS.save });
    if (!success) {
      if (action.savingThrow.conditionOnFail) applyCondition(state, target, action.savingThrow.conditionOnFail, caster, action.savingThrow.conditionDuration, dc, action.savingThrow.ability);
      if (action.pushOnFailedSave) pushTargetAwayFromCaster(state, caster, target, action.pushOnFailedSave, action.name);
    }
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: caster.displayName, action: action.name, details: success ? `${target.displayName} succeeds on the ${action.name} save.` : `${target.displayName} fails the ${action.name} save.`, type: 'save' });
  }
  applyActionRuntimeEffects(state, caster, target, action);
  void slotLevelUsed;
  return true;
}

function applySteedLifeBond(state: BattleState, caster: Creature, amount: number): void {
  if (amount <= 0) return;
  const steed = state.creatures.find(creature => creature.controlledMountForId === caster.id && creature.isAlive);
  if (steed && creatureDistance(caster, steed) <= 5) applyHealing(state, steed, amount, caster, 'Life Bond');
}

function tryAutomaticCounterspell(state: BattleState, caster: Creature, action: MonsterAction): boolean {
  if (action.name === 'Counterspell' || (action.spellLevel ?? 0) > 3) return false;
  const counterspeller = state.creatures
    .filter(candidate => candidate.isAlive && candidate.team !== caster.team && !candidate.reactionUsed && !candidate.conditions.some(condition => ['incapacitated', 'paralyzed', 'stunned', 'unconscious'].includes(condition)) && creatureDistance(candidate, caster) <= 60)
    .filter(candidate => candidate.monsterData.actions.some(candidateAction => candidateAction.name === 'Counterspell' && candidateAction.reactionOnly) && hasResource(candidate, 'slot-3'))
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!counterspeller) return false;
  consumeResource(counterspeller, 'slot-3');
  counterspeller.reactionUsed = true;
  counterspeller.stats.actionUsage.Counterspell = (counterspeller.stats.actionUsage.Counterspell || 0) + 1;
  pushLog(state, { round: state.round, turn: state.turnIndex, actor: counterspeller.displayName, action: 'Counterspell', details: `${counterspeller.displayName} counters ${caster.displayName}'s ${action.name}.`, type: 'special' });
  return true;
}

function removeSpellConditions(
  state: BattleState,
  caster: Creature,
  target: Creature,
  action: MonsterAction,
): void {
  for (const condition of action.removesConditions ?? []) {
    if (!target.conditions.includes(condition)) continue;
    target.conditions = target.conditions.filter(candidate => candidate !== condition);
    target.conditionTimers = target.conditionTimers.filter(timer => timer.condition !== condition);
    state.events.push({ kind: 'condition', creatureId: target.id, condition, applied: false, durationMs: BASE_DURATIONS.condition });
    pushLog(state, {
      round: state.round, turn: state.turnIndex, actor: caster.displayName, action: action.name,
      details: `${caster.displayName} ends ${condition} on ${target.displayName}.`, type: 'condition',
    });
  }
}

function applyLifeDomainBlessedHealer(
  state: BattleState,
  caster: Creature,
  slotLevelUsed: number | null,
  healedAnotherCreature: boolean,
): void {
  if (slotLevelUsed === null || !healedAnotherCreature || !isLifeDomainCleric(caster, 6)) return;
  applyHealing(state, caster, 2 + slotLevelUsed, caster, 'Blessed Healer');
}

function applyLandAidHeal(state: BattleState, caster: Creature, action: MonsterAction): void {
  if (!action.landAidHealDice) return;
  const range = action.range?.normal ?? 60;
  const target = getAliveCreatures(state)
    .filter(c => c.team === caster.team && c.currentHp < c.maxHp && creatureDistance(caster, c) <= range)
    .sort((a, b) => (a.currentHp / a.maxHp) - (b.currentHp / b.maxHp))[0];
  if (!target) return;
  const amount = rollHealingTotal(caster, { ...action, heal: { dice: action.landAidHealDice, addCastingMod: false } }, null);
  applyHealing(state, target, amount, caster, `${action.name} Heal`);
}

const LAY_ON_HANDS_POISON_CLEANSE: Condition[] = ['poisoned'];
const RESTORING_TOUCH_CONDITIONS: Condition[] = [
  'poisoned', 'blinded', 'charmed', 'deafened', 'frightened', 'paralyzed', 'stunned',
];

function clearableLayOnHandsConditions(source: Creature, target: Creature): Condition[] {
  if (source.monsterData.heroClass !== 'Paladin') return [];
  const paladinLevel = source.monsterData.heroLevel ?? 0;
  const candidates = paladinLevel >= 14 ? RESTORING_TOUCH_CONDITIONS : LAY_ON_HANDS_POISON_CLEANSE;
  return candidates.filter(condition => target.conditions.includes(condition));
}

function clearConditionsWithLayOnHands(state: BattleState, source: Creature, target: Creature, spellName: string): void {
  if (spellName !== 'Lay on Hands') return;
  if (source.monsterData.heroClass !== 'Paladin') return;

  const paladinLevel = source.monsterData.heroLevel ?? 0;
  for (const condition of clearableLayOnHandsConditions(source, target)) {
    if (!hasResource(source, 'lay-on-hands', 5)) return;
    consumeResource(source, 'lay-on-hands', 5);
    target.conditions = target.conditions.filter(c => c !== condition);
    target.conditionTimers = target.conditionTimers.filter(timer => timer.condition !== condition);
    state.events.push({
      kind: 'condition',
      creatureId: target.id,
      condition,
      applied: false,
      durationMs: BASE_DURATIONS.condition,
    });
    const actionName = condition === 'poisoned' && paladinLevel < 14 ? 'Lay on Hands Cleanse' : 'Restoring Touch';
    source.stats.actionUsage[actionName] = (source.stats.actionUsage[actionName] || 0) + 1;
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: source.displayName,
      action: actionName,
      details: `${source.displayName} spends 5 Lay on Hands points to remove ${condition} from ${target.displayName}.`,
      type: 'condition',
    });
  }
}

function layOnHandsCanHelp(source: Creature, target: Creature, resourceKey: string): boolean {
  if (!hasResource(source, resourceKey, 1)) return false;
  if (target.currentHp < target.maxHp) return true;
  return clearableLayOnHandsConditions(source, target).length > 0 && hasResource(source, resourceKey, 5);
}

/**
 * Heal a creature. Clamps at maxHp; restoring a downed creature to 1 HP
 * requires specific "revive" spells we don't simulate - Healing Word /
 * Cure Wounds only work on conscious allies.
 */
export function applyHealing(state: BattleState, target: Creature, amount: number, source: Creature, spellName: string): void {
  if (!target.isAlive) return;  // permanently dead - no in-combat revive
  const blockingEffect = target.ongoingEffects?.find(effect =>
    effect.noHealing && (!effect.condition || target.conditions.includes(effect.condition))
  );
  const healingBlocked = !!blockingEffect;
  if (healingBlocked) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: source.displayName, action: spellName,
      details: `${target.displayName} can't regain Hit Points while affected by ${blockingEffect!.key}.`,
      type: 'info'
    });
    return;
  }
  const before = target.currentHp;
  // Revive trigger fires for both dying heroes AND stabilised-unconscious
  // heroes (3-success outcome). SRD: any positive healing on a 0-HP creature
  // sets HP to the heal amount AND wakes them up. The previous gate on
  // `target.dying` only covered the dying case, leaving stabilised heroes
  // stuck unconscious after a Healing Word.
  const wasUnconsciousAtZero = (target.dying === true)
    || (target.currentHp === 0 && target.conditions.includes('unconscious'));
  if (wasUnconsciousAtZero) {
    target.dying = false;
    target.deathSaves = undefined;
    target.conditions = target.conditions.filter(c => c !== 'unconscious');
    target.conditionTimers = target.conditionTimers.filter(t => t.condition !== 'unconscious');
    // Revive is a life-state transition (set HP to the heal amount and wake
    // the creature), not an additive heal, so it stays a direct write.
    target.currentHp = Math.min(target.maxHp, amount);
    target.stats.timesRevived = (target.stats.timesRevived ?? 0) + 1;
    source.stats.alliesRevived = (source.stats.alliesRevived ?? 0) + 1;
  } else {
    gainHp(target, amount);
  }
  const healed = target.currentHp - before;
  if (healed > 0 && target.ongoingEffects?.length) {
    target.ongoingEffects = target.ongoingEffects.filter(effect => !effect.key.toLowerCase().includes('infernal wound'));
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: source.displayName, action: spellName,
    details: wasUnconsciousAtZero
      ? `${source.displayName} revives ${target.displayName} with ${spellName} - ${target.displayName} is back at ${target.currentHp}/${target.maxHp} HP.`
      : `${source.displayName} heals ${target.displayName} for ${healed} HP (${target.currentHp}/${target.maxHp}).`,
    type: 'heal'
  });
  state.events.push({
    kind: 'heal', creatureId: target.id, amount: healed,
    creatureHpBefore: before, creatureHpAfter: target.currentHp,
    durationMs: BASE_DURATIONS.heal,
  });
  if (wasUnconsciousAtZero) {
    state.events.push({
      kind: 'stabilise', creatureId: target.id, hpAfter: target.currentHp,
      durationMs: BASE_DURATIONS.stabilise,
    });
    state.events.push({
      kind: 'condition', creatureId: target.id, condition: 'unconscious',
      applied: false, durationMs: 0,
    });
  }
  clearConditionsWithLayOnHands(state, source, target, spellName);
}

export function applyTemporaryHp(state: BattleState, target: Creature, amount: number, source: Creature, actionName: string): void {
  if (!target.isAlive) return;
  const before = target.temporaryHp ?? 0;
  target.temporaryHp = Math.max(before, amount);
  const gained = target.temporaryHp - before;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: source.displayName,
    action: actionName,
    details: gained > 0
      ? `${source.displayName} grants ${target.displayName} ${gained} temporary HP (${target.temporaryHp} total).`
      : `${target.displayName} keeps ${before} temporary HP; ${actionName} would not improve it.`,
    type: 'special',
  });
  state.events.push({
    kind: 'message',
    text: `${target.displayName} gains ${gained > 0 ? gained : 0} temporary HP`,
    durationMs: BASE_DURATIONS.message,
  });
}

function powerWordTargets(
  state: BattleState,
  caster: Creature,
  action: MonsterAction,
  primaryTarget: Creature | null,
): Creature[] {
  if (!action.powerWord || !primaryTarget) return [];
  const targets = [primaryTarget];
  const secondaryRange = action.powerWord.secondaryRange;
  const isWordsOfCreation = caster.monsterData.heroClass === 'Bard' && (caster.monsterData.heroLevel ?? 0) >= 20;
  if (!secondaryRange || !isWordsOfCreation) return targets;

  const wantsAlly = action.powerWord.kind === 'heal';
  const secondary = getAliveCreatures(state)
    .filter(c => c.id !== primaryTarget.id)
    .filter(c => wantsAlly ? c.team === primaryTarget.team : c.team !== caster.team)
    .filter(c => creatureDistance(primaryTarget, c) <= secondaryRange)
    .sort((a, b) => wantsAlly
      ? (a.currentHp / a.maxHp) - (b.currentHp / b.maxHp)
      : a.currentHp - b.currentHp
    )[0];
  if (secondary) targets.push(secondary);
  return targets;
}

function clearPowerWordHealConditions(
  state: BattleState,
  caster: Creature,
  target: Creature,
  action: MonsterAction,
): void {
  const clears = action.powerWord?.clearsConditions ?? [];
  for (const condition of clears) {
    if (!target.conditions.includes(condition)) continue;
    target.conditions = target.conditions.filter(c => c !== condition);
    target.conditionTimers = target.conditionTimers.filter(t => t.condition !== condition);
    state.events.push({ kind: 'condition', creatureId: target.id, condition, applied: false, durationMs: BASE_DURATIONS.condition });
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: caster.displayName,
      action: action.name,
      details: `${target.displayName} is no longer ${condition}.`,
      type: 'condition',
    });
  }
  if (target.conditions.includes('prone') && !target.reactionUsed) {
    target.reactionUsed = true;
    target.conditions = target.conditions.filter(c => c !== 'prone');
    target.conditionTimers = target.conditionTimers.filter(t => t.condition !== 'prone');
    state.events.push({ kind: 'condition', creatureId: target.id, condition: 'prone', applied: false, durationMs: BASE_DURATIONS.condition });
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: caster.displayName,
      action: action.name,
      details: `${target.displayName} uses its Reaction to stand from Prone.`,
      type: 'condition',
    });
  }
}

function executePowerWord(
  state: BattleState,
  caster: Creature,
  action: MonsterAction,
  primaryTarget: Creature | null,
): boolean {
  if (!action.powerWord || !primaryTarget) return false;
  const targets = powerWordTargets(state, caster, action, primaryTarget);
  if (targets.length === 0) return false;

  for (const target of targets) {
    if (action.powerWord.kind === 'heal') {
      applyHealing(state, target, target.maxHp, caster, action.name);
      clearPowerWordHealConditions(state, caster, target, action);
      continue;
    }

    const threshold = action.powerWord.killThresholdHp ?? 100;
    const damageType = action.powerWord.fallbackDamageType ?? 'psychic';
    const damage = target.currentHp <= threshold
      ? target.currentHp + target.maxHp
      : rollDice(action.powerWord.fallbackDamage ?? '12d12').total;
    state.events.push({
      kind: 'attack',
      attackerId: caster.id,
      targetId: target.id,
      actionName: action.name,
      attackType: 'psychic',
      durationMs: BASE_DURATIONS.attack,
    });
    const details = target.currentHp <= threshold
      ? `${caster.displayName} speaks ${action.name}; ${target.displayName} has ${target.currentHp} HP and is compelled to die.`
      : `${caster.displayName} speaks ${action.name}; ${target.displayName} has more than ${threshold} HP and takes ${damage} ${damageType} damage.`;
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: caster.displayName,
      action: action.name,
      details,
      damage,
      type: 'damage',
    });
    const before = target.currentHp;
    const hitEvent = {
      kind: 'hit' as const,
      targetId: target.id,
      damage,
      damageType,
      critical: false,
      targetHpBefore: before,
      targetHpAfter: before,
      durationMs: BASE_DURATIONS.hit,
    };
    state.events.push(hitEvent);
    applyDamage(state, target, damage, damageType, caster, false, true);
    hitEvent.targetHpAfter = target.currentHp;
  }
  return true;
}

/**
 * Magic Missile style auto-hit darts. Each dart deals its own damage roll
 * (no attack roll, no save). Caller supplies targets (array, possibly
 * same creature multiple times). Shows as `autoDartDamage` with
 * `autoDartDamageType` on the action.
 */
export function applyAutoDarts(state: BattleState, caster: Creature, action: MonsterAction, targets: Creature[]): void {
  const damageType = action.autoDartDamageType ?? 'force';
  const diceExpr = action.autoDartDamage ?? '1d4+1';
  const reflectionCache = new Map<string, Creature | null>();
  const resolvedTargets = targets
    .map(target => {
      if (!target.isAlive) return null;
      if (!reflectionCache.has(target.id)) {
        const reflection = action.name === 'Magic Missile'
          ? resolveSpellReflection(state, caster, target, 'magicMissile', action.name)
          : 'none';
        reflectionCache.set(target.id,
          reflection === 'unaffected' ? null :
          reflection === 'reflected' ? caster :
          target
        );
      }
      return reflectionCache.get(target.id) ?? null;
    })
    .filter((target): target is Creature => !!target);

  for (const target of resolvedTargets) {
    if (!target.isAlive) continue;
    const dmg = applyDamageRollPenalty(caster, rollDice(diceExpr).total);
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: caster.displayName, action: action.name,
      details: `${caster.displayName}'s ${action.name} hits ${target.displayName} for ${dmg} ${damageType} damage.`,
      damage: dmg, type: 'damage',
    });
    const beforeHp = target.currentHp;
    state.events.push({ kind: 'hit', targetId: target.id, damage: dmg, damageType, critical: false, targetHpBefore: beforeHp, targetHpAfter: beforeHp, durationMs: BASE_DURATIONS.hit });
    // Single-target spell save: damage is magical.
    applyDamage(state, target, dmg, damageType, caster, false, true);
    const ev = state.events[state.events.length - (target.isAlive ? 1 : 2)] as { kind: 'hit'; targetHpAfter: number };
    if (ev.kind === 'hit') ev.targetHpAfter = target.currentHp;
  }
}

/**
 * Attach a buff to a target. Translates the static BuffTemplate on the
 * action into a runtime ActiveBuff with caster/round data. Drops the
 * caster's prior concentration if this new spell requires concentration.
 */
export function applyBuffFromSpell(
  state: BattleState,
  caster: Creature,
  target: Creature,
  action: MonsterAction,
  options: { skipConcentrationDrop?: boolean } = {},
): void {
  if (!action.buff) return;
  const tmpl = action.buff;
  const duration = action.durationRounds ?? 10;
  const endRound = state.round + duration;
  // Concentration: cast of a new concentration spell ends any old one.
  if (tmpl.requiresConcentration && !options.skipConcentrationDrop) {
    dropConcentratedBuffsFrom(state, caster.id);
    caster.concentratingOn = tmpl.key;
  }
  if (tmpl.requiresConcentration && options.skipConcentrationDrop) {
    caster.concentratingOn = tmpl.key;
  }
  const existingMaxHpBonus = target.activeBuffs.find(b => b.key === tmpl.key)?.maxHpBonus ?? 0;
  const existingSpeedBonus = target.activeBuffs.find(b => b.key === tmpl.key)?.speedBonus ?? 0;
  const buff: ActiveBuff = {
    name: tmpl.name, key: tmpl.key, casterId: caster.id,
    appliedRound: state.round, endRound,
    requiresConcentration: tmpl.requiresConcentration,
    spellLevel: action.spellLevel,
    attackBonus: tmpl.attackBonus,
    attackBonusDice: tmpl.attackBonusDice,
    saveBonus: tmpl.saveBonus,
    saveBonusDice: tmpl.saveBonusDice,
    acBonus: tmpl.acBonus,
    acMinimum: tmpl.acMinimum,
    acBaseFromDex: tmpl.acBaseFromDex,
    maxHpBonus: tmpl.maxHpBonus,
    damageRider: tmpl.damageRider,
    bonusActionDamage: tmpl.bonusActionDamage,
    bonusActionDash: tmpl.bonusActionDash,
    bonusActionDamageType: tmpl.bonusActionDamageType,
    bonusActionDamageRange: tmpl.bonusActionDamageRange,
    endsWhenTargetDies: tmpl.endsWhenTargetDies,
    resistPhysical: tmpl.resistPhysical,
    resistDamageTypes: tmpl.resistDamageTypes,
    resistAllDamageExcept: tmpl.resistAllDamageExcept,
    wardingBond: tmpl.wardingBond,
    rageDamageBonus: tmpl.rageDamageBonus,
    conditionalRider: tmpl.conditionalRider,
    reactiveDamage: tmpl.reactiveDamage,
    endsWhenTemporaryHpDepleted: tmpl.endsWhenTemporaryHpDepleted,
    preventDeath: tmpl.preventDeath,
    advantageForAttackerId: tmpl.advantageForAttackerId,
    advantageForAllAttackers: tmpl.advantageForAllAttackers,
    attackDisadvantage: tmpl.attackDisadvantage,
    attackDisadvantageAgainstCaster: tmpl.attackDisadvantageAgainstCaster,
    attackersHaveDisadvantage: tmpl.attackersHaveDisadvantage,
    saveDisadvantage: tmpl.saveDisadvantage,
    saveDisadvantageAbilities: tmpl.saveDisadvantageAbilities,
    abilityCheckDisadvantageAbilities: tmpl.abilityCheckDisadvantageAbilities,
    forcedDodgeSave: tmpl.forcedDodgeSave,
    forcedFlee: tmpl.forcedFlee,
    maximizesHealing: tmpl.maximizesHealing,
    speedPenalty: tmpl.speedPenalty,
    speedBonus: tmpl.speedBonus,
    stealthBonus: tmpl.stealthBonus,
    preventsOpportunityAttacks: tmpl.preventsOpportunityAttacks,
    attackBonusForAllAttackers: tmpl.attackBonusForAllAttackers,
    spellAttackAdvantage: tmpl.spellAttackAdvantage,
    spellSaveDcBonus: tmpl.spellSaveDcBonus,
    expiresOnSourceTurnStart: tmpl.expiresOnSourceTurnStart,
    strengthTestDisadvantage: tmpl.strengthTestDisadvantage,
    strengthTestAdvantage: tmpl.strengthTestAdvantage,
    damageRollPenalty: tmpl.damageRollPenalty,
    weaponDamageBonus: tmpl.weaponDamageBonus,
    weaponDamageBonusDice: tmpl.weaponDamageBonusDice,
    weaponDamagePenaltyDice: tmpl.weaponDamagePenaltyDice,
    weaponAttacksMagical: tmpl.weaponAttacksMagical,
    weaponDamageRider: tmpl.weaponDamageRider,
    weaponConditionOnHit: tmpl.weaponConditionOnHit,
    endsOnWeaponHit: tmpl.endsOnWeaponHit,
    appliedCondition: tmpl.appliedCondition,
    appliedConditions: tmpl.appliedConditions,
    endsOnDamage: tmpl.endsOnDamage,
    temporaryHpAtTurnStart: tmpl.temporaryHpAtTurnStart,
    conditionImmunities: tmpl.conditionImmunities,
    endsOnAttackOrCast: tmpl.endsOnAttackOrCast,
    mirrorImages: tmpl.mirrorImages,
    sanctuarySaveDc: tmpl.sanctuarySaveDc,
    attackersOfTypesHaveDisadvantage: tmpl.attackersOfTypesHaveDisadvantage,
    canSeeInvisible: tmpl.canSeeInvisible,
    suppressesInvisibility: tmpl.suppressesInvisibility,
    hasteAction: tmpl.hasteAction,
    limitAttacksToOne: tmpl.limitAttacksToOne,
    restrictActionBonusCombination: tmpl.restrictActionBonusCombination,
    saveAdvantageAbilities: tmpl.saveAdvantageAbilities,
    saveAdvantageConditions: tmpl.saveAdvantageConditions,
    saveEnds: tmpl.saveEnds,
    escapeAction: tmpl.escapeAction,
  };
  addBuff(target, buff);
  for (const condition of tmpl.appliedConditions ?? (tmpl.appliedCondition ? [tmpl.appliedCondition] : [])) {
    if (!target.conditions.includes(condition)) target.conditions.push(condition);
  }
  if (tmpl.maxHpBonus && tmpl.maxHpBonus > existingMaxHpBonus) {
    const increase = tmpl.maxHpBonus - existingMaxHpBonus;
    target.maxHp += increase;
    applyHealing(state, target, increase, caster, tmpl.name);
  }
  if (tmpl.speedBonus && tmpl.speedBonus > existingSpeedBonus) {
    target.movementRemaining += tmpl.speedBonus - existingSpeedBonus;
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: caster.displayName, action: tmpl.name,
    details: `${caster.displayName} casts ${tmpl.name} on ${target.id === caster.id ? 'self' : target.displayName}.`,
    type: 'special'
  });
  if (tmpl.key === 'rage' && target.monsterData.heroClass === 'Barbarian' && (target.monsterData.heroLevel ?? 0) >= 6) {
    for (const condition of ['charmed', 'frightened'] as const) {
      if (!target.conditions.includes(condition)) continue;
      target.conditions = target.conditions.filter(c => c !== condition);
      target.conditionTimers = target.conditionTimers.filter(t => t.condition !== condition);
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Mindless Rage',
        details: `${target.displayName}'s Rage ends ${condition}.`,
        type: 'condition',
      });
      state.events.push({
        kind: 'condition',
        creatureId: target.id,
        condition,
        applied: false,
        durationMs: 0,
      });
    }
  }
}

function scaleAttackSpellForSlot(action: MonsterAction, slotLevelUsed: number): MonsterAction {
  if (action.name === 'Aid' && action.buff?.maxHpBonus) {
    const baseLevel = action.spellLevel ?? 2;
    const maxHpBonus = action.buff.maxHpBonus + Math.max(0, slotLevelUsed - baseLevel) * 5;
    return {
      ...action,
      description: `Bolster up to 3 allies within 30 ft. Each target's Hit Point maximum and current Hit Points increase by ${maxHpBonus} for the encounter.`,
      buff: { ...action.buff, maxHpBonus },
    };
  }

  if (action.name === 'Armor of Agathys' && action.temporaryHp && action.buff?.reactiveDamage) {
    const amount = 5 * slotLevelUsed;
    return {
      ...action,
      description: `You gain ${amount} Temporary Hit Points for 1 hour. While you have those hit points, a creature that hits you with a melee attack takes ${amount} cold damage.`,
      temporaryHp: { ...action.temporaryHp, dice: String(amount) },
      buff: { ...action.buff, reactiveDamage: `${amount} cold` },
    };
  }

  if (action.name !== 'Witch Bolt' || !action.damage) return action;
  const baseLevel = action.spellLevel ?? 1;
  const extraDice = Math.max(0, slotLevelUsed - baseLevel);
  if (extraDice === 0) return action;
  const match = action.damage.match(/^(\d+)d12$/);
  if (!match) return action;
  return { ...action, damage: `${parseInt(match[1], 10) + extraDice}d12` };
}

function clearDeadBonusActionDamageLinks(state: BattleState, caster: Creature): void {
  let clearedConcentrationKey: string | undefined;
  for (const target of state.creatures) {
    if (target.isAlive || !target.activeBuffs) continue;
    const before = target.activeBuffs.length;
    target.activeBuffs = target.activeBuffs.filter(b => {
      const shouldClear = b.casterId === caster.id && b.bonusActionDamage && b.endsWhenTargetDies;
      if (shouldClear) clearedConcentrationKey = b.key;
      return !shouldClear;
    });
    if (target.activeBuffs.length !== before) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: caster.displayName, action: clearedConcentrationKey ?? 'Concentration',
        details: `${caster.displayName}'s linked spell ends because the target is down.`,
        type: 'special',
      });
    }
  }
  if (clearedConcentrationKey && caster.concentratingOn === clearedConcentrationKey) {
    caster.concentratingOn = undefined;
  }
}

function endAttackOrCastBuffs(state: BattleState, caster: Creature): void {
  for (const buff of [...caster.activeBuffs].filter(candidate => candidate.endsOnAttackOrCast)) {
    removeActiveBuff(state, caster, buff);
    pushLog(state, {
      round: state.round, turn: state.turnIndex, actor: caster.displayName,
      action: buff.name, details: `${caster.displayName} becomes visible.`, type: 'special',
    });
  }

}

/** Move the caster's spectral weapon up to its recorded speed and attack a chosen target. */
export function useSpiritualWeaponAttack(state: BattleState, caster: Creature, target: Creature): boolean {
  const weapon = caster.spiritualWeapon;
  if (!weapon || weapon.endRound <= state.round || caster.bonusActionUsed || !target.isAlive || target.team === caster.team) return false;
  const distanceToTarget = Math.max(Math.abs(target.position.x - weapon.position.x), Math.abs(target.position.y - weapon.position.y)) * 5;
  if (distanceToTarget > weapon.moveFt + 5) return false;
  weapon.position = { ...target.position };
  resolveAttack(state, caster, target, {
    name: 'Spiritual Weapon', type: 'melee', description: 'Spectral weapon attack.',
    attackBonus: weapon.attackBonus, damage: weapon.damage, damageType: weapon.damageType, reach: 5, magical: true,
  });
  caster.bonusActionUsed = true;
  return true;
}

function canReceiveTacticalBuff(creature: Creature): boolean {
  return creature.isAlive
    && !creature.dying
    && !(creature.currentHp === 0 && creature.conditions.includes('unconscious'));
}

function canReceiveAreaBuff(creature: Creature, action: MonsterAction): boolean {
  if (action.buff?.maxHpBonus) return creature.isAlive;
  return canReceiveTacticalBuff(creature);
}

/**
 * Resolve bonus-action damage from a maintained linked spell such as 2024
 * Witch Bolt. This is not a new spell cast, so it does not set the
 * bonusActionSpellCast flag.
 */
export function tryUseBonusActionDamageBuff(state: BattleState, caster: Creature, targetId?: string): boolean {
  clearDeadBonusActionDamageLinks(state, caster);
  if (caster.bonusActionUsed) return false;

  const linked = getAliveCreatures(state)
    .filter(target => target.team !== caster.team)
    .filter(target => targetId === undefined || target.id === targetId)
    .flatMap(target => (target.activeBuffs ?? [])
      .filter(b =>
        b.casterId === caster.id &&
        b.bonusActionDamage &&
        b.appliedRound < state.round &&
        creatureDistance(caster, target) <= (b.bonusActionDamageRange ?? Infinity)
      )
      .map(buff => ({ target, buff })))
    .sort((a, b) => a.target.currentHp - b.target.currentHp)[0];

  if (!linked) return false;

  const damageType = linked.buff.bonusActionDamageType ?? 'untyped';
  const amount = applyDamageRollPenalty(caster, rollDice(linked.buff.bonusActionDamage!).total);
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: caster.displayName, action: linked.buff.name,
    details: `${caster.displayName}'s ${linked.buff.name} deals ${amount} ${damageType} damage to ${linked.target.displayName}.`,
    damage: amount, type: 'damage',
  });
  const beforeHp = linked.target.currentHp;
  state.events.push({
    kind: 'hit', targetId: linked.target.id, damage: amount, damageType,
    critical: false, targetHpBefore: beforeHp, targetHpAfter: beforeHp,
    durationMs: BASE_DURATIONS.hit,
  });
  applyDamage(state, linked.target, amount, damageType, caster, false, true);
  const ev = state.events[state.events.length - (linked.target.isAlive ? 1 : 2)] as { kind: 'hit'; targetHpAfter: number };
  if (ev.kind === 'hit') ev.targetHpAfter = linked.target.currentHp;
  caster.bonusActionUsed = true;
  caster.stats.actionUsage[linked.buff.name] = (caster.stats.actionUsage[linked.buff.name] || 0) + 1;
  return true;
}

function applyBaneFromSpell(state: BattleState, caster: Creature, action: MonsterAction, selectedTargets?: Creature[]): void {
  if (!action.buff || !action.savingThrow) return;
  const { ability } = action.savingThrow;
  const dc = action.savingThrow.dc + getSpellSaveDcBonus(caster, action);
  if (action.buff.requiresConcentration) {
    dropConcentratedBuffsFrom(state, caster.id);
    caster.concentratingOn = action.buff.key;
  }
  const range = action.range?.normal ?? 30;
  const targets = (selectedTargets?.length ? selectedTargets : getAliveCreatures(state)
    .filter(c => c.team !== caster.team && creatureDistance(caster, c) <= range)
    .sort((a, b) => b.currentHp - a.currentHp)
    .slice(0, action.multiTargetSave?.maxTargets ?? 3))
    .filter(target => target.isAlive && target.team !== caster.team && creatureDistance(caster, target) <= range)
    .slice(0, action.multiTargetSave?.maxTargets ?? 3);

  for (const target of targets) {
    const saveMod = getEffectiveSaveModifier(target, ability, state);
    const save = rollSaveWithBuffs(target, saveMod, false, dc, ability);
    const passed = save.total >= dc;
    state.events.push({ kind: 'save', targetId: target.id, success: passed, durationMs: BASE_DURATIONS.save });
    if (passed) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Bane Save',
        details: `${target.displayName} resists Bane (${save.total} vs DC ${dc}).`,
        type: 'save'
      });
      continue;
    }
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Bane Save',
      details: `${target.displayName} fails against Bane (${save.total} vs DC ${dc}).`,
      type: 'save'
    });
    applyBuffFromSpell(state, caster, target, action, { skipConcentrationDrop: true });
  }
}

/**
 * Single entry point for casting a leveled spell. Consumes the slot
 * (or nothing if it's a cantrip), then dispatches to the right
 * resolver based on the action shape:
 *   autoDarts -> applyAutoDarts (Magic Missile)
 *   heal      -> applyHealing   (Cure Wounds, Healing Word)
 *   buff      -> applyBuffFromSpell  (Bless, Shield of Faith, Hex)
 *   attackBonus present -> resolveAttack (Fire Bolt, Guiding Bolt)
 *   savingThrow present -> resolveAoE   (Fireball, Sacred Flame)
 *
 * Returns true on successful cast, false if out of slots or invalid
 * target. Callers should only invoke this for actions where
 * action.spellLevel is defined.
 */
export function executeSpell(
  state: BattleState,
  caster: Creature,
  action: MonsterAction,
  primaryTarget: Creature | null,
  aoeTargets?: Creature[],
  /**
   * Optional explicit center for the AoE animation. When a hero casts a
   * point-origin spell (Fireball, Shatter, Lightning Bolt's endpoint), the
   * AI picks a target cell and passes it here so the visual AoE draws at
   * that cell instead of at the caster's feet. Monster-cast AoEs
   * (dragon breath) omit this and keep the caster-centered default.
   */
  aoeCenter?: { x: number; y: number },
): boolean {
  if (action.sizeChangeChoice) {
    const direction = action.sizeChangeChoice.selected;
    const current = primaryTarget?.temporarySize ?? primaryTarget?.monsterData.size;
    const index = current ? SIZE_STEPS.indexOf(current) : -1;
    const next = direction === 'enlarge' ? SIZE_STEPS[index + 1] : direction === 'reduce' ? SIZE_STEPS[index - 1] : undefined;
    if (!primaryTarget || !next || (direction === 'enlarge' && isPositionBlocked(primaryTarget.position, next, state.creatures, primaryTarget.id, state.terrainBlocked))) return false;
  }
  if (action.spiritualWeapon && caster.spiritualWeapon && caster.spiritualWeapon.endRound > state.round) return false;
  if (action.requiresNoHeavyArmor && primaryTarget?.monsterData.wearingHeavyArmor) return false;
  if (action.darkness) {
    const range = action.range?.normal ?? action.range?.long ?? 0;
    if (!aoeCenter || !Number.isInteger(aoeCenter.x) || !Number.isInteger(aoeCenter.y)
      || creatureDistance(caster, { ...caster, position: aoeCenter, monsterData: { ...caster.monsterData, size: 'Medium' } }) > range
      || !canSeePoint(state, caster, aoeCenter)) return false;
  }
  if (action.teleport) {
    const size = caster.wildShape?.size ?? caster.temporarySize ?? caster.monsterData.size;
    const footprint = getFootprintSize(size);
    const gridSize = state.gridSize ?? 20;
    if (!aoeCenter || !Number.isInteger(aoeCenter.x) || !Number.isInteger(aoeCenter.y)
      || Math.max(Math.abs(aoeCenter.x - caster.position.x), Math.abs(aoeCenter.y - caster.position.y)) * 5 > action.teleport.distanceFt
      || aoeCenter.x < 0 || aoeCenter.y < 0 || aoeCenter.x + footprint > gridSize || aoeCenter.y + footprint > gridSize
      || isPositionBlocked(aoeCenter, size, state.creatures, caster.id, state.terrainBlocked)
      || !canSeePoint(state, caster, aoeCenter)) return false;
  }
  if (action.summon) {
    const variant = action.summon.variants[0];
    const size = variant && getFootprintSize(variant.monsterData.size);
    const gridSize = state.gridSize ?? 20;
    if (!variant || !aoeCenter || !Number.isInteger(aoeCenter.x) || !Number.isInteger(aoeCenter.y)
      || Math.max(Math.abs(aoeCenter.x - caster.position.x), Math.abs(aoeCenter.y - caster.position.y)) * 5 > action.summon.rangeFt
      || aoeCenter.x < 0 || aoeCenter.y < 0 || aoeCenter.x + size! > gridSize || aoeCenter.y + size! > gridSize
      || isPositionBlocked(aoeCenter, variant.monsterData.size, state.creatures, undefined, state.terrainBlocked)
      || !canSeePoint(state, caster, aoeCenter)) return false;
  }
  if (action.revive) {
    const deathRound = primaryTarget?.stats.deathRound;
    if (!primaryTarget || primaryTarget.isAlive || primaryTarget.team !== caster.team || deathRound === undefined
      || state.round - deathRound > action.revive.maxDeathRounds) return false;
  }
  if (action.damageResistanceChoice && !action.damageResistanceChoice.choices.includes(action.damageResistanceChoice.selected ?? '')) return false;
  if (action.damageTypeChoice && !action.damageTypeChoice.choices.includes(action.damageTypeChoice.selected ?? '')) return false;
  if (action.curseChoice && (!action.curseChoice.selected || !action.curseChoice.choices.includes(action.curseChoice.selected))) return false;
  const level = action.spellLevel ?? 0;
  let slotLevelUsed = level;
  let spellSlotUsedForThisCast: number | null = null;

  // Slot check + consume. Cantrips cost nothing. For leveled spells we
  // find the LOWEST available slot >= spell's level and consume it. This
  // gives us two things automatically:
  //   (1) Warlock pact slots: Warlock L3 has only L2 slots but needs to
  //       cast Hex (spellLevel 1). Upcasting into the L2 slot works.
  //   (2) Full casters conserving high slots: Wizard casts Magic Missile
  //       using their lowest L1 slot, not an L3 slot.
  // Monster innate spellcasting (e.g. "Mage casts Fireball 2/Day", or
  // Lich at-will Fireball) skips the slot path entirely. The spellLevel
  // on these actions is informational (used by damage scaling and AI
  // valuation), not a consumable.
  if (level > 0 && !action.resourceCost && !action.atWill) {
    let chosenSlotLevel: number | null = null;
    for (let lvl = level; lvl <= 9; lvl++) {
      if (hasResource(caster, `slot-${lvl}`)) { chosenSlotLevel = lvl; break; }
    }
    if (chosenSlotLevel === null) return false;
    if (shouldPreserveSpellSlot(caster, chosenSlotLevel)) {
      pushLog(state, {
        round: state.round,
        turn: state.turnIndex,
        actor: caster.displayName,
        action: 'Boon of Spell Recall',
        details: `${caster.displayName} preserves a level ${chosenSlotLevel} spell slot.`,
        type: 'special',
      });
    } else {
      consumeResource(caster, `slot-${chosenSlotLevel}`);
    }
    slotLevelUsed = chosenSlotLevel;
    spellSlotUsedForThisCast = chosenSlotLevel;
  }

  // Non-slot resource cost: Barbarian Rage, Monk Ki, Fighter Second
  // Wind, AND monster innate per-spell counters (Mage Fireball uses).
  if (action.resourceCost) {
    if (!consumeResource(caster, action.resourceCost.key, action.resourceCost.amount)) {
      return false;
    }
  }
  if (action.layOnHands && primaryTarget && !layOnHandsCanHelp(caster, primaryTarget, action.layOnHands.resourceKey)) {
    return false;
  }

  // Track spell usage (catches all spell paths: buff, heal, AoE, attack, darts)
  caster.stats.actionUsage[action.name] = (caster.stats.actionUsage[action.name] || 0) + 1;
  if (action.isBonusAction && action.spellLevel !== undefined) {
    caster.turnFlags = { ...(caster.turnFlags ?? {}), bonusActionSpellCast: true };
  }
  const castAction = scaleAttackSpellForSlot(action, slotLevelUsed);
  if (tryAutomaticCounterspell(state, caster, castAction)) return true;
  if (castAction.attackThenArea && primaryTarget) {
    resolveAttack(state, caster, primaryTarget, castAction);
    const burst = {
      ...castAction,
      name: `${castAction.name} Burst`,
      type: 'special' as const,
      targetScope: 'area_enemies' as const,
      damageType: castAction.attackThenArea.damageType,
      savingThrow: {
        ability: castAction.attackThenArea.saveAbility,
        dc: castAction.attackThenArea.saveDc,
        damageOnFail: castAction.attackThenArea.damage,
        damageOnSuccess: 'half' as const,
        area: `${castAction.attackThenArea.radiusFt}-foot sphere`,
      },
      attackBonus: undefined,
      damage: undefined,
      attackThenArea: undefined,
    };
    const radius = castAction.attackThenArea.radiusFt;
    const burstTargets = getAliveCreatures(state).filter(target => creatureDistance(target, primaryTarget) <= radius);
    if (burstTargets.length) resolveAoE(state, caster, burst, burstTargets, primaryTarget.position, undefined, true);
    return true;
  }
  if (castAction.postHit && primaryTarget) {
    return executePostHitSpell(state, caster, castAction, primaryTarget, slotLevelUsed);
  }
  if (castAction.dashOnCast) {
    caster.movementRemaining += getEffectiveMoveSpeed(caster, state);
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: caster.displayName, action: 'Dash', details: `${caster.displayName} dashes while casting ${castAction.name}.`, type: 'move' });
  }

  if (castAction.darkness && aoeCenter) {
    if (castAction.darkness.requiresConcentration) {
      dropConcentratedBuffsFrom(state, caster.id);
      caster.concentratingOn = `darkness:${castAction.name}`;
    }
    state.darknessZones = (state.darknessZones ?? []).filter(zone =>
      zone.sourceId !== caster.id || !zone.requiresConcentration
    );
    state.darknessZones.push({
      sourceId: caster.id,
      x: aoeCenter.x,
      y: aoeCenter.y,
      radius: castAction.darkness.radius,
      endRound: state.round + castAction.darkness.durationRounds,
      requiresConcentration: castAction.darkness.requiresConcentration === true,
    });
    pushLog(state, {
      round: state.round, turn: state.turnIndex, actor: caster.displayName,
      action: castAction.name,
      details: `${caster.displayName} creates ${castAction.name}.`, type: 'special',
    });
    return true;
  }

  if (action.name !== 'Invisibility') endAttackOrCastBuffs(state, caster);

  if (castAction.teleport && aoeCenter) {
    const size = caster.wildShape?.size ?? caster.temporarySize ?? caster.monsterData.size;
    const footprint = getFootprintSize(size);
    const gridSize = state.gridSize ?? 20;
    if (!Number.isInteger(aoeCenter.x) || !Number.isInteger(aoeCenter.y)
      || Math.max(Math.abs(aoeCenter.x - caster.position.x), Math.abs(aoeCenter.y - caster.position.y)) * 5 > castAction.teleport.distanceFt
      || aoeCenter.x < 0 || aoeCenter.y < 0 || aoeCenter.x + footprint > gridSize || aoeCenter.y + footprint > gridSize
      || isPositionBlocked(aoeCenter, size, state.creatures, caster.id, state.terrainBlocked)
      || !canSeePoint(state, caster, aoeCenter)) return false;
    const from = { ...caster.position };
    caster.position = { ...aoeCenter };
    const rider = caster.riderId ? state.creatures.find(candidate => candidate.id === caster.riderId) : undefined;
    if (rider?.mountedOnId === caster.id) rider.position = { ...aoeCenter };
    state.events.push({ kind: 'move', creatureId: caster.id, from, to: { ...aoeCenter }, durationMs: 0 });
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: caster.displayName, action: castAction.name, details: `${caster.displayName} teleports to (${aoeCenter.x}, ${aoeCenter.y}).`, type: 'move' });
    return true;
  }

  if (castAction.summon && aoeCenter) {
    const variant = castAction.summon.variants[0];
    if (!variant) return false;
    if (castAction.concentration) {
      dropConcentratedBuffsFrom(state, caster.id);
      caster.concentratingOn = castAction.name;
    }
    const levelAboveBase = Math.max(0, slotLevelUsed - (variant.attack?.baseSpellLevel ?? castAction.spellLevel ?? 1));
    const monsterData = {
      ...variant.monsterData,
      ac: variant.monsterData.ac + levelAboveBase * (variant.acPerSlotLevel ?? 0),
      hp: variant.monsterData.hp + levelAboveBase * (variant.hpPerSlotLevel ?? 0),
      hpFormula: String(variant.monsterData.hp + levelAboveBase * (variant.hpPerSlotLevel ?? 0)),
      actions: variant.monsterData.actions.map(monsterAction => monsterAction.name !== variant.attack?.actionName ? monsterAction : {
        ...monsterAction,
        damage: `${variant.attack.dice}+${variant.attack.baseBonus + slotLevelUsed}`,
      }),
    };
    if (variant.attack?.attacksPerSpellLevels) monsterData.actions = [
      { name: 'Multiattack', type: 'multiattack', description: `The spirit makes ${Math.max(1, Math.floor(slotLevelUsed / variant.attack.attacksPerSpellLevels))} ${variant.attack.actionName} attack${slotLevelUsed >= variant.attack.attacksPerSpellLevels * 2 ? 's' : ''}.` },
      ...monsterData.actions,
    ];
    if (castAction.summon.controlledMount) {
      const previousSteeds = new Set(state.creatures.filter(creature => creature.controlledMountForId === caster.id).map(creature => creature.id));
      for (const rider of state.creatures) {
        if (!rider.mountedOnId || !previousSteeds.has(rider.mountedOnId)) continue;
        const steed = state.creatures.find(creature => creature.id === rider.mountedOnId);
        rider.mountedOnId = undefined;
        rider.position = { ...(steed?.position ?? caster.position) };
      }
      if (previousSteeds.size) {
        state.creatures = state.creatures.filter(creature => !previousSteeds.has(creature.id));
        state.initiativeOrder = state.initiativeOrder.filter(id => !previousSteeds.has(id));
      }
    }
    const summon = createSummonedCreature(state, caster, monsterData, aoeCenter, castAction.summon.durationRounds, {
      requiresConcentration: castAction.summon.requiresConcentration ?? castAction.concentration === true,
      controlledMount: castAction.summon.controlledMount,
    });
    if (!summon) return false;
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: caster.displayName, action: castAction.name, details: `${caster.displayName} summons ${summon.displayName}.`, type: 'special' });
    return true;
  }

  if (castAction.dispelMagic && primaryTarget) {
    const effect = primaryTarget.activeBuffs
      .filter(buff => buff.spellLevel !== undefined && buff.spellLevel <= castAction.dispelMagic!.maxSpellLevel)
      .find(buff => buff.key === castAction.dispelMagic!.selectedKey);
    if (!effect || !removeActiveBuff(state, primaryTarget, effect)) return false;
    pushLog(state, {
      round: state.round, turn: state.turnIndex, actor: caster.displayName,
      action: castAction.name,
      details: `${caster.displayName} dispels ${effect.name} on ${primaryTarget.displayName}.`, type: 'special',
    });
    return true;
  }

  if (castAction.revive && primaryTarget) {
    const deathRound = primaryTarget.stats.deathRound;
    if (primaryTarget.isAlive || primaryTarget.team !== caster.team || deathRound === undefined
      || state.round - deathRound > castAction.revive.maxDeathRounds) return false;
    primaryTarget.isAlive = true;
    primaryTarget.currentHp = castAction.revive.hp;
    primaryTarget.dying = false;
    primaryTarget.deathSaves = undefined;
    primaryTarget.conditions = [];
    primaryTarget.conditionTimers = [];
    primaryTarget.stats.deathRound = undefined;
    primaryTarget.stats.diedFromSaves = undefined;
    pushLog(state, {
      round: state.round, turn: state.turnIndex, actor: caster.displayName,
      action: castAction.name,
      details: `${caster.displayName} restores ${primaryTarget.displayName} to life with ${primaryTarget.currentHp} HP.`, type: 'heal',
    });
    return true;
  }

  if (castAction.spiritualWeapon && primaryTarget && castAction.attackBonus !== undefined && castAction.damage) {
    caster.spiritualWeapon = {
      position: { ...primaryTarget.position }, endRound: state.round + (castAction.durationRounds ?? 10), moveFt: castAction.spiritualWeapon.moveFt,
      attackBonus: castAction.attackBonus, damage: castAction.damage, damageType: castAction.damageType ?? 'force',
    };
    resolveAttack(state, caster, primaryTarget, { ...castAction, magical: true });
    return true;
  }

  if (castAction.repeatableAreaSpell && castAction.savingThrow?.damageOnFail && primaryTarget && aoeTargets) {
    caster.repeatableAreaSpell = {
      name: castAction.name, endRound: state.round + (castAction.durationRounds ?? 10), damageType: castAction.damageType ?? 'untyped',
      damageDice: castAction.savingThrow.damageOnFail, saveAbility: castAction.savingThrow.ability,
      saveDC: castAction.savingThrow.dc + getSpellSaveDcBonus(caster, castAction), area: castAction.savingThrow.area ?? '5-foot cylinder',
    };
    caster.concentratingOn = castAction.name;
    resolveAoE(state, caster, castAction, aoeTargets, aoeCenter, undefined, true);
    return true;
  }

  if (castAction.repeatableActionSpell && castAction.attackBonus !== undefined && castAction.damage && primaryTarget) {
    caster.repeatableActionSpell = { name: castAction.name, endRound: state.round + (castAction.durationRounds ?? 10), damageType: castAction.damageType ?? 'untyped', damageDice: castAction.damage, attackBonus: castAction.attackBonus, healFromDamage: castAction.repeatableActionSpell.healFromDamage };
    caster.concentratingOn = castAction.name;
    const before = primaryTarget.currentHp;
    resolveAttack(state, caster, primaryTarget, castAction);
    if (castAction.repeatableActionSpell.healFromDamage) applyHealing(state, caster, Math.floor(Math.max(0, before - primaryTarget.currentHp) / 2), caster, castAction.name);
    return true;
  }

  if (castAction.buffOnFailedSave?.requiresConcentration) {
    dropConcentratedBuffsFrom(state, caster.id);
    caster.concentratingOn = castAction.buffOnFailedSave.key;
  }

  if (castAction.powerWord) {
    return executePowerWord(state, caster, castAction, primaryTarget);
  }

  if (castAction.multiTargetAttack && aoeTargets?.length) {
    for (const target of aoeTargets.slice(0, castAction.multiTargetAttack.count)) {
      if (target.isAlive) resolveAttack(state, caster, target, castAction);
    }
    return true;
  }

  // Auto-hit darts (Magic Missile) - caller supplies dart targets
  if (castAction.autoDarts && aoeTargets && aoeTargets.length > 0) {
    applyAutoDarts(state, caster, castAction, aoeTargets.slice(0, castAction.autoDarts));
    return true;
  }

  // Healing
  if (castAction.heal && primaryTarget) {
    if (castAction.layOnHands) {
      const resourceKey = castAction.layOnHands.resourceKey;
      const available = caster.resources[resourceKey] ?? 0;
      const missingHp = Math.max(0, primaryTarget.maxHp - primaryTarget.currentHp);
      const amount = Math.min(available, missingHp);
      if (amount <= 0 && clearableLayOnHandsConditions(caster, primaryTarget).length === 0) return false;
      if (amount > 0 && !consumeResource(caster, resourceKey, amount)) return false;
      applyHealing(state, primaryTarget, amount, caster, castAction.name);
      return true;
    }

    let healedAnotherCreature = false;
    if (castAction.targetScope === 'all_allies_in_area') {
      const range = castAction.range?.normal ?? 30;
      const targets = (aoeTargets?.length ? aoeTargets : getAliveCreatures(state)
        .filter(c => c.team === caster.team && creatureDistance(caster, c) <= range))
        .filter(c => c.isAlive && c.team === caster.team && creatureDistance(caster, c) <= range)
        .slice(0, castAction.multiTargetHeal?.maxTargets ?? 6);
      for (const t of targets) {
        const beforeHeal = t.currentHp;
        const amount = capHealingTotalForAction(castAction, t, rollHealingTotal(caster, castAction, spellSlotUsedForThisCast, t));
        applyHealing(state, t, amount, caster, castAction.name);
        if (t.id === caster.id && spellSlotUsedForThisCast !== null) applySteedLifeBond(state, caster, Math.max(0, t.currentHp - beforeHeal));
        clearHealingSpellConditions(state, caster, t, castAction);
        if (t.id !== caster.id && t.currentHp > beforeHeal) healedAnotherCreature = true;
      }
    } else {
      const beforeHeal = primaryTarget.currentHp;
      const amount = capHealingTotalForAction(castAction, primaryTarget, rollHealingTotal(caster, castAction, spellSlotUsedForThisCast, primaryTarget));
      applyHealing(state, primaryTarget, amount, caster, castAction.name);
      if (primaryTarget.id === caster.id && spellSlotUsedForThisCast !== null) applySteedLifeBond(state, caster, Math.max(0, primaryTarget.currentHp - beforeHeal));
      clearHealingSpellConditions(state, caster, primaryTarget, castAction);
      if (primaryTarget.id !== caster.id && primaryTarget.currentHp > beforeHeal) healedAnotherCreature = true;
    }
    applyLifeDomainBlessedHealer(state, caster, spellSlotUsedForThisCast, healedAnotherCreature);
    return true;
  }

  if (castAction.temporaryHp && primaryTarget) {
    const amount = rollDice(castAction.temporaryHp.dice).total;
    applyTemporaryHp(state, primaryTarget, amount, caster, castAction.name);
    if (!castAction.buff) return true;
  }

  if (castAction.removesConditions && primaryTarget) {
    removeSpellConditions(state, caster, primaryTarget, castAction);
    if (!castAction.buff) return true;
  }

  if (castAction.grantsFlight && primaryTarget) {
    if (castAction.concentration) {
      dropConcentratedBuffsFrom(state, caster.id);
      caster.concentratingOn = castAction.name;
    }
    primaryTarget.temporaryFlightSpeed = castAction.grantsFlight.speed;
    primaryTarget.temporaryFlightExpiresRound = state.round + castAction.grantsFlight.durationRounds;
    primaryTarget.temporaryFlightSourceId = castAction.concentration ? caster.id : undefined;
    pushLog(state, {
      round: state.round, turn: state.turnIndex, actor: caster.displayName, action: castAction.name,
      details: `${primaryTarget.displayName} gains a ${castAction.grantsFlight.speed}-foot Fly Speed.`, type: 'special',
    });
    return true;
  }

  // Buff/debuff
  if (castAction.buff && primaryTarget && castAction.attackBonus === undefined) {
    if (castAction.name === 'Bane' && castAction.savingThrow) {
      applyBaneFromSpell(state, caster, castAction, aoeTargets);
      return true;
    }
    if (castAction.targetScope === 'all_allies_in_area') {
      if (castAction.buff.requiresConcentration) {
        dropConcentratedBuffsFrom(state, caster.id);
        caster.concentratingOn = castAction.buff.key;
      }
      const range = castAction.range?.normal ?? 30;
      const targets = (aoeTargets?.length ? aoeTargets : getAliveCreatures(state)
        .filter(c => c.team === caster.team && canReceiveAreaBuff(c, castAction) && creatureDistance(caster, c) <= range)
        .sort((a, b) => {
          if (castAction.buff?.maxHpBonus) {
            if (a.id === primaryTarget.id) return -1;
            if (b.id === primaryTarget.id) return 1;
            return (a.currentHp / a.maxHp) - (b.currentHp / b.maxHp);
          }
          return (a.id === caster.id ? -1 : b.id === caster.id ? 1 : b.currentHp - a.currentHp);
        })
        .slice(0, castAction.multiTargetBuff?.maxTargets ?? 3))
        .filter(c => c.team === caster.team && canReceiveAreaBuff(c, castAction) && creatureDistance(caster, c) <= range)
        .slice(0, castAction.multiTargetBuff?.maxTargets ?? 3);
      for (const t of targets) {
        applyBuffFromSpell(state, caster, t, castAction, { skipConcentrationDrop: true });
      }
      return true;
    }
    applyBuffFromSpell(state, caster, primaryTarget, castAction);
    if (castAction.sizeChangeChoice?.selected) {
      const index = SIZE_STEPS.indexOf(primaryTarget.temporarySize ?? primaryTarget.monsterData.size);
      primaryTarget.temporarySize = SIZE_STEPS[index + (castAction.sizeChangeChoice.selected === 'enlarge' ? 1 : -1)]!;
      primaryTarget.temporarySizeExpiresRound = state.round + (castAction.durationRounds ?? 10);
      primaryTarget.temporarySizeSourceId = caster.id;
    }
    return true;
  }

  // Area save spell (Fireball, Thunderwave, Sacred Flame if save-type)
  if (castAction.savingThrow && aoeTargets) {
    if (castAction.persistentAura?.damageOnInitialCast !== false) {
      resolveAoE(state, caster, castAction, aoeTargets, aoeCenter, undefined, true);
    }
    attachConcentrationAura(state, caster, castAction, aoeCenter);
    createPersistentZone(state, caster, castAction, aoeCenter ?? primaryTarget?.position);
    applyLandAidHeal(state, caster, castAction);
    return true;
  }

  // Single-target save spell with no AoE array (e.g., Sacred Flame)
  if (castAction.savingThrow && primaryTarget) {
    if (castAction.persistentAura?.damageOnInitialCast !== false) {
      resolveAoE(state, caster, castAction, [primaryTarget], aoeCenter, undefined, true);
    }
    attachConcentrationAura(state, caster, castAction, aoeCenter);
    createPersistentZone(state, caster, castAction, aoeCenter ?? primaryTarget?.position);
    return true;
  }

  // Attack-roll spell (Fire Bolt, Guiding Bolt, Eldritch Blast beam)
  if (castAction.attackBonus !== undefined && primaryTarget) {
    if (castAction.buff) {
      applyBuffFromSpell(state, caster, primaryTarget, castAction);
    }
    resolveAttack(state, caster, primaryTarget, castAction);
    return true;
  }

  if (castAction.persistentZone && aoeCenter) {
    if (castAction.concentration) {
      dropConcentratedBuffsFrom(state, caster.id);
      caster.concentratingOn = castAction.name;
    }
    createPersistentZone(state, caster, castAction, aoeCenter ?? primaryTarget?.position);
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: caster.displayName, action: castAction.name, details: `${caster.displayName} creates ${castAction.name}.`, type: 'special' });
    return true;
  }

  // Unknown shape - log and eat the slot
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: caster.displayName, action: action.name,
    details: `${caster.displayName} casts ${action.name} but the spell effect isn't simulated.`,
    type: 'info'
  });
  return true;
}
