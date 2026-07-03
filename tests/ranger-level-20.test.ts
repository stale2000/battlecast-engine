import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { Creature, MonsterData } from '../src/types/monster';
import {
  applyDamage,
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  executeSpell,
  initBattle,
  resolveAttack,
  type BattleState,
} from '../src/engine/combat';
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

function stateWith(creatures: Creature[], gridSize = 20): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize,
    teamTactics: DEFAULT_TACTICS,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Ranger level 11-20 build data', () => {
  it('unlocks Ranger through level 20 without unlocking the next unfinished class', () => {
    expect(getMaxHeroLevelForClass('Ranger')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Ranger', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed level-20 Hunter loadout', () => {
    const ranger = buildHero('Ranger', 20);

    expect(ranger.heroSubclass).toBe('Hunter');
    expect(ranger.abilities.dex).toBe(20);
    expect(ranger.abilities.wis).toBe(20);
    expect(ranger.ac).toBe(16);
    expect(ranger.hp).toBe(164);
    expect(ranger.speed).toMatchObject({ walk: 40, climb: 40, swim: 40 });
    expect(ranger.senses).toContain('Blindsight 30 ft.');
    expect(ranger.initialResources).toMatchObject({
      'favored-enemy': 6,
      tireless: 5,
      'natures-veil': 5,
      'slot-5': 2,
    });
    expect(ranger.actions.some(a => a.name === 'Tireless')).toBe(true);
    expect(ranger.actions.some(a => a.name === "Nature's Veil")).toBe(true);
    expect(ranger.actions.some(a => a.name === 'Stoneskin')).toBe(true);
    expect(ranger.actions.find(a => a.name === "Hunter's Mark")?.buff?.damageRider).toBe('1d10 force');
  });

  it('scales Favored Enemy and half-caster slots by the Ranger table', () => {
    expect(buildHero('Ranger', 1).initialResources).toMatchObject({ 'favored-enemy': 2, 'slot-1': 2 });
    expect(buildHero('Ranger', 5).initialResources).toMatchObject({ 'favored-enemy': 3, 'slot-2': 2 });
    expect(buildHero('Ranger', 9).initialResources).toMatchObject({ 'favored-enemy': 4, 'slot-3': 2 });
    expect(buildHero('Ranger', 13).initialResources).toMatchObject({ 'favored-enemy': 5, 'slot-4': 1 });
    expect(buildHero('Ranger', 17).initialResources).toMatchObject({ 'favored-enemy': 6, 'slot-5': 1 });
    expect(buildHero('Ranger', 20).initialResources).toMatchObject({ 'favored-enemy': 6, 'slot-5': 2 });
  });
});

describe('Ranger defensive features', () => {
  it('Tireless grants temporary HP that absorbs damage before real HP', () => {
    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 10), 'blue', { x: 1, y: 1 }, 0);
    const attacker = createCreatureWithFixedHp(makeTarget(), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([ranger, attacker]);
    ranger.currentHp -= 30;
    const tireless = ranger.monsterData.actions.find(a => a.name === 'Tireless')!;
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    expect(executeSpell(state, ranger, tireless, ranger)).toBe(true);
    expect(ranger.temporaryHp).toBe(10);
    expect(ranger.resources.tireless).toBe(1);

    applyDamage(state, ranger, 8, 'slashing', attacker, true, false);

    expect(ranger.temporaryHp).toBe(2);
    expect(ranger.currentHp).toBe(ranger.maxHp - 30);
    expect(state.logs.some(log => log.action === 'Temporary HP')).toBe(true);
  });

  it('Relentless Hunter preserves Hunter\'s Mark after a failed concentration save', () => {
    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 13), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 8, y: 1 }, 1);
    const attacker = createCreatureWithFixedHp(makeTarget(), 'red', { x: 2, y: 1 }, 2);
    const state = stateWith([ranger, target, attacker]);
    const mark = ranger.monsterData.actions.find(a => a.name === "Hunter's Mark")!;

    expect(executeSpell(state, ranger, mark, target)).toBe(true);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    applyDamage(state, ranger, 22, 'slashing', attacker, true, false);

    expect(target.activeBuffs.some(b => b.key === 'hunters-mark' && b.casterId === ranger.id)).toBe(true);
    expect(ranger.concentratingOn).toBe('hunters-mark');
    expect(state.logs.some(log => log.action === 'Relentless Hunter')).toBe(true);
  });

  it('lower-level Rangers still lose Hunter\'s Mark on a failed concentration save', () => {
    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 12), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 8, y: 1 }, 1);
    const attacker = createCreatureWithFixedHp(makeTarget(), 'red', { x: 2, y: 1 }, 2);
    const state = stateWith([ranger, target, attacker]);
    const mark = ranger.monsterData.actions.find(a => a.name === "Hunter's Mark")!;

    expect(executeSpell(state, ranger, mark, target)).toBe(true);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    applyDamage(state, ranger, 22, 'slashing', attacker, true, false);

    expect(target.activeBuffs.some(b => b.key === 'hunters-mark' && b.casterId === ranger.id)).toBe(false);
    expect(ranger.concentratingOn).toBeUndefined();
    expect(state.logs.some(log => log.action === 'Concentration Broken')).toBe(true);
  });

  it('Superior Hunter\'s Defense resists the triggering damage type for the current turn', () => {
    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 15), 'blue', { x: 1, y: 1 }, 0);
    const attacker = createCreatureWithFixedHp(makeTarget(), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([ranger, attacker]);

    applyDamage(state, ranger, 20, 'fire', attacker, false, true);
    applyDamage(state, ranger, 10, 'fire', attacker, false, true);

    expect(ranger.currentHp).toBe(ranger.maxHp - 15);
    expect(ranger.reactionUsed).toBe(true);
    expect(ranger.stats.actionUsage["Superior Hunter's Defense"]).toBe(1);
    expect(state.logs.filter(log => log.action === "Superior Hunter's Defense")).toHaveLength(2);
  });

  it('Escape the Horde gives opportunity attacks against the Hunter disadvantage', () => {
    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 7), 'blue', { x: 1, y: 1 }, 0);
    const attacker = createCreatureWithFixedHp(makeTarget({ ac: 10 }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([ranger, attacker]);
    const slam = attacker.monsterData.actions.find(a => a.name === 'Slam')!;
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0);

    resolveAttack(state, attacker, ranger, slam, { cause: 'opportunity' });

    expect(attacker.stats.attacksMade).toBe(1);
    expect(attacker.stats.attacksHit).toBe(0);
    expect(state.logs.some(log => log.type === 'miss' && log.action === 'Slam')).toBe(true);
  });
});

