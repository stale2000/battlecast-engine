import { describe, it, expect } from 'vitest';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';
import { monsters } from '../src/data/monsters';

const mage = monsters.find(m => m.name === 'Mage')!;
const goblinWarrior = monsters.find(m => m.name === 'Goblin Warrior')!;

describe('Mage innate spellcasting (regression for player report)', () => {
  it('Mage has structured Fireball + Cone of Cold actions, not a description blob', () => {
    expect(mage.actions.some(a => a.name === 'Fireball')).toBe(true);
    expect(mage.actions.some(a => a.name === 'Cone of Cold')).toBe(true);
    const fireball = mage.actions.find(a => a.name === 'Fireball')!;
    expect(fireball.spellLevel).toBe(4);
    expect(fireball.savingThrow?.damageOnFail).toBe('9d6');
    expect(fireball.resourceCost?.key).toBe('fireball-uses');
  });

  it('Mage has the per-spell daily counters in initialResources', () => {
    expect(mage.initialResources?.['fireball-uses']).toBe(2);
    expect(mage.initialResources?.['cone-of-cold-uses']).toBe(1);
  });

  it('Mage actually casts a damage spell when it has multiple enemies in range', () => {
    let spellSeen = 0;
    for (let trial = 0; trial < 20; trial++) {
      const m = createCreatureWithFixedHp(mage, 'red', { x: 10, y: 10 }, 0);
      const enemies = [
        createCreatureWithFixedHp(goblinWarrior, 'blue', { x: 14, y: 9 }, 0),
        createCreatureWithFixedHp(goblinWarrior, 'blue', { x: 14, y: 10 }, 1),
        createCreatureWithFixedHp(goblinWarrior, 'blue', { x: 14, y: 11 }, 2),
      ];
      const state = runBattle([m, ...enemies], 20);
      if (state.logs.some(l => l.action === 'Fireball' || l.action === 'Cone of Cold')) {
        spellSeen++;
      }
    }
    // The mage should reliably open with one of its big-area spells when
    // three enemies are clustered in cone/sphere range.
    expect(spellSeen).toBeGreaterThan(15);
  });

  it('Mage consumes its per-spell daily counters across many fights', () => {
    let totalUsed = 0;
    for (let trial = 0; trial < 20; trial++) {
      const m = createCreatureWithFixedHp(mage, 'red', { x: 10, y: 10 }, 0);
      const enemies = [
        createCreatureWithFixedHp(goblinWarrior, 'blue', { x: 14, y: 9 }, 0),
        createCreatureWithFixedHp(goblinWarrior, 'blue', { x: 14, y: 10 }, 1),
        createCreatureWithFixedHp(goblinWarrior, 'blue', { x: 14, y: 11 }, 2),
      ];
      const state = runBattle([m, ...enemies], 20);
      const finalMage = state.creatures.find(c => c.id === m.id)!;
      const fireballRemaining = finalMage.resources['fireball-uses'] ?? 2;
      const coneRemaining = finalMage.resources['cone-of-cold-uses'] ?? 1;
      totalUsed += (2 - fireballRemaining) + (1 - coneRemaining);
    }
    // Across 20 fights, the Mage should have burned at least 15
    // big-spell uses total - the per-spell counters are decrementing.
    expect(totalUsed).toBeGreaterThan(15);
  });
});
