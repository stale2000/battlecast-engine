import { engineRandom } from './rng.js';
import { Condition, ConditionDuration, Creature, LegendaryAction, MonsterAction } from '../types/monster.js';
import { BASE_DURATIONS } from '../types/animation.js';
import {
  BattleState, distance, getFootprintSize, creatureDistance, isPositionBlocked,
  getEnemies, getAliveCreatures,
  resolveAttack, resolveAoE, resolveSingleTargetSave, getAoETargets, pickRangedSphereCenter,
  executeSpell, applyHealing,
  processRegeneration, processRecharges, checkBattleComplete, applyDamage, applyCondition, applyTemporaryHp, pushLog,
  type TacticType,
  hasBuff, hasResource, consumeResource, addBuff,
  processConcentrationAuras, checkAuraEntry, triggerPersistentZones, expireBuffsForCreature, expireSourceTurnBuffs, dropConcentratedBuffsFrom,
  runDeathSave, stabiliseDyingAlly,
  getActiveSize, getActiveSpeed, getActiveTraits, hasActiveTrait,
  getEffectiveMoveSpeed, getEffectiveSaveModifier, getHydraHeadCount, canTakeReactions,
  processSwallowedTargets, resolveSwallowAction,
  processTargetTurnStartOngoingEffects, processSourceTurnStartOngoingEffects,
  processTargetTurnEndOngoingEffects,
  tryEscapeContainer, processHydraEndOfTurn,
  rollSaveWithBuffs,
} from './combat.js';
import { abilityModifier, averageDamage, rollSave, rollDice } from './dice.js';
import { getEligibleWildShapeBeasts } from '../data/heroes.js';
import { moveToward } from './ai-movement.js';
import { chooseSmartDestination } from './ai-movement-evaluator.js';
import {
  getActiveActions, getSpecialActions, getMultiattack,
  getMeleeActions, getRangedActions,
  shouldPreferRanged, selectTarget,
  estimateActionDamage, estimateDamage, expectedHitDamage,
  shouldUseAoE, shouldRetreat, bestAoEPosition,
  adjustForResistance,
} from './ai-targeting.js';
import { trySpellcast } from './ai-spellcasting.js';
import { revealVisibleHiddenCreatures } from './visibility.js';

/**
 * Turn orchestration: end-to-end "creature takes a turn" logic.
 *
 * Includes:
 *  - processConditionTimers / processTurnStartTraits / processTurnStart
 *  - handlePassiveAuras / processReel
 *  - parseMultiattack
 *  - executeTurn (the main per-creature dispatcher)
 *  - executeLegendaryAction
 *
 * All targeting decisions, damage math, movement step logic, and the
 * spellcasting decision tree live in sibling modules (ai-targeting,
 * ai-spellcasting, ai-movement, combat).
 */

/**
 * "Still a valid target for the attacker right now?" - shared guard for
 * mid-turn target re-validation (multiattack second swing, Flurry of
 * Blows ki-strike, Barbarian Frenzy bonus attack). The naive check
 * `target.isAlive ? target : reselect()` keeps a dying hero as the
 * target across follow-up swings because dying creatures are still
 * `isAlive=true`. That bypasses the team-level "finish downed"
 * tactic toggle - the attacker keeps whaling on a dying target even
 * when their team is configured to leave dying enemies alone.
 *
 * Returns false when the target is dead, OR when the target is dying
 * and the attacker's team does NOT have finishDowned enabled. Otherwise
 * true. Callers re-select via selectTarget when this returns false.
 */
function targetStillValid(state: BattleState, attacker: Creature, target: Creature | null | undefined): boolean {
  if (!target || !target.isAlive) return false;
  if (target.dying) {
    const finishDowned = attacker.team === 'red'
      ? state.teamTactics?.redFinishDowned
      : state.teamTactics?.blueFinishDowned;
    return !!finishDowned;
  }
  return true;
}

/** Haste grants exactly one weapon attack after the creature's normal action. */
function tryHasteFollowUp(state: BattleState, creature: Creature, strategy: 'nearest' | 'weakest' | 'strongest' | 'smart'): void {
  if (!(creature.activeBuffs ?? []).some(buff => buff.hasteAction)) return;
  const target = selectTarget(state, creature, strategy);
  if (!targetStillValid(state, creature, target)) return;
  const action = getActiveActions(creature)
    .filter(candidate => (candidate.type === 'melee' || candidate.type === 'ranged') && candidate.attackBonus !== undefined)
    .filter(candidate => creatureDistance(creature, target!) <= (candidate.type === 'melee'
      ? candidate.reach ?? 5
      : candidate.range?.long ?? candidate.range?.normal ?? 0))
    .sort((left, right) => estimateActionDamage(right, target!) - estimateActionDamage(left, target!))[0];
  if (action) resolveAttack(state, creature, target!, action);
}

function hasSpellcastingActions(creature: Creature): boolean {
  if (creature.monsterData.isHero || creature.monsterData.isHomebrew) return true;
  return creature.monsterData.actions.some(action =>
    !action.legendaryOnly && action.spellLevel !== undefined
  );
}

function teamStabilisesAllies(state: BattleState, team: 'red' | 'blue'): boolean {
  return team === 'red'
    ? state.teamTactics?.redStabiliseAllies !== false
    : state.teamTactics?.blueStabiliseAllies !== false;
}

function findDyingAllyToStabilise(state: BattleState, actor: Creature): Creature | null {
  if (!actor.monsterData.isHero) return null;
  if (!teamStabilisesAllies(state, actor.team)) return null;

  return state.creatures
    .filter(c =>
      c.id !== actor.id &&
      c.team === actor.team &&
      c.monsterData.isHero &&
      c.isAlive &&
      c.dying &&
      creatureDistance(actor, c) <= 5
    )
    .sort((a, b) =>
      (b.deathSaves?.failures ?? 0) - (a.deathSaves?.failures ?? 0) ||
      (a.deathSaves?.successes ?? 0) - (b.deathSaves?.successes ?? 0) ||
      a.displayName.localeCompare(b.displayName)
    )[0] ?? null;
}

function activeSpeedPenalty(creature: Creature): number {
  return Math.max(0, ...((creature.activeBuffs ?? []).map(b => b.speedPenalty ?? 0)));
}

function resetMovementStateForTurn(state: BattleState, creature: Creature): void {
  const speedZero = creature.conditions.includes('restrained') || creature.conditions.includes('grappled');
  const activeSpeed = getActiveSpeed(creature);
  const bestSpeed = Math.max(0, getEffectiveMoveSpeed(creature, state) - activeSpeedPenalty(creature));
  creature.movementRemaining = speedZero ? 0 : bestSpeed;
  creature.hasActed = false;
  // Flyers re-ascend at the start of their turn (modeling the
  // beginning-of-turn "fly back up" with the first chunk of movement).
  // Restrained, grappled, or otherwise speed-zero creatures can't fly -
  // they're held down. Ground creatures stay false. Both write
  // explicitly so we don't carry stale airborne state between turns.
  if (state.movementEnvironment !== 'underwater' && (activeSpeed.fly ?? 0) > 0 && !speedZero) {
    creature.airborne = true;
  } else {
    creature.airborne = false;
  }
}

function tryStabiliseDyingAlly(state: BattleState, actor: Creature): boolean {
  const ally = findDyingAllyToStabilise(state, actor);
  return ally ? stabiliseDyingAlly(state, actor, ally) : false;
}

function tryActivateSuperiorDefense(state: BattleState, creature: Creature): void {
  if (creature.monsterData.heroClass !== 'Monk' || (creature.monsterData.heroLevel ?? 0) < 18) return;
  if (!hasResource(creature, 'ki', 3) || hasBuff(creature, 'superior-defense')) return;
  if (creature.conditions.includes('incapacitated') || creature.conditions.includes('stunned') ||
      creature.conditions.includes('paralyzed') || creature.conditions.includes('petrified') ||
      creature.conditions.includes('unconscious')) return;
  if (getEnemies(state, creature).filter(enemy => enemy.isAlive).length === 0) return;

  consumeResource(creature, 'ki', 3);
  creature.activeBuffs.push({
    name: 'Superior Defense',
    key: 'superior-defense',
    casterId: creature.id,
    appliedRound: state.round,
    endRound: state.round + 10,
    resistAllDamageExcept: ['force'],
  });
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: creature.displayName,
    action: 'Superior Defense',
    details: `${creature.displayName} spends 3 Focus Points for resistance to all damage except Force.`,
    type: 'special',
  });
  creature.stats.actionUsage['Superior Defense'] = (creature.stats.actionUsage['Superior Defense'] || 0) + 1;
  state.events.push({ kind: 'effect', creatureId: creature.id, label: 'Superior Defense', tone: 'success', durationMs: BASE_DURATIONS.effect });
}

/**
 * Process condition timers at the start of a creature's turn.
 * Removes expired conditions and allows repeat saves for 1-minute conditions.
 */
export function processConditionTimers(state: BattleState, creature: Creature): void {
  const toRemove: number[] = [];
  const toEscalate: { index: number; stages: Condition[]; currentIndex: number; sourceId: string; saveDC?: number; saveAbility?: keyof Creature['monsterData']['abilities']; finalDuration?: ConditionDuration }[] = [];

  for (let i = creature.conditionTimers.length - 1; i >= 0; i--) {
    const timer = creature.conditionTimers[i];

    if (timer.duration === 'end_of_next_turn') {
      if (state.round > timer.appliedRound) {
        // Staged condition (e.g. cockatrice restrained → petrified): force escalation save on expiry
        if (timer.stageInfo && timer.saveDC && timer.saveAbility) {
          const saveMod = getEffectiveSaveModifier(creature, timer.saveAbility, state);
          const hasMR = hasActiveTrait(creature, 'Magic Resistance');
          const save = rollSaveWithBuffs(creature, saveMod, hasMR, timer.saveDC, timer.saveAbility, timer.condition);

          state.events.push({ kind: 'save', targetId: creature.id, success: save.total >= timer.saveDC, durationMs: BASE_DURATIONS.save });

          if (save.total >= timer.saveDC) {
            pushLog(state, {
              round: state.round, turn: state.turnIndex,
              actor: creature.displayName, action: 'Save',
              details: `${creature.displayName} shakes off ${timer.condition}! (${save.total} vs DC ${timer.saveDC})`,
              type: 'save'
            });
            toRemove.push(i);
          } else {
            pushLog(state, {
              round: state.round, turn: state.turnIndex,
              actor: creature.displayName, action: 'Failed Save',
              details: `${creature.displayName} fails the save and the condition worsens! (${save.total} vs DC ${timer.saveDC})`,
              type: 'condition'
            });
            toEscalate.push({ index: i, stages: timer.stageInfo.stages, currentIndex: timer.stageInfo.currentIndex, sourceId: timer.sourceId, saveDC: timer.saveDC, saveAbility: timer.saveAbility, finalDuration: timer.stageInfo.finalDuration });
          }
        } else {
          toRemove.push(i);
        }
      }
    } else if (timer.duration === 'start_of_next_turn') {
      // Remove at the start of the creature's next turn after application
      if (state.round > timer.appliedRound) {
        toRemove.push(i);
      }
    } else if (timer.duration === '1_minute') {
      // 1 minute = 10 rounds. Auto-expire after 10 rounds.
      if (state.round > timer.appliedRound + 10) {
        toRemove.push(i);
        continue;
      }
      // Allow repeat save at start of turn (if at least 1 round has passed)
      if (state.round > timer.appliedRound && timer.saveDC && timer.saveAbility) {
        const saveMod = getEffectiveSaveModifier(creature, timer.saveAbility, state);
        const hasMR = hasActiveTrait(creature, 'Magic Resistance');
        const save = rollSaveWithBuffs(creature, saveMod, hasMR, timer.saveDC, timer.saveAbility, timer.condition);

        state.events.push({ kind: 'save', targetId: creature.id, success: save.total >= timer.saveDC, durationMs: BASE_DURATIONS.save });

        if (save.total >= timer.saveDC) {
          pushLog(state, {
            round: state.round, turn: state.turnIndex,
            actor: creature.displayName, action: 'Save',
            details: `${creature.displayName} shakes off ${timer.condition}! (${save.total} vs DC ${timer.saveDC})`,
            type: 'save'
          });
          toRemove.push(i);
        } else {
          pushLog(state, {
            round: state.round, turn: state.turnIndex,
            actor: creature.displayName, action: 'Failed Save',
            details: `${creature.displayName} remains ${timer.condition}. (${save.total} vs DC ${timer.saveDC})`,
            type: 'condition'
          });
        }
      }
    }
    // 'permanent' conditions are never auto-removed
  }

  const removeSet = new Set(toRemove);
  for (const idx of toRemove) {
    const timer = creature.conditionTimers[idx];
    creature.conditions = creature.conditions.filter(c => c !== timer.condition);

    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: 'Condition Ends',
      details: `${creature.displayName} is no longer ${timer.condition}.`,
      type: 'condition'
    });
    state.events.push({
      kind: 'condition', creatureId: creature.id, condition: timer.condition, applied: false,
      durationMs: BASE_DURATIONS.condition,
    });
  }
  // Rebuild conditionTimers array, filtering out removed indices (avoids splice-index corruption)
  const escalateSet = new Set(toEscalate.map(e => e.index));
  creature.conditionTimers = creature.conditionTimers.filter((_, i) => !removeSet.has(i) && !escalateSet.has(i));

  // Process staged escalations (e.g. restrained → petrified)
  for (const esc of toEscalate) {
    const prevCondition = esc.stages[esc.currentIndex];
    creature.conditions = creature.conditions.filter(c => c !== prevCondition);
    state.events.push({
      kind: 'condition', creatureId: creature.id, condition: prevCondition, applied: false,
      durationMs: 0,
    });

    const nextIndex = esc.currentIndex + 1;
    const nextCondition = esc.stages[nextIndex];
    const isFinal = nextIndex >= esc.stages.length - 1;
    const nextDuration: ConditionDuration = isFinal ? (esc.finalDuration ?? 'permanent') : 'end_of_next_turn';
    const nextStageInfo = isFinal ? undefined : { stages: esc.stages, currentIndex: nextIndex };

    applyCondition(state, creature, nextCondition, { id: esc.sourceId } as Creature,
      nextDuration, esc.saveDC, esc.saveAbility, nextStageInfo);
  }
}

/**
 * Process trait-based conditions at the start of a creature's turn.
 * Handles Petrifying Gaze (Basilisk, Medusa), Frightful Presence, etc.
 */
