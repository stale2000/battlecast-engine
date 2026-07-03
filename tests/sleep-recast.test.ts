import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';

describe('AI does not recast Sleep on unconscious targets', () => {
  it('Wizard does not cast Sleep twice in a row on same target', () => {
    const wizard = buildHero('Wizard', 5);
    const barbarian = buildHero('Barbarian', 3);
    let doubleSleepSeen = false;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(wizard, 'blue', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(barbarian, 'red', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const sleepCasts = state.logs.filter(l =>
        l.actor?.includes('Wizard') && l.action === 'Sleep'
      );
      if (sleepCasts.length >= 2) {
        // Check if there was a wake-up between casts
        const firstIdx = state.logs.indexOf(sleepCasts[0]);
        const secondIdx = state.logs.indexOf(sleepCasts[1]);
        const wokeBetween = state.logs.slice(firstIdx, secondIdx).some(l =>
          l.action === 'Wakes Up'
        );
        if (!wokeBetween) doubleSleepSeen = true;
      }
    }
    expect(doubleSleepSeen).toBe(false);
  });
});
