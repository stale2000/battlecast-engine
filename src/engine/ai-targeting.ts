/**
 * AI targeting + damage estimation cluster.
 *
 * The "who do I attack and how good is my hit?" layer that sits below
 * spellcasting and turn orchestration. Two responsibilities:
 *
 *   1. Target selection. Given a creature and a strategy
 *      (nearest/weakest/strongest/smart), pick the best enemy. LoS
 *      filtering for ranged-capable creatures is built in so a
 *      bow-wielder doesn't keep targeting an enemy hidden behind a wall.
 *
 *   2. Damage estimation. A single shared `estimateDamage(action, opts)`
 *      core powers both attack-action ranking (`estimateActionDamage`,
 *      target-resistance-aware, 0.65 save-for-half multiplier) and
 *      spell-picker ranking (`estimateSpellDamage`, no resistance
 *      adjustment, full damage on saves, condition-rider value
 *      included). Two thin wrappers expose those configurations under
 *      stable names.
 *
 * Plus three small helpers used widely across the AI:
 *   - `shouldPreferRanged` - movement-time decision (kept here because
 *     it consults the same action-list helpers as targeting).
 *   - `shouldUseAoE` - pre-multiattack check that gates breath-style
 *     specials.
 *   - `shouldRetreat` - HP-threshold heuristic for low-HP intelligent
 *     creatures.
 *
 * Design boundary: this file is "what" decisions (who, how strong),
 * not "when" or "how to execute". The actual cast/attack happens in
 * ai-spellcasting.ts and ai.ts (executeTurn). This file pulls
 * pure-engine helpers from combat.ts and dice.ts but never resolves
 * dice itself.
 */

import { Creature, MonsterAction } from '../types/monster.js';
import {
  BattleState, creatureDistance, getFootprintSize, isPositionBlocked,
  getEnemies, getAliveCreatures, getAoETargets,
  isInCone, isInLine,
  getActiveSize, getActiveSpeed,
} from './combat.js';
import { abilityModifier, averageDamage } from './dice.js';
import { canSeeCreatureIgnoringHide } from './visibility.js';

// ─────────────────────────────────────────────────────────────────────
// Action list helpers - used by targeting, spellcasting, and turn
// orchestration. Wild-shaped Druids fight as the beast, so we route
// through `getActiveActions` to pick the right action set.
// ─────────────────────────────────────────────────────────────────────

export function getActiveActions(creature: Creature): MonsterAction[] {
  const base = creature.wildShape ? creature.wildShape.actions : creature.monsterData.actions;
  const granted = creature.wildShape ? [] : creature.activeBuffs.flatMap(buff => buff.grantsAction ? [buff.grantsAction] : []);
  const actions = granted.length ? [...base, ...granted] : base;
  if (!creature.swallowedTargetId) return actions;
  if (!actions.some(a => a.name === 'Swallow')) return actions;
  return actions.filter(a => a.name !== 'Bite');
}

export function getSpecialActions(creature: Creature): MonsterAction[] {
  return getActiveActions(creature).filter(a =>
    !a.legendaryOnly && a.type === 'special' && a.savingThrow
  );
}

export function getMultiattack(creature: Creature): MonsterAction | undefined {
  return getActiveActions(creature).find(a => !a.legendaryOnly && a.type === 'multiattack');
}

export function getMeleeActions(creature: Creature): MonsterAction[] {
  return getActiveActions(creature).filter(a =>
    !a.legendaryOnly && a.type === 'melee' && a.attackBonus !== undefined
  );
}

export function getRangedActions(creature: Creature): MonsterAction[] {
  return getActiveActions(creature).filter(a => !a.legendaryOnly).flatMap(a => {
    if (a.attackBonus === undefined) return [];
    if (a.type === 'ranged') return [a];
    if (canRepeatMeleeOrRangedAtRange(a)) {
      return [{ ...a, type: 'ranged' as const }];
    }
    return [];
  });
}

export function canRepeatMeleeOrRangedAtRange(action: MonsterAction): boolean {
  if (action.type !== 'melee' || !action.range) return false;
  const description = action.description.toLowerCase();
  return action.damageType === 'force' || description.includes('magically returns');
}

// ─────────────────────────────────────────────────────────────────────
// Movement-time preference: ranged vs melee
// ─────────────────────────────────────────────────────────────────────

