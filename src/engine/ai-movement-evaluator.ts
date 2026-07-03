/**
 * Smart-movement evaluator. Per-turn destination chooser that scores
 * candidate cells along multiple axes and picks the best for a creature
 * to walk toward.
 *
 * This is the "where do I want to be standing at the end of my move?"
 * decision. The pathfinder (`moveToward` in ai-movement.ts) still
 * handles the actual route - this layer only picks the destination.
 *
 * Architecture (filled in over a sequence of PRs):
 *   PR A (this one): scaffolding + distanceScore.
 *     Behaviour near-identical to the previous nearestFootprintEdge
 *     destination. Existing tests should pass without changes.
 *   PR B: archetype profiles + threat-radius kiting + dispersion.
 *     Big visible change for ranged mobs.
 *   PR C: coverScore + LoS cache.
 *     Wizards / squishies hug walls.
 *   PR D: allyAffinity (healers) + oaRisk polish.
 *
 * Each component is composed via a weighted sum. Weights vary by
 * archetype profile (PR B). PR A uses uniform weights so behaviour
 * stays close to today.
 */

import { Creature } from '../types/monster.js';
import {
  BattleState, getFootprintSize, isPositionBlocked,
  getActiveSize, getActiveSpeed, getEffectiveMoveSpeed, hasActiveTrait,
} from './combat.js';
import { canRepeatMeleeOrRangedAtRange, getActiveActions, shouldPreferRanged } from './ai-targeting.js';

export type MovementArchetype =
  | 'melee'           // pure melee, charges in
  | 'ranged'          // ranged-only or ranged-preferred
  | 'caster'          // spellcaster (squishy, prefers cover)
  | 'mixed'           // both melee and ranged usable
  | 'healer'          // has heal action; prefers ally proximity
  | 'tank';           // high AC, melee, holds chokepoints

export interface MovementProfile {
  archetype: MovementArchetype;
  weights: {
    distance: number;
    cover: number;
    oaRisk: number;
    allyAffinity: number;
    dispersion: number;
    edge: number;
    packTactics: number;
  };
  /**
   * The creature's effective ranged "normal" range, in ft. Used by
   * distanceScore for kite-zone scoring.
   */
  bestRangedNormal: number;
  /**
   * True if the creature has the Pack Tactics trait. Movement scoring
   * uses this to bias toward providing or benefiting from PT.
   */
  hasPackTactics: boolean;
}

export interface MoveCandidate {
  pos: { x: number; y: number };
  total: number;
  components: {
    distance: number;
    cover: number;
    oaRisk: number;
    allyAffinity: number;
    dispersion: number;
    edge: number;
    packTactics: number;
  };
}

/**
 * Derive a movement profile from a creature's static stats.
 *
 * PR A: returns a generic 'mixed' profile with uniform weights. The
 * archetype is detected (so tests can sanity-check derivation) but
 * doesn't yet influence weights - PR B will tune per-archetype.
 */
