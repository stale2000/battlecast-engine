/**
 * Tests for the extended `runMonteCarlo` onProgress callback.
 *
 * The callback now receives a full MonteCarloProgress snapshot (counts,
 * not just %) so a worker can forward it to the UI for live win-%
 * display. Firing is wall-clock-rate-limited (~4/sec) rather than
 * per-battle - these tests verify the counts are monotonic and the
 * final tick always carries completed === total.
 */
import { describe, expect, test } from 'vitest';
import { runMonteCarlo, type MonteCarloProgress } from '../src/engine/ai';
import { monsters } from '../src/data/monsters';

async function quickSetup(numBattles: number) {
  const goblin = monsters.find(m => m.name === 'Goblin Warrior')!;
  const commoner = monsters.find(m => m.name === 'Commoner')!;
  const ticks: MonteCarloProgress[] = [];
  const result = await runMonteCarlo(
    [{ data: goblin, count: 1 }],
    [{ data: commoner, count: 1 }],
    numBattles,
    10,
    (p) => ticks.push({ ...p }),
    undefined,
    undefined,
    undefined,
  );
  return { ticks, result };
}

describe('runMonteCarlo onProgress (MonteCarloProgress snapshot)', async () => {
  test('fires at least once (for the final battle)', async () => {
    const { ticks } = await quickSetup(10);
    expect(ticks.length).toBeGreaterThan(0);
  });

  test('final tick has completed === total', async () => {
    const { ticks } = await quickSetup(50);
    const last = ticks[ticks.length - 1];
    expect(last.completed).toBe(last.total);
    expect(last.total).toBe(50);
  });

  test('completed count is monotonic (non-decreasing)', async () => {
    const { ticks } = await quickSetup(100);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].completed).toBeGreaterThanOrEqual(ticks[i - 1].completed);
    }
  });

  test('sum of win counts never exceeds completed', async () => {
    const { ticks } = await quickSetup(50);
    for (const p of ticks) {
      expect(p.redWins + p.blueWins + p.draws).toBeLessThanOrEqual(p.completed);
    }
  });

  test('win counts at final tick match the returned result', async () => {
    const { ticks, result } = await quickSetup(50);
    const last = ticks[ticks.length - 1];
    expect(last.redWins).toBe(result.redWins);
    expect(last.blueWins).toBe(result.blueWins);
    expect(last.draws).toBe(result.draws);
  });

  test('totalRounds accumulates over the run', async () => {
    const { ticks } = await quickSetup(30);
    const last = ticks[ticks.length - 1];
    // Every battle runs for at least 1 round, so at 30 battles totalRounds
    // is a positive number at the end.
    expect(last.totalRounds).toBeGreaterThan(0);
  });

  test('tiny run (1 battle) still fires onProgress once', async () => {
    const { ticks } = await quickSetup(1);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[ticks.length - 1].completed).toBe(1);
    expect(ticks[ticks.length - 1].total).toBe(1);
  });

  test('runs without onProgress callback still complete', async () => {
    const goblin = monsters.find(m => m.name === 'Goblin Warrior')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    const result = await runMonteCarlo(
      [{ data: goblin, count: 1 }],
      [{ data: commoner, count: 1 }],
      20,
      10,
      undefined, // no callback
    );
    expect(result.totalBattles).toBe(20);
  });
});

