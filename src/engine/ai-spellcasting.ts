/**
 * AI spellcasting decision tree.
 *
 * The single entry point is `trySpellcast(state, creature, beforeOffense)`.
 * It returns `true` if a spell or injected tactical action consumed the
 * creature's main action this turn (so the caller skips weapon attacks).
 * The priority order:
 *
 *   Step 0 (bonus action): bonus-action heals (Healing Word / Lay on
 *     Hands) and bonus-action buffs (Rage, Hex, Hunter's Mark) cast
 *     first WITHOUT consuming the main action. A stronger leveled
 *     action heal can hold first refusal when casting the bonus spell
 *     would block it.
 *
 *   Step 1 (main): emergency heal - Cure Wounds / Mass Cure Wounds /
 *     other heal actions - ranked by urgency, reachability, and number
 *     of allies helped. Touch healers can move before healing.
 *
 *   Step 1.5 (main): caller-injected non-offensive tactical action
 *     after healing has had first refusal (currently stabilise ally).
 *
 *   Step 2 (main): concentration buff. If not already concentrating
 *     and a sensible buff target exists, put up Bless / Spirit
 *     Guardians / Shield of Faith. 1v1 fights skip concentration
 *     debuffs (Bane) and ally-only buffs that would just hit self.
 *
 *   Step 3 (main): damage. Rank leveled damage spells by expected
 *     value × multi-target multiplier × resistance adjustment, fall
 *     back to the strongest castable cantrip - but only if the
 *     cantrip outdamages the best weapon attack (otherwise let the
 *     weapon path handle it).
 *
 * Hero AoE targeting (`getHeroAoeTargets`) is module-private. It
 * picks a center point that maximizes enemies hit, respects the
 * spell's range, and returns the targets + center the animation
 * layer needs.
 *
 * Boundary: this file decides WHICH spell to cast and where to put
 * the AoE. The actual cast is `executeSpell` from `combat.ts`. Damage
 * estimation + resistance math live in `ai-targeting.ts`. Wild Shape
 * druids can't cast (gated at the top).
 */

import { Creature, MonsterAction } from '../types/monster.js';
import {
  BattleState, creatureDistance, distance,
  getEnemies, getAllies,
  executeSpell, hasBuff, hasResource, addBuff,
  tryUseBonusActionDamageBuff, useSpiritualWeaponAttack,
  isInCone, isInLine, bestDirectionalTargets,
  pushLog, getEffectiveMoveSpeed,
} from './combat.js';
import { moveToward } from './ai-movement.js';
import { averageDamage } from './dice.js';
import {
  estimateDamage, estimateSpellDamage, inferSpellDamageType, adjustForResistance,
} from './ai-targeting.js';

// ─────────────────────────────────────────────────────────────────────
// Spell list helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Every hero-ability action on the creature. This includes spells
 * (spellLevel defined) AND non-slot abilities like Rage, Second Wind,
 * Lay on Hands (resourceCost defined). trySpellcast's decision tree
 * handles both categories.
 */
function getSpellActions(creature: Creature): MonsterAction[] {
  return creature.monsterData.actions.filter(a =>
    !a.legendaryOnly &&
    (a.spellLevel !== undefined || a.resourceCost !== undefined || a.layOnHands !== undefined)
  );
}

function tryInstinctivePounce(state: BattleState, creature: Creature, action: MonsterAction): void {
  if (action.name !== 'Rage') return;
  if (creature.monsterData.heroClass !== 'Barbarian' || (creature.monsterData.heroLevel ?? 0) < 7) return;
  const target = getEnemies(state, creature)
    .filter(enemy => enemy.isAlive)
    .sort((a, b) => creatureDistance(creature, a) - creatureDistance(creature, b))[0];
  if (!target) return;
  const oldRemaining = creature.movementRemaining;
  const from = { ...creature.position };
  creature.movementRemaining = Math.floor(getEffectiveMoveSpeed(creature, state) / 2);
  creature.position = moveToward(creature, target.position, state);
  creature.movementRemaining = oldRemaining;
  const moved = distance(from, creature.position);
  if (moved > 0) {
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: creature.displayName,
      action: 'Instinctive Pounce',
      details: `${creature.displayName} surges ${moved} ft as part of entering Rage.`,
      type: 'move',
    });
  }
}

/**
 * Area classification for hero AoE targeting. Determines whether the
 * effect originates at the caster (cone, line, cube-from-you,
 * emanation) or at a chosen point within range (sphere, cylinder at
 * a point). The engine's existing dragon-breath path assumes from-caster,
 * which is why Fireball-style spells currently land at the Wizard's feet.
 */
