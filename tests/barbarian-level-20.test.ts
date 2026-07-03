import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildHero, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { ActiveBuff, Creature, MonsterData } from '../src/types/monster';
import {
  applyCondition,
  applyDamage,
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  resolveAttack,
  rollAllInitiatives,
  rollSaveWithBuffs,
  type BattleState,
} from '../src/engine/combat';

function makeTarget(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Training Target',
    size: 'Medium',
    type: 'Construct',
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
    actions: [{ name: 'Slam', type: 'melee', attackBonus: 4, damage: '1d6+2', damageType: 'bludgeoning', reach: 5, description: 'Slam.' }],
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

function rageBuff(creature: Creature, bonus = 4): ActiveBuff {
  return {
    name: 'Rage',
    key: 'rage',
    casterId: creature.id,
    appliedRound: 1,
    endRound: 100,
    rageDamageBonus: bonus,
    resistPhysical: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Barbarian level 11-20 build data', () => {
  it('unlocks Barbarian through level 20 without unlocking unfinished classes', () => {
    expect(getMaxHeroLevelForClass('Barbarian')).toBe(20);
    expect(getMaxHeroLevelForClass('Fighter')).toBe(20);
    expect(getMaxHeroLevelForClass('Monk')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Barbarian', 20)).not.toThrow();
    expect(() => buildHero('Fighter', 20)).not.toThrow();
    expect(() => buildHero('Monk', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies level-20 Primal Champion and the fixed Epic Boon loadout', () => {
    const barbarian = buildHero('Barbarian', 20);
    expect(barbarian.abilities.str).toBe(25);
    expect(barbarian.abilities.con).toBe(22);
    expect(barbarian.proficiencyBonus).toBe(6);
    expect(barbarian.initialResources?.rage).toBe(6);
    expect(barbarian.initialResources?.['intimidating-presence']).toBe(1);
    expect(barbarian.actions.find(a => a.name === 'Rage')?.buff?.rageDamageBonus).toBe(4);
    expect(barbarian.actions.find(a => a.name === 'Intimidating Presence')?.savingThrow?.dc).toBe(21);
  });
});

describe('Barbarian save features', () => {
  it('Danger Sense gives advantage on Dexterity saves', () => {
    const barbarian = createCreatureWithFixedHp(buildHero('Barbarian', 7), 'blue', { x: 1, y: 1 }, 0);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.95);

    const save = rollSaveWithBuffs(barbarian, 2, false, 15, 'dex');

    expect(save.total).toBeGreaterThanOrEqual(15);
    expect(save.rolls).toHaveLength(2);
  });

  it('Indomitable Might floors Strength saves at the Barbarian strength score', () => {
    const barbarian = createCreatureWithFixedHp(buildHero('Barbarian', 18), 'blue', { x: 1, y: 1 }, 0);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const save = rollSaveWithBuffs(barbarian, 0, false, 30, 'str');

    expect(save.total).toBe(barbarian.monsterData.abilities.str);
  });
});

describe('Barbarian rage features', () => {
  it('Relentless Rage keeps a raging Barbarian up at twice Barbarian level HP', () => {
    const barbarian = createCreatureWithFixedHp(buildHero('Barbarian', 11), 'blue', { x: 1, y: 1 }, 0);
    const attacker = createCreatureWithFixedHp(makeTarget(), 'red', { x: 2, y: 1 }, 0);
    barbarian.currentHp = 5;
    barbarian.activeBuffs.push(rageBuff(barbarian, 3));
    const state = stateWith([barbarian, attacker]);
    vi.spyOn(Math, 'random').mockReturnValue(0.95);

    applyDamage(state, barbarian, 40, 'fire', attacker, true, true);

    expect(barbarian.currentHp).toBe(22);
    expect(barbarian.dying).toBeUndefined();
    expect(state.logs.some(log => log.action === 'Relentless Rage')).toBe(true);
    expect(barbarian.resources['relentless-rage-dc']).toBe(15);
  });

  it('Mindless Rage blocks frightened while Rage is active', () => {
    const barbarian = createCreatureWithFixedHp(buildHero('Barbarian', 6), 'blue', { x: 1, y: 1 }, 0);
    const source = createCreatureWithFixedHp(makeTarget(), 'red', { x: 2, y: 1 }, 0);
    barbarian.activeBuffs.push(rageBuff(barbarian, 2));
    const state = stateWith([barbarian, source]);

    const applied = applyCondition(state, barbarian, 'frightened', source, '1_minute');

    expect(applied).toBe(false);
    expect(barbarian.conditions).not.toContain('frightened');
    expect(state.logs.some(log => log.action === 'Mindless Rage')).toBe(true);
  });

  it('Feral Instinct rolls initiative with advantage', () => {
    const barbarian = createCreatureWithFixedHp(buildHero('Barbarian', 7), 'blue', { x: 1, y: 1 }, 0);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.95);

    rollAllInitiatives([barbarian]);

    expect(barbarian.initiative).toBeGreaterThanOrEqual(20);
  });
});

describe('Barbarian high-level offense', () => {
  it('Improved Brutal Strike uses 2d10 damage and two riders at level 17', () => {
    const barbarian = createCreatureWithFixedHp(buildHero('Barbarian', 17), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ name: 'Ally' }), 'blue', { x: 1, y: 2 }, 1);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 2, y: 1 }, 0);
    const state = stateWith([barbarian, ally, target]);
    const greataxe = barbarian.monsterData.actions.find(a => a.name === 'Greataxe')!;
    barbarian.turnFlags.brutalStrike = true;
    vi.spyOn(Math, 'random').mockReturnValue(0.95);

    resolveAttack(state, barbarian, target, greataxe);

    expect(barbarian.turnFlags.brutalStrike).toBe(false);
    expect(barbarian.stats.actionUsage['Brutal Strike']).toBe(1);
    expect(target.activeBuffs.some(b => b.name === 'Sundering Blow' && b.attackBonusForAllAttackers === 5)).toBe(true);
    expect(target.activeBuffs.some(b => b.name === 'Hamstring Blow' && b.speedPenalty === 15)).toBe(true);
  });

  it('Boon of Irresistible Offense ignores physical resistance but not immunity', () => {
    const barbarian18 = createCreatureWithFixedHp(buildHero('Barbarian', 18), 'blue', { x: 1, y: 1 }, 0);
    const barbarian19 = createCreatureWithFixedHp(buildHero('Barbarian', 19), 'blue', { x: 1, y: 2 }, 1);
    const resistant = createCreatureWithFixedHp(makeTarget({ resistances: ['slashing'] }), 'red', { x: 2, y: 1 }, 0);
    const ignored = createCreatureWithFixedHp(makeTarget({ resistances: ['slashing'] }), 'red', { x: 2, y: 2 }, 1);
    const immune = createCreatureWithFixedHp(makeTarget({ immunities: ['slashing'] }), 'red', { x: 2, y: 3 }, 2);

    applyDamage(stateWith([barbarian18, resistant]), resistant, 20, 'slashing', barbarian18, true, false);
    applyDamage(stateWith([barbarian19, ignored]), ignored, 20, 'slashing', barbarian19, true, false);
    applyDamage(stateWith([barbarian19, immune]), immune, 20, 'slashing', barbarian19, true, false);

    expect(resistant.currentHp).toBe(90);
    expect(ignored.currentHp).toBe(80);
    expect(immune.currentHp).toBe(100);
  });
});
