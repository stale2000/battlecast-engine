import { describe, it, expect } from 'vitest';
import { calculateDifficulty, difficultyFraction } from '../src/engine/difficulty';

describe('calculateDifficulty', () => {
  it('returns trivial for 0 XP', () => {
    const r = calculateDifficulty(4, 3, 0);
    expect(r.tier).toBe('trivial');
    expect(r.totalMonsterXP).toBe(0);
    expect(r.perPlayerXP).toBe(0);
  });

  it('returns low for XP just at the low threshold', () => {
    // L3, 4 players: low = 150 * 4 = 600
    const r = calculateDifficulty(4, 3, 600);
    expect(r.tier).toBe('low');
  });

  it('returns moderate for XP at moderate threshold', () => {
    // L3, 4 players: moderate = 225 * 4 = 900
    const r = calculateDifficulty(4, 3, 900);
    expect(r.tier).toBe('moderate');
  });

  it('returns high for XP at high threshold', () => {
    // L3, 4 players: high = 400 * 4 = 1600
    const r = calculateDifficulty(4, 3, 1600);
    expect(r.tier).toBe('high');
  });

  it('returns deadly for XP at deadly threshold', () => {
    // L3, 4 players: deadly = 500 * 4 = 2000
    const r = calculateDifficulty(4, 3, 2000);
    expect(r.tier).toBe('deadly');
  });

  it('scales thresholds with party size', () => {
    const r3 = calculateDifficulty(3, 3, 0);
    const r5 = calculateDifficulty(5, 3, 0);
    expect(r5.thresholds.moderate).toBe(r3.thresholds.moderate * 5 / 3);
  });

  it('perPlayerXP divides total by party size', () => {
    const r = calculateDifficulty(4, 3, 800);
    expect(r.perPlayerXP).toBe(200);
  });

  it('clamps level to 1-20', () => {
    const low = calculateDifficulty(4, 0, 100);
    expect(low.thresholds.low).toBe(200); // L1 * 4
    const high = calculateDifficulty(4, 25, 100);
    expect(high.thresholds.low).toBe(24000); // L20 * 4
  });

  it('handles party size 1', () => {
    const r = calculateDifficulty(1, 5, 750);
    expect(r.tier).toBe('moderate');
    expect(r.thresholds.moderate).toBe(750);
  });

  it('between thresholds falls into lower tier', () => {
    // L3, 4 players: low=600, moderate=900
    const r = calculateDifficulty(4, 3, 750);
    expect(r.tier).toBe('low'); // 750 >= 600 (low) but < 900 (moderate)
  });

  it('labels match tier names', () => {
    expect(calculateDifficulty(4, 3, 0).label).toBe('Trivial');
    expect(calculateDifficulty(4, 3, 600).label).toBe('Low');
    expect(calculateDifficulty(4, 3, 900).label).toBe('Moderate');
    expect(calculateDifficulty(4, 3, 1600).label).toBe('High');
    expect(calculateDifficulty(4, 3, 2000).label).toBe('Deadly');
  });
});

describe('difficultyFraction', () => {
  it('returns 0 for trivial (0 XP)', () => {
    const r = calculateDifficulty(4, 3, 0);
    expect(difficultyFraction(r)).toBe(0);
  });

  it('returns 0.25 at the low threshold', () => {
    // low threshold for L3 × 4 = 600
    const r = calculateDifficulty(4, 3, 600);
    expect(difficultyFraction(r)).toBeCloseTo(0.25, 2);
  });

  it('returns 0.5 at moderate threshold', () => {
    const r = calculateDifficulty(4, 3, 900);
    expect(difficultyFraction(r)).toBeCloseTo(0.5, 2);
  });

  it('returns 0.75 at high threshold', () => {
    const r = calculateDifficulty(4, 3, 1600);
    expect(difficultyFraction(r)).toBeCloseTo(0.75, 2);
  });

  it('returns 1.0 at deadly threshold', () => {
    const r = calculateDifficulty(4, 3, 2000);
    expect(difficultyFraction(r)).toBe(1);
  });

  it('caps at 1.0 for very high XP', () => {
    const r = calculateDifficulty(4, 3, 10000);
    expect(difficultyFraction(r)).toBe(1);
  });

  it('increases monotonically', () => {
    const xps = [0, 200, 600, 900, 1200, 1600, 2000, 3000, 5000];
    const fracs = xps.map(xp => difficultyFraction(calculateDifficulty(4, 3, xp)));
    for (let i = 1; i < fracs.length; i++) {
      expect(fracs[i]).toBeGreaterThanOrEqual(fracs[i - 1]);
    }
  });
});