function aoeOriginKind(area: string): 'caster' | 'point' {
  const a = area.toLowerCase();
  if (a.includes('cone') || a.includes('line') || a.includes('emanation')) return 'caster';
  // Spheres, cylinders, cubes at a point → choose a target cell.
  return 'point';
}

/** Parse "N-foot" radius from the area string; default 20. */
function parseAreaRadius(area: string): number {
  const m = area.toLowerCase().match(/(\d+)[\s-]?foot/);
  return m ? parseInt(m[1]) : 20;
}

/** Feet → cells (1 cell = 5 ft in our grid). */
function feetToCells(ft: number): number {
  return ft / 5;
}

/**
 * Score a hypothetical center point. Since hero AoE targeting already
 * filters allies out of the damage list (pragmatic deviation from SRD
 * friendly fire), the scorer just counts enemies caught. Allies in the
 * visual blast are harmless and shouldn't discourage placement - that
 * was the old behavior and it blocked valid Shatter / Fireball casts
 * when enemies closed to melee range with an ally. Caller picks the
 * max-scoring point.
 */
function scoreAoeCenter(
  state: BattleState, caster: Creature, centerX: number, centerY: number, radius: number,
): { score: number; enemies: Creature[]; allTargets: Creature[] } {
  const enemies: Creature[] = [];
  const allTargets: Creature[] = [];
  let alliesHit = 0;
  const rCells = feetToCells(radius);
  for (const c of state.creatures) {
    if (!c.isAlive || c.id === caster.id) continue;
    const dx = c.position.x - centerX;
    const dy = c.position.y - centerY;
    const distCells = Math.sqrt(dx * dx + dy * dy);
    if (distCells > rCells) continue;
    allTargets.push(c);
    if (c.team === caster.team) alliesHit++;
    else enemies.push(c);
  }
  // "No friendly fire" toggle: if enabled, any placement hitting an ally
  // is rejected entirely. Otherwise, heavy penalty (3x per ally).
  const noFF = caster.team === 'red'
    ? state.teamTactics?.redNoFriendlyFire
    : state.teamTactics?.blueNoFriendlyFire;
  const score = alliesHit > 0 && noFF
    ? -Infinity
    : enemies.length - alliesHit * 3;
  return { score, enemies, allTargets };
}

/**
 * Hero AoE targeting. Replaces getAoETargets for heroes: picks a center
 * point that maximizes enemies-vs-allies, respects the spell's max
 * range (Fireball = 150 ft, Shatter = 60 ft, etc.), and returns ONLY
 * enemy creatures in the blast. Strictly a deviation from SRD (allies
 * in area should take damage too) in exchange for sane MC numbers -
 * it prevents the AI from nuking its own party and matches player
 * expectations ("Wizard doesn't Fireball their own tank").
 *
 * Returns both the affected enemies and the chosen center position
 * so the animation layer can draw the AoE at the right spot. For
 * from-caster shapes (cone/line/emanation) the center IS the caster.
 */
function getHeroAoeTargets(state: BattleState, caster: Creature, action: MonsterAction): {
  targets: Creature[]; center: { x: number; y: number };
} {
  const area = action.savingThrow?.area ?? '';
  const casterCenter = { ...caster.position };
  if (!area) {
    return { targets: getEnemies(state, caster).filter(e => e.isAlive), center: casterCenter };
  }

  const radius = parseAreaRadius(area);
  const origin = aoeOriginKind(area);

  // From-caster shapes: cone, line, or emanation.
  if (origin === 'caster') {
    const areaLower = area.toLowerCase();
    if (areaLower.includes('cone')) {
      const { targets } = bestDirectionalTargets(state, caster, radius, isInCone);
      return { targets, center: casterCenter };
    }
    if (areaLower.includes('line')) {
      const { targets } = bestDirectionalTargets(state, caster, radius, isInLine);
      return { targets, center: casterCenter };
    }
    // Emanation (Thunderwave, etc.): all creatures within radius
    const targets = state.creatures.filter(c =>
      c.isAlive &&
      c.id !== caster.id &&
      creatureDistance(c, caster) <= radius
    );
    return { targets, center: casterCenter };
  }

  // Point-origin shapes: pick the best enemy cluster center.
  // Max range a caster can place the point: use the spell's action.range
  // if set, else a sensible default derived from the spell level.
  const maxRange = action.range?.normal
    ?? (action.spellLevel === 3 ? 120 : action.spellLevel === 2 ? 60 : 60);
  const maxRangeCells = feetToCells(maxRange);

  // Candidate centers: every alive enemy's cell (and the mid-point between
  // pairs for cluster centers). Start with enemy cells - cheap and usually
  // optimal.
  const enemies = getEnemies(state, caster).filter(e => e.isAlive);
  if (enemies.length === 0) return { targets: [], center: casterCenter };

  let best = { score: -Infinity, enemies: [] as Creature[], allTargets: [] as Creature[], cx: 0, cy: 0 };
  for (const anchor of enemies) {
    if (creatureDistance(caster, anchor) > maxRange) continue;
    const r = scoreAoeCenter(state, caster, anchor.position.x, anchor.position.y, radius);
    if (r.score > best.score) {
      best = { score: r.score, enemies: r.enemies, allTargets: r.allTargets, cx: anchor.position.x, cy: anchor.position.y };
    }
  }

  for (let i = 0; i < enemies.length; i++) {
    for (let j = i + 1; j < enemies.length; j++) {
      const midX = Math.round((enemies[i].position.x + enemies[j].position.x) / 2);
      const midY = Math.round((enemies[i].position.y + enemies[j].position.y) / 2);
      const dxc = midX - caster.position.x;
      const dyc = midY - caster.position.y;
      if (Math.sqrt(dxc * dxc + dyc * dyc) > maxRangeCells) continue;
      const r = scoreAoeCenter(state, caster, midX, midY, radius);
      if (r.score > best.score) {
        best = { score: r.score, enemies: r.enemies, allTargets: r.allTargets, cx: midX, cy: midY };
      }
    }
  }

  if (best.score <= 0) {
    return { targets: [], center: casterCenter };
  }
  // Return ALL creatures in the blast (allies + enemies). resolveAoE
  // processes everyone; applyDamage handles immunity/resistance.
  return { targets: best.allTargets, center: { x: best.cx, y: best.cy } };
}

