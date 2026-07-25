/**
 * Area-of-effect resolution + single-target save resolution.
 *
 * Phase 4c refactor: extracted from the original monolithic combat.ts.
 * Covers four save-based concerns:
 *
 *   - Single-target save resolution (resolveSingleTargetSave) - Beholder
 *     rays, Vampire Charm, Ghost Possession, etc. Picks the right
 *     visual mode (beam / psychic / grapple / touch).
 *   - AoE resolution (resolveAoE) - cones, lines, spheres, cylinders.
 *     Handles damage saves, evasion, legendary resistance, immunity,
 *     condition-on-fail, and the 2024 Sleep HP-pool variant.
 *   - Target picking (getAoETargets, bestDirectionalTargets) - parses
 *     the area string and finds the best direction for cones/lines.
 *   - Animation (emitAoEEvent, getSingleTargetVisual) - emits the
 *     correct event for the renderer.
 *
 * There is an ESM cycle: combat-aoe imports applyDamage / applyCondition
 * / resolveConditionOnHit / pushLog from combat.ts; combat.ts imports
 * resolveAoE / resolveSingleTargetSave / getAoETargets / etc. back from
 * combat-aoe. This is safe because every cross-module call happens
 * inside a function body (lazy named binding) - same pattern as the
 * combat <-> combat-buffs cycle from Phase 4b.
 */
import { Condition, Creature, MonsterAction } from '../types/monster.js';
import { BASE_DURATIONS, type AnimationEvent, type AoEDamageTarget } from '../types/animation.js';
import { rollDice, abilityModifier, maxDiceTotal } from './dice.js';
import {
  creatureDistance, parseAoEShape, isInCone, isInLine, isPositionBlocked, distance,
} from './combat-geometry.js';
import {
  rollSaveWithBuffs, hasResource, consumeResource, addBuff, getSpellSaveDcBonus, applyDamageRollPenalty,
} from './combat-buffs.js';
import {
  applyDamage, applyCondition, resolveConditionOnHit,
  pushLog, getAliveCreatures, getEnemies,
  getEffectiveSaveModifier, hasActiveTrait, getActiveSize,
  applyActionRuntimeEffects, emptyDamageSummary, addDamageToSummary,
  conditionTargetMatchesActionSize, hasTotalCoverFromContainer, logTotalCoverFromContainer, passesSanctuary,
  isImmuneToDamageType,
  type BattleState,
} from './combat.js';
import { runOpportunityAttacks } from './ai-turn.js';

// ─────────────────────────────────────────────────────────────────────
// Single-target visual categorization
// ─────────────────────────────────────────────────────────────────────

/**
 * Categorize a single-target save-based ability into its visual mode.
 * Used when the ability has NO area field (it's not an AoE) and should
 * render as one of the 4 targeted visual styles instead of a sphere.
 *
 * Categories:
 *   beam    - instant bright line from attacker to target (eye rays, spittle)
 *   psychic - ripples at the target only (charm, fear, domination, sleep)
 *   grapple - thick tether line from attacker to target (constrict, engulf, chain)
 *   touch   - color flash on target token (drain, paralyze touch, corruption)
 */
type SingleTargetVisual = 'beam' | 'psychic' | 'grapple' | 'touch';

const BEAM_ABILITIES = new Set([
  'Charm Ray', 'Paralyzing Ray', 'Fear Ray', 'Death Ray', 'Sleep Ray',
  'Enervation Ray', 'Disintegration Ray',
  'Death Glare', 'Poisonous Spittle', 'Acid Spray',
  'Eye Ray',
]);

const PSYCHIC_ABILITIES = new Set([
  'Charm', 'Scare', 'Heart Sight', 'Dreadful Glare',
  'Possession', 'Dominate Mind', 'Consume Memories',
  'Cacophony', 'Mockery', 'Enthralling Panache', 'Roar',
  'Dissonant Whispers', 'Hold Person', 'Vicious Mockery',
  'Hypnotic Pattern', 'Sleep', 'Befuddlement',
  'Power Word Heal', 'Power Word Kill',
]);

const GRAPPLE_ABILITIES = new Set([
  'Constrict', 'Engulf', 'Whelm', 'Web Strand', 'Web',
  'Conjure Infernal Chain', 'Entangling Rope', 'Vortex',
  'Tentacle Slam',
]);

export function getSingleTargetVisual(actionName: string): SingleTargetVisual {
  if (BEAM_ABILITIES.has(actionName)) return 'beam';
  if (PSYCHIC_ABILITIES.has(actionName)) return 'psychic';
  if (GRAPPLE_ABILITIES.has(actionName)) return 'grapple';
  return 'touch';
}

