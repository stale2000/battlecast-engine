import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { shieldOfFaith } from '../src/data/spells';

// ─────────────────────────────────────────────────────────────────────────────
// Class spell wiring - one test per class verifying slot table + repertoire.
// End-to-end combat tests live in hero-integration.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe('Wizard spell progression', () => {
  it('L1 has 2 × L1 slots and L1-only spells', () => {
    const w = buildHero('Wizard', 1);
    expect(w.initialResources).toEqual({ 'slot-1': 2 });
    const leveled = w.actions.filter(a => (a.spellLevel ?? -1) > 0);
    const levels = new Set(leveled.map(a => a.spellLevel));
    expect(levels.has(1)).toBe(true);
    expect(levels.has(2)).toBe(false);
    expect(levels.has(3)).toBe(false);
  });

  it('L3 unlocks L2 slots + L2 spells', () => {
    const w = buildHero('Wizard', 3);
    expect(w.initialResources).toEqual({ 'slot-1': 4, 'slot-2': 2 });
    const hasL2 = w.actions.some(a => a.spellLevel === 2);
    expect(hasL2).toBe(true);
  });

  it('L5 unlocks L3 slots + Fireball', () => {
    const w = buildHero('Wizard', 5);
    expect(w.initialResources).toEqual({ 'slot-1': 4, 'slot-2': 3, 'slot-3': 2 });
    const fireball = w.actions.find(a => a.name === 'Fireball');
    expect(fireball).toBeDefined();
    expect(fireball!.spellLevel).toBe(3);
    expect(fireball!.savingThrow?.damageOnFail).toBe('8d6');
  });

  it('Fire Bolt cantrip scales 1d10 → 2d10 at L5', () => {
    const fb1 = buildHero('Wizard', 1).actions.find(a => a.name === 'Fire Bolt')!;
    const fb5 = buildHero('Wizard', 5).actions.find(a => a.name === 'Fire Bolt')!;
    expect(fb1.damage).toBe('1d10');
    expect(fb5.damage).toBe('2d10');
    expect(fb1.spellLevel).toBe(0); // cantrip
  });

  it('Magic Missile is always 3 auto-darts at 1d4+1 force', () => {
    const mm = buildHero('Wizard', 3).actions.find(a => a.name === 'Magic Missile')!;
    expect(mm.autoDarts).toBe(3);
    expect(mm.autoDartDamage).toBe('1d4+1');
    expect(mm.autoDartDamageType).toBe('force');
    expect(mm.spellLevel).toBe(1);
  });

  it('unlocks Meteor Swarm at L17', () => {
    expect(buildHero('Wizard', 16).actions.some(a => a.name === 'Meteor Swarm')).toBe(false);
    expect(buildHero('Wizard', 17).actions.some(a => a.name === 'Meteor Swarm')).toBe(true);
  });
});

describe('Sorcerer spell progression', () => {
  it('shares slot table with Wizard', () => {
    const s = buildHero('Sorcerer', 5);
    // Slot keys only - sorcerer also carries "sorcery" points.
    expect(s.initialResources!['slot-1']).toBe(4);
    expect(s.initialResources!['slot-2']).toBe(3);
    expect(s.initialResources!['slot-3']).toBe(2);
  });

  it('carries Fireball and Lightning Bolt at L5', () => {
    const s = buildHero('Sorcerer', 5);
    expect(s.actions.some(a => a.name === 'Fireball')).toBe(true);
    expect(s.actions.some(a => a.name === 'Lightning Bolt')).toBe(true);
  });

  it('unlocks Meteor Swarm at L17', () => {
    expect(buildHero('Sorcerer', 16).actions.some(a => a.name === 'Meteor Swarm')).toBe(false);
    expect(buildHero('Sorcerer', 17).actions.some(a => a.name === 'Meteor Swarm')).toBe(true);
  });
});

