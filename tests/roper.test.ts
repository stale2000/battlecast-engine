import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

describe('Roper data integrity', () => {
  it('has Tentacle with 60ft reach and grapple', () => {
    const roper = md('Roper');
    const tentacle = roper.actions.find(a => a.name === 'Tentacle');
    expect(tentacle).toBeDefined();
    expect(tentacle!.reach).toBe(60);
    expect(tentacle!.conditionOnHit?.condition).toBe('grappled');
  });

  it('has Bite with +7 and 3d8+4 damage', () => {
    const roper = md('Roper');
    const bite = roper.actions.find(a => a.name === 'Bite');
    expect(bite).toBeDefined();
    expect(bite!.attackBonus).toBe(7);
    expect(bite!.damage).toBe('3d8+4');
    expect(bite!.reach).toBe(5);
  });

  it('has Reel action', () => {
    const roper = md('Roper');
    const reel = roper.actions.find(a => a.name === 'Reel');
    expect(reel).toBeDefined();
  });

  it('multiattack includes tentacle, reel, and bite', () => {
    const roper = md('Roper');
    const multi = roper.actions.find(a => a.type === 'multiattack');
    expect(multi).toBeDefined();
    const desc = multi!.description.toLowerCase();
    expect(desc).toContain('tentacle');
    expect(desc).toContain('reel');
    expect(desc).toContain('bite');
  });
});

describe('Roper Reel mechanic', () => {
  it('Roper reels grappled targets closer', () => {
    const roper = md('Roper');
    const veteran = md('Veteran');
    let reelSeen = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(roper, 'red', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      reelSeen += state.logs.filter(l => l.action === 'Reel').length;
    }
    expect(reelSeen).toBeGreaterThan(0);
  });

  it('Roper deals Bite damage after Reel pulls target close', () => {
    const roper = md('Roper');
    const veteran = md('Veteran');
    let biteDmg = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(roper, 'red', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      biteDmg += state.logs.filter(l =>
        l.actor?.includes('Roper') && l.action === 'Bite' && (l.damage ?? 0) > 0
      ).length;
    }
    expect(biteDmg).toBeGreaterThan(0);
  });

  it('Roper kills enemies (not just grapples forever)', () => {
    const roper = md('Roper');
    const commoner = md('Commoner');
    let roperWins = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(roper, 'red', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const roperAlive = state.creatures.find(c => c.name === 'Roper')?.isAlive;
      const commonerAlive = state.creatures.find(c => c.name === 'Commoner')?.isAlive;
      if (roperAlive && !commonerAlive) roperWins++;
    }
    expect(roperWins).toBe(20);
  });

  it('Roper uses full combat sequence: Tentacle → Reel → Bite', () => {
    const roper = md('Roper');
    const veteran = md('Veteran');
    let fullSequenceSeen = false;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(roper, 'red', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const roperLogs = state.logs.filter(l => l.actor?.includes('Roper'));
      let sawTentacle = false;
      let sawReel = false;
      for (const log of roperLogs) {
        if (log.action === 'Tentacle') sawTentacle = true;
        if (log.action === 'Reel' && sawTentacle) sawReel = true;
        if (log.action === 'Bite' && sawReel && (log.damage ?? 0) > 0) {
          fullSequenceSeen = true;
          break;
        }
      }
      if (fullSequenceSeen) break;
    }
    expect(fullSequenceSeen).toBe(true);
  });

  it('Roper grapples and reels across multiple battles', () => {
    const roper = md('Roper');
    const veteran = md('Veteran');
    let totalReels = 0;
    let totalGrapples = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(roper, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 3, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 17, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 20);
      totalReels += state.logs.filter(l => l.action === 'Reel').length;
      totalGrapples += state.logs.filter(l => l.details?.includes('grappled') || l.details?.includes('Grappled')).length;
    }
    // Roper should grapple and reel frequently
    expect(totalGrapples).toBeGreaterThan(5);
    expect(totalReels).toBeGreaterThan(0);
  });
});

describe('Roper vs party balance', () => {
  it('Roper (CR 5) beats 2 commoners consistently', () => {
    const roper = md('Roper');
    const commoner = md('Commoner');
    let roperWins = 0;
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(roper, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 3, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 17, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 20);
      const alive = state.creatures.filter(c => c.isAlive);
      if (alive.every(c => c.team === 'red')) roperWins++;
    }
    expect(roperWins).toBe(10);
  });

  it('Roper deals meaningful damage per battle', () => {
    const roper = md('Roper');
    const veteran = md('Veteran');
    let totalDmg = 0;
    const trials = 20;
    for (let i = 0; i < trials; i++) {
      const creatures = [
        createCreatureWithFixedHp(roper, 'red', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 15, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const roperCreature = state.creatures.find(c => c.name === 'Roper');
      totalDmg += roperCreature?.stats.damageDealt ?? 0;
    }
    // Roper should deal at least some average damage per battle (Bite is 3d8+4 = ~17 per hit)
    expect(totalDmg / trials).toBeGreaterThan(10);
  });
});
