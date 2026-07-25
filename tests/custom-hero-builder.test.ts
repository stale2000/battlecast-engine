import { describe, it, expect } from 'vitest';
import { buildHero, buildCustomHero, getAvailableSpells, HERO_CLASS_NAMES } from '../src/data/heroes';

describe('buildCustomHero', () => {
  it('keeps default cantrips deterministic while exposing the full supported pool for selection', () => {
    for (const cls of HERO_CLASS_NAMES) {
      const available = getAvailableSpells(cls, 5).filter(spell => spell.spellLevel === 0);
      const defaults = buildHero(cls, 5).actions.filter(action => action.spellLevel === 0);
      expect(defaults.length).toBe(available.length ? 1 : 0);
      for (const action of defaults) expect(available.some(spell => spell.name === action.name)).toBe(true);
    }
  });

  it('produces identical output to buildHero when no overrides given', () => {
    for (const cls of HERO_CLASS_NAMES) {
      const base = buildHero(cls, 5);
      const custom = buildCustomHero(cls, 5, {});
      expect(custom.hp).toBe(base.hp);
      expect(custom.ac).toBe(base.ac);
      expect(custom.abilities).toEqual(base.abilities);
      expect(custom.actions.length).toBe(base.actions.length);
    }
  });

  it('applies custom ability scores and recalculates HP', () => {
    const base = buildHero('Fighter', 5);
    const custom = buildCustomHero('Fighter', 5, {
      abilities: { str: 20, dex: 14, con: 16, int: 10, wis: 10, cha: 8 },
    });
    // CON 16 (+3) vs default CON 14 (+2) → more HP
    expect(custom.hp).toBeGreaterThan(base.hp);
    expect(custom.abilities.str).toBe(20);
    expect(custom.abilities.con).toBe(16);
  });

  it('applies HP override', () => {
    const custom = buildCustomHero('Wizard', 5, { hpOverride: 100 });
    expect(custom.hp).toBe(100);
  });

  it('applies AC override', () => {
    const custom = buildCustomHero('Fighter', 5, { acOverride: 25 });
    expect(custom.ac).toBe(25);
  });

  it('applies display name', () => {
    const custom = buildCustomHero('Rogue', 3, { displayName: 'Shadow the Quick' });
    expect(custom.name).toBe('Shadow the Quick');
  });

  it('applies weapon override', () => {
    const custom = buildCustomHero('Fighter', 5, {
      weapon: { name: 'Frostbrand', die: '2d6', damageType: 'cold', type: 'melee' },
    });
    const frostbrand = custom.actions.find(a => a.name === 'Frostbrand');
    expect(frostbrand).toBeDefined();
    expect(frostbrand!.damageType).toBe('cold');
    expect(frostbrand!.damage).toContain('2d6');
    // Should not have the default weapon
    const longsword = custom.actions.find(a => a.name === 'Longsword');
    expect(longsword).toBeUndefined();
  });

  it('applies spell selection filter', () => {
    const base = buildHero('Wizard', 5);
    const baseSpells = base.actions.filter(a => (a.spellLevel ?? 0) > 0);
    expect(baseSpells.length).toBeGreaterThan(2);

    const custom = buildCustomHero('Wizard', 5, {
      spells: ['Fireball', 'Magic Missile'],
    });
    const customSpells = custom.actions.filter(a => (a.spellLevel ?? 0) > 0);
    expect(customSpells.length).toBe(2);
    expect(customSpells.map(s => s.name).sort()).toEqual(['Fireball', 'Magic Missile']);
  });

  it('respects explicit cantrip selection when imported/manual spells include cantrips', () => {
    const custom = buildCustomHero('Wizard', 5, {
      spells: ['Magic Missile'],
      spellSelectionIncludesCantrips: true,
    });

    expect(custom.actions.some(a => a.name === 'Magic Missile')).toBe(true);
    expect(custom.actions.some(a => a.name === 'Fire Bolt')).toBe(false);
  });

  it('replaces the default cantrip with a selected supported class cantrip', () => {
    const wizard = buildCustomHero('Wizard', 5, { cantrips: ['Ray of Frost'] });
    const ray = wizard.actions.find(action => action.name === 'Ray of Frost');
    expect(ray).toMatchObject({ damage: '2d8', buffOnHit: { speedPenalty: 10 } });
    expect(wizard.actions.some(action => action.name === 'Fire Bolt')).toBe(false);
  });

  it('custom abilities cascade to attack bonus', () => {
    const weak = buildCustomHero('Fighter', 5, {
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    });
    const strong = buildCustomHero('Fighter', 5, {
      abilities: { str: 20, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    });
    const weakAtk = weak.actions.find(a => a.name === 'Longsword');
    const strongAtk = strong.actions.find(a => a.name === 'Longsword');
    expect(strongAtk!.attackBonus!).toBeGreaterThan(weakAtk!.attackBonus!);
  });

  it('custom abilities cascade to save DCs for casters', () => {
    const lowInt = buildCustomHero('Wizard', 5, {
      abilities: { str: 10, dex: 14, con: 14, int: 14, wis: 10, cha: 8 },
    });
    const highInt = buildCustomHero('Wizard', 5, {
      abilities: { str: 10, dex: 14, con: 14, int: 20, wis: 10, cha: 8 },
    });
    const lowFireball = lowInt.actions.find(a => a.name === 'Fireball');
    const highFireball = highInt.actions.find(a => a.name === 'Fireball');
    expect(highFireball!.savingThrow!.dc).toBeGreaterThan(lowFireball!.savingThrow!.dc);
  });

  it('maintains class features and resources with custom stats', () => {
    const custom = buildCustomHero('Barbarian', 5, {
      abilities: { str: 20, dex: 14, con: 16, int: 8, wis: 10, cha: 8 },
    });
    const rage = custom.actions.find(a => a.name === 'Rage');
    expect(rage).toBeDefined();
    expect(custom.initialResources?.['rage']).toBeGreaterThan(0);
  });

  it('ranged weapon override works correctly', () => {
    const custom = buildCustomHero('Ranger', 5, {
      weapon: { name: 'Crossbow +1', die: '1d10', damageType: 'piercing', type: 'ranged', range: { normal: 100, long: 400 } },
    });
    const crossbow = custom.actions.find(a => a.name === 'Crossbow +1');
    expect(crossbow).toBeDefined();
    expect(crossbow!.type).toBe('ranged');
    expect(crossbow!.range?.normal).toBe(100);
    expect(crossbow!.loading).toBe(true);
  });

  it('applies multiple weapon overrides with imported hit and damage bonuses', () => {
    const custom = buildCustomHero('Paladin', 5, {
      weapons: [
        { name: 'Longsword', die: '1d8', damageOverride: '1d8+5', attackBonusOverride: 8, damageType: 'slashing', type: 'melee' },
        { name: 'Javelin', die: '1d6', damageOverride: '1d6+4', attackBonusOverride: 7, damageType: 'piercing', type: 'ranged', range: { normal: 30, long: 120 } },
      ],
    });

    const longsword = custom.actions.find(a => a.name === 'Longsword');
    const javelin = custom.actions.find(a => a.name === 'Javelin');
    expect(longsword).toMatchObject({ attackBonus: 8, damage: '1d8+5', damageType: 'slashing', type: 'melee' });
    expect(longsword?.smiteOnHit).toBeDefined();
    expect(javelin).toMatchObject({ attackBonus: 7, damage: '1d6+4', damageType: 'piercing', type: 'ranged', range: { normal: 30, long: 120 } });
    expect(javelin?.smiteOnHit).toBeUndefined();
  });

  it('can build a Paladin from imported level 2 spell selections', () => {
    const custom = buildCustomHero('Paladin', 5, {
      spells: ['Aid', 'Magic Weapon', 'Shining Smite'],
    });

    const spells = custom.actions.filter(a => (a.spellLevel ?? 0) > 0);
    expect(spells.map(s => s.name).sort()).toEqual(['Aid', 'Magic Weapon', 'Shining Smite']);
    expect(spells.find(s => s.name === 'Aid')?.buff?.maxHpBonus).toBe(5);
    expect(spells.find(s => s.name === 'Magic Weapon')?.buff?.attackBonusDice).toBe('1');
    expect(spells.find(s => s.name === 'Shining Smite')?.buff?.damageRider).toBe('2d6 radiant');
  });
});

describe('getAvailableSpells', () => {
  it('returns spells for caster classes', () => {
    const wizardSpells = getAvailableSpells('Wizard', 5);
    expect(wizardSpells.length).toBeGreaterThan(3);
    expect(wizardSpells.some(s => s.name === 'Fireball')).toBe(true);
    expect(wizardSpells.some(s => s.name === 'Magic Missile')).toBe(true);
  });

  it('lists supported combat cantrips only for their SRD classes', () => {
    for (const cls of ['Sorcerer', 'Wizard'] as const) {
      const names = getAvailableSpells(cls, 5).map(spell => spell.name);
      expect(names).toEqual(expect.arrayContaining(['Blade Ward', 'Ray of Frost', 'Chill Touch', 'Shocking Grasp']));
    }
    const warlock = getAvailableSpells('Warlock', 5).map(spell => spell.name);
    expect(warlock).toContain('Chill Touch');
    expect(warlock).toContain('Blade Ward');
    expect(warlock).not.toContain('Ray of Frost');
    expect(getAvailableSpells('Cleric', 5).map(spell => spell.name)).toContain('Toll the Dead');
    expect(getAvailableSpells('Cleric', 5).map(spell => spell.name)).toContain('Resistance');
    expect(getAvailableSpells('Druid', 5).map(spell => spell.name)).toContain('Resistance');
    expect(getAvailableSpells('Wizard', 5).map(spell => spell.name)).toContain('Ice Knife');
  });

  it('keeps optional level-five spell lists aligned with the 2024 SRD classes', () => {
    const names = (cls: Parameters<typeof getAvailableSpells>[0]) => new Set(getAvailableSpells(cls, 5).map(spell => spell.name));
    for (const spell of ['Fog Cloud', 'Barkskin', 'Gust of Wind', 'Lesser Restoration']) expect(names('Ranger')).toContain(spell);
    expect(names('Ranger')).not.toContain('Faerie Fire');
    for (const spell of ['Protection from Poison', 'Flaming Sphere']) expect(names('Druid')).toContain(spell);
    for (const spell of ['Fear', 'Fly']) expect(names('Druid')).not.toContain(spell);
    expect(names('Paladin')).not.toContain('Hold Person');
    for (const spell of ['Web']) expect(names('Sorcerer')).toContain(spell);
    for (const spell of ["Tasha's Hideous Laughter", 'Cloud of Daggers', 'Acid Arrow']) expect(names('Sorcerer')).not.toContain(spell);
    for (const spell of ['Counterspell', 'Cloud of Daggers']) expect(names('Warlock')).toContain(spell);
    for (const spell of ['Branding Smite', 'Searing Smite', 'Thunderous Smite', 'Wrathful Smite']) expect(names('Paladin')).toContain(spell);
    expect(names('Ranger')).toContain('Ensnaring Strike');
    expect(names('Druid')).toContain('Wind Wall');
    expect(names('Warlock')).toContain('Hunger of Hadar');
    expect(names('Cleric')).toContain('Protection from Energy');
    expect(names('Sorcerer')).toContain('Flame Blade');
    expect(names('Bard')).toContain('Plant Growth');
    expect(names('Bard')).toContain('See Invisibility');
    for (const spell of ['Bane', 'Invisibility', 'Misty Step', 'Vampiric Touch']) expect(names('Warlock')).toContain(spell);
    expect(names('Sorcerer')).toContain('Sleet Storm');
    expect(names('Wizard')).toContain('Sleet Storm');
    expect(getAvailableSpells('Ranger', 9).map(spell => spell.name)).toContain('Conjure Animals');
    expect(getAvailableSpells('Ranger', 9).map(spell => spell.name)).toContain('Plant Growth');
  });

  it('returns empty for martial classes', () => {
    expect(getAvailableSpells('Barbarian', 5)).toEqual([]);
    expect(getAvailableSpells('Rogue', 5)).toEqual([]);
    expect(getAvailableSpells('Monk', 5)).toEqual([]);
    expect(getAvailableSpells('Fighter', 5)).toEqual([]);
  });

  it('respects level-gated spell availability', () => {
    const l1 = getAvailableSpells('Wizard', 1);
    const l5 = getAvailableSpells('Wizard', 5);
    const l9 = getAvailableSpells('Wizard', 9);
    expect(l5.length).toBeGreaterThan(l1.length);
    expect(l9.length).toBeGreaterThan(l5.length);
  });

  it('includes spell level for each spell', () => {
    const spells = getAvailableSpells('Cleric', 9);
    for (const s of spells) {
      expect(s.spellLevel).toBeGreaterThanOrEqual(0);
      expect(s.spellLevel).toBeLessThanOrEqual(5);
    }
    expect(spells).toEqual(expect.arrayContaining([{ spellLevel: 0, name: 'Sacred Flame' }]));
  });

  it('returns spells for half-casters at appropriate levels', () => {
    const l1 = getAvailableSpells('Paladin', 1);
    expect(l1.length).toBeGreaterThan(0);
    expect(l1.some(s => s.name === 'Bless')).toBe(true);
    expect(l1.some(s => s.spellLevel === 2)).toBe(false);

    const l5 = getAvailableSpells('Paladin', 5);
    expect(l5).toEqual(expect.arrayContaining([
      { spellLevel: 2, name: 'Aid' },
      { spellLevel: 2, name: 'Magic Weapon' },
      { spellLevel: 2, name: 'Shining Smite' },
    ]));
  });

  it('all 8 caster classes return spells at L5', () => {
    const casters: Array<'Wizard'|'Sorcerer'|'Cleric'|'Druid'|'Bard'|'Warlock'|'Paladin'|'Ranger'> =
      ['Wizard', 'Sorcerer', 'Cleric', 'Druid', 'Bard', 'Warlock', 'Paladin', 'Ranger'];
    for (const cls of casters) {
      const spells = getAvailableSpells(cls, 5);
      expect(spells.length).toBeGreaterThan(0);
    }
  });
});
