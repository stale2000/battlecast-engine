/**
 * AI movement engine. The single authority for creature movement on
 * the grid: every retreat, dash, and approach goes through `moveToward`.
 *
 * What lives here:
 *   - Grid bounds + per-cell collision checks (isInBounds, isValidStep)
 *   - A* pathfinding over the grid, with corner-cut blocking and a
 *     best-effort partial-path return when the full path is blocked
 *   - Spiral-search fallback for creatures that would otherwise freeze
 *     when the direct path is walled off
 *   - Distance helpers (chebyshev) and the "nearest cell within a
 *     large creature's footprint" helper that sets the goal for an
 *     attacker pursuing a 2x2+ target (`nearestFootprintEdge`)
 *   - The public entry point, `moveToward`, which composes all of
 *     the above and produces the single `move` event
 *
 * Contract (see ARCHITECTURE.md - "Movement and collision"):
 *   - `moveToward(creature, target, state)` mutates `creature.position`
 *     AND `creature.movementRemaining`, and appends at most one `move`
 *     event to `state.events`. If no valid step is available it returns
 *     the current position unchanged and emits no event - this file
 *     never pushes a `move` event with `from === to`.
 *
 *   - The collision checker `isPositionBlocked` (from `combat.ts`) is
 *     the companion rule: nothing outside this file should be making
 *     collision decisions. External callers compute destinations
 *     (often via `nearestFootprintEdge`) and hand them to `moveToward`.
 *
 * Why pathfinding lives in ai/ rather than combat/: movement decisions
 * are AI decisions. `combat.ts` owns dice, damage, buffs, and the
 * placement-time `isPositionBlocked` primitive. Everything above that
 * primitive (how a creature chooses a cell to move to, how many steps
 * to spend, how to route around a wall) is behaviour, not mechanics.
 */

import { Creature } from '../types/monster.js';
import { BASE_DURATIONS } from '../types/animation.js';
import { BattleState, getFootprintSize, isPositionBlocked } from './combat.js';

/**
 * Check if a position is within grid bounds for a creature of a given footprint size.
 * If gridSize is not set on state, skip the bounds check.
 */
function isInBounds(pos: { x: number; y: number }, fp: number, gridSize: number | undefined): boolean {
  if (gridSize === undefined) return true;
  return pos.x >= 0 && pos.y >= 0 && pos.x + fp <= gridSize && pos.y + fp <= gridSize;
}

/**
 * Check if a candidate position is valid: not blocked by other creatures,
 * not on blocking terrain (when provided), and within bounds.
 */
function isValidStep(
  pos: { x: number; y: number },
  size: string,
  fp: number,
  creatures: Creature[],
  excludeId: string,
  gridSize: number | undefined,
  terrainBlocked?: Set<string>,
): boolean {
  if (!isInBounds(pos, fp, gridSize)) return false;
  return !isPositionBlocked(pos, size, creatures, excludeId, terrainBlocked);
}

/**
 * Spiral search for a valid cell near a center point (radius 1..maxRadius).
 * Returns the first unblocked, in-bounds cell, or null if none found.
 */