/** Best-effort damage-type inference from a free-text action description. */
function inferDamageType(description: string): string | undefined {
  const m = description.match(/\b(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\b/i);
  return m ? m[1].toLowerCase() : undefined;
}

function draconicElementalAffinityBonus(attacker: Creature, action: MonsterAction, damageType: string): number {
  if (attacker.monsterData.heroClass !== 'Sorcerer' || (attacker.monsterData.heroLevel ?? 0) < 6) return 0;
  if (action.spellLevel === undefined || !/fire/i.test(damageType)) return 0;
  return Math.max(0, abilityModifier(attacker.monsterData.abilities.cha));
}

function wizardEvocationBonus(attacker: Creature, action: MonsterAction): number {
  if (!isWizardEvoker(attacker, 10)) return 0;
  if (action.spellLevel === undefined || action.spellSchool !== 'evocation') return 0;
  return Math.max(0, abilityModifier(attacker.monsterData.abilities.int));
}

function isWizardEvoker(attacker: Creature, minLevel: number): boolean {
  return attacker.monsterData.heroClass === 'Wizard'
    && (attacker.monsterData.heroLevel ?? 0) >= minLevel
    && (!attacker.monsterData.heroSubclass || attacker.monsterData.heroSubclass === 'Evoker');
}

function tryConsumeWizardOverchannel(
  state: BattleState,
  attacker: Creature,
  action: MonsterAction,
  damageExpression: string,
): number | null {
  if (!isWizardEvoker(attacker, 14)) return null;
  const spellLevel = action.spellLevel ?? 0;
  if (spellLevel < 1 || spellLevel > 5) return null;
  if (action.resourceCost || action.atWill) return null;
  if (!action.castingAbility || !hasResource(attacker, 'overchannel')) return null;

  consumeResource(attacker, 'overchannel');
  attacker.stats.actionUsage['Overchannel'] = (attacker.stats.actionUsage['Overchannel'] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: attacker.displayName,
    action: 'Overchannel',
    details: `${attacker.displayName} overchannels ${action.name}, dealing maximum spell damage.`,
    type: 'special',
  });
  return maxDiceTotal(damageExpression);
}

function applySaveBuff(state: BattleState, attacker: Creature, target: Creature, action: MonsterAction, tmpl: NonNullable<MonsterAction['buffOnFailedSave']>): void {
  if (!target.isAlive) return;
  addBuff(target, {
    name: tmpl.name,
    key: tmpl.key,
    casterId: attacker.id,
    appliedRound: state.round,
    endRound: state.round + (action.durationRounds ?? 2),
    requiresConcentration: tmpl.requiresConcentration,
    attackBonus: tmpl.attackBonus,
    attackBonusDice: tmpl.attackBonusDice,
    saveBonus: tmpl.saveBonus,
    saveBonusDice: tmpl.saveBonusDice,
    acBonus: tmpl.acBonus,
    damageRider: tmpl.damageRider,
    bonusActionDamage: tmpl.bonusActionDamage,
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
    preventDeath: tmpl.preventDeath,
    advantageForAttackerId: tmpl.advantageForAttackerId,
    advantageForAllAttackers: tmpl.advantageForAllAttackers,
    attackDisadvantage: tmpl.attackDisadvantage,
    attackDisadvantageAgainstCaster: tmpl.attackDisadvantageAgainstCaster,
    attackersHaveDisadvantageExceptCaster: tmpl.attackersHaveDisadvantageExceptCaster,
    saveDisadvantage: tmpl.saveDisadvantage,
    saveDisadvantageAbilities: tmpl.saveDisadvantageAbilities,
    abilityCheckDisadvantageAbilities: tmpl.abilityCheckDisadvantageAbilities,
    forcedDodgeSave: tmpl.forcedDodgeSave,
    forcedFlee: tmpl.forcedFlee,
    cannotMoveAwayFromCaster: tmpl.cannotMoveAwayFromCaster,
    speedPenalty: tmpl.speedPenalty,
    preventsOpportunityAttacks: tmpl.preventsOpportunityAttacks,
    attackBonusForAllAttackers: tmpl.attackBonusForAllAttackers,
    spellAttackAdvantage: tmpl.spellAttackAdvantage,
    spellSaveDcBonus: tmpl.spellSaveDcBonus,
    expiresOnSourceTurnStart: tmpl.expiresOnSourceTurnStart,
    strengthTestDisadvantage: tmpl.strengthTestDisadvantage,
    strengthTestAdvantage: tmpl.strengthTestAdvantage,
    damageRollPenalty: tmpl.damageRollPenalty,
    limitAttacksToOne: tmpl.limitAttacksToOne,
    restrictActionBonusCombination: tmpl.restrictActionBonusCombination,
    saveEnds: tmpl.saveEnds,
    escapeAction: tmpl.escapeAction,
    appliedCondition: tmpl.appliedCondition,
    appliedConditions: tmpl.appliedConditions,
    endsOnDamage: tmpl.endsOnDamage,
    suppressInvisibilityForCasterId: tmpl.suppressInvisibilityForCaster ? attacker.id : undefined,
  });
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: tmpl.name,
    details: `${target.displayName} is affected by ${tmpl.name}.`,
    type: 'special'
  });
}

function findCountercharmBard(state: BattleState, target: Creature): Creature | undefined {
  return getAliveCreatures(state)
    .filter(c => c.team === target.team)
    .filter(c => c.monsterData.heroClass === 'Bard' && (c.monsterData.heroLevel ?? 0) >= 7)
    .filter(c => c.monsterData.reactionPreferences?.countercharm?.enabled ?? true)
    .filter(c => !c.reactionUsed && creatureDistance(c, target) <= 30)
    .sort((a, b) => (b.monsterData.heroLevel ?? 0) - (a.monsterData.heroLevel ?? 0))[0];
}