function processTurnStartTraits(state: BattleState, creature: Creature): void {
  // Check if any nearby enemy has a gaze or aura trait that triggers on turn start
  const enemies = getEnemies(state, creature);

  for (const enemy of enemies) {
    if (!enemy.isAlive || getActiveTraits(enemy).length === 0) continue;

    // Petrifying Gaze (Basilisk)
    const petrifyingGaze = getActiveTraits(enemy).find(t => t.name === 'Petrifying Gaze');
    if (petrifyingGaze && creatureDistance(creature, enemy) <= 30) {
      const dcMatch = petrifyingGaze.description.match(/DC (\d+)/);
      const dc = dcMatch ? parseInt(dcMatch[1]) : 12;
      const abilityMatch = petrifyingGaze.description.match(/(Constitution|Wisdom|Dexterity|Strength|Intelligence|Charisma)/i);
      const ability = abilityMatch ? abilityMatch[1].toLowerCase().slice(0, 3) as keyof typeof creature.monsterData.abilities : 'con';

      // If already petrified, skip
      if (creature.conditions.includes('petrified')) continue;

      const saveMod = getEffectiveSaveModifier(creature, ability, state);
      const hasMR = hasActiveTrait(creature, 'Magic Resistance');
      const save = rollSave(saveMod, hasMR);

      state.events.push({ kind: 'save', targetId: creature.id, success: save.total >= dc, durationMs: BASE_DURATIONS.save });

      if (save.total >= dc) {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: creature.displayName, action: 'Save',
          details: `${creature.displayName} averts ${enemy.displayName}'s Petrifying Gaze! (${save.total} vs DC ${dc})`,
          type: 'save'
        });
      } else {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: creature.displayName, action: 'Failed Save',
          details: `${creature.displayName} fails against ${enemy.displayName}'s Petrifying Gaze! (${save.total} vs DC ${dc})`,
          type: 'save'
        });

        // Petrification stages: restrained → petrified
        if (creature.conditions.includes('restrained')) {
          // Upgrade to petrified
          creature.conditions = creature.conditions.filter(c => c !== 'restrained');
          creature.conditionTimers = creature.conditionTimers.filter(t => t.condition !== 'restrained');
          state.events.push({ kind: 'condition', creatureId: creature.id, condition: 'restrained', applied: false, durationMs: 0 });
          applyCondition(state, creature, 'petrified', enemy, 'permanent');
        } else {
          applyCondition(state, creature, 'restrained', enemy, '1_minute', dc, ability);
        }
      }
    }
  }
}

/** Turn start: expire buffs, process conditions, recharge, reset movement.
 *  Returns false if the creature can't act (incapacitated/dead). */
export function processTurnStart(state: BattleState, creature: Creature): boolean {
  const expiredSummons = state.creatures.filter(candidate => candidate.summonExpiresRound !== undefined && candidate.summonExpiresRound <= state.round);
  if (expiredSummons.length) {
    const expired = new Set(expiredSummons.map(candidate => candidate.id));
    state.creatures = state.creatures.filter(candidate => !expired.has(candidate.id));
    state.initiativeOrder = state.initiativeOrder.filter(id => !expired.has(id));
    if (expired.has(creature.id)) return false;
  }
  if (creature.spiritualWeapon && creature.spiritualWeapon.endRound <= state.round) creature.spiritualWeapon = undefined;
  if ((creature.repeatableAreaSpell && creature.repeatableAreaSpell.endRound <= state.round)
    || (creature.repeatableActionSpell && creature.repeatableActionSpell.endRound <= state.round)) dropConcentratedBuffsFrom(state, creature.id);
  if (creature.concentrationAura && creature.concentrationAura.endRound <= state.round) {
    dropConcentratedBuffsFrom(state, creature.id);
  }
  if (creature.concentrationAura) creature.concentrationAura.movedThisTurn = false;
  state.events.push({ kind: 'turnStart', creatureId: creature.id, durationMs: BASE_DURATIONS.turnStart });
  state.darknessZones = state.darknessZones?.filter(zone => zone.endRound > state.round);
  revealVisibleHiddenCreatures(state);
  // Dying hero at the start of their turn: roll a death save before any
  // other turn-start processing. Outcomes:
  //   - nat 20: dying cleared, currentHp=1, unconscious removed.
  //     We fall through and let the rest of processTurnStart run normally
  //     so the hero gets a full turn this round.
  //   - 3 successes: stabilised. dying cleared but still unconscious -
  //     the unconscious-skip branch below catches them.
  //   - 3 failures: permanently dead. Return false to skip the turn.
  //   - Otherwise: still dying + still unconscious; skip the turn.
  if (creature.dying) {
    runDeathSave(state, creature);
    if (!creature.isAlive) return false;
  }
  expireSourceTurnBuffs(state, creature);
  if (creature.activeBuffs) {
    expireBuffsForCreature(state, creature);
    for (const buff of creature.activeBuffs) {
      if (buff.temporaryHpAtTurnStart) applyTemporaryHp(state, creature, buff.temporaryHpAtTurnStart, creature, buff.name);
    }
  }
  creature.turnFlags = {};
  // Heroic Warrior (Fighter L10): gain Heroic Inspiration each turn
  if (creature.monsterData.heroClass === 'Fighter' && (creature.monsterData.heroLevel ?? 0) >= 10) {
    creature.turnFlags.heroicInspiration = true;
  }
  // Survivor (Champion Fighter L18): while Bloodied and above 0 HP,
  // regain 5 + CON modifier at the start of each turn.
  if (creature.monsterData.heroClass === 'Fighter' && (creature.monsterData.heroLevel ?? 0) >= 18
      && creature.currentHp > 0 && creature.currentHp <= Math.floor(creature.maxHp / 2)) {
    const amount = 5 + abilityModifier(creature.monsterData.abilities.con);
    applyHealing(state, creature, amount, creature, 'Survivor');
    creature.stats.actionUsage['Survivor'] = (creature.stats.actionUsage['Survivor'] || 0) + 1;
  }
  creature.reactionUsed = false;
  creature.reactionsUsed = 0;
  creature.bonusActionUsed = false;
  tryActivateHolyNimbus(state, creature);
  // Self-Restoration (Monk L10): auto-remove charmed, frightened, or poisoned
  if (creature.monsterData.heroClass === 'Monk' && (creature.monsterData.heroLevel ?? 0) >= 10) {
    for (const cond of ['charmed', 'frightened', 'poisoned'] as const) {
      if (creature.conditions.includes(cond)) {
        creature.conditions = creature.conditions.filter(c => c !== cond);
        creature.conditionTimers = creature.conditionTimers.filter(t => t.condition !== cond);
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: creature.displayName, action: 'Self-Restoration',
          details: `${creature.displayName} shakes off ${cond} via Self-Restoration!`,
          type: 'condition'
        });
        state.events.push({ kind: 'condition', creatureId: creature.id, condition: cond, applied: false, durationMs: 0 });
      }
    }
  }
  processConditionTimers(state, creature);
  if (creature.hasteLethargySourceId) {
    const sourceId = creature.hasteLethargySourceId;
    creature.hasteLethargySourceId = undefined;
    creature.conditionTimers = creature.conditionTimers.filter(timer => !(timer.condition === 'incapacitated' && timer.sourceId === sourceId));
    if (!creature.conditionTimers.some(timer => timer.condition === 'incapacitated')) creature.conditions = creature.conditions.filter(condition => condition !== 'incapacitated');
    pushLog(state, {
      round: state.round, turn: state.turnIndex, actor: creature.displayName,
      action: 'Haste', details: `${creature.displayName} loses its Haste turn.`, type: 'condition',
    });
    state.events.push({ kind: 'condition', creatureId: creature.id, condition: 'incapacitated', applied: false, durationMs: BASE_DURATIONS.condition });
    return false;
  }
  const incapacitated = creature.conditions.some(condition =>
    condition === 'incapacitated' || condition === 'stunned' || condition === 'paralyzed' || condition === 'petrified' || condition === 'unconscious'
  );
  if (incapacitated || (creature.temporaryFlightExpiresRound !== undefined && state.round >= creature.temporaryFlightExpiresRound)) {
    creature.temporaryFlightSpeed = undefined;
    creature.temporaryFlightExpiresRound = undefined;
  }
  if (incapacitated || (creature.temporarySizeExpiresRound !== undefined && state.round >= creature.temporarySizeExpiresRound)) {
    creature.temporarySize = undefined;
    creature.temporarySizeExpiresRound = undefined;
  }
  tryActivateSuperiorDefense(state, creature);
  processTargetTurnStartOngoingEffects(state, creature);
  if (!creature.isAlive) return false;
  processSourceTurnStartOngoingEffects(state, creature);
  checkBattleComplete(state);
  if (state.isComplete) {
    resetMovementStateForTurn(state, creature);
    return false;
  }
  processTurnStartTraits(state, creature);
  if (creature.conditions.includes('incapacitated') ||
      creature.conditions.includes('stunned') ||
      creature.conditions.includes('paralyzed') ||
      creature.conditions.includes('petrified') ||
      creature.conditions.includes('unconscious')) {
    // D&D 5e: all of these set speed to 0 in addition to skipping the turn.
    creature.movementRemaining = 0;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: 'Skipped',
      details: `${creature.displayName} is ${creature.conditions[0]} and cannot act!`,
      type: 'condition'
    });
    return false;
  }
  processRegeneration(state, creature);
  if (!creature.isAlive) return false;
  processConcentrationAuras(state, creature);
  if (!creature.isAlive) return false;
  if (creature.swallowedTargetId) {
    processSwallowedTargets(state, creature);
    checkBattleComplete(state);
    if (state.isComplete) return false;
  }
  processRecharges(creature);
  resetMovementStateForTurn(state, creature);
  const fleeBuff = creature.activeBuffs.find(buff => buff.forcedFlee);
  const fearSource = fleeBuff && state.creatures.find(candidate => candidate.id === fleeBuff.casterId && candidate.isAlive);
  if (fearSource) {
    const from = { ...creature.position };
    creature.movementRemaining *= 2;
    creature.position = moveToward(creature, {
      x: creature.position.x + Math.sign(creature.position.x - fearSource.position.x) * (state.gridSize ?? 20),
      y: creature.position.y + Math.sign(creature.position.y - fearSource.position.y) * (state.gridSize ?? 20),
    }, state);
    checkAuraEntry(state, creature, from);
    creature.hasActed = true;
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: creature.displayName, action: fleeBuff!.name, details: `${creature.displayName} dashes away in fear.`, type: 'condition' });
  }
  const forcedDodge = creature.activeBuffs.find(buff => buff.forcedDodgeSave);
  if (forcedDodge?.forcedDodgeSave) {
    const { ability, dc } = forcedDodge.forcedDodgeSave;
    const save = rollSaveWithBuffs(creature, getEffectiveSaveModifier(creature, ability, state), false, dc, ability);
    const passed = save.total >= dc;
    state.events.push({ kind: 'save', targetId: creature.id, success: passed, durationMs: BASE_DURATIONS.save });
    if (!passed) {
      creature.turnFlags.dodge = true;
      creature.hasActed = true;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: creature.displayName, action: forcedDodge.name, details: `${creature.displayName} is forced to Dodge (${save.total} vs DC ${dc}).`, type: 'condition' });
    }
  }
  return true;
}

function paladinAuraRange(paladin: Creature): number {
  return (paladin.monsterData.heroLevel ?? 0) >= 18 ? 30 : 10;
}

function isPaladinAuraActive(paladin: Creature): boolean {
  return paladin.isAlive
    && paladin.monsterData.heroClass === 'Paladin'
    && !paladin.conditions.some(condition =>
      condition === 'incapacitated' ||
      condition === 'unconscious' ||
      condition === 'stunned' ||
      condition === 'paralyzed' ||
      condition === 'petrified'
    );
}

function processHolyNimbusAuras(state: BattleState, creature: Creature): void {
  if (!creature.isAlive) return;
  const paladins = getAliveCreatures(state)
    .filter(paladin => paladin.team !== creature.team)
    .filter(paladin => isPaladinAuraActive(paladin))
    .filter(paladin => hasBuff(paladin, 'holy-nimbus'))
    .filter(paladin => creatureDistance(paladin, creature) <= paladinAuraRange(paladin));

  for (const paladin of paladins) {
    if (!creature.isAlive) return;
    const damage = Math.max(1, abilityModifier(paladin.monsterData.abilities.cha) + paladin.monsterData.proficiencyBonus);
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: paladin.displayName,
      action: 'Holy Nimbus',
      details: `${creature.displayName} takes ${damage} radiant damage from ${paladin.displayName}'s Holy Nimbus.`,
      damage,
      type: 'damage',
    });
    const beforeHp = creature.currentHp;
    const hitEvent = {
      kind: 'hit' as const,
      targetId: creature.id,
      damage,
      damageType: 'radiant',
      critical: false,
      targetHpBefore: beforeHp,
      targetHpAfter: beforeHp,
      durationMs: BASE_DURATIONS.hit,
    };
    state.events.push(hitEvent);
    applyDamage(state, creature, damage, 'radiant', paladin, false, true);
    hitEvent.targetHpAfter = creature.currentHp;
    paladin.stats.actionUsage['Holy Nimbus'] = (paladin.stats.actionUsage['Holy Nimbus'] || 0) + 1;
  }
}

/** Passive aura effects at start of turn (Fire Aura, Heat Aura, Fear Aura). */
export function handlePassiveAuras(state: BattleState, creature: Creature): void {
  processHolyNimbusAuras(state, creature);
  if (!creature.isAlive) return;

  // Fire Aura (Balor 3d8), Heat Aura (Remorhaz 3d10) - parse dice from description
  const damageAura = getActiveTraits(creature).find(t =>
    t.name === 'Fire Aura' || t.name === 'Heat Aura'
  );
  if (damageAura) {
    const diceMatch = damageAura.description.match(/(\d+d\d+)/);
    const diceExpr = diceMatch ? diceMatch[1] : '3d6';
    const dmgType = damageAura.name === 'Heat Aura' ? 'fire' : 'fire';
    for (const adj of getAliveCreatures(state).filter(c => c.id !== creature.id && creatureDistance(c, creature) <= 5)) {
      const dmg = rollDice(diceExpr).total;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: creature.displayName, action: damageAura.name,
        details: `${adj.displayName} takes ${dmg} fire damage from ${creature.displayName}'s ${damageAura.name}!`, damage: dmg, type: 'damage' });
      // Innate aura damage (Fire / Heat Aura) is magical for resistance purposes.
      applyDamage(state, adj, dmg, dmgType, creature, false, true);
    }
  }
  const fearAura = getActiveTraits(creature).find(t => t.name === 'Fear Aura');
  if (fearAura) {
    const dcMatch = fearAura.description.match(/DC (\d+)/);
    const dc = dcMatch ? parseInt(dcMatch[1]) : 15;
    for (const target of getEnemies(state, creature).filter(c => creatureDistance(c, creature) <= 20)) {
      if (target.conditions.includes('frightened')) continue;
      const saveMod = getEffectiveSaveModifier(target, 'wis', state);
      const hasMR = hasActiveTrait(target, 'Magic Resistance');
      const save = rollSave(saveMod, hasMR);
      state.events.push({ kind: 'save', targetId: target.id, success: save.total >= dc, durationMs: BASE_DURATIONS.save });
      if (save.total < dc) {
        applyCondition(state, target, 'frightened', creature, 'start_of_next_turn', dc, 'wis');
      } else {
        pushLog(state, { round: state.round, turn: state.turnIndex, actor: target.displayName, action: 'Save',
          details: `${target.displayName} resists ${creature.displayName}'s Fear Aura! (${save.total} vs DC ${dc})`, type: 'save' });
      }
    }
  }
}

