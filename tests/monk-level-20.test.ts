import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { Creature, MonsterData } from '../src/types/monster';
import {
  applyDamage,
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  getEffectiveSaveModifier,
  resolveAttack,
  rollAllInitiatives,
  rollSaveWithBuffs,
  type BattleState,
} from '../src/engine/combat';
import { executeRound } from '../src/engine/ai';

function makeTarget(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Training Target',
    size: 'Medium',
    type: 'Construct',
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

describe('Monk level 11-20 build data', () => {
  it('unlocks Monk through level 20 without unlocking the next unfinished class', () => {
    expect(getMaxHeroLevelForClass('Monk')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Monk', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed level-20 Open Hand loadout', () => {
    const monk = buildHero('Monk', 20);

    expect(monk.heroSubclass).toBe('Warrior of the Open Hand');
    expect(monk.abilities.dex).toBe(25);
    expect(monk.abilities.wis).toBe(22);
    expect(monk.ac).toBe(24);
    expect(monk.speed.walk).toBe(60);
    expect(monk.initialResources?.ki).toBe(20);
    expect(monk.initialResources?.['wholeness-of-body']).toBe(6);
    expect(monk.saves).toMatchObject({ str: expect.any(Number), dex: expect.any(Number), con: expect.any(Number), int: expect.any(Number), wis: expect.any(Number), cha: expect.any(Number) });
    expect(monk.actions.find(a => a.name === 'Multiattack')?.description).toContain('two Martial Arts (Unarmed) attacks');
    expect(monk.actions.find(a => a.name === 'Martial Arts (Unarmed)')?.damage).toMatch(/^1d12\+7$/);
  });

  it('scales Martial Arts and Unarmored Movement by the SRD table', () => {
    expect(buildHero('Monk', 4).actions.find(a => a.name === 'Martial Arts (Unarmed)')?.damage).toMatch(/^1d6/);
    expect(buildHero('Monk', 5).actions.find(a => a.name === 'Martial Arts (Unarmed)')?.damage).toMatch(/^1d8/);
    expect(buildHero('Monk', 11).actions.find(a => a.name === 'Martial Arts (Unarmed)')?.damage).toMatch(/^1d10/);
    expect(buildHero('Monk', 17).actions.find(a => a.name === 'Martial Arts (Unarmed)')?.damage).toMatch(/^1d12/);
    expect(buildHero('Monk', 6).speed.walk).toBe(45);
    expect(buildHero('Monk', 10).speed.walk).toBe(50);
    expect(buildHero('Monk', 14).speed.walk).toBe(55);
    expect(buildHero('Monk', 18).speed.walk).toBe(60);
  });
});

describe('Monk defensive features', () => {
  it('Deflect Attacks reduces physical attack damage as a reaction', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 3), 'blue', { x: 1, y: 1 }, 0);
    const attacker = createCreatureWithFixedHp(makeTarget(), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([monk, attacker]);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    applyDamage(state, monk, 20, 'slashing', attacker, true, false);

    expect(monk.currentHp).toBe(monk.maxHp - 4);
    expect(monk.reactionUsed).toBe(true);
    expect(monk.stats.actionUsage['Deflect Attacks']).toBe(1);
  });

  it('Deflect Energy works on non-physical attack damage from level 13', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 13), 'blue', { x: 1, y: 1 }, 0);
    const state = stateWith([monk]);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    applyDamage(state, monk, 20, 'fire', null, true, true);

    expect(monk.currentHp).toBe(monk.maxHp);
    expect(monk.stats.actionUsage['Deflect Energy']).toBe(1);
  });

  it('Disciplined Survivor gives all-save proficiency and can reroll a failed save', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 14), 'blue', { x: 1, y: 1 }, 0);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.95)
      .mockReturnValueOnce(0.95);

    const save = rollSaveWithBuffs(monk, getEffectiveSaveModifier(monk, 'int'), false, 15, 'int');

    expect(monk.monsterData.saves?.int).toBeGreaterThan(0);
    expect(save.total).toBeGreaterThanOrEqual(15);
    expect(monk.resources.ki).toBe(13);
    expect(monk.stats.actionUsage['Disciplined Survivor']).toBe(1);
  });

  it('Perfect Focus restores low Focus Points to 4 on initiative', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 15), 'blue', { x: 1, y: 1 }, 0);
    monk.resources.ki = 2;

    rollAllInitiatives([monk]);

    expect(monk.resources.ki).toBe(4);
  });

  it('Superior Defense activates at turn start and resists non-force damage', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 18), 'blue', { x: 1, y: 1 }, 0);
    const enemy = createCreatureWithFixedHp(makeTarget({ hp: 1000 }), 'red', { x: 12, y: 12 }, 1);
    const state = stateWith([monk, enemy]);

    executeRound(state);
    const before = monk.currentHp;
    applyDamage(state, monk, 20, 'fire', enemy, false, true);

    expect(monk.activeBuffs.some(b => b.key === 'superior-defense')).toBe(true);
    expect(monk.resources.ki).toBeLessThan(18);
    expect(before - monk.currentHp).toBe(10);
    expect(monk.stats.actionUsage['Superior Defense']).toBe(1);
  });
});

