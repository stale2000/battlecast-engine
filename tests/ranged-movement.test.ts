import { describe, it, expect } from 'vitest';
import { runBattle, executeTurn, shouldPreferRanged } from '../src/engine/ai';
import { createCreatureWithFixedHp, creatureDistance, DEFAULT_TACTICS, type BattleState } from '../src/engine/combat';
import type { MonsterData, MonsterAction, Creature } from '../src/types/monster';

function makeState(creatures: Creature[], gridSize = 30): BattleState {
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
    teamTactics: DEFAULT_TACTICS,
  };
}

// ─────────────────────────────────────────────────────────────────
// Pure helper: who prefers ranged?
// ─────────────────────────────────────────────────────────────────

function melee(name: string, damage: string): MonsterAction {
  return { name, type: 'melee', attackBonus: 4, damage, damageType: 'slashing', reach: 5, description: '' };
}
function ranged(name: string, damage: string, normal = 80): MonsterAction {
  return { name, type: 'ranged', attackBonus: 4, damage, damageType: 'piercing', range: { normal, long: normal * 4 }, description: '' };
}

describe('shouldPreferRanged', () => {
  it('no ranged actions → false (melee-only creature)', () => {
    expect(shouldPreferRanged([melee('Bite', '1d8+2')], [])).toBe(false);
  });

  it('no melee actions → true (pure ranged)', () => {
    expect(shouldPreferRanged([], [ranged('Bow', '1d8+2')])).toBe(true);
  });

  it('mixed, ranged avg > melee avg → true', () => {
    // 8.5 > 6.5
    expect(shouldPreferRanged([melee('Scimitar', '1d6+3')], [ranged('Pistol', '1d10+3')])).toBe(true);
  });

  it('mixed, ranged avg == melee avg → true (tie to ranged)', () => {
    // both 6.5
    expect(shouldPreferRanged([melee('Longsword', '1d8+2')], [ranged('Longbow', '1d8+2')])).toBe(true);
  });

  it('mixed, ranged avg < melee avg → false', () => {
    // ranged 6.5 < melee 13 (Greataxe)
    expect(shouldPreferRanged([melee('Greataxe', '1d12+3')], [ranged('Javelin', '1d6+3')])).toBe(false);
  });

  it('Barbarian hero → always false (rage wants melee)', () => {
    expect(shouldPreferRanged(
      [melee('Greataxe', '1d12+3')], [ranged('Javelin', '1d6+3')], 'Barbarian',
    )).toBe(false);
  });

  it('Rogue hero → always true (sneak from range)', () => {
    expect(shouldPreferRanged(
      [melee('Shortsword', '1d6+3')], [ranged('Shortbow', '1d6+3')], 'Rogue',
    )).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Integration: creature already in ranged range doesn't charge
// ─────────────────────────────────────────────────────────────────

function makeArcher(): MonsterData {
  return {
    name: 'Test Archer',
    size: 'Medium', type: 'Humanoid', alignment: 'Neutral',
    ac: 15, hp: 30, hpFormula: '5d8',
    speed: { walk: 30 },
    abilities: { str: 12, dex: 16, con: 12, int: 10, wis: 12, cha: 10 },
    senses: '', languages: '',
    cr: '1', xp: 200, proficiencyBonus: 2,
    actions: [
      ranged('Longbow', '1d10+3', 80),   // avg 8.5
      melee('Shortsword', '1d6+1'),       // avg 4.5 - ranged should win
    ],
  };
}

function makeMelee(): MonsterData {
  return {
    name: 'Test Brute',
    size: 'Medium', type: 'Humanoid', alignment: 'Neutral',
    ac: 14, hp: 40, hpFormula: '6d8',
    speed: { walk: 30 },
    abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 8 },
    senses: '', languages: '',
    cr: '1', xp: 200, proficiencyBonus: 2,
    actions: [melee('Club', '1d8+3')],
  };
}

describe('Ranged creature movement (single-turn via executeTurn)', () => {
  it('mixed attacker with better ranged does not advance INTO melee when in range', () => {
    // Archer at (5,5), brute at (10,5): 5 cells = 25ft, inside Longbow 80ft
    // and inside the brute's moveBudget (35ft). PR B kite-zone math may
    // back the archer up to maximize forced-dash distance. The key
    // invariant is that the archer doesn't charge TOWARD the brute.
    const archer = createCreatureWithFixedHp(makeArcher(), 'red', { x: 5, y: 5 }, 0);
    const brute = createCreatureWithFixedHp(makeMelee(), 'blue', { x: 10, y: 5 }, 1);
    const state = makeState([archer, brute]);

    executeTurn(state, archer);

    expect(archer.position.x).toBeLessThanOrEqual(5);  // didn't close the gap
  });

  it('mixed attacker with better ranged advances when out of ranged normal range', () => {
    // Archer at (2,2), brute at (25,2): 23 cells = 115ft, outside Longbow 80ft.
    // Archer must move to close the gap to its ranged normal range.
    const archer = createCreatureWithFixedHp(makeArcher(), 'red', { x: 2, y: 2 }, 0);
    const brute = createCreatureWithFixedHp(makeMelee(), 'blue', { x: 25, y: 2 }, 1);
    const state = makeState([archer, brute]);

    executeTurn(state, archer);

    expect(archer.position.x).toBeGreaterThan(2);
  });

  it('ranged-preferring creature does not enter melee threat just to remove long-range disadvantage', () => {
    const md: MonsterData = {
      name: 'Short Range Archer',
      size: 'Medium', type: 'Humanoid', alignment: 'Neutral',
      ac: 14, hp: 30, hpFormula: '5d8',
      speed: { walk: 30 },
      abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 12, cha: 10 },
      senses: '', languages: '',
      cr: '1', xp: 200, proficiencyBonus: 2,
      actions: [
        ranged('Shortbow', '1d8+3', 30),
        melee('Dagger', '1d4+1'),
      ],
    };
    const archer = createCreatureWithFixedHp(md, 'red', { x: 2, y: 2 }, 0);
    const brute = createCreatureWithFixedHp(makeMelee(), 'blue', { x: 12, y: 2 }, 1);
    const state = makeState([archer, brute]);

    expect(creatureDistance(archer, brute)).toBe(50);

    executeTurn(state, archer);

    expect(creatureDistance(archer, brute)).toBeGreaterThan(35);
    expect(state.events.some(e => e.kind === 'attack' && e.actionName === 'Shortbow')).toBe(true);
  });

  it('melee-dominant mixed attacker advances to melee reach', () => {
    // Greataxe (avg 9.5) > Javelin (avg 6.5) → prefers melee. Must close gap.
    const md: MonsterData = {
      name: 'Javelineer Brute',
      size: 'Medium', type: 'Humanoid', alignment: 'Neutral',
      ac: 14, hp: 40, hpFormula: '6d8',
      speed: { walk: 30 },
      abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 8 },
      senses: '', languages: '',
      cr: '1', xp: 200, proficiencyBonus: 2,
      actions: [
        melee('Greataxe', '1d12+3'),
        ranged('Javelin', '1d6+3', 30),
      ],
    };
    const attacker = createCreatureWithFixedHp(md, 'red', { x: 2, y: 2 }, 0);
    const victim = createCreatureWithFixedHp(makeMelee(), 'blue', { x: 10, y: 2 }, 1);
    const state = makeState([attacker, victim]);

    executeTurn(state, attacker);

    expect(attacker.position.x).toBeGreaterThan(2);
  });

  it('pure-ranged creature does not charge (regression test - existing behavior preserved)', () => {
    const md: MonsterData = {
      name: 'Sniper',
      size: 'Medium', type: 'Humanoid', alignment: 'Neutral',
      ac: 13, hp: 20, hpFormula: '4d8',
      speed: { walk: 30 },
      abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 12, cha: 10 },
      senses: '', languages: '',
      cr: '1/2', xp: 100, proficiencyBonus: 2,
      actions: [ranged('Longbow', '1d8+3', 150)],
    };
    const sniper = createCreatureWithFixedHp(md, 'red', { x: 5, y: 5 }, 0);
    const target = createCreatureWithFixedHp(makeMelee(), 'blue', { x: 15, y: 5 }, 1);
    const state = makeState([sniper, target]);

    executeTurn(state, sniper);

    // PR B: pure-ranged may kite back to maximize forced-dash distance.
    // Invariant: doesn't charge TOWARD the target.
    expect(sniper.position.x).toBeLessThanOrEqual(5);
  });
});