/**
 * Reel: pull each creature grappled by `reeler` up to 6 cells (30 ft)
 * straight toward it. Finds the closest unblocked cell along the line.
 */
function processReel(state: BattleState, reeler: Creature): void {
  const grappledTargets = state.creatures.filter(c =>
    c.isAlive && c.conditions.includes('grappled') &&
    c.conditionTimers.some(t => t.condition === 'grappled' && t.sourceId === reeler.id)
  );
  if (grappledTargets.length === 0) return;

  for (const victim of grappledTargets) {
    const dx = reeler.position.x - victim.position.x;
    const dy = reeler.position.y - victim.position.y;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist <= 1) continue; // already adjacent

    const stepX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
    const stepY = dy === 0 ? 0 : dy > 0 ? 1 : -1;
    const maxSteps = Math.min(6, dist - 1); // pull up to 30 ft but stay 1 cell away
    let bestPos = victim.position;

    for (let s = 1; s <= maxSteps; s++) {
      const candidate = { x: victim.position.x + stepX * s, y: victim.position.y + stepY * s };
      if (candidate.x < 0 || candidate.y < 0 ||
          candidate.x >= (state.gridSize ?? 20) || candidate.y >= (state.gridSize ?? 20)) break;
      if (isPositionBlocked(candidate, getActiveSize(victim), state.creatures, victim.id, state.terrainBlocked)) break;
      bestPos = candidate;
    }

    if (bestPos.x !== victim.position.x || bestPos.y !== victim.position.y) {
      const from = { ...victim.position };
      victim.position = bestPos;
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: reeler.displayName, action: 'Reel',
        details: `${reeler.displayName} reels ${victim.displayName} closer!`,
        type: 'info'
      });
      state.events.push({ kind: 'move', creatureId: victim.id, from, to: bestPos, path: [from, bestPos], durationMs: BASE_DURATIONS.move });
    }
  }
}

/**
 * Resolve opportunity attacks triggered by `creature` leaving reach of
 * adjacent enemies. The creature has already been moved to its new
 * position when this runs; we rewind to the last in-reach cell along
 * the move's path for each OA so damage applies at the departure
 * square, then either truncate the move at that cell (and push a
 * continuation) so the replay shows the mover pausing there, or fall
 * back to a position rewind-restore when truncation isn't possible.
 *
 * Returns `true` when the creature died mid-movement (caller should
 * return immediately; the body's final cell is left on creature.position).
 *
 * Event mutation contract
 * -----------------------
 * This function mutates the move event already in `state.events` to
 * truncate it at the OA cell. That follows the codebase's established
 * "push then mutate" pattern (see resolveAttack's hit-event HP fix-up
 * in combat.ts). The invariant is: events can be mutated by the engine
 * before the replay's animation cursor reaches them; once consumed by
 * the runner they are effectively immutable. Since runOpportunityAttacks
 * runs synchronously inside the same turn as the move it modifies and
 * the replay always lags the engine by a full turn, the mutation is
 * never observed mid-flight.
 *
 * Splicing (vs mutating) is reserved for the single-OA death-fallback
 * case where there's no continuation to truncate. Splice shifts later
 * event indices, which can desynchronise cached `eventIndex` snapshots
 * on logs by 1 - a pre-existing minor visual issue inherited from the
 * original implementation, kept here to avoid scope creep.
 */
export function runOpportunityAttacks(
  state: BattleState,
  creature: Creature,
  oldPos: { x: number; y: number },
): boolean {
  // Flying-OA exemption (flying step 2): a creature that's currently
  // airborne is above ground melee reach, so leaving "reach" doesn't
  // actually leave reach - the ground creature was never able to swing
  // at it. Mirrors the 5e RAW reading of OA + flight.
  // `airborne` is set true at the start of a flyer's turn and flipped
  // to false the moment they make a melee attack (had to descend).
  // Flyer-vs-flyer (both have fly speed) still triggers OAs normally
  // since both can engage at altitude.
  const moverIsAirborne = !!creature.airborne;

  // Pull the path of the just-completed move so we can detect walk-past
  // cases - a mover that enters an enemy's reach mid-move and then leaves
  // it provokes too, not only movers that started adjacent. Matches the
  // 5e RAW reading where you provoke "as you leave reach", regardless of
  // whether reach was entered this turn or last.
  const moveIdx = state.events.findLastIndex(
    e => e.kind === 'move' && e.creatureId === creature.id
  );
  const moveEvent = moveIdx >= 0 ? state.events[moveIdx] : undefined;
  const movePath = (moveEvent && moveEvent.kind === 'move' && moveEvent.path)
    ? moveEvent.path
    : [oldPos, creature.position];
  // Tracks whether the move event has already been split for an OA this
  // call - prevents two enemies' OAs from both trying to truncate the
  // same event (the second OA fires at the truncated destination, not
  // perfectly accurate but visually coherent).
  let moveSplit = false;

  const oaEnemies = getEnemies(state, creature).filter(e => e.isAlive);
  for (const enemy of oaEnemies) {
    const oaMelee = getMeleeActions(enemy);
    // No melee actions means no reach and no possible OA. Silent skip -
    // this is geometry-irrelevant noise (e.g. a Wizard adjacent to a
    // mover would emit on every passer-by).
    if (oaMelee.length === 0) continue;

    const reach = oaMelee.reduce((max, a) => Math.max(max, a.reach || 5), 5);
    const distAfter = creatureDistance(enemy, creature);

    // Find the last cell along the path where the mover was still within
    // the enemy's reach. If one exists AND the mover ended outside reach,
    // an OA fires - rewound to that last in-reach cell, since that's the
    // square the mover was at when they "left reach."
    let lastInReachCell: { x: number; y: number } | null = null;
    for (const cell of movePath) {
      const d = Math.max(Math.abs(enemy.position.x - cell.x), Math.abs(enemy.position.y - cell.y)) * 5;
      if (d <= reach) lastInReachCell = cell;
    }
    const wouldProvoke = lastInReachCell !== null && distAfter > reach;
    if (!wouldProvoke) continue;

    const enemyIsFlyer = (getActiveSpeed(enemy).fly ?? 0) > 0;

    // (1) Airborne mover over grounded enemy: enemy can't swing skyward.
    if (moverIsAirborne && !enemyIsFlyer) {
      state.events.push({
        kind: 'oaAvoided', moverId: creature.id, enemyId: enemy.id,
        reason: 'flying', durationMs: BASE_DURATIONS.oaAvoided,
      });
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: enemy.displayName, action: 'Out of Reach',
        details: `${enemy.displayName} can't reach ${creature.displayName} - flying above melee range.`,
        type: 'info',
      });
      continue;
    }

    // (2) Reaction already spent this round - explicit log + event so
    // the user sees why a goblin walked past the Fighter unscathed.
    const reactionLimit = getHydraHeadCount(enemy) ?? 1;
    const reactionsUsed = enemy.reactionsUsed ?? (enemy.reactionUsed ? 1 : 0);
    if (enemy.activeBuffs?.some(b => b.preventsReactions || b.preventsOpportunityAttacks)) {
      state.events.push({
        kind: 'oaAvoided', moverId: creature.id, enemyId: enemy.id,
        reason: 'stunned', durationMs: BASE_DURATIONS.oaAvoided,
      });
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: enemy.displayName, action: 'OA Prevented',
        details: `${enemy.displayName} can't make an opportunity attack while staggered.`,
        type: 'info',
      });
      continue;
    }
    if (reactionsUsed >= reactionLimit) {
      state.events.push({
        kind: 'oaAvoided', moverId: creature.id, enemyId: enemy.id,
        reason: 'reactionUsed', durationMs: BASE_DURATIONS.oaAvoided,
      });
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: enemy.displayName, action: 'Reaction Spent',
        details: `${enemy.displayName} can't make an opportunity attack - reaction already used this round.`,
        type: 'info',
      });
      continue;
    }

    // (3) Disabling conditions block reactions.
    if (enemy.conditions.includes('incapacitated') || enemy.conditions.includes('stunned') ||
        enemy.conditions.includes('paralyzed') || enemy.conditions.includes('unconscious')) {
      state.events.push({
        kind: 'oaAvoided', moverId: creature.id, enemyId: enemy.id,
        reason: 'stunned', durationMs: BASE_DURATIONS.oaAvoided,
      });
      const cond = enemy.conditions.find(c => c === 'incapacitated' || c === 'stunned' || c === 'paralyzed' || c === 'unconscious');
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: enemy.displayName, action: 'OA Prevented',
        details: `${enemy.displayName} is ${cond} - can't take an opportunity attack.`,
        type: 'info',
      });
      continue;
    }

    // Real OA fires. Split the move event so the replay animates the
    // mover from their start cell to the OA cell, then pauses on the
    // OA swing, then animates the continuation to the final cell. This
    // makes the OA visible during the move instead of firing after the
    // mover already arrived at the destination.
    const savedPos = { ...creature.position };
    const oaCell = { ...lastInReachCell! };
    enemy.reactionsUsed = reactionsUsed + 1;
    enemy.reactionUsed = enemy.reactionsUsed >= reactionLimit;

    if (!moveSplit && moveEvent && moveEvent.kind === 'move' && moveIdx >= 0) {
      // Truncate the existing move event to end at the OA cell.
      const originalTo = { ...moveEvent.to };
      const oaPathIdx = movePath.findIndex(p => p.x === oaCell.x && p.y === oaCell.y);
      if (oaPathIdx >= 0) {
        const truncatedPath = movePath.slice(0, oaPathIdx + 1);
        const truncatedDist = truncatedPath.length - 1; // cells of movement up to oaCell
        moveEvent.to = { ...oaCell };
        moveEvent.path = truncatedPath.length > 1 ? truncatedPath : undefined;
        moveEvent.durationMs = Math.min(BASE_DURATIONS.move * Math.max(1, truncatedDist / 2), 800);

        // The OA's attack/hit/miss events will push next - they fire
        // against the mover at oaCell. After they're emitted (below),
        // we push a continuation move event if the mover survived.
        creature.position = oaCell;
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: enemy.displayName, action: 'Opportunity Attack',
          details: `${enemy.displayName} makes an opportunity attack against ${creature.displayName} (leaving ${reach} ft reach)!`,
          type: 'info',
        });
        resolveAttack(state, enemy, creature, oaMelee[0], { cause: 'opportunity' });
        moveSplit = true;

        if (!creature.isAlive) {
          // Dead at oaCell - body stays there. The truncated move event
          // already ends at oaCell so the replay is correct without
          // further changes.
          creature.position = oaCell;
          return true;
        }

        // Survived - push a continuation move event for the rest of the
        // original path so the replay finishes the move after the OA.
        const continuationPath = movePath.slice(oaPathIdx);
        const continuationDist = continuationPath.length - 1;
        creature.position = originalTo;
        state.events.push({
          kind: 'move',
          creatureId: creature.id,
          from: { ...oaCell },
          to: originalTo,
          path: continuationPath.length > 1 ? continuationPath : undefined,
          durationMs: Math.min(BASE_DURATIONS.move * Math.max(1, continuationDist / 2), 800),
        });
        continue;
      }
    }

    // Fallback path: no move event found or already split for an earlier
    // OA. Use the original rewind-then-restore behavior; the replay will
    // show this OA at the final destination, which is imperfect but
    // matches the visuals of the existing single-OA-per-move case.
    creature.position = oaCell;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: enemy.displayName, action: 'Opportunity Attack',
      details: `${enemy.displayName} makes an opportunity attack against ${creature.displayName} (leaving ${reach} ft reach)!`,
      type: 'info',
    });
    resolveAttack(state, enemy, creature, oaMelee[0], { cause: 'opportunity' });
    if (!creature.isAlive) {
      creature.position = oaCell;
      if (moveSplit) {
        // A prior OA already truncated the original move and pushed a
        // continuation event. We can't splice the original move - that
        // would orphan the continuation. Instead, truncate or splice
        // the continuation so the replay ends the chain at oaCell and
        // the body stays there. Without this, the replay would slide
        // the corpse through the rest of the original path.
        const contIdx = state.events.findLastIndex(
          e => e.kind === 'move' && e.creatureId === creature.id,
        );
        if (contIdx >= 0 && contIdx !== moveIdx) {
          const contMove = state.events[contIdx];
          if (contMove.kind === 'move') {
            const contPath = contMove.path ?? [contMove.from, contMove.to];
            const oaPathIdx = contPath.findIndex(p => p.x === oaCell.x && p.y === oaCell.y);
            if (oaPathIdx >= 0) {
              const truncated = contPath.slice(0, oaPathIdx + 1);
              contMove.to = { ...oaCell };
              contMove.path = truncated.length > 1 ? truncated : undefined;
              contMove.durationMs = Math.min(
                BASE_DURATIONS.move * Math.max(1, (truncated.length - 1) / 2),
                800,
              );
            } else {
              // oaCell isn't on the continuation's path - happens when
              // enemies are processed out of path order. Drop the
              // continuation; the body stays at oaCell (the truncated
              // original move ends at oaCell1, but creature.position
              // logically points at oaCell2 which is just visually
              // imperfect, not corrupting).
              state.events.splice(contIdx, 1);
            }
          }
        }
      } else if (moveIdx >= 0) {
        // No split yet - safe to splice the original move so the body
        // doesn't slide to the final destination.
        state.events.splice(moveIdx, 1);
      }
      return true;
    }
    creature.position = savedPos;
  }
  return false;
}

type TargetStrategy = 'nearest' | 'weakest' | 'strongest' | 'smart';

/**
 * Decide whether this creature should retreat this turn. Aggressive
 * and defensive tactics never retreat; barbarians never retreat;
 * kiting retreats below 50% HP; smart uses the default heuristic.
 */
function shouldRetreatForTactic(creature: Creature, tactic: TacticType): boolean {
  if (tactic === 'aggressive' || tactic === 'defensive') return false;
  if (creature.monsterData.heroClass === 'Barbarian') return false;
  if (tactic === 'kiting') return creature.currentHp / creature.maxHp <= 0.5;
  return shouldRetreat(creature);
}

/**
 * Retreat / Disengage / kiting-shot phase. Runs before target selection.
 * If the creature retreats, it returns `true` and the caller should end
 * the turn. A retreating creature:
 *   - Optionally Disengages (Rogues for free via Cunning Action, others
 *     when estimated OA damage is too painful).
 *   - Moves away from the nearest enemy.
 *   - If it didn't forfeit its action to Disengage (Rogues still can),
 *     fires a single ranged attack at the best available target.
 */
