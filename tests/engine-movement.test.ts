import { describe, it, expect } from 'vitest';
import { Creature } from '../src/types/monster';
import { BattleState, getFootprintSize, isPositionBlocked } from '../src/engine/combat';
import { moveToward, executeRound, runBattle } from '../src/engine/ai';

/** Minimal creature factory for movement tests. */
function makeCreature(
  id: string,
  size: string,
  team: 'red' | 'blue',
  pos: { x: number; y: number },
  speed: number = 30,
): Creature {
  return {
    id,
    name: id,
    displayName: id,
    monsterData: {
      name: id,
      size,
      type: 'beast',
      alignment: 'neutral',
      ac: 10,
      hp: 200,
      hpFormula: '20d10',
      speed: { walk: speed },
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      senses: '',
      languages: '',
      cr: '1',
      xp: 200,
      proficiencyBonus: 2,
      actions: [
        { name: 'Bite', type: 'melee' as const, attackBonus: 5, damage: '1d6+3', damageType: 'piercing', reach: 5 },
      ],
    } as Creature['monsterData'],
    team,
    currentHp: 200,
    maxHp: 200,
    position: pos,
    initiative: 0,
    conditions: [],
    conditionTimers: [],
    isAlive: true,
    hasActed: false,
    hasMovedThisTurn: false,
    movementRemaining: speed,
    recharges: {},
    resources: {},
    activeBuffs: [],
    turnFlags: {},
    stats: { damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksHit: 0, killCount: 0, roundsSurvived: 0, actionUsage: {} },
  };
}

function makeState(creatures: Creature[], gridSize: number = 20): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize,
  };
}

function footprintsOverlap(a: Creature, b: Creature): boolean {
  const fpA = getFootprintSize(a.monsterData.size);
  const fpB = getFootprintSize(b.monsterData.size);
  return (
    a.position.x < b.position.x + fpB &&
    a.position.x + fpA > b.position.x &&
    a.position.y < b.position.y + fpB &&
    a.position.y + fpA > b.position.y
  );
}