export function deriveProfile(creature: Creature): MovementProfile {
  const actions = getActiveActions(creature) || [];
  // True melee = melee-only attacks, plus mundane thrown weapons we
  // intentionally model as "close and fight" instead of infinite ammo.
  // Repeatable hybrid = spell-like / returning melee-or-ranged attacks
  // (e.g. Arcane Burst, Flame Spear) that can be used at range every turn.
  // Pure ranged = type=ranged with attackBonus (e.g. Shortbow).
  const trueMeleeActions = actions.filter(a =>
    (a.type === 'melee' || a.type === undefined)
    && a.attackBonus !== undefined
    && (a.range === undefined || !canRepeatMeleeOrRangedAtRange(a)),
  );
  const hybridActions = actions.filter(a =>
    canRepeatMeleeOrRangedAtRange(a),
  );
  const rangedActions = actions.filter(a =>
    a.type === 'ranged' && a.attackBonus !== undefined,
  );
  const hasHeal = actions.some(a => a.heal);
  const hasTrueMelee = trueMeleeActions.length > 0;
  const canFireAtRange = hybridActions.length > 0 || rangedActions.length > 0;
  const ac = creature.monsterData.ac;

  // Hero spellcaster classes
  const isHeroCaster = creature.monsterData.isHero && (
    creature.monsterData.heroClass === 'Wizard'
    || creature.monsterData.heroClass === 'Sorcerer'
    || creature.monsterData.heroClass === 'Warlock'
  );
  // NPC spellcaster: has a `Spellcasting` special action whose description
  // mentions casting (Mage, Lich, Archmage, etc.).
  const hasNpcSpellcasting = actions.some(a =>
    a.type === 'special' && /casts|spellcasting/i.test(a.description ?? '')
  );
  const isCaster = isHeroCaster || hasNpcSpellcasting;

  // For mixed creatures (have both melee and ranged), defer to
  // shouldPreferRanged - the same hit-adjusted EV check the targeting
  // layer uses to pick attacks. This keeps movement aligned with what
  // the creature will actually shoot/swing. A Knight with greatsword +
  // 1d8 radiant rider has melee EV > crossbow EV → behaves as 'tank'.
  // A Goblin Warrior with equal scimitar/shortbow EVs → behaves as
  // 'ranged' and kites melee threats.
  //
  // Healing is a secondary capability, not always a movement identity.
  // Rangers and other ranged-first half-casters should not walk toward
  // monsters just because Cure Wounds exists on their sheet.
  let archetype: MovementArchetype = 'melee';
  if (isCaster) archetype = 'caster';
  else if (canFireAtRange && !hasTrueMelee) archetype = 'ranged';
  else if (canFireAtRange && hasTrueMelee) {
    const meleeAttacks = trueMeleeActions;
    const rangedAttacks = [...rangedActions, ...hybridActions];
    const prefersRanged = shouldPreferRanged(
      meleeAttacks, rangedAttacks, creature.monsterData.heroClass,
    );
    if (prefersRanged) archetype = 'ranged';
    else if (ac >= 16) archetype = 'tank';
    else archetype = 'melee';
  }
  else if (hasTrueMelee && ac >= 16) archetype = 'tank';
  else if (hasTrueMelee) archetype = 'melee';
  else archetype = 'melee';  // catch-all: no actions or unusual setup

  if (hasHeal && archetype !== 'ranged' && archetype !== 'caster') {
    archetype = 'healer';
  }

  // Best normal range across both pure-ranged AND hybrid actions
  // (Mage's Arcane Burst counts even though type=melee).
  const allRangedSources = [...rangedActions, ...hybridActions];
  const bestRangedNormal = allRangedSources.reduce(
    (max, a) => Math.max(max, a.range?.normal ?? 0),
    0,
  );

  const hasPackTactics = hasActiveTrait(creature, 'Pack Tactics');

  return {
    archetype,
    weights: weightsForArchetype(archetype),
    bestRangedNormal,
    hasPackTactics,
  };
}

/**
 * Per-archetype weight tuning. Each component scales independently;
 * the score function ultimately sums weight × component_value.
 *
 * Rough rationale:
 *  - Melee / tank / mixed: distance dominates (charge in / engage).
 *    Dispersion 0 - clustering is fine.
 *  - Ranged / caster: distance still matters but kite-zone bonuses
 *    deliver the magnitude. Dispersion ON for outnumbering scenarios.
 *  - Healer: ally affinity dominates (PR D wires this in); distance
 *    is secondary.
 *
 * PR B: cover, oaRisk, allyAffinity stay at 0 - wired in PR C/D.
 */
function weightsForArchetype(a: MovementArchetype): MovementProfile['weights'] {
  switch (a) {
    case 'melee':   return { distance: 1, cover: 0, oaRisk: 1, allyAffinity: 0, dispersion: 0, edge: 0.1, packTactics: 1 };
    case 'ranged':  return { distance: 1, cover: 0, oaRisk: 1, allyAffinity: 0, dispersion: 1, edge: 0.2, packTactics: 1 };
    case 'caster':  return { distance: 1, cover: 0, oaRisk: 1, allyAffinity: 0, dispersion: 1, edge: 0.2, packTactics: 1 };
    case 'mixed':   return { distance: 1, cover: 0, oaRisk: 1, allyAffinity: 0, dispersion: 0.3, edge: 0.1, packTactics: 1 };
    case 'healer':  return { distance: 0.3, cover: 0, oaRisk: 1, allyAffinity: 0, dispersion: 0, edge: 0.1, packTactics: 0.5 };
    case 'tank':    return { distance: 1, cover: 0, oaRisk: 1, allyAffinity: 0, dispersion: 0, edge: 0.1, packTactics: 1 };
  }
}

