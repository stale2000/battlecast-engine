import { describe, it, expect } from 'vitest';
import { buildHero, HERO_CLASS_NAMES, type HeroClassName } from '../src/data/heroes';

describe('Phase 1: L7-10 foundation', () => {
  it('all classes build without error at L7-10', () => {
    for (const cls of HERO_CLASS_NAMES) {
      for (let level = 7; level <= 10; level++) {
        expect(() => buildHero(cls, level), `${cls} L${level} should build`).not.toThrow();
      }
    }
  });

  it('HP increases at every level for all classes', () => {
    for (const cls of HERO_CLASS_NAMES) {
      let prevHP = 0;
      for (let level = 1; level <= 10; level++) {
        const hero = buildHero(cls, level);
        expect(hero.hp, `${cls} L${level} HP should increase`).toBeGreaterThan(prevHP);
        prevHP = hero.hp;
      }
    }
  });

  it('AC never decreases from L1 to L10', () => {
    for (const cls of HERO_CLASS_NAMES) {
      let prevAC = 0;
      for (let level = 1; level <= 10; level++) {
        const hero = buildHero(cls, level);
        expect(hero.ac, `${cls} L${level} AC should not decrease`).toBeGreaterThanOrEqual(prevAC);
        prevAC = hero.ac;
      }
    }
  });

  it('L8 ASI gives primary ability 20 for non-Fighter classes', () => {
    const nonFighter = HERO_CLASS_NAMES.filter(c => c !== 'Fighter');
    for (const cls of nonFighter) {
      const hero = buildHero(cls, 8);
      const spec = { Barbarian: 'str', Bard: 'cha', Cleric: 'wis', Druid: 'wis', Monk: 'dex', Paladin: 'str', Ranger: 'dex', Rogue: 'dex', Sorcerer: 'cha', Warlock: 'cha', Wizard: 'int' } as Record<string, string>;
      const primary = spec[cls] as keyof typeof hero.abilities;
      expect(hero.abilities[primary], `${cls} L8 primary should be 20`).toBe(20);
    }
  });

  it('Fighter already has primary 20 at L6, stays 20 at L8-10', () => {
    for (let level = 6; level <= 10; level++) {
      expect(buildHero('Fighter', level).abilities.str).toBe(20);
    }
  });

  it('proficiency bonus is +3 at L7-8, +4 at L9-10', () => {
    for (const cls of HERO_CLASS_NAMES) {
      expect(buildHero(cls, 7).proficiencyBonus).toBe(3);
      expect(buildHero(cls, 8).proficiencyBonus).toBe(3);
      expect(buildHero(cls, 9).proficiencyBonus).toBe(4);
      expect(buildHero(cls, 10).proficiencyBonus).toBe(4);
    }
  });
});

describe('Phase 1: Spell slot progression L7-10', () => {
  it('full casters get L4 slots at L7', () => {
    for (const cls of ['Wizard', 'Sorcerer', 'Cleric', 'Druid', 'Bard'] as HeroClassName[]) {
      const hero = buildHero(cls, 7);
      expect(hero.initialResources?.['slot-4'], `${cls} L7 should have L4 slots`).toBeGreaterThan(0);
    }
  });

  it('full casters get L5 slots at L9', () => {
    for (const cls of ['Wizard', 'Sorcerer', 'Cleric', 'Druid', 'Bard'] as HeroClassName[]) {
      const hero = buildHero(cls, 9);
      expect(hero.initialResources?.['slot-5'], `${cls} L9 should have L5 slots`).toBeGreaterThan(0);
    }
  });

  it('full caster slot counts are correct at L10', () => {
    const hero = buildHero('Wizard', 10);
    expect(hero.initialResources?.['slot-1']).toBe(4);
    expect(hero.initialResources?.['slot-2']).toBe(3);
    expect(hero.initialResources?.['slot-3']).toBe(3);
    expect(hero.initialResources?.['slot-4']).toBe(3);
    expect(hero.initialResources?.['slot-5']).toBe(2);
  });

  it('half casters get L3 slots at L9', () => {
    for (const cls of ['Paladin', 'Ranger'] as HeroClassName[]) {
      const hero = buildHero(cls, 9);
      expect(hero.initialResources?.['slot-3'], `${cls} L9 should have L3 slots`).toBeGreaterThan(0);
    }
  });

  it('half caster slot counts are correct at L10', () => {
    const hero = buildHero('Paladin', 10);
    expect(hero.initialResources?.['slot-1']).toBe(4);
    expect(hero.initialResources?.['slot-2']).toBe(3);
    expect(hero.initialResources?.['slot-3']).toBe(2);
  });

  it('warlock pact slots are correct at L7-10', () => {
    expect(buildHero('Warlock', 7).initialResources?.['slot-4']).toBe(2);
    expect(buildHero('Warlock', 9).initialResources?.['slot-5']).toBe(2);
    expect(buildHero('Warlock', 10).initialResources?.['slot-5']).toBe(2);
  });
});

describe('Phase 1: Resource scaling L7-10', () => {
  it('Monk Ki equals level', () => {
    for (let level = 7; level <= 10; level++) {
      expect(buildHero('Monk', level).initialResources?.['ki']).toBe(level);
    }
  });

  it('Barbarian rage uses scale correctly', () => {
    expect(buildHero('Barbarian', 7).initialResources?.['rage']).toBeGreaterThanOrEqual(4);
  });

  it('Sorcerer sorcery points equal level', () => {
    for (let level = 7; level <= 10; level++) {
      const hero = buildHero('Sorcerer', level);
      expect(hero.initialResources?.['sorcery']).toBe(level);
    }
  });

  it('all classes have traits/features at L7+', () => {
    for (const cls of HERO_CLASS_NAMES) {
      const hero = buildHero(cls, 10);
      expect(hero.traits!.length, `${cls} L10 should have traits`).toBeGreaterThan(0);
      // Should have features from L7+ levels
      const highLevelTraits = hero.traits!.filter(t => t.name.match(/^L[7-9]|^L10/));
      expect(highLevelTraits.length, `${cls} L10 should have L7+ features`).toBeGreaterThan(0);
    }
  });
});