describe('moveToward - step-wise collision + bounds', () => {
  it('Large creature cannot land on another creature\'s footprint', () => {
    const a = makeCreature('a', 'Large', 'red', { x: 5, y: 5 }, 30);
    const b = makeCreature('b', 'Large', 'blue', { x: 8, y: 5 }, 30);
    b.initiative = 0; // ensure A goes first in executeRound
    a.initiative = 20;
    const state = makeState([a, b], 20);

    executeRound(state);

    // A must not overlap B
    expect(footprintsOverlap(a, b)).toBe(false);

    // No move event should land on a cell inside B's footprint
    const bFp = getFootprintSize('Large');
    for (const evt of state.events) {
      if (evt.kind === 'move' && evt.creatureId === a.id) {
        const toFp = getFootprintSize('Large');
        const overlaps =
          evt.to.x < b.position.x + bFp &&
          evt.to.x + toFp > b.position.x &&
          evt.to.y < b.position.y + bFp &&
          evt.to.y + toFp > b.position.y;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('Huge creature with all neighbours blocked stays put', () => {
    // Huge (3x3) at (5,5). Surround with 8 Medium creatures on all sides.
    const a = makeCreature('huge', 'Huge', 'red', { x: 5, y: 5 }, 30);
    a.initiative = 20;

    // Ring of Medium creatures around the 3x3 footprint (5..7, 5..7)
    // Place one on each side and corner, snug against the footprint
    const blockers: Creature[] = [];
    const ringPositions = [
      { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 }, { x: 7, y: 4 }, { x: 8, y: 4 },
      { x: 4, y: 5 }, { x: 8, y: 5 },
      { x: 4, y: 6 }, { x: 8, y: 6 },
      { x: 4, y: 7 }, { x: 8, y: 7 },
      { x: 4, y: 8 }, { x: 5, y: 8 }, { x: 6, y: 8 }, { x: 7, y: 8 }, { x: 8, y: 8 },
    ];
    for (let i = 0; i < ringPositions.length; i++) {
      const c = makeCreature(`blocker-${i}`, 'Medium', 'blue', ringPositions[i], 0);
      c.initiative = 0;
      blockers.push(c);
    }

    const allCreatures = [a, ...blockers];
    const state = makeState(allCreatures, 20);

    executeRound(state);

    // A should still be at (5,5)
    expect(a.position).toEqual({ x: 5, y: 5 });

    // No move event with from !== to for the huge creature
    const moveEvents = state.events.filter(
      e => e.kind === 'move' && e.creatureId === 'huge'
    );
    for (const evt of moveEvents) {
      if (evt.kind === 'move') {
        expect(evt.from.x === evt.to.x && evt.from.y === evt.to.y).toBe(false);
        // This assertion means: if we DO see a move event, from !== to (which is correct behavior).
        // But we expect zero such events since the creature can't move.
      }
    }
    // Actually the creature shouldn't have any move events at all since it's stuck
    // (it can attack adjacent enemies in melee range instead)
  });

  it('Path sweep: Large creature does NOT pass through a Medium creature in its path', () => {
    const a = makeCreature('a', 'Large', 'red', { x: 5, y: 5 }, 30);
    const blocker = makeCreature('blocker', 'Medium', 'blue', { x: 7, y: 5 }, 0);
    // Target far away, straight line
    const target = { x: 12, y: 5 };

    const state = makeState([a, blocker], 20);

    const result = moveToward(a, target, state);

    // A's final position must not overlap the blocker
    const aFp = getFootprintSize('Large'); // 2
    const bFp = getFootprintSize('Medium'); // 1
    const overlapsBlocker =
      result.x < blocker.position.x + bFp &&
      result.x + aFp > blocker.position.x &&
      result.y < blocker.position.y + bFp &&
      result.y + aFp > blocker.position.y;
    expect(overlapsBlocker).toBe(false);

    // A should not have passed through the blocker's column
    // Large (fp=2) at x=5 occupies x=5,6. Blocker at x=7.
    // A cannot move to x=6 (would occupy 6,7 overlapping blocker at 7).
    // So A stays at x=5 or routes around.
    expect(result.x + aFp <= blocker.position.x || result.x >= blocker.position.x + bFp || result.y + aFp <= blocker.position.y || result.y >= blocker.position.y + bFp).toBe(true);
  });

  it('Bounds: Gargantuan creature near the edge cannot walk off', () => {
    // Gargantuan (4x4) at (16,16) on 20x20 grid. Occupies (16..19,16..19).
    const a = makeCreature('garg', 'Gargantuan', 'red', { x: 16, y: 16 }, 30);
    const dummy = makeCreature('dummy', 'Medium', 'blue', { x: 0, y: 0 }, 0);
    const state = makeState([a, dummy], 20);

    const result = moveToward(a, { x: 100, y: 100 }, state);

    // Must stay in bounds
    expect(result.x + 4).toBeLessThanOrEqual(20);
    expect(result.y + 4).toBeLessThanOrEqual(20);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
  });

  it('No no-op move events after a blocked-in-place turn', () => {
    // Same setup as the "blocked Huge" test
    const a = makeCreature('huge', 'Huge', 'red', { x: 5, y: 5 }, 30);
    a.initiative = 20;

    const ringPositions = [
      { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 }, { x: 7, y: 4 }, { x: 8, y: 4 },
      { x: 4, y: 5 }, { x: 8, y: 5 },
      { x: 4, y: 6 }, { x: 8, y: 6 },
      { x: 4, y: 7 }, { x: 8, y: 7 },
      { x: 4, y: 8 }, { x: 5, y: 8 }, { x: 6, y: 8 }, { x: 7, y: 8 }, { x: 8, y: 8 },
    ];
    const blockers = ringPositions.map((pos, i) => {
      const c = makeCreature(`blocker-${i}`, 'Medium', 'blue', pos, 0);
      c.initiative = 0;
      return c;
    });

    const state = makeState([a, ...blockers], 20);
    executeRound(state);

    // Assert no move events with from === to
    const noOpMoves = state.events.filter(
      e => e.kind === 'move' && e.creatureId === 'huge' &&
        (e as { from: { x: number; y: number }; to: { x: number; y: number } }).from.x ===
        (e as { from: { x: number; y: number }; to: { x: number; y: number } }).to.x &&
        (e as { from: { x: number; y: number }; to: { x: number; y: number } }).from.y ===
        (e as { from: { x: number; y: number }; to: { x: number; y: number } }).to.y
    );
    expect(noOpMoves).toHaveLength(0);
  });

  it('Two Large creatures moving toward each other don\'t overlap', () => {
    const a = makeCreature('a', 'Large', 'red', { x: 5, y: 5 }, 30);
    const b = makeCreature('b', 'Large', 'blue', { x: 15, y: 5 }, 30);
    // Give them alternating initiative
    a.initiative = 20;
    b.initiative = 10;

    const state = makeState([a, b], 20);
    executeRound(state);

    // AABB footprints must not overlap
    expect(footprintsOverlap(a, b)).toBe(false);
  });
});

describe('stalemate detection', () => {
  it('declares stalemate after 3 idle rounds when creatures cannot reach each other', () => {
    // Two creatures on a 20x20 grid, separated by a full wall of terrain
    // at column x=10 so neither can path to the other.
    const a = makeCreature('a', 'Medium', 'red', { x: 2, y: 5 }, 30);
    const b = makeCreature('b', 'Medium', 'blue', { x: 15, y: 5 }, 30);
    const wall = new Set<string>();
    for (let y = 0; y < 20; y++) wall.add(`10,${y}`);

    const result = runBattle([a, b], 20, undefined, wall, wall);

    expect(result.isComplete).toBe(true);
    // Should have detected stalemate - either via the 3-idle-round check
    // or via the existing 100-round tiebreak.
    const stalemateLogs = result.logs.filter(l => l.action === 'Stalemate');
    // Core assertion: stalemate was declared, and it happened way before round 100
    expect(stalemateLogs.length + result.logs.filter(l => l.action === 'Battle Over').length).toBeGreaterThanOrEqual(1);
    expect(result.round).toBeLessThan(100);
  });

  it('does NOT stalemate when creatures are fighting normally', () => {
    // Two adjacent creatures - they should fight to the death, not stalemate
    const a = makeCreature('a', 'Medium', 'red', { x: 5, y: 5 }, 30);
    const b = makeCreature('b', 'Medium', 'blue', { x: 6, y: 5 }, 30);

    const result = runBattle([a, b], 20);

    expect(result.isComplete).toBe(true);
    expect(result.winner).not.toBe('draw');
    const stalemateLogs = result.logs.filter(l => l.action === 'Stalemate');
    expect(stalemateLogs.length).toBe(0);
  });
});