/**
 * Hit-chance-adjusted expected damage of an attack-roll action against
 * a generic AC. Includes base damage dice + additionalDamage rider +
 * a hit-rate multiplier derived from the action's attackBonus vs the
 * supplied AC guess.
 *
 * The hit-rate term is the missing piece in raw `averageDamage` that
 * caused frontline melee creatures (e.g. 2024 Knight: Greatsword +5
 * vs. Heavy Crossbow +2) to be misclassified as "prefer ranged."
 * The +5 vs +2 swing is a 15-percentage-point hit gap, dwarfing the
 * marginal raw-damage difference between the weapons.
 *
 * AC 14 default approximates a typical 5e enemy in the CR 1-5 band.
 * Refining this per-target is possible but adds complexity; for the
 * movement decision (which has to be stable across the turn anyway)
 * a single midpoint is good enough.
 */
export function expectedHitDamage(action: MonsterAction, acGuess: number = 14): number {
  const base = averageDamage(action.damage || '0');
  let rider = 0;
  if (action.additionalDamage) {
    // additionalDamage looks like "1d8 radiant" - take the dice expression.
    const dicePart = action.additionalDamage.split(' ')[0];
    rider = averageDamage(dicePart);
  }
  const toHit = action.attackBonus ?? 0;
  // d20 roll needs (acGuess - toHit) or higher. Hit rate = (21 - target) / 20.
  // Clamp to [0.05, 0.95] for nat-1 / nat-20 invariants.
  const hitRate = Math.max(0.05, Math.min(0.95, (21 - (acGuess - toHit)) / 20));
  return (base + rider) * hitRate;
}

/**
 * Decides whether a creature's movement AI should treat it as a ranged
 * fighter - i.e. stop at ranged normal range instead of charging to melee.
 *
 * Rule:
 *  - No ranged actions → false.
 *  - Barbarian → false (rage requires melee).
 *  - Rogue → true (sneak attack from bow, kite with Cunning Action).
 *  - No melee actions → true (pure ranged).
 *  - Otherwise → true if best ranged action's hit-adjusted expected
 *    damage is at least as high as the best melee action's. Includes
 *    additionalDamage riders and the to-hit delta (Greatsword +5
 *    vs. Heavy Crossbow +2 makes melee much higher EV against typical
 *    targets). Ties go to ranged - shooting from safety is worth a
 *    marginal EV loss.
 *
 * Comparison uses a generic AC 14 target. Stable across the turn so
 * the movement decision doesn't oscillate as the actual target's AC
 * changes within multiattack.
 */
export function shouldPreferRanged(
  meleeActions: MonsterAction[],
  rangedActions: MonsterAction[],
  heroClass?: string,
): boolean {
  if (rangedActions.length === 0) return false;
  if (heroClass === 'Barbarian') return false;
  if (heroClass === 'Rogue') return true;
  if (meleeActions.length === 0) return true;
  const rangedExpected = Math.max(...rangedActions.map(a => expectedHitDamage(a)));
  const meleeExpected = Math.max(...meleeActions.map(a => expectedHitDamage(a)));
  if (meleeExpected === 0) return true;
  return rangedExpected >= meleeExpected;
}

// ─────────────────────────────────────────────────────────────────────
// Damage estimation
// ─────────────────────────────────────────────────────────────────────

/**
 * Heuristic value of a damage-on-fail / condition-on-fail spell when
 * scoring its expected impact. Expressed in "HP-equivalent" units so
 * a Hold Person ranks roughly alongside a 15-damage spell. These are
 * eyeballed, not derived from any sim.
 */
const CONDITION_VALUES: Partial<Record<string, number>> = {
  incapacitated: 12, paralyzed: 15, stunned: 15, unconscious: 15,
  restrained: 8, frightened: 6, prone: 3, grappled: 4, poisoned: 3,
  blinded: 5, charmed: 8, petrified: 20,
};

function targetAlreadyIgnoresCondition(target: Creature | undefined, condition: string): boolean {
  if (!target) return false;
  const normalized = condition.toLowerCase();
  return target.conditions.some(c => c.toLowerCase() === normalized) ||
    (target.monsterData.conditionImmunities ?? []).some(c => c.toLowerCase() === normalized);
}