/**
 * Chebyshev distance, in feet, between a position and the closest cell
 * of a target creature's footprint.
 */
export function distanceToFootprint(
  pos: { x: number; y: number },
  target: Creature,
): number {
  const fp = getFootprintSize(getActiveSize(target));
  const dx = Math.max(
    0,
    Math.max(pos.x - (target.position.x + fp - 1), target.position.x - pos.x),
  );
  const dy = Math.max(
    0,
    Math.max(pos.y - (target.position.y + fp - 1), target.position.y - pos.y),
  );
  return Math.max(dx, dy) * 5;
}

/**
 * Chebyshev distance, in feet, between two cell positions.
 */
function cellDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 5;
}

/**
 * Max melee reach (in ft) of a creature, considering its actions.
 * 0 if the creature has no melee attacks at all (pure ranged enemy
 * doesn't generate threat radius for us to dodge).
 */
function maxMeleeReach(c: Creature): number {
  const actions = getActiveActions(c) || [];
  let max = 0;
  for (const a of actions) {
    if (a.type !== 'melee' && a.type !== undefined) continue;
    if (a.attackBonus === undefined) continue;
    // Hybrid actions (Mage's Arcane Burst) count as melee for reach
    // purposes - the attacker can still bite/slash at melee range.
    max = Math.max(max, a.reach ?? 5);
  }
  return max;
}

/**
 * Effective movement budget per turn for a creature, in ft.
 * Uses max(walk, fly) since flyers can ignore terrain on the way in.
 */
function effectiveMoveSpeed(c: Creature, state: BattleState): number {
  return getEffectiveMoveSpeed(c, state);
}

/**
 * Distance score with archetype-aware behaviour.
 *
 * For ranged / caster archetypes:
 *   - PROXIMITY to target: prefer cells in own ranged sweet spot.
 *     Penalty for being below 5 ft (in melee) or above bestRangedNormal.
 *   - KITE-ZONE per melee enemy: penalty for cells inside the enemy's
 *     normal move + reach (they can attack normally), bonus for cells
 *     in the kite zone (enemy must dash to reach, no attack that turn),
 *     small bonus for unreachable-even-with-dash cells.
 *
 * For melee / tank / mixed archetypes:
 *   - PROXIMITY to target: closer = better. No kite-zone math; they
 *     want to engage, not dodge.
 *
 * For healer:
 *   - Mild proximity to target. Real healer behaviour is driven by
 *     allyAffinity (PR D), this just keeps them in the action.
 *
 * Tiebreaker: small penalty for distance from current position,
 * euclidean (axis-aligned cells preferred). PR A's pathfinder
 * diagonal bias is gone (#186), but axis preference still helps
 * stability when multiple cells score near-tied.
 */
