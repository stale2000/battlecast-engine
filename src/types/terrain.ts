/**
 * Terrain types for BattleCast map presets.
 *
 * Shipped in the "blocked terrain" PR (2026-04-12). This first pass
 * handles only movement blocking. Line-of-sight, elevation, and
 * difficult-terrain movement cost are coming in follow-up PRs, but
 * the type distinguishes walls from chasms from day one so the
 * annotated map data doesn't need to change when LoS lands.
 *
 * - **wall** - structural obstacle. Blocks movement AND (will block)
 *   line of sight. Stone walls, cottage walls, solid rock pillars,
 *   thick tree trunks.
 * - **chasm** - open hazard space. Blocks movement but NOT line of
 *   sight - you can see (and shoot) across it. Lava, deep water,
 *   cliff edges, bottomless pits.
 */
export type TerrainKind = 'wall' | 'chasm' | 'difficult' | 'half-cover' | 'three-quarters-cover' | 'total-cover';

/**
 * A single terrain cell in a sparse map annotation. Maps typically
 * have 0-60 of these for a 20×20 grid; most cells are normal open
 * terrain and absent from the array.
 */
export interface TerrainCell {
  x: number;
  y: number;
  kind: TerrainKind;
}

/**
 * True if a creature cannot move into / through this terrain kind.
 * Both walls and chasms block movement in this version; they'll
 * diverge on line-of-sight in a later PR.
 */
export function blocksMovement(kind: TerrainKind): boolean {
  return kind === 'wall' || kind === 'chasm';
}

/**
 * True if ranged attacks cannot pass through this terrain kind.
 * Walls block sight, chasms don't. Not yet consumed by the engine -
 * the next PR will wire `blocksLineOfSight` into ranged-attack
 * resolution. Exported now so the type surface stays stable.
 */
export function blocksLineOfSight(kind: TerrainKind): boolean {
  return kind === 'wall' || kind === 'total-cover';
}

export function buildDifficultTerrainSet(terrain?: TerrainCell[]): Set<string> {
  return new Set((terrain ?? []).filter(cell => cell.kind === 'difficult').map(cell => `${cell.x},${cell.y}`));
}

export function buildCoverMap(terrain?: TerrainCell[]): Record<string, 2 | 5> {
  const cover: Record<string, 2 | 5> = {};
  for (const cell of terrain ?? []) {
    if (cell.kind === 'half-cover') cover[`${cell.x},${cell.y}`] = 2;
    if (cell.kind === 'three-quarters-cover') cover[`${cell.x},${cell.y}`] = 5;
  }
  return cover;
}

export function coverLevelBetween(
  from: { x: number; y: number }, to: { x: number; y: number }, fromFp: number, toFp: number,
  cover: Record<string, 2 | 5> | undefined,
): 0 | 2 | 5 {
  if (!cover || Object.keys(cover).length === 0) return 0;
  const a = footprintCenter(from, fromFp);
  const b = footprintCenter(to, toFp);
  let best: 0 | 2 | 5 = 0;
  for (const [x, y] of bresenhamLine(a.x, a.y, b.x, b.y)) {
    if ((x === a.x && y === a.y) || (x === b.x && y === b.y)) continue;
    best = Math.max(best, cover[`${x},${y}`] ?? 0) as 0 | 2 | 5;
  }
  return best;
}

/**
 * Build a fast `"x,y"`-keyed Set of cells that block movement, for
 * O(1) lookups in hot paths (moveToward runs many times per battle).
 * Returns an empty Set for an empty or undefined terrain array.
 */
export function buildMovementBlockedSet(terrain?: TerrainCell[]): Set<string> {
  const set = new Set<string>();
  if (!terrain) return set;
  for (const t of terrain) {
    if (blocksMovement(t.kind)) set.add(`${t.x},${t.y}`);
  }
  return set;
}

/**
 * Same idea as buildMovementBlockedSet but only includes cells that
 * block line of sight (walls, not chasms). A chasm - lava, water,
 * pit - blocks a creature from walking but not from seeing / shooting
 * across it. Used for ranged-attack LoS checks in resolveAttack and
 * AI target selection.
 */
export function buildSightBlockedSet(terrain?: TerrainCell[]): Set<string> {
  const set = new Set<string>();
  if (!terrain) return set;
  for (const t of terrain) {
    if (blocksLineOfSight(t.kind)) set.add(`${t.x},${t.y}`);
  }
  return set;
}