function runRetreat(
  state: BattleState,
  creature: Creature,
  enemies: Creature[],
  tactic: TacticType,
  targetStrategy: TargetStrategy,
): boolean {
  if (!shouldRetreatForTactic(creature, tactic)) return false;
  const rangedActions = getRangedActions(creature);

  // BattleCast does not currently model "fled the battlefield" as a
  // combat outcome. If a wounded melee-only creature retreats anyway,
  // it can create a non-fight where both sides drift apart and the
  // simulation hits the round cap. Only use retreat mode when the
  // creature can still contribute after backing away.
  if (rangedActions.length === 0) return false;

  const nearestEnemy = enemies.reduce((n, e) =>
    creatureDistance(creature, e) < creatureDistance(creature, n) ? e : n
  );

  // Find adjacent enemies that could make an OA if we leave their reach.
  const adjacentEnemies = enemies.filter(e => {
    if (!e.isAlive || !canTakeReactions(e)) return false;
    if (e.conditions.includes('incapacitated') || e.conditions.includes('stunned') ||
        e.conditions.includes('paralyzed') || e.conditions.includes('unconscious')) return false;
    const reach = getMeleeActions(e).reduce((max, a) => Math.max(max, a.reach || 5), 5);
    return creatureDistance(e, creature) <= reach;
  });

  const isRogue = creature.monsterData.heroClass === 'Rogue';
  const hasNimbleEscape = hasActiveTrait(creature, 'Nimble Escape');
  const freeDisengage = isRogue || hasNimbleEscape;
  let disengaged = false;

  if (adjacentEnemies.length > 0 && !freeDisengage) {
    let estimatedOaDmg = 0;
    for (const e of adjacentEnemies) {
      const melee = getMeleeActions(e);
      if (melee.length > 0) {
        estimatedOaDmg += estimateActionDamage(melee[0]) * 0.65;
      }
    }
    if (estimatedOaDmg > creature.currentHp * 0.3) {
      disengaged = true;
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: creature.displayName, action: 'Disengage',
        details: `${creature.displayName} Disengages to retreat safely (avoiding ~${Math.round(estimatedOaDmg)} OA damage).`,
        type: 'move'
      });
      // One oaAvoided per adjacent enemy that won't get to swing -
      // gives the grid a floating "OA AVOIDED · Disengaged" badge over
      // each enemy that would have provoked.
      for (const e of adjacentEnemies) {
        state.events.push({
          kind: 'oaAvoided', moverId: creature.id, enemyId: e.id,
          reason: 'disengage', durationMs: BASE_DURATIONS.oaAvoided,
        });
      }
    }
  }

  if (freeDisengage && adjacentEnemies.length > 0) {
    disengaged = true;
    const action = isRogue ? 'Cunning Action: Disengage' : 'Nimble Escape: Disengage';
    const detail = isRogue
      ? `${creature.displayName} uses Cunning Action to Disengage (bonus action).`
      : `${creature.displayName} uses Nimble Escape to Disengage (bonus action).`;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action,
      details: detail,
      type: 'move'
    });
    const reason = isRogue ? 'cunning' : 'nimble';
    for (const e of adjacentEnemies) {
      state.events.push({
        kind: 'oaAvoided', moverId: creature.id, enemyId: e.id,
        reason, durationMs: BASE_DURATIONS.oaAvoided,
      });
    }
  }

  const retreatTarget = {
    x: creature.position.x + Math.sign(creature.position.x - nearestEnemy.position.x) * 6,
    y: creature.position.y + Math.sign(creature.position.y - nearestEnemy.position.y) * 6,
  };
  const oldPos = { ...creature.position };
  creature.position = moveToward(creature, retreatTarget, state);
  if (creature.position.x !== oldPos.x || creature.position.y !== oldPos.y) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: 'Retreat',
      details: `${creature.displayName} retreats! (${Math.round(creature.currentHp / creature.maxHp * 100)}% HP)`,
      type: 'move'
    });
  }

  // Disengage forfeits the action unless Rogue (Cunning Action = bonus action).
  if (!disengaged || isRogue) {
    if (rangedActions.length > 0) {
      const target = selectTarget(state, creature, targetStrategy);
      if (target) {
        const rangedAction = rangedActions[0];
        const maxRange = rangedAction.range?.long || rangedAction.range?.normal || 60;
        if (creatureDistance(creature, target) <= maxRange) {
          resolveAttack(state, creature, target, rangedAction);
        }
      }
    }
  }
  return true;
}

/**
 * Wild Shape (Druid L2+): bonus action to transform into a beast.
 * Triggers when enemies are in melee range and no concentration is up
 * (if concentrating on Call Lightning/Moonbeam, stay humanoid and cast).
 */
function tryWildShape(state: BattleState, creature: Creature, target: Creature): void {
  if (creature.monsterData.heroClass !== 'Druid') return;
  if ((creature.monsterData.heroLevel ?? 0) < 2) return;
  if (creature.wildShape || creature.bonusActionUsed) return;
  if (!hasResource(creature, 'wild-shape')) return;
  const preferredBeastName = creature.monsterData.preferredWildShapeBeast;
  if (!preferredBeastName && creatureDistance(creature, target) > 15) return;
  if (creature.concentratingOn) return;

  const druidLevel = creature.monsterData.heroLevel ?? 2;
  const beasts = getEligibleWildShapeBeasts({
    level: druidLevel,
    subclass: creature.monsterData.heroSubclass,
  });
  const orderedBeasts = preferredBeastName
    ? beasts.filter(candidate => candidate.name === preferredBeastName)
    : beasts;
  const gridSize = state.gridSize ?? 20;
  const beast = orderedBeasts.find(candidate => {
    const fp = getFootprintSize(candidate.size);
    if (creature.position.x + fp > gridSize || creature.position.y + fp > gridSize) return false;
    return !isPositionBlocked(creature.position, candidate.size, state.creatures, creature.id, state.terrainBlocked);
  });
  if (!beast) return;

  consumeResource(creature, 'wild-shape');
  creature.bonusActionUsed = true;
  const isMoon = creature.monsterData.heroSubclass === 'Circle of the Moon';
  const tempHp = isMoon ? druidLevel * 3 : druidLevel;
  const moonAc = 13 + abilityModifier(creature.monsterData.abilities.wis);
  const ac = isMoon ? Math.max(beast.ac, moonAc) : beast.ac;
  creature.wildShape = {
    beastName: beast.name,
    tempHp, maxTempHp: tempHp,
    formHp: beast.formHp,
    cr: beast.cr,
    ac, speed: beast.speed,
    actions: beast.actions, size: beast.size,
    traits: beast.traits, saves: beast.saves,
    abilities: beast.abilities,
    isMoon,
  };
  if (beast.initialResources) {
    for (const [key, value] of Object.entries(beast.initialResources)) {
      creature.resources[key] = value;
    }
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: creature.displayName, action: 'Wild Shape',
    details: `${creature.displayName} transforms into a ${beast.name}! (${tempHp} temporary HP, AC ${ac})`,
    type: 'special'
  });
  creature.stats.actionUsage['Wild Shape'] = (creature.stats.actionUsage['Wild Shape'] || 0) + 1;
  state.events.push({ kind: 'wildShape', creatureId: creature.id, beastName: beast.name, durationMs: 0 });
}

function tryEndQuiveringPalm(state: BattleState, creature: Creature): boolean {
  if (creature.monsterData.heroClass !== 'Monk' || (creature.monsterData.heroLevel ?? 0) < 17) return false;
  const key = `quivering-palm:${creature.id}`;
  const target = getEnemies(state, creature).find(enemy =>
    enemy.isAlive && enemy.activeBuffs?.some(buff => buff.key === key)
  );
  if (!target) return false;

  target.activeBuffs = target.activeBuffs.filter(buff => buff.key !== key);
  const wisMod = abilityModifier(creature.monsterData.abilities.wis);
  const dc = 8 + creature.monsterData.proficiencyBonus + wisMod;
  const saveMod = getEffectiveSaveModifier(target, 'con', state);
  const save = rollSaveWithBuffs(target, saveMod, false, dc, 'con');
  const success = save.total >= dc;
  const rawDamage = rollDice('10d12').total;
  const damage = success ? Math.floor(rawDamage / 2) : rawDamage;

  state.events.push({
    kind: 'attack',
    attackerId: creature.id,
    targetId: target.id,
    actionName: 'Quivering Palm',
    attackType: 'touch',
    durationMs: BASE_DURATIONS.attack,
  });
  state.events.push({ kind: 'save', targetId: target.id, success, durationMs: BASE_DURATIONS.save });
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: creature.displayName,
    action: 'Quivering Palm',
    details: `${creature.displayName} ends Quivering Palm on ${target.displayName}; ${target.displayName} ${success ? 'resists' : 'fails'} (${save.total} vs DC ${dc}) and takes ${damage} force damage.`,
    damage,
    type: 'damage',
  });
  const before = target.currentHp;
  state.events.push({
    kind: 'hit',
    targetId: target.id,
    damage,
    damageType: 'force',
    critical: false,
    targetHpBefore: before,
    targetHpAfter: before,
    durationMs: BASE_DURATIONS.hit,
  });
  const hitEvent = state.events[state.events.length - 1];
  applyDamage(state, target, damage, 'force', creature, false, true, false);
  if (hitEvent.kind === 'hit') hitEvent.targetHpAfter = target.currentHp;
  creature.stats.actionUsage['Quivering Palm'] = (creature.stats.actionUsage['Quivering Palm'] || 0) + 1;
  return true;
}

/**
 * Action Surge (Fighter L2+): spend the resource to take another full
 * attack action. Re-selects target and runs the multiattack / best-attack
 * block a second time. No-op for creatures without the resource.
 */
function runActionSurge(
  state: BattleState,
  creature: Creature,
  target: Creature,
  targetStrategy: TargetStrategy,
  multiattack: MonsterAction | undefined,
  meleeActions: MonsterAction[],
  rangedActions: MonsterAction[],
  bestMeleeReach: number,
): void {
  if (!creature.monsterData.isHero || !hasResource(creature, 'action-surge') || state.isComplete) return;
  consumeResource(creature, 'action-surge');
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: creature.displayName, action: 'Action Surge',
    details: `${creature.displayName} uses Action Surge for an extra attack action!`,
    type: 'special'
  });
  creature.stats.actionUsage['Action Surge'] = (creature.stats.actionUsage['Action Surge'] || 0) + 1;

  const surgeTarget = selectTarget(state, creature, targetStrategy) ?? target;
  if (!surgeTarget?.isAlive) return;
  const surgeDist = creatureDistance(creature, surgeTarget);
  const usedLoadingActions = new Set<string>();
  if (multiattack) {
    const surgeAttacks = parseMultiattack(multiattack.description.toLowerCase(), creature, surgeDist, meleeActions, rangedActions);
    for (const attack of surgeAttacks) {
      const ct = surgeTarget.isAlive ? surgeTarget : selectTarget(state, creature, targetStrategy);
      if (!ct) break;
      const chosen = chooseLegalAttackForTarget(creature, ct, attack, rangedActions, usedLoadingActions);
      if (!chosen) continue;
      markLoadingActionUsed(chosen, usedLoadingActions);
      resolveAttack(state, creature, ct, chosen);
      checkBattleComplete(state);
      if (state.isComplete) break;
    }
  } else if (surgeDist <= bestMeleeReach && meleeActions.length > 0) {
    const best = meleeActions.reduce((b, a) => estimateActionDamage(a, surgeTarget) > estimateActionDamage(b, surgeTarget) ? a : b);
    resolveAttack(state, creature, surgeTarget, best);
  } else if (rangedActions.length > 0) {
    const best = rangedActions.reduce((b, a) => estimateActionDamage(a, surgeTarget) > estimateActionDamage(b, surgeTarget) ? a : b);
    resolveAttack(state, creature, surgeTarget, best);
  }
}

/**
 * Flurry of Blows (Monk L2+): spend 1 ki for 2 extra unarmed strikes
 * (3 at L10+). Requires target in melee reach and an unused bonus action.
 */
function runFlurryOfBlows(
  state: BattleState,
  creature: Creature,
  target: Creature,
  targetStrategy: TargetStrategy,
  meleeActions: MonsterAction[],
  bestMeleeReach: number,
): void {
  if (creature.monsterData.heroClass !== 'Monk') return;
  if ((creature.monsterData.heroLevel ?? 0) < 2) return;
  if (creature.bonusActionUsed || !hasResource(creature, 'ki') || state.isComplete) return;

  const flurryTarget = (targetStillValid(state, creature, target) ? target : selectTarget(state, creature, targetStrategy)) ?? null;
  if (!flurryTarget || meleeActions.length === 0) return;
  const flurryDist = creatureDistance(creature, flurryTarget);
  if (flurryDist > bestMeleeReach) return;
  if (meleeBlockedByAltitude(creature, flurryTarget)) return;

  creature.bonusActionUsed = true;
  consumeResource(creature, 'ki');
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: creature.displayName, action: 'Flurry of Blows',
    details: `${creature.displayName} spends 1 ki for Flurry of Blows!`,
    type: 'special'
  });
  creature.stats.actionUsage['Flurry of Blows'] = (creature.stats.actionUsage['Flurry of Blows'] || 0) + 1;
  const unarmed = meleeActions[0];
  const flurryStrikes = (creature.monsterData.heroLevel ?? 0) >= 10 ? 3 : 2;
  for (let s = 0; s < flurryStrikes; s++) {
    const ct = targetStillValid(state, creature, flurryTarget) ? flurryTarget : selectTarget(state, creature, targetStrategy);
    if (!ct) break;
    const hadOpenHandFlag = creature.turnFlags?.openHandFlurryStrike;
    creature.turnFlags = { ...(creature.turnFlags ?? {}), openHandFlurryStrike: true };
    try {
      resolveAttack(state, creature, ct, unarmed);
    } finally {
      if (hadOpenHandFlag) {
        creature.turnFlags.openHandFlurryStrike = true;
      } else {
        delete creature.turnFlags.openHandFlurryStrike;
      }
    }
    checkBattleComplete(state);
    if (state.isComplete) break;
  }
}

/**
 * Martial Arts (Monk L1+): after attacking, make one bonus-action
 * unarmed strike. Flurry consumes the same bonus action at L2+, so this
 * only fires when Flurry was unavailable or intentionally skipped.
 */
function runMartialArtsBonusStrike(
  state: BattleState,
  creature: Creature,
  target: Creature,
  targetStrategy: TargetStrategy,
  meleeActions: MonsterAction[],
  bestMeleeReach: number,
): void {
  if (creature.monsterData.heroClass !== 'Monk') return;
  if ((creature.monsterData.heroLevel ?? 0) < 1) return;
  if (creature.bonusActionUsed || state.isComplete) return;

  const unarmed = meleeActions.find(a => a.name === 'Martial Arts (Unarmed)') ?? meleeActions[0];
  if (!unarmed) return;
  const strikeTarget = (targetStillValid(state, creature, target) ? target : selectTarget(state, creature, targetStrategy)) ?? null;
  if (!strikeTarget) return;
  if (creatureDistance(creature, strikeTarget) > bestMeleeReach) return;
  if (meleeBlockedByAltitude(creature, strikeTarget)) return;

  creature.bonusActionUsed = true;
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: creature.displayName, action: 'Martial Arts',
    details: `${creature.displayName} follows up with a bonus unarmed strike.`,
    type: 'special'
  });
  creature.stats.actionUsage['Martial Arts'] = (creature.stats.actionUsage['Martial Arts'] || 0) + 1;
  resolveAttack(state, creature, strikeTarget, unarmed);
  checkBattleComplete(state);
}

/**
 * Frenzy (Berserker Barbarian L3+): bonus-action melee attack while raging.
 * Requires rage buff, unused bonus action, and a melee target in reach.
 */