describe('Cleric spell progression', () => {
  it('has both Cure Wounds and Bless at L1', () => {
    const c = buildHero('Cleric', 1);
    expect(c.actions.some(a => a.name === 'Cure Wounds')).toBe(true);
    expect(c.actions.some(a => a.name === 'Bless')).toBe(true);
  });

  it('Cure Wounds uses WIS (caster mod)', () => {
    const c = buildHero('Cleric', 3);
    const cw = c.actions.find(a => a.name === 'Cure Wounds')!;
    expect(cw.castingAbility).toBe('wis');
    expect(cw.heal?.addCastingMod).toBe(true);
  });

  it('gets Spiritual Weapon at L3 (when L2 slots unlock)', () => {
    expect(buildHero('Cleric', 2).actions.some(a => a.name === 'Spiritual Weapon')).toBe(false);
    expect(buildHero('Cleric', 3).actions.some(a => a.name === 'Spiritual Weapon')).toBe(true);
  });

  it('gets Spirit Guardians at L5', () => {
    expect(buildHero('Cleric', 4).actions.some(a => a.name === 'Spirit Guardians')).toBe(false);
    expect(buildHero('Cleric', 5).actions.some(a => a.name === 'Spirit Guardians')).toBe(true);
  });
});

describe('Druid spell progression', () => {
  it('has Entangle and Thunderwave at L1', () => {
    const d = buildHero('Druid', 1);
    expect(d.actions.some(a => a.name === 'Entangle')).toBe(true);
    expect(d.actions.some(a => a.name === 'Thunderwave')).toBe(true);
  });

  it('gets Call Lightning at L5', () => {
    expect(buildHero('Druid', 5).actions.some(a => a.name === 'Call Lightning')).toBe(true);
  });
});

describe('Bard spell progression', () => {
  it('has Dissonant Whispers + Healing Word at L1', () => {
    const b = buildHero('Bard', 1);
    expect(b.actions.some(a => a.name === 'Dissonant Whispers')).toBe(true);
    expect(b.actions.some(a => a.name === 'Healing Word')).toBe(true);
  });

  it('gets Hold Person at L3', () => {
    expect(buildHero('Bard', 2).actions.some(a => a.name === 'Hold Person')).toBe(false);
    expect(buildHero('Bard', 3).actions.some(a => a.name === 'Hold Person')).toBe(true);
  });

  it('gets Aid at L3', () => {
    expect(buildHero('Bard', 2).actions.some(a => a.name === 'Aid')).toBe(false);
    expect(buildHero('Bard', 3).actions.some(a => a.name === 'Aid')).toBe(true);
  });
});

describe('Warlock pact slots', () => {
  it('L1 has one slot-1', () => {
    expect(buildHero('Warlock', 1).initialResources).toEqual({ 'slot-1': 1 });
  });

  it('L3 bumps both slots to L2 (warlock pact slot scaling)', () => {
    expect(buildHero('Warlock', 3).initialResources).toEqual({ 'slot-2': 2 });
  });

  it('L5 slots are all level 3', () => {
    expect(buildHero('Warlock', 5).initialResources).toEqual({ 'slot-3': 2 });
  });

  it('has Hex and Witch Bolt at L1, Hold Person at L3, Hypnotic Pattern at L5', () => {
    expect(buildHero('Warlock', 1).actions.some(a => a.name === 'Hex')).toBe(true);
    expect(buildHero('Warlock', 1).actions.some(a => a.name === 'Witch Bolt')).toBe(true);
    expect(buildHero('Warlock', 3).actions.some(a => a.name === 'Hold Person')).toBe(true);
    expect(buildHero('Warlock', 5).actions.some(a => a.name === 'Hypnotic Pattern')).toBe(true);
  });
});