function spiralSearch(
  center: { x: number; y: number },
  size: string,
  fp: number,
  creatures: Creature[],
  excludeId: string,
  gridSize: number | undefined,
  maxRadius: number = 2,
  terrainBlocked?: Set<string>,
): { x: number; y: number } | null {
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // only ring cells
        const candidate = { x: center.x + dx, y: center.y + dy };
        if (isValidStep(candidate, size, fp, creatures, excludeId, gridSize, terrainBlocked)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

/** Chebyshev distance - D&D 5e treats each step as 5 ft whether
 * cardinal or diagonal, so diagonal movement shouldn't cost extra for
 * our movement-budget math. */
function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * A* pathfinding over the grid, respecting terrain + other creatures.
 * Goal is satisfied by ANY cell that's orthogonal-or-diagonal-adjacent
 * to `target`, OR `target` itself - because the caller often passes an
 * enemy's occupied cell as the intended destination. Stopping "next to"
 * the target is the correct move for melee closers.
 *
 * Returns an array of step positions starting from the cell after
 * `from` and ending at the goal cell (truncated to `maxSteps`). Empty
 * array = no reachable path, or the creature is already adjacent.
 *
 * `maxSteps` controls how many steps of the found path are returned -
 * it does NOT limit A*'s search. A* explores freely up to
 * MAX_EXPANSIONS nodes, so it can find paths longer than the creature's
 * current movement budget; the caller just walks the first N steps.
 * This way a slow creature still heads in the right direction across a
 * map 20+ cells wide instead of failing to pathfind.
 *
 * When no full path exists, returns the path to the node CLOSEST to
 * the goal that we managed to reach. This is the "best-effort" move
 * - better than standing still when the ideal path is blocked.
 */
function findPath(
  from: { x: number; y: number },
  target: { x: number; y: number },
  size: string,
  fp: number,
  creatures: Creature[],
  excludeId: string,
  gridSize: number | undefined,
  terrainBlocked: Set<string> | undefined,
  maxSteps: number,
  options: { exactGoal?: boolean } = {},
): Array<{ x: number; y: number }> {
  if (options.exactGoal ? from.x === target.x && from.y === target.y : chebyshev(from, target) <= 1) return [];

  interface Node { x: number; y: number; g: number; f: number; parentKey: string | null }
  const open = new Map<string, Node>();
  const closed = new Set<string>();
  const startKey = `${from.x},${from.y}`;
  open.set(startKey, { x: from.x, y: from.y, g: 0, f: chebyshev(from, target), parentKey: null });

  // We record every node we ever open so we can walk back parents.
  const all = new Map<string, Node>();
  all.set(startKey, open.get(startKey)!);

  // Orthogonals first so chebyshev-tied f-cost cells along the
  // straight line beat diagonals at insertion time. Without this
  // ordering, A* explores NE/NW/SE/SW first and a creature going
  // due east "stairsteps" diagonally before turning back to the
  // target row, instead of walking straight. Diagonal moves still
  // work; they just lose ties to orthogonal moves.
  const DIRS: Array<[number, number]> = [
    [0, -1],   [-1, 0],            [1, 0],   [0, 1],
    [-1, -1],  [1, -1], [-1, 1], [1, 1],
  ];

  let expansions = 0;
  const MAX_EXPANSIONS = 1200; // plenty for 30×30-ish grids

  // Track the best-h node we've seen, so if A* exhausts without
  // reaching the goal we can still return a partial path in the
  // right direction.
  let bestH = chebyshev(from, target);
  let bestKey: string | null = null;

  const buildPath = (endKey: string): Array<{ x: number; y: number }> => {
    const path: Array<{ x: number; y: number }> = [];
    let key: string | null = endKey;
    while (key && key !== startKey) {
      const n = all.get(key);
      if (!n) break;
      path.unshift({ x: n.x, y: n.y });
      key = n.parentKey;
    }
    return path.slice(0, maxSteps);
  };

  while (open.size > 0 && expansions++ < MAX_EXPANSIONS) {
    // Pop lowest-f node. Linear scan is fine at this grid size.
    let currentKey = '';
    let current: Node | null = null;
    for (const [k, n] of open) {
      if (!current || n.f < current.f) { current = n; currentKey = k; }
    }
    if (!current) break;

    const reachedGoal = options.exactGoal
      ? current.x === target.x && current.y === target.y
      : chebyshev(current, target) <= 1;
    if (reachedGoal && !(current.x === from.x && current.y === from.y)) {
      return buildPath(currentKey);
    }

    open.delete(currentKey);
    closed.add(currentKey);

    for (const [dx, dy] of DIRS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const key = `${nx},${ny}`;
      if (closed.has(key)) continue;
      const neighbor = { x: nx, y: ny };
      if (!isValidStep(neighbor, size, fp, creatures, excludeId, gridSize, terrainBlocked)) continue;
      // Block diagonal corner-cutting: if moving diagonally, both
      // orthogonal neighbours must also be passable. Without this a
      // creature can slip between two diagonally-adjacent blocked
      // cells (e.g., squeeze between two chasm cells).
      if (dx !== 0 && dy !== 0) {
        const side1 = { x: current.x + dx, y: current.y };
        const side2 = { x: current.x, y: current.y + dy };
        if (!isValidStep(side1, size, fp, creatures, excludeId, gridSize, terrainBlocked) &&
            !isValidStep(side2, size, fp, creatures, excludeId, gridSize, terrainBlocked)) continue;
      }
      const g = current.g + 1;
      const existing = open.get(key);
      if (existing && existing.g <= g) continue;
      const h = chebyshev(neighbor, target);
      const f = g + h;
      const node: Node = { x: nx, y: ny, g, f, parentKey: currentKey };
      open.set(key, node);
      all.set(key, node);
      if (h < bestH) { bestH = h; bestKey = key; }
    }
  }

  // Exhausted without reaching the goal - return best-effort path
  // toward the closest node we found, so the creature still moves
  // in the right general direction.
  return bestKey ? buildPath(bestKey) : [];
}

/**
 * Returns the cell within the target's footprint closest to `from`.
 * Called by the turn orchestrator to pick the "goal" cell when
 * pursuing a large creature (2x2+). A*'s goal test accepts "adjacent
 * to the goal cell", so the pursuing creature ends up one step away
 * from the target's nearest footprint cell - i.e., in melee reach
 * regardless of which corner of the large footprint is closest.
 */
export function nearestFootprintEdge(from: { x: number; y: number }, target: Creature): { x: number; y: number } {
  const fp = getFootprintSize(target.wildShape?.size ?? target.temporarySize ?? target.monsterData.size);
  if (fp <= 1) return target.position;
  let bestDist = Infinity;
  let best = target.position;
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      const cx = target.position.x + dx;
      const cy = target.position.y + dy;
      const d = Math.max(Math.abs(from.x - cx), Math.abs(from.y - cy));
      if (d < bestDist) { bestDist = d; best = { x: cx, y: cy }; }
    }
  }
  return best;
}