export interface DamageEstimateOptions {
  /** When set, reduce damage by the target's resistance/immunity/vulnerability. */
  target?: Creature;
  /** Multiplier on save-for-half damage. 0.65 = expected-value of a
   *  damage-on-fail / half-on-success save. Spell pickers use 1 because
   *  they compare spells whose base damage is already "full hit" value. */
  saveForHalfMultiplier?: number;
  /** Include the heuristic "condition prevented" value so debuff spells
   *  rank alongside damage spells in the spell picker. Attack-action
   *  ranking leaves this off so weapon choice stays damage-only. */
  includeConditionRider?: boolean;
}

/**
 * Expected damage from an action this turn. Common core for both
 * attack-action ranking and spell-picker ranking. See DamageEstimateOptions
 * for the knobs that separate the two call sites.
 */
export function estimateDamage(action: MonsterAction, opts: DamageEstimateOptions = {}): number {
  const { target, saveForHalfMultiplier = 0.65, includeConditionRider = false } = opts;
  let dmg = 0;
  if (action.autoDarts && action.autoDartDamage) {
    dmg = action.autoDarts * averageDamage(action.autoDartDamage);
  } else if (action.damage) {
    dmg = averageDamage(action.damage);
    if (action.multiTargetAttack) dmg *= action.multiTargetAttack.count;
    if (action.additionalDamage) {
      const parts = action.additionalDamage.split(' ');
      dmg += averageDamage(parts[0]);
    }
  } else if (action.savingThrow?.damageOnFail) {
    const mainType = action.damageType || '';
    const parts = [
      { damage: action.savingThrow.damageOnFail, damageType: mainType },
      ...(action.savingThrow.extraDamageOnFail ?? []),
    ];
    dmg = parts.reduce((sum, part) => {
      const partDamage = averageDamage(part.damage) * saveForHalfMultiplier;
      return sum + (target ? adjustForResistance(partDamage, part.damageType, target) : partDamage);
    }, 0);
  } else if (action.powerWord?.kind === 'kill') {
    const threshold = action.powerWord.killThresholdHp ?? 100;
    dmg = target && target.currentHp <= threshold
      ? target.currentHp + target.maxHp
      : averageDamage(action.powerWord.fallbackDamage ?? '12d12');
  }
  if (target && dmg > 0 && !action.savingThrow?.extraDamageOnFail?.length) {
    dmg = adjustForResistance(dmg, action.damageType || '', target);
  }
  if (includeConditionRider) {
    const cond = action.savingThrow?.conditionOnFail ?? action.conditionOnHit?.condition;
    if (cond && !targetAlreadyIgnoresCondition(target, cond)) {
      dmg += CONDITION_VALUES[cond] ?? 3;
    }
  }
  return dmg;
}

export function estimateSpellDamage(action: MonsterAction): number {
  // Spell picker: no target-resistance (decision is made before a target
  // is locked), use full damage on saves (spell already discounts
  // save-for-half in its base numbers), and include condition riders
  // so debuff spells rank alongside damage.
  return estimateDamage(action, { saveForHalfMultiplier: 1, includeConditionRider: true });
}

export function estimateActionDamage(action: MonsterAction, target?: Creature): number {
  // Attack-action ranking: target-resistance-aware, 0.65 save-for-half
  // expected value for breath-style actions, no condition rider
  // (weapon choice is damage-only).
  return estimateDamage(action, { target });
}