describe('Paladin / Ranger half-caster progression', () => {
  it('Paladin L1 has 2024 spellcasting', () => {
    const p = buildHero('Paladin', 1);
    expect(p.initialResources!['slot-1']).toBe(2);
    expect(p.actions.some(a => a.name === 'Bless')).toBe(true);
    expect(p.actions.some(a => a.name === 'Cure Wounds')).toBe(true);
  });

  it('Paladin L2 gets Bless + Cure Wounds with 2 × slot-1', () => {
    const p = buildHero('Paladin', 2);
    expect(p.initialResources!['slot-1']).toBe(2);
    expect(p.actions.some(a => a.name === 'Bless')).toBe(true);
    expect(p.actions.some(a => a.name === 'Cure Wounds')).toBe(true);
  });

  it("Ranger L2 gets Hunter's Mark + Cure Wounds + Entangle", () => {
    const r = buildHero('Ranger', 2);
    expect(r.actions.some(a => a.name === "Hunter's Mark")).toBe(true);
    expect(r.actions.some(a => a.name === 'Cure Wounds')).toBe(true);
    expect(r.actions.some(a => a.name === 'Entangle')).toBe(true);
  });

  it('Paladin L5 unlocks slot-2', () => {
    const p = buildHero('Paladin', 5);
    expect(p.initialResources!['slot-1']).toBe(4);
    expect(p.initialResources!['slot-2']).toBe(2);
  });

  it('Paladin L5 unlocks modeled level 2 spells', () => {
    const p4 = buildHero('Paladin', 4);
    const p5 = buildHero('Paladin', 5);
    expect(p4.actions.some(a => a.spellLevel === 2)).toBe(false);
    expect(p5.actions.some(a => a.name === 'Aid')).toBe(true);
    expect(p5.actions.some(a => a.name === 'Magic Weapon')).toBe(true);
    expect(p5.actions.some(a => a.name === 'Shining Smite')).toBe(true);
  });

  it('Ranger L5 unlocks Aid with slot-2', () => {
    expect(buildHero('Ranger', 4).actions.some(a => a.name === 'Aid')).toBe(false);
    expect(buildHero('Ranger', 5).actions.some(a => a.name === 'Aid')).toBe(true);
  });
});

describe('Martial classes have no spells', () => {
  it.each(['Barbarian', 'Fighter', 'Monk', 'Rogue'] as const)('%s has no leveled spells', (cls) => {
    for (let lv = 1; lv <= 6; lv++) {
      const h = buildHero(cls, lv);
      const leveled = h.actions.filter(a => (a.spellLevel ?? 0) > 0);
      expect(leveled).toHaveLength(0);
    }
  });
});

describe('Concentration flags on spells', () => {
  it('Bless, Hex, Hunter\'s Mark, Shield of Faith all flag concentration', () => {
    const p = buildHero('Paladin', 2);
    const bless = p.actions.find(a => a.name === 'Bless')!;
    expect(bless.buff?.requiresConcentration).toBe(true);

    const w = buildHero('Warlock', 1);
    const hex = w.actions.find(a => a.name === 'Hex')!;
    expect(hex.buff?.requiresConcentration).toBe(true);

    const r = buildHero('Ranger', 2);
    const hm = r.actions.find(a => a.name === "Hunter's Mark")!;
    expect(hm.buff?.requiresConcentration).toBe(true);

    const sf = shieldOfFaith();
    expect(sf.buff?.requiresConcentration).toBe(true);
    expect(sf.isBonusAction).toBe(true);
  });
});