/**
 * True if the caster can pay for this spell now. Cantrips always castable.
 * Leveled spells require a slot at or above the spell's level. The engine
 * doesn't currently support upcasting - we use the exact slot level only,
 * unless no slot at that level exists, in which case we skip.
 */
function canCastSpell(creature: Creature, spell: MonsterAction): boolean {
  // Monster innate at-will spell (Lich Fireball, Red Dragon Scorching
  // Ray, Night Hag Magic Missile, ...) - always available.
  if (spell.atWill) return true;
  // Non-slot resource cost (Rage, Second Wind, Ki, Lay on Hands, AND
  // monster innate-spellcasting per-spell counters like "Fireball 2/Day").
  // When resourceCost is set, the per-spell counter is the only gate -
  // the spell's spellLevel exists for damage scaling, not slot
  // consumption. Without this branch, monster innate spells with
  // spellLevel > 0 would fall through to the slot loop below and never
  // cast (monsters don't have spell slots configured).
  if (spell.resourceCost) {
    return hasResource(creature, spell.resourceCost.key, spell.resourceCost.amount);
  }
  if (spell.layOnHands) {
    return hasResource(creature, spell.layOnHands.resourceKey, 1);
  }
  const lvl = spell.spellLevel ?? 0;
  if (lvl === 0) return true;
  // Upcasting: any slot at or above the spell's level works. Warlock pact
  // slots at L3 are all L2s even for a spellLevel-1 spell like Hex, so
  // the caster needs to be allowed to spend a higher-level slot.
  for (let slotLvl = lvl; slotLvl <= 9; slotLvl++) {
    if (hasResource(creature, `slot-${slotLvl}`)) return true;
  }
  return false;
}

function spellValueAgainstTarget(spell: MonsterAction, target: Creature): number {
  return estimateDamage(spell, {
    target,
    saveForHalfMultiplier: 1,
    includeConditionRider: true,
  });
}

interface HealPlan {
  spell: MonsterAction;
  target: Creature;
  score: number;
  affectedTargets: Creature[];
}

function isZeroHpUnconscious(creature: Creature): boolean {
  return creature.currentHp === 0 && creature.conditions.includes('unconscious');
}

function canReceiveTacticalBuff(creature: Creature): boolean {
  return creature.isAlive && !creature.dying && !isZeroHpUnconscious(creature);
}

function isMeleeOnlySmiteBuff(spell: MonsterAction): boolean {
  return spell.name === 'Blinding Smite' || /next melee hit/i.test(spell.description);
}

function canReachMeleeThisTurn(creature: Creature, enemies: Creature[]): boolean {
  const meleeReach = creature.monsterData.actions
    .filter(action => action.type === 'melee' || action.type === undefined)
    .reduce((max, action) => Math.max(max, action.reach ?? 5), 0);
  if (meleeReach <= 0) return false;
  return enemies.some(enemy => creatureDistance(creature, enemy) <= meleeReach + creature.movementRemaining);
}