function tryCountercharm(
  state: BattleState,
  target: Creature,
  conditionOnFail: Condition | undefined,
  saveMod: number,
  dc: number,
  ability: keyof Creature['monsterData']['abilities'],
): { total: number; passed: boolean } | null {
  if (!conditionOnFail || !['charmed', 'frightened'].includes(conditionOnFail)) return null;
  const bard = findCountercharmBard(state, target);
  if (!bard) return null;

  bard.reactionUsed = true;
  bard.stats.actionUsage['Countercharm'] = (bard.stats.actionUsage['Countercharm'] || 0) + 1;
  const reroll = rollSaveWithBuffs(target, saveMod, true, dc, ability, conditionOnFail);
  const passed = reroll.total >= dc;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: bard.displayName,
    action: 'Countercharm',
    details: `${bard.displayName} forces ${target.displayName} to reroll the ${conditionOnFail} save with Advantage (${reroll.total} vs DC ${dc}).`,
    type: passed ? 'save' : 'special',
  });
  return { total: reroll.total, passed };
}

export function pushTargetAwayFromCaster(state: BattleState, attacker: Creature, target: Creature, feet: number, actionName: string = 'Thunderwave Push'): { x: number; y: number } | undefined {
  if (!target.isAlive || feet <= 0) return undefined;
  const dx = Math.sign(target.position.x - attacker.position.x);
  const dy = Math.sign(target.position.y - attacker.position.y);
  const stepX = dx === 0 && dy === 0 ? 0 : dx;
  const stepY = dx === 0 && dy === 0 ? 1 : dy;
  const maxSquares = Math.max(1, Math.floor(feet / 5));
  let best = { ...target.position };
  for (let squares = maxSquares; squares >= 1; squares--) {
    const candidate = {
      x: target.position.x + stepX * squares,
      y: target.position.y + stepY * squares,
    };
    if (candidate.x < 0 || candidate.y < 0 ||
        candidate.x >= (state.gridSize ?? 20) || candidate.y >= (state.gridSize ?? 20)) continue;
    if (isPositionBlocked(candidate, getActiveSize(target), state.creatures, target.id, state.terrainBlocked)) continue;
    best = candidate;
    break;
  }
  if (best.x === target.position.x && best.y === target.position.y) return undefined;
  const from = { ...target.position };
  target.position = best;
  state.events.push({ kind: 'move', creatureId: target.id, from, to: best, durationMs: BASE_DURATIONS.move });
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: actionName,
    details: `${target.displayName} is pushed ${distance(from, best)} ft away.`,
    type: 'move'
  });
  return from;
}

function fleeFromCaster(state: BattleState, attacker: Creature, target: Creature, actionName: string): void {
  if (target.reactionUsed || target.conditions.some(condition => ['incapacitated', 'paralyzed', 'stunned', 'unconscious'].includes(condition))) return;
  const speed = target.movementRemaining > 0 ? target.movementRemaining : (target.monsterData.speed.walk ?? 0);
  const from = pushTargetAwayFromCaster(state, attacker, target, speed, actionName);
  if (!from) return;
  target.reactionUsed = true;
  target.reactionsUsed = (target.reactionsUsed ?? 0) + 1;
  runOpportunityAttacks(state, target, from);
}

// ─────────────────────────────────────────────────────────────────────
// Single-target save resolution
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve a single-target save-based ability (NOT an AoE). Runs the
 * same save -> damage / condition logic as resolveAoE but emits an
 * `attack` event with the correct visual mode (beam/psychic/grapple/
 * touch) instead of an `aoe` sphere event. This fixes the visual bug
 * where Beholder rays, Vampire Charm, Ghost Possession, etc. rendered
 * as 30-foot teal explosions.
 */
