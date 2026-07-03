/**
 * 2024 DMG encounter difficulty calculator.
 *
 * XP thresholds per character level (2024 rules, no group-size
 * multiplier). Multiply each threshold by party size to get the
 * encounter budget for that difficulty tier. Total monster XP falls
 * into the matching band.
 */

export type DifficultyTier = 'trivial' | 'low' | 'moderate' | 'high' | 'deadly';

export interface DifficultyResult {
  tier: DifficultyTier;
  label: string;
  totalMonsterXP: number;
  perPlayerXP: number;
  thresholds: {
    low: number;
    moderate: number;
    high: number;
    deadly: number;
  };
}

// Per-character XP thresholds from the 2024 DMG.
// Index = character level (1-based; index 0 unused).
const THRESHOLDS: Array<{ low: number; moderate: number; high: number; deadly: number }> = [
  { low: 0, moderate: 0, high: 0, deadly: 0 },       // index 0 (unused)
  { low: 50, moderate: 75, high: 100, deadly: 150 },  // L1
  { low: 100, moderate: 150, high: 200, deadly: 250 }, // L2
  { low: 150, moderate: 225, high: 400, deadly: 500 }, // L3
  { low: 250, moderate: 375, high: 500, deadly: 750 }, // L4
  { low: 500, moderate: 750, high: 1100, deadly: 1700 }, // L5
  { low: 600, moderate: 1000, high: 1400, deadly: 2000 }, // L6
  { low: 750, moderate: 1300, high: 1700, deadly: 2500 }, // L7
  { low: 1000, moderate: 1700, high: 2100, deadly: 3400 }, // L8
  { low: 1300, moderate: 2000, high: 2600, deadly: 4500 }, // L9
  { low: 1600, moderate: 2300, high: 3100, deadly: 5500 }, // L10
  { low: 1900, moderate: 2900, high: 3900, deadly: 6500 }, // L11
  { low: 2200, moderate: 3200, high: 4500, deadly: 7500 }, // L12
  { low: 2600, moderate: 3900, high: 5200, deadly: 9000 }, // L13
  { low: 2900, moderate: 4200, high: 5700, deadly: 10500 }, // L14
  { low: 3300, moderate: 5000, high: 6400, deadly: 12000 }, // L15
  { low: 3800, moderate: 5500, high: 7200, deadly: 13500 }, // L16
  { low: 4500, moderate: 6500, high: 8800, deadly: 15500 }, // L17
  { low: 5000, moderate: 7000, high: 9500, deadly: 17000 }, // L18
  { low: 5500, moderate: 8000, high: 10500, deadly: 19000 }, // L19
  { low: 6000, moderate: 8500, high: 11500, deadly: 21000 }, // L20
];

const TIER_LABELS: Record<DifficultyTier, string> = {
  trivial: 'Trivial',
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  deadly: 'Deadly',
};

function getPerCharThresholds(level: number): { low: number; moderate: number; high: number; deadly: number } {
  const clamped = Math.max(1, Math.min(level, THRESHOLDS.length - 1));
  return THRESHOLDS[clamped];
}

/**
 * Calculate encounter difficulty for a party.
 *
 * @param partySize - Number of player characters (1-10)
 * @param avgLevel  - Average character level (1-20)
 * @param totalMonsterXP - Sum of XP values of all monsters in the encounter
 */
export function calculateDifficulty(
  partySize: number,
  avgLevel: number,
  totalMonsterXP: number,
): DifficultyResult {
  const level = Math.max(1, Math.round(avgLevel));
  const size = Math.max(1, Math.round(partySize));
  const perChar = getPerCharThresholds(level);

  const thresholds = {
    low: perChar.low * size,
    moderate: perChar.moderate * size,
    high: perChar.high * size,
    deadly: perChar.deadly * size,
  };

  let tier: DifficultyTier;
  if (totalMonsterXP >= thresholds.deadly) tier = 'deadly';
  else if (totalMonsterXP >= thresholds.high) tier = 'high';
  else if (totalMonsterXP >= thresholds.moderate) tier = 'moderate';
  else if (totalMonsterXP >= thresholds.low) tier = 'low';
  else tier = 'trivial';

  return {
    tier,
    label: TIER_LABELS[tier],
    totalMonsterXP,
    perPlayerXP: size > 0 ? Math.round(totalMonsterXP / size) : 0,
    thresholds,
  };
}

/** Color for each difficulty tier (matches the app's design tokens). */
export function difficultyColor(tier: DifficultyTier): string {
  switch (tier) {
    case 'trivial': return 'var(--text-muted)';
    case 'low': return 'var(--success)';
    case 'moderate': return 'var(--gold)';
    case 'high': return 'var(--warning)';
    case 'deadly': return 'var(--danger)';
  }
}

/** Fraction 0-1 of how "full" the difficulty gauge is.
 *  0 = no XP, 0.25 = low threshold, 0.5 = moderate, 0.75 = high, 1.0 = deadly. */
export function difficultyFraction(result: DifficultyResult): number {
  const { totalMonsterXP: xp, thresholds: t } = result;
  if (xp <= 0 || t.deadly === 0) return 0;
  const bands: [number, number, number][] = [
    [0,          t.low,      0.25],
    [t.low,      t.moderate, 0.25],
    [t.moderate, t.high,     0.25],
    [t.high,     t.deadly,   0.25],
  ];
  let base = 0;
  for (const [lo, hi, span] of bands) {
    if (xp < hi) {
      const range = hi - lo || 1;
      return base + span * ((xp - lo) / range);
    }
    base += span;
  }
  return Math.min(1, base);
}