function healingNeedScore(creature: Creature): number {
  if (!creature.isAlive) return 0;
  if (creature.dying || isZeroHpUnconscious(creature)) {
    return 1000 + Math.min(creature.maxHp, 120) / 10;
  }
  if (creature.currentHp >= creature.maxHp) return 0;
  const hpFraction = creature.currentHp / creature.maxHp;
  const missingHp = creature.maxHp - creature.currentHp;
  if (hpFraction <= 0.25) return 180 + missingHp;
  if (hpFraction < 0.5) return 70 + missingHp;
  return 0;
}

function isHealingAction(spell: MonsterAction): boolean {
  return !!spell.heal || !!spell.temporaryHp || spell.powerWord?.kind === 'heal' || !!spell.buff?.maxHpBonus;
}

function estimatedHealValue(spell: MonsterAction): number {
  if (spell.powerWord?.kind === 'heal') return 120;
  if (spell.temporaryHp) return averageDamage(spell.temporaryHp.dice);
  if (spell.buff?.maxHpBonus) return spell.buff.maxHpBonus;
  return spell.heal ? averageDamage(spell.heal.dice) : 0;
}

function healRangeForSpell(spell: MonsterAction): number {
  if (spell.targetScope === 'all_allies_in_area') return spell.range?.normal ?? 30;
  return spell.range?.normal ?? 5;
}

function canPotentiallyReachHealTarget(caster: Creature, target: Creature, range: number): boolean {
  if (target.id === caster.id) return true;
  return creatureDistance(caster, target) <= range + caster.movementRemaining;
}

function healCandidatesForSpell(caster: Creature, allies: Creature[], spell: MonsterAction): Creature[] {
  if (spell.targetScope === 'self') {
    return healingNeedScore(caster) > 0 ? [caster] : [];
  }

  return [caster, ...allies]
    .filter(a => healingNeedScore(a) > 0)
    .sort((a, b) =>
      healingNeedScore(b) - healingNeedScore(a)
      || (a.currentHp / a.maxHp) - (b.currentHp / b.maxHp)
    );
}

function estimateAreaHealTargets(caster: Creature, allies: Creature[], anchor: Creature, range: number): Creature[] {
  const candidates = [caster, ...allies].filter(a => healingNeedScore(a) > 0);
  const origin = creatureDistance(caster, anchor) <= range ? caster : anchor;
  return candidates
    .filter(a => a.id === anchor.id || creatureDistance(origin, a) <= range)
    .sort((a, b) => healingNeedScore(b) - healingNeedScore(a))
    .slice(0, 6);
}

function rankHealPlans(caster: Creature, allies: Creature[], spells: MonsterAction[]): HealPlan[] {
  const plans: HealPlan[] = [];
  for (const spell of spells) {
    if (!isHealingAction(spell)) continue;
    const range = healRangeForSpell(spell);
    for (const target of healCandidatesForSpell(caster, allies, spell)) {
      if (!canPotentiallyReachHealTarget(caster, target, range)) continue;
      const affectedTargets = spell.targetScope === 'all_allies_in_area'
        ? estimateAreaHealTargets(caster, allies, target, range)
        : [target];
      const urgencyScore = affectedTargets.reduce((sum, t) => sum + healingNeedScore(t), 0);
      if (urgencyScore <= 0) continue;
      const actionEconomyBonus = spell.isBonusAction ? 35 : 0;
      const movementPenalty = target.id !== caster.id && creatureDistance(caster, target) > range ? 15 : 0;
      plans.push({
        spell,
        target,
        affectedTargets,
        score: urgencyScore + estimatedHealValue(spell) * 0.2 + actionEconomyBonus - movementPenalty,
      });
    }
  }
  return plans.sort((a, b) =>
    b.score - a.score
    || (b.spell.spellLevel ?? 0) - (a.spell.spellLevel ?? 0)
    || estimatedHealValue(b.spell) - estimatedHealValue(a.spell)
  );
}

function shouldCastBonusHealBeforeAction(bonusPlan: HealPlan, bestMainPlan: HealPlan | undefined): boolean {
  if (!bestMainPlan) return true;
  if (bonusPlan.spell.spellLevel === undefined) return true;
  if ((bestMainPlan.spell.spellLevel ?? 0) === 0) return true;
  return bestMainPlan.score <= bonusPlan.score + 250;
}

function moveIntoHealRange(state: BattleState, caster: Creature, target: Creature, spell: MonsterAction): boolean {
  const range = healRangeForSpell(spell);
  if (target.id === caster.id || creatureDistance(caster, target) <= range) return true;

  const from = { ...caster.position };
  caster.position = moveToward(caster, target.position, state);
  const moved = distance(from, caster.position);
  if (moved > 0) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: caster.displayName, action: 'Move',
      details: `${caster.displayName} moves ${moved} ft to reach ${target.displayName} for ${spell.name}.`,
      type: 'move',
    });
  }
  return creatureDistance(caster, target) <= range;
}

