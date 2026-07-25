import { Creature, MonsterData } from '../types/monster.js';
import { createCreatureWithFixedHp, getFootprintSize, isPositionBlocked } from '../engine/combat.js';

/**
 * Find valid placement positions for `count` creatures of a given size,
 * confined to a column range within the grid. Returns an array of positions
 * (may be fewer than `count` if space runs out).
 *
 * Row-major scan with footprint stride, skipping blocked cells.
 */
export function findPlacementSlots(
  size: string,
  count: number,
  team: 'red' | 'blue',
  existing: Creature[],
  gridSize: number,
  /**
   * Optional set of `"x,y"`-keyed blocked cells from the active map.
   * When supplied, the scan skips over walls and chasms automatically,
   * so preset creatures land on walkable cells even if the scenario's
   * team zone has terrain.
   */
  terrainBlocked?: Set<string>,
): { x: number; y: number }[] {
  const fp = getFootprintSize(size);
  const stride = fp + 1; // one-cell gap between tokens

  // Team column range (left third for red, right third for blue)
  const xStart = team === 'red' ? 1 : Math.floor(gridSize * 2 / 3) + 1;
  const xEnd = team === 'red' ? Math.floor(gridSize / 3) : gridSize;

  const positions: { x: number; y: number }[] = [];
  // Build a virtual "existing" list that grows as we place
  const placed: Creature[] = [...existing];

  // Row-major scan within team region first, then overflow to full grid
  const scanRegions: { xMin: number; xMax: number }[] = [
    { xMin: xStart, xMax: xEnd },
  ];
  // Overflow: scan full grid if team region is full
  if (xStart > 0 || xEnd < gridSize) {
    scanRegions.push({ xMin: 0, xMax: gridSize });
  }

  for (const region of scanRegions) {
    if (positions.length >= count) break;
    // Estimate how many rows we'll need, then offset Y to center
    // the formation vertically instead of starting at the top edge.
    const regionWidth = Math.max(1, Math.floor((region.xMax - region.xMin) / stride));
    const rowsNeeded = Math.ceil(count / regionWidth);
    const totalHeight = rowsNeeded * stride;
    const yOffset = Math.max(1, Math.floor((gridSize - totalHeight) / 2));

    for (let y = yOffset; y <= gridSize - fp; y += stride) {
      if (positions.length >= count) break;
      for (let x = region.xMin; x <= region.xMax - fp; x += stride) {
        if (positions.length >= count) break;
        const pos = { x, y };
        if (isPositionBlocked(pos, size, placed, undefined, terrainBlocked)) continue;
        positions.push(pos);
        // Add a dummy creature to `placed` so subsequent checks see it
        placed.push({
          id: `__placing_${positions.length}`,
          name: '',
          displayName: '',
          monsterData: { size } as Creature['monsterData'],
          team,
          currentHp: 1,
          maxHp: 1,
          position: pos,
          initiative: 0,
          conditions: [],
          conditionTimers: [],
          isAlive: true,
          hasActed: false,
          hasMovedThisTurn: false,
          movementRemaining: 0,
          recharges: {},
          resources: {},
          activeBuffs: [],
          turnFlags: {},
          stats: { damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksHit: 0, killCount: 0, roundsSurvived: 0, actionUsage: {} },
        });
      }
    }
  }

  return positions;
}

/**
 * Place `count` creatures of the same kind for one team. Builds the
 * Creature objects via createCreatureWithFixedHp so HP is deterministic
 * (no rolling at placement time - matters for share-link reproducibility).
 *
 * `startIdx` is the team-local index used for unique IDs and display
 * names ("Goblin 1", "Goblin 2", ...). Caller increments it across
 * multiple monster types in the same team.
 */
export function placeTeam(
  monsterData: MonsterData,
  team: 'red' | 'blue',
  count: number,
  gridSize: number,
  startIdx: number,
  existing: Creature[],
  terrainBlocked?: Set<string>,
): Creature[] {
  const positions = findPlacementSlots(monsterData.size, count, team, existing, gridSize, terrainBlocked);
  return positions.map((pos, i) =>
    createCreatureWithFixedHp(monsterData, team, pos, startIdx + i)
  );
}

export interface TeamEntry {
  monster: MonsterData;
  count: number;
}

export interface TeamPlacementOptions {
  gridSize: number;
  /** Movement-blocked cells (walls + chasms) for ground creatures. */
  groundBlocked: Set<string> | undefined;
  /** Sight-only blocked cells (walls only) for flying creatures. */
  flyingBlocked: Set<string> | undefined;
}

/**
 * Place every creature in both teams onto the grid, picking the right
 * blocked-cells set per monster based on whether it has a fly speed.
 *
 * Returns the full creature roster ready for `battle.setCreatures(...)`.
 *
 * Used by both the preset loader (handleLoadPreset) and the encounter
 * builder (handleLoadEncounter) - they share the per-team placement
 * loop and the ground-vs-flying terrain split.
 */
export function placeTeams(
  blueTeam: TeamEntry[],
  redTeam: TeamEntry[],
  options: TeamPlacementOptions,
): Creature[] {
  const { gridSize, groundBlocked, flyingBlocked } = options;
  const blockedFor = (md: MonsterData) =>
    (md.speed?.fly ?? 0) > 0 ? flyingBlocked : groundBlocked;

  const allCreatures: Creature[] = [];
  let idx = 0;
  for (const entry of redTeam) {
    const placed = placeTeam(entry.monster, 'red', entry.count, gridSize, idx, allCreatures, blockedFor(entry.monster));
    allCreatures.push(...placed);
    idx += entry.count;
  }
  idx = 0;
  for (const entry of blueTeam) {
    const placed = placeTeam(entry.monster, 'blue', entry.count, gridSize, idx, allCreatures, blockedFor(entry.monster));
    allCreatures.push(...placed);
    idx += entry.count;
  }
  return allCreatures;
}
