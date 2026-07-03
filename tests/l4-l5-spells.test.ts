import { describe, it, expect } from 'vitest';
import { buildHero, type HeroClassName } from '../src/data/heroes';

describe('L4 spells available at L7+', () => {
  it('Wizard L7 has Ice Storm', () => {
    const wiz = buildHero('Wizard', 7);
    expect(wiz.actions.some(a => a.name === 'Ice Storm')).toBe(true);
  });

  it('Wizard L6 does NOT have Ice Storm', () => {
    const wiz = buildHero('Wizard', 6);
    expect(wiz.actions.some(a => a.name === 'Ice Storm')).toBe(false);
  });

  it('Wizard L7 has Banishment', () => {
    expect(buildHero('Wizard', 7).actions.some(a => a.name === 'Banishment')).toBe(true);
  });

  it('Sorcerer L7 has Blight', () => {
    expect(buildHero('Sorcerer', 7).actions.some(a => a.name === 'Blight')).toBe(true);
  });

  it('Cleric L7 has Death Ward', () => {
    expect(buildHero('Cleric', 7).actions.some(a => a.name === 'Death Ward')).toBe(true);
  });

  it('Cleric L7 has Banishment', () => {
    expect(buildHero('Cleric', 7).actions.some(a => a.name === 'Banishment')).toBe(true);
  });

  it('Druid L7 has Ice Storm', () => {
    expect(buildHero('Druid', 7).actions.some(a => a.name === 'Ice Storm')).toBe(true);
  });

  it('Bard L7 has Banishment', () => {
    expect(buildHero('Bard', 7).actions.some(a => a.name === 'Banishment')).toBe(true);
  });

  it('Warlock L7 has Banishment and Blight', () => {
    const w = buildHero('Warlock', 7);
    expect(w.actions.some(a => a.name === 'Banishment')).toBe(true);
    expect(w.actions.some(a => a.name === 'Blight')).toBe(true);
  });
});

describe('L5 spells available at L9+', () => {
  it('Wizard L9 has Cone of Cold', () => {
    expect(buildHero('Wizard', 9).actions.some(a => a.name === 'Cone of Cold')).toBe(true);
  });

  it('Wizard L8 does NOT have Cone of Cold', () => {
    expect(buildHero('Wizard', 8).actions.some(a => a.name === 'Cone of Cold')).toBe(false);
  });

  it('Wizard L9 has Hold Monster', () => {
    expect(buildHero('Wizard', 9).actions.some(a => a.name === 'Hold Monster')).toBe(true);
  });

  it('Wizard L9 has Synaptic Static', () => {
    expect(buildHero('Wizard', 9).actions.some(a => a.name === 'Synaptic Static')).toBe(true);
  });

  it('Cleric L9 has Flame Strike', () => {
    expect(buildHero('Cleric', 9).actions.some(a => a.name === 'Flame Strike')).toBe(true);
  });

  it('Cleric L9 has Mass Cure Wounds', () => {
    expect(buildHero('Cleric', 9).actions.some(a => a.name === 'Mass Cure Wounds')).toBe(true);
  });

  it('Druid L9 has Cone of Cold', () => {
    expect(buildHero('Druid', 9).actions.some(a => a.name === 'Cone of Cold')).toBe(true);
  });

  it('Sorcerer L9 has Synaptic Static', () => {
    expect(buildHero('Sorcerer', 9).actions.some(a => a.name === 'Synaptic Static')).toBe(true);
  });

  it('Bard L9 has Hold Monster and Mass Cure Wounds', () => {
    const b = buildHero('Bard', 9);
    expect(b.actions.some(a => a.name === 'Hold Monster')).toBe(true);
    expect(b.actions.some(a => a.name === 'Mass Cure Wounds')).toBe(true);
  });

  it('Warlock L9 has Hold Monster', () => {
    expect(buildHero('Warlock', 9).actions.some(a => a.name === 'Hold Monster')).toBe(true);
  });
});