function runFrenzy(
  state: BattleState,
  creature: Creature,
  target: Creature,
  targetStrategy: TargetStrategy,
  meleeActions: MonsterAction[],
  bestMeleeReach: number,
): void {
  if (creature.monsterData.heroClass !== 'Barbarian') return;
  if ((creature.monsterData.heroLevel ?? 0) < 3) return;
  if (creature.bonusActionUsed || !hasBuff(creature, 'rage') || state.isComplete) return;

  const frenzyTarget = (targetStillValid(state, creature, target) ? target : selectTarget(state, creature, targetStrategy)) ?? null;
  if (!frenzyTarget || meleeActions.length === 0) return;
  const frenzyDist = creatureDistance(creature, frenzyTarget);
  if (frenzyDist > bestMeleeReach) return;

  creature.bonusActionUsed = true;
  const best = meleeActions.reduce((b, a) => estimateActionDamage(a, frenzyTarget) > estimateActionDamage(b, frenzyTarget) ? a : b);
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: creature.displayName, action: 'Frenzy',
    details: `${creature.displayName} makes a frenzied bonus attack!`,
    type: 'special'
  });
  creature.stats.actionUsage['Frenzy'] = (creature.stats.actionUsage['Frenzy'] || 0) + 1;
  resolveAttack(state, creature, frenzyTarget, best);
}

function runIntimidatingPresence(state: BattleState, creature: Creature): void {
  if (creature.monsterData.heroClass !== 'Barbarian') return;
  if ((creature.monsterData.heroLevel ?? 0) < 14) return;
  if (creature.bonusActionUsed || state.isComplete) return;

  const action = getActiveActions(creature).find(a => a.name === 'Intimidating Presence');
  if (!action?.savingThrow?.area || !action.resourceCost) return;
  const targets = getEnemies(state, creature)
    .filter(enemy => enemy.isAlive)
    .filter(enemy => creatureDistance(creature, enemy) <= 30)
    .filter(enemy => !enemy.conditions.includes('frightened'))
    .filter(enemy => !(enemy.monsterData.conditionImmunities ?? []).includes('frightened'));
  if (targets.length === 0) return;

  if (!hasResource(creature, action.resourceCost.key, action.resourceCost.amount)) {
    if (!hasResource(creature, 'rage')) return;
    consumeResource(creature, 'rage');
    creature.resources[action.resourceCost.key] = action.resourceCost.amount;
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: creature.displayName,
      action: 'Intimidating Presence',
      details: `${creature.displayName} expends a Rage use to restore Intimidating Presence.`,
      type: 'special',
    });
  }

  executeSpell(state, creature, action, targets[0], targets);
  creature.bonusActionUsed = true;
  checkBattleComplete(state);
}

function tryUseAbjureFoes(state: BattleState, creature: Creature): boolean {
  if (creature.monsterData.heroClass !== 'Paladin' || (creature.monsterData.heroLevel ?? 0) < 9) return false;
  const action = getActiveActions(creature).find(a => a.name === 'Abjure Foes');
  if (!action?.resourceCost || !action.savingThrow) return false;
  if (!hasResource(creature, action.resourceCost.key, action.resourceCost.amount)) return false;

  const chaMod = Math.max(1, abilityModifier(creature.monsterData.abilities.cha));
  const candidates = getEnemies(state, creature)
    .filter(enemy => enemy.isAlive)
    .filter(enemy => creatureDistance(creature, enemy) <= (action.range?.normal ?? 60))
    .filter(enemy => !enemy.conditions.includes('frightened'))
    .filter(enemy => !(enemy.monsterData.conditionImmunities ?? []).includes('frightened'))
    .sort((a, b) => b.currentHp - a.currentHp)
    .slice(0, chaMod);

  if (candidates.length === 0) return false;
  const strongSingleTarget = candidates.length === 1 && candidates[0].maxHp >= creature.maxHp;
  if (candidates.length < 2 && !strongSingleTarget) return false;

  consumeResource(creature, action.resourceCost.key, action.resourceCost.amount);
  creature.stats.actionUsage[action.name] = (creature.stats.actionUsage[action.name] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: creature.displayName,
    action: action.name,
    details: `${creature.displayName} invokes Abjure Foes against ${candidates.length} enemies.`,
    type: 'special',
  });

  const resolvedAction: MonsterAction = { ...action, resourceCost: undefined };
  for (const target of candidates) {
    if (!target.isAlive) continue;
    resolveSingleTargetSave(state, creature, target, resolvedAction);
  }
  creature.hasActed = true;
  checkBattleComplete(state);
  return true;
}

function tryActivateSacredWeapon(
  state: BattleState,
  creature: Creature,
  distanceToTarget: number,
  meleeActions: MonsterAction[],
  bestMeleeReach: number,
): void {
  if (creature.monsterData.heroClass !== 'Paladin' || (creature.monsterData.heroLevel ?? 0) < 3) return;
  if (hasBuff(creature, 'sacred-weapon')) return;
  if (!hasResource(creature, 'channel-divinity')) return;
  if (meleeActions.length === 0 || distanceToTarget > bestMeleeReach) return;

  const attackBonus = Math.max(1, abilityModifier(creature.monsterData.abilities.cha));
  consumeResource(creature, 'channel-divinity');
  addBuff(creature, {
    name: 'Sacred Weapon',
    key: 'sacred-weapon',
    casterId: creature.id,
    appliedRound: state.round,
    endRound: state.round + 100,
    attackBonus,
  });
  creature.stats.actionUsage['Sacred Weapon'] = (creature.stats.actionUsage['Sacred Weapon'] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: creature.displayName,
    action: 'Sacred Weapon',
    details: `${creature.displayName} empowers their weapon, adding +${attackBonus} to melee attack rolls.`,
    type: 'special',
  });
}

function tryActivateHolyNimbus(state: BattleState, creature: Creature): void {
  if (creature.monsterData.heroClass !== 'Paladin' || (creature.monsterData.heroLevel ?? 0) < 20) return;
  if (creature.bonusActionUsed || hasBuff(creature, 'holy-nimbus')) return;
  const action = getActiveActions(creature).find(a => a.name === 'Holy Nimbus');
  if (!action?.resourceCost || !hasResource(creature, action.resourceCost.key, action.resourceCost.amount)) return;
  if (executeSpell(state, creature, action, creature)) {
    creature.bonusActionUsed = true;
  }
}

function tryActivateNaturesVeil(state: BattleState, creature: Creature): void {
  if (creature.monsterData.heroClass !== 'Ranger' || (creature.monsterData.heroLevel ?? 0) < 14) return;
  if (creature.bonusActionUsed || creature.conditions.includes('invisible')) return;
  const action = getActiveActions(creature).find(a => a.name === "Nature's Veil");
  if (!action?.resourceCost || !hasResource(creature, action.resourceCost.key, action.resourceCost.amount)) return;
  if (getEnemies(state, creature).filter(enemy => enemy.isAlive).length === 0) return;

  consumeResource(creature, action.resourceCost.key, action.resourceCost.amount);
  creature.bonusActionUsed = true;
  const applied = applyCondition(state, creature, 'invisible', creature, 'end_of_next_turn');
  if (!applied) return;
  creature.stats.actionUsage["Nature's Veil"] = (creature.stats.actionUsage["Nature's Veil"] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: creature.displayName,
    action: "Nature's Veil",
    details: `${creature.displayName} uses a bonus action to become Invisible until the end of their next turn.`,
    type: 'special',
  });
}

function tryUseSteadyAim(
  state: BattleState,
  creature: Creature,
  didMove: boolean,
  distanceFt: number,
  meleeActions: MonsterAction[],
  rangedActions: MonsterAction[],
): void {
  if (creature.monsterData.heroClass !== 'Rogue' || (creature.monsterData.heroLevel ?? 0) < 3) return;
  if (didMove || creature.bonusActionUsed || creature.turnFlags?.steadyAim) return;
  if (creature.conditions.includes('incapacitated') || creature.conditions.includes('unconscious')) return;
  const hasLegalAttack = [...meleeActions, ...rangedActions].some(action => actionCanReachDistance(action, distanceFt));
  if (!hasLegalAttack) return;

  creature.turnFlags.steadyAim = true;
  creature.bonusActionUsed = true;
  creature.movementRemaining = 0;
  creature.stats.actionUsage['Steady Aim'] = (creature.stats.actionUsage['Steady Aim'] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: creature.displayName,
    action: 'Steady Aim',
    details: `${creature.displayName} holds position and gains Advantage on the next attack.`,
    type: 'special',
  });
  state.events.push({
    kind: 'effect',
    creatureId: creature.id,
    label: 'Steady Aim',
    tone: 'success',
    durationMs: BASE_DURATIONS.effect,
  });
}