/**
 * Trace cells from (x0, y0) to (x1, y1) inclusive using Bresenham's
 * line algorithm. Used by the LoS check; exported as its own function
 * so tests can verify the line math independently of wall lookup.
 */
export function bresenhamLine(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  // Safety bound - a sane battle grid won't exceed ~60 cells on a side,
  // so 200 iterations is more than enough and guards against runaway.
  for (let i = 0; i < 200; i++) {
    cells.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return cells;
}

/**
 * Pick the "center" grid cell of a creature's footprint for LoS
 * math. For a 1×1 creature the center is its position. For larger
 * footprints we use `pos + floor(fp/2)` which lands roughly at the
 * center-bottom-right of the footprint - good enough for a top-down
 * grid, and it's the same cell every time so LoS is deterministic.
 */
export function footprintCenter(pos: { x: number; y: number }, footprintSize: number): { x: number; y: number } {
  const o = Math.floor(footprintSize / 2);
  return { x: pos.x + o, y: pos.y + o };
}

/**
 * Returns true if a line from attacker center to target center passes
 * through any sight-blocking cell (wall). Cells inside either
 * creature's footprint are excluded - a troll standing IN a doorway
 * can still see out, and its own footprint doesn't block its own
 * attacks.
 *
 * Chasms deliberately don't appear in `sightBlocked`; you can shoot
 * across a lava pool or river but not walk through it.
 */
export function lineOfSightBlocked(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromFp: number,
  toFp: number,
  sightBlocked: Set<string>,
): boolean {
  if (sightBlocked.size === 0) return false;
  const a = footprintCenter(from, fromFp);
  const b = footprintCenter(to, toFp);
  const cells = bresenhamLine(a.x, a.y, b.x, b.y);
  // Helper for "is this cell inside either footprint?" - excluded
  // so the creatures don't block their own sight.
  const inFromFp = (x: number, y: number) =>
    x >= from.x && x < from.x + fromFp && y >= from.y && y < from.y + fromFp;
  const inToFp = (x: number, y: number) =>
    x >= to.x && x < to.x + toFp && y >= to.y && y < to.y + toFp;
  for (const [x, y] of cells) {
    if (inFromFp(x, y) || inToFp(x, y)) continue;
    if (sightBlocked.has(`${x},${y}`)) return true;
  }
  return false;
}

/**
 * Author terrain as a readable ASCII grid and compile to TerrainCell[].
 * This is MUCH more ergonomic than hand-typing {x, y, kind} tuples for
 * 16×16 or 24×24 maps - you can see the map at a glance and tweak a
 * cell by editing a single character.
 *
 * Grammar:
 *   `.` or ` ` → open (no cell emitted)
 *   `W`       → wall   (blocks movement + sight)
 *   `C`       → chasm  (blocks movement, not sight - lava, water, pit)
 *   `D`       → difficult terrain, `H` → half cover, `Q` → three-quarters cover,
 *   `T`       → total cover
 *
 * Leading/trailing whitespace and blank lines are stripped. Each row's
 * characters correspond left-to-right to grid x coordinates; each row
 * (top-to-bottom) corresponds to increasing y.
 *
 * Example (3×3 - a wall running top-to-bottom with a lava pit in the
 * bottom-right corner):
 *
 *     parseTerrainMask(`
 *       .W.
 *       .W.
 *       .WC
 *     `)
 *
 * Rows shorter than the widest row are right-padded with `.` (open),
 * so ragged input is safe - just paste the map and go.
 */
export function parseTerrainMask(mask: string): TerrainCell[] {
  const cells: TerrainCell[] = [];
  const rows = mask.split('\n').map(r => r.trim()).filter(r => r.length > 0);
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === 'W') cells.push({ x, y, kind: 'wall' });
      else if (ch === 'C') cells.push({ x, y, kind: 'chasm' });
      else if (ch === 'D') cells.push({ x, y, kind: 'difficult' });
      else if (ch === 'H') cells.push({ x, y, kind: 'half-cover' });
      else if (ch === 'Q') cells.push({ x, y, kind: 'three-quarters-cover' });
      else if (ch === 'T') cells.push({ x, y, kind: 'total-cover' });
      // '.' and ' ' and anything else → open (no cell)
    }
  }
  return cells;
}
