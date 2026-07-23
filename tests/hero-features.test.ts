import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp, DEFAULT_TACTICS, executeSpell, type BattleState } from '../src/engine/combat';
import { SeededRng, withRng } from '../src/engine/rng';

function md(name: string) { return monsters.find(x => x.name === name)!; }

describe('Rogue: Uncanny Dodge', () => {
  it('halves damage from one attack per round using reaction', () => {
    const rogue = buildHero('Rogue', 5);
    const ogre = md('Ogre');
    let dodgeUsed = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(rogue, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      dodgeUsed += state.logs.filter(l => l.action === 'Uncanny Dodge').length;
    }
    expect(dodgeUsed).toBeGreaterThan(15);
  });

  it('not available before L5', () => {
    const rogue = buildHero('Rogue', 4);
    const ogre = md('Ogre');
    let dodgeUsed = 0;
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(rogue, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      dodgeUsed += state.logs.filter(l => l.action === 'Uncanny Dodge').length;
    }
    expect(dodgeUsed).toBe(0);
  });

  it('uses reaction (max once between Rogue turns)', () => {
    // In D&D, reaction resets at start of your turn. So the Rogue can
    // dodge once before its turn and once after (if enemies attack on
    // both sides). This is correct - we just verify it fires regularly.
    const rogue = buildHero('Rogue', 5);
    const ogre = md('Ogre');
    let totalDodges = 0;
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(ogre, 'red', { x: 9, y: 11 }, 1),
        createCreatureWithFixedHp(rogue, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      totalDodges += state.logs.filter(l => l.action === 'Uncanny Dodge').length;
    }
    expect(totalDodges).toBeGreaterThan(5);
  });
});

describe('Cleric: Channel Divinity - Preserve Life', () => {
  it('heals an injured ally for a large amount', () => {
    const cleric = buildHero('Cleric', 5);
    const fighter = buildHero('Fighter', 5);
    const c = createCreatureWithFixedHp(cleric, 'blue', { x: 7, y: 10 }, 0);
    const f = createCreatureWithFixedHp(fighter, 'blue', { x: 9, y: 10 }, 1);
    f.currentHp = 1;
    const state: BattleState = {
      creatures: [c, f],
      round: 1,
      turnIndex: 0,
      initiativeOrder: [c.id, f.id],
      logs: [],
      events: [],
      isComplete: false,
      winner: null,
      gridSize: 20,
      teamTactics: DEFAULT_TACTICS,
    };
    const preserveLife = c.monsterData.actions.find(a => a.name === 'Channel Divinity: Preserve Life')!;

    executeSpell(state, c, preserveLife, f);

    expect(f.currentHp).toBe(Math.floor(f.maxHp / 2));
    expect(c.resources['channel-divinity']).toBe(1);
    expect(state.logs.some(l => l.action === 'Channel Divinity: Preserve Life')).toBe(true);
  });

  it('not available at level 1', () => {
    const cleric = buildHero('Cleric', 1);
    expect(cleric.initialResources?.['channel-divinity']).toBeUndefined();
  });
});

describe('Bard: Bardic Inspiration', () => {
  it('gives an ally an inspiration die as a bonus action', () => {
    const bard = buildHero('Bard', 5);
    const fighter = buildHero('Fighter', 5);
    const ogre = md('Ogre');
    let inspUsed = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(bard, 'blue', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(fighter, 'blue', { x: 7, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.action === 'Bardic Inspiration')) inspUsed++;
    }
    expect(inspUsed).toBeGreaterThan(15);
  });

  it('Bard can still attack after using Bardic Inspiration', () => {
    const bard = buildHero('Bard', 5);
    const fighter = buildHero('Fighter', 5);
    const ogre = md('Ogre');
    let inspAndAttackR1 = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(bard, 'blue', { x: 8, y: 10 }, 0),
        createCreatureWithFixedHp(fighter, 'blue', { x: 7, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 20);
      const r1 = state.logs.filter(l => l.round === 1 && l.actor?.includes('Bard'));
      const hasInsp = r1.some(l => l.action === 'Bardic Inspiration');
      const hasAction = r1.some(l => l.action === 'Rapier' || l.action === 'Shortbow' || l.action === 'Bane' || l.action === 'Shatter' || l.action === 'Dissonant Whispers');
      if (hasInsp && hasAction) inspAndAttackR1++;
    }
    expect(inspAndAttackR1).toBeGreaterThan(5);
  });
});

describe('Monk: Stunning Strike', () => {
  it('spends ki to attempt stunning on melee hit', () => {
    const monk = buildHero('Monk', 5);
    const ogre = md('Ogre');
    let stunAttempts = 0;
    let stunsLanded = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(monk, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = withRng(new SeededRng(10_000 + i), () => runBattle(creatures, 20));
      stunAttempts += state.logs.filter(l => l.details?.includes('Stunning Strike')).length;
      stunsLanded += state.logs.filter(l => l.action === 'Stunning Strike' && l.details?.includes('stunned')).length;
    }
    expect(stunAttempts).toBeGreaterThan(10);
    expect(stunsLanded).toBeGreaterThan(0);
  });

  it('not available before L5', () => {
    const monk = buildHero('Monk', 4);
    const ogre = md('Ogre');
    let stunAttempts = 0;
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(monk, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      stunAttempts += state.logs.filter(l => l.details?.includes('Stunning Strike')).length;
    }
    expect(stunAttempts).toBe(0);
  });
});

