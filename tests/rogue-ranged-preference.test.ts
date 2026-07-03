import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { monsters } from '../src/data/monsters';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

describe('Rogue uses Rapier when stuck in melee', () => {
  it('Rogue uses Rapier when fully surrounded and can\'t escape', () => {
    const rogue = buildHero('Rogue', 5);
    const ogre = md('Ogre');
    let rapierUsed = 0;
    for (let i = 0; i < 20; i++) {
      // Rogue completely boxed in - all 8 adjacent cells occupied
      const creatures = [
        createCreatureWithFixedHp(rogue, 'blue', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(ogre, 'red', { x: 9, y: 9 }, 0),
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 9 }, 1),
        createCreatureWithFixedHp(ogre, 'red', { x: 11, y: 9 }, 2),
        createCreatureWithFixedHp(ogre, 'red', { x: 9, y: 10 }, 3),
        createCreatureWithFixedHp(ogre, 'red', { x: 11, y: 10 }, 4),
        createCreatureWithFixedHp(ogre, 'red', { x: 9, y: 11 }, 5),
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 11 }, 6),
        createCreatureWithFixedHp(ogre, 'red', { x: 11, y: 11 }, 7),
      ];
      const state = runBattle(creatures, 2);
      rapierUsed += state.logs.filter(l =>
        l.actor?.includes('Rogue') && l.action === 'Rapier'
      ).length;
    }
    expect(rapierUsed).toBeGreaterThan(0);
  });
});

describe('Rogue prefers ranged attacks over melee when possible', () => {
  it('Rogue uses Shortbow when starting at range from a slower enemy', () => {
    const rogue = buildHero('Rogue', 5);
    const zombie = md('Zombie'); // Speed 20 - can't catch the Rogue
    let shortbowUsed = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(rogue, 'blue', { x: 3, y: 10 }, 0),
        createCreatureWithFixedHp(zombie, 'red', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      shortbowUsed += state.logs.filter(l =>
        l.actor?.includes('Rogue') && l.action === 'Shortbow'
      ).length;
    }
    expect(shortbowUsed).toBeGreaterThan(10);
  });

  it('Rogue kites away when starting adjacent to a tough slow enemy', () => {
    const rogue = buildHero('Rogue', 5);
    const troll = md('Troll'); // Speed 30, 94 HP - tough, same speed as Rogue
    let kiteSeen = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(rogue, 'blue', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(troll, 'red', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 10);
      kiteSeen += state.logs.filter(l =>
        l.actor?.includes('Rogue') && (l.action === 'Cunning Action: Disengage' || l.details?.includes('ranged distance'))
      ).length;
    }
    expect(kiteSeen).toBeGreaterThan(0);
  });
});
