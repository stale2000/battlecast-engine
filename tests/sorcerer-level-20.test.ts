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

describe('Sorcerer level 11-20 build data', () => {
  it('unlocks Sorcerer through level 20 without unlocking the next unfinished class', () => {
    expect(getMaxHeroLevelForClass('Sorcerer')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Sorcerer', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed level-20 Draconic Sorcerer loadout', () => {
    const sorcerer = buildHero('Sorcerer', 20);

    expect(sorcerer.heroSubclass).toBe('Draconic Sorcery');
    expect(sorcerer.abilities).toMatchObject({
      str: 8,
      dex: 15,
      con: 18,
      int: 10,
      wis: 12,
      cha: 21,
    });
    expect(sorcerer.ac).toBe(17);
    expect(sorcerer.hp).toBe(182);
    expect(sorcerer.speed).toMatchObject({ walk: 30, fly: 60 });
    expect(sorcerer.saves).toMatchObject({ con: 10, cha: 11 });
    expect(sorcerer.resistances).toContain('fire');
    expect(sorcerer.initialResources).toMatchObject({
      'innate-sorcery': 2,
      sorcery: 20,
      'slot-7': 2,
      'slot-8': 1,
      'slot-9': 1,
    });
    expect(sorcerer.actions.find(a => a.name === 'Fire Bolt')).toMatchObject({
      attackBonus: 11,
      damage: '4d10',
      spellLevel: 0,
    });
    expect(sorcerer.actions.some(a => a.name === 'Sorcery Incarnate')).toBe(true);
    expect(sorcerer.actions.some(a => a.name === 'Fire Storm')).toBe(true);
    expect(sorcerer.actions.some(a => a.name === 'Sunburst')).toBe(true);
    expect(sorcerer.actions.some(a => a.name === 'Meteor Swarm')).toBe(true);
    expect(sorcerer.actions.some(a => a.name === 'Power Word Kill')).toBe(true);
    expect(sorcerer.traits?.some(t => t.name.includes('Arcane Apotheosis'))).toBe(true);
  });

  it('adds Draconic Resilience HP and unarmored AC from level 3', () => {
    const level2 = buildHero('Sorcerer', 2);
    const level3 = buildHero('Sorcerer', 3);

    expect(level2.heroSubclass).toBeUndefined();
    expect(level2.ac).toBe(12);
    expect(level2.hp).toBe(14);
    expect(level3.heroSubclass).toBe('Draconic Sorcery');
    expect(level3.ac).toBe(15);
    expect(level3.hp).toBe(23);
  });

  it('scales Sorcery Points and high-level full-caster slots', () => {
    expect(buildHero('Sorcerer', 11).initialResources).toMatchObject({ sorcery: 11, 'slot-6': 1 });
    expect(buildHero('Sorcerer', 13).initialResources).toMatchObject({ sorcery: 13, 'slot-7': 1 });
    expect(buildHero('Sorcerer', 15).initialResources).toMatchObject({ sorcery: 15, 'slot-8': 1 });
    expect(buildHero('Sorcerer', 17).initialResources).toMatchObject({ sorcery: 17, 'slot-9': 1 });
    expect(buildHero('Sorcerer', 20).initialResources).toMatchObject({ sorcery: 20, 'slot-7': 2 });
  });
});

describe('Sorcerer metamagic and Draconic Sorcery features', () => {
  it('uses Sorcery Incarnate to activate Innate Sorcery from Sorcery Points', () => {
    const sorcerer = createCreatureWithFixedHp(buildHero('Sorcerer', 7), 'blue', { x: 1, y: 1 }, 0);
    sorcerer.resources['innate-sorcery'] = 0;
    const state = stateWith([sorcerer]);
    const incarnate = sorcerer.monsterData.actions.find(action => action.name === 'Sorcery Incarnate')!;

    expect(executeSpell(state, sorcerer, incarnate, sorcerer)).toBe(true);

    expect(sorcerer.resources.sorcery).toBe(5);
    expect(sorcerer.activeBuffs.some(buff => buff.key === 'innate-sorcery')).toBe(true);
    expect(sorcerer.stats.actionUsage['Sorcery Incarnate']).toBe(1);
  });

  it('spends a Sorcery Point on Seeking Spell to reroll a missed spell attack', () => {
    const sorcerer = createCreatureWithFixedHp(buildHero('Sorcerer', 5), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 15 }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([sorcerer, target]);
    const fireBolt = sorcerer.monsterData.actions.find(action => action.name === 'Fire Bolt')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0);

    resolveAttack(state, sorcerer, target, fireBolt);

    expect(sorcerer.resources.sorcery).toBe(4);
    expect(sorcerer.stats.actionUsage['Seeking Spell']).toBe(1);
    expect(sorcerer.stats.attacksHit).toBe(1);
    expect(state.logs.some(log => log.action === 'Seeking Spell')).toBe(true);
  });

  it('uses Arcane Apotheosis for a free Seeking Spell while Innate Sorcery is active', () => {
    const sorcerer = createCreatureWithFixedHp(buildHero('Sorcerer', 20), 'blue', { x: 1, y: 1 }, 0);
    sorcerer.resources.sorcery = 0;
    sorcerer.activeBuffs.push({
      name: 'Innate Sorcery',
      key: 'innate-sorcery',
      casterId: sorcerer.id,
      appliedRound: 1,
      endRound: 10,
      spellAttackAdvantage: true,
      spellSaveDcBonus: 1,
    });
    const target = createCreatureWithFixedHp(makeTarget({ ac: 30 }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([sorcerer, target]);
    const fireBolt = sorcerer.monsterData.actions.find(action => action.name === 'Fire Bolt')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0.99);

    resolveAttack(state, sorcerer, target, fireBolt);

    expect(sorcerer.resources.sorcery).toBe(0);
    expect(sorcerer.turnFlags['arcane-apotheosis-metamagic-used']).toBe(true);
    expect(sorcerer.stats.actionUsage['Arcane Apotheosis']).toBe(1);
    expect(sorcerer.stats.actionUsage['Seeking Spell']).toBe(1);
    expect(sorcerer.stats.attacksHit).toBe(1);
    expect(state.logs.some(log => log.action === 'Seeking Spell' && log.details.includes('Arcane Apotheosis'))).toBe(true);
  });

  it('adds Elemental Affinity damage to fire spell attacks', () => {
    const sorcerer = createCreatureWithFixedHp(buildHero('Sorcerer', 6), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 1 }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([sorcerer, target]);
    const fireBolt = sorcerer.monsterData.actions.find(action => action.name === 'Fire Bolt')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5);

    resolveAttack(state, sorcerer, target, fireBolt);

    expect(target.currentHp).toBe(114);
    expect(sorcerer.stats.actionUsage['Elemental Affinity']).toBe(1);
    expect(state.logs.some(log => log.action === 'Elemental Affinity' && log.damage === 4)).toBe(true);
  });

  it('adds Elemental Affinity damage to failed-save fire AoE spells', () => {
    const sorcerer = createCreatureWithFixedHp(buildHero('Sorcerer', 6), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([sorcerer, target]);
    const fireball = sorcerer.monsterData.actions.find(action => action.name === 'Fireball')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(executeSpell(state, sorcerer, fireball, target, [target], target.position)).toBe(true);

    expect(target.currentHp).toBe(108);
    expect(sorcerer.resources['slot-3']).toBe((sorcerer.monsterData.initialResources?.['slot-3'] ?? 0) - 1);
    expect(sorcerer.stats.actionUsage.Fireball).toBe(1);
    expect(sorcerer.stats.actionUsage['Elemental Affinity']).toBe(1);
    expect(state.logs.some(log => log.action === 'Elemental Affinity' && log.damage === 4)).toBe(true);
  });
});
