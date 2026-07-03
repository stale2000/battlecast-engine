import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { Creature, MonsterData } from '../src/types/monster';
import {
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  executeSpell,
  resolveAttack,
  type BattleState,
} from '../src/engine/combat';

function makeTarget(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Training Target',
    size: 'Medium',
    type: 'Humanoid',
    alignment: 'Unaligned',
    ac: 10,
    hp: 100,
    hpFormula: '100',
    speed: { walk: 30 },
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    senses: 'Passive Perception 10',
    languages: '-',
    cr: '0',
    xp: 0,
    proficiencyBonus: 2,
    actions: [{ name: 'Slam', type: 'melee', attackBonus: 5, damage: '1d8+3', damageType: 'bludgeoning', reach: 5, description: 'Slam.' }],
    ...overrides,
  };
}

function stateWith(creatures: Creature[]): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize: 20,
    teamTactics: DEFAULT_TACTICS,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cleric level 11-20 build data', () => {
  it('unlocks Cleric through level 20 without unlocking the next unfinished class', () => {
    expect(getMaxHeroLevelForClass('Cleric')).toBe(20);
    expect(getMaxHeroLevelForClass('Druid')).toBe(20);
    expect(getMaxHeroLevelForClass('Fighter')).toBe(20);
    expect(getMaxHeroLevelForClass('Monk')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Cleric', 20)).not.toThrow();
    expect(() => buildHero('Druid', 20)).not.toThrow();
    expect(() => buildHero('Fighter', 20)).not.toThrow();
    expect(() => buildHero('Monk', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed level-20 Life Cleric loadout, slots, and resources', () => {
    const cleric = buildHero('Cleric', 20);

    expect(cleric.heroSubclass).toBe('Life Domain');
    expect(cleric.abilities.wis).toBe(21);
    expect(cleric.abilities.con).toBe(19);
    expect(cleric.proficiencyBonus).toBe(6);
    expect(cleric.ac).toBe(20);
    expect(cleric.initialResources?.['channel-divinity']).toBe(4);
    expect(cleric.initialResources?.['divine-intervention']).toBe(1);
    expect(cleric.initialResources?.['slot-9']).toBe(1);
    expect(cleric.initialResources?.['slot-7']).toBe(2);
    expect(cleric.actions.some(a => a.name === 'Heal')).toBe(true);
    expect(cleric.actions.some(a => a.name === 'Fire Storm')).toBe(true);
    expect(cleric.actions.some(a => a.name === 'Sunburst')).toBe(true);
    expect(cleric.actions.some(a => a.name === 'Mass Heal')).toBe(true);
    expect(cleric.actions.some(a => a.name === 'Power Word Heal')).toBe(true);
    expect(cleric.actions.some(a => a.name === 'Greater Divine Intervention: Wish-Heal')).toBe(true);
  });

  it('uses the 2024 Channel Divinity use scaling', () => {
    expect(buildHero('Cleric', 2).initialResources?.['channel-divinity']).toBe(2);
    expect(buildHero('Cleric', 6).initialResources?.['channel-divinity']).toBe(3);
    expect(buildHero('Cleric', 18).initialResources?.['channel-divinity']).toBe(4);
  });

  it('Improved Blessed Strikes upgrades Divine Strike to 2d8 at level 14', () => {
    const l13 = buildHero('Cleric', 13).actions.find(a => a.name === 'Warhammer')!;
    const l14 = buildHero('Cleric', 14).actions.find(a => a.name === 'Warhammer')!;

    expect(l13.additionalDamage).toBe('1d8 radiant');
    expect(l14.additionalDamage).toBe('2d8 radiant');
  });
});

describe('Life Cleric healing features', () => {
  it('Preserve Life cannot heal a target above half its maximum HP', () => {
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 10), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ hp: 100 }), 'blue', { x: 2, y: 1 }, 1);
    ally.currentHp = 10;
    const state = stateWith([cleric, ally]);
    const preserveLife = cleric.monsterData.actions.find(a => a.name === 'Channel Divinity: Preserve Life')!;

    executeSpell(state, cleric, preserveLife, ally);

    expect(ally.currentHp).toBe(50);
    expect(cleric.resources['channel-divinity']).toBe(2);
  });

  it('Disciple of Life improves slot healing and Blessed Healer heals the Cleric once', () => {
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 6), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ hp: 100 }), 'blue', { x: 2, y: 1 }, 1);
    cleric.currentHp = 20;
    ally.currentHp = 1;
    const state = stateWith([cleric, ally]);
    const cure = cleric.monsterData.actions.find(a => a.name === 'Cure Wounds')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    executeSpell(state, cleric, cure, ally);

    expect(ally.currentHp).toBe(10); // min 2d8 + WIS 4 + Disciple of Life 3
    expect(cleric.currentHp).toBe(23); // Blessed Healer: 2 + slot level
    expect(cleric.resources['slot-1']).toBe(3);
  });

  it('Supreme Healing maximizes healing dice at level 17', () => {
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 17), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ hp: 100 }), 'blue', { x: 2, y: 1 }, 1);
    ally.currentHp = 1;
    const state = stateWith([cleric, ally]);
    const massCure = cleric.monsterData.actions.find(a => a.name === 'Mass Cure Wounds')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    executeSpell(state, cleric, massCure, ally);

    expect(ally.currentHp).toBe(53); // 5d8 maximized (40) + WIS 5 + Disciple of Life 7
    expect(state.logs.some(l => l.action === 'Blessed Healer')).toBe(true);
  });

  it('Heal restores 70 HP and clears blinded, deafened, and poisoned', () => {
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 11), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ hp: 100 }), 'blue', { x: 2, y: 1 }, 1);
    ally.currentHp = 10;
    ally.conditions.push('blinded', 'deafened', 'poisoned');
    const state = stateWith([cleric, ally]);
    const heal = cleric.monsterData.actions.find(a => a.name === 'Heal')!;

    executeSpell(state, cleric, heal, ally);

    expect(ally.currentHp).toBe(88); // 70 + Disciple of Life 8 from a level-6 slot
    expect(ally.conditions).not.toContain('blinded');
    expect(ally.conditions).not.toContain('deafened');
    expect(ally.conditions).not.toContain('poisoned');
  });
});

