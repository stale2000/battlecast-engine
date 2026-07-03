import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { Creature, MonsterAction, MonsterData } from '../src/types/monster';
import {
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  executeSpell,
  resolveAttack,
  resolveSingleTargetSave,
  rollAllInitiatives,
  type BattleState,
} from '../src/engine/combat';

function makeTarget(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Training Target',
    size: 'Medium',
    type: 'Humanoid',
    alignment: 'Unaligned',
    ac: 10,
    hp: 80,
    hpFormula: '80',
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

describe('Bard level 11-20 build data', () => {
  it('unlocks Bard through level 20 without unlocking unfinished classes', () => {
    expect(getMaxHeroLevelForClass('Bard')).toBe(20);
    expect(getMaxHeroLevelForClass('Cleric')).toBe(20);
    expect(getMaxHeroLevelForClass('Druid')).toBe(20);
    expect(getMaxHeroLevelForClass('Fighter')).toBe(20);
    expect(getMaxHeroLevelForClass('Monk')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Bard', 20)).not.toThrow();
    expect(() => buildHero('Cleric', 20)).not.toThrow();
    expect(() => buildHero('Druid', 20)).not.toThrow();
    expect(() => buildHero('Fighter', 20)).not.toThrow();
    expect(() => buildHero('Monk', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed Bard level-20 loadout, slots, and d12 inspiration', () => {
    const bard = buildHero('Bard', 20);

    expect(bard.abilities.cha).toBe(21);
    expect(bard.abilities.dex).toBe(17);
    expect(bard.abilities.con).toBe(16);
    expect(bard.proficiencyBonus).toBe(6);
    expect(bard.initialResources?.['bardic-inspiration']).toBe(5);
    expect(bard.initialResources?.['slot-9']).toBe(1);
    expect(bard.initialResources?.['slot-7']).toBe(2);
    expect(bard.actions.find(a => a.name === 'Bardic Inspiration')?.buff?.attackBonusDice).toBe('1d12');
    expect(bard.actions.some(a => a.name === 'Befuddlement')).toBe(true);
    expect(bard.actions.some(a => a.name === 'Power Word Kill')).toBe(true);
    expect(bard.actions.some(a => a.name === 'Power Word Heal')).toBe(true);
  });

  it('uses Lore Magical Discoveries to add Fireball from level 6', () => {
    expect(buildHero('Bard', 5).actions.some(a => a.name === 'Fireball')).toBe(false);
    expect(buildHero('Bard', 6).actions.some(a => a.name === 'Fireball')).toBe(true);
  });
});

describe('Bardic Inspiration high-level features', () => {
  it('Superior Inspiration restores Bardic Inspiration to two uses on initiative', () => {
    const bard = createCreatureWithFixedHp(buildHero('Bard', 18), 'blue', { x: 1, y: 1 }, 0);
    bard.resources['bardic-inspiration'] = 0;

    rollAllInitiatives([bard]);

    expect(bard.resources['bardic-inspiration']).toBe(2);
  });

  it('Boon of Spell Recall can preserve a level 1-4 spell slot', () => {
    const bard = createCreatureWithFixedHp(buildHero('Bard', 19), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget(), 'blue', { x: 2, y: 1 }, 1);
    ally.currentHp = 10;
    const state = stateWith([bard, ally]);
    const cure = bard.monsterData.actions.find(a => a.name === 'Cure Wounds')!;
    const slotsBefore = bard.resources['slot-1'];
    vi.spyOn(Math, 'random').mockReturnValueOnce(0); // Spell Recall d4 -> 1, matching slot-1.

    executeSpell(state, bard, cure, ally);

    expect(bard.resources['slot-1']).toBe(slotsBefore);
    expect(state.logs.some(l => l.action === 'Boon of Spell Recall')).toBe(true);
  });

  it('Cutting Words can turn an enemy hit into a miss', () => {
    const bard = createCreatureWithFixedHp(buildHero('Bard', 15), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ ac: 16 }), 'blue', { x: 2, y: 1 }, 1);
    const attacker = createCreatureWithFixedHp(makeTarget(), 'red', { x: 3, y: 1 }, 2);
    const attack = attacker.monsterData.actions[0];
    const state = stateWith([bard, ally, attacker]);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.6) // d20 -> 13, total 18 vs AC 16.
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(0.2); // d12 -> 3, total 15 and misses.

    resolveAttack(state, attacker, ally, attack);

    expect(bard.resources['bardic-inspiration']).toBe(4);
    expect(bard.reactionUsed).toBe(true);
    expect(state.logs.some(l => l.action === 'Cutting Words')).toBe(true);
    expect(state.events.some(e => e.kind === 'miss' && e.targetId === ally.id)).toBe(true);
  });

  it('Peerless Skill spends Bardic Inspiration only when it turns a Bard miss into a hit', () => {
    const bard = createCreatureWithFixedHp(buildHero('Bard', 14), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 17 }), 'red', { x: 2, y: 1 }, 1);
    const attack = bard.monsterData.actions.find(a => a.name === 'Rapier')!;
    const state = stateWith([bard, target]);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.3) // d20 -> 7, total 15 vs AC 17.
      .mockReturnValueOnce(0.3)
      .mockReturnValueOnce(0.15); // d10 -> 2, total 17 hits.

    resolveAttack(state, bard, target, attack);

    expect(bard.resources['bardic-inspiration']).toBe(4);
    expect(state.logs.some(l => l.action === 'Peerless Skill')).toBe(true);
    expect(target.currentHp).toBeLessThan(target.maxHp);
  });

  it('Peerless Skill does not expend Bardic Inspiration if the bonus still misses', () => {
    const bard = createCreatureWithFixedHp(buildHero('Bard', 14), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 25 }), 'red', { x: 2, y: 1 }, 1);
    const attack = bard.monsterData.actions.find(a => a.name === 'Rapier')!;
    const state = stateWith([bard, target]);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.3) // d20 -> 7, total 15 vs AC 25.
      .mockReturnValueOnce(0.3)
      .mockReturnValueOnce(0.15); // d10 -> 2, still misses.

    resolveAttack(state, bard, target, attack);

    expect(bard.resources['bardic-inspiration']).toBe(5);
    expect(target.currentHp).toBe(target.maxHp);
  });
});

