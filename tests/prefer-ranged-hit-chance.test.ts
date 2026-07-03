import { describe, it, expect } from 'vitest';
import { expectedHitDamage, shouldPreferRanged } from '../src/engine/ai-targeting';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';
import { monsters } from '../src/data/monsters';
import type { MonsterAction } from '../src/types/monster';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

const greatsword: MonsterAction = {
  name: 'Greatsword', type: 'melee', attackBonus: 5,
  damage: '2d6+3', damageType: 'slashing',
  additionalDamage: '1d8 radiant',
  reach: 5, description: 'Melee.',
};
const heavyCrossbow: MonsterAction = {
  name: 'Heavy Crossbow', type: 'ranged', attackBonus: 2,
  damage: '2d10', damageType: 'piercing',
  additionalDamage: '1d8 radiant',
  range: { normal: 100, long: 400 },
  description: 'Ranged.',
};
const longsword: MonsterAction = {
  name: 'Longsword', type: 'melee', attackBonus: 4,
  damage: '1d8+2', damageType: 'slashing',
  reach: 5, description: 'Melee.',
};
const shortbow: MonsterAction = {
  name: 'Shortbow', type: 'ranged', attackBonus: 4,
  damage: '1d6+2', damageType: 'piercing',
  range: { normal: 80, long: 320 },
  description: 'Ranged.',
};

describe('expectedHitDamage', () => {
  it('combines base + additionalDamage + hit-rate', () => {
    // Greatsword: 2d6+3 (avg 10) + 1d8 (avg 4.5) = 14.5 raw
    // +5 vs AC 14: hits on 9+ on d20 = 12/20 = 0.6
    // Expected: 14.5 * 0.6 = 8.7
    const ev = expectedHitDamage(greatsword, 14);
    expect(ev).toBeCloseTo(8.7, 1);
  });

  it('is lower for low-to-hit ranged with same dice', () => {
    // Heavy Crossbow: 2d10 (avg 11) + 1d8 (avg 4.5) = 15.5 raw
    // +2 vs AC 14: hits on 12+ = 9/20 = 0.45
    // Expected: 15.5 * 0.45 = ~6.97
    const ev = expectedHitDamage(heavyCrossbow, 14);
    expect(ev).toBeCloseTo(6.975, 1);
  });

  it('clamps hit-rate at 5% (nat-1 always misses) and 95% (nat-20 always hits)', () => {
    // Massive +20 to-hit vs AC 1: would hit on 0+ but capped at 95%.
    const obvious: MonsterAction = { ...greatsword, attackBonus: 20 };
    const obviousEv = expectedHitDamage(obvious, 1);
    expect(obviousEv).toBeCloseTo(14.5 * 0.95, 1);
    // Hopelessly outclassed: +0 vs AC 30. Floor 5%.
    const hopeless: MonsterAction = { ...greatsword, attackBonus: 0 };
    const hopelessEv = expectedHitDamage(hopeless, 30);
    expect(hopelessEv).toBeCloseTo(14.5 * 0.05, 1);
  });

  it('handles missing fields gracefully', () => {
    const bare: MonsterAction = {
      name: 'Bare', type: 'melee', attackBonus: 0,
      damage: '1d6', damageType: 'b', reach: 5, description: '',
    };
    const ev = expectedHitDamage(bare, 14);
    // 1d6 = 3.5 avg; +0 to hit vs AC 14 = 7/20 = 0.35; 3.5 * 0.35 = 1.225
    expect(ev).toBeCloseTo(1.225, 1);
  });
});

describe('shouldPreferRanged with hit-chance correction', () => {
  it('Knight (Greatsword +5 vs Heavy Crossbow +2) prefers MELEE', () => {
    // Pre-fix bug: returned true because raw 2d10 (11) > 2d6+3 (10).
    // After fix: melee EV (8.7) > ranged EV (6.97) so returns false.
    expect(shouldPreferRanged([greatsword], [heavyCrossbow])).toBe(false);
  });

  it('matched-hit-bonus weapons (both +4): higher raw damage wins', () => {
    // Longsword: 1d8+2 = 6.5 avg, +4 → vs AC 14 hits on 10+ = 0.55, EV ~3.58
    // Shortbow: 1d6+2 = 5.5 avg, +4 → same hit rate 0.55, EV ~3.03
    // Melee wins on raw, so shouldPreferRanged returns false.
    expect(shouldPreferRanged([longsword], [shortbow])).toBe(false);
  });

  it('genuinely ranged-preferring archer (no melee penalty)', () => {
    // Pure-ranged creature (e.g. archer with no melee weapon): always ranged.
    expect(shouldPreferRanged([], [shortbow])).toBe(true);
  });

  it('Barbarian still forced to melee regardless of weapons', () => {
    expect(shouldPreferRanged([greatsword], [shortbow], 'Barbarian')).toBe(false);
  });

  it('Rogue still prefers ranged (sneak attack from bow)', () => {
    expect(shouldPreferRanged([longsword], [shortbow], 'Rogue')).toBe(true);
  });

  it('handles no ranged actions', () => {
    expect(shouldPreferRanged([greatsword], [])).toBe(false);
  });
});

describe('Knight closes to melee in practice (integration)', () => {
  it('Knight at 30ft from a Commoner ends in melee reach (not standing back firing)', () => {
    const knight = md('Knight');
    const commoner = md('Commoner');
    let melees = 0;
    let crossbows = 0;
    for (let trial = 0; trial < 10; trial++) {
      const creatures = [
        createCreatureWithFixedHp(knight, 'red', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      melees += state.logs.filter(l =>
        l.actor?.includes('Knight') && l.action === 'Greatsword' && (l.damage ?? 0) > 0
      ).length;
      crossbows += state.logs.filter(l =>
        l.actor?.includes('Knight') && l.action === 'Heavy Crossbow' && (l.damage ?? 0) > 0
      ).length;
    }
    // After the fix, Knight should mostly use Greatsword (higher EV in melee).
    // A few crossbow hits possible if turn ends with Commoner out of reach.
    expect(melees).toBeGreaterThan(crossbows);
  });
});
