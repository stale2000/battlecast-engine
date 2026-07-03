import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';

describe('Fighter uses javelins, not longbow', () => {
  it('Fighter secondary weapon is Javelin', () => {
    const fighter = buildHero('Fighter', 3);
    const javelin = fighter.actions.find(a => a.name === 'Javelin');
    expect(javelin).toBeDefined();
    expect(javelin!.damageType).toBe('piercing');
    expect(javelin!.range?.normal).toBe(30);
  });

  it('Fighter does not have a Longbow', () => {
    const fighter = buildHero('Fighter', 3);
    const longbow = fighter.actions.find(a => a.name === 'Longbow');
    expect(longbow).toBeUndefined();
  });

  it('Javelin uses STR (no dex override)', () => {
    const fighter = buildHero('Fighter', 3);
    const javelin = fighter.actions.find(a => a.name === 'Javelin');
    expect(javelin).toBeDefined();
    // No abilityOverride means it uses the primary stat (STR for Fighter)
    expect((javelin as any).castingAbility).toBeUndefined();
  });
});