describe('Bard defensive and Power Word features', () => {
  it('Countercharm rerolls a failed save against Frightened with Advantage', () => {
    const bard = createCreatureWithFixedHp(buildHero('Bard', 7), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget(), 'blue', { x: 2, y: 1 }, 1);
    const enemy = createCreatureWithFixedHp(makeTarget(), 'red', { x: 3, y: 1 }, 2);
    const dread: MonsterAction = {
      name: 'Dreadful Glare',
      type: 'special',
      description: 'WIS save or frightened.',
      savingThrow: { ability: 'wis', dc: 15, conditionOnFail: 'frightened', conditionDuration: '1_minute' },
    };
    const state = stateWith([bard, ally, enemy]);
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.95);

    resolveSingleTargetSave(state, enemy, ally, dread);

    expect(ally.conditions).not.toContain('frightened');
    expect(bard.reactionUsed).toBe(true);
    expect(state.logs.some(l => l.action === 'Countercharm')).toBe(true);
  });

  it('Words of Creation lets Power Word Kill affect a second nearby enemy', () => {
    const bard = createCreatureWithFixedHp(buildHero('Bard', 20), 'blue', { x: 1, y: 1 }, 0);
    const enemy1 = createCreatureWithFixedHp(makeTarget({ hp: 80 }), 'red', { x: 4, y: 1 }, 1);
    const enemy2 = createCreatureWithFixedHp(makeTarget({ hp: 80 }), 'red', { x: 5, y: 1 }, 2);
    enemy1.currentHp = 50;
    enemy2.currentHp = 60;
    const state = stateWith([bard, enemy1, enemy2]);
    const powerWordKill = bard.monsterData.actions.find(a => a.name === 'Power Word Kill')!;

    executeSpell(state, bard, powerWordKill, enemy1);

    expect(enemy1.isAlive).toBe(false);
    expect(enemy2.isAlive).toBe(false);
    expect(bard.resources['slot-9']).toBe(0);
  });

  it('Power Word Heal fully heals and clears the modeled conditions', () => {
    const bard = createCreatureWithFixedHp(buildHero('Bard', 17), 'blue', { x: 1, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(makeTarget({ hp: 120 }), 'blue', { x: 4, y: 1 }, 1);
    ally.currentHp = 12;
    ally.conditions.push('paralyzed', 'poisoned', 'prone');
    const state = stateWith([bard, ally]);
    const powerWordHeal = bard.monsterData.actions.find(a => a.name === 'Power Word Heal')!;

    executeSpell(state, bard, powerWordHeal, ally);

    expect(ally.currentHp).toBe(ally.maxHp);
    expect(ally.conditions).not.toContain('paralyzed');
    expect(ally.conditions).not.toContain('poisoned');
    expect(ally.conditions).not.toContain('prone');
    expect(ally.reactionUsed).toBe(true);
  });
});
