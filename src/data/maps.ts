import { parseTerrainMask, type TerrainCell } from '../types/terrain.js';

/**
 * Map presets - background images that paint under the battle grid. Each
 * map has a recommended grid size (the app will offer to resize on load
 * if the current setup differs and has creatures placed).
 *
 * Shipped images live at `/public/maps/<slug>.webp` (full) and
 * `/public/maps/thumbs/<slug>.webp` (card thumbnail). Annotate terrain
 * via the dev-only `/maps-editor` route.
 */
export interface MapPreset {
  id: string;
  title: string;
  description: string;
  /** Recommended grid size - app offers to resize on load if it differs. */
  gridSize: number;
  /**
   * URL for the full-size battle background, or null for a blank grid.
   * Null means BattleGrid draws the default white play area with no
   * painted scene (the classic pre-maps behavior, still useful for
   * theorycraft / Monte Carlo where map art would distract).
   */
  image: string | null;
  /**
   * URL for the 256x256 modal card thumbnail, or null for blank grids.
   * Null -> MapsModal renders a CSS-drawn grid pattern placeholder.
   */
  thumb: string | null;
  /** Category tags - for filtering / badge colors. */
  tags: ('outdoor' | 'indoor' | 'urban' | 'wild' | 'blank')[];
  /** Human-readable grouping for the grid-size badge. */
  sizeLabel: 'Small' | 'Standard' | 'Large' | 'Huge';
  /**
   * Sparse list of non-normal cells (walls, chasms). Absent or empty
   * means the whole map is open terrain. Coordinates are grid cells
   * (0..gridSize-1). See `src/types/terrain.ts` for the kind semantics.
   */
  terrain?: TerrainCell[];
}

/**
 * The id of the map that loads on first visit. Grass Plain is chosen
 * because its 20x20 size matches the default grid size, it's neutral,
 * and the clean palette won't distract from creature tokens. useBattle
 * imports this to seed its initial mapId / mapImage state.
 */
export const DEFAULT_MAP_ID = 'grass-plain';

export const maps: MapPreset[] = [
  {
    id: 'forest-clearing',
    title: 'Forest Clearing',
    description: 'Open meadow ringed by dense pines. Boulders and fallen logs for cover.',
    gridSize: 16,
    image: '/maps/forest-clearing.webp',
    thumb: '/maps/thumbs/forest-clearing.webp',
    tags: ['outdoor', 'wild'],
    sizeLabel: 'Small',
    terrain: parseTerrainMask(`
      WWWWWWWWWWWWWWWW
      WWWWW.......WWWW
      WWWWW.........WW
      WWW...........WW
      WW.....CCC....WW
      W....C..........
      W....C..........
      W....C....CC...W
      WW........CC..WW
      WW............WW
      .............WWW
      ............WWWW
      ............WWWW
      ............WWWW
      ............WW..
      ................
    `),
  },
  {
    id: 'stone-bridge',
    title: 'Stone Bridge',
    description: 'An arch bridge over a rushing river. A chokepoint where formation matters.',
    gridSize: 20,
    image: '/maps/stone-bridge.webp',
    thumb: '/maps/thumbs/stone-bridge.webp',
    tags: ['outdoor', 'wild'],
    sizeLabel: 'Standard',
    terrain: parseTerrainMask(`
      WWWW........CCCC.WWW
      WWWW...WW...CCCC.WWW
      WWWW.......CCCCC.WWW
      WWW.......CCCCC...WW
      ..........CCC.......
      ..........CC........
      WW........CC........
      WWW......CCC........
      WW....CCCCCCC.......
      ....................
      ....................
      ......CCCCCCC.....WW
      ........CCCC......WW
      ........CCC.........
      .......CCCC.........
      ......CCCCC.........
      WW....CCCCC.WW......
      WWW...CCCCC.WW......
      WWW...CCCCC.......WW
      WW....CCCCC.......WW
    `),
  },
  {
    id: 'grass-plain',
    title: 'Grass Plain',
    description: 'Open grassland with no obstacles. Used by the encounter builder for clean party-vs-monsters fights.',
    gridSize: 20,
    image: '/maps/grass-plain.webp',
    thumb: '/maps/thumbs/grass-plain.webp',
    tags: ['outdoor', 'wild'],
    sizeLabel: 'Standard',
  },
  {
    id: 'cave-floor',
    title: 'Cave Floor',
    description: 'Open stone cave floor with no obstacles. Good for underground lairs, lich fights, and dungeon-room tests.',
    gridSize: 20,
    image: '/maps/cave-floor.webp',
    thumb: '/maps/thumbs/cave-floor.webp',
    tags: ['indoor'],
    sizeLabel: 'Standard',
  },
  // Blank grids
  // Classic pre-maps white grid at each size tier. Useful when you want
  // to focus on creature mechanics without a themed background. The
  // MapsModal renders a CSS-drawn grid pattern for these cards since
  // there's no image asset.
  {
    id: 'blank-16',
    title: 'Blank Grid (Small)',
    description: 'Classic white grid. No background, no flavor - just tactics.',
    gridSize: 16,
    image: null,
    thumb: null,
    tags: ['blank'],
    sizeLabel: 'Small',
  },
  {
    id: 'blank-20',
    title: 'Blank Grid (Standard)',
    description: 'Classic white grid. No background, no flavor - just tactics.',
    gridSize: 20,
    image: null,
    thumb: null,
    tags: ['blank'],
    sizeLabel: 'Standard',
  },
  {
    id: 'blank-24',
    title: 'Blank Grid (Large)',
    description: 'Classic white grid. No background, no flavor - just tactics.',
    gridSize: 24,
    image: null,
    thumb: null,
    tags: ['blank'],
    sizeLabel: 'Large',
  },
  {
    id: 'blank-28',
    title: 'Blank Grid (Huge)',
    description: 'Classic white grid. No background, no flavor - just tactics.',
    gridSize: 28,
    image: null,
    thumb: null,
    tags: ['blank'],
    sizeLabel: 'Huge',
  },
];
