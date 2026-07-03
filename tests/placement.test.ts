import { describe, it, expect } from 'vitest';
import { findPlacementSlots } from '../src/utils/placement';
import { Creature } from '../src/types/monster';
import { getFootprintSize, isPositionBlocked } from '../src/engine/combat';
import { runBattle } from '../src/engine/ai';

function makePlacedCreature(id: string, size: string, team: 'red' | 'blue', pos: { x: number; y: number }): Creature {
  return {
    id,
    name: 'Test',
    displayName: 'Test',
    monsterData: { name: 'Test', size, type: 'beast', alignment: 'neutral', ac: 10, hp: 20, hpFormula: '4d8', speed: { walk: 30 }, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, senses: '', languages: '', cr: '1', xp: 200, proficiencyBonus: 2, actions: [] } as Creature['monsterData'],
    team,
    currentHp: 20,
    maxHp: 20,
    position: pos,
    initiative: 0,
    conditions: [],
    conditionTimers: [],
    isAlive: true,
    hasActed: false,
    hasMovedThisTurn: false,
    movementRemaining: 30,
    recharges: {},
    stats: { damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksHit: 0, killCount: 0, roundsSurvived: 0, actionUsage: {} },
  };
}

describe('findPlacementSlots', () => {
  it('places 4 Large creatures in 20x20 grid without overlap', () => {
    const slots = findPlacementSlots('Large', 4, 'red', [], 20);
    expect(slots).toHaveLength(4);

    // Build creatures from slots and verify no pair overlaps
    const placed: Creature[] = slots.map((pos, i) => makePlacedCreature(`l${i}`, 'Large', 'red', pos));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(isPositionBlocked(placed[j].position, 'Large', [placed[i]])).toBe(false);
      }
    }
  });

  it('places 3 Huge creatures in 18x18 grid without overlap', () => {
    const slots = findPlacementSlots('Huge', 3, 'blue', [], 18);
    expect(slots).toHaveLength(3);

    const placed: Creature[] = slots.map((pos, i) => makePlacedCreature(`h${i}`, 'Huge', 'blue', pos));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(isPositionBlocked(placed[j].position, 'Huge', [placed[i]])).toBe(false);
      }
    }
  });

  it('returns fewer than count when grid cannot fit all', () => {
    // Try to fit 20 Huge (3x3, stride 4) creatures in a tiny 10x10 grid
    const slots = findPlacementSlots('Huge', 20, 'red', [], 10);
    expect(slots.length).toBeLessThan(20);
    expect(slots.length).toBeGreaterThan(0);
  });

  it('respects existing creatures when placing', () => {
    const existing = [makePlacedCreature('e1', 'Large', 'red', { x: 1, y: 1 })];
    const slots = findPlacementSlots('Large', 2, 'red', existing, 20);
    expect(slots).toHaveLength(2);

    // None of the new slots should overlap the existing creature
    for (const pos of slots) {
      expect(isPositionBlocked(pos, 'Large', existing)).toBe(false);
    }
  });

  it('all placed positions fit within grid bounds', () => {
    const slots = findPlacementSlots('Huge', 5, 'red', [], 20);
    const fp = getFootprintSize('Huge');
    for (const pos of slots) {
      expect(pos.x + fp).toBeLessThanOrEqual(20);
      expect(pos.y + fp).toBeLessThanOrEqual(20);
      expect(pos.x).toBeGreaterThanOrEqual(0);
      expect(pos.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('after a simulated battle, no two live creatures overlap', () => {
    const gridSize = 20;
    // Place 2 Large reds and 2 Large blues
    const creatures: Creature[] = [
      makePlacedCreature('r1', 'Large', 'red', { x: 2, y: 2 }),
      makePlacedCreature('r2', 'Large', 'red', { x: 2, y: 8 }),
      makePlacedCreature('b1', 'Large', 'blue', { x: 14, y: 2 }),
      makePlacedCreature('b2', 'Large', 'blue', { x: 14, y: 8 }),
    ];
    // Give them speed and actions for combat
    for (const c of creatures) {
      c.monsterData.speed = { walk: 30 };
      c.monsterData.actions = [
        { name: 'Bite', type: 'melee' as 'melee', attackBonus: 5, damage: '1d6+3', damageType: 'piercing', reach: 5 },
      ];
      c.currentHp = 50;
      c.maxHp = 50;
    }

    const result = runBattle(creatures, gridSize);
    const alive = result.creatures.filter(c => c.isAlive);

    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        expect(isPositionBlocked(alive[j].position, alive[j].monsterData.size, [alive[i]])).toBe(false);
      }
    }

    // Also verify no move events have from === to (no no-op moves)
    for (const evt of result.events) {
      if (evt.kind === 'move') {
        const notNoOp = evt.from.x !== evt.to.x || evt.from.y !== evt.to.y;
        expect(notNoOp).toBe(true);
      }
    }
  });
});
