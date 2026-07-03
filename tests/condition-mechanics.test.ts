/**
 * TDD tests for condition mechanics bugs.
 *
 * Each test documents a specific D&D 5e rule that's currently broken
 * or missing in the engine. Written BEFORE the fix so they fail first,
 * then the fix makes them pass.
 *
 * Bugs covered:
 * 1. Unconscious creatures don't auto-crit on melee (only paralyzed does)
 * 2. Blinded creatures don't grant advantage to their attackers
 * 3. Paralyzed/stunned/petrified/unconscious don't zero movement speed
 * 4. Frightened creatures can still move toward the fear source
 * 5. Charmed creatures can still attack their charmer
 */
import { describe, expect, test } from 'vitest';
import {
  hasAdvantage,
  hasDisadvantage,
  createCreatureWithFixedHp,
  resolveAttack,
  DEFAULT_TACTICS,
  type BattleState,
} from '../src/engine/combat';
import { executeTurn } from '../src/engine/ai';
import { monsters, getMonsterByName } from '../src/data/monsters';
import type { MonsterAction, Creature } from '../src/types/monster';

// ── Helpers ────────────────────────────────────────────────────────

function makeState(creatures: Creature[]): BattleState {
  return {
    creatures,
    round: 2,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize: 20,
    teamTactics: DEFAULT_TACTICS,
  };
}

const meleeAction: MonsterAction = {
  name: 'Bite', type: 'melee', attackBonus: 5,
  damage: '1d6+3', damageType: 'piercing', reach: 5,
  description: 'test',
};

const rangedAction: MonsterAction = {
  name: 'Shortbow', type: 'ranged', attackBonus: 5,
  damage: '1d6+3', damageType: 'piercing',
  range: { normal: 80, long: 320 },
  description: 'test',
};

function makeCreature(id: string, team: 'red' | 'blue', conditions: Creature['conditions'] = []): Creature {
  const data = getMonsterByName('Veteran')!;
  const c = createCreatureWithFixedHp(data, team, { x: team === 'red' ? 2 : 10, y: 5 }, 0);
  c.id = id;
  c.conditions = [...conditions];
  c.conditionTimers = conditions.map(cond => ({
    condition: cond,
    duration: '1_minute' as const,
    appliedRound: 1,
    sourceId: team === 'red' ? 'blue-src' : 'red-src',
  }));
  return c;
}

// ═══════════════════════════════════════════════════════════════════
// BUG 1: Unconscious auto-crit
// D&D 5e: "Any attack that hits the creature is a critical hit if
// the attacker is within 5 feet."
// Current: only paralyzed triggers auto-crit (line 838), unconscious
// is missing from the check.
// ═══════════════════════════════════════════════════════════════════