function distanceScore(
  pos: { x: number; y: number },
  creature: Creature,
  target: Creature,
  profile: MovementProfile,
  state: BattleState,
  enemies: Creature[],
): number {
  let score = 0;
  const dTarget = distanceToFootprint(pos, target);

  if (profile.archetype === 'ranged' || profile.archetype === 'caster') {
    // Sweet-spot range: 5 ft (out of melee) up through bestRangedNormal.
    // Peak right at the edge of normal range so we maximize kite distance
    // while still firing without disadvantage.
    const minRange = 5;
    const maxRange = Math.max(profile.bestRangedNormal, 5);
    if (dTarget < minRange) {
      // Inside melee with target - very bad for ranged.
      score -= 80;
    } else if (dTarget <= maxRange) {
      // In sweet spot. Mild bonus, slightly higher near the far edge.
      const fraction = dTarget / maxRange;
      score += 10 + fraction * 10;
    } else {
      // Outside normal range - linear penalty.
      score -= (dTarget - maxRange) * 1.5;
    }

    // Kite-zone scoring against each melee threat.
    //
    // Three zones based on enemy walk + reach:
    //   - Inside reach (d <= moveBudget): enemy walks in and attacks. Bad.
    //     Penalty grows the deeper we are inside.
    //   - Kite zone (moveBudget < d <= dashReach): enemy must dash to
    //     reach us, no attack this turn. Flat bonus - we don't try to
    //     min-max position within the zone (zigzags toward / away from
    //     enemy hurt other heuristics like Pack Tactics).
    //   - Beyond dash (d > dashReach): enemy needs 2 turns to close.
    //     Slightly higher bonus; only pulls a creature to a corner if
    //     it's also near sweet-spot range.
    for (const enemy of enemies) {
      const reach = maxMeleeReach(enemy);
      if (reach === 0) continue;  // pure ranged enemy = no melee threat
      const speed = effectiveMoveSpeed(enemy, state);
      const moveBudget = speed + reach;
      const dashReach = 2 * speed + reach;
      const distToEnemy = distanceToFootprint(pos, enemy);

      if (distToEnemy <= moveBudget) {
        // Entering a melee enemy's one-turn attack envelope just to
        // take a ranged shot is a very visible tactical error. Keep the
        // penalty strong enough that "stay safe but out of range" can
        // beat "step forward and get hit next turn."
        score -= 55 + (moveBudget - distToEnemy) * 0.8;
      } else if (distToEnemy <= dashReach) {
        score += 15;
      } else {
        score += 20;
      }
    }
  } else if (profile.archetype === 'healer') {
    // Mild "stay near the target" pull; PR D's allyAffinity will
    // override with "stay near wounded ally" once it's wired.
    score -= dTarget * 0.5;
  } else {
    // melee / tank / mixed: closer is better, period.
    score -= dTarget;
  }

  // Tiebreaker: prefer cells near current position (axis-aligned via euclidean).
  const dx = pos.x - creature.position.x;
  const dy = pos.y - creature.position.y;
  const dFromCurrent = Math.sqrt(dx * dx + dy * dy) * 5;
  score -= dFromCurrent * 0.01;

  return score;
}

/**
 * Cache for archetype detection - same creature can be queried many
 * times per turn during dispersion scoring. The map is per-call (built
 * inside chooseSmartDestination) so it doesn't bleed across turns.
 */
type ArchetypeCache = Map<string, MovementArchetype>;

function archetypeOf(c: Creature, cache: ArchetypeCache): MovementArchetype {
  let cached = cache.get(c.id);
  if (cached === undefined) {
    cached = deriveProfile(c).archetype;
    cache.set(c.id, cached);
  }
  return cached;
}

/**
 * Mob-dispersion score: penalty for clustering with other ranged
 * allies, but ONLY when the ranged allies outnumber melee enemies
 * (the case where each enemy can only chase one ally per turn, so
 * fanning out forces them to commit to one target while the rest
 * fire freely).
 *
 * Below the outnumbering threshold, dispersion returns 0 - clustering
 * for mutual support is fine when you're already at a numerical
 * disadvantage.
 *
 * Pairwise check: penalty per nearby ranged ally, scaling with how
 * close they are. The optimizer picks cells that minimize this sum,
 * naturally producing a fanned formation across the team.
 */
function dispersionScore(
  pos: { x: number; y: number },
  _creature: Creature,
  profile: MovementProfile,
  allies: Creature[],
  enemies: Creature[],
  cache: ArchetypeCache,
): number {
  if (profile.archetype !== 'ranged' && profile.archetype !== 'caster') return 0;

  const meleeEnemyCount = enemies.filter(e => maxMeleeReach(e) > 0).length;
  const rangedAllies = allies.filter(a => {
    const arch = archetypeOf(a, cache);
    return arch === 'ranged' || arch === 'caster';
  });
  // Include self in the ranged count for the threshold test.
  const rangedAllyCount = rangedAllies.length + 1;
  if (rangedAllyCount <= meleeEnemyCount) return 0;

  let penalty = 0;
  for (const ally of rangedAllies) {
    const d = cellDistance(pos, ally.position);
    // Only penalize tight stacking (adjacent or 1 cell apart). At 10+ ft,
    // teammates can still benefit from Pack Tactics, healing reach, etc.,
    // and forcing wider spread breaks formation play.
    if (d < 10) penalty -= 40;
  }
  return penalty;
}