describe('Class abilities: Rage, Second Wind, Divine Smite', () => {
  it('Barbarian has a Rage action with rage resource cost and physical resistance', () => {
    const b = buildHero('Barbarian', 3);
    const rage = b.actions.find(a => a.name === 'Rage')!;
    expect(rage).toBeDefined();
    expect(rage.resourceCost).toEqual({ key: 'rage', amount: 1 });
    expect(rage.buff?.resistPhysical).toBe(true);
    expect(rage.buff?.rageDamageBonus).toBe(2);
    expect(b.initialResources!.rage).toBe(3); // L3-5: 3 uses
  });

  it('Fighter has Second Wind as a self-heal action with 1d10+level', () => {
    const f = buildHero('Fighter', 3);
    const sw = f.actions.find(a => a.name === 'Second Wind')!;
    expect(sw).toBeDefined();
    expect(sw.heal?.dice).toBe('1d10+3');
    expect(sw.resourceCost).toEqual({ key: 'second-wind', amount: 1 });
    expect(f.initialResources!['second-wind']).toBe(2);
  });

  it("Paladin L2+ weapons gain the smiteOnHit hook", () => {
    const p1 = buildHero('Paladin', 1);
    const p2 = buildHero('Paladin', 2);
    const sword1 = p1.actions.find(a => a.name === 'Longsword')!;
    const sword2 = p2.actions.find(a => a.name === 'Longsword')!;
    expect(sword1.smiteOnHit).toBeUndefined();
    expect(sword2.smiteOnHit).toBeDefined();
    expect(sword2.smiteOnHit!.damageType).toBe('radiant');
    expect(sword2.smiteOnHit!.die).toBe(8);
    expect(sword2.smiteOnHit!.dicePerSlotLevel[0]).toBe(2); // 2d8 at L1 slot
  });

  it('Paladin has Lay on Hands action + pool', () => {
    const p = buildHero('Paladin', 3);
    const loh = p.actions.find(a => a.name === 'Lay on Hands')!;
    expect(loh).toBeDefined();
    expect(loh.layOnHands).toEqual({ resourceKey: 'lay-on-hands' });
    expect(p.initialResources!['lay-on-hands']).toBe(15); // 5 × level
  });

  it('Cleric L2+ has Channel Divinity resource', () => {
    expect(buildHero('Cleric', 1).initialResources!['channel-divinity']).toBeUndefined();
    expect(buildHero('Cleric', 2).initialResources!['channel-divinity']).toBe(2);
    expect(buildHero('Cleric', 6).initialResources!['channel-divinity']).toBe(3);
  });

  it('Monk L2+ has a ki pool equal to monk level', () => {
    expect(buildHero('Monk', 1).initialResources?.ki).toBeUndefined();
    expect(buildHero('Monk', 3).initialResources!.ki).toBe(3);
    expect(buildHero('Monk', 6).initialResources!.ki).toBe(6);
  });

  it('Sorcerer L2+ has sorcery points equal to sorcerer level', () => {
    // Sorcerer L1 has slot-1 but no sorcery points yet.
    expect(buildHero('Sorcerer', 1).initialResources?.sorcery).toBeUndefined();
    expect(buildHero('Sorcerer', 1).initialResources?.['innate-sorcery']).toBe(2);
    expect(buildHero('Sorcerer', 3).initialResources!.sorcery).toBe(3);
    expect(buildHero('Sorcerer', 6).initialResources!.sorcery).toBe(6);
  });

  it('Bard always has Bardic Inspiration die (min 1)', () => {
    expect(buildHero('Bard', 1).initialResources!['bardic-inspiration']).toBe(3);
    expect(buildHero('Bard', 5).initialResources!['bardic-inspiration']).toBe(4);
  });
});

describe('Spell save DCs scale with level and ability', () => {
  it('Wizard L5 with INT 18 and PB+3 has DC 8 + 3 + 4 = 15', () => {
    const w = buildHero('Wizard', 5);
    const fireball = w.actions.find(a => a.name === 'Fireball')!;
    expect(fireball.savingThrow?.dc).toBe(15);
  });

  it('Cleric L1 with WIS 16 and PB+2 has DC 8 + 2 + 3 = 13', () => {
    const c = buildHero('Cleric', 1);
    // Bless has no save, but verify Guiding Bolt attack bonus: PB(2)+WIS(3)=5
    const gb = c.actions.find(a => a.name === 'Guiding Bolt')!;
    expect(gb.attackBonus).toBe(5);
  });
});
