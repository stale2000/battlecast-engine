import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';

describe('Fighter L6 stat fixes', () => {
  it('Fighter L6 has STR 20 (two ASIs at L4 and L6)', () => {
    const fighter = buildHero('Fighter', 6);
    expect(fighter.abilities.str).toBe(20);
  });

  it('Fighter L5 has STR 19 (17 primary plus one ASI at L4)', () => {
    const fighter = buildHero('Fighter', 5);
    expect(fighter.abilities.str).toBe(19);
  });

  it('Fighter L3 has STR 17 (standard array plus background boost)', () => {
    const fighter = buildHero('Fighter', 3);
    expect(fighter.abilities.str).toBe(17);
  });

  it('Javelin uses STR for damage (not DEX)', () => {
    const fighter = buildHero('Fighter', 5);
    const javelin = fighter.actions.find(a => a.name === 'Javelin');
    expect(javelin).toBeDefined();
    // STR 19 = +4 mod, so damage should include +4
    expect(javelin!.damage).toContain('+4');
    expect(javelin!.attackBonus).toBe(3 + 4); // PB 3 + STR 4
  });

  it('Fighter L6 Javelin has +5 from STR 20', () => {
    const fighter = buildHero('Fighter', 6);
    const javelin = fighter.actions.find(a => a.name === 'Javelin');
    expect(javelin!.damage).toContain('+5');
    expect(javelin!.attackBonus).toBe(3 + 5); // PB 3 + STR 5
  });

  it('Fighter L5+ has Plate armor (AC 21 = 18 + 2 shield + 1 defense)', () => {
    const fighter = buildHero('Fighter', 5);
    expect(fighter.ac).toBe(21);
  });

  it('Fighter L4 still has Chain Mail (AC 19 = 16 + 2 shield + 1 defense)', () => {
    const fighter = buildHero('Fighter', 4);
    expect(fighter.ac).toBe(19);
  });
});