describe('Ranger offensive Hunter features', () => {
  it('Colossus Slayer adds once-per-turn weapon damage against an already wounded target', () => {
    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 3), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 8, y: 1 }, 1);
    const state = stateWith([ranger, target]);
    target.currentHp = target.maxHp - 5;
    const longbow = ranger.monsterData.actions.find(a => a.name === 'Longbow')!;
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    resolveAttack(state, ranger, target, longbow);
    resolveAttack(state, ranger, target, longbow);

    expect(ranger.stats.actionUsage['Colossus Slayer']).toBe(1);
    expect(state.logs.filter(log => log.action === 'Colossus Slayer')).toHaveLength(1);
  });

  it('Superior Hunter\'s Prey splashes Hunter\'s Mark damage to a nearby second enemy', () => {
    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 11), 'blue', { x: 1, y: 1 }, 0);
    const marked = createCreatureWithFixedHp(makeTarget(), 'red', { x: 8, y: 1 }, 1);
    const secondary = createCreatureWithFixedHp(makeTarget(), 'red', { x: 9, y: 1 }, 2);
    const state = stateWith([ranger, marked, secondary]);
    const mark = ranger.monsterData.actions.find(a => a.name === "Hunter's Mark")!;
    const longbow = ranger.monsterData.actions.find(a => a.name === 'Longbow')!;

    expect(executeSpell(state, ranger, mark, marked)).toBe(true);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    resolveAttack(state, ranger, marked, longbow);

    expect(secondary.currentHp).toBeLessThan(secondary.maxHp);
    expect(ranger.stats.actionUsage["Superior Hunter's Prey"]).toBe(1);
    expect(state.logs.some(log => log.action === "Superior Hunter's Prey")).toBe(true);
  });

  it('Precise Hunter grants advantage against the Ranger\'s marked target', () => {
    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 17), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 25 }), 'red', { x: 8, y: 1 }, 1);
    const state = stateWith([ranger, target]);
    const mark = ranger.monsterData.actions.find(a => a.name === "Hunter's Mark")!;
    const longbow = ranger.monsterData.actions.find(a => a.name === 'Longbow')!;

    expect(executeSpell(state, ranger, mark, target)).toBe(true);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99)
      .mockReturnValue(0.99);
    resolveAttack(state, ranger, target, longbow);

    expect(ranger.stats.attacksHit).toBe(1);
  });

  it('Nature\'s Veil is used as a bonus action before attacking when Hunter\'s Mark is already active', () => {
    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 14), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 21, y: 1 }, 1);
    const state = initBattle([ranger, target], 30);
    state.teamTactics = DEFAULT_TACTICS;
    target.activeBuffs.push({
      name: "Hunter's Mark",
      key: 'hunters-mark',
      casterId: ranger.id,
      appliedRound: state.round,
      endRound: state.round + 30,
      requiresConcentration: true,
      damageRider: '1d6 force',
    });
    ranger.concentratingOn = 'hunters-mark';
    state.turnIndex = state.initiativeOrder.indexOf(ranger.id);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    executeTurn(state, ranger);

    expect(ranger.conditions).toContain('invisible');
    expect(ranger.resources['natures-veil']).toBe(2);
    expect(ranger.stats.actionUsage["Nature's Veil"]).toBe(1);
    expect(state.logs.some(log => log.action === "Nature's Veil")).toBe(true);
  });
});