export function reachableMovementDestinations(
  creature: Creature,
  state: BattleState,
): Array<{ x: number; y: number; distanceFt: number }> {
  const maxSquares = Math.floor(creature.movementRemaining / 5);
  if (maxSquares <= 0) return [];
  const from = { ...creature.position };
  const size = creature.wildShape?.size ?? creature.temporarySize ?? creature.monsterData.size;
  const fp = getFootprintSize(size);
  const gridSize = state.gridSize;
  const movementBlocked = movementBlockedSetFor(creature, state);
  const results: Array<{ x: number; y: number; distanceFt: number }> = [];
  for (let y = 0; y <= (gridSize ?? from.y + maxSquares) - fp; y++) {
    for (let x = 0; x <= (gridSize ?? from.x + maxSquares) - fp; x++) {
      const destination = { x, y };
      if ((x === from.x && y === from.y) || chebyshev(from, destination) > maxSquares) continue;
      if (!isValidStep(destination, size, fp, state.creatures, creature.id, gridSize, movementBlocked)) continue;
      const path = findPath(from, destination, size, fp, state.creatures, creature.id, gridSize, movementBlocked, maxSquares, { exactGoal: true });
      if (path.length && path[path.length - 1]?.x === x && path[path.length - 1]?.y === y) results.push({ x, y, distanceFt: path.length * 5 });
    }
  }
  return results.sort((left, right) => left.x - right.x || left.y - right.y);
}

export function moveToDestination(creature: Creature, destination: { x: number; y: number }, state: BattleState): { x: number; y: number } {
  const reachable = reachableMovementDestinations(creature, state);
  if (!reachable.some(cell => cell.x === destination.x && cell.y === destination.y)) return creature.position;
  const from = { ...creature.position };
  const size = creature.wildShape?.size ?? creature.temporarySize ?? creature.monsterData.size;
  const fp = getFootprintSize(size);
  const movementBlocked = movementBlockedSetFor(creature, state);
  const path = findPath(from, destination, size, fp, state.creatures, creature.id, state.gridSize, movementBlocked, Math.floor(creature.movementRemaining / 5), { exactGoal: true });
  creature.position = destination;
  creature.movementRemaining -= path.length * 5;
  state.events.push({ kind: 'move', creatureId: creature.id, from, to: destination, path: path.length > 1 ? [from, ...path] : undefined, durationMs: Math.min(BASE_DURATIONS.move * Math.max(1, path.length / 2), 800) });
  return destination;
}