describe('Spell data integrity for L4-L5', () => {
  it('all L4 spells have correct spellLevel', () => {
    const wiz = buildHero('Wizard', 8);
    const l4Spells = wiz.actions.filter(a => a.spellLevel === 4);
    expect(l4Spells.length).toBeGreaterThanOrEqual(3);
    for (const s of l4Spells) {
      expect(s.spellLevel).toBe(4);
    }
  });

  it('all L5 spells have correct spellLevel', () => {
    const wiz = buildHero('Wizard', 10);
    const l5Spells = wiz.actions.filter(a => a.spellLevel === 5);
    expect(l5Spells.length).toBeGreaterThanOrEqual(3);
    for (const s of l5Spells) {
      expect(s.spellLevel).toBe(5);
    }
  });

  it('AoE spells have damageType set', () => {
    const wiz = buildHero('Wizard', 10);
    for (const a of wiz.actions) {
      if (a.savingThrow?.damageOnFail && a.savingThrow?.area) {
        expect(a.damageType, `${a.name} should have damageType`).toBeDefined();
      }
    }
  });

  it('Cone of Cold is a 60-foot Cone', () => {
    const wiz = buildHero('Wizard', 9);
    const coc = wiz.actions.find(a => a.name === 'Cone of Cold');
    expect(coc!.savingThrow?.area).toContain('Cone');
  });

  it('Hold Monster has no targetTypeRestriction (works on any creature)', () => {
    const wiz = buildHero('Wizard', 9);
    const hm = wiz.actions.find(a => a.name === 'Hold Monster');
    expect(hm!.targetTypeRestriction).toBeUndefined();
  });

  it('Banishment is concentration', () => {
    const wiz = buildHero('Wizard', 7);
    const b = wiz.actions.find(a => a.name === 'Banishment');
    expect(b!.concentration).toBe(true);
  });

  it('Synaptic Static is NOT concentration', () => {
    const wiz = buildHero('Wizard', 9);
    const ss = wiz.actions.find(a => a.name === 'Synaptic Static');
    expect(ss!.concentration).toBeFalsy();
  });

  it('Paladin L9 has Blinding Smite (L3)', () => {
    expect(buildHero('Paladin', 9).actions.some(a => a.name === 'Blinding Smite')).toBe(true);
  });

  it('Paladin L8 does NOT have Blinding Smite', () => {
    expect(buildHero('Paladin', 8).actions.some(a => a.name === 'Blinding Smite')).toBe(false);
  });

  it('Ranger L9 has Conjure Barrage', () => {
    expect(buildHero('Ranger', 9).actions.some(a => a.name === 'Conjure Barrage')).toBe(true);
  });

  it('Ranger L9 has Protection from Energy', () => {
    expect(buildHero('Ranger', 9).actions.some(a => a.name === 'Protection from Energy')).toBe(true);
  });

  it('Ranger L8 does NOT have Conjure Barrage', () => {
    expect(buildHero('Ranger', 8).actions.some(a => a.name === 'Conjure Barrage')).toBe(false);
  });

  it('Conjure Barrage is a 60-foot Cone', () => {
    const r = buildHero('Ranger', 9);
    const cb = r.actions.find(a => a.name === 'Conjure Barrage');
    expect(cb!.savingThrow?.area).toContain('Cone');
  });

  it('Blinding Smite is a bonus action', () => {
    const p = buildHero('Paladin', 9);
    const bs = p.actions.find(a => a.name === 'Blinding Smite');
    expect(bs!.isBonusAction).toBe(true);
  });

  it('Half casters do NOT get L4 spells', () => {
    for (const cls of ['Paladin', 'Ranger'] as HeroClassName[]) {
      const hero = buildHero(cls, 10);
      expect(hero.actions.some(a => a.spellLevel === 4), `${cls} should not have L4 spells`).toBe(false);
    }
  });
});