export function resolveSingleTargetSave(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction,
): void {
  if (!action.savingThrow || !target.isAlive) return;
  if (hasTotalCoverFromContainer(target, attacker)) {
    logTotalCoverFromContainer(state, attacker, target, action.name);
    return;
  }
  const { ability, damageOnFail, damageOnFailIfTargetWounded, damageOnSuccess, conditionOnFail, additionalConditionsOnFail, conditionDuration } = action.savingThrow;
  const dc = action.savingThrow.dc + getSpellSaveDcBonus(attacker, action);

  const visual = getSingleTargetVisual(action.name);

  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: action.name,
    details: `${attacker.displayName} uses ${action.name} on ${target.displayName}! (DC ${dc} ${ability.toUpperCase()} save)`,
    type: 'special'
  });

  state.events.push({
    kind: 'attack', attackerId: attacker.id, targetId: target.id,
    actionName: action.name, attackType: visual,
    durationMs: BASE_DURATIONS.attack,
  });

  if (!attacker.monsterData.isHero || attacker.wildShape) {
    attacker.stats.actionUsage = attacker.stats.actionUsage || {};
    attacker.stats.actionUsage[action.name] = (attacker.stats.actionUsage[action.name] || 0) + 1;
  }

  const saveMod = getEffectiveSaveModifier(target, ability, state);
  const hasMR = hasActiveTrait(target, 'Magic Resistance');
  const save = rollSaveWithBuffs(target, saveMod, hasMR, dc, ability, conditionOnFail);
  let passed = save.total >= dc;

  if (!passed) {
    const countercharm = tryCountercharm(state, target, conditionOnFail, saveMod, dc, ability);
    if (countercharm) {
      save.total = countercharm.total;
      passed = countercharm.passed;
    }
  }

  if (!passed && hasResource(target, 'legendary-resistance')) {
    consumeResource(target, 'legendary-resistance');
    passed = true;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Legendary Resistance',
      details: `${target.displayName} uses Legendary Resistance to succeed the save!`,
      type: 'special'
    });
  }

  state.events.push({ kind: 'save', targetId: target.id, success: passed, durationMs: BASE_DURATIONS.save });

  const effectiveDamageOnFail = target.currentHp < target.maxHp ? (damageOnFailIfTargetWounded ?? damageOnFail) : damageOnFail;
  if (effectiveDamageOnFail) {
    const dmgType = action.damageType || inferDamageType(action.description) || 'untyped';
    const immune = isImmuneToDamageType(target, dmgType);
    if (immune) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Immune',
        details: `${target.displayName} is immune to ${dmgType} damage!`,
        type: 'info'
      });
      return;
    }

    let dmg: number;
    if (passed && damageOnSuccess === 'half') {
      dmg = Math.floor(rollDice(effectiveDamageOnFail).total / 2);
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Save',
        details: `${target.displayName} saves! (${save.total} vs DC ${dc}) Takes ${dmg} ${dmgType} damage (half).`,
        damage: dmg, type: 'save'
      });
    } else if (passed) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Save',
        details: `${target.displayName} saves! (${save.total} vs DC ${dc})`,
        type: 'save'
      });
      if (action.buffOnSuccessfulSave) applySaveBuff(state, attacker, target, action, action.buffOnSuccessfulSave);
      return;
    } else {
      dmg = rollDice(effectiveDamageOnFail).total;
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Failed Save',
        details: `${target.displayName} fails! (${save.total} vs DC ${dc}) Takes ${dmg} ${dmgType} damage!`,
        damage: dmg, type: 'damage'
      });
    }
    const hpBefore = target.currentHp;
    // Save-based single-target damage (rays, single-target spells): magical.
    const appliedDamage = applyDamage(state, target, dmg, dmgType, attacker, false, true);
    const hpAfter = target.currentHp;
    state.events.push({ kind: 'hit', targetId: target.id, damage: dmg, damageType: dmgType, critical: false, targetHpBefore: hpBefore, targetHpAfter: hpAfter, durationMs: BASE_DURATIONS.hit });
    const damageSummary = emptyDamageSummary();
    addDamageToSummary(damageSummary, appliedDamage, dmgType);
    applyActionRuntimeEffects(state, attacker, target, action, damageSummary, { savePassed: passed });
  } else if (!passed) {
    // Pure condition effect (no damage), e.g. Charm Ray, Paralyzing Ray
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Failed Save',
      details: `${target.displayName} fails the save! (${save.total} vs DC ${dc})`,
      type: 'save'
    });
  } else {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Save',
      details: `${target.displayName} resists ${action.name}! (${save.total} vs DC ${dc})`,
      type: 'save'
    });
  }

  if (!passed && conditionOnFail && conditionTargetMatchesActionSize(action, target)) {
    applyCondition(state, target, conditionOnFail, attacker,
      conditionDuration || 'end_of_next_turn', dc, ability);
    for (const condition of additionalConditionsOnFail ?? []) applyCondition(state, target, condition, attacker, conditionDuration || 'end_of_next_turn', dc, ability);
  }

  if (!passed && !effectiveDamageOnFail) {
    applyActionRuntimeEffects(state, attacker, target, action, emptyDamageSummary());
  }

  if (!passed && action.conditionOnHit) {
    resolveConditionOnHit(state, attacker, target, action);
  }
  if (!passed) {
    if (action.buffOnFailedSave) applySaveBuff(state, attacker, target, action, action.buffOnFailedSave);
    if (action.pushOnFailedSave) pushTargetAwayFromCaster(state, attacker, target, action.pushOnFailedSave);
    if (action.fleeOnFailedSave) fleeFromCaster(state, attacker, target, action.name);
  } else if (action.buffOnSuccessfulSave) {
    applySaveBuff(state, attacker, target, action, action.buffOnSuccessfulSave);
  }
}

// ─────────────────────────────────────────────────────────────────────
// AoE event emission + resolution
// ─────────────────────────────────────────────────────────────────────

/** Push an AoE animation event onto the state's event queue. */
function emitAoEEvent(
  state: BattleState, attacker: Creature, area: string | undefined,
  center: { x: number; y: number } | undefined,
  direction: { x: number; y: number } | undefined,
  targets: Creature[], spellName: string,
): void {
  const { radius, shape } = parseAoEShape(area);
  let dir = direction;
  if (!dir && (shape === 'cone' || shape === 'line') && targets.length > 0) {
    dir = {
      x: targets.reduce((s, t) => s + t.position.x, 0) / targets.length,
      y: targets.reduce((s, t) => s + t.position.y, 0) / targets.length,
    };
  }
  state.events.push({
    kind: 'aoe', attackerId: attacker.id,
    center: center ? { ...center } : { ...attacker.position },
    radius, shape,
    direction: dir ? { ...dir } : undefined,
    durationMs: BASE_DURATIONS.aoe,
    spellName,
  });
}