describe('BUG 1: Unconscious melee hits should auto-crit', () => {
  test('melee attack against unconscious target within 5ft is auto-crit', () => {
    const attacker = makeCreature('atk', 'red');
    const target = makeCreature('tgt', 'blue', ['unconscious']);
    target.position = { x: 3, y: 5 }; // adjacent (within 5ft)
    const state = makeState([attacker, target]);

    const hpBefore = target.currentHp;
    // Run 20 attacks - every single one should crit (not just the nat-20s)
    let allCrit = true;
    for (let i = 0; i < 20; i++) {
      target.currentHp = target.maxHp;
      target.isAlive = true;
      target.conditions = ['unconscious'];
      state.events = [];
      state.logs = [];
      resolveAttack(state, attacker, target, meleeAction);
      const hitEvents = state.events.filter(e => e.kind === 'hit') as Array<{ kind: 'hit'; critical: boolean }>;
      if (hitEvents.length > 0 && !hitEvents[0].critical) {
        allCrit = false;
        break;
      }
    }
    expect(allCrit).toBe(true);
  });

  test('ranged attack against unconscious target does NOT auto-crit', () => {
    const attacker = makeCreature('atk', 'red');
    const target = makeCreature('tgt', 'blue', ['unconscious']);
    target.position = { x: 15, y: 5 }; // far away
    const state = makeState([attacker, target]);

    // Run 20 attacks - should see a mix of crits and non-crits
    let sawNonCrit = false;
    for (let i = 0; i < 20; i++) {
      target.currentHp = target.maxHp;
      state.events = [];
      resolveAttack(state, attacker, target, rangedAction);
      const hitEvents = state.events.filter(e => e.kind === 'hit') as Array<{ kind: 'hit'; critical: boolean }>;
      if (hitEvents.length > 0 && !hitEvents[0].critical) {
        sawNonCrit = true;
        break;
      }
    }
    expect(sawNonCrit).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BUG 2: Blinded targets grant advantage
// D&D 5e: "Attack rolls against the [blinded] creature have advantage."
// Current: only the blinded ATTACKER gets disadvantage (line 304).
// Missing: the blinded TARGET grants advantage to its attackers.
// ═══════════════════════════════════════════════════════════════════

describe('BUG 2: Attacks against blinded targets should have advantage', () => {
  test('hasAdvantage returns true when target is blinded', () => {
    const attacker = makeCreature('atk', 'red');
    const target = makeCreature('tgt', 'blue', ['blinded']);
    const state = makeState([attacker, target]);

    expect(hasAdvantage(state, attacker, target, meleeAction)).toBe(true);
  });

  test('blinded attacker still has disadvantage (existing behavior)', () => {
    const attacker = makeCreature('atk', 'red', ['blinded']);
    const target = makeCreature('tgt', 'blue');

    expect(hasDisadvantage(attacker, target, meleeAction)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BUG 3: Speed not zeroed for paralyzed/stunned/petrified/unconscious
// D&D 5e: all four of these set speed to 0.
// Current: executeTurn skips the turn (correct) but movementRemaining
// is never zeroed - if the condition lifts mid-round the creature
// could theoretically move at full speed.
// ═══════════════════════════════════════════════════════════════════

describe('BUG 3: Paralyzed/stunned/petrified/unconscious should zero speed', () => {
  test.each([
    'paralyzed',
    'stunned',
    'petrified',
    'unconscious',
  ] as const)('%s creature has movementRemaining = 0 after executeTurn', (condition) => {
    const creature = makeCreature('c', 'red', [condition]);
    creature.movementRemaining = 30;
    const enemy = makeCreature('e', 'blue');
    enemy.monsterData = { ...enemy.monsterData, actions: [meleeAction] };
    const state = makeState([creature, enemy]);

    executeTurn(state, creature);

    expect(creature.movementRemaining).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BUG 4: Frightened creatures should not move closer to fear source
// D&D 5e: "The creature can't willingly move closer to the source
// of its fear."
// Current: frightened creatures still path toward enemies normally.
// ═══════════════════════════════════════════════════════════════════

describe('BUG 4: Frightened creature should not move closer to fear source', () => {
  test('frightened creature does not reduce distance to the fear source', () => {
    const creature = makeCreature('scared', 'red', ['frightened']);
    creature.position = { x: 5, y: 5 };
    creature.movementRemaining = 30;
    const fearSource = makeCreature('scary', 'blue');
    fearSource.position = { x: 15, y: 5 };
    fearSource.monsterData = { ...fearSource.monsterData, actions: [meleeAction] };
    // Set the fear source as the condition source
    creature.conditionTimers = [{
      condition: 'frightened',
      duration: '1_minute',
      appliedRound: 1,
      sourceId: fearSource.id,
    }];
    const state = makeState([creature, fearSource]);

    const distBefore = Math.abs(creature.position.x - fearSource.position.x) +
                       Math.abs(creature.position.y - fearSource.position.y);

    executeTurn(state, creature);

    const distAfter = Math.abs(creature.position.x - fearSource.position.x) +
                      Math.abs(creature.position.y - fearSource.position.y);

    // Distance should not decrease (creature can't move closer)
    expect(distAfter).toBeGreaterThanOrEqual(distBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════
// BUG 5: Charmed creatures should not attack their charmer
// D&D 5e: "A charmed creature can't attack the charmer or target
// the charmer with harmful abilities or magical effects."
// Current: charmed has zero mechanical effect.
// ═══════════════════════════════════════════════════════════════════

describe('BUG 5: Charmed creature should not attack the charmer', () => {
  test('charmed creature skips attacks against its charm source', () => {
    const charmed = makeCreature('victim', 'red', ['charmed']);
    charmed.position = { x: 5, y: 5 };
    charmed.movementRemaining = 30;
    const charmer = makeCreature('charmer', 'blue');
    charmer.position = { x: 6, y: 5 }; // adjacent
    charmer.monsterData = { ...charmer.monsterData, actions: [meleeAction] };
    // Only one enemy - the charmer
    charmed.conditionTimers = [{
      condition: 'charmed',
      duration: '1_minute',
      appliedRound: 1,
      sourceId: charmer.id,
    }];
    const state = makeState([charmed, charmer]);

    const charmerHpBefore = charmer.currentHp;
    executeTurn(state, charmed);

    // Charmed creature should NOT have damaged the charmer
    expect(charmer.currentHp).toBe(charmerHpBefore);
  });
});