describe('cooperative cancel via shouldStop', async () => {
  /**
   * shouldStop lets the worker ask runMonteCarlo to break out of its
   * loop after the current battle finishes. The returned result must
   * reflect the actual number of completed battles AND still have
   * full perCreature stats for those battles - that's the whole
   * point of cooperative cancel vs worker.terminate().
   */
  test('shouldStop cuts the run short and result reflects actual count', async () => {
    const goblin = monsters.find(m => m.name === 'Goblin Warrior')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    // shouldStop is called at the start of each loop iteration, so an
    // iteration counter mirrors "battles attempted" exactly (no race
    // with the rate-limited progress callback). Request stop on the
    // 6th call → 5 battles run.
    let calls = 0;
    const result = await runMonteCarlo(
      [{ data: goblin, count: 1 }],
      [{ data: commoner, count: 1 }],
      100,
      10,
      undefined,
      undefined, undefined, undefined,
      () => {
        calls += 1;
        return calls > 5;
      },
    );
    expect(result.totalBattles).toBe(5);
  });

  test('cancelled run still has populated perCreature stats', async () => {
    const goblin = monsters.find(m => m.name === 'Goblin Warrior')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    let calls = 0;
    const result = await runMonteCarlo(
      [{ data: goblin, count: 2 }],
      [{ data: commoner, count: 3 }],
      50,
      10,
      undefined,
      undefined, undefined, undefined,
      () => { calls += 1; return calls > 10; },
    );
    // 2 goblin + 3 commoner types → at least 2 distinct keys in perCreature.
    expect(result.perCreature.size).toBeGreaterThanOrEqual(2);
    // Every entry should have real battle counts, not zero.
    for (const stats of result.perCreature.values()) {
      // survivalRate is a computed ratio - checking that its source
      // battles > 0 would require exposing internals. Instead: verify
      // damage aggregates are sensible (non-negative, not NaN).
      expect(Number.isFinite(stats.avgDamageDealt)).toBe(true);
      expect(stats.avgDamageDealt).toBeGreaterThanOrEqual(0);
    }
  });

  test('redWinPct is still 0-100 after cancel (not NaN or 0-1)', async () => {
    const goblin = monsters.find(m => m.name === 'Goblin Warrior')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    let calls = 0;
    const result = await runMonteCarlo(
      [{ data: goblin, count: 1 }],
      [{ data: commoner, count: 1 }],
      100,
      10,
      undefined,
      undefined, undefined, undefined,
      () => { calls += 1; return calls > 5; },
    );
    expect(Number.isFinite(result.redWinPct)).toBe(true);
    expect(result.redWinPct).toBeGreaterThanOrEqual(0);
    expect(result.redWinPct).toBeLessThanOrEqual(100);
    // sum should still be close to 100.
    const drawPct = (result.draws / result.totalBattles) * 100;
    expect(result.redWinPct + result.blueWinPct + drawPct).toBeCloseTo(100, 1);
  });

  test('shouldStop firing before the first battle returns empty result without crashing', async () => {
    const goblin = monsters.find(m => m.name === 'Goblin Warrior')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    const result = await runMonteCarlo(
      [{ data: goblin, count: 1 }],
      [{ data: commoner, count: 1 }],
      100,
      10,
      undefined,
      undefined, undefined, undefined,
      () => true, // cancel immediately
    );
    expect(result.totalBattles).toBe(0);
    // Math should not blow up - redWinPct should be NaN-free.
    expect(Number.isFinite(result.redWinPct)).toBe(true);
  });
});

describe('MonteCarloResult.redWinPct / blueWinPct contract (regression: cancel path math)', async () => {
  /**
   * Guards against a bug in the cancel path where partial results
   * stored win% as a 0-1 ratio instead of 0-100 percentage, making
   * the result modal's stacked winbar render at 1/100th width. This
   * test pins the contract that runMonteCarlo uses, and
   * `useBattle.cancelMonteCarloSim` must keep synthesizing partials
   * that match it.
   */
  test('full run: redWinPct + blueWinPct + drawPct add up to ~100', async () => {
    const veteran = monsters.find(m => m.name === 'Veteran')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    const r = await runMonteCarlo(
      [{ data: veteran, count: 1 }],
      [{ data: commoner, count: 5 }],
      50,
      20,
    );
    const drawPct = (r.draws / r.totalBattles) * 100;
    expect(r.redWinPct + r.blueWinPct + drawPct).toBeCloseTo(100, 1);
  });

  test('full run: redWinPct is in the 0-100 range, never 0-1', async () => {
    const veteran = monsters.find(m => m.name === 'Veteran')!;
    const commoner = monsters.find(m => m.name === 'Commoner')!;
    // Use a mismatch so red wins most - redWinPct should be >> 1
    // (it should be ~80+). If the contract got broken to 0-1, this
    // would be ~0.8 and the test would catch it.
    const r = await runMonteCarlo(
      [{ data: veteran, count: 1 }],
      [{ data: commoner, count: 1 }],
      30,
      20,
    );
    // Red (veteran, 58 HP, big damage) should beat a single commoner
    // the vast majority of the time. redWinPct must be > 1 to prove
    // the stored value is 0-100, not 0-1.
    expect(r.redWinPct).toBeGreaterThan(1);
  });
});