/**
 * Opportunity-attack risk. If the creature is currently inside a melee
 * enemy's reach AND the candidate cell is outside that reach, moving
 * provokes an OA. Each provocation costs the creature ~one melee swing
 * worth of HP, modeled here as a fixed 7-damage hit (the median for
 * common melee enemies' best attack). For each provoking enemy:
 * subtract their hit-adjusted expected damage.
 */
function oaRiskPenalty(
  pos: { x: number; y: number },
  creature: Creature,
  enemies: Creature[],
): number {
  // Creatures with Nimble Escape (or Rogue Cunning Action) Disengage for
  // free as a bonus action. They never provoke OAs from movement.
  const freeDisengage =
    creature.monsterData.heroClass === 'Rogue'
    || hasActiveTrait(creature, 'Nimble Escape');
  if (freeDisengage) return 0;

  let penalty = 0;
  for (const enemy of enemies) {
    const reach = maxMeleeReach(enemy);
    if (reach === 0) continue;
    const currentDist = distanceToFootprint(creature.position, enemy);
    if (currentDist > reach) continue;  // not in melee with this enemy
    const newDist = distanceToFootprint(pos, enemy);
    if (newDist <= reach) continue;  // staying in melee, no OA
    // Provokes OA. Estimate cost as the enemy's best melee attack EV.
    let bestEV = 0;
    for (const a of getActiveActions(enemy) || []) {
      if (a.type !== 'melee' && a.type !== undefined) continue;
      if (a.attackBonus === undefined) continue;
      // Inline EV: averageDamage of dice + advantage rider on hit, vs
      // creature's AC. For the AI's purposes a generic AC 14 lookup is
      // close enough - keeps the helper local.
      const baseDice = a.damage || '0';
      const m = baseDice.match(/(\d+)d(\d+)([+-]\d+)?/);
      const avg = m
        ? (parseInt(m[1], 10) * (parseInt(m[2], 10) + 1) / 2) + (m[3] ? parseInt(m[3], 10) : 0)
        : 0;
      const toHit = a.attackBonus;
      const hitRate = Math.max(0.05, Math.min(0.95, (21 - (creature.monsterData.ac - toHit)) / 20));
      bestEV = Math.max(bestEV, avg * hitRate);
    }
    penalty -= bestEV;
  }
  return penalty;
}

/**
 * Pack Tactics scoring: creatures with the trait want either to be
 * adjacent to the target themselves (so allies' attacks gain
 * advantage), OR to have an ally already adjacent (so they can shoot
 * from range with advantage).
 *
 *   - If an ally will already be within 5 ft of the target after this
 *     turn (we approximate "after this turn" with current positions -
 *     each creature decides without knowing what the others do),
 *     I get advantage from any cell. No spatial bonus.
 *   - If no ally is adjacent and I AM adjacent at this candidate,
 *     I become the PT provider for the team. Big bonus.
 *   - Otherwise: mild pull toward melee, scaled by distance, so the
 *     closest goblin to the target naturally walks in to provide PT
 *     while the rest stay back and shoot.
 *
 * For non-PT creatures: returns 0.
 */
