import { describe, expect, it } from 'vitest';
import { buildSpellAction, produceFlame } from '../src/data/spells.js';

describe('Produce Flame', () => {
  it('scales its ranged fire attack and is discoverable', () => {
    const spell = produceFlame('wis', 3, 3);
    expect(spell.attackBonus).toBe(6);
    expect(spell.damage).toBe('2d8');
    expect(spell.damageType).toBe('fire');
    expect(buildSpellAction('Produce Flame', 'wis', 3, 3)).toMatchObject({ name: 'Produce Flame', damage: '2d8' });
  });
});
