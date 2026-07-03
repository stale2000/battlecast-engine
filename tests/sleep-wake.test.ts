import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp, applyCondition, applyDamage, pushLog } from '../src/engine/combat';
import type { BattleState } from '../src/engine/combat';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

function makeMinimalState(creatures: ReturnType<typeof createCreatureWithFixedHp>[]): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    events: [],
    logs: [],
    isComplete: false,
    gridSize: 20,
  } as unknown as BattleState;
}

describe('Sleep wakes on damage', () => {
  it('unconscious condition is removed when creature takes damage', () => {
    const barbarian = buildHero('Barbarian', 3);
    const wizard = buildHero('Wizard', 3);
    const creatures = [
      createCreatureWithFixedHp(barbarian, 'red', { x: 10, y: 10 }, 0),
      createCreatureWithFixedHp(wizard, 'blue', { x: 5, y: 10 }, 0),
    ];
    const state = makeMinimalState(creatures);
    const target = creatures[0];
    const attacker = creatures[1];

    // Apply unconscious (as Sleep would)
    applyCondition(state, target, 'unconscious', attacker, '1_minute');
    expect(target.conditions).toContain('unconscious');

    // Deal damage - should wake up
    applyDamage(state, target, 5, 'fire', attacker);
    expect(target.conditions).not.toContain('unconscious');

    // Should have a "Wakes Up" log
    const wakeLog = state.logs.find(l => l.action === 'Wakes Up');
    expect(wakeLog).toBeDefined();
  });

  it('sleeping creature wakes after melee hit in combat', () => {
    const goblin = md('Goblin Warrior');
    const commoner = md('Commoner');
    const creatures = [
      createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
      createCreatureWithFixedHp(commoner, 'blue', { x: 11, y: 10 }, 0),
    ];
    const state = makeMinimalState(creatures);
    const target = creatures[1];
    const attacker = creatures[0];

    applyCondition(state, target, 'unconscious', attacker, '1_minute');
    expect(target.conditions).toContain('unconscious');

    // Simulate a melee hit
    applyDamage(state, target, 3, 'slashing', attacker);
    expect(target.conditions).not.toContain('unconscious');
    expect(target.conditionTimers.some(t => t.condition === 'unconscious')).toBe(false);
  });

  it('zero damage does not wake sleeping creature', () => {
    const barbarian = buildHero('Barbarian', 3);
    const wizard = buildHero('Wizard', 3);
    const creatures = [
      createCreatureWithFixedHp(barbarian, 'red', { x: 10, y: 10 }, 0),
      createCreatureWithFixedHp(wizard, 'blue', { x: 5, y: 10 }, 0),
    ];
    const state = makeMinimalState(creatures);
    const target = creatures[0];
    const attacker = creatures[1];

    applyCondition(state, target, 'unconscious', attacker, '1_minute');
    applyDamage(state, target, 0, 'fire', attacker);
    expect(target.conditions).toContain('unconscious');
  });
});
