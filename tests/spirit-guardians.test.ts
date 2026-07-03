import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';
import { monsters } from '../src/data/monsters';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

describe('Spirit Guardians is self-centered', () => {
  it('Spirit Guardians area is emanation (caster-centered), not sphere (point-targeted)', () => {
    const cleric = buildHero('Cleric', 5);
    const sg = cleric.actions.find(a => a.name === 'Spirit Guardians');
    expect(sg).toBeDefined();
    expect(sg!.savingThrow?.area?.toLowerCase()).toContain('emanation');
  });

  it('Spirit Guardians only hits enemies near the Cleric, not at range', () => {
    const cleric = buildHero('Cleric', 5);
    const goblin = md('Goblin Warrior');
    let hitFarTarget = false;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(cleric, 'blue', { x: 3, y: 10 }, 0),
        // Near goblin - should be hit by SG
        createCreatureWithFixedHp(goblin, 'red', { x: 5, y: 10 }, 0),
        // Far goblin - should NOT be hit by SG (15ft = 3 cells away is limit)
        createCreatureWithFixedHp(goblin, 'red', { x: 15, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 5);
      // Check if Spirit Guardians damaged the far goblin
      for (const l of state.logs) {
        if (l.action === 'Spirit Guardians' || l.details?.includes('Spirit Guardians')) {
          // If the far goblin (at x=15) made a save against SG, it was targeted at range
          if (l.actor?.includes('Goblin Warrior 2') && (l.action === 'Save' || l.action === 'Failed Save')) {
            hitFarTarget = true;
          }
        }
      }
    }
    expect(hitFarTarget).toBe(false);
  });
});