export function executeTurn(state: BattleState, creature: Creature): void {
  if (!creature.isAlive || state.isComplete) return;
  if (!processTurnStart(state, creature)) {
    processTargetTurnEndOngoingEffects(state, creature);
    return;
  }
  try {
  handlePassiveAuras(state, creature);

  if (tryEscapeContainer(state, creature)) {
    creature.hasActed = true;
    checkBattleComplete(state);
    return;
  }

  const enemies = getEnemies(state, creature);
  if (enemies.length === 0) return;

  // Resolve the team's tactic for this creature.
  const tactic: TacticType = (state.teamTactics?.[creature.team] as TacticType) || 'smart';

  // Map tactic to target-selection strategy.
  const targetStrategy: TargetStrategy =
    tactic === 'aggressive' ? 'nearest' :
    tactic === 'kiting'     ? 'weakest' :
    tactic === 'defensive'  ? 'nearest' :
    'smart';

  if (runRetreat(state, creature, enemies, tactic, targetStrategy)) return;

  // Pick target
  const target = selectTarget(state, creature, targetStrategy);
  if (!target) return;

  tryWildShape(state, creature, target);

  if (tryEndQuiveringPalm(state, creature)) {
    creature.hasActed = true;
    checkBattleComplete(state);
    return;
  }

  if (tryUseAbjureFoes(state, creature)) {
    return;
  }

  // Spellcasting: heroes, homebrew casters, and spell-like monsters check
  // their spell list before falling through to weapon / breath-weapon logic. trySpellcast picks a
  // spell by priority (heal → concentration buff → damage) and casts
  // it. If it casts, the creature has used its action and we return.
  // (Wild-shaped druids skip spellcasting and fall through to beast attacks.)
  const hasSpells = hasSpellcastingActions(creature);
  if (hasSpells && trySpellcast(state, creature, () => tryStabiliseDyingAlly(state, creature))) {
    tryHasteFollowUp(state, creature, targetStrategy);
    creature.hasActed = true;
    checkBattleComplete(state);
    return;
  }

  if (tryStabiliseDyingAlly(state, creature)) {
    tryHasteFollowUp(state, creature, targetStrategy);
    creature.hasActed = true;
    checkBattleComplete(state);
    return;
  }

  // Check for AoE special abilities. For narrow shapes (lines), prefer
  // moving closer first to maximize targets - skip the pre-movement check
  // and let the post-movement check handle it. For wide shapes (cones,
  // spheres), fire immediately if 2+ enemies are in range.
  //
  // Pre-positioning: before falling back to "fire from where I'm standing,"
  // check if moving to a better cell would significantly improve cone/line
  // coverage. If so, do the move and fire from the new position. Addresses
  // the "dragon doesn't try to get everyone in the cone" feedback - the
  // previous logic only optimized aim direction, never moved first.
  const specials = getSpecialActions(creature);
  for (const special of specials) {
    if (special.resourceCost && !hasResource(creature, special.resourceCost.key, special.resourceCost.amount)) continue;
    if (special.recharge) {
      if (creature.recharges[special.name] === false) continue;
      if (creature.recharges[special.name] === undefined) {
        creature.recharges[special.name] = true;
      }
    }
    if (creature.recharges[special.name] === false) continue;
    if (!special.savingThrow?.area) continue;

    const currentEnemyHits = getAoETargets(state, creature, special)
      .filter(t => t.team !== creature.team && t.isAlive).length;
    const repositioned = bestAoEPosition(state, creature, special);

    // Move-then-fire path: only kick in if (a) we'd hit at least 2 enemies
    // after moving, AND (b) the new spot is meaningfully better than here
    // (≥2 more hits, OR we'd go from "can't fire" to "can fire").
    const repoSignificantlyBetter = repositioned.targetCount >= 2 && (
      currentEnemyHits < 2
        ? true
        : repositioned.targetCount >= currentEnemyHits + 2
    );
    if (repoSignificantlyBetter && (
      repositioned.position.x !== creature.position.x ||
      repositioned.position.y !== creature.position.y
    )) {
      const oldPosBeforeRepo = { ...creature.position };
      creature.position = moveToward(creature, repositioned.position, state);
      const moved = distance(oldPosBeforeRepo, creature.position) > 0;
      if (moved) {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: creature.displayName, action: 'Move',
          details: `${creature.displayName} repositions for a better ${special.name} angle.`,
          type: 'move'
        });
        // Aura-entry damage for moving into an enemy concentration aura.
        checkAuraEntry(state, creature, oldPosBeforeRepo);
        triggerPersistentZones(state, creature, 'entry');
        if (!creature.isAlive || state.isComplete) return;
      }
      const reTargets = getAoETargets(state, creature, special);
      if (reTargets.filter(t => t.team !== creature.team && t.isAlive).length >= 2) {
        resolveAoE(state, creature, special, reTargets, undefined, repositioned.direction);
        creature.recharges[special.name] = false;
        creature.hasActed = true;
        checkBattleComplete(state);
        return;
      }
      // Repositioning didn't actually pan out (aim drifted, or move blocked).
      // Fall through to the standard pre-movement check below.
    }

    if (shouldUseAoE(state, creature, special)) {
      const areaLower = (special.savingThrow?.area || '').toLowerCase();
      const isLine = areaLower.includes('line');
      const isRangedSphere = (areaLower.includes('sphere') || areaLower.includes('cylinder') || areaLower.includes('radius'))
        && !areaLower.includes('emanation') && !!special.range;
      const currentTargets = getAoETargets(state, creature, special);
      const enemies = getEnemies(state, creature).filter(e => e.isAlive);
      // For lines: only fire pre-movement if we'd hit most enemies already.
      // Otherwise move closer first - line alignment improves dramatically
      // with positioning. Cones/spheres fire if 2+ hit.
      if (isLine && currentTargets.length < Math.max(enemies.length * 0.6, 3)) {
        continue; // defer to post-movement check
      }
      // Fireball-style sphere with a range: detonate at the chosen
      // enemy-cluster cell, not at the caster's feet. The visual event
      // and the damage calc both use this center.
      let center: { x: number; y: number } | undefined = undefined;
      if (isRangedSphere) {
        const rangeMatch = areaLower.match(/(\d+)-foot/);
        const radiusFt = rangeMatch ? parseInt(rangeMatch[1]) : 20;
        center = pickRangedSphereCenter(state, creature, special, radiusFt).center;
      }
      resolveAoE(state, creature, special, currentTargets, center);
      creature.recharges[special.name] = false;
      creature.hasActed = true;
      checkBattleComplete(state);
      return;
    }
  }

  // Get attack profile (uses beast actions if wild-shaped)
  const multiattack = getMultiattack(creature);
  const meleeActions = getMeleeActions(creature);
  const rangedActions = getRangedActions(creature);

  // Determine best reach and ranged range
  const bestMeleeReach = meleeActions.reduce((max, a) => Math.max(max, a.reach || 5), 5);
  const bestRangedNormal = rangedActions.reduce((max, a) => Math.max(max, a.range?.normal || 0), 0);
  const distToTarget = creatureDistance(creature, target);

  // ────────────────────────────────────────────────────────────
  // Movement decision - fully determined by the team's tactic.
  //
  //   Aggressive: always charge toward target, close the gap.
  //   Smart:      advance toward target (standard behavior).
  //               Also advances ranged creatures if out of range.
  //   Kiting:     stay at max ranged range. If enemy is closer
  //               than 15ft, move AWAY. If farther than normal
  //               range, advance to just within range. Otherwise
  //               hold position and shoot.
  //   Defensive:  never advance. Attack whatever's in reach.
  // ────────────────────────────────────────────────────────────
  const oldPosBeforeMove = { ...creature.position };
  let didMove = false;
  let disengagedThisTurn = false;
  const hasNimbleEscape = hasActiveTrait(creature, 'Nimble Escape');

  if (tactic === 'defensive') {
    // Defensive: never advance. Stand ground and attack in reach.
  } else if (tactic === 'kiting' && rangedActions.length > 0) {
    // Kiting: maintain distance at the weapon's normal range.
    const idealMin = 15; // 3 cells - don't let enemies closer
    const idealMax = bestRangedNormal > 0 ? bestRangedNormal : 80;

    if (distToTarget <= idealMin) {
      // Too close - run away. Rogues Disengage for free.
      if (creature.monsterData.heroClass === 'Rogue') {
        disengagedThisTurn = true;
      }
      const dx = creature.position.x - target.position.x;
      const dy = creature.position.y - target.position.y;
      const awayX = dx === 0 && dy === 0 ? 1 : Math.sign(dx);
      const awayY = dx === 0 && dy === 0 ? 0 : Math.sign(dy);
      creature.position = moveToward(creature, {
        x: creature.position.x + awayX * 10,
        y: creature.position.y + awayY * 10,
      }, state);
      didMove = creature.position.x !== oldPosBeforeMove.x || creature.position.y !== oldPosBeforeMove.y;
      if (didMove) {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: creature.displayName, action: 'Kite',
          details: `${creature.displayName} backs away from ${target.displayName}.`,
          type: 'move'
        });
      }
    } else if (distToTarget > idealMax) {
      // Too far to shoot - advance to get within normal range
      creature.position = moveToward(creature, chooseSmartDestination(creature, target, state), state);
      const moved = distance(oldPosBeforeMove, creature.position);
      didMove = moved > 0;
      if (didMove) {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: creature.displayName, action: 'Move',
          details: `${creature.displayName} moves ${moved} ft to get ${target.displayName} in range.`,
          type: 'move'
        });
      }
    }
    // else: in the sweet spot (15ft < dist <= normal range) - hold and shoot
  } else {
    // Aggressive + Smart: advance toward target.
    // For Smart tactic, creatures whose ranged weapons are at least as
    // good as their melee weapons stop advancing once they're within
    // ranged normal range - they don't charge into melee to do worse
    // damage. See shouldPreferRanged for the exact rule.
    // For Aggressive tactic, ranged-prefer is overridden - the creature
    // always closes to melee, matching the "charge in" intent.
    const prefersRangedMovement = shouldPreferRanged(
      meleeActions, rangedActions, creature.monsterData.heroClass,
    );
    const aggressive = tactic === 'aggressive';
    const closeToMelee =
      (meleeActions.length > 0 && distToTarget > bestMeleeReach) ||
      (meleeActions.length === 0 && rangedActions.length > 0 && distToTarget > bestRangedNormal);
    let shouldAdvance = (aggressive || !prefersRangedMovement)
      ? closeToMelee
      : distToTarget > bestRangedNormal;

    // D&D 5e: frightened creatures can't willingly move closer to the
    // source of their fear. If the movement target IS the fear source,
    // block the advance. The creature can still attack if already in
    // range but won't close the gap.
    if (shouldAdvance && creature.conditions.includes('frightened')) {
      const fearSource = creature.conditionTimers.find(t => t.condition === 'frightened')?.sourceId;
      if (fearSource && target.id === fearSource) {
        shouldAdvance = false;
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: creature.displayName, action: 'Frightened',
          details: `${creature.displayName} is too frightened to move closer to ${target.displayName}!`,
          type: 'condition'
        });
      }
    }

    if (shouldAdvance) {
      creature.position = moveToward(creature, chooseSmartDestination(creature, target, state), state);
      const moved = distance(oldPosBeforeMove, creature.position);
      didMove = moved > 0;
      if (didMove) {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: creature.displayName, action: 'Move',
          details: `${creature.displayName} moves ${moved} ft toward ${target.displayName}.`,
          type: 'move'
        });
      }
    } else if (!aggressive && prefersRangedMovement && rangedActions.length > 0
               && !creature.conditions.includes('frightened')) {
      // In ranged range and Smart tactic: let the smart-movement layer
      // pick a kite/disperse destination. If it returns a different cell
      // than current, reposition. (No-op if the current cell is best.)
      const smartDest = chooseSmartDestination(creature, target, state);
      if (smartDest.x !== creature.position.x || smartDest.y !== creature.position.y) {
        creature.position = moveToward(creature, smartDest, state);
        const moved = distance(oldPosBeforeMove, creature.position);
        didMove = moved > 0;
        if (didMove) {
          pushLog(state, {
            round: state.round, turn: state.turnIndex,
            actor: creature.displayName, action: 'Reposition',
            details: `${creature.displayName} repositions to a better firing line.`,
            type: 'move'
          });
        }
      }
    }

    // Rogues kite away from adjacent enemies for free (Cunning Action:
    // Disengage is a bonus action). Non-Rogues stay and fight in melee -
    // provoking OA to kite is rarely worth the damage trade.
    if (creature.monsterData.heroClass === 'Rogue' && prefersRangedMovement
        && enemies.some(e => e.isAlive && creatureDistance(creature, e) <= 5)) {
      const nearestEnemy = enemies.reduce((n, e) =>
        creatureDistance(creature, e) < creatureDistance(creature, n) ? e : n
      );
      // Snapshot enemies the Rogue is adjacent to BEFORE moving, so we
      // can emit oaAvoided badges over each one once the disengage move
      // lands.
      const wasAdjacent = enemies.filter(e =>
        e.isAlive && canTakeReactions(e) && creatureDistance(creature, e) <= 5
      );
      disengagedThisTurn = true;
      const kiteTarget = {
        x: creature.position.x + Math.sign(creature.position.x - nearestEnemy.position.x) * 6,
        y: creature.position.y + Math.sign(creature.position.y - nearestEnemy.position.y) * 6,
      };
      const kiteOld = { ...creature.position };
      creature.position = moveToward(creature, kiteTarget, state);
      if (creature.position.x !== kiteOld.x || creature.position.y !== kiteOld.y) {
        didMove = true;
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: creature.displayName, action: 'Cunning Action: Disengage',
          details: `${creature.displayName} disengages and moves to ranged distance.`,
          type: 'move'
        });
        for (const e of wasAdjacent) {
          state.events.push({
            kind: 'oaAvoided', moverId: creature.id, enemyId: e.id,
            reason: 'cunning', durationMs: BASE_DURATIONS.oaAvoided,
          });
        }
      }
    }
  }

  // Opportunity attacks fire BEFORE the creature reaches its destination.
  // In D&D the OA happens "as you leave reach" - the enemy strikes while
  // you're still adjacent. runOpportunityAttacks rewinds the position,
  // resolves each OA, then restores the final position on survivors.
  if (didMove && !disengagedThisTurn && !hasNimbleEscape) {
    if (runOpportunityAttacks(state, creature, oldPosBeforeMove)) return;
  }
  // Log the Nimble Escape disengage (only if we actually left an adjacent
  // enemy's reach - movement that doesn't leave melee doesn't use it).
  if (didMove && hasNimbleEscape && !disengagedThisTurn) {
    // Gather the full path the creature traveled this turn. Nimble
    // Escape is a bonus-action Disengage that protects ALL movement
    // for the turn, so we walk every move event emitted since this
    // creature's turnStart. Catches walk-past cases where the goblin
    // never started adjacent but crossed an enemy's reach mid-move -
    // the original `wasAdj` check only looked at the turn-start cell
    // and silently missed those.
    const turnStartIdx = state.events.findLastIndex(
      e => e.kind === 'turnStart' && e.creatureId === creature.id,
    );
    const sliceStart = turnStartIdx >= 0 ? turnStartIdx + 1 : 0;
    const turnPath: { x: number; y: number }[] = [];
    for (const ev of state.events.slice(sliceStart)) {
      if (ev.kind !== 'move' || ev.creatureId !== creature.id) continue;
      const seg = ev.path ?? [ev.from, ev.to];
      if (turnPath.length === 0) turnPath.push(...seg);
      else turnPath.push(...seg.slice(1)); // skip duplicated junction cell
    }
    if (turnPath.length === 0) turnPath.push(oldPosBeforeMove, creature.position);

    const escapedFrom = enemies.filter(e => {
      if (!e.isAlive) return false;
      const oaMelee = getMeleeActions(e);
      if (oaMelee.length === 0) return false;
      const reach = oaMelee.reduce((max, a) => Math.max(max, a.reach || 5), 5);
      let crossedReach = false;
      for (const cell of turnPath) {
        const d = Math.max(
          Math.abs(e.position.x - cell.x),
          Math.abs(e.position.y - cell.y),
        ) * 5;
        if (d <= reach) { crossedReach = true; break; }
      }
      const stillAdj = creatureDistance(creature, e) <= reach;
      return crossedReach && !stillAdj;
    });
    if (escapedFrom.length > 0) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: creature.displayName, action: 'Nimble Escape: Disengage',
        details: `${creature.displayName} uses Nimble Escape to slip out of melee (bonus action).`,
        type: 'move'
      });
      for (const e of escapedFrom) {
        state.events.push({
          kind: 'oaAvoided', moverId: creature.id, enemyId: e.id,
          reason: 'nimble', durationMs: BASE_DURATIONS.oaAvoided,
        });
      }
    }
  }

  // Check if movement caused any creature to enter a concentration aura
  if (didMove) {
    checkAuraEntry(state, creature, oldPosBeforeMove);
    triggerPersistentZones(state, creature, 'entry');
    if (!creature.isAlive || state.isComplete) return;
  }

  // Recalculate distance after movement
  let newDist = creatureDistance(creature, target);

  // Post-movement AoE check: creatures that moved into range can now
  // fire breath weapons, Mind Blast, or other AoE specials on the same turn.
  for (const special of specials) {
    if (special.resourceCost && !hasResource(creature, special.resourceCost.key, special.resourceCost.amount)) continue;
    if (special.recharge && creature.recharges[special.name] === false) continue;
    if (creature.recharges[special.name] !== false && shouldUseAoE(state, creature, special)) {
      const aoeTargets = getAoETargets(state, creature, special);
      resolveAoE(state, creature, special, aoeTargets);
      creature.recharges[special.name] = false;
      creature.hasActed = true;
      checkBattleComplete(state);
      return;
    }
  }

  // Post-movement hero spellcast: if the hero moved closer to enemies,
  // spells that were out of range before might now be castable.
  if (hasSpells && !creature.hasActed && trySpellcast(state, creature, () => tryStabiliseDyingAlly(state, creature))) {
    creature.hasActed = true;
    checkBattleComplete(state);
    return;
  }

  // Reckless Attack (Barbarian L2+): always reckless when in melee range.
  // Gives advantage on STR melee attacks but enemies get advantage back.
  // Brutal Strike (L9+): forgo advantage for +1d10 damage instead.
  if (creature.monsterData.heroClass === 'Barbarian' && (creature.monsterData.heroLevel ?? 0) >= 2
      && newDist <= bestMeleeReach && meleeActions.length > 0) {
    if ((creature.monsterData.heroLevel ?? 0) >= 9) {
      creature.turnFlags.brutalStrike = true;
    } else {
      creature.turnFlags.reckless = true;
    }
  }

  runIntimidatingPresence(state, creature);
  if (state.isComplete) return;
  tryActivateSacredWeapon(state, creature, newDist, meleeActions, bestMeleeReach);
  tryActivateNaturesVeil(state, creature);
  tryUseSteadyAim(state, creature, didMove, newDist, meleeActions, rangedActions);

  // D&D 5e: charmed creatures can't attack the charmer. If the ONLY
  // enemy is the charmer, skip the entire attack phase. If there are
  // other enemies, the multiattack loop handles per-attack retargeting.
  if (creature.conditions.includes('charmed') && target) {
    const charmSource = creature.conditionTimers.find(t => t.condition === 'charmed')?.sourceId;
    const enemies = getEnemies(state, creature).filter(e => e.isAlive);
    if (charmSource && enemies.length === 1 && enemies[0].id === charmSource) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: creature.displayName, action: 'Charmed',
        details: `${creature.displayName} is charmed and has no valid targets to attack!`,
        type: 'condition'
      });
      creature.hasActed = true;
      return;
    }
  }

  const swallowedCandidate = getEnemies(state, creature).find(enemy =>
    enemy.isAlive &&
    enemy.conditionTimers.some(timer => timer.condition === 'grappled' && timer.sourceId === creature.id)
  );
  const swallowAction = getActiveActions(creature).find(action => action.name === 'Swallow');
  if (!creature.hasActed && swallowAction && swallowedCandidate &&
      resolveSwallowAction(state, creature, swallowedCandidate, swallowAction)) {
    creature.hasActed = true;
    checkBattleComplete(state);
    return;
  }

  const singleTargetSpecials = specials
    .filter(special => !special.savingThrow?.area)
    .filter(special => !special.resourceCost || hasResource(creature, special.resourceCost.key, special.resourceCost.amount))
    .filter(special => !special.recharge || creature.recharges[special.name] !== false)
    .filter(special => actionCanReachDistance(special, newDist))
    .filter(special => {
      const condition = special.savingThrow?.conditionOnFail ?? special.conditionOnHit?.condition;
      return !condition || !target.conditions.includes(condition);
    });
  if (!creature.hasActed && !multiattack && singleTargetSpecials.length > 0) {
    const bestSpecial = singleTargetSpecials.reduce((best, action) =>
      scoreActionChoice(action, target) > scoreActionChoice(best, target) ? action : best
    );
    const bestAttack = [...meleeActions, ...rangedActions]
      .filter(action => actionCanReachDistance(action, newDist))
      .sort((a, b) => scoreActionChoice(b, target) - scoreActionChoice(a, target))[0];
    if (!bestAttack || controlValue(bestSpecial) >= 8 ||
        scoreActionChoice(bestSpecial, target) >= scoreActionChoice(bestAttack, target)) {
      if (bestSpecial.recharge && creature.recharges[bestSpecial.name] === undefined) {
        creature.recharges[bestSpecial.name] = true;
      }
      if (bestSpecial.savingThrow) {
        resolveSingleTargetSave(state, creature, target, bestSpecial);
      }
      if (bestSpecial.recharge) creature.recharges[bestSpecial.name] = false;
      creature.hasActed = true;
      checkBattleComplete(state);
      return;
    }
  }

  // Execute attacks
  if (multiattack) {
    // Beholder Eye Rays: pick 3 random rays from the special/ranged actions
    const desc = multiattack.description.toLowerCase();
    let attacks: MonsterAction[];
    if (desc.includes('eye ray')) {
      const rays = getActiveActions(creature).filter(a =>
        a.type !== 'multiattack' && a.type !== 'melee' && a.name !== 'Bite'
      );
      attacks = [];
      for (let r = 0; r < 3 && rays.length > 0; r++) {
        const idx = Math.floor(engineRandom() * rays.length);
        attacks.push(rays[idx]);
      }
    } else if (desc.includes('reel')) {
      // Roper-style multiattack: Tentacle x2, Reel, Bite x2
      const tentacle = getActiveActions(creature).find(a => a.name.toLowerCase().includes('tentacle'));
      const bite = getActiveActions(creature).find(a => a.name === 'Bite');
      attacks = [];
      if (tentacle) { attacks.push(tentacle, tentacle); }
      // Sentinel: Reel is inserted as a marker, handled below
      attacks.push({ name: '__reel__', type: 'special', description: '', actions: [] } as unknown as MonsterAction);
      if (bite) { attacks.push(bite, bite); }
    } else {
      attacks = parseMultiattack(desc, creature, newDist, meleeActions, rangedActions);
    }

    const usedLoadingActions = new Set<string>();
    for (const attack of attacks) {
      // Reel: pull all grappled targets toward this creature
      if (attack.name === '__reel__') {
        processReel(state, creature);
        continue;
      }

      let currentTarget = targetStillValid(state, creature, target) ? target : selectTarget(state, creature, targetStrategy);
      if (!currentTarget) break;

      // D&D 5e: charmed creatures can't attack the charmer. If the
      // current target is the charm source, try to pick a different
      // enemy. If no other enemies exist, skip the attack entirely.
      if (creature.conditions.includes('charmed')) {
        const charmSource = creature.conditionTimers.find(t => t.condition === 'charmed')?.sourceId;
        if (charmSource && currentTarget.id === charmSource) {
          const otherTarget = getEnemies(state, creature)
            .filter(e => e.isAlive && e.id !== charmSource)[0] ?? null;
          if (otherTarget) {
            currentTarget = otherTarget;
          } else {
            pushLog(state, {
              round: state.round, turn: state.turnIndex,
              actor: creature.displayName, action: 'Charmed',
              details: `${creature.displayName} is charmed and cannot attack ${currentTarget.displayName}!`,
              type: 'condition'
            });
            continue;
          }
        }
      }

      const chosen = chooseLegalAttackForTarget(creature, currentTarget, attack, rangedActions, usedLoadingActions);
      if (!chosen) {
        if (!loadingActionAlreadyUsed(attack, usedLoadingActions)) {
          resolveAttack(state, creature, currentTarget, attack);
          checkBattleComplete(state);
          if (state.isComplete) return;
        }
        continue;
      }
      markLoadingActionUsed(chosen, usedLoadingActions);

      if (creature.monsterData.name === 'Mind Flayer' && chosen.name === 'Extract Brain' &&
          !currentTarget.conditions.includes('stunned') && !currentTarget.conditions.includes('grappled')) {
        continue;
      }

      if (creature.monsterData.name === 'Purple Worm' && chosen.name === 'Swallow' &&
          !currentTarget.conditions.includes('grappled')) {
        continue;
      }

      // Special/save-based actions: route by whether they have an area
      // (true AoE → resolveAoE) or not (single-target → resolveSingleTargetSave).
      // Previously ALL save-based specials went through resolveAoE, which
      // emitted a 30-foot sphere animation for single-target rays/charms.
      if (chosen.name === 'Swallow') {
        resolveSwallowAction(state, creature, currentTarget, chosen);
      } else if (chosen.type === 'special' && chosen.savingThrow && chosen.savingThrow.area) {
        resolveAoE(state, creature, chosen, [currentTarget]);
      } else if (chosen.type === 'special' && chosen.savingThrow) {
        resolveSingleTargetSave(state, creature, currentTarget, chosen);
      } else {
        resolveAttack(state, creature, currentTarget, chosen);
      }
      checkBattleComplete(state);
      if (state.isComplete) return;
    }
    creature.hasActed = true;
  } else if (tactic === 'kiting' && rangedActions.length > 0) {
    const bestRanged = rangedActions.reduce((best, a) =>
      estimateActionDamage(a, target) > estimateActionDamage(best, target) ? a : best
    );
    const maxRange = bestRanged.range?.long || bestRanged.range?.normal || 120;
    if (newDist <= maxRange) {
      resolveAttack(state, creature, target, bestRanged);
    } else if (newDist <= bestMeleeReach && meleeActions.length > 0 && !meleeBlockedByAltitude(creature, target)) {
      const bestMelee = meleeActions.reduce((best, a) =>
        estimateActionDamage(a, target) > estimateActionDamage(best, target) ? a : best
      );
      resolveAttack(state, creature, target, bestMelee);
    }
  }

  // Recompute distance after all movement (including kite/OA)
  newDist = creatureDistance(creature, target);
  const meleeAltitudeBlocked = meleeBlockedByAltitude(creature, target);

  if (!creature.hasActed && newDist <= bestMeleeReach && meleeActions.length > 0 && rangedActions.length > 0) {
    // Both melee and ranged available - pick based on creature profile
    const bestMelee = meleeActions.reduce((best, a) =>
      estimateActionDamage(a, target) > estimateActionDamage(best, target) ? a : best
    );
    const bestRanged = rangedActions.reduce((best, a) =>
      estimateActionDamage(a, target) > estimateActionDamage(best, target) ? a : best
    );
    const maxRange = bestRanged.range?.long || bestRanged.range?.normal || 120;
    const enemyAdjacent = enemies.some(e => e.isAlive && creatureDistance(creature, e) <= 5);
    const wantsRanged = creature.monsterData.heroClass !== 'Barbarian' && (
      creature.monsterData.heroClass === 'Rogue' ||
      (tactic === 'kiting') ||
      (creature.monsterData.ac <= 14 && estimateActionDamage(bestRanged, target) >= estimateActionDamage(bestMelee, target) * 0.7)
    );
    const prefersRanged = wantsRanged && !enemyAdjacent;
    if ((prefersRanged || meleeAltitudeBlocked) && newDist <= maxRange) {
      resolveAttack(state, creature, target, bestRanged);
    } else if (!meleeAltitudeBlocked) {
      resolveAttack(state, creature, target, bestMelee);
    }
  } else if (!creature.hasActed && newDist <= bestMeleeReach && meleeActions.length > 0 && !meleeAltitudeBlocked) {
    const bestMelee = meleeActions.reduce((best, a) =>
      estimateActionDamage(a, target) > estimateActionDamage(best, target) ? a : best
    );
    resolveAttack(state, creature, target, bestMelee);
  } else if (!creature.hasActed && rangedActions.length > 0) {
    const bestRanged = rangedActions.reduce((best, a) =>
      estimateActionDamage(a, target) > estimateActionDamage(best, target) ? a : best
    );
    const maxRange = bestRanged.range?.long || bestRanged.range?.normal || 120;
    if (newDist <= maxRange) {
      resolveAttack(state, creature, target, bestRanged);
    }
  } else if (!creature.hasActed && meleeActions.length > 0) {
    // Moved but still out of range - dash (move again)
    const oldPos = { ...creature.position };
    const dashSpeedZero = creature.conditions.includes('restrained') || creature.conditions.includes('grappled');
    creature.movementRemaining = dashSpeedZero ? 0 : Math.max(0, getEffectiveMoveSpeed(creature, state) - activeSpeedPenalty(creature)); // Dash
    creature.position = moveToward(creature, chooseSmartDestination(creature, target, state), state);
    const moved = distance(oldPos, creature.position);
    if (moved > 0) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: creature.displayName, action: 'Dash',
        details: `${creature.displayName} dashes ${moved} ft toward ${target.displayName}!`,
        type: 'move'
      });
    }
  }

  tryHasteFollowUp(state, creature, targetStrategy);
  runActionSurge(state, creature, target, targetStrategy, multiattack, meleeActions, rangedActions, bestMeleeReach);
  runFlurryOfBlows(state, creature, target, targetStrategy, meleeActions, bestMeleeReach);
  runMartialArtsBonusStrike(state, creature, target, targetStrategy, meleeActions, bestMeleeReach);
  runFrenzy(state, creature, target, targetStrategy, meleeActions, bestMeleeReach);

  creature.hasActed = true;
  checkBattleComplete(state);
  } finally {
    processHydraEndOfTurn(state, creature);
    processTargetTurnEndOngoingEffects(state, creature);
  }
}

