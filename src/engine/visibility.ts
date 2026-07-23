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

/** Geometric visibility, intentionally ignoring an existing Hide result. */
export function canSeeCreatureIgnoringHide(state: BattleState, observer: Creature, target: Creature): boolean {
  if (magicalDarknessBlocksSight(state.darknessZones, state.round, observer, target)) return false;
  const sightBlocked = state.terrainSightBlocked;
  if (!sightBlocked?.size) return true;
  return !lineOfSightBlocked(
    observer.position,
    target.position,
    getFootprintSize(observer.wildShape?.size ?? observer.temporarySize ?? observer.monsterData.size),
    getFootprintSize(target.wildShape?.size ?? target.temporarySize ?? target.monsterData.size),
    sightBlocked,
  );
}

/** Whether the observer can pinpoint a grounded creature with temporary Tremorsense. */
export function canDetectWithTremorsense(observer: Creature, target: Creature): boolean {
  const range = Math.max(0, ...(observer.activeBuffs ?? []).map(buff => buff.tremorsenseRange ?? 0));
  if (!range || observer.airborne || target.airborne) return false;
  const observerCenter = footprintCenter(observer.position, getFootprintSize(observer.wildShape?.size ?? observer.temporarySize ?? observer.monsterData.size));
  const targetCenter = footprintCenter(target.position, getFootprintSize(target.wildShape?.size ?? target.temporarySize ?? target.monsterData.size));
  return Math.max(Math.abs(observerCenter.x - targetCenter.x), Math.abs(observerCenter.y - targetCenter.y)) * 5 <= range;
}

/** Remove Hide results as soon as the named observer regains clear sight. */
export function revealVisibleHiddenCreatures(state: BattleState): void {
  for (const creature of state.creatures) {
    if (!creature.activeBuffs?.length) continue;
    creature.activeBuffs = creature.activeBuffs.filter(buff => {
      if (!buff.key.startsWith('hidden-from:')) return true;
      const observer = state.creatures.find(candidate => candidate.id === buff.key.slice('hidden-from:'.length));
      return !observer || !observer.isAlive || !canSeeCreatureIgnoringHide(state, observer, creature);
    });
  }
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
