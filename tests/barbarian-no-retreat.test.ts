import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';

describe('Barbarian never retreats while raging', () => {
  it('Barbarian does not disengage or retreat', () => {
    const barbarian = buildHero('Barbarian', 3);
    const ranger = buildHero('Ranger', 5);
    let retreatSeen = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(barbarian, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(ranger, 'blue', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      retreatSeen += state.logs.filter(l =>
        l.actor?.includes('Barbarian') &&
        (l.action === 'Retreat' || l.action === 'Disengage')
      ).length;
    }
    expect(retreatSeen).toBe(0);
  });
});