function packTacticsBonus(
  pos: { x: number; y: number },
  creature: Creature,
  target: Creature,
  profile: MovementProfile,
  allies: Creature[],
): number {
  if (!profile.hasPackTactics) return 0;

  const allyAdjacentToTarget = allies.some(a =>
    distanceToFootprint(a.position, target) <= 5,
  );

  if (allyAdjacentToTarget) {
    // Some ally already provides PT. Any of MY positions gets advantage
    // on attacks. Don't bias position spatially - let the kite-zone
    // and distance scoring decide where I should stand.
    return 0;
  }

  const myCandidateDist = distanceToFootprint(pos, target);
  if (myCandidateDist <= 5) {
    // I become the PT provider. Whole team gets advantage on attacks.
    // Strong bonus that overrides kite-zone "stay outside reach".
    return 40;
  }

  // No PT yet, and this candidate isn't adjacent. Small pull toward
  // melee so the closest creature drifts in to provide PT.
  // Inversely scaled by current distance: the closest goblin feels
  // the strongest pull.
  const myCurrentDist = distanceToFootprint(creature.position, target);
  if (myCurrentDist <= 30) {
    // Within ~6-cell move-budget of the target - could plausibly reach.
    return -myCandidateDist * 0.2;
  }
  return 0;
}

/**
 * Mild penalty for cells very close to the map edge - prevents
 * the optimizer from picking corner cells that are technically high-
 * scoring but trap the creature in subsequent turns.
 */
function edgePenalty(
  pos: { x: number; y: number },
  state: BattleState,
): number {
  const gs = state.gridSize ?? 20;
  const minDist = Math.min(pos.x, pos.y, gs - 1 - pos.x, gs - 1 - pos.y);
  if (minDist === 0) return -10;  // on edge
  if (minDist === 1) return -3;
  return 0;
}

/**
 * Score a candidate destination cell.
 *
 * Components active in PR B: distance (with kite-zone math), dispersion,
 * edge. cover / oaRisk / allyAffinity stay at 0 - wired in PR C/D.
 */
export function scoreCandidate(
  pos: { x: number; y: number },
  creature: Creature,
  target: Creature,
  profile: MovementProfile,
  state: BattleState,
  enemies: Creature[],
  allies: Creature[],
  archetypeCache: ArchetypeCache,
): MoveCandidate {
  const components = {
    distance: distanceScore(pos, creature, target, profile, state, enemies),
    cover: 0,
    oaRisk: oaRiskPenalty(pos, creature, enemies),
    allyAffinity: 0,
    dispersion: dispersionScore(pos, creature, profile, allies, enemies, archetypeCache),
    edge: edgePenalty(pos, state),
    packTactics: packTacticsBonus(pos, creature, target, profile, allies),
  };
  const w = profile.weights;
  const total =
    components.distance * w.distance +
    components.cover * w.cover +
    components.oaRisk * w.oaRisk +
    components.allyAffinity * w.allyAffinity +
    components.dispersion * w.dispersion +
    components.edge * w.edge +
    components.packTactics * w.packTactics;
  return { pos: { ...pos }, total, components };
}

/**
 * Add the chebyshev shell of cells at exactly `distance` cells from
 * the target's footprint. Handles multi-cell targets correctly.
 * Skips cells that fail bounds / blocked filtering via the supplied
 * `tryAdd` callback.
 */
function addShell(
  target: Creature,
  distance: number,
  tryAdd: (x: number, y: number) => void,
): void {
  const fp = getFootprintSize(getActiveSize(target));
  const minX = target.position.x - distance;
  const maxX = target.position.x + fp - 1 + distance;
  const minY = target.position.y - distance;
  const maxY = target.position.y + fp - 1 + distance;
  // Top + bottom rows (full width)
  for (let x = minX; x <= maxX; x++) {
    tryAdd(x, minY);
    if (maxY !== minY) tryAdd(x, maxY);
  }
  // Left + right columns (excluding the corners we already covered)
  for (let y = minY + 1; y < maxY; y++) {
    tryAdd(minX, y);
    if (maxX !== minX) tryAdd(maxX, y);
  }
}

/**
 * Generate a small set of candidate destination cells. The candidate
 * count is intentionally bounded (target ~30) so per-turn scoring stays
 * cheap enough for 10K-trial Monte Carlo runs.
 *
 * Seeds:
 *   - Current position (so "stay put" is always evaluated)
 *   - 8 neighbors of the current position (graceful local moves)
 *   - Shells around the target footprint at chebyshev distances 1, 3,
 *     5, 7 (= 5 / 15 / 25 / 35 ft). PR B will replace this with
 *     kite-zone-aware shell selection; PR A uses fixed engagement
 *     distances.
 *
 * Filtered to:
 *   - On the grid
 *   - Not blocked by terrain (flyers ignore chasms)
 *   - Not blocked by other creatures
 */