function groupSimultaneousDeaths(events: AnimationEvent[]): AnimationEvent[] {
  const creatureIds = events.flatMap(event =>
    event.kind === 'death' ? [event.creatureId] : []
  );
  if (creatureIds.length < 2) return events;

  const grouped: AnimationEvent[] = [];
  let inserted = false;
  for (const event of events) {
    if (event.kind === 'death') {
      if (!inserted) {
        grouped.push({
          kind: 'deaths',
          creatureIds,
          durationMs: BASE_DURATIONS.deaths,
        });
        inserted = true;
      }
      continue;
    }
    grouped.push(event);
  }
  return grouped;
}

function groupSimultaneousConditions(events: AnimationEvent[]): AnimationEvent[] {
  const conditions = events.flatMap(event =>
    event.kind === 'condition'
      ? [{ creatureId: event.creatureId, condition: event.condition, applied: event.applied }]
      : []
  );
  if (conditions.length < 2) return events;

  const grouped: AnimationEvent[] = [];
  let inserted = false;
  for (const event of events) {
    if (event.kind === 'condition') {
      if (!inserted) {
        grouped.push({
          kind: 'conditionBatch',
          conditions,
          durationMs: BASE_DURATIONS.conditionBatch,
        });
        inserted = true;
      }
      continue;
    }
    grouped.push(event);
  }
  return grouped;
}