function executeHealPlan(state: BattleState, caster: Creature, plan: HealPlan): boolean {
  if (!moveIntoHealRange(state, caster, plan.target, plan.spell)) return false;
  return executeSpell(state, caster, plan.spell, plan.target);
}

function tryRetargetHex(state: BattleState, creature: Creature, enemies: Creature[]): boolean {
  if (creature.bonusActionUsed) return false;
  const oldTarget = state.creatures.find(c =>
    !c.isAlive && c.activeBuffs?.some(b => b.key === 'hex' && b.casterId === creature.id)
  );
  if (!oldTarget) return false;
  const oldBuff = oldTarget.activeBuffs.find(b => b.key === 'hex' && b.casterId === creature.id);
  if (!oldBuff) return false;

  const hexAction = creature.monsterData.actions.find(a => a.name === 'Hex');
  const range = hexAction?.range?.normal ?? 90;
  const target = enemies
    .filter(e =>
      creatureDistance(creature, e) <= range &&
      !(e.activeBuffs ?? []).some(b => b.key === 'hex' && b.casterId === creature.id)
    )
    .sort((a, b) => b.currentHp - a.currentHp)[0];
  if (!target) return false;

  oldTarget.activeBuffs = oldTarget.activeBuffs.filter(b => !(b.key === 'hex' && b.casterId === creature.id));
  addBuff(target, {
    ...oldBuff,
    appliedRound: state.round,
  });
  creature.concentratingOn = oldBuff.key;
  creature.bonusActionUsed = true;
  pushHexRetargetLog(state, creature, oldTarget, target);
  return true;
}