export function generateCandidates(
  creature: Creature,
  target: Creature,
  state: BattleState,
): { x: number; y: number }[] {
  const seen = new Set<string>();
  const out: { x: number; y: number }[] = [];
  const fp = getFootprintSize(getActiveSize(creature));
  const isFlying = state.movementEnvironment !== 'underwater' && (getActiveSpeed(creature).fly ?? 0) > 0;
  const blocked = isFlying ? state.terrainSightBlocked : state.terrainBlocked;
  const gs = state.gridSize ?? 20;

  const tryAdd = (x: number, y: number) => {
    if (x < 0 || y < 0 || x + fp > gs || y + fp > gs) return;
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    if (isPositionBlocked({ x, y }, getActiveSize(creature), state.creatures, creature.id, blocked)) return;
    seen.add(key);
    out.push({ x, y });
  };

  // Current position - "stay put" baseline.
  tryAdd(creature.position.x, creature.position.y);

  // 8 neighbors of the current position - cheap incremental moves.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      tryAdd(creature.position.x + dx, creature.position.y + dy);
    }
  }

  // Shells around the target's footprint at typical engagement distances.
  for (const distance of [1, 3, 5, 7]) {
    addShell(target, distance, tryAdd);
  }

  return out;
}

/**
 * `moveToward` calls `findPath`, which stops at chebyshev distance 1
 * from its `target` argument (so the creature lands "adjacent to" the
 * target rather than on it). When chooseSmartDestination wants the
 * creature to END UP exactly at cell C, we have to pass `C + 1 step
 * in the direction away from the creature` so the pathfinder's stop
 * condition lands the creature on C.
 *
 * Equivalent to nearestFootprintEdge's effect for the legacy
 * "destination = enemy cell" case: passing the enemy's cell as
 * target made the pathfinder stop adjacent, putting the creature in
 * melee. Now we generalize it.
 */
function pathfinderTargetFor(
  creature: Creature,
  idealCell: { x: number; y: number },
): { x: number; y: number } {
  const dx = Math.sign(idealCell.x - creature.position.x);
  const dy = Math.sign(idealCell.y - creature.position.y);
  // Already at the chosen cell (or no motion direction): just return
  // the cell itself; pathfinder will be a no-op.
  if (dx === 0 && dy === 0) return { ...idealCell };
  return { x: idealCell.x + dx, y: idealCell.y + dy };
}

/**
 * Public entry point: pick the best destination for a creature's turn.
 * The pathfinder still does the actual walk via moveToward.
 *
 * PR B: drives destination selection from the candidate scorer.
 *  1. Derive archetype profile (per-archetype weights + bestRangedNormal).
 *  2. Generate ~30-150 candidate cells via shells around the target.
 *  3. Score each via distance / dispersion / edge (cover / oaRisk /
 *     allyAffinity wired in PR C/D).
 *  4. Pick the highest-scoring "ideal end position."
 *  5. Convert to a pathfinder target so moveToward lands the creature
 *     ON the ideal cell (instead of one short of it).
 */
export function chooseSmartDestination(
  creature: Creature,
  target: Creature,
  state: BattleState,
): { x: number; y: number } {
  const profile = deriveProfile(creature);
  const candidates = generateCandidates(creature, target, state);
  if (candidates.length === 0) return { ...creature.position };

  const enemies: Creature[] = [];
  const allies: Creature[] = [];
  for (const c of state.creatures) {
    if (!c.isAlive) continue;
    if (c.id === creature.id) continue;
    if (c.team === creature.team) allies.push(c);
    else enemies.push(c);
  }

  const archetypeCache: ArchetypeCache = new Map();

  let best: MoveCandidate | null = null;
  for (const c of candidates) {
    const scored = scoreCandidate(c, creature, target, profile, state, enemies, allies, archetypeCache);
    if (!best || scored.total > best.total) best = scored;
  }
  if (!best) return { ...creature.position };
  return pathfinderTargetFor(creature, best.pos);
}