/**
 * Move `creature` toward `target` using at most its remaining movement
 * budget. Mutates `creature.position` and `creature.movementRemaining`;
 * emits at most one `move` event into `state.events`.
 *
 * Returns the creature's post-move position (which equals its input
 * position when movement didn't happen).
 *
 * Blocked paths are handled gracefully:
 *   - If the full A* path is reachable within budget, walks `maxSquares`
 *     steps along it and stops.
 *   - If the path is partially reachable, walks as far as possible.
 *   - If no path exists, falls back to a small spiral search one step
 *     toward the target so the creature at least shifts in the right
 *     direction - better than freezing against a wall.
 *   - If even the spiral search fails, returns the current position
 *     unchanged and pushes no event.
 *
 * Flying creatures (fly speed > 0) ignore chasm cells but still respect
 * walls (via `state.terrainSightBlocked`). Ground creatures respect the
 * full `state.terrainBlocked` set (walls + chasms).
 */
export function moveToward(creature: Creature, target: { x: number; y: number }, state: BattleState): { x: number; y: number } {
  const speed = creature.movementRemaining;
  const maxSquares = Math.floor(speed / 5);

  if (maxSquares <= 0) return creature.position;

  const from = { ...creature.position };
  const size = creature.wildShape?.size ?? creature.temporarySize ?? creature.monsterData.size;
  const fp = getFootprintSize(size);
  const gridSize = state.gridSize;

  // Flying creatures ignore chasms (open space, not structural), so
  // their movement-block set is walls only. terrainSightBlocked is
  // already "walls only" by definition, so we reuse it here.
  // Ground creatures use the full terrain set (walls + chasms).
  const activeSpeed = creature.wildShape?.speed ?? creature.monsterData.speed;
  const isFlying = (activeSpeed.fly ?? 0) > 0;
  const movementBlocked = isFlying ? state.terrainSightBlocked : state.terrainBlocked;

  // A* finds a path that navigates around walls - the old greedy
  // loop would get stuck against any L-shaped wall. Empty path
  // means: already adjacent, or no reachable route within budget.
  const path = findPath(
    from, target, size, fp,
    state.creatures, creature.id,
    gridSize, movementBlocked, maxSquares,
  );

  let current = { ...from };
  let squaresUsed = 0;
  if (path.length > 0) {
    const dest = path[path.length - 1];
    current = dest;
    squaresUsed = path.length;
  } else if (chebyshev(from, target) > 1) {
    // No path through walls. Try a spiral-search move of 1 square
    // in the general direction of the target so the creature doesn't
    // freeze permanently - they may still be able to pivot around a
    // wall on a later turn.
    const dx = Math.sign(target.x - from.x);
    const dy = Math.sign(target.y - from.y);
    const spiralCenter = { x: from.x + dx, y: from.y + dy };
    const found = spiralSearch(spiralCenter, size, fp, state.creatures, creature.id, gridSize, 2, movementBlocked);
    if (found) {
      // Reject diagonal corner-cutting in the fallback step too
      const fdx = found.x - from.x;
      const fdy = found.y - from.y;
      const cornerBlocked = fdx !== 0 && fdy !== 0 &&
        !isValidStep({ x: from.x + fdx, y: from.y }, size, fp, state.creatures, creature.id, gridSize, movementBlocked) &&
        !isValidStep({ x: from.x, y: from.y + fdy }, size, fp, state.creatures, creature.id, gridSize, movementBlocked);
      if (!cornerBlocked) {
        current = found;
        squaresUsed = chebyshev(from, found);
      }
    }
  }

  if (current.x !== from.x || current.y !== from.y) {
    creature.movementRemaining -= squaresUsed * 5;
    const moveDist = chebyshev(from, current);
    state.events.push({
      kind: 'move',
      creatureId: creature.id,
      from,
      to: current,
      path: path.length > 1 ? [from, ...path] : undefined,
      durationMs: Math.min(BASE_DURATIONS.move * Math.max(1, moveDist / 2), 800),
    });
  }

  return current;
}

function movementBlockedSetFor(creature: Creature, state: BattleState): Set<string> | undefined {
  const activeSpeed = creature.wildShape?.speed ?? creature.monsterData.speed;
  return (activeSpeed.fly ?? 0) > 0 ? state.terrainSightBlocked : state.terrainBlocked;
}
