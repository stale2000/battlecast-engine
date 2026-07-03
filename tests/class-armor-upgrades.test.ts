import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';

describe('Cleric armor upgrade at L5+', () => {
  it('Cleric L4 has Chain Mail AC (16 + 2 shield = 18)', () => {
    expect(buildHero('Cleric', 4).ac).toBe(18);
  });
  it('Cleric L5 upgrades to Plate AC (18 + 2 shield = 20)', () => {
    expect(buildHero('Cleric', 5).ac).toBe(20);
  });
});

describe('Ranger armor at L5+', () => {
  it('Ranger L4 has Scale Mail AC (14 + 2 DEX cap = 16)', () => {
    expect(buildHero('Ranger', 4).ac).toBe(16);
  });
  it('Ranger L5 upgrades to Studded Leather AC (12 + 4 DEX = 16)', () => {
    // Same AC but allows full DEX; verify it stays 16
    expect(buildHero('Ranger', 5).ac).toBe(16);
  });
});

describe('Monk AC bonus at L5+', () => {
  it('Monk L4 has unarmored AC (10 + 4 DEX + 2 WIS = 16)', () => {
    expect(buildHero('Monk', 4).ac).toBe(16);
  });
  it('Monk L5 gets +1 AC from training (17)', () => {
    expect(buildHero('Monk', 5).ac).toBe(17);
  });
});
