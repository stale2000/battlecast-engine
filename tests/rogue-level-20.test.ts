import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { Creature, MonsterData } from '../src/types/monster';
import {
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  getInitiativeOrder,
  resolveAttack,
  type BattleState,
} from '../src/engine/combat';
import { executeRound } from '../src/engine/ai';
import { executeTurn } from '../src/engine/ai-turn';

function makeTarget(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Training Target',
    size: 'Medium',
    type: 'Construct',
    alignment: 'Unaligned',
    ac: 10,
    hp: 120,
    hpFormula: '120',
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

describe('Rogue level 11-20 build data', () => {
  it('unlocks Rogue through level 20 without unlocking the next unfinished class', () => {
    expect(getMaxHeroLevelForClass('Rogue')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Rogue', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed level-20 Thief loadout', () => {
    const rogue = buildHero('Rogue', 20);

    expect(rogue.heroSubclass).toBe('Thief');
    expect(rogue.abilities.dex).toBe(20);
    expect(rogue.abilities.con).toBe(20);
    expect(rogue.abilities.wis).toBe(16);
    expect(rogue.ac).toBe(17);
    expect(rogue.hp).toBe(203);
    expect(rogue.speed).toMatchObject({ walk: 30, climb: 30 });
    expect(rogue.saves).toMatchObject({
      dex: 11,
      int: 7,
      wis: 9,
      cha: 5,
    });
    expect(rogue.initialResources).toMatchObject({ 'stroke-of-luck': 1 });
    expect(rogue.actions.find(a => a.name === 'Rapier')?.additionalDamage).toBe('10d6 piercing');
    expect(rogue.traits?.some(t => t.name.includes('Elusive'))).toBe(true);
    expect(rogue.traits?.some(t => t.name.includes('Stroke of Luck'))).toBe(true);
  });

  it('scales Sneak Attack dice through the high-level table', () => {
    expect(buildHero('Rogue', 11).actions.find(a => a.name === 'Rapier')?.additionalDamage).toBe('6d6 piercing');
    expect(buildHero('Rogue', 13).actions.find(a => a.name === 'Rapier')?.additionalDamage).toBe('7d6 piercing');
    expect(buildHero('Rogue', 15).actions.find(a => a.name === 'Rapier')?.additionalDamage).toBe('8d6 piercing');
    expect(buildHero('Rogue', 17).actions.find(a => a.name === 'Rapier')?.additionalDamage).toBe('9d6 piercing');
    expect(buildHero('Rogue', 19).actions.find(a => a.name === 'Rapier')?.additionalDamage).toBe('10d6 piercing');
  });
});

describe('Rogue tactical features', () => {
  it('uses Steady Aim when holding position with a legal ranged attack', () => {
    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 3), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 15 }), 'red', { x: 9, y: 1 }, 1);
    const state = stateWith([rogue, target]);
    state.teamTactics = { ...DEFAULT_TACTICS, blue: 'defensive' };
    vi.spyOn(Math, 'random')
      .mockReturnValue(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99);

    executeTurn(state, rogue);

    expect(rogue.bonusActionUsed).toBe(true);
    expect(rogue.turnFlags.steadyAim).toBe(true);
    expect(rogue.stats.actionUsage['Steady Aim']).toBe(1);
    expect(rogue.stats.attacksHit).toBe(1);
    expect(state.logs.some(log => log.action === 'Steady Aim')).toBe(true);
  });

  it('uses Cunning Strike: Trip by forgoing one Sneak Attack die', () => {
    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 5), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 1, hp: 120 }), 'red', { x: 2, y: 1 }, 1);
    target.activeBuffs.push({
      name: 'Test Advantage',
      key: 'test-advantage',
      casterId: rogue.id,
      appliedRound: 1,
      endRound: 2,
      advantageForAttackerId: rogue.id,
    });
    const state = stateWith([rogue, target]);
    const rapier = rogue.monsterData.actions.find(action => action.name === 'Rapier')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5);

    resolveAttack(state, rogue, target, rapier);

    expect(target.conditions).toContain('prone');
    expect(rogue.stats.actionUsage['Cunning Strike: Trip']).toBe(1);
    expect(state.logs.some(log => log.action === 'Cunning Strike: Trip')).toBe(true);
  });

  it('uses Cunning Strike: Poison when Trip is not legal', () => {
    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 5), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 1, hp: 120, size: 'Huge' }), 'red', { x: 2, y: 1 }, 1);
    target.activeBuffs.push({
      name: 'Test Advantage',
      key: 'test-advantage',
      casterId: rogue.id,
      appliedRound: 1,
      endRound: 2,
      advantageForAttackerId: rogue.id,
    });
    const state = stateWith([rogue, target]);
    const rapier = rogue.monsterData.actions.find(action => action.name === 'Rapier')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5);

    resolveAttack(state, rogue, target, rapier);

    expect(target.conditions).toContain('poisoned');
    expect(rogue.stats.actionUsage['Cunning Strike: Poison']).toBe(1);
  });

  it('uses high-level Cunning Strike: Obscure and a second effect when legal', () => {
    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 14), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 1, hp: 200 }), 'red', { x: 2, y: 1 }, 1);
    target.activeBuffs.push({
      name: 'Test Advantage',
      key: 'test-advantage',
      casterId: rogue.id,
      appliedRound: 1,
      endRound: 2,
      advantageForAttackerId: rogue.id,
    });
    const state = stateWith([rogue, target]);
    const rapier = rogue.monsterData.actions.find(action => action.name === 'Rapier')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5);

    resolveAttack(state, rogue, target, rapier);

    expect(target.conditions).toContain('blinded');
    expect(target.conditions).toContain('prone');
    expect(rogue.stats.actionUsage['Cunning Strike: Obscure']).toBe(1);
    expect(rogue.stats.actionUsage['Cunning Strike: Trip']).toBe(1);
  });

  it('Elusive blocks attack Advantage against a non-incapacitated Rogue', () => {
    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 18), 'blue', { x: 2, y: 1 }, 0);
    const attacker = createCreatureWithFixedHp(makeTarget({ ac: 10 }), 'red', { x: 1, y: 1 }, 1);
    rogue.conditions.push('prone');
    const state = stateWith([rogue, attacker]);
    const slam = attacker.monsterData.actions.find(action => action.name === 'Slam')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99);

    resolveAttack(state, attacker, rogue, slam);

    expect(attacker.stats.attacksHit).toBe(0);
    expect(state.logs.some(log => log.type === 'miss' && log.action === 'Slam')).toBe(true);
  });

  it('Stroke of Luck turns one missed Rogue attack into a 20', () => {
    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 20), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 30, hp: 200 }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([rogue, target]);
    const rapier = rogue.monsterData.actions.find(action => action.name === 'Rapier')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    resolveAttack(state, rogue, target, rapier);

    expect(rogue.resources['stroke-of-luck']).toBe(0);
    expect(rogue.stats.attacksHit).toBe(1);
    expect(rogue.stats.actionUsage['Stroke of Luck']).toBe(1);
    expect(state.logs.some(log => log.action === 'Stroke of Luck')).toBe(true);
  });

  it('Thief Reflexes grants a second first-round turn but not a second later-round turn', () => {
    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 17), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 999, actions: [] }), 'red', { x: 9, y: 1 }, 1);
    rogue.initiative = 20;
    target.initiative = 15;
    const state = stateWith([rogue, target]);
    state.initiativeOrder = getInitiativeOrder(state.creatures);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(state.initiativeOrder).toEqual([rogue.id, target.id, rogue.id]);

    executeRound(state);
    expect(state.events.filter(event => event.kind === 'turnStart' && event.creatureId === rogue.id)).toHaveLength(2);

    executeRound(state);
    expect(state.events.filter(event => event.kind === 'turnStart' && event.creatureId === rogue.id)).toHaveLength(3);
  });
});