describe('Monk high-level attacks', () => {
  it('Stunning Strike is once per turn and applies the success rider', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 5), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 1000 }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([monk, target]);
    const unarmed = monk.monsterData.actions.find(a => a.name === 'Martial Arts (Unarmed)')!;
    vi.spyOn(Math, 'random').mockReturnValue(0.95);

    resolveAttack(state, monk, target, unarmed);
    const openingApplied = target.activeBuffs.some(b => b.key.includes('stunning-strike-success') && b.advantageForAllAttackers);
    resolveAttack(state, monk, target, unarmed);

    expect(monk.stats.actionUsage['Stunning Strike']).toBe(1);
    expect(monk.resources.ki).toBe(4);
    expect(target.activeBuffs.some(b => b.key.includes('stunning-strike-success') && b.speedPenalty)).toBe(true);
    expect(openingApplied).toBe(true);
  });

  it('Open Hand Technique can topple a target hit by Flurry of Blows', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 10), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 1000 }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([monk, target]);
    const unarmed = monk.monsterData.actions.find(a => a.name === 'Martial Arts (Unarmed)')!;
    monk.turnFlags.openHandFlurryStrike = true;
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    resolveAttack(state, monk, target, unarmed);

    expect(target.conditions).toContain('prone');
    expect(monk.stats.actionUsage['Open Hand Technique']).toBe(1);
  });

  it('Quivering Palm seeds on an unarmed hit and detonates on the next Monk turn', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 17), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 1000 }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([monk, target]);
    vi.spyOn(Math, 'random').mockReturnValue(0.95);

    executeRound(state);
    expect(target.activeBuffs.some(b => b.key === `quivering-palm:${monk.id}`)).toBe(true);

    const hpBefore = target.currentHp;
    executeRound(state);

    expect(target.currentHp).toBeLessThan(hpBefore);
    expect(target.activeBuffs.some(b => b.key === `quivering-palm:${monk.id}`)).toBe(false);
    expect(monk.stats.actionUsage['Quivering Palm']).toBe(1);
  });

  it('uses a ranged fallback instead of melee-only bonus attacks against airborne targets', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 20), 'red', { x: 4, y: 10 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({
      name: 'Hovering Target',
      speed: { walk: 0, fly: 40, hover: true },
      hp: 1000,
    }), 'blue', { x: 5, y: 10 }, 1);
    const state = stateWith([monk, target]);
    vi.spyOn(Math, 'random').mockReturnValue(0.95);

    executeRound(state);

    const monkLogs = state.logs.filter(log => log.actor === monk.displayName);
    expect(monk.monsterData.actions.find(action => action.name === 'Dart')).toBeDefined();
    expect(monkLogs.some(log => log.action === 'Dart')).toBe(true);
    expect(monkLogs.some(log => log.action === 'Flurry of Blows')).toBe(false);
    expect(monkLogs.some(log => log.action === 'Martial Arts')).toBe(false);
    expect(monkLogs.some(log => log.details?.includes('flying above melee range'))).toBe(false);
  });

  it('Wholeness of Body is chosen as a bonus-action self-heal when bloodied', () => {
    const monk = createCreatureWithFixedHp(buildHero('Monk', 6), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 1000 }), 'red', { x: 12, y: 12 }, 1);
    monk.currentHp = Math.floor(monk.maxHp / 3);
    const before = monk.currentHp;
    const state = stateWith([monk, target]);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    executeRound(state);

    expect(monk.currentHp).toBeGreaterThan(before);
    expect(monk.resources['wholeness-of-body']).toBe((monk.monsterData.initialResources?.['wholeness-of-body'] ?? 0) - 1);
    expect(state.logs.some(log => log.action === 'Wholeness of Body')).toBe(true);
  });

  it('Boon of Irresistible Offense ignores physical resistance for Monk weapon damage', () => {
    const monk18 = createCreatureWithFixedHp(buildHero('Monk', 18), 'blue', { x: 1, y: 1 }, 0);
    const monk19 = createCreatureWithFixedHp(buildHero('Monk', 19), 'blue', { x: 1, y: 2 }, 1);
    const resisted = createCreatureWithFixedHp(makeTarget({ resistances: ['bludgeoning'] }), 'red', { x: 2, y: 1 }, 2);
    const ignored = createCreatureWithFixedHp(makeTarget({ resistances: ['bludgeoning'] }), 'red', { x: 2, y: 2 }, 3);

    applyDamage(stateWith([monk18, resisted]), resisted, 20, 'bludgeoning', monk18, true, true);
    applyDamage(stateWith([monk19, ignored]), ignored, 20, 'bludgeoning', monk19, true, true);

    expect(resisted.currentHp).toBe(390);
    expect(ignored.currentHp).toBe(380);
  });
});