function countWordToNumber(value: string | undefined): number {
  if (!value) return 2;
  if (value === 'five' || value === '5') return 5;
  if (value === 'four' || value === '4') return 4;
  if (value === 'three' || value === '3') return 3;
  return 2;
}

const CONTROL_ACTION_VALUE: Partial<Record<Condition, number>> = {
  paralyzed: 24,
  stunned: 24,
  unconscious: 24,
  incapacitated: 20,
  petrified: 28,
  restrained: 10,
  frightened: 8,
  blinded: 8,
  charmed: 8,
  prone: 4,
  grappled: 4,
  poisoned: 3,
};

function controlValue(action: MonsterAction): number {
  const condition = action.conditionOnHit?.condition ?? action.savingThrow?.conditionOnFail;
  return condition ? CONTROL_ACTION_VALUE[condition] ?? 3 : 0;
}

function scoreActionChoice(action: MonsterAction, target?: Creature): number {
  const damageScore = action.attackBonus !== undefined
    ? expectedHitDamage(action, target?.monsterData.ac)
    : estimateActionDamage(action, target);
  return damageScore + controlValue(action);
}

function actionCanReachDistance(action: MonsterAction, distanceFt: number): boolean {
  if (action.type === 'melee') return distanceFt <= (action.reach ?? 5);
  if (action.type === 'ranged') {
    const range = action.range?.long ?? action.range?.normal ?? 0;
    return distanceFt <= range;
  }
  if (action.range) return distanceFt <= (action.range.long ?? action.range.normal);
  const withinMatch = action.description.match(/within\s+(\d+)\s+feet/i);
  if (withinMatch) return distanceFt <= Number(withinMatch[1]);
  return distanceFt <= (action.reach ?? 5);
}

function meleeBlockedByAltitude(attacker: Creature, target: Creature): boolean {
  return target.airborne === true && (getActiveSpeed(attacker).fly ?? 0) <= 0;
}

function loadingActionKey(action: MonsterAction): string {
  return action.name.toLowerCase();
}

function actionHasLoadingProperty(action: MonsterAction): boolean {
  return action.loading ?? /\bcrossbow\b/i.test(action.name);
}

function loadingActionAlreadyUsed(action: MonsterAction, usedLoadingActions: Set<string>): boolean {
  return actionHasLoadingProperty(action) && usedLoadingActions.has(loadingActionKey(action));
}

function markLoadingActionUsed(action: MonsterAction, usedLoadingActions: Set<string>): void {
  if (actionHasLoadingProperty(action)) usedLoadingActions.add(loadingActionKey(action));
}

function bestLegalRangedAlternative(
  rangedActions: MonsterAction[],
  distanceFt: number,
  usedLoadingActions: Set<string>,
): MonsterAction | null {
  const candidates = rangedActions
    .filter(action => !loadingActionAlreadyUsed(action, usedLoadingActions))
    .filter(action => distanceFt <= (action.range?.long ?? action.range?.normal ?? 0))
    .sort((a, b) => scoreActionChoice(b) - scoreActionChoice(a));
  return candidates[0] ?? null;
}

function chooseLegalAttackForTarget(
  creature: Creature,
  target: Creature,
  planned: MonsterAction,
  rangedActions: MonsterAction[],
  usedLoadingActions: Set<string>,
): MonsterAction | null {
  const distanceFt = creatureDistance(creature, target);
  const isMelee = planned.type === 'melee' || planned.type === undefined;
  const isRanged = planned.type === 'ranged';
  const meleeReach = planned.reach ?? 5;
  const altitudeBlocked = isMelee && meleeBlockedByAltitude(creature, target);

  if (loadingActionAlreadyUsed(planned, usedLoadingActions)) {
    return bestLegalRangedAlternative(rangedActions, distanceFt, usedLoadingActions);
  }

  if ((isMelee && distanceFt > meleeReach) || altitudeBlocked) {
    return bestLegalRangedAlternative(rangedActions, distanceFt, usedLoadingActions);
  }

  if (isRanged) {
    const maxRange = planned.range?.long ?? planned.range?.normal ?? 5;
    if (distanceFt > maxRange) {
      return bestLegalRangedAlternative(rangedActions, distanceFt, usedLoadingActions);
    }
  }

  return planned;
}

