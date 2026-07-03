import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Creature, MonsterAction } from '../src/types/monster';
import type { BattleState } from '../src/engine/combat';

// vi.hoisted runs before vi.mock hoisting, so these are available in the factory
const { mockRollAttack, mockRollDamage, mockRollDice } = vi.hoisted(() => ({
  mockRollAttack: vi.fn(() => ({ roll: { total: 25 }, naturalRoll: 15 })),
  mockRollDamage: vi.fn(() => ({ total: 10, rolls: [10] })),
  mockRollDice: vi.fn(() => ({ total: 10, rolls: [10] })),
}));

vi.mock('../src/engine/dice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/dice')>();
  return {
    ...actual,
    rollAttack: mockRollAttack,
    rollDamage: mockRollDamage,
    rollDice: mockRollDice,
  };
});

// Import AFTER mock setup
import { resolveAttack, creatureDistance } from '../src/engine/combat';
import { executeTurn } from '../src/engine/ai';

/** Minimal creature factory for range tests. */
function makeCreature(
  id: string,
  team: 'red' | 'blue',
  pos: { x: number; y: number },
  actions: MonsterAction[],
  opts: { speed?: number; size?: string; hp?: number; isHero?: boolean; resources?: Record<string, number> } = {},
): Creature {
  const { speed = 30, size = 'Medium', hp = 200, isHero = false, resources = {} } = opts;
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
      hp,
      hpFormula: '20d10',
      speed: { walk: speed },
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      senses: '',
      languages: '',
      cr: '1',
      xp: 200,
      proficiencyBonus: 2,
      actions,
      isHero,
      initialResources: resources,
    } as Creature['monsterData'],
    team,
    currentHp: hp,
    maxHp: hp,
    position: pos,
    initiative: 10,
    conditions: [],
    conditionTimers: [],
    isAlive: true,
    hasActed: false,
    hasMovedThisTurn: false,
    movementRemaining: speed,
    recharges: {},
    resources: { ...resources },
    activeBuffs: [],
    turnFlags: {},
    stats: { damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksHit: 0, killCount: 0, roundsSurvived: 0, actionUsage: {} },
  };
}

