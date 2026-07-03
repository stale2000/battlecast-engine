import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { Creature, MonsterData } from '../src/types/monster';
import {
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  hasAdvantage,
  resolveAttack,
  runDeathSave,
  type BattleState,
} from '../src/engine/combat';
import { executeRound } from '../src/engine/ai';

function makeTarget(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Training Target',
    size: 'Medium',
    type: 'Humanoid',
    alignment: 'Unaligned',
    ac: 10,
    hp: 400,
    hpFormula: '400',
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

describe('Fighter level 11-20 build data', () => {
  it('unlocks Fighter through level 20 without unlocking the next unfinished class', () => {
    expect(getMaxHeroLevelForClass('Fighter')).toBe(20);
    expect(getMaxHeroLevelForClass('Monk')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Fighter', 20)).not.toThrow();
    expect(() => buildHero('Monk', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed level-20 Champion loadout, resources, and four-attack action', () => {
    const fighter = buildHero('Fighter', 20);

    expect(fighter.heroSubclass).toBe('Champion');
    expect(fighter.abilities.str).toBe(21);
    expect(fighter.abilities.con).toBe(20);
    expect(fighter.abilities.dex).toBe(17);
    expect(fighter.ac).toBe(21);
    expect(fighter.proficiencyBonus).toBe(6);
    expect(fighter.initialResources?.['second-wind']).toBe(4);
    expect(fighter.initialResources?.['action-surge']).toBe(2);
    expect(fighter.initialResources?.indomitable).toBe(3);
    expect(fighter.actions.find(a => a.name === 'Multiattack')?.description).toContain('four Longsword attacks');
  });

  it('scales Extra Attack at levels 11 and 20', () => {
    expect(buildHero('Fighter', 10).actions.find(a => a.name === 'Multiattack')?.description).toContain('two Longsword attacks');
    expect(buildHero('Fighter', 11).actions.find(a => a.name === 'Multiattack')?.description).toContain('three Longsword attacks');
    expect(buildHero('Fighter', 20).actions.find(a => a.name === 'Multiattack')?.description).toContain('four Longsword attacks');
  });
});

describe('Fighter high-level attacks', () => {
  it('Action Surge repeats the full four-attack action at level 20', () => {
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 20), 'blue', { x: 1, y: 1 }, 0);
    const enemy = createCreatureWithFixedHp(makeTarget({ hp: 1000 }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([fighter, enemy]);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    executeRound(state);

    const weaponSwings = state.logs.filter(l => l.round === 1 && l.actor === fighter.displayName && l.action === 'Longsword');
    expect(weaponSwings).toHaveLength(8);
    expect(fighter.resources['action-surge']).toBe(1);
    expect(fighter.stats.actionUsage['Action Surge']).toBe(1);
  });

  it('Improved Critical and Superior Critical expand the Champion critical range', () => {
    const l14 = createCreatureWithFixedHp(buildHero('Fighter', 14), 'blue', { x: 1, y: 1 }, 0);
    const l15 = createCreatureWithFixedHp(buildHero('Fighter', 15), 'blue', { x: 1, y: 1 }, 0);
    const hardTarget1 = createCreatureWithFixedHp(makeTarget({ ac: 99 }), 'red', { x: 2, y: 1 }, 1);
    const hardTarget2 = createCreatureWithFixedHp(makeTarget({ ac: 99 }), 'red', { x: 2, y: 1 }, 2);
    const longsword14 = l14.monsterData.actions.find(a => a.name === 'Longsword')!;
    const longsword15 = l15.monsterData.actions.find(a => a.name === 'Longsword')!;

    vi.spyOn(Math, 'random').mockReturnValue(0.85); // natural 18
    resolveAttack(stateWith([l14, hardTarget1]), l14, hardTarget1, longsword14);
    expect(hardTarget1.currentHp).toBe(hardTarget1.maxHp);

    vi.restoreAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0.85); // natural 18
    resolveAttack(stateWith([l15, hardTarget2]), l15, hardTarget2, longsword15);
    expect(hardTarget2.currentHp).toBeLessThan(hardTarget2.maxHp);
  });

  it('Studied Attacks grants Advantage on the next attack after a miss', () => {
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 13), 'blue', { x: 1, y: 1 }, 0);
    const enemy = createCreatureWithFixedHp(makeTarget({ ac: 99 }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([fighter, enemy]);
    const longsword = fighter.monsterData.actions.find(a => a.name === 'Longsword')!;
    vi.spyOn(Math, 'random').mockReturnValue(0.2);

    resolveAttack(state, fighter, enemy, longsword);

    expect(hasAdvantage(state, fighter, enemy, longsword)).toBe(true);
    expect(fighter.stats.actionUsage['Studied Attacks']).toBe(1);
  });

  it('Boon of Combat Prowess converts one miss per turn into a hit', () => {
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 19), 'blue', { x: 1, y: 1 }, 0);
    const enemy = createCreatureWithFixedHp(makeTarget({ ac: 99, hp: 200 }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([fighter, enemy]);
    const longsword = fighter.monsterData.actions.find(a => a.name === 'Longsword')!;
    vi.spyOn(Math, 'random').mockReturnValue(0); // natural 1 would normally miss

    resolveAttack(state, fighter, enemy, longsword);
    const hpAfterFirst = enemy.currentHp;
    resolveAttack(state, fighter, enemy, longsword);

    expect(hpAfterFirst).toBeLessThan(enemy.maxHp);
    expect(enemy.currentHp).toBe(hpAfterFirst);
    expect(fighter.stats.actionUsage['Boon of Combat Prowess']).toBe(1);
    expect(state.logs.some(l => l.action === 'Boon of Combat Prowess')).toBe(true);
  });
});

describe('Fighter Survivor', () => {
  it('heals a bloodied level-18 Champion at the start of its turn', () => {
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 18), 'blue', { x: 1, y: 1 }, 0);
    const enemy = createCreatureWithFixedHp(makeTarget({ hp: 400 }), 'red', { x: 2, y: 1 }, 1);
    fighter.currentHp = Math.floor(fighter.maxHp / 2);
    const before = fighter.currentHp;
    const state = stateWith([fighter, enemy]);

    executeRound(state);

    expect(fighter.currentHp).toBeGreaterThan(before);
    expect(state.logs.some(l => l.action === 'Survivor')).toBe(true);
    expect(fighter.stats.actionUsage.Survivor).toBe(1);
  });

  it('treats an 18-20 death save as a pop-up at level 18', () => {
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 18), 'blue', { x: 1, y: 1 }, 0);
    fighter.currentHp = 0;
    fighter.dying = true;
    fighter.deathSaves = { successes: 0, failures: 0 };
    fighter.conditions.push('unconscious');
    const state = stateWith([fighter]);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.85) // 18
      .mockReturnValueOnce(0); // advantage second die

    runDeathSave(state, fighter);

    expect(fighter.dying).toBe(false);
    expect(fighter.currentHp).toBe(1);
    expect(fighter.conditions).not.toContain('unconscious');
    expect(fighter.stats.timesPoppedAtOneHp).toBe(1);
  });
});
