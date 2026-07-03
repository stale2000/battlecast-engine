/**
 * Pure geometric primitives used throughout combat resolution.
 *
 * Phase 4a refactor: extracted from the original monolithic combat.ts.
 * These functions touch positions, footprints, distances, and area
 * shapes - no battle-state mutation, no random rolls, no logging.
 *
 * combat.ts re-exports each of these so external callers can keep
 * importing from './combat.js'. New callers should import from this file
 * directly.
 */
import { Creature } from '../types/monster.js';

/** Footprint side length, in 5-foot cells, for a given size category. */
export function getFootprintSize(size: string): number {
  switch (size) {
    case 'Large': return 2;
    case 'Huge': return 3;
    case 'Gargantuan': return 4;
    default: return 1; // Medium, Small, Tiny
  }
}

/**
 * Chebyshev distance between two grid cells, in feet.
 * D&D uses 5-foot squares; diagonal movement still costs 5 ft (5e RAW).
 */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return Math.max(dx, dy) * 5;
}

/**
 * Min Chebyshev distance between two creatures' footprints, in feet.
 * Honors size: a Large vs Large at adjacent corners returns 0 ft.
 */
export function creatureDistance(a: Creature, b: Creature): number {
  const fpA = getFootprintSize(a.wildShape?.size ?? a.monsterData.size);
  const fpB = getFootprintSize(b.wildShape?.size ?? b.monsterData.size);
  const dx = Math.max(0, Math.max(a.position.x - (b.position.x + fpB - 1), b.position.x - (a.position.x + fpA - 1)));
  const dy = Math.max(0, Math.max(a.position.y - (b.position.y + fpB - 1), b.position.y - (a.position.y + fpA - 1)));
  return Math.max(dx, dy) * 5;
}

/**
 * Check if placing a creature at `pos` with given size overlaps any
 * existing alive creature OR a blocking terrain cell.
 *
 * `terrainBlocked` is an optional set of `"x,y"` keys (walls + chasms).
 * Omit it for the classic creature-only collision check.
 */
export function isPositionBlocked(
  pos: { x: number; y: number },
  size: string,
  creatures: Creature[],
  excludeId?: string,
  terrainBlocked?: Set<string>,
): boolean {
  const fp = getFootprintSize(size);

  // Terrain check - any footprint cell overlapping a blocked cell
  // rejects the whole position. A Large creature (fp=2) can't straddle
  // a wall even partially.
  if (terrainBlocked && terrainBlocked.size > 0) {
    for (let dy = 0; dy < fp; dy++) {
      for (let dx = 0; dx < fp; dx++) {
        if (terrainBlocked.has(`${pos.x + dx},${pos.y + dy}`)) return true;
      }
    }
  }

  // Creature collision (AABB)
  for (const c of creatures) {
    if (!c.isAlive || c.id === excludeId) continue;
    const cfp = getFootprintSize(c.wildShape?.size ?? c.monsterData.size);
    if (pos.x < c.position.x + cfp && pos.x + fp > c.position.x &&
        pos.y < c.position.y + cfp && pos.y + fp > c.position.y) {
      return true;
    }
  }
  return false;
}

export function isInMeleeRange(attacker: Creature, target: Creature, reach: number = 5): boolean {
  return creatureDistance(attacker, target) <= reach;
}

/**
 * Check if `target` falls inside a 60-degree cone from `origin` aimed
 * at `direction`. Range is in feet; the cone half-angle is 30 degrees
 * (cos check >= cos(pi/6)).
 */
export function isInCone(
  origin: { x: number; y: number },
  direction: { x: number; y: number },
  target: { x: number; y: number },
  rangeFt: number,
): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dist = Math.sqrt(dx * dx + dy * dy) * 5;
  if (dist <= 0 || dist > rangeFt) return false;
  const ddx = direction.x - origin.x;
  const ddy = direction.y - origin.y;
  const dirLen = Math.sqrt(ddx * ddx + ddy * ddy);
  if (dirLen === 0) return dist <= 5;
  const dot = (dx * ddx + dy * ddy) / (Math.sqrt(dx * dx + dy * dy) * dirLen);
  return dot >= Math.cos(Math.PI / 6);
}

/**
 * Check if `target` is inside a line originating from `origin` aimed
 * at `direction`. D&D 5e line: 5 ft wide, range in feet. We accept a
 * perpendicular distance up to 0.7 cells (generous for grid snap) and
 * require the target to be in front of the caster.
 */
export function isInLine(
  origin: { x: number; y: number },
  direction: { x: number; y: number },
  target: { x: number; y: number },
  rangeFt: number,
): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dist = Math.sqrt(dx * dx + dy * dy) * 5;
  if (dist <= 0 || dist > rangeFt) return false;
  const ddx = direction.x - origin.x;
  const ddy = direction.y - origin.y;
  const dirLen = Math.sqrt(ddx * ddx + ddy * ddy);
  if (dirLen === 0) return dist <= 5;
  const dot = (dx * ddx + dy * ddy) / dirLen;
  if (dot < 0) return false;
  const perpDist = Math.abs(dx * ddy - dy * ddx) / dirLen;
  return perpDist <= 0.7;
}

/**
 * Parse a saving-throw `area` string (e.g. "30-foot Cone", "20-foot Sphere",
 * "60-foot Line") into a normalized `{ radius, shape }`. Defaults to a
 * 30-foot sphere when the string is missing or unparseable.
 */
export function parseAoEShape(area: string | undefined): {
  radius: number; shape: 'sphere' | 'cone' | 'line' | 'cylinder';
} {
  const a = (area || '').toLowerCase();
  const m = a.match(/(\d+)-foot/);
  const radius = m ? parseInt(m[1]) : 30;
  const shape: 'sphere' | 'cone' | 'line' | 'cylinder' =
    a.includes('cone') ? 'cone' :
    a.includes('line') ? 'line' :
    a.includes('cylinder') ? 'cylinder' : 'sphere';
  return { radius, shape };
}
