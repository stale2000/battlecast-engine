import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp, initBattle } from '../src/engine/combat';
import { trySpellcast } from '../src/engine/ai-spellcasting';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

describe('AI avoids spells the target is immune to', () => {
  it('Wizard does not cast Scorching Ray on fire-immune Barbed Devil', () => {
    const wizard = buildHero('Wizard', 5);
    const barbedDevil = md('Barbed Devil');
    let scorchingRayUsed = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(wizard, 'blue', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(barbedDevil, 'red', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      scorchingRayUsed += state.logs.filter(l =>
        l.actor?.includes('Wizard') && l.action === 'Scorching Ray'
      ).length;
    }
    expect(scorchingRayUsed).toBe(0);
  });

  it('Wizard does not cast Fireball on fire-immune targets', () => {
    const wizard = buildHero('Wizard', 5);
    const barbedDevil = md('Barbed Devil');
    let fireballUsed = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(wizard, 'blue', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(barbedDevil, 'red', { x: 12, y: 10 }, 0),
        createCreatureWithFixedHp(barbedDevil, 'red', { x: 14, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 20);
      fireballUsed += state.logs.filter(l =>
        l.actor?.includes('Wizard') && l.action === 'Fireball'
      ).length;
    }
    expect(fireballUsed).toBe(0);
  });

  it('Wizard prefers Lightning Bolt over Fireball against fire-immune', () => {
    const wizard = buildHero('Wizard', 5);
    const barbedDevil = md('Barbed Devil');
    let lightningUsed = 0;
    let fireUsed = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(wizard, 'blue', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(barbedDevil, 'red', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      for (const l of state.logs) {
        if (l.actor?.includes('Wizard')) {
          if (l.action === 'Lightning Bolt') lightningUsed++;
          if (l.action === 'Fireball' || l.action === 'Scorching Ray' || l.action === 'Burning Hands') fireUsed++;
        }
      }
    }
    expect(fireUsed).toBe(0);
    expect(lightningUsed).toBeGreaterThan(0);
  });

  it('Wizard still casts fire spells on non-immune targets', () => {
    const wizard = buildHero('Wizard', 5);
    const veteran = md('Veteran');
    let fireSpellUsed = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(wizard, 'blue', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'red', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      fireSpellUsed += state.logs.filter(l =>
        l.actor?.includes('Wizard') &&
        (l.action === 'Fireball' || l.action === 'Scorching Ray' || l.action === 'Burning Hands' || l.action === 'Fire Bolt')
      ).length;
    }
    expect(fireSpellUsed).toBeGreaterThan(0);
  });

  it('Ranger does not cast Entangle on a restraint-immune Black Pudding', () => {
    const rangerData = buildHero('Ranger', 5);
    const pudding = md('Black Pudding');
    const ranger = createCreatureWithFixedHp(rangerData, 'blue', { x: 5, y: 10 }, 0);
    const target = createCreatureWithFixedHp(pudding, 'red', { x: 15, y: 10 }, 0);
    ranger.resources['favored-enemy'] = 0;
    ranger.bonusActionUsed = true;
    const state = initBattle([ranger, target], 20);

    const castMainActionSpell = trySpellcast(state, ranger);

    expect(castMainActionSpell).toBe(false);
    expect(state.logs.some(l => l.actor?.includes('Ranger') && l.action === 'Entangle')).toBe(false);
  });

  it('Ranger still casts Entangle on enemies that can be restrained', () => {
    const rangerData = buildHero('Ranger', 5);
    const ogre = md('Ogre');
    const ranger = createCreatureWithFixedHp(rangerData, 'blue', { x: 5, y: 10 }, 0);
    const target = createCreatureWithFixedHp(ogre, 'red', { x: 15, y: 10 }, 0);
    ranger.resources['favored-enemy'] = 0;
    ranger.bonusActionUsed = true;
    const state = initBattle([ranger, target], 20);

    const castMainActionSpell = trySpellcast(state, ranger);

    expect(castMainActionSpell).toBe(true);
    expect(state.logs.some(l => l.actor?.includes('Ranger') && l.action === 'Entangle')).toBe(true);
  });
});