function pushHexRetargetLog(state: BattleState, creature: Creature, oldTarget: Creature, target: Creature): void {
  state.logs.push({
    round: state.round, turn: state.turnIndex,
    actor: creature.displayName, action: 'Hex',
    details: `${creature.displayName} moves Hex from ${oldTarget.displayName} to ${target.displayName}.`,
    type: 'special', eventIndex: state.events.length,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Try to select and cast a spell for this creature's action this turn.
 * Returns true if a spell was cast (consuming the main action for the
 * turn); callers should skip weapon attacks.
 *
 * Priority (v1 heuristic):
 *   1. Heal a below-50%-HP ally with a healing spell if available
 *   1.5 Let the caller spend the action on a non-offensive table action
 *   2. Buff: if not already concentrating, put a concentration buff on
 *      the best target (self for self-buffs, ally for Bless-style)
 *   3. Highest-damage spell vs. weakest in-range enemy (prefer saving-slot
 *      over cantrip when slots are plentiful, but save slots when scarce)
 *
 * Cantrip-only casters with no slots still hit step 3 and fire a damage
 * cantrip. Fighter/Rogue/Barbarian without any spells fall through to
 * the weapon branch.
 */
export function trySpellcast(state: BattleState, creature: Creature, beforeOffense?: () => boolean): boolean {
  // Beast Spells (Druid L18+) allows spellcasting while Wild Shaped.
  if (creature.wildShape && !(creature.monsterData.heroClass === 'Druid' && (creature.monsterData.heroLevel ?? 0) >= 18)) {
    return false;
  }
  const spells = getSpellActions(creature);
  if (spells.length === 0) return false;

  const enemies = getEnemies(state, creature).filter(e => e.isAlive);
  const allies = getAllies(state, creature).filter(a => a.isAlive);

  // ── Step 0: bonus action spells ──────────────────────────────────────
  // Bonus action buffs (Rage, Hex, Hunter's Mark) and bonus action heals
  // (Healing Word) are cast first WITHOUT consuming the main action, so
  // the creature can still attack/cast a main-action spell this turn.
  if (!creature.bonusActionUsed) {
    tryUseBonusActionDamageBuff(state, creature);
  }

  // Spiritual Weapon is already an authoritative persistent engine object.
  // Reuse its validated resolver before considering new bonus-action casts so
  // AI-controlled Clerics do not leave a live weapon idle for its full duration.
  if (!creature.bonusActionUsed && creature.spiritualWeapon) {
    const target = enemies
      .filter(enemy => Math.max(
        Math.abs(enemy.position.x - creature.spiritualWeapon!.position.x),
        Math.abs(enemy.position.y - creature.spiritualWeapon!.position.y),
      ) * 5 <= creature.spiritualWeapon!.moveFt + 5)
      .sort((a, b) => a.currentHp - b.currentHp)[0];
    if (target) useSpiritualWeaponAttack(state, creature, target);
  }

  if (!creature.bonusActionUsed) {
    // Bonus-action heal (Healing Word): check before buffs
    const bonusHeals = spells.filter(s => s.isBonusAction && isHealingAction(s) && canCastSpell(creature, s));
    if (bonusHeals.length > 0) {
      const bestBonusHeal = rankHealPlans(creature, allies, bonusHeals)[0];
      const bestMainHeal = rankHealPlans(
        creature,
        allies,
        spells.filter(s => !s.isBonusAction && isHealingAction(s) && canCastSpell(creature, s)),
      )[0];
      if (bestBonusHeal && shouldCastBonusHealBeforeAction(bestBonusHeal, bestMainHeal)) {
        if (executeHealPlan(state, creature, bestBonusHeal)) {
          creature.bonusActionUsed = true;
          if (bestBonusHeal.spell.spellLevel !== undefined) {
            creature.turnFlags = { ...(creature.turnFlags ?? {}), bonusActionSpellCast: true };
          }
        }
      }
    }

    if (!creature.bonusActionUsed) {
      tryRetargetHex(state, creature, enemies);
    }

    // Bonus-action buff (Rage, Hex, Hunter's Mark)
    if (!creature.bonusActionUsed) {
      const alreadyConcentrating = !!creature.concentratingOn
        || state.creatures.some(c => c.activeBuffs?.some(b => b.requiresConcentration && b.casterId === creature.id));
      const bonusBuffs = spells
        .filter(s => s.isBonusAction && s.buff && canCastSpell(creature, s))
        .filter(s => !isMeleeOnlySmiteBuff(s) || canReachMeleeThisTurn(creature, enemies))
        .filter(s => !(s.targetScope === 'self' && s.buff && hasBuff(creature, s.buff.key)))
        .filter(s => !s.buff?.requiresConcentration || !alreadyConcentrating);
      if (bonusBuffs.length > 0) {
        const buff = bonusBuffs.sort((a, b) => (b.spellLevel ?? 0) - (a.spellLevel ?? 0))[0];
        let target: Creature | null = null;
        if (buff.targetScope === 'self') target = creature;
        else if (buff.targetScope === 'one_enemy') {
          target = enemies.slice().sort((a, b) => b.currentHp - a.currentHp)[0] ?? null;
        } else if (buff.targetScope === 'one_ally') {
          // Pick the frontline ally (highest HP, most likely to use the buff)
          const allyTargets = allies.filter(a => canReceiveTacticalBuff(a) && !hasBuff(a, buff.buff!.key));
          target = allyTargets.sort((a, b) => b.currentHp - a.currentHp)[0] ?? null;
        }
        if (target) {
          executeSpell(state, creature, buff, target);
          tryInstinctivePounce(state, creature, buff);
          creature.bonusActionUsed = true;
          if (buff.spellLevel !== undefined) {
            creature.turnFlags = { ...(creature.turnFlags ?? {}), bonusActionSpellCast: true };
          }
        }
      }
    }
  }

  // ── Step 1: emergency heal (main action only) ─────────────────────────
  // If a bonus-action spell was cast this turn, only cantrip heals allowed
  // (there are none currently, so this effectively skips heal if BA used).
  const healSpells = spells.filter(s =>
    !s.isBonusAction && isHealingAction(s) && canCastSpell(creature, s) &&
    (!creature.turnFlags?.bonusActionSpellCast || (s.spellLevel ?? 0) === 0)
  );
  if (healSpells.length > 0) {
    // Rank by urgency and reachability, not just raw heal dice. This lets
    // touch healers move before reviving and lets Mass Cure beat a small
    // single-target heal when several allies are down.
    for (const plan of rankHealPlans(creature, allies, healSpells)) {
      if (executeHealPlan(state, creature, plan)) {
        return true;
      }
    }
  }

  if (beforeOffense?.()) {
    return true;
  }

  // ── Step 2: concentration buff ────────────────────────────────────────
  // If not already concentrating and we have a buff spell, put it up.
  // Also skip self-buffs that are already active (e.g., Rage - not
  // concentration, but shouldn't be re-cast while active).
  const alreadyConcentrating = !!creature.concentratingOn
    || state.creatures.some(c => c.activeBuffs?.some(b => b.requiresConcentration && b.casterId === creature.id));
  const buffSpells = spells
    .filter(s => !s.isBonusAction && s.buff && canCastSpell(creature, s))
    .filter(s => !s.buff?.maxHpBonus)
    .filter(s => !creature.turnFlags?.bonusActionSpellCast || (s.spellLevel ?? 0) === 0)
    .filter(s => {
      if (!s.buff) return true;
      if (s.targetScope === 'self' && hasBuff(creature, s.buff.key)) return false;
      return true;
    });
  // Skip low-level buff if a higher-level concentration damage spell is
  // available (Spirit Guardians L3 > Bless L1). The damage spell will be
  // picked in Step 3 and is worth more than the buff.
  const concDamageSpells = spells.filter(s =>
    s.concentration && s.savingThrow?.damageOnFail && canCastSpell(creature, s)
  );
  const bestConcDmgLevel = concDamageSpells.reduce((max, s) => Math.max(max, s.spellLevel ?? 0), 0);
  const viableBuffs = buffSpells.filter(s => {
    if (!s.buff?.requiresConcentration) return true;
    return (s.spellLevel ?? 0) >= bestConcDmgLevel;
  });

  // Skip concentration debuffs (Bane) and single-target-only buffs (Bless on self)
  // in 1v1 - they're not worth the concentration slot against a single enemy.
  const finalBuffs = viableBuffs.filter(s => {
    if (enemies.length <= 1 && s.buff?.requiresConcentration) {
      if (s.buff.attackBonusDice?.startsWith('-')) return false; // Bane-like debuffs
      if (s.targetScope === 'one_ally' || s.targetScope === 'all_allies_in_area') {
        if (allies.length === 0) return false; // Bless on self only = weak
      }
    }
    return true;
  });

  const castableBuffs = alreadyConcentrating
    ? finalBuffs.filter(s => !s.buff?.requiresConcentration)
    : finalBuffs;
  if (castableBuffs.length > 0) {
    const buff = castableBuffs.sort((a, b) => (b.spellLevel ?? 0) - (a.spellLevel ?? 0))[0];
    // Target scope determines who we buff.
    //   'self'     - caster (Rage, self-cast Shield of Faith)
    //   'one_enemy'- Hex / Hunter's Mark: pick the beefiest enemy so the
    //                rider deals the most total damage over the fight
    //   'one_ally' / default - buff the healthiest candidate (the
    //                frontline who will survive to cash in the bonus)
    let target: Creature | null = null;
    if (buff.targetScope === 'self') target = creature;
    else if (buff.targetScope === 'one_enemy') {
      target = enemies.slice().sort((a, b) => b.currentHp - a.currentHp)[0] ?? null;
    } else {
      const candidates = [creature, ...allies].filter(canReceiveTacticalBuff);
      target = candidates.sort((a, b) => b.currentHp / b.maxHp - a.currentHp / a.maxHp)[0] ?? creature;
    }
    if (target) {
      executeSpell(state, creature, buff, target);
      return true;
    }
  }

  // ── Step 3: damage (main action only) ──────────────────────────────────
  // D&D rule: if you cast a bonus-action spell this turn, the only spell
  // you can cast as your action is a cantrip. No leveled action spells.
  const bonusSpellCastThisTurn = !!creature.turnFlags?.bonusActionSpellCast;
  const damageSpells = spells
    .filter(s => !s.isBonusAction && canCastSpell(creature, s))
    .filter(s => estimateSpellDamage(s) > 0)
    .filter(s => !bonusSpellCastThisTurn || (s.spellLevel ?? 0) === 0)
    .filter(s => !(s.concentration && alreadyConcentrating));

  if (damageSpells.length === 0 || enemies.length === 0) return false;

  // Prefer leveled spells when an enemy would actually die to it; otherwise
  // conserve slots and fire a cantrip.
  // Find best target (lowest HP in range of any spell).
  const bestTarget = enemies
    .slice()
    .sort((a, b) => a.currentHp - b.currentHp)[0];

  // Damage-spell selection ranks the real per-target value after range,
  // type restrictions, damage resistance, and condition immunity. AoEs sum
  // their enemy targets, so Fireball still wins clustered fights while
  // control-only spells drop out if every target ignores the rider.
  const leveledDamage = damageSpells.filter(s => (s.spellLevel ?? 0) > 0);
  const rankedLeveled = leveledDamage.map(spell => {
    let value = -1;
    let resolvedTargets: Creature[] = [];
    let resolvedCenter: { x: number; y: number } | undefined;
    let resolvedTarget: Creature | undefined;
    if (spell.savingThrow?.area) {
      const { targets, center } = getHeroAoeTargets(state, creature, spell);
      resolvedTargets = targets;
      resolvedCenter = center;
      // Don't target already-unconscious creatures (e.g., don't recast Sleep)
      resolvedTargets = resolvedTargets.filter(t => !t.conditions.includes('unconscious'));

      // HP-pool spells (2024 Sleep): only targets whose current HP fits under
      // the pool's average roll actually get affected - filter here so the AI
      // doesn't burn a slot on a room full of high-HP enemies.
      if (spell.savingThrow.hpPoolDice) {
        const avgPool = averageDamage(spell.savingThrow.hpPoolDice);
        resolvedTargets = resolvedTargets
          .slice()
          .sort((a, b) => a.currentHp - b.currentHp);
        let remaining = avgPool;
        const eligible: Creature[] = [];
        for (const t of resolvedTargets) {
          if (t.currentHp > remaining) break;
          remaining -= t.currentHp;
          eligible.push(t);
        }
        resolvedTargets = eligible;
      }
      if (resolvedTargets.length === 0) {
        return { spell, value: -1, targets: resolvedTargets, center: resolvedCenter, target: resolvedTarget };
      }
      value = resolvedTargets
        .filter(t => t.team !== creature.team)
        .reduce((sum, t) => sum + spellValueAgainstTarget(spell, t), 0);
    } else {
      // Single-target: in-range + type restriction check.
      const range = spell.range?.normal ?? 120;
      const candidates = enemies.filter(e =>
        e.isAlive &&
        creatureDistance(creature, e) <= range &&
        (!spell.targetTypeRestriction ||
          e.monsterData.type.toLowerCase() === spell.targetTypeRestriction.toLowerCase())
      );
      if (candidates.length === 0) {
        return { spell, value: -1, targets: [], center: resolvedCenter, target: resolvedTarget };
      }
      const bestCandidate = candidates
        .map(target => ({ target, value: spellValueAgainstTarget(spell, target) }))
        .sort((a, b) => b.value - a.value)[0];
      if (!bestCandidate || bestCandidate.value <= 0) {
        return { spell, value: -1, targets: [], center: resolvedCenter, target: resolvedTarget };
      }
      resolvedTarget = bestCandidate.target;
      value = bestCandidate.value;
    }
    return { spell, value, targets: resolvedTargets, center: resolvedCenter, target: resolvedTarget };
  })
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value);

  for (const pick of rankedLeveled) {
    const spell = pick.spell;
    const spellTarget = pick.target ?? bestTarget;
    if (spell.savingThrow?.area) {
      executeSpell(state, creature, spell, spellTarget, pick.targets, pick.center);
      return true;
    }
    if (spell.autoDarts) {
      const darts = Array(spell.autoDarts).fill(spellTarget);
      executeSpell(state, creature, spell, spellTarget, darts);
      return true;
    }
    executeSpell(state, creature, spell, spellTarget);
    return true;
  }

  // Fall back to damage cantrips - but only if they outdamage the best
  // weapon attack. Bard Vicious Mockery (2d4 avg 5, save) is worse than
  // Rapier (1d8+2 avg 6.5, attack roll). Skip weak cantrips so the hero
  // falls through to the weapon attack path.
  const bestWeaponDmg = creature.monsterData.actions
    .filter(a => (a.type === 'melee' || a.type === 'ranged') && a.damage && a.spellLevel === undefined)
    .reduce((max, a) => Math.max(max, averageDamage(a.damage!)), 0);
  const cantrips = damageSpells
    .filter(s => (s.spellLevel ?? 0) === 0)
    .filter(s => {
      const dmgType = inferSpellDamageType(s) || '';
      const adjusted = adjustForResistance(estimateSpellDamage(s), dmgType, bestTarget);
      return adjusted >= bestWeaponDmg;
    })
    .sort((a, b) => {
      const dmgA = adjustForResistance(estimateSpellDamage(a), inferSpellDamageType(a) || '', bestTarget);
      const dmgB = adjustForResistance(estimateSpellDamage(b), inferSpellDamageType(b) || '', bestTarget);
      return dmgB - dmgA;
    });
  for (const cantrip of cantrips) {
    if (cantrip.savingThrow?.area) {
      const { targets, center } = getHeroAoeTargets(state, creature, cantrip);
      if (targets.length === 0) continue;
      executeSpell(state, creature, cantrip, bestTarget, targets, center);
      return true;
    }
    const range = cantrip.range?.normal ?? 60;
    if (creatureDistance(creature, bestTarget) <= range) {
      if (cantrip.savingThrow) {
        // Single-target save cantrip (Sacred Flame, Vicious Mockery)
        // Pass as primaryTarget only (not aoeTargets) so it doesn't
        // push an AoE animation event.
        executeSpell(state, creature, cantrip, bestTarget);
      } else {
        executeSpell(state, creature, cantrip, bestTarget);
      }
      return true;
    }
  }

  return false;
}
