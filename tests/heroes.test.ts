import { describe, it, expect } from 'vitest';
import {
  buildHero, allHeroBuilds, heroSummary, getHeroClassSpec,
  HERO_CLASS_NAMES, MIN_HERO_LEVEL, getMaxHeroLevelForClass,
} from '../src/data/heroes';

describe('buildHero - smoke tests across all classes × levels', () => {
  it('produces a valid MonsterData for every (class, level) pair', () => {
    const builds = allHeroBuilds();
    const expectedCount = HERO_CLASS_NAMES.reduce(
      (sum, cls) => sum + getMaxHeroLevelForClass(cls) - MIN_HERO_LEVEL + 1,
      0,
    );
    expect(builds).toHaveLength(expectedCount);
    for (const h of builds) {
      expect(h.name).toMatch(/L\d+$/);
      expect(h.isHero).toBe(true);
      expect(h.heroLevel).toBeGreaterThanOrEqual(1);
      expect(h.heroLevel).toBeLessThanOrEqual(getMaxHeroLevelForClass(h.heroClass as (typeof HERO_CLASS_NAMES)[number]));
      expect(h.hp).toBeGreaterThan(0);
      expect(h.ac).toBeGreaterThanOrEqual(10);
      expect(h.actions.length).toBeGreaterThan(0);
      expect(h.traits && h.traits.length).toBeGreaterThan(0);
    }
  });

  it('throws for unsupported class levels', () => {
    expect(() => buildHero('Fighter', 0)).toThrow();
    expect(() => buildHero('Fighter', 20)).not.toThrow();
    expect(() => buildHero('Fighter', 21)).toThrow();
    expect(() => buildHero('Monk', 20)).not.toThrow();
    expect(() => buildHero('Ranger', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 21)).toThrow();
    expect(() => buildHero('Barbarian', 20)).not.toThrow();
    expect(() => buildHero('Barbarian', 21)).toThrow();
  });

  it('caches built heroes so repeated calls return the same reference', () => {
    const a = buildHero('Wizard', 3);
    const b = buildHero('Wizard', 3);
    expect(a).toBe(b);
  });
});

describe('Fighter progression', () => {
  it('gains Extra Attack (multiattack) at L5', () => {
    const l4 = buildHero('Fighter', 4);
    const l5 = buildHero('Fighter', 5);
    expect(l4.actions.find(a => a.type === 'multiattack')).toBeUndefined();
    expect(l5.actions.find(a => a.type === 'multiattack')).toBeDefined();
  });

  it('has a Longsword attack with STR-based damage', () => {
    const l1 = buildHero('Fighter', 1);
    const sword = l1.actions.find(a => a.name === 'Longsword')!;
    expect(sword.type).toBe('melee');
    expect(sword.damage).toMatch(/^1d8\+\d+$/);
    expect(sword.damageType).toBe('slashing');
  });

  it('attack bonus scales with proficiency: +5 (L1, PB+2, STR+3) → +7 (L5, PB+3, STR+4)', () => {
    const l1 = buildHero('Fighter', 1);
    const l5 = buildHero('Fighter', 5);
    const atkL1 = l1.actions.find(a => a.name === 'Longsword')!.attackBonus!;
    const atkL5 = l5.actions.find(a => a.name === 'Longsword')!.attackBonus!;
    expect(atkL1).toBe(5);
    expect(atkL5).toBe(7);
  });

  it('HP scales: L1 d10 + CON(+2) = 12; L6 fighter = 12 + 5 × (6+2) = 52', () => {
    // SRD "take the average" rule: after L1, add (hitDie/2 + 1) + CON each level.
    expect(buildHero('Fighter', 1).hp).toBe(12);
    expect(buildHero('Fighter', 6).hp).toBe(52);
  });
});

describe('Rogue Sneak Attack', () => {
  it('Rapier has Sneak Attack additionalDamage that scales 1d6 → 2d6 → 3d6', () => {
    const s1 = buildHero('Rogue', 1).actions.find(a => a.name === 'Rapier')!;
    const s3 = buildHero('Rogue', 3).actions.find(a => a.name === 'Rapier')!;
    const s5 = buildHero('Rogue', 5).actions.find(a => a.name === 'Rapier')!;
    expect(s1.additionalDamage).toBe('1d6 piercing');
    expect(s3.additionalDamage).toBe('2d6 piercing');
    expect(s5.additionalDamage).toBe('3d6 piercing');
  });

  it('Shortbow (ranged finesse substitute) also gets Sneak Attack', () => {
    const bow = buildHero('Rogue', 5).actions.find(a => a.name === 'Shortbow')!;
    expect(bow.additionalDamage).toBe('3d6 piercing');
  });
});