const DAMAGE_TYPE_PATTERN = /\b(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\b/i;

export function inferSpellDamageType(spell: MonsterAction): string | undefined {
  if (spell.damageType) return spell.damageType;
  const m = spell.description.match(DAMAGE_TYPE_PATTERN);
  return m ? m[1].toLowerCase() : undefined;
}

export function adjustForResistance(dmg: number, damageType: string, target: Creature): number {
  if (!damageType || damageType === 'untyped') return dmg;
  const dt = damageType.toLowerCase();
  const immunities = target.monsterData.immunities || [];
  if (immunities.some(i => dt.includes(i.toLowerCase()))) return 0;
  const resistances = target.monsterData.resistances || [];
  if (resistances.some(r => dt.includes(r.toLowerCase()))) return Math.floor(dmg / 2);
  const vulnerabilities = target.monsterData.vulnerabilities || [];
  if (vulnerabilities.some(v => dt.includes(v.toLowerCase()))) return dmg * 2;
  return dmg;
}

// ─────────────────────────────────────────────────────────────────────
// Target selection
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns true if the attacker can see the target through the active
 * map's walls. Chasms never block sight. Returns true unconditionally
 * when there's no terrain data - pre-terrain behavior.
 */
export function canSee(state: BattleState, attacker: Creature, target: Creature): boolean {
  if (target.activeBuffs?.some(buff => buff.key === `hidden-from:${attacker.id}`)
    && !target.activeBuffs.some(buff => buff.suppressInvisibilityForCasterId === attacker.id)) return false;
  return canSeeCreatureIgnoringHide(state, attacker, target);
}

export function selectTarget(state: BattleState, creature: Creature, strategy: 'nearest' | 'weakest' | 'strongest' | 'smart'): Creature | null {
  let enemies = getEnemies(state, creature);
  if (enemies.length === 0) return null;

  // Dying-enemy handling. Default: deprioritise dying enemies (a downed
  // hero contributes nothing to the fight, finishing them off is a wasted
  // turn versus engaging a standing threat). The team's `finishDowned`
  // tactic toggle flips this: when true, dying enemies stay in the pool
  // and the strategy below picks them up naturally - smart-tactic AIs
  // gravitate to the lowest-HP target (which is the 0-HP dying hero),
  // nearest-tactic AIs swing at whoever's adjacent. Brutal-but-realistic
  // option for DMs who want to model enemies actually finishing PCs off.
  const finishDowned = creature.team === 'red'
    ? state.teamTactics?.redFinishDowned
    : state.teamTactics?.blueFinishDowned;
  if (!finishDowned) {
    const standing = enemies.filter(e => !e.dying);
    if (standing.length > 0) enemies = standing;
  }

  // LoS filter: if this creature has ANY ranged actions, prefer targets
  // it can actually see. Walls shouldn't make a ranged attacker slam
  // into the same hidden enemy every round. Falls back to the full
  // enemy list when nothing is visible - otherwise the creature freezes.
  // Melee-first creatures ignore LoS because they'll close to reach anyway.
  const hasRanged = getRangedActions(creature).length > 0;
  if (hasRanged) {
    const visible = enemies.filter(e => canSee(state, creature, e));
    if (visible.length > 0) enemies = visible;
  }

  switch (strategy) {
    case 'nearest':
      return enemies.reduce((closest, e) =>
        creatureDistance(creature, e) < creatureDistance(creature, closest) ? e : closest
      );

    case 'weakest':
      return enemies.reduce((weakest, e) =>
        e.currentHp < weakest.currentHp ? e : weakest
      );

    case 'strongest':
      return enemies.reduce((strongest, e) =>
        e.currentHp > strongest.currentHp ? e : strongest
      );

    case 'smart': {
      // Intelligent monsters focus fire on low-HP targets that are reachable
      const intMod = abilityModifier(creature.monsterData.abilities.int);

      if (intMod >= 2) {
        // Smart: target lowest HP% enemy that's reasonably close
        return enemies.reduce((best, e) => {
          const eHpPct = e.currentHp / e.maxHp;
          const bestHpPct = best.currentHp / best.maxHp;
          const eDist = creatureDistance(creature, e);
          const bestDist = creatureDistance(creature, best);

          // If enemy is much closer, prefer it (unless other is nearly dead)
          if (eDist < bestDist * 0.5 && eHpPct > 0.1) return e;
          if (eHpPct < bestHpPct) return e;
          return best;
        });
      }

      if (intMod >= 0) {
        // Average intelligence: mix of nearest and weakest
        const nearest = enemies.reduce((n, e) =>
          creatureDistance(creature, e) < creatureDistance(creature, n) ? e : n
        );
        const weakest = enemies.reduce((w, e) =>
          e.currentHp < w.currentHp ? e : w
        );

        // If weakest is reachable this turn, go for it
        if (creatureDistance(creature, weakest) <= creature.movementRemaining + 10) {
          return weakest;
        }
        return nearest;
      }

      // Dumb creatures (Int < 10): just attack nearest
      return enemies.reduce((n, e) =>
        creatureDistance(creature, e) < creatureDistance(creature, n) ? e : n
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// AoE / retreat heuristics
// ─────────────────────────────────────────────────────────────────────

/**
 * Pre-multiattack check: should this creature fire its breath-style
 * special action right now? The rule of thumb is "two or more enemies
 * in the cone, after immunities filter out fire-immune targets etc."
 */
export function shouldUseAoE(state: BattleState, creature: Creature, action: MonsterAction): boolean {
  if (!action.savingThrow?.area) return false;

  const targets = getAoETargets(state, creature, action);
  const dt = (action.damageType || '').toLowerCase();
  const enemyTargets = targets.filter(t => {
    if (t.team === creature.team) return false;
    if (dt && t.monsterData.immunities?.some(i => dt.includes(i.toLowerCase()))) return false;
    return true;
  });

  if (enemyTargets.length >= 2) return true;

  // Single-target case: an AoE is still worth firing if its control
  // payload outvalues a basic attack. The cleanest marker is a
  // cascading-save effect (Sleep Breath, Paralyzing Breath) where the
  // second failure inflicts a long-duration disabling condition.
  if (enemyTargets.length >= 1 && action.savingThrow?.secondFailureCondition) {
    return true;
  }

  // Single-target case: high-impact runtime-effect specials are often
  // the creature's signature move, not just "damage in an area".
  // Examples: Gelatinous Cube Engulf, Vrock Spores on a lone frontliner,
  // and similar containment / ongoing-effect riders. If the action has
  // a structured effect payload, let the monster show that mechanic even
  // when only one enemy is currently in the area.
  const hasRuntimeEffectPayload = action.effects?.some(effect =>
    effect.kind === 'container' ||
    effect.kind === 'ongoingDamage' ||
    effect.kind === 'blocksHealing' ||
    effect.kind === 'hpMaxReduction' ||
    effect.kind === 'abilityScoreDrain'
  );
  if (enemyTargets.length >= 1 && hasRuntimeEffectPayload) {
    return true;
  }

  // Single-target case: spell-like monster AoEs should fire when the
  // opportunity is there. Limited per-day spells are better used than
  // left expired, and at-will spellcasters such as the Lich should look
  // like spellcasters even in 1v1 fights.
  if (enemyTargets.length >= 1 && (action.resourceCost || action.atWill)) {
    return true;
  }

  return false;
}

export interface AoEPositionResult {
  /** Best position found (caller's current position if no improvement). */
  position: { x: number; y: number };
  /** Number of unique enemy targets the AoE would hit from `position`. */
  targetCount: number;
  /**
   * For directional AoEs (cone, line) the optimal aim point. Caller
   * forwards this to resolveAoE so the cone fires the right way.
   */
  direction?: { x: number; y: number };
}

/**
 * Find the position within the creature's movement range that
 * maximizes the AoE's enemy-hit count. Used by directional AoEs
 * (cone, line) and area AoEs (sphere, cylinder) to pre-position
 * the caster before firing breath weapons.
 *
 * The user feedback this addresses: "dragons not actively trying to
 * get everyone in the cone" - the previous logic only optimized the
 * aim direction from the current position, never moved to a better
 * spot first.
 *
 * Score weighs enemy hits positively; ally hits subtract 3 each
 * (matches the bestDirectionalTargets penalty), and respects the
 * team's no-friendly-fire flag. Damage-type immunities filter out
 * enemies that wouldn't take damage anyway.
 *
 * Search is bounded - we cap at 8 squares (40 ft) of scan radius
 * around the attacker even if their movement budget is larger, since
 * the relevant positions for a 30-60 ft AoE are always close to the
 * enemy cluster, and unbounded scans get expensive in MC simulations.
 */
export function bestAoEPosition(
  state: BattleState,
  attacker: Creature,
  action: MonsterAction,
): AoEPositionResult {
  const baseline: AoEPositionResult = { position: attacker.position, targetCount: 0 };
  if (!action.savingThrow?.area) return baseline;

  const area = action.savingThrow.area.toLowerCase();
  const rangeMatch = area.match(/(\d+)-foot/);
  const range = rangeMatch ? parseInt(rangeMatch[1]) : 30;
  const isCone = area.includes('cone');
  const isLine = area.includes('line');
  const directionalChecker = isCone ? isInCone : isLine ? isInLine : null;

  const dt = (action.damageType || '').toLowerCase();
  const isImmune = (c: Creature) =>
    !!dt && (c.monsterData.immunities || []).some(i => dt.includes(i.toLowerCase()));

  // Same finishDowned guard as selectTarget: a dying enemy isn't worth
  // skewing AoE placement toward unless the team's tactic says to
  // finish downed heroes off. Otherwise we'd cluster a fireball over
  // a downed PC for "free hits" the team has already chosen to ignore.
  const finishDownedAoE = attacker.team === 'red'
    ? state.teamTactics?.redFinishDowned
    : state.teamTactics?.blueFinishDowned;
  const enemies = getAliveCreatures(state)
    .filter(c => c.team !== attacker.team && (finishDownedAoE || !c.dying));
  if (enemies.length === 0) return baseline;
  const allies = getAliveCreatures(state).filter(c => c.team === attacker.team && c.id !== attacker.id);
  const noFF = attacker.team === 'red'
    ? state.teamTactics?.redNoFriendlyFire
    : state.teamTactics?.blueNoFriendlyFire;

  const scoreAt = (pos: { x: number; y: number }): { count: number; score: number; direction?: { x: number; y: number } } => {
    if (directionalChecker) {
      // Try each enemy as the aim point and take the best.
      let best = { count: 0, score: -Infinity, direction: enemies[0].position };
      for (const dir of enemies) {
        let count = 0;
        for (const e of enemies) {
          if (isImmune(e)) continue;
          if (directionalChecker(pos, dir.position, e.position, range)) count++;
        }
        let allyHits = 0;
        for (const a of allies) {
          if (directionalChecker(pos, dir.position, a.position, range)) allyHits++;
        }
        const s = (allyHits > 0 && noFF) ? -Infinity : count - allyHits * 3;
        if (s > best.score) best = { count, score: s, direction: dir.position };
      }
      return best;
    }
    // Sphere / cylinder / emanation: chebyshev distance from position
    let count = 0;
    for (const e of enemies) {
      if (isImmune(e)) continue;
      const dx = Math.abs(e.position.x - pos.x);
      const dy = Math.abs(e.position.y - pos.y);
      if (Math.max(dx, dy) * 5 <= range) count++;
    }
    let allyHits = 0;
    for (const a of allies) {
      const dx = Math.abs(a.position.x - pos.x);
      const dy = Math.abs(a.position.y - pos.y);
      if (Math.max(dx, dy) * 5 <= range) allyHits++;
    }
    const score = (allyHits > 0 && noFF) ? -Infinity : count - allyHits * 3;
    return { count, score };
  };

  // Baseline: current-position score.
  const here = scoreAt(attacker.position);
  let best: AoEPositionResult = { position: attacker.position, targetCount: here.count, direction: here.direction };
  let bestScore = here.score;

  // Bounded scan around the attacker. Cap at 8 squares regardless of
  // movement budget - the useful positions for a 30-60 ft AoE are
  // always close to the enemy cluster, not at the far edge of an
  // 80 ft fly speed.
  const maxSquares = Math.min(8, Math.floor(attacker.movementRemaining / 5));
  if (maxSquares <= 0) return best;

  const fp = getFootprintSize(getActiveSize(attacker));
  const isFlying = (getActiveSpeed(attacker).fly ?? 0) > 0;
  const blocked = isFlying ? state.terrainSightBlocked : state.terrainBlocked;

  for (let dy = -maxSquares; dy <= maxSquares; dy++) {
    for (let dx = -maxSquares; dx <= maxSquares; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) > maxSquares) continue;
      if (dx === 0 && dy === 0) continue; // already scored as baseline
      const candidate = { x: attacker.position.x + dx, y: attacker.position.y + dy };
      if (candidate.x < 0 || candidate.y < 0) continue;
      const gs = state.gridSize ?? 20;
      if (candidate.x + fp > gs || candidate.y + fp > gs) continue;
      // isPositionBlocked excludes the attacker (so its current cell isn't a self-collision).
      if (isPositionBlocked(candidate, getActiveSize(attacker), state.creatures, attacker.id, blocked)) continue;
      const result = scoreAt(candidate);
      if (result.score > bestScore) {
        bestScore = result.score;
        best = { position: candidate, targetCount: result.count, direction: result.direction };
      }
    }
  }
  return best;
}

/**
 * HP-threshold heuristic: should this creature switch to retreat mode?
 * Only intelligent creatures retreat; the threshold tightens as INT
 * drops (smart creatures bail at 15% HP, average waits for 10%).
 */
export function shouldRetreat(creature: Creature): boolean {
  const hpPct = creature.currentHp / creature.maxHp;
  const intMod = abilityModifier(creature.monsterData.abilities.int);

  // Only intelligent creatures retreat
  if (intMod < 0) return false;

  // Low CR creatures retreat at lower HP thresholds
  if (hpPct <= 0.15 && intMod >= 1) return true;
  if (hpPct <= 0.1) return true;

  return false;
}
