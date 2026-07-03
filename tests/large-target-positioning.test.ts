import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

describe('Creatures spread around Large+ targets, not cluster at origin', () => {
  it('attackers approach from their nearest side, not all from the origin corner', () => {
    const tarrasque = md('Tarrasque');
    const harmlessGargantuan = {
      ...tarrasque,
      name: 'Harmless Gargantuan Target',
      actions: [],
      legendaryActions: [],
      legendaryActionUses: 0,
      initialResources: undefined,
    };
    const barbarian = buildHero('Barbarian', 6);

    // Place barbarians on opposite sides of the Tarrasque (4x4 at 8,8)
    // Barbarian A starts left, B starts right
    // After movement, A should be on the left side and B on the right
    let spreadSeen = false;
    for (let trial = 0; trial < 10; trial++) {
      const creatures = [
        createCreatureWithFixedHp(harmlessGargantuan, 'red', { x: 8, y: 8 }, 0),
        createCreatureWithFixedHp(barbarian, 'blue', { x: 3, y: 10 }, 0),
        createCreatureWithFixedHp(barbarian, 'blue', { x: 16, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 2);
      const barbs = state.creatures.filter(c => c.team === 'blue' && c.isAlive);
      if (barbs.length >= 2) {
        const xs = barbs.map(b => b.position.x).sort((a, b) => a - b);
        // One should be left of center (< 10), one right of center (> 10)
        if (xs[0] <= 8 && xs[1] >= 11) spreadSeen = true;
      }
    }
    expect(spreadSeen).toBe(true);
  });

  it('attacker moves to nearest edge of Large target, not origin', () => {
    const dragon = md('Adult Red Dragon'); // Large (2x2)
    const barbarian = buildHero('Barbarian', 6);

    // Barbarian starts to the RIGHT of the dragon
    // Dragon at (10,10), barbarian at (15,11)
    // Should move toward (12,11) - right edge - not (10,10) - origin
    let movedToRightSide = false;
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(dragon, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(barbarian, 'blue', { x: 15, y: 11 }, 0),
      ];
      const state = runBattle(creatures, 3);
      const barb = state.creatures.find(c => c.team === 'blue');
      if (barb && barb.position.x >= 11) movedToRightSide = true;
    }
    expect(movedToRightSide).toBe(true);
  });
});