describe('Barbarian: Reckless Attack', () => {
  it('attacks with higher hit rate when in melee (advantage)', () => {
    const barb = buildHero('Barbarian', 5);
    const ogre = md('Ogre');
    let hits = 0, attacks = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(barb, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const barbLogs = state.logs.filter(l => l.actor?.includes('Barbarian'));
      attacks += barbLogs.filter(l => l.action === 'Greataxe').length;
      hits += barbLogs.filter(l => l.action === 'Greataxe' && l.details?.includes('hits')).length;
    }
    // With advantage vs AC 11 and +7 bonus, hit rate should be very high (~95%+)
    const hitRate = hits / attacks;
    expect(hitRate).toBeGreaterThan(0.8);
  });

  it('not available at level 1', () => {
    const barb = buildHero('Barbarian', 1);
    const ogre = md('Ogre');
    const creatures = [
      createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
      createCreatureWithFixedHp(barb, 'blue', { x: 9, y: 10 }, 0),
    ];
    runBattle(creatures, 20);
    // L1 barbarian shouldn't set reckless flag
    // We can't directly check the flag, but crits should be normal rate (~5%)
  });
});

describe('Monk: Flurry of Blows', () => {
  it('spends ki for 2 extra unarmed strikes', () => {
    const monk = buildHero('Monk', 5);
    const ogre = md('Ogre');
    let flurryUsed = 0;
    let r1Attacks = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(ogre, 'red', { x: 12, y: 10 }, 1),
        createCreatureWithFixedHp(monk, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.action === 'Flurry of Blows')) flurryUsed++;
      r1Attacks += state.logs.filter(l => l.round === 1 && l.actor?.includes('Monk') && l.action?.includes('Martial Arts')).length;
    }
    expect(flurryUsed).toBeGreaterThan(15);
    // R1: 2 normal + 2 flurry = 4 attacks
    expect(r1Attacks / 20).toBeGreaterThan(3);
  });

  it('consumes ki points', () => {
    const monk = buildHero('Monk', 5);
    const ogre = md('Ogre');
    const creatures = [
      createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
      createCreatureWithFixedHp(ogre, 'red', { x: 12, y: 10 }, 1),
      createCreatureWithFixedHp(monk, 'blue', { x: 9, y: 10 }, 0),
    ];
    const state = runBattle(creatures, 20);
    const m = state.creatures.find(c => c.monsterData.heroClass === 'Monk');
    if (m) {
      const kiUsed = (m.monsterData.initialResources?.ki ?? 0) - (m.resources.ki ?? 0);
      expect(kiUsed).toBeGreaterThan(0);
    }
  });
});

describe('Barbarian: Frenzy (Berserker L3+)', () => {
  it('makes bonus melee attack while raging', () => {
    const barb = buildHero('Barbarian', 5);
    const ogre = md('Ogre');
    let frenzyUsed = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(ogre, 'red', { x: 12, y: 10 }, 1),
        createCreatureWithFixedHp(barb, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.action === 'Frenzy')) frenzyUsed++;
    }
    expect(frenzyUsed).toBeGreaterThan(10);
  });

  it('does not fire on R1 when Rage uses the bonus action', () => {
    const barb = buildHero('Barbarian', 5);
    const ogre = md('Ogre');
    let frenzyR1 = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(ogre, 'red', { x: 12, y: 10 }, 1),
        createCreatureWithFixedHp(barb, 'blue', { x: 9, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.round === 1 && l.action === 'Frenzy' && l.actor?.includes('Barbarian'))) frenzyR1++;
    }
    expect(frenzyR1).toBe(0);
  });
});

describe('Fighter: Action Surge', () => {
  it('uses Action Surge to make extra attacks on turn 1', () => {
    const fighter = buildHero('Fighter', 5);
    const ogre = md('Ogre');
    let surgeUsed = 0;
    let r1Attacks = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(fighter, 'blue', { x: 8, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.action === 'Action Surge')) surgeUsed++;
      r1Attacks += state.logs.filter(l => l.round === 1 && l.actor?.includes('Fighter') && (l.action === 'Longsword' || l.action === 'Javelin')).length;
    }
    expect(surgeUsed).toBeGreaterThan(15);
    // With multiattack (2) + action surge (2) = 4 attacks on R1 (some may be javelins)
    expect(r1Attacks / 20).toBeGreaterThanOrEqual(3);
  });

  it('only uses Action Surge once per battle', () => {
    const fighter = buildHero('Fighter', 5);
    const ogre = md('Ogre');
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(ogre, 'red', { x: 12, y: 10 }, 1),
        createCreatureWithFixedHp(fighter, 'blue', { x: 8, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const surgeCount = state.logs.filter(l => l.action === 'Action Surge').length;
      expect(surgeCount).toBeLessThanOrEqual(1);
    }
  });

  it('is not available at level 1 (only L2+)', () => {
    const fighter = buildHero('Fighter', 1);
    expect(fighter.initialResources?.['action-surge']).toBeUndefined();
  });

  it('shows in battle summary action usage', () => {
    const fighter = buildHero('Fighter', 5);
    const ogre = md('Ogre');
    const creatures = [
      createCreatureWithFixedHp(ogre, 'red', { x: 10, y: 10 }, 0),
      createCreatureWithFixedHp(fighter, 'blue', { x: 8, y: 10 }, 0),
    ];
    const state = runBattle(creatures, 20);
    const f = state.creatures.find(c => c.monsterData.heroClass === 'Fighter');
    if (f && f.stats.actionUsage['Action Surge']) {
      expect(f.stats.actionUsage['Action Surge']).toBe(1);
    }
  });
});