function makeState(creatures: Creature[], gridSize: number = 100): BattleState {
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

// Common actions used across tests
const bite5: MonsterAction = {
  name: 'Bite', type: 'melee', attackBonus: 5,
  damage: '1d6+3', damageType: 'piercing', reach: 5,
  description: 'Melee Attack Roll: +5, reach 5 ft.',
};

const bite10: MonsterAction = {
  name: 'Bite', type: 'melee', attackBonus: 5,
  damage: '1d6+3', damageType: 'piercing', reach: 10,
  description: 'Melee Attack Roll: +5, reach 10 ft.',
};

const shortbow: MonsterAction = {
  name: 'Shortbow', type: 'ranged', attackBonus: 4,
  damage: '1d6+2', damageType: 'piercing',
  range: { normal: 80, long: 320 },
  description: 'Ranged Attack Roll: +4, range 80/320 ft.',
};

const longbow: MonsterAction = {
  name: 'Longbow', type: 'ranged', attackBonus: 5,
  damage: '1d8+3', damageType: 'piercing',
  range: { normal: 150, long: 600 },
  description: 'Ranged Attack Roll: +5, range 150/600 ft.',
};

const longsword: MonsterAction = {
  name: 'Longsword', type: 'melee', attackBonus: 6,
  damage: '1d8+4', damageType: 'slashing', reach: 5,
  description: 'Melee Attack Roll: +6, reach 5 ft.',
};

const javelin: MonsterAction = {
  name: 'Javelin', type: 'ranged', attackBonus: 6,
  damage: '1d6+4', damageType: 'piercing',
  range: { normal: 30, long: 120 },
  description: 'Ranged Attack Roll: +6, range 30/120 ft.',
};

const heavyCrossbow: MonsterAction = {
  name: 'Heavy Crossbow', type: 'ranged', attackBonus: 5,
  damage: '1d10+3', damageType: 'piercing',
  range: { normal: 100, long: 400 },
  description: 'Ranged Attack Roll: +5, range 100/400 ft. Loading.',
};

beforeEach(() => {
  mockRollAttack.mockClear();
  mockRollDamage.mockClear();
  mockRollDice.mockClear();
  // Default: always hit (total 25 vs AC 10)
  mockRollAttack.mockReturnValue({ roll: { total: 25 }, naturalRoll: 15 });
  mockRollDamage.mockReturnValue({ total: 10, rolls: [10] });
});

// ─── Test 1: Melee out of reach ───
describe('resolveAttack range checks', () => {
  it('melee attack at reach 5 vs target 10 ft away → skipped, no stats, no attack event, info log', () => {
    const attacker = makeCreature('attacker', 'red', { x: 0, y: 0 }, [bite5]);
    const target = makeCreature('target', 'blue', { x: 2, y: 0 }, [bite5]);
    const state = makeState([attacker, target]);

    // Distance = 2 squares * 5 = 10 ft; bite reach = 5
    expect(creatureDistance(attacker, target)).toBe(10);

    resolveAttack(state, attacker, target, bite5);

    expect(attacker.stats.attacksMade).toBe(0);
    expect(state.events.filter(e => e.kind === 'attack')).toHaveLength(0);
    expect(state.logs.some(l => l.type === 'info' && l.details.includes('cannot reach'))).toBe(true);
    expect(mockRollAttack).not.toHaveBeenCalled();
  });

  // ─── Test 2: Melee within reach ───
  it('melee attack at reach 10 vs target 10 ft away → rolls normally', () => {
    const attacker = makeCreature('attacker', 'red', { x: 0, y: 0 }, [bite10]);
    const target = makeCreature('target', 'blue', { x: 2, y: 0 }, [bite10]);
    const state = makeState([attacker, target]);

    expect(creatureDistance(attacker, target)).toBe(10);

    resolveAttack(state, attacker, target, bite10);

    expect(attacker.stats.attacksMade).toBe(1);
    expect(state.events.some(e => e.kind === 'attack')).toBe(true);
    expect(mockRollAttack).toHaveBeenCalled();
  });

  // ─── Test 3: Ranged beyond long range ───
  it('ranged attack beyond long range → skipped, info log, no attack event', () => {
    const attacker = makeCreature('attacker', 'red', { x: 0, y: 0 }, [shortbow]);
    // 65 squares * 5 = 325 ft > 320 long range
    const target = makeCreature('target', 'blue', { x: 65, y: 0 }, [shortbow]);
    const state = makeState([attacker, target]);

    expect(creatureDistance(attacker, target)).toBe(325);

    resolveAttack(state, attacker, target, shortbow);

    expect(attacker.stats.attacksMade).toBe(0);
    expect(state.events.filter(e => e.kind === 'attack')).toHaveLength(0);
    expect(state.logs.some(l => l.type === 'info' && l.details.includes('out of range'))).toBe(true);
    expect(mockRollAttack).not.toHaveBeenCalled();
  });

  // ─── Test 4: Ranged within normal range → no disadvantage ───
  it('ranged attack within normal range → no disadvantage', () => {
    const attacker = makeCreature('attacker', 'red', { x: 0, y: 0 }, [shortbow]);
    // 10 squares * 5 = 50 ft, well within normal 80
    const target = makeCreature('target', 'blue', { x: 10, y: 0 }, [shortbow]);
    const state = makeState([attacker, target]);

    resolveAttack(state, attacker, target, shortbow);

    expect(mockRollAttack).toHaveBeenCalledWith(
      shortbow.attackBonus,
      false, // no advantage
      false, // no disadvantage
    );
  });

  // ─── Test 5: Ranged between normal and long range → disadvantage ───
  it('ranged attack between normal and long range → disadvantage applied', () => {
    const attacker = makeCreature('attacker', 'red', { x: 0, y: 0 }, [shortbow]);
    // 20 squares * 5 = 100 ft; normal = 80, long = 320
    const target = makeCreature('target', 'blue', { x: 20, y: 0 }, [shortbow]);
    const state = makeState([attacker, target]);

    expect(creatureDistance(attacker, target)).toBe(100);

    resolveAttack(state, attacker, target, shortbow);

    expect(mockRollAttack).toHaveBeenCalledWith(
      shortbow.attackBonus,
      false, // no advantage
      true,  // disadvantage from long range
    );
  });

  // ─── Test 6: Ranged with enemy adjacent to attacker → disadvantage ───
  it('ranged attack while a different enemy is adjacent to attacker → disadvantage', () => {
    const attacker = makeCreature('attacker', 'red', { x: 0, y: 0 }, [shortbow]);
    const target = makeCreature('target', 'blue', { x: 10, y: 0 }, [bite5]); // far away
    // Adjacent enemy: 1 square away = 5 ft
    const adjacentEnemy = makeCreature('adjacent', 'blue', { x: 1, y: 0 }, [bite5]);
    const state = makeState([attacker, target, adjacentEnemy]);

    expect(creatureDistance(attacker, target)).toBe(50); // within normal range
    expect(creatureDistance(adjacentEnemy, attacker)).toBe(5); // adjacent

    resolveAttack(state, attacker, target, shortbow);

    expect(mockRollAttack).toHaveBeenCalledWith(
      shortbow.attackBonus,
      false, // no advantage
      true,  // disadvantage from adjacent enemy
    );
  });
});

// ─── Test 7: Multiattack substitution ───
describe('multiattack per-attack range validation', () => {
  it('out-of-range melee sub-action substitutes a ranged alternative if available', () => {
    const multiattack: MonsterAction = {
      name: 'Multiattack', type: 'multiattack',
      description: 'The creature makes two bite attacks.',
    };

    // Place attacker at distance where bite (reach 5) is out of range but shortbow (80/320) is in range
    // 2 squares * 5 = 10 ft
    const attacker = makeCreature('attacker', 'red', { x: 0, y: 0 }, [multiattack, bite5, shortbow], { speed: 0 });
    attacker.movementRemaining = 0;
    const target = makeCreature('target', 'blue', { x: 2, y: 0 }, [bite5]);
    const state = makeState([attacker, target]);

    expect(creatureDistance(attacker, target)).toBe(10);

    executeTurn(state, attacker);

    // Bite should NOT have fired (out of range at 10 ft, reach 5)
    // Shortbow should have been substituted
    const attackEvents = state.events.filter(e => e.kind === 'attack') as { kind: 'attack'; actionName: string }[];
    expect(attackEvents.every(e => e.actionName === 'Shortbow')).toBe(true);
    expect(attackEvents.length).toBeGreaterThan(0);

    // No "cannot reach" info logs - the substitution should prevent them
    expect(state.logs.some(l => l.details.includes('cannot reach') && l.details.includes('Bite'))).toBe(false);
  });

  it('out-of-range melee sub-action with no ranged alternative → skipped with info log', () => {
    const multiattack: MonsterAction = {
      name: 'Multiattack', type: 'multiattack',
      description: 'The creature makes two bite attacks.',
    };

    const attacker = makeCreature('attacker', 'red', { x: 0, y: 0 }, [multiattack, bite5], { speed: 0 });
    attacker.movementRemaining = 0;
    const target = makeCreature('target', 'blue', { x: 2, y: 0 }, [bite5]);
    const state = makeState([attacker, target]);

    executeTurn(state, attacker);

    // No attack events should fire - both bites are out of range and no ranged alternative
    const attackEvents = state.events.filter(e => e.kind === 'attack');
    expect(attackEvents).toHaveLength(0);
    expect(attacker.stats.attacksMade).toBe(0);
  });
});

describe('#85 combat action legality regressions', () => {
  it('Action Surge retargets to a legal ranged follow-up instead of spending unreachable melee swings', () => {
    const multiattack: MonsterAction = {
      name: 'Multiattack', type: 'multiattack',
      description: 'The fighter makes two Longsword attacks.',
    };
    const fighter = makeCreature(
      'fighter',
      'blue',
      { x: 0, y: 0 },
      [multiattack, longsword, javelin],
      { speed: 0, isHero: true, resources: { 'action-surge': 1 } },
    );
    const adjacentTarget = makeCreature('adjacent-target', 'red', { x: 1, y: 0 }, [bite5], { hp: 1 });
    const rangedTarget = makeCreature('ranged-target', 'red', { x: 4, y: 0 }, [bite5], { hp: 200 });
    const state = makeState([fighter, adjacentTarget, rangedTarget]);

    executeTurn(state, fighter);

    expect(state.logs.some(l => l.action === 'Action Surge')).toBe(true);
    expect(state.logs.some(l => l.action === 'Longsword' && l.details.includes('cannot reach'))).toBe(false);
    const attackEvents = state.events.filter(e => e.kind === 'attack') as { kind: 'attack'; actionName: string }[];
    expect(attackEvents.filter(e => e.actionName === 'Longsword')).toHaveLength(1);
    expect(attackEvents.filter(e => e.actionName === 'Javelin')).toHaveLength(3);
  });

  it('Loading weapons fire only once during a multiattack action', () => {
    const multiattack: MonsterAction = {
      name: 'Multiattack', type: 'multiattack',
      description: 'The archer makes two Heavy Crossbow attacks.',
    };
    const archer = makeCreature('archer', 'blue', { x: 0, y: 0 }, [multiattack, heavyCrossbow], { speed: 0 });
    const target = makeCreature('target', 'red', { x: 10, y: 0 }, [bite5]);
    const state = makeState([archer, target]);

    executeTurn(state, archer);

    const attackEvents = state.events.filter(e => e.kind === 'attack') as { kind: 'attack'; actionName: string }[];
    expect(attackEvents.filter(e => e.actionName === 'Heavy Crossbow')).toHaveLength(1);
    expect(archer.stats.attacksMade).toBe(1);
  });
});

// ─── Test 8: Dragon scenario ───
describe('dragon scenario - mixed reach multiattack', () => {
  it('Ancient Red Dragon at distance: only in-reach attacks fire', () => {
    const claw10: MonsterAction = {
      name: 'Claw', type: 'melee', attackBonus: 17,
      damage: '2d6+10', damageType: 'slashing', reach: 10,
      description: 'Melee Attack Roll: +17, reach 10 ft.',
    };
    const bite15: MonsterAction = {
      name: 'Bite', type: 'melee', attackBonus: 17,
      damage: '2d10+10', damageType: 'piercing', reach: 15,
      description: 'Melee Attack Roll: +17, reach 15 ft.',
    };
    const multiattack: MonsterAction = {
      name: 'Multiattack', type: 'multiattack',
      description: 'The dragon makes one bite attack and two claw attacks.',
    };

    // Place dragon such that after movement it's at ~15 ft from target
    // Dragon speed 0 to isolate attack logic; place at 3 squares = 15 ft
    const dragon = makeCreature('dragon', 'red', { x: 0, y: 0 },
      [multiattack, bite15, claw10],
      { speed: 0, size: 'Gargantuan', hp: 507 },
    );
    dragon.movementRemaining = 0;

    const commoner = makeCreature('commoner', 'blue', { x: 3, y: 0 },
      [bite5], { hp: 4 },
    );
    // Distance: for Gargantuan (4x4) at (0,0) the right edge is at x=3, so distance to medium at (3,0) is 0
    // Let me place commoner farther so bite15 is in range but claw10 is not
    // Gargantuan occupies (0,0)-(3,3). Commoner at (6,0).
    // Distance = max(0, max(6 - 3, 0 - 6)) * 5 = 3*5 = 15 ft
    commoner.position = { x: 6, y: 0 };

    const state = makeState([dragon, commoner]);
    const dist = creatureDistance(dragon, commoner);
    expect(dist).toBe(15);

    // Give commoner lots of HP so it survives
    commoner.currentHp = 500;
    commoner.maxHp = 500;

    executeTurn(state, dragon);

    const attackEvents = state.events.filter(e => e.kind === 'attack') as { kind: 'attack'; actionName: string }[];

    // Bite (reach 15) should fire - 15 ft <= 15 ft
    const biteAttacks = attackEvents.filter(e => e.actionName === 'Bite');
    expect(biteAttacks.length).toBe(1);

    // Claw (reach 10) should NOT fire - 15 ft > 10 ft
    const clawAttacks = attackEvents.filter(e => e.actionName === 'Claw');
    expect(clawAttacks.length).toBe(0);

    // There should be info logs about claws not reaching
    expect(state.logs.some(l => l.details.includes('cannot reach') && l.details.includes('Claw'))).toBe(true);
  });
});

// ─── Test 9: Goblin regression test ───
describe('goblin regression - no 50-ft scimitar swing', () => {
  it('goblin at (5,5) vs target at (15,5): scimitar never fires at 50 ft', () => {
    const scimitar: MonsterAction = {
      name: 'Scimitar', type: 'melee', attackBonus: 4,
      damage: '1d6+2', damageType: 'slashing', reach: 5,
      description: 'Melee Attack Roll: +4, reach 5 ft.',
    };

    const attacker = makeCreature('goblin-atk', 'red', { x: 5, y: 5 },
      [scimitar, shortbow], { speed: 30 },
    );
    const target = makeCreature('goblin-def', 'blue', { x: 15, y: 5 },
      [scimitar, shortbow], { speed: 30, hp: 500 },
    );
    const state = makeState([attacker, target]);

    // Initial distance = 10 squares * 5 = 50 ft
    expect(creatureDistance(attacker, target)).toBe(50);

    executeTurn(state, attacker);

    // The scimitar should NEVER appear in attack events
    const attackEvents = state.events.filter(e => e.kind === 'attack') as { kind: 'attack'; actionName: string }[];
    const scimitarAttacks = attackEvents.filter(e => e.actionName === 'Scimitar');
    expect(scimitarAttacks).toHaveLength(0);

    // Either the goblin used the shortbow, or moved and still couldn't melee
    // With speed 30, goblin moves 6 squares: (5,5) → (11,5), newDist = 4*5 = 20ft
    // 20 ft > scimitar reach 5, so it falls to ranged attack path
    const shortbowAttacks = attackEvents.filter(e => e.actionName === 'Shortbow');
    expect(shortbowAttacks.length).toBeGreaterThanOrEqual(1);
  });
});
