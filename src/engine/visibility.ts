import type { Creature, DarknessZone } from '../types/monster.js';
import { bresenhamLine, footprintCenter, lineOfSightBlocked } from '../types/terrain.js';
import { getFootprintSize } from './combat-geometry.js';
import type { BattleState } from './combat.js';

function canSeeThroughMagicalDarkness(creature: Creature): boolean {
  return /unimpeded by magical darkness/i.test(creature.monsterData.senses ?? '');
}

/**
 * True when a magical-darkness zone intersects the observer's sight line.
 * The engine uses Chebyshev grid distance for spheres, so a zone is tested
 * against the same square-grid geometry used by other area effects.
 */
export function magicalDarknessBlocksSight(
  zones: DarknessZone[] | undefined,
  round: number,
  observer: Creature,
  target: Creature | { position: { x: number; y: number }; monsterData?: { size?: string } },
): boolean {
  if (!zones?.length || canSeeThroughMagicalDarkness(observer)) return false;
  const observerCenter = footprintCenter(observer.position, getFootprintSize(observer.wildShape?.size ?? observer.temporarySize ?? observer.monsterData.size));
  const targetCenter = footprintCenter(target.position, getFootprintSize(target.monsterData?.size ?? 'Medium'));
  const cells = bresenhamLine(observerCenter.x, observerCenter.y, targetCenter.x, targetCenter.y);
  return zones.some(zone => zone.endRound > round && cells.some(([x, y]) =>
    Math.max(Math.abs(x - zone.x), Math.abs(y - zone.y)) * 5 <= zone.radius
  ));
}

/** True when an observer can see a map point through walls and magical darkness. */
export function canSeePoint(
  state: BattleState,
  observer: Creature,
  point: { x: number; y: number },
): boolean {
  if (magicalDarknessBlocksSight(state.darknessZones, state.round, observer, { position: point })) return false;
  const sightBlocked = state.terrainSightBlocked;
  if (!sightBlocked?.size) return true;
  return !lineOfSightBlocked(
    observer.position,
    point,
    getFootprintSize(observer.wildShape?.size ?? observer.temporarySize ?? observer.monsterData.size),
    1,
    sightBlocked,
  );
}
