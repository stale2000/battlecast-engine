/**
 * Tests for MonteCarloResult.roundsDistribution (roadmap #11).
 *
 * The distribution is the raw array of battle lengths, one entry per
 * completed battle. The UI buckets it for rendering; these tests pin
 * the engine-side contract.
 */
import { describe, expect, test } from 'vitest';
import { runMonteCarlo } from '../src/engine/ai';
import { monsters } from '../src/data/monsters';

describe('roundsDistribution', () => {
  test('length matches totalBattles on a full run', async () => {
    const veteran = monsters.find(m => m.name === 'Veteran')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    const r = await runMonteCarlo(
      [{ data: veteran, count: 1 }],
      [{ data: commoner, count: 3 }],
      40,
      15,
    );
    expect(r.roundsDistribution).toHaveLength(r.totalBattles);
    expect(r.totalBattles).toBe(40);
  });

  test('length matches actual battles completed on a cancelled run', async () => {
    const veteran = monsters.find(m => m.name === 'Veteran')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    let calls = 0;
    const r = await runMonteCarlo(
      [{ data: veteran, count: 1 }],
      [{ data: commoner, count: 1 }],
      100,
      15,
      undefined,
      undefined, undefined, undefined,
      () => { calls += 1; return calls > 7; },
    );
    expect(r.roundsDistribution).toHaveLength(r.totalBattles);
    expect(r.totalBattles).toBe(7);
  });

  test('every entry is a positive integer', async () => {
    const veteran = monsters.find(m => m.name === 'Veteran')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    const r = await runMonteCarlo(
      [{ data: veteran, count: 1 }],
      [{ data: commoner, count: 3 }],
      30,
      15,
    );
    for (const n of r.roundsDistribution) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  test('sum of distribution equals avgRounds * totalBattles (within 1 round)', async () => {
    const veteran = monsters.find(m => m.name === 'Veteran')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    const r = await runMonteCarlo(
      [{ data: veteran, count: 1 }],
      [{ data: commoner, count: 2 }],
      50,
      15,
    );
    const sum = r.roundsDistribution.reduce((a, b) => a + b, 0);
    // avgRounds = totalRounds / totalBattles, so sum = avgRounds * totalBattles.
    // Allow 1-round tolerance for floating-point rounding at large battle counts.
    expect(Math.abs(sum - r.avgRounds * r.totalBattles)).toBeLessThan(1);
  });

  test('empty array on immediate-cancel run (0 battles completed)', async () => {
    const veteran = monsters.find(m => m.name === 'Veteran')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    const r = await runMonteCarlo(
      [{ data: veteran, count: 1 }],
      [{ data: commoner, count: 1 }],
      100,
      15,
      undefined,
      undefined, undefined, undefined,
      () => true, // cancel before the first battle
    );
    expect(r.totalBattles).toBe(0);
    expect(r.roundsDistribution).toEqual([]);
  });

  test('different matchups produce visibly different distributions', async () => {
    // Lopsided matchup → short distribution clustered low
    const ancient = monsters.find(m => m.name === 'Ancient Red Dragon')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    const lopsided = await runMonteCarlo(
      [{ data: ancient, count: 1 }],
      [{ data: commoner, count: 3 }],
      30,
      20,
    );

    // Balanced attrition fight → longer / wider distribution
    const veteran = monsters.find(m => m.name === 'Veteran')!;
    const ogre = monsters.find(m => m.name === 'Ogre')!;
    const balanced = await runMonteCarlo(
      [{ data: veteran, count: 3 }],
      [{ data: ogre, count: 2 }],
      30,
      20,
    );

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const lopsidedMean = avg(lopsided.roundsDistribution);
    const balancedMean = avg(balanced.roundsDistribution);
    // Balanced fight should run longer than a dragon vs 3 commoners.
    expect(balancedMean).toBeGreaterThan(lopsidedMean);
  });
});