export function resolveAoE(
  state: BattleState,
  attacker: Creature,
  action: MonsterAction,
  targets: Creature[],
  center?: { x: number; y: number },
  direction?: { x: number; y: number },
  spellcastingAlreadyAccounted = false,
): void {
  if (!action.savingThrow) return;

  const { ability, damageOnFail, damageOnFailIfTargetWounded, damageOnSuccess, area, hpPoolDice } = action.savingThrow;
  const automaticDamage = action.persistentAura?.automaticDamage === true;
  const dc = action.savingThrow.dc + getSpellSaveDcBonus(attacker, action);

  // HP-pool spells (2024 Sleep)
  if (hpPoolDice) {
    const poolRoll = rollDice(hpPoolDice);
    let pool = poolRoll.total;

    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: attacker.displayName, action: action.name,
      details: `${attacker.displayName} casts ${action.name}! (${area || ''}, ${hpPoolDice} HP pool = ${pool})`,
      type: 'special'
    });
    emitAoEEvent(state, attacker, area, center, direction, targets, action.name);

    const sorted = [...targets]
      .filter(t => t.isAlive)
      .sort((a, b) => a.currentHp - b.currentHp);

    for (const target of sorted) {
      if (target.currentHp > pool) {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: target.displayName, action: action.name,
          details: `${target.displayName} (${target.currentHp} HP) exceeds the remaining pool (${pool}) and is unaffected.`,
          type: 'special'
        });
        break;
      }
      pool -= target.currentHp;
      applyCondition(state, target, action.savingThrow.conditionOnFail ?? 'unconscious', attacker,
        action.savingThrow.conditionDuration ?? '1_minute', 0, ability);
    }
    return;
  }

  // Standard saving-throw AoE
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: action.name,
    details: automaticDamage ? `${attacker.displayName} uses ${action.name}! (${area || ''}, no save)` : `${attacker.displayName} uses ${action.name}! (${area || ''}, DC ${dc} ${ability.toUpperCase()} save)`,
    type: 'special'
  });
  emitAoEEvent(state, attacker, area, center, direction, targets, action.name);
  // actionUsage tracked by executeSpell for spellcasting calls; for monster
  // breath weapons / legendary AoEs called directly, track here.
  if (!attacker.monsterData.isHero && !spellcastingAlreadyAccounted) {
    attacker.stats.actionUsage[action.name] = (attacker.stats.actionUsage[action.name] || 0) + 1;
  }
  // Monster innate spell with a per-day counter (Mage Fireball 2/Day,
  // Cone of Cold 1/Day). Hero spells consume their resource via
  // executeSpell; the AoE path is reached when an AI-picked monster
  // breath/spell has savingThrow.area, so consume here too.
  if (action.resourceCost && !spellcastingAlreadyAccounted) {
    consumeResource(attacker, action.resourceCost.key, action.resourceCost.amount);
  }

  const { conditionOnFail, conditionDuration } = action.savingThrow;
  const aoeDamageTargets: AoEDamageTarget[] = [];
  const followUpEvents: AnimationEvent[] = [];
  let overchannelDamage: number | null | undefined;
  const rollSpellDamage = (damageExpression: string): number => {
    if (overchannelDamage === undefined) {
      overchannelDamage = tryConsumeWizardOverchannel(state, attacker, action, damageExpression);
    }
    return overchannelDamage ?? rollDice(damageExpression).total;
  };

  for (const target of targets) {
    if (!target.isAlive) continue;
    if (action.targetScope !== 'area_enemies' && !passesSanctuary(state, attacker, target)) continue;
    if (hasTotalCoverFromContainer(target, attacker)) {
      logTotalCoverFromContainer(state, attacker, target, action.name);
      continue;
    }

    const saveMod = getEffectiveSaveModifier(target, ability, state);

    const hasMR = hasActiveTrait(target, 'Magic Resistance');
    const save = automaticDamage ? { total: Number.NEGATIVE_INFINITY } : rollSaveWithBuffs(target, saveMod, hasMR, dc, ability, conditionOnFail);
    let passed = !automaticDamage && save.total >= dc;

    if (!automaticDamage && !passed) {
      const countercharm = tryCountercharm(state, target, conditionOnFail, saveMod, dc, ability);
      if (countercharm) {
        save.total = countercharm.total;
        passed = countercharm.passed;
      }
    }

    if (!automaticDamage && !passed && hasResource(target, 'legendary-resistance')) {
      consumeResource(target, 'legendary-resistance');
      passed = true;
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Legendary Resistance',
        details: `${target.displayName} uses Legendary Resistance to succeed the save!`,
        type: 'special'
      });
    }

    const visualTarget: AoEDamageTarget = { targetId: target.id, saveSuccess: passed };

    const effectiveDamageOnFail = target.currentHp < target.maxHp ? (damageOnFailIfTargetWounded ?? damageOnFail) : damageOnFail;
    if (effectiveDamageOnFail) {
      const aoeDmgType = action.damageType || inferDamageType(action.description) || 'untyped';
      const damageParts = [
        { damage: effectiveDamageOnFail, damageType: aoeDmgType, primary: true },
        ...(action.savingThrow.extraDamageOnFail ?? []).map(part => ({ ...part, primary: false })),
      ];

      let rawDamageTotal = 0;
      let appliedDamageTotal = 0;
      // Evasion (Monk L7+, Rogue L7+): DEX save success = 0 damage, fail = half
      const hasEvasion = hasActiveTrait(target, 'Evasion');
      if (passed && damageOnSuccess === 'half' && hasEvasion && ability === 'dex') {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: target.displayName, action: 'Evasion',
          details: `${target.displayName} evades! (${save.total} vs DC ${dc}) Takes no damage!`,
          type: 'save'
        });
        aoeDamageTargets.push(visualTarget);
        continue;
      }
      const halfDamage = !automaticDamage && ((passed && damageOnSuccess === 'half') || (!passed && hasEvasion && ability === 'dex'));
      const draconicBonus = draconicElementalAffinityBonus(attacker, action, aoeDmgType);
      const evocationBonus = wizardEvocationBonus(attacker, action);
      const rolledParts = damageParts.map(part => {
        let partDamage = applyDamageRollPenalty(attacker, part.primary ? rollSpellDamage(part.damage) : rollDice(part.damage).total);
        if (part.primary) partDamage += draconicBonus + evocationBonus;
        if (halfDamage) partDamage = Math.floor(partDamage / 2);
        return { ...part, rolledDamage: partDamage };
      });
      rawDamageTotal = rolledParts.reduce((sum, part) => sum + part.rolledDamage, 0);

      if (passed && damageOnSuccess === 'half') {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: target.displayName, action: 'Save',
          details: `${target.displayName} saves! (${save.total} vs DC ${dc}) Takes ${rawDamageTotal} damage (half).`,
          damage: rawDamageTotal,
          type: 'save'
        });
      } else if (passed) {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: target.displayName, action: 'Save',
          details: `${target.displayName} saves! (${save.total} vs DC ${dc}) Takes no damage.`,
          type: 'save'
        });
        if (action.buffOnSuccessfulSave) {
          const emittedStart = state.events.length;
          applySaveBuff(state, attacker, target, action, action.buffOnSuccessfulSave);
          followUpEvents.push(...state.events.splice(emittedStart));
        }
        aoeDamageTargets.push(visualTarget);
        continue;
      } else {
        if (draconicBonus > 0) {
          attacker.stats.actionUsage['Elemental Affinity'] = (attacker.stats.actionUsage['Elemental Affinity'] || 0) + 1;
          pushLog(state, {
            round: state.round,
            turn: state.turnIndex,
            actor: attacker.displayName,
            action: 'Elemental Affinity',
            details: `${attacker.displayName}'s fire affinity adds ${draconicBonus} fire damage.`,
            damage: draconicBonus,
            type: 'damage',
          });
        }
        // Evasion on fail: half damage instead of full (DEX saves only)
        if (!automaticDamage && hasEvasion && ability === 'dex') {
          pushLog(state, {
            round: state.round, turn: state.turnIndex,
            actor: target.displayName, action: 'Evasion (partial)',
            details: `${target.displayName} partially evades! (${save.total} vs DC ${dc}) Takes ${rawDamageTotal} damage (half via Evasion).`,
            damage: rawDamageTotal,
            type: 'damage'
          });
        } else if (automaticDamage) {
          pushLog(state, {
            round: state.round, turn: state.turnIndex,
            actor: target.displayName, action: action.name,
            details: `${target.displayName} takes ${rawDamageTotal} ${aoeDmgType} damage!`,
            damage: rawDamageTotal,
            type: 'damage'
          });
        } else {
          pushLog(state, {
            round: state.round, turn: state.turnIndex,
            actor: target.displayName, action: 'Failed Save',
            details: `${target.displayName} fails the save! (${save.total} vs DC ${dc}) Takes ${rawDamageTotal} damage!`,
            damage: rawDamageTotal,
            type: 'damage'
          });
        }
      }

      // AoE damage from spells, breath weapons, etc. Treat as magical for
      // resistance bypass - the typical AoE source is a spell or supernatural
      // ability. Specific non-magical AoEs (rare in 5e) can opt out via
      // action.magical = false explicitly if they're authored without it set.
      const hpBefore = target.currentHp;
      const damageSummary = emptyDamageSummary();
      for (const part of rolledParts) {
        if (!target.isAlive || part.rolledDamage <= 0) continue;
        const emittedStart = state.events.length;
        const appliedDamage = applyDamage(state, target, part.rolledDamage, part.damageType, attacker, false, action.magical ?? true);
        addDamageToSummary(damageSummary, appliedDamage, part.damageType);
        appliedDamageTotal += appliedDamage;
        followUpEvents.push(...state.events.splice(emittedStart));
      }
      applyActionRuntimeEffects(state, attacker, target, action, damageSummary, { savePassed: passed });
      if (!target.isAlive) target.stats.killedByAction = action.name;
      visualTarget.damage = appliedDamageTotal;
      visualTarget.damageType = damageParts.length > 1 ? 'mixed' : aoeDmgType;
      visualTarget.critical = false;
      visualTarget.targetHpBefore = hpBefore;
      visualTarget.targetHpAfter = target.currentHp;
    } else if (passed) {
      // No damage - condition-only AoE (e.g., Horrifying Visage). Save passed = no effect.
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Save',
        details: `${target.displayName} saves! (${save.total} vs DC ${dc})`,
        type: 'save'
      });
      aoeDamageTargets.push(visualTarget);
      continue;
    } else if (!effectiveDamageOnFail) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Failed Save',
        details: `${target.displayName} fails the save! (${save.total} vs DC ${dc})`,
        type: 'save'
      });
    }

    if (!passed && conditionOnFail && target.isAlive && conditionTargetMatchesActionSize(action, target)) {
      const { secondFailureCondition, secondFailureDuration } = action.savingThrow;
      const stageInfo = secondFailureCondition
        ? { stages: [conditionOnFail, secondFailureCondition], currentIndex: 0, finalDuration: secondFailureDuration }
        : undefined;
      const emittedStart = state.events.length;
      applyCondition(state, target, conditionOnFail, attacker, conditionDuration || 'end_of_next_turn', dc, ability, stageInfo);
      for (const condition of action.savingThrow.additionalConditionsOnFail ?? []) applyCondition(state, target, condition, attacker, conditionDuration || 'end_of_next_turn', dc, ability);
      followUpEvents.push(...state.events.splice(emittedStart));
    }

    if (!passed && !effectiveDamageOnFail) {
      const emittedStart = state.events.length;
      applyActionRuntimeEffects(state, attacker, target, action, emptyDamageSummary());
      followUpEvents.push(...state.events.splice(emittedStart));
    }

    if (!passed) {
      const emittedStart = state.events.length;
      if (action.buffOnFailedSave) applySaveBuff(state, attacker, target, action, action.buffOnFailedSave);
      if (action.pushOnFailedSave) pushTargetAwayFromCaster(state, attacker, target, action.pushOnFailedSave);
      if (action.fleeOnFailedSave) fleeFromCaster(state, attacker, target, action.name);
      followUpEvents.push(...state.events.splice(emittedStart));
    } else if (action.buffOnSuccessfulSave) {
      const emittedStart = state.events.length;
      applySaveBuff(state, attacker, target, action, action.buffOnSuccessfulSave);
      followUpEvents.push(...state.events.splice(emittedStart));
    }

    aoeDamageTargets.push(visualTarget);
  }

  if (aoeDamageTargets.length > 0) {
    state.events.push({
      kind: 'aoeDamage',
      targets: aoeDamageTargets,
      durationMs: BASE_DURATIONS.aoeDamage,
    });
  }
  state.events.push(...groupSimultaneousConditions(groupSimultaneousDeaths(followUpEvents)));
}

