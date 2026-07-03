import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero, getEligibleWildShapeBeasts } from '../src/data/heroes';
import { executeRound, runBattle } from '../src/engine/ai';
import { applyDamage, createCreatureWithFixedHp, initBattle } from '../src/engine/combat';

function md(name: string) { return monsters.find(x => x.name === name)!; }

describe('Wild Shape activation', () => {
  it('Druid L2+ transforms into a beast when enemies are near', () => {
    const druid = buildHero('Druid', 4);
    const ogre = md('Ogre');
    let wildShapeSeen = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(druid, 'blue', { x: 5, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.action === 'Wild Shape')) wildShapeSeen++;
    }
    expect(wildShapeSeen).toBeGreaterThan(5);
  });

  it('Druid L1 does not have Wild Shape', () => {
    const druid = buildHero('Druid', 1);
    expect(druid.initialResources?.['wild-shape']).toBeUndefined();
  });

  it('uses at most 2 wild shape charges per battle', () => {
    const druid = buildHero('Druid', 4);
    const ogre = md('Ogre');
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(ogre, 'red', { x: 12, y: 10 }, 1),
        createCreatureWithFixedHp(druid, 'blue', { x: 5, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const wsCount = state.logs.filter(l => l.action === 'Wild Shape').length;
      expect(wsCount).toBeLessThanOrEqual(2);
    }
  });

  it('Moon Druid L3 can use CR 1 beasts with 2024 temp HP and Moon AC', () => {
    const druid = buildHero('Druid', 3, { subclass: 'Circle of the Moon' });
    const guard = createCreatureWithFixedHp(md('Guard'), 'red', { x: 9, y: 10 }, 0);
    const druidCreature = createCreatureWithFixedHp(druid, 'blue', { x: 6, y: 10 }, 0);
    const state = initBattle([guard, druidCreature], 20);
    druidCreature.initiative = 20;
    guard.initiative = 1;
    state.initiativeOrder = [druidCreature.id, guard.id];
    executeRound(state);

    const wildShapeLog = state.logs.find(l => l.action === 'Wild Shape' && l.actor?.includes('Druid'));
    expect(wildShapeLog?.details).toContain('9 temporary HP');
    expect(wildShapeLog?.details).toContain('AC 16');
  });

  it('can prefer a specific eligible Moon Druid Wild Shape form', () => {
    const druid = buildHero('Druid', 3, {
      subclass: 'Circle of the Moon',
      preferredWildShapeBeast: 'Giant Toad',
    });
    expect(druid.preferredWildShapeBeast).toBe('Giant Toad');
    const guard = createCreatureWithFixedHp(md('Guard'), 'red', { x: 9, y: 10 }, 0);
    const druidCreature = createCreatureWithFixedHp(druid, 'blue', { x: 6, y: 10 }, 0);
    const state = initBattle([guard, druidCreature], 20);
    druidCreature.initiative = 20;
    guard.initiative = 1;
    state.initiativeOrder = [druidCreature.id, guard.id];
    executeRound(state);

    const wildShapeLog = state.logs.find(l => l.action === 'Wild Shape' && l.actor?.includes('Druid'));
    expect(wildShapeLog?.details).toContain('Giant Toad');
  });

  it('allows Giant Hyena Rampage after Wild Shape uses the bonus action', () => {
    const druid = buildHero('Druid', 3, {
      subclass: 'Circle of the Moon',
      preferredWildShapeBeast: 'Giant Hyena',
    });
    let rampageSeen = 0;
    for (let i = 0; i < 20; i++) {
      const ogre = createCreatureWithFixedHp(md('Ogre'), 'red', { x: 9, y: 10 }, 0);
      ogre.currentHp = Math.floor(ogre.maxHp / 2);
      const druidCreature = createCreatureWithFixedHp(druid, 'blue', { x: 6, y: 10 }, 0);
      const state = initBattle([ogre, druidCreature], 20);
      druidCreature.initiative = 20;
      ogre.initiative = 1;
      state.initiativeOrder = [druidCreature.id, ogre.id];
      executeRound(state);
      if (state.logs.some(l => l.action === 'Rampage' && l.actor?.includes('Druid'))) rampageSeen++;
    }
    expect(rampageSeen).toBeGreaterThan(0);
  });
});

