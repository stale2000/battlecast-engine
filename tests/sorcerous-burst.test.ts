import { describe, expect, it } from 'vitest';
import { sorcerousBurst } from '../src/data/spells.js';
import { rollExplodingDamage } from '../src/engine/dice.js';
import { withRng } from '../src/engine/rng.js';

describe('Sorcerous Burst', () => {
  it('exposes selectable damage types and explodes maximum dice', () => {
    const spell = sorcerousBurst('cha', 3, 3);
    expect(spell.damageTypeChoice?.choices).toContain('lightning');
    expect(spell.explodingDamage).toBe(true);
    const rolls = [0.999, 0];
    const result = withRng({ next: () => rolls.shift() ?? 0 }, () => rollExplodingDamage('1d8'));
    expect(result.total).toBe(9);
    expect(result.rolls).toEqual([8, 1]);
  });
});
