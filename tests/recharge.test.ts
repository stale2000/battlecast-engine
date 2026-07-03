import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCreatureWithFixedHp, processRecharges, DEFAULT_TACTICS, type BattleState } from '../src/engine/combat';
import { executeTurn } from '../src/engine/ai';
import type { MonsterData, MonsterAction, Creature } from '../src/types/monster';

// ─────────────────────────────────────────────────────────────────
// processRecharges: pure helper, deterministic via Math.random spy
// ─────────────────────────────────────────────────────────────────

function d6(value: number) {
  // processRecharges computes Math.floor(Math.random() * 6) + 1.
  // Given a desired d6 result v in [1,6], we need Math.random() ∈ [(v-1)/6, v/6).
  // Picking the midpoint avoids boundary rounding surprises.
  return (value - 0.5) / 6;
}

function makeMonster(recharge: string): MonsterData {
  const breath: MonsterAction = {
    name: 'Breath', type: 'special',
    description: 'Breath weapon.',
    damageType: 'fire',
    savingThrow: { ability: 'dex', dc: 13, damageOnFail: '4d6', damageOnSuccess: 'half', area: '15-foot Cone' },
    recharge,
    targetScope: 'area_enemies',
  };
  const claw: MonsterAction = {
    name: 'Claw', type: 'melee', attackBonus: 4,
    damage: '1d6+2', damageType: 'slashing', reach: 5, description: '',
  };
  return {
    name: 'Drake',
    size: 'Medium', type: 'Dragon', alignment: 'Neutral',
    ac: 14, hp: 40, hpFormula: '6d8+6',
    speed: { walk: 30 },
    abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 12, cha: 10 },
    senses: '', languages: '',
    cr: '2', xp: 450, proficiencyBonus: 2,
    actions: [claw, breath],
  };
}

function spent(recharge: string): Creature {
  const c = createCreatureWithFixedHp(makeMonster(recharge), 'red', { x: 5, y: 5 }, 0);
  c.recharges['Breath'] = false; // already used this combat
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('processRecharges: "5-6"', () => {
  it('does not recharge on d6 = 1..4', () => {
    for (const roll of [1, 2, 3, 4]) {
      vi.spyOn(Math, 'random').mockReturnValue(d6(roll));
      const c = spent('5-6');
      processRecharges(c);
      expect(c.recharges['Breath']).toBe(false);
    }
  });

  it('recharges on d6 = 5 or 6', () => {
    for (const roll of [5, 6]) {
      vi.spyOn(Math, 'random').mockReturnValue(d6(roll));
      const c = spent('5-6');
      processRecharges(c);
      expect(c.recharges['Breath']).toBe(true);
    }
  });
});

describe('processRecharges: "6"', () => {
  it('does not recharge on d6 = 1..5', () => {
    for (const roll of [1, 2, 3, 4, 5]) {
      vi.spyOn(Math, 'random').mockReturnValue(d6(roll));
      const c = spent('6');
      processRecharges(c);
      expect(c.recharges['Breath']).toBe(false);
    }
  });

  it('recharges on d6 = 6', () => {
    vi.spyOn(Math, 'random').mockReturnValue(d6(6));
    const c = spent('6');
    processRecharges(c);
    expect(c.recharges['Breath']).toBe(true);
  });
});

describe('processRecharges: "3-5" (bounded range - regression for range-ignoring bug)', () => {
  it('recharges on d6 = 3, 4, 5', () => {
    for (const roll of [3, 4, 5]) {
      vi.spyOn(Math, 'random').mockReturnValue(d6(roll));
      const c = spent('3-5');
      processRecharges(c);
      expect(c.recharges['Breath']).toBe(true);
    }
  });

  it('does NOT recharge on d6 = 6 (out of range)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(d6(6));
    const c = spent('3-5');
    processRecharges(c);
    // Regression test: the old parser only kept the first number, so
    // `roll >= 3` would incorrectly accept 6.
    expect(c.recharges['Breath']).toBe(false);
  });

  it('does not recharge on d6 = 1 or 2', () => {
    for (const roll of [1, 2]) {
      vi.spyOn(Math, 'random').mockReturnValue(d6(roll));
      const c = spent('3-5');
      processRecharges(c);
      expect(c.recharges['Breath']).toBe(false);
    }
  });
});

describe('processRecharges: already-available abilities are not rerolled', () => {
  it('leaves recharges[name] === true untouched', () => {
    vi.spyOn(Math, 'random').mockReturnValue(d6(1));
    const c = createCreatureWithFixedHp(makeMonster('5-6'), 'red', { x: 5, y: 5 }, 0);
    c.recharges['Breath'] = true;
    processRecharges(c);
    expect(c.recharges['Breath']).toBe(true);
  });

  it('leaves undefined recharges[name] untouched (first-turn availability is set by the ai layer)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(d6(1));
    const c = createCreatureWithFixedHp(makeMonster('5-6'), 'red', { x: 5, y: 5 }, 0);
    // Deliberately do not touch c.recharges['Breath'].
    processRecharges(c);
    expect(c.recharges['Breath']).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// Integration: breath weapon through executeTurn
// ─────────────────────────────────────────────────────────────────

function makeState(creatures: Creature[], gridSize = 20): BattleState {
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

function makeTarget(): MonsterData {
  return {
    name: 'Dummy',
    size: 'Medium', type: 'Humanoid', alignment: 'Neutral',
    ac: 10, hp: 200, hpFormula: '', speed: { walk: 30 },
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    senses: '', languages: '',
    cr: '1', xp: 100, proficiencyBonus: 2,
    actions: [{ name: 'Punch', type: 'melee', attackBonus: 0, damage: '1', damageType: 'bludgeoning', reach: 5, description: '' }],
  };
}

describe('Recharge in play: breath cannot fire two turns in a row without a successful recharge roll', () => {
  it('marks breath spent after use; missed d6 leaves it unavailable', () => {
    // Two targets stand close so the breath has a valid area target.
    const drake = createCreatureWithFixedHp(makeMonster('5-6'), 'red', { x: 5, y: 5 }, 0);
    const t1 = createCreatureWithFixedHp(makeTarget(), 'blue', { x: 7, y: 5 }, 0);
    const t2 = createCreatureWithFixedHp(makeTarget(), 'blue', { x: 7, y: 6 }, 1);
    const state = makeState([drake, t1, t2]);

    // Turn 1: drake fires breath (first-turn availability is set by ai layer).
    executeTurn(state, drake);
    expect(drake.recharges['Breath']).toBe(false);

    // Turn 2 start: roll fails (d6 = 1). Breath should remain unavailable.
    vi.spyOn(Math, 'random').mockReturnValue(d6(1));
    drake.hasActed = false;
    drake.movementRemaining = 30;
    processRecharges(drake);
    expect(drake.recharges['Breath']).toBe(false);

    // Turn 3 start: roll hits (d6 = 6). Breath should be available again.
    vi.restoreAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(d6(6));
    processRecharges(drake);
    expect(drake.recharges['Breath']).toBe(true);
  });
});