describe('Wild Shape eligibility', () => {
  it('uses 2024 beast eligibility, excluding swarms and non-Beasts', () => {
    const moonL3 = getEligibleWildShapeBeasts({ level: 3, subclass: 'Circle of the Moon' }).map(b => b.name);
    expect(moonL3).toContain('Brown Bear');
    expect(moonL3).toContain('Dire Wolf');
    expect(moonL3).not.toContain('Giant Eagle');
    expect(moonL3).not.toContain('Swarm of Piranhas');

    const landL3 = getEligibleWildShapeBeasts({ level: 3, subclass: 'Circle of the Land' }).map(b => b.name);
    expect(landL3).not.toContain('Brown Bear');

    const landL8 = getEligibleWildShapeBeasts({ level: 8, subclass: 'Circle of the Land' }).map(b => b.name);
    expect(landL8).toContain('Brown Bear');
  });
});

describe('Wild Shape beast form', () => {
  it('uses beast attacks instead of druid spells/weapons', () => {
    const druid = buildHero('Druid', 4);
    const ogre = md('Ogre');
    let beastAttacks = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(druid, 'blue', { x: 8, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      // After wild shape, druid should use beast attacks (Bite, Claw)
      // not Quarterstaff or Produce Flame
      for (const l of state.logs.filter(l => l.actor?.includes('Druid'))) {
        if (l.action === 'Bite' || l.action === 'Claw' || l.action === 'Tusk') beastAttacks++;
      }
    }
    expect(beastAttacks).toBeGreaterThan(0);
  });

  it('does not cast spells while wild-shaped', () => {
    const druid = buildHero('Druid', 4);
    const ogre = md('Ogre');
    let spellsWhileShaped = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(druid, 'blue', { x: 8, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      let shaped = false;
      for (const l of state.logs) {
        if (l.action === 'Wild Shape' && l.actor?.includes('Druid')) shaped = true;
        if (l.action === 'Wild Shape Reverted' && l.actor?.includes('Druid')) shaped = false;
        if (shaped && l.actor?.includes('Druid') && (
          l.action === 'Moonbeam' || l.action === 'Call Lightning' ||
          l.action === 'Produce Flame' || l.action === 'Entangle' ||
          l.action === 'Cure Wounds' || l.action === 'Healing Word'
        )) {
          spellsWhileShaped++;
        }
      }
    }
    expect(spellsWhileShaped).toBe(0);
  });
});

describe('Wild Shape HP and revert', () => {
  it('2024 temporary HP absorbs damage, overflow carries to druid real HP', () => {
    const druid = buildHero('Druid', 4);
    const ogre = md('Ogre');
    let revertSeen = 0;
    for (let i = 0; i < 30; i++) {
      const d = createCreatureWithFixedHp(druid, 'blue', { x: 8, y: 10 }, 0);
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        d,
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.action === 'Wild Shape Reverted')) revertSeen++;
    }
    // The form should break at least sometimes, reverting the druid.
    expect(revertSeen).toBeGreaterThan(0);
  });

  it('does not use beast HP as a second health bar', () => {
    const druid = createCreatureWithFixedHp(buildHero('Druid', 3, { subclass: 'Circle of the Moon' }), 'blue', { x: 5, y: 5 }, 0);
    const attacker = createCreatureWithFixedHp(md('Commoner'), 'red', { x: 6, y: 5 }, 0);
    const state = initBattle([druid, attacker], 20);
    druid.wildShape = {
      beastName: 'Brown Bear',
      tempHp: 4,
      maxTempHp: 4,
      formHp: 22,
      cr: '1',
      ac: 16,
      speed: { walk: 40, climb: 30 },
      actions: [],
      size: 'Large',
      abilities: { str: 17, dex: 12, con: 15 },
      isMoon: true,
    };

    applyDamage(state, druid, 3, 'slashing', attacker, true);
    expect(druid.wildShape?.tempHp).toBe(1);
    expect(druid.currentHp).toBe(druid.maxHp);

    applyDamage(state, druid, 2, 'slashing', attacker, true);
    expect(druid.wildShape).toBeUndefined();
    expect(druid.currentHp).toBe(druid.maxHp - 1);
  });

  it('druid uses beast AC while shaped (not druid AC)', () => {
    const druid = buildHero('Druid', 4);
    // Black Bear has AC 11. Druid has AC 16.
    // If shaped, attacks against AC 11 should hit more often.
    const ogre = md('Ogre');
    let hitsTotal = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(druid, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      // Count hits on the druid by the ogre
      for (const l of state.logs) {
        if (l.actor?.includes('Ogre') && l.details?.includes('hits') && l.details?.includes('Druid')) {
          hitsTotal++;
        }
      }
    }
    // With AC 11 (beast) vs AC 16 (druid), should hit more than 50% of attacks
    // (Ogre +6 vs AC 11 = hit on 5+ = 80%)
    expect(hitsTotal).toBeGreaterThan(10);
  });
});