describe('Cleric high-level offensive and intervention features', () => {
  it('Divine Intervention casts a level-5 Cleric spell without expending a slot', () => {
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 10), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ hp: 100 }), 'blue', { x: 2, y: 1 }, 1);
    cleric.currentHp = cleric.maxHp;
    ally.currentHp = 1;
    const state = stateWith([cleric, ally]);
    const intervention = cleric.monsterData.actions.find(a => a.name === 'Divine Intervention: Mass Cure Wounds')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    executeSpell(state, cleric, intervention, ally);

    expect(cleric.resources['divine-intervention']).toBe(0);
    expect(cleric.resources['slot-5']).toBe(2);
    expect(ally.currentHp).toBe(11); // free cast: min 5d8 + WIS, no Disciple/Blessed Healer
    expect(cleric.currentHp).toBe(cleric.maxHp);
  });

  it('Greater Divine Intervention uses the same intervention resource for Wish-Heal', () => {
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 20), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ hp: 100 }), 'blue', { x: 2, y: 1 }, 1);
    ally.currentHp = 1;
    const state = stateWith([cleric, ally]);
    const wishHeal = cleric.monsterData.actions.find(a => a.name === 'Greater Divine Intervention: Wish-Heal')!;

    executeSpell(state, cleric, wishHeal, ally);

    expect(cleric.resources['divine-intervention']).toBe(0);
    expect(cleric.resources['slot-6']).toBe(2);
    expect(ally.currentHp).toBe(71);
  });

  it('Cleric level 14 weapon hits include 2d8 radiant Divine Strike damage', () => {
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 14), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 100 }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([cleric, target]);
    const warhammer = cleric.monsterData.actions.find(a => a.name === 'Warhammer')!;
    vi.spyOn(Math, 'random').mockReturnValue(0.95);

    resolveAttack(state, cleric, target, warhammer);

    expect(target.currentHp).toBeLessThan(100 - 8); // base hit plus improved Divine Strike rider
    expect(state.logs.some(l => l.action === 'Warhammer' && l.details.includes('radiant'))).toBe(true);
  });
});
