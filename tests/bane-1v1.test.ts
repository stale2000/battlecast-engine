import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';

describe('AI skips Bane in 1v1', () => {
  it('Bard does not open with Bane against a single enemy', () => {
    const bard = buildHero('Bard', 3);
    const barbarian = buildHero('Barbarian', 3);
    let baneUsed = 0;
    const trials = 30;
    for (let i = 0; i < trials; i++) {
      const creatures = [
        createCreatureWithFixedHp(bard, 'blue', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(barbarian, 'red', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      baneUsed += state.logs.filter(l =>
        l.actor?.includes('Bard') && l.action === 'Bane'
      ).length;
    }
    expect(baneUsed).toBe(0);
  });

  it('Bard still uses Bane when multiple enemies present', () => {
    const bard = buildHero('Bard', 3);
    const barbarian = buildHero('Barbarian', 3);
    let baneUsed = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(bard, 'blue', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(barbarian, 'red', { x: 13, y: 10 }, 0),
        createCreatureWithFixedHp(barbarian, 'red', { x: 15, y: 10 }, 1),
        createCreatureWithFixedHp(barbarian, 'red', { x: 15, y: 12 }, 2),
      ];
      const state = runBattle(creatures, 20);
      baneUsed += state.logs.filter(l =>
        l.actor?.includes('Bard') && l.action === 'Bane'
      ).length;
    }
    expect(baneUsed).toBeGreaterThan(0);
  });
});