// ─────────────────────────────────────────────────────────────────────
// Target picking
// ─────────────────────────────────────────────────────────────────────

/**
 * Pick the best direction for a directional AoE (cone or line) from the
 * attacker. Tries each enemy as a candidate direction and picks the one
 * that hits the most enemies (penalizing friendly-fire when the team
 * has the no-FF flag set).
 */
export function bestDirectionalTargets(
  state: BattleState,
  attacker: Creature,
  rangeFt: number,
  checker: (origin: { x: number; y: number }, dir: { x: number; y: number }, target: { x: number; y: number }, range: number) => boolean,
): { targets: Creature[]; direction: { x: number; y: number } } {
  const alive = getAliveCreatures(state).filter(c => c.id !== attacker.id);
  const enemies = alive.filter(c => c.team !== attacker.team);
  if (enemies.length === 0) return { targets: [], direction: { x: attacker.position.x + 1, y: attacker.position.y } };

  let best = { targets: [] as Creature[], direction: enemies[0].position, score: -Infinity };
  for (const dir of enemies) {
    const hit = alive.filter(c => checker(attacker.position, dir.position, c.position, rangeFt));
    const enemiesHit = hit.filter(c => c.team !== attacker.team).length;
    const alliesHit = hit.filter(c => c.team === attacker.team).length;
    const noFF = attacker.team === 'red'
      ? state.teamTactics?.redNoFriendlyFire
      : state.teamTactics?.blueNoFriendlyFire;
    const score = alliesHit > 0 && noFF ? -Infinity : enemiesHit - alliesHit * 3;
    if (score > best.score) {
      best = { targets: hit, direction: dir.position, score };
    }
  }
  return best;
}

