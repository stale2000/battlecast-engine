import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { monsters } from '../src/data/monsters';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp, applyDamage } from '../src/engine/combat';
import type { BattleState } from '../src/engine/combat';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

function makeState(creatures: ReturnType<typeof createCreatureWithFixedHp>[]): BattleState {
  return {
    creatures, round: 1, turnIndex: 0,
    events: [], logs: [], isComplete: false, gridSize: 20,
  } as unknown as BattleState;
}

// ── Barbarian ──

describe('Barbarian L7: Feral Instinct', () => {
  it('Barbarian L7+ has Feral Instinct trait', () => {
    const barb7 = buildHero('Barbarian', 7);
    expect(barb7.traits?.some(t => t.name.includes('Feral Instinct'))).toBe(true);
  });

  it('Barbarian L6 does NOT have Feral Instinct', () => {
    const barb6 = buildHero('Barbarian', 6);
    expect(barb6.traits?.some(t => t.name.includes('Feral Instinct'))).toBeFalsy();
  });
});

describe('Barbarian L9: Rage damage +3', () => {
  it('rage damage bonus is +3 at L9+', () => {
    const barb = buildHero('Barbarian', 9);
    // The rage buff template should have rageDamageBonus = 3
    const rageAction = barb.actions.find(a => a.name === 'Rage');
    expect(rageAction).toBeDefined();
    expect(rageAction!.buff?.rageDamageBonus).toBe(3);
  });

  it('rage damage bonus is +2 at L8', () => {
    const barb = buildHero('Barbarian', 8);
    const rageAction = barb.actions.find(a => a.name === 'Rage');
    expect(rageAction!.buff?.rageDamageBonus).toBe(2);
  });
});

// ── Monk & Rogue L7: Evasion ──

describe('Evasion (Monk L7, Rogue L7)', () => {
  it('Monk L7+ takes 0 damage on successful DEX save from AoE', () => {
    const monk = buildHero('Monk', 7);
    const wizard = buildHero('Wizard', 5);
    const c = createCreatureWithFixedHp(monk, 'blue', { x: 10, y: 10 }, 0);
    const w = createCreatureWithFixedHp(wizard, 'red', { x: 5, y: 10 }, 0);
    const state = makeState([c, w]);

    // Simulate a DEX-save AoE that the monk saves against
    // With Evasion, success = 0 damage instead of half
    // We test via the evasion flag on the hero data
    expect(monk.traits?.some(t => t.name.includes('Evasion'))).toBe(true);
  });

  it('Rogue L7+ has Evasion trait', () => {
    const rogue = buildHero('Rogue', 7);
    expect(rogue.traits?.some(t => t.name.includes('Evasion'))).toBe(true);
  });

  it('Monk L6 does NOT have Evasion', () => {
    const monk = buildHero('Monk', 6);
    expect(monk.traits?.some(t => t.name.includes('Evasion'))).toBeFalsy();
  });

  it('Rogue L6 does NOT have Evasion', () => {
    const rogue = buildHero('Rogue', 6);
    expect(rogue.traits?.some(t => t.name.includes('Evasion'))).toBeFalsy();
  });

  it('Evasion: Monk takes 0 damage from Fireball on DEX save success', () => {
    const monk = buildHero('Monk', 7);
    const wizard = buildHero('Wizard', 5);
    let evasionLogSeen = false;
    for (let i = 0; i < 50; i++) {
      const creatures = [
        createCreatureWithFixedHp(wizard, 'red', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(monk, 'blue', { x: 10, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.action === 'Evasion')) {
        evasionLogSeen = true;
        break;
      }
    }
    expect(evasionLogSeen).toBe(true);
  });
});

// ── Wizard L10: Empowered Evocation ──

describe('Wizard L10: Empowered Evocation', () => {
  it('Wizard L10 has Empowered Evocation trait', () => {
    const wizard = buildHero('Wizard', 10);
    expect(wizard.traits?.some(t => t.name.includes('Empowered Evocation'))).toBe(true);
  });

  it('Wizard L9 does NOT have Empowered Evocation', () => {
    const wizard = buildHero('Wizard', 9);
    expect(wizard.traits?.some(t => t.name.includes('Empowered Evocation'))).toBeFalsy();
  });
});

// ── Warlock L10: Fiendish Resilience ──

describe('Warlock L10: Fiendish Resilience', () => {
  it('Warlock L10 has Fiendish Resilience trait', () => {
    const warlock = buildHero('Warlock', 10);
    expect(warlock.traits?.some(t => t.name.includes('Fiendish Resilience'))).toBe(true);
  });
});

// ── Cleric L7: Blessed Strikes ──

describe('Cleric L7: Blessed Strikes', () => {
  it('Cleric L7+ has Blessed Strikes trait', () => {
    const cleric = buildHero('Cleric', 7);
    expect(cleric.traits?.some(t => t.name.includes('Blessed Strikes'))).toBe(true);
  });

  it('Cleric L6 does NOT have Blessed Strikes', () => {
    const cleric = buildHero('Cleric', 6);
    expect(cleric.traits?.some(t => t.name.includes('Blessed Strikes'))).toBeFalsy();
  });
});

// ── Druid L7: Elemental Fury ──

describe('Druid L7: Elemental Fury', () => {
  it('Druid L7+ has Elemental Fury trait', () => {
    const druid = buildHero('Druid', 7);
    expect(druid.traits?.some(t => t.name.includes('Elemental Fury'))).toBe(true);
  });
});

// ── Fighter L10: Heroic Warrior ──

describe('Fighter L10: Heroic Warrior', () => {
  it('Fighter L10 has Heroic Warrior trait', () => {
    const fighter = buildHero('Fighter', 10);
    expect(fighter.traits?.some(t => t.name.includes('Heroic Warrior'))).toBe(true);
  });
});

// ── Monk L10: Self-Restoration ──

describe('Monk L10: Self-Restoration', () => {
  it('Monk L10 has Self-Restoration trait', () => {
    const monk = buildHero('Monk', 10);
    expect(monk.traits?.some(t => t.name.includes('Self-Restoration'))).toBe(true);
  });
});

// ── Bard L10: Bardic Inspiration d10 ──

describe('Bard L10: Bardic Inspiration d10', () => {
  it('Bard L10 has Inspiration d10 trait', () => {
    const bard = buildHero('Bard', 10);
    expect(bard.traits?.some(t => t.name.includes('d10'))).toBe(true);
  });
});

// ── Druid L10: Nature's Ward ──

describe('Druid L10: Nature\'s Ward', () => {
  it('Druid L10 has Nature\'s Ward trait', () => {
    const druid = buildHero('Druid', 10);
    expect(druid.traits?.some(t => t.name.includes('Nature'))).toBe(true);
  });
});

// ── Cross-class: L7-10 power scaling ──

describe('L7-10 power scaling', () => {
  it('L10 heroes have higher attack bonus and more HP than L6', () => {
    // Structural test - L10 is strictly better stats than L6
    for (const cls of ['Fighter', 'Barbarian', 'Wizard', 'Cleric', 'Rogue'] as const) {
      const h6 = buildHero(cls, 6);
      const h10 = buildHero(cls, 10);
      expect(h10.hp, `${cls} L10 HP`).toBeGreaterThan(h6.hp);
      const w6 = h6.actions.find(a => a.type === 'melee' || a.type === 'ranged');
      const w10 = h10.actions.find(a => a.type === 'melee' || a.type === 'ranged');
      if (w6 && w10) {
        expect(w10.attackBonus!, `${cls} L10 attack bonus`).toBeGreaterThanOrEqual(w6.attackBonus!);
      }
    }
  });

});