describe('Caster cantrips', () => {
  it('Wizard Fire Bolt fires as a ranged spell attack', () => {
    const fb = buildHero('Wizard', 1).actions.find(a => a.name === 'Fire Bolt')!;
    expect(fb.type).toBe('ranged');
    expect(fb.damageType).toBe('fire');
    expect(fb.damage).toBe('1d10');
    expect(fb.range).toEqual({ normal: 120, long: 120 });
  });

  it('Fire Bolt scales to 2d10 at L5', () => {
    const fb = buildHero('Wizard', 5).actions.find(a => a.name === 'Fire Bolt')!;
    expect(fb.damage).toBe('2d10');
  });

  it('Cleric Sacred Flame is a DEX-save radiant cantrip', () => {
    const sf = buildHero('Cleric', 3).actions.find(a => a.name === 'Sacred Flame')!;
    expect(sf.type).toBe('special');
    expect(sf.savingThrow).toBeDefined();
    expect(sf.savingThrow!.ability).toBe('dex');
    expect(sf.savingThrow!.damageOnFail).toBe('1d8');
  });

  it('Warlock at L5 gets a multiattack for two Eldritch Blast beams', () => {
    const l4 = buildHero('Warlock', 4);
    const l5 = buildHero('Warlock', 5);
    expect(l4.actions.find(a => a.type === 'multiattack')).toBeUndefined();
    expect(l5.actions.find(a => a.type === 'multiattack')).toBeDefined();
    // Agonizing Blast adds CHA mod to damage
    const eb = l5.actions.find(a => a.name === 'Eldritch Blast')!;
    expect(eb.damage).toMatch(/\+\d+$/); // has an ability mod appended
  });
});

describe('Barbarian unarmored defense', () => {
  it('has high HP (d12) and unarmored AC = 10 + DEX + CON', () => {
    // primary STR 16, secondary DEX 14, CON 14 → AC 10 + 2 + 2 = 14
    expect(buildHero('Barbarian', 1).ac).toBe(14);
    expect(buildHero('Barbarian', 1).hp).toBe(14); // 12 + 2 CON
  });

  it('gains +10 speed at L5', () => {
    expect(buildHero('Barbarian', 4).speed.walk).toBe(30);
    expect(buildHero('Barbarian', 5).speed.walk).toBe(40);
  });
});

describe('Monk martial arts scaling', () => {
  it('unarmed die follows the 2024 Martial Arts table', () => {
    expect(buildHero('Monk', 1).actions[0].damage).toMatch(/^1d6/);
    const l5 = buildHero('Monk', 5);
    const l11 = buildHero('Monk', 11);
    const l17 = buildHero('Monk', 17);
    expect(l5.actions.find(a => a.name === 'Martial Arts (Unarmed)')!.damage).toMatch(/^1d8/);
    expect(l11.actions.find(a => a.name === 'Martial Arts (Unarmed)')!.damage).toMatch(/^1d10/);
    expect(l17.actions.find(a => a.name === 'Martial Arts (Unarmed)')!.damage).toMatch(/^1d12/);
  });

  it('gains scaling Unarmored Movement bonuses', () => {
    expect(buildHero('Monk', 1).speed.walk).toBe(30);
    expect(buildHero('Monk', 2).speed.walk).toBe(40);
    expect(buildHero('Monk', 6).speed.walk).toBe(45);
    expect(buildHero('Monk', 10).speed.walk).toBe(50);
    expect(buildHero('Monk', 14).speed.walk).toBe(55);
    expect(buildHero('Monk', 18).speed.walk).toBe(60);
  });
});

describe('Ranger Archery fighting style', () => {
  it('Longbow gets +2 attack bonus starting at L2', () => {
    const l1 = buildHero('Ranger', 1);
    const l2 = buildHero('Ranger', 2);
    // L1: no fighting style yet, L2: Archery +2
    const atk1 = l1.actions.find(a => a.name === 'Longbow')!.attackBonus!;
    const atk2 = l2.actions.find(a => a.name === 'Longbow')!.attackBonus!;
    expect(atk2 - atk1).toBe(2);
  });
});

describe('Heroes carry distinguishing metadata', () => {
  it('all builds have isHero / heroClass / heroLevel set', () => {
    const h = buildHero('Paladin', 4);
    expect(h.isHero).toBe(true);
    expect(h.heroClass).toBe('Paladin');
    expect(h.heroLevel).toBe(4);
    expect(h.type).toMatch(/Hero/);
  });

  it('CR is "-" so CR sorting puts them at the top or bottom', () => {
    expect(buildHero('Wizard', 1).cr).toBe('-');
  });
});

describe('heroSummary preview helper', () => {
  it('returns HP/AC/primary/weapon for the picker card', () => {
    const s = heroSummary('Fighter', 3);
    expect(s.name).toBe('Fighter L3');
    expect(s.primary).toBe('STR');
    expect(s.hp).toBeGreaterThan(0);
    expect(s.ac).toBe(19); // chain mail 16 + shield 2 + defense fighting style 1
    expect(s.weapon).toBeTruthy();
  });
});

describe('class spec exposure', () => {
  it('every class returns a spec with skills, hit die, primary ability', () => {
    for (const cls of HERO_CLASS_NAMES) {
      const spec = getHeroClassSpec(cls);
      expect(spec.hitDie).toBeGreaterThanOrEqual(6);
      expect(spec.skills.length).toBeGreaterThan(0);
    }
  });
});