/**
 * For point-and-shoot sphere / cylinder spells (Fireball within 150 ft,
 * Web within 60 ft, ...) pick the center cell that maximizes enemy hits
 * while respecting allies + no-friendly-fire. The candidates are every
 * enemy's own cell, plus a small ring of cells around enemy clusters,
 * filtered to stay within the spell's `action.range` from the caster.
 *
 * Returns { center, targets } where center is the chosen detonation
 * cell and targets are the creatures (excluding caster) caught by the
 * sphere when it explodes there.
 */
export function pickRangedSphereCenter(
  state: BattleState,
  attacker: Creature,
  action: MonsterAction,
  radiusFt: number,
): { center: { x: number; y: number }; targets: Creature[] } {
  const alive = getAliveCreatures(state);
  const enemies = alive.filter(c => c.team !== attacker.team && c.id !== attacker.id);
  const allies = alive.filter(c => c.team === attacker.team && c.id !== attacker.id);
  const maxRangeFt = (action.range?.normal ?? action.range?.long ?? 9999);
  const noFF = attacker.team === 'red'
    ? state.teamTactics?.redNoFriendlyFire
    : state.teamTactics?.blueNoFriendlyFire;
  const dt = (action.damageType || '').toLowerCase();
  const isImmune = (c: Creature) =>
    !!dt && (c.monsterData.immunities || []).some(i => dt.includes(i.toLowerCase()));

  const candidates: { x: number; y: number }[] = enemies.map(e => ({ ...e.position }));
  // Also try cells offset by half the radius so the sphere can catch
  // two clustered enemies that an enemy-cell origin would miss.
  const r = Math.max(1, Math.floor(radiusFt / 5));
  for (const e of enemies) {
    for (const dx of [-r, 0, r]) for (const dy of [-r, 0, r]) {
      if (dx === 0 && dy === 0) continue;
      candidates.push({ x: e.position.x + dx, y: e.position.y + dy });
    }
  }

  let best = { center: enemies[0]?.position ?? attacker.position, targets: [] as Creature[], score: -Infinity };
  for (const center of candidates) {
    // Caster reach to the center
    const dxC = Math.abs(center.x - attacker.position.x);
    const dyC = Math.abs(center.y - attacker.position.y);
    if (Math.max(dxC, dyC) * 5 > maxRangeFt) continue;
    let enemyHits = 0;
    let allyHits = 0;
    const targets: Creature[] = [];
    for (const c of [...enemies, ...allies]) {
      const dxT = Math.abs(c.position.x - center.x);
      const dyT = Math.abs(c.position.y - center.y);
      if (Math.max(dxT, dyT) * 5 > radiusFt) continue;
      targets.push(c);
      if (c.team === attacker.team) allyHits++;
      else if (!isImmune(c)) enemyHits++;
    }
    const score = (allyHits > 0 && noFF) ? -Infinity : enemyHits - allyHits * 3;
    if (score > best.score) best = { center, targets, score };
  }
  return { center: best.center, targets: best.targets };
}

/** Determine targets for an AoE based on area description and attacker position. */
export function getAoETargets(
  state: BattleState,
  attacker: Creature,
  action: MonsterAction,
  _preferEnemies: boolean = true
): Creature[] {
  if (!action.savingThrow?.area) return getEnemies(state, attacker);

  const area = action.savingThrow.area.toLowerCase();
  const alive = getAliveCreatures(state);

  const rangeMatch = area.match(/(\d+)-foot/);
  const range = rangeMatch ? parseInt(rangeMatch[1]) : 30;

  if (area.includes('cone')) {
    return bestDirectionalTargets(state, attacker, range, isInCone).targets;
  }

  if (area.includes('line')) {
    return bestDirectionalTargets(state, attacker, range, isInLine).targets;
  }

  // Emanation = self-centered. Fireball-style sphere/cylinder with an
  // action.range = picks an optimal point within range and enumerates
  // creatures around it (including the caster's allies).
  if (area.includes('emanation')) {
    return alive.filter(c =>
      c.id !== attacker.id &&
      creatureDistance(c, attacker) <= range
    );
  }

  if (area.includes('radius') || area.includes('sphere') || area.includes('cylinder')) {
    if (action.range) {
      return pickRangedSphereCenter(state, attacker, action, range).targets;
    }
    return alive.filter(c =>
      c.id !== attacker.id &&
      creatureDistance(c, attacker) <= range
    );
  }

  return getEnemies(state, attacker).filter(c =>
    creatureDistance(c, attacker) <= range
  );
}
