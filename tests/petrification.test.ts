import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Creature, MonsterData, Condition, ConditionTimer } from '../src/types/monster';
import {
  BattleState,
  applyCondition,
  DEFAULT_TACTICS,
} from '../src/engine/combat';
import { processConditionTimers } from '../src/engine/ai';
import { getMonsterByName } from '../src/data/monsters';

// ── Helpers ──────────────────────────────────────────────────────────

function makeMonsterData(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Test Monster',
    size: 'Medium',
    type: 'Beast',
    alignment: 'Unaligned',
    ac: 12,
    hp: 50,
    hpFormula: '5d10',
    speed: { walk: 30 },
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    senses: '',
    languages: '',
    cr: '1',
    xp: 200,
    proficiencyBonus: 2,
    actions: [],
    ...overrides,
  };
}

function makeCreature(
  overrides: Partial<Creature> & { id: string; team: 'red' | 'blue' }
): Creature {
  return {
    id: overrides.id,
    name: overrides.name || 'Test',
    displayName: overrides.displayName || 'Test',
    monsterData: overrides.monsterData || makeMonsterData(),
    team: overrides.team,
    currentHp: overrides.currentHp ?? 50,
    maxHp: overrides.maxHp ?? 50,
    position: overrides.position || { x: 0, y: 0 },
    initiative: overrides.initiative ?? 10,
    conditions: overrides.conditions || [],
    conditionTimers: overrides.conditionTimers || [],
    isAlive: overrides.isAlive ?? true,
    hasActed: false,
    hasMovedThisTurn: false,
    movementRemaining: 30,
    recharges: {},
    stats: { damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksHit: 0, killCount: 0, roundsSurvived: 0 },
  };
}

