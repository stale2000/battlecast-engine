import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { runMonteCarlo } from '../src/engine/ai';
import { MonsterData } from '../src/types/monster';

/**
 * runMonteCarlo is the single consumer of the new `deathRound` stat that
 * combat.applyDamage writes on death. These tests lock in:
 *
 * 1. avgDeathRound is `null` for types that never die in the simulation.
 * 2. avgDeathRound is present for types that do die.
 * 3. deathCount tracks the number of creature-appearances that ended in death.
 * 4. In a matchup where squishy creatures fight tanky ones, the squishies
 *    have a lower avgDeathRound than the tanks - "dies first" is monotonic
 *    in HP/AC where those are the dominant factors.
 */
describe('runMonteCarlo - avgDeathRound tracking', () => {
  const get = (name: string): MonsterData => {
    const m = monsters.find(x => x.name === name);
    if (!m) throw new Error(`missing monster: ${name}`);
    return m;
  };

  it('records avgDeathRound for creatures that die and null for those that survive', async () => {
    // Pit Fiend is CR 20 - it obliterates goblins in round 1 and never dies.
    // Goblins are CR 1/4 and always die.
    const r = await runMonteCarlo(
      [{ data: get('Pit Fiend'), count: 1 }],
      [{ data: get('Goblin Minion'), count: 6 }],
      40,
      20,
    );

    const pitFiend = r.perCreature.get('Pit Fiend-red');
    const goblin = r.perCreature.get('Goblin Minion-blue');

    expect(pitFiend).toBeDefined();
    expect(goblin).toBeDefined();

    // Pit Fiend never dies → avgDeathRound is null and deathCount is 0
    expect(pitFiend!.avgDeathRound).toBeNull();
    expect(pitFiend!.deathCount).toBe(0);
    expect(pitFiend!.survivalRate).toBe(1);

    // Goblins almost always die → deathCount > 0 and avgDeathRound is a
    // finite number. PR B kite-zone math lets goblins survive longer than
    // before (they actively avoid Pit Fiend's reach), so the threshold is
    // relaxed - the assertion is "majority die" not "nearly all die".
    expect(goblin!.deathCount).toBeGreaterThan(0);
    expect(goblin!.avgDeathRound).not.toBeNull();
    expect(goblin!.avgDeathRound).toBeGreaterThanOrEqual(1);
    expect(goblin!.survivalRate).toBeLessThan(0.4);
  });

  it('ranks squishy creatures as dying earlier than tanky ones on the same team', async () => {
    // Mix goblins (HP ~7) with trolls (HP ~84, regen) on the same side,
    // versus a stronger red team. Trolls should die later than goblins.
    const r = await runMonteCarlo(
      [{ data: get('Adult Red Dragon'), count: 1 }],
      [{ data: get('Goblin Minion'), count: 4 }, { data: get('Troll'), count: 2 }],
      80,
      24,
    );

    const goblin = r.perCreature.get('Goblin Minion-blue')!;
    const troll = r.perCreature.get('Troll-blue')!;

    // Both types should have died at least sometimes against a dragon
    expect(goblin.deathCount).toBeGreaterThan(0);
    expect(troll.deathCount).toBeGreaterThan(0);

    // Goblins (7 HP, no regen) die meaningfully before trolls (84 HP, regen)
    expect(goblin.avgDeathRound).not.toBeNull();
    expect(troll.avgDeathRound).not.toBeNull();
    expect(goblin.avgDeathRound!).toBeLessThan(troll.avgDeathRound!);
  });

  it('deathCount + survivalCount equals total creature-appearances per type', async () => {
    const count = 3;
    const battles = 50;
    const r = await runMonteCarlo(
      [{ data: get('Veteran'), count }],
      [{ data: get('Ogre'), count }],
      battles,
      20,
    );

    for (const entry of r.perCreature.values()) {
      // survivalCount isn't exposed directly, but we can back it out:
      // survivalRate = survivalCount / battles-appearances
      // appearances = count * totalBattles
      const appearances = count * battles;
      const survivalCount = Math.round(entry.survivalRate * appearances);
      expect(entry.deathCount + survivalCount).toBe(appearances);
    }
  });

  it('heroSummary is undefined for pure monster-vs-monster runs', async () => {
    const r = await runMonteCarlo(
      [{ data: get('Goblin Minion'), count: 2 }],
      [{ data: get('Kobold'), count: 2 }],
      10,
      20,
    );
    expect(r.heroSummary).toBeUndefined();
  });
});