function parseMultiattack(
  desc: string,
  creature: Creature,
  distToTarget: number,
  meleeActions: MonsterAction[],
  rangedActions: MonsterAction[]
): MonsterAction[] {
  const attacks: MonsterAction[] = [];
  const usedLoadingActions = new Set<string>();
  const pushAttack = (action: MonsterAction | undefined): boolean => {
    if (!action) return false;
    if (loadingActionAlreadyUsed(action, usedLoadingActions)) return false;
    attacks.push(action);
    markLoadingActionUsed(action, usedLoadingActions);
    return true;
  };
  const pushRepeated = (action: MonsterAction | undefined, count: number): void => {
    for (let i = 0; i < count; i++) {
      if (!pushAttack(action)) break;
    }
  };
  const pushBestAvailable = (candidates: MonsterAction[], count: number): void => {
    const sorted = [...candidates].sort((a, b) => scoreActionChoice(b) - scoreActionChoice(a));
    for (let i = 0; i < count; i++) {
      const next = sorted.find(action => !loadingActionAlreadyUsed(action, usedLoadingActions));
      if (!pushAttack(next)) break;
    }
  };
  const activeActions = getActiveActions(creature);
  const byName = (name: string) => activeActions.find(action =>
    !action.legendaryOnly && action.name.toLowerCase() === name.toLowerCase()
  );

  if (creature.monsterData.name === 'Hydra' && desc.includes('as many bite attacks as it has heads')) {
    const bite = byName('Bite');
    const headCount = getHydraHeadCount(creature) ?? 5;
    if (bite) return Array.from({ length: Math.max(0, headCount) }, () => bite);
  }

  if (creature.monsterData.name === 'Tarrasque' && desc.includes('one bite') && desc.includes('three other attacks')) {
    const bite = byName('Bite');
    const otherAttacks = activeActions
      .filter(action => ['Claw', 'Tail'].includes(action.name) && actionCanReachDistance(action, distToTarget))
      .sort((a, b) => scoreActionChoice(b) - scoreActionChoice(a));
    const bestOther = otherAttacks[0] ?? byName('Claw') ?? byName('Tail');
    pushAttack(bite);
    pushRepeated(bestOther, 3);
    if (attacks.length > 0) return attacks;
  }

  if (creature.monsterData.name === 'Pit Fiend' && desc.includes('one bite') && desc.includes('two devilish claw')) {
    const bite = byName('Bite');
    const claw = byName('Devilish Claw');
    const mace = byName('Fiery Mace');
    pushAttack(bite);
    pushRepeated(claw, 2);
    pushAttack(mace);
    if (attacks.length > 0) return attacks;
  }

  if (creature.monsterData.name === 'Vampire' && desc.includes('two grave strike') && desc.includes('uses bite')) {
    const graveStrike = byName('Grave Strike');
    const bite = byName('Bite');
    pushRepeated(graveStrike, 2);
    pushAttack(bite);
    if (attacks.length > 0) return attacks;
  }

  if (creature.monsterData.name === 'Mind Flayer' && desc.includes('tentacles')) {
    const tentacles = byName('Tentacles');
    const extractBrain = byName('Extract Brain');
    pushAttack(tentacles);
    pushAttack(extractBrain);
    if (attacks.length > 0) return attacks;
  }

  if (creature.monsterData.name === 'Purple Worm' && desc.includes('one bite') && desc.includes('tail stinger')) {
    const bite = byName('Bite');
    const tail = byName('Tail Stinger');
    const swallow = byName('Swallow');
    pushAttack(bite);
    pushAttack(tail);
    pushAttack(swallow);
    if (attacks.length > 0) return attacks;
  }

  const replacement = activeActions.find(action =>
    action.type === 'special' &&
    !action.legendaryOnly &&
    desc.includes('replace one attack') &&
    desc.includes(action.name.toLowerCase()) &&
    actionCanReachDistance(action, distToTarget)
  );
  const replaceBase = desc.match(/makes\s+(three|3|two|2|four|4|five|5)\s+(\w+)\s+attacks/i);
  if (replacement && replaceBase) {
    const count = countWordToNumber(replaceBase[1].toLowerCase());
    const baseName = replaceBase[2].toLowerCase();
    const base = activeActions.find(action =>
      !action.legendaryOnly && action.name.toLowerCase().includes(baseName) && action.type !== 'multiattack'
    );
    if (base) {
      pushAttack(replacement);
      pushRepeated(base, count - 1);
      return attacks;
    }
  }

  // Generic "makes three attacks, using X or Y in any combination" text.
  // 2024 stat blocks such as the Lich use this shape; older parsing fell
  // through to the two-attack fallback because "attacks" was parsed as
  // the action name.
  const genericCount = desc.match(/makes\s+(three|3|two|2|four|4|five|5)\s+attacks\b/i);
  if (genericCount) {
    const count = countWordToNumber(genericCount[1].toLowerCase());
    const candidates = [...meleeActions, ...rangedActions]
      .filter(action => !action.legendaryOnly && actionCanReachDistance(action, distToTarget));
    if (candidates.length > 0) {
      pushBestAvailable(candidates, count);
      return attacks;
    }
  }

  // Try to parse "makes N X attacks" patterns
  const patterns = [
    /makes (?:three|3) (\w+)/i,
    /makes (?:two|2) (\w+)/i,
    /makes (?:five|5) (\w+)/i,
    /makes (?:four|4) (\w+)/i,
  ];

  for (const pattern of patterns) {
    const match = desc.match(pattern);
    if (match) {
      const attackName = match[1].toLowerCase();
      const count = desc.includes('three') || desc.includes('3') ? 3 :
                    desc.includes('five') || desc.includes('5') ? 5 :
                    desc.includes('four') || desc.includes('4') ? 4 : 2;

      // Find the matching action
      const action = activeActions.find(a =>
        !a.legendaryOnly && a.name.toLowerCase().includes(attackName) && a.type !== 'multiattack'
      );

      if (action) {
        pushRepeated(action, count);
        return attacks;
      }
    }
  }

  // Try "one X and one/two Y" or "one X attack and three Y attacks"
  const comboMatch = desc.match(/one (\w+).*(?:and|,)\s*(?:one|two|three|1|2|3)\s+(\w+)/i);
  if (comboMatch) {
    const name1 = comboMatch[1].toLowerCase();
    const name2 = comboMatch[2].toLowerCase();
    const countMatch = desc.match(/(?:and|,)\s*(one|two|three|1|2|3)\s+/i);
    const count2 = countMatch ? (
      countMatch[1] === 'three' || countMatch[1] === '3' ? 3 :
      countMatch[1] === 'two' || countMatch[1] === '2' ? 2 : 1
    ) : 1;

    const action1 = activeActions.find(a =>
      !a.legendaryOnly && a.name.toLowerCase().includes(name1) && a.type !== 'multiattack'
    );
    const action2 = activeActions.find(a =>
      !a.legendaryOnly && a.name.toLowerCase().includes(name2) && a.type !== 'multiattack'
    );

    pushAttack(action1);
    pushRepeated(action2, count2);
    if (attacks.length > 0) return attacks;
  }

  // Fallback: pick appropriate attacks based on situation
  const allAttacks = [...meleeActions, ...rangedActions].filter(a => a.type !== 'multiattack');

  if (allAttacks.length === 0) return [];

  // Two attacks of the best available action
  if (distToTarget <= 10 && meleeActions.length > 0) {
    pushBestAvailable(meleeActions, 2);
  } else if (rangedActions.length > 0) {
    pushBestAvailable(rangedActions, 2);
  } else {
    pushBestAvailable(allAttacks, 2);
  }

  return attacks;
}

type LegendaryActionPlan = {
  legendaryAction: LegendaryAction;
  cost: number;
  score: number;
  action?: MonsterAction;
  target?: Creature;
  targets?: Creature[];
  center?: { x: number; y: number };
  teleportTo?: { x: number; y: number };
  teleportBurst?: LegendaryAction['teleportBurst'];
};

function isValidSingleTargetForAction(action: MonsterAction, target: Creature): boolean {
  if (!target.isAlive) return false;
  if (action.targetTypeRestriction &&
      target.monsterData.type.toLowerCase() !== action.targetTypeRestriction.toLowerCase()) {
    return false;
  }
  const condition = action.conditionOnHit?.condition ?? action.savingThrow?.conditionOnFail;
  if (condition && target.conditions.includes(condition)) return false;
  return true;
}

function scoreLegendaryActionAgainstTarget(action: MonsterAction, target: Creature): number {
  if (action.attackBonus !== undefined) return scoreActionChoice(action, target);
  return estimateDamage(action, { target }) + controlValue(action);
}

function areaCenterForAction(
  state: BattleState,
  creature: Creature,
  action: MonsterAction,
): { x: number; y: number } | undefined {
  const area = action.savingThrow?.area?.toLowerCase() ?? '';
  if (!action.range || !(area.includes('sphere') || area.includes('cylinder') || area.includes('radius'))) {
    return undefined;
  }
  const rangeMatch = area.match(/(\d+)-foot/);
  const radiusFt = rangeMatch ? parseInt(rangeMatch[1]) : 20;
  return pickRangedSphereCenter(state, creature, action, radiusFt).center;
}

function chooseLegendaryTeleportDestination(
  state: BattleState,
  creature: Creature,
  distanceFt: number,
): { x: number; y: number } {
  const maxCells = Math.floor(distanceFt / 5);
  const gridSize = state.gridSize ?? 20;
  const enemies = getEnemies(state, creature).filter(e => e.isAlive);
  let best = { ...creature.position };
  let bestScore = -Infinity;

  for (let x = Math.max(0, creature.position.x - maxCells); x <= Math.min(gridSize - 1, creature.position.x + maxCells); x++) {
    for (let y = Math.max(0, creature.position.y - maxCells); y <= Math.min(gridSize - 1, creature.position.y + maxCells); y++) {
      const candidate = { x, y };
      if (distance(creature.position, candidate) > distanceFt) continue;
      if (isPositionBlocked(candidate, getActiveSize(creature), state.creatures, creature.id, state.terrainBlocked)) continue;
      const nearestEnemy = enemies.reduce((nearest, enemy) =>
        Math.min(nearest, distance(candidate, enemy.position)), Infinity
      );
      if (nearestEnemy > bestScore) {
        bestScore = nearestEnemy;
        best = candidate;
      }
    }
  }

  return best;
}

function teleportBurstTargets(
  state: BattleState,
  creature: Creature,
  from: { x: number; y: number },
  to: { x: number; y: number },
  radiusFt: number,
): Creature[] {
  return getAliveCreatures(state).filter(target =>
    target.id !== creature.id &&
    (distance(target.position, from) <= radiusFt || distance(target.position, to) <= radiusFt)
  );
}

function buildLegendaryActionPlan(
  state: BattleState,
  creature: Creature,
  legendaryAction: LegendaryAction,
  remaining: number,
): LegendaryActionPlan | null {
  const cost = legendaryAction.cost ?? 1;
  if (cost > remaining) return null;

  if (legendaryAction.teleportBurst) {
    const teleportTo = chooseLegendaryTeleportDestination(state, creature, legendaryAction.teleportBurst.distanceFt);
    const targets = teleportBurstTargets(
      state,
      creature,
      creature.position,
      teleportTo,
      legendaryAction.teleportBurst.radiusFt,
    );
    const baseDamage = averageDamage(legendaryAction.teleportBurst.damage);
    const score = targets
      .filter(target => target.team !== creature.team)
      .reduce((sum, target) =>
        sum + adjustForResistance(baseDamage, legendaryAction.teleportBurst!.damageType, target), 0
      );
    const moved = teleportTo.x !== creature.position.x || teleportTo.y !== creature.position.y;
    return {
      legendaryAction,
      cost,
      score: score + (moved ? 0.02 : 0),
      targets,
      teleportTo,
      teleportBurst: legendaryAction.teleportBurst,
    };
  }

  if (creature.monsterData.name === 'Beholder' && legendaryAction.name === 'Eye Ray') {
    const rays = getActiveActions(creature).filter(action =>
      action.name.includes('Ray') && action.name !== 'Eye Rays'
    );
    const rayPlans = rays.flatMap(action => {
      const enemies = getEnemies(state, creature).filter(enemy =>
        isValidSingleTargetForAction(action, enemy) &&
        actionCanReachDistance(action, creatureDistance(creature, enemy))
      );
      return enemies.map(target => ({
        action,
        target,
        score: scoreLegendaryActionAgainstTarget(action, target),
      }));
    });
    const best = rayPlans.sort((a, b) => b.score - a.score)[0];
    if (best) {
      return {
        legendaryAction,
        cost,
        score: best.score,
        action: best.action,
        target: best.target,
      };
    }
  }

  if (!legendaryAction.actionRef) {
    return { legendaryAction, cost, score: 0.01 };
  }

  const action = getActiveActions(creature).find(a => a.name === legendaryAction.actionRef);
  if (!action) return null;

  const enemies = getEnemies(state, creature).filter(e => isValidSingleTargetForAction(action, e));
  if (enemies.length === 0) return null;

  if (action.savingThrow?.area) {
    const targets = getAoETargets(state, creature, action);
    const condition = action.savingThrow.conditionOnFail;
    const meaningfulEnemies = targets.filter(target =>
      target.team !== creature.team &&
      target.isAlive &&
      (!condition || !target.conditions.includes(condition))
    );
    if (meaningfulEnemies.length === 0) return null;
    const score = meaningfulEnemies.reduce((sum, target) =>
      sum + scoreLegendaryActionAgainstTarget(action, target), 0
    );
    return {
      legendaryAction,
      cost,
      score,
      action,
      targets,
      center: areaCenterForAction(state, creature, action),
    };
  }

  const candidates = enemies
    .map(target => ({ target, distance: creatureDistance(creature, target) }))
    .filter(({ distance }) => actionCanReachDistance(action, distance));
  if (candidates.length === 0) return null;

  const best = candidates.reduce((currentBest, candidate) =>
    scoreLegendaryActionAgainstTarget(action, candidate.target) >
    scoreLegendaryActionAgainstTarget(action, currentBest.target)
      ? candidate
      : currentBest
  );

  return {
    legendaryAction,
    cost,
    score: scoreLegendaryActionAgainstTarget(action, best.target),
    action,
    target: best.target,
  };
}

function logLegendaryAction(state: BattleState, creature: Creature, legendaryAction: LegendaryAction): void {
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: creature.displayName, action: 'Legendary Action',
    details: `${creature.displayName} uses a legendary action: ${legendaryAction.name}.`,
    type: 'special'
  });
  creature.stats.actionUsage[`LA: ${legendaryAction.name}`] =
    (creature.stats.actionUsage[`LA: ${legendaryAction.name}`] || 0) + 1;
}

function executeTeleportBurst(state: BattleState, creature: Creature, plan: LegendaryActionPlan): void {
  if (!plan.teleportTo || !plan.teleportBurst) return;

  const from = { ...creature.position };
  const to = { ...plan.teleportTo };
  if (from.x !== to.x || from.y !== to.y) {
    creature.position = to;
    state.events.push({
      kind: 'move',
      creatureId: creature.id,
      from,
      to,
      path: [from, to],
      durationMs: BASE_DURATIONS.move,
    });
  }

  for (const target of plan.targets ?? []) {
    const damage = rollDice(plan.teleportBurst.damage).total;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: plan.legendaryAction.name,
      details: `${target.displayName} takes ${damage} ${plan.teleportBurst.damageType} damage from ${creature.displayName}'s ${plan.legendaryAction.name}!`,
      damage,
      type: 'damage',
    });
    applyDamage(state, target, damage, plan.teleportBurst.damageType, creature, false, true);
  }
}

/**
 * Execute one legendary action for a creature that has LA points remaining.
 * Picks the best affordable legendary action and resolves it.
 *
 * Exported so `ai-loop.ts` can invoke this from `executeRound` after
 * each non-legendary creature's turn. Moves into the same module as
 * `executeTurn` when Phase 3c extracts the turn orchestrator.
 */
export function executeLegendaryAction(state: BattleState, creature: Creature): void {
  const las = creature.monsterData.legendaryActions!;
  const remaining = creature.legendaryActionsRemaining ?? 0;
  if (remaining <= 0) return;

  const enemies = getEnemies(state, creature).filter(e => e.isAlive);
  if (enemies.length === 0) return;

  const plan = las
    .map(la => buildLegendaryActionPlan(state, creature, la, remaining))
    .filter((p): p is LegendaryActionPlan => !!p)
    .sort((a, b) => b.score - a.score || b.cost - a.cost)[0];
  if (!plan) return;

  creature.legendaryActionsRemaining = remaining - plan.cost;
  logLegendaryAction(state, creature, plan.legendaryAction);

  if (plan.teleportBurst) {
    executeTeleportBurst(state, creature, plan);
    checkBattleComplete(state);
    return;
  }

  if (!plan.action) return;

  if (plan.action.savingThrow?.area && plan.targets) {
    resolveAoE(state, creature, plan.action, plan.targets, plan.center);
  } else if (plan.action.savingThrow && plan.target) {
    resolveSingleTargetSave(state, creature, plan.target, plan.action);
  } else if (plan.target) {
    resolveAttack(state, creature, plan.target, plan.action);
  }

  checkBattleComplete(state);
}
