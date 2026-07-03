import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { Creature, MonsterData } from '../src/types/monster';
import {
  applyCondition,
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  executeSpell,
  rollAllInitiatives,
  type BattleState,
} from '../src/engine/combat';
import { trySpellcast } from '../src/engine/ai-spellcasting';

function makeTarget(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Training Target',
    size: 'Medium',
    type: 'Humanoid',
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

function shapedDruid(level: number): Creature {
  const druid = createCreatureWithFixedHp(buildHero('Druid', level), 'blue', { x: 1, y: 1 }, 0);
  druid.wildShape = {
    beastName: 'Wolf',
    tempHp: level,
    maxTempHp: level,
    formHp: 11,
    cr: '1/4',
    ac: 13,
    speed: { walk: 40 },
    actions: [],
    size: 'Medium',
    abilities: { str: 12, dex: 15, con: 12 },
    isMoon: false,
  };
  return druid;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Druid level 11-20 build data', () => {
  it('unlocks Druid through level 20 without unlocking the next unfinished class', () => {
    expect(getMaxHeroLevelForClass('Druid')).toBe(20);
    expect(getMaxHeroLevelForClass('Fighter')).toBe(20);
    expect(getMaxHeroLevelForClass('Monk')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Druid', 20)).not.toThrow();
    expect(() => buildHero('Fighter', 20)).not.toThrow();
    expect(() => buildHero('Monk', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed level-20 Circle of the Land loadout, slots, and resources', () => {
    const druid = buildHero('Druid', 20);

    expect(druid.heroSubclass).toBe('Circle of the Land');
    expect(druid.abilities.wis).toBe(21);
    expect(druid.abilities.con).toBe(19);
    expect(druid.proficiencyBonus).toBe(6);
    expect(druid.initialResources?.['wild-shape']).toBe(4);
    expect(druid.initialResources?.['natural-recovery']).toBe(1);
    expect(druid.initialResources?.['slot-9']).toBe(1);
    expect(druid.initialResources?.['slot-7']).toBe(2);
    expect(druid.actions.some(a => a.name === "Land's Aid")).toBe(true);
    expect(druid.actions.some(a => a.name === "Nature's Sanctuary")).toBe(true);
    expect(druid.actions.some(a => a.name === 'Heal')).toBe(true);
    expect(druid.actions.some(a => a.name === 'Fire Storm')).toBe(true);
    expect(druid.actions.some(a => a.name === 'Sunburst')).toBe(true);
    expect(druid.actions.some(a => a.name === 'Storm of Vengeance')).toBe(true);
  });

  it('Potent Spellcasting adds Wisdom to Druid cantrip damage from level 7', () => {
    const l6 = buildHero('Druid', 6).actions.find(a => a.name === 'Produce Flame')!;
    const l7 = buildHero('Druid', 7).actions.find(a => a.name === 'Produce Flame')!;

    expect(l6.damage).toBe('2d8');
    expect(l7.damage).toBe('2d8+4');
  });

  it('Nature\'s Ward gives the Polar Land Druid cold resistance and poisoned immunity', () => {
    const l9 = buildHero('Druid', 9);
    const l10 = buildHero('Druid', 10);

    expect(l9.resistances).toBeUndefined();
    expect(l10.resistances).toContain('cold');
    expect(l10.conditionImmunities).toContain('poisoned');
  });
});

describe('Circle of the Land combat features', () => {
  it('Land\'s Aid spends Wild Shape, damages enemies, and heals a wounded ally', () => {
    const druid = createCreatureWithFixedHp(buildHero('Druid', 14), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ hp: 80 }), 'blue', { x: 2, y: 1 }, 1);
    const enemy = createCreatureWithFixedHp(makeTarget({ hp: 80 }), 'red', { x: 4, y: 1 }, 2);
    ally.currentHp = 10;
    const state = stateWith([druid, ally, enemy]);
    const landAid = druid.monsterData.actions.find(a => a.name === "Land's Aid")!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    executeSpell(state, druid, landAid, enemy, [enemy], enemy.position);

    expect(druid.resources['wild-shape']).toBe(3);
    expect(enemy.currentHp).toBeLessThan(enemy.maxHp);
    expect(ally.currentHp).toBeGreaterThan(10);
    expect(state.logs.some(l => l.action === "Land's Aid Heal")).toBe(true);
  });

  it('Natural Recovery casts the selected Polar circle spell without spending a slot', () => {
    const druid = createCreatureWithFixedHp(buildHero('Druid', 9), 'blue', { x: 1, y: 1 }, 0);
    const enemy = createCreatureWithFixedHp(makeTarget({ hp: 80 }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([druid, enemy]);
    const naturalRecovery = druid.monsterData.actions.find(a => a.name === 'Natural Recovery: Cone of Cold')!;
    const slotBefore = druid.resources['slot-5'];

    executeSpell(state, druid, naturalRecovery, enemy, [enemy], enemy.position);

    expect(druid.resources['natural-recovery']).toBe(0);
    expect(druid.resources['slot-5']).toBe(slotBefore);
    expect(enemy.currentHp).toBeLessThan(enemy.maxHp);
  });

  it('Nature\'s Sanctuary spends Wild Shape and gives nearby allies half-cover AC', () => {
    const druid = createCreatureWithFixedHp(buildHero('Druid', 14), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ hp: 80 }), 'blue', { x: 2, y: 1 }, 1);
    const state = stateWith([druid, ally]);
    const sanctuary = druid.monsterData.actions.find(a => a.name === "Nature's Sanctuary")!;

    executeSpell(state, druid, sanctuary, ally);

    expect(druid.resources['wild-shape']).toBe(3);
    expect(ally.activeBuffs.some(b => b.key === 'natures-sanctuary' && b.acBonus === 2)).toBe(true);
  });
});

describe('High-level Druid features', () => {
  it('Beast Spells allows a level-18 Druid to cast while Wild Shaped', () => {
    const druid = shapedDruid(18);
    const enemy = createCreatureWithFixedHp(makeTarget({ hp: 80 }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([druid, enemy]);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const cast = trySpellcast(state, druid);

    expect(cast).toBe(true);
    expect(Object.keys(druid.stats.actionUsage).some(name => name !== 'Wild Shape')).toBe(true);
  });

  it('level-17 Druids still cannot cast while Wild Shaped', () => {
    const druid = shapedDruid(17);
    const enemy = createCreatureWithFixedHp(makeTarget({ hp: 80 }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([druid, enemy]);

    const cast = trySpellcast(state, druid);

    expect(cast).toBe(false);
    expect(druid.stats.actionUsage).toEqual({});
  });

  it('Archdruid restores one Wild Shape use on initiative if empty', () => {
    const druid = createCreatureWithFixedHp(buildHero('Druid', 20), 'blue', { x: 1, y: 1 }, 0);
    druid.resources['wild-shape'] = 0;

    rollAllInitiatives([druid]);

    expect(druid.resources['wild-shape']).toBe(1);
  });

  it('Nature\'s Ward blocks the poisoned condition', () => {
    const druid = createCreatureWithFixedHp(buildHero('Druid', 10), 'blue', { x: 1, y: 1 }, 0);
    const enemy = createCreatureWithFixedHp(makeTarget(), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([druid, enemy]);

    const applied = applyCondition(state, druid, 'poisoned', enemy, '1_minute');

    expect(applied).toBe(false);
    expect(druid.conditions).not.toContain('poisoned');
  });
});