function makeState(creatures: Creature[], round = 1): BattleState {
  return {
    creatures,
    round,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize: 100,
    teamTactics: DEFAULT_TACTICS,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('splice index corruption fix', () => {
  it('correctly removes multiple timers without index corruption', () => {
    const creature = makeCreature({
      id: 'target',
      team: 'blue',
      conditions: ['prone', 'frightened', 'poisoned'],
      conditionTimers: [
        { condition: 'prone', duration: 'end_of_next_turn', appliedRound: 1, sourceId: 'a' },
        { condition: 'frightened', duration: 'end_of_next_turn', appliedRound: 1, sourceId: 'b' },
        { condition: 'poisoned', duration: 'end_of_next_turn', appliedRound: 1, sourceId: 'c' },
      ],
    });
    const state = makeState([creature], 2); // round 2, all should expire

    processConditionTimers(state, creature);

    expect(creature.conditions).toEqual([]);
    expect(creature.conditionTimers).toEqual([]);
  });

  it('removes correct timers when some should persist', () => {
    const creature = makeCreature({
      id: 'target',
      team: 'blue',
      conditions: ['prone', 'petrified', 'poisoned'],
      conditionTimers: [
        { condition: 'prone', duration: 'end_of_next_turn', appliedRound: 1, sourceId: 'a' },
        { condition: 'petrified', duration: 'permanent', appliedRound: 1, sourceId: 'b' },
        { condition: 'poisoned', duration: 'end_of_next_turn', appliedRound: 1, sourceId: 'c' },
      ],
    });
    const state = makeState([creature], 2);

    processConditionTimers(state, creature);

    // permanent petrified should survive
    expect(creature.conditions).toEqual(['petrified']);
    expect(creature.conditionTimers).toHaveLength(1);
    expect(creature.conditionTimers[0].condition).toBe('petrified');
  });
});

describe('cockatrice petrification stages (D&D 5e 2024)', () => {
  it('cockatrice Petrifying Bite applies restrained for end_of_next_turn', () => {
    // SRD 5.2: action is "Petrifying Bite" and the 2024 SRD exposes only the
    // Restrained condition - the staged escalation to Petrified is carried by
    // the engine's generic stageInfo path (tested below with mocked data),
    // not by the Cockatrice's published stat block.
    const cockatriceData = getMonsterByName('Cockatrice')!;
    const bite = cockatriceData.actions.find(a => a.name === 'Petrifying Bite')!;
    expect(bite.conditionOnHit!.condition).toBe('restrained');
    expect(bite.conditionOnHit!.duration).toBe('end_of_next_turn');
  });

  it('restrained clears on passed save at end of next turn', async () => {
    // Mock rollSave to always succeed (high roll)
    const dice = await import('../src/engine/dice');
    const spy = vi.spyOn(dice, 'rollSave').mockReturnValue({
      total: 20, rolls: [20], modifier: 0, expression: '1d20+0',
    });

    try {
      const creature = makeCreature({
        id: 'target',
        team: 'blue',
        conditions: ['restrained'],
        conditionTimers: [{
          condition: 'restrained',
          duration: 'end_of_next_turn',
          appliedRound: 1,
          sourceId: 'cockatrice1',
          saveDC: 11,
          saveAbility: 'con',
          stageInfo: { stages: ['restrained', 'petrified'], currentIndex: 0 },
        }],
      });
      const state = makeState([creature], 2);

      processConditionTimers(state, creature);

      expect(creature.conditions).not.toContain('restrained');
      expect(creature.conditions).not.toContain('petrified');
      expect(creature.conditionTimers).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('restrained escalates to petrified on failed save at end of next turn', async () => {
    // Mock rollSave to always fail (low roll)
    const dice = await import('../src/engine/dice');
    const spy = vi.spyOn(dice, 'rollSave').mockReturnValue({
      total: 3, rolls: [3], modifier: 0, expression: '1d20+0',
    });

    try {
      const creature = makeCreature({
        id: 'target',
        team: 'blue',
        conditions: ['restrained'],
        conditionTimers: [{
          condition: 'restrained',
          duration: 'end_of_next_turn',
          appliedRound: 1,
          sourceId: 'cockatrice1',
          saveDC: 11,
          saveAbility: 'con',
          stageInfo: { stages: ['restrained', 'petrified'], currentIndex: 0 },
        }],
      });
      const state = makeState([creature], 2);

      processConditionTimers(state, creature);

      expect(creature.conditions).not.toContain('restrained');
      expect(creature.conditions).toContain('petrified');
      // Petrified should be permanent
      const petrifiedTimer = creature.conditionTimers.find(t => t.condition === 'petrified');
      expect(petrifiedTimer).toBeDefined();
      expect(petrifiedTimer!.duration).toBe('permanent');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('permanent petrification persists', () => {
  it('petrified creature stays petrified for 20+ rounds', () => {
    const creature = makeCreature({
      id: 'target',
      team: 'blue',
      conditions: ['petrified'],
      conditionTimers: [{
        condition: 'petrified',
        duration: 'permanent',
        appliedRound: 1,
        sourceId: 'cockatrice1',
      }],
    });

    // Simulate 25 rounds of processConditionTimers
    for (let round = 2; round <= 25; round++) {
      const state = makeState([creature], round);
      processConditionTimers(state, creature);
    }

    expect(creature.conditions).toContain('petrified');
    expect(creature.conditionTimers).toHaveLength(1);
    expect(creature.conditionTimers[0].condition).toBe('petrified');
    expect(creature.conditionTimers[0].duration).toBe('permanent');
  });

  it('petrified creature is skipped in executeTurn', async () => {
    // Import executeTurn
    const { executeTurn } = await import('../src/engine/ai');

    const petrifiedCreature = makeCreature({
      id: 'stone',
      team: 'blue',
      displayName: 'Stone Bear',
      conditions: ['petrified'],
      conditionTimers: [{
        condition: 'petrified',
        duration: 'permanent',
        appliedRound: 1,
        sourceId: 'cockatrice1',
      }],
      position: { x: 0, y: 0 },
    });
    const enemy = makeCreature({
      id: 'enemy',
      team: 'red',
      displayName: 'Enemy',
      position: { x: 5, y: 5 },
      monsterData: makeMonsterData({
        actions: [{ name: 'Bite', type: 'melee', attackBonus: 5, damage: '1d6+3', damageType: 'piercing', reach: 5, description: 'test' }],
      }),
    });
    const state = makeState([petrifiedCreature, enemy], 3);

    const oldPos = { ...petrifiedCreature.position };
    executeTurn(state, petrifiedCreature);

    // Creature should not have moved or acted
    expect(petrifiedCreature.position).toEqual(oldPos);
    expect(state.logs.some(l => l.details.includes('petrified') && l.details.includes('cannot act'))).toBe(true);
  });
});
