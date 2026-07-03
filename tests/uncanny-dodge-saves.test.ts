import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { createCreatureWithFixedHp, applyDamage, applyCondition } from '../src/engine/combat';
import type { BattleState } from '../src/engine/combat';

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

describe('Uncanny Dodge only works on attacks, not saves', () => {
  it('Uncanny Dodge does NOT trigger on save-based damage', () => {
    const rogue = buildHero('Rogue', 5);
    const wizard = buildHero('Wizard', 5);
    const creatures = [
      createCreatureWithFixedHp(rogue, 'blue', { x: 10, y: 10 }, 0),
      createCreatureWithFixedHp(wizard, 'red', { x: 5, y: 10 }, 0),
    ];
    const state = makeMinimalState(creatures);
    const target = creatures[0];
    const attacker = creatures[1];
    const hpBefore = target.currentHp;

    // Simulate save-based damage (Fireball) - isAttack = false
    applyDamage(state, target, 20, 'fire', attacker, false);

    // Should take full 20 damage, not halved by Uncanny Dodge
    expect(hpBefore - target.currentHp).toBe(20);
    expect(state.logs.some(l => l.action === 'Uncanny Dodge')).toBe(false);
  });

  it('Uncanny Dodge DOES trigger on attack-based damage', () => {
    const rogue = buildHero('Rogue', 5);
    const goblin = buildHero('Fighter', 3);
    const creatures = [
      createCreatureWithFixedHp(rogue, 'blue', { x: 10, y: 10 }, 0),
      createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 10 }, 0),
    ];
    const state = makeMinimalState(creatures);
    const target = creatures[0];
    const attacker = creatures[1];
    const hpBefore = target.currentHp;

    // Simulate attack-based damage - isAttack = true
    applyDamage(state, target, 20, 'slashing', attacker, true);

    // Should be halved to 10
    expect(hpBefore - target.currentHp).toBe(10);
    expect(state.logs.some(l => l.action === 'Uncanny Dodge')).toBe(true);
  });

  it('Uncanny Dodge defaults to non-attack when isAttack omitted (backward compat)', () => {
    const rogue = buildHero('Rogue', 5);
    const wizard = buildHero('Wizard', 5);
    const creatures = [
      createCreatureWithFixedHp(rogue, 'blue', { x: 10, y: 10 }, 0),
      createCreatureWithFixedHp(wizard, 'red', { x: 5, y: 10 }, 0),
    ];
    const state = makeMinimalState(creatures);
    const target = creatures[0];
    const attacker = creatures[1];
    const hpBefore = target.currentHp;

    // Omit isAttack - should default to false (safe default, no halving)
    applyDamage(state, target, 20, 'fire', attacker);

    expect(hpBefore - target.currentHp).toBe(20);
    expect(state.logs.some(l => l.action === 'Uncanny Dodge')).toBe(false);
  });
});
