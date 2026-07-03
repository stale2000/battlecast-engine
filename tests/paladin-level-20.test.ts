import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { Creature, MonsterData } from '../src/types/monster';
import {
  applyCondition,
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  executeSpell,
  getEffectiveSaveModifier,
  hasBuff,
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

describe('Paladin level 11-20 build data', () => {
  it('unlocks Paladin through level 20 without unlocking the next unfinished class', () => {
    expect(getMaxHeroLevelForClass('Paladin')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Paladin', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed level-20 Devotion loadout', () => {
    const paladin = buildHero('Paladin', 20);

    expect(paladin.heroSubclass).toBe('Oath of Devotion');
    expect(paladin.abilities.str).toBe(20);
    expect(paladin.abilities.cha).toBe(20);
    expect(paladin.ac).toBe(21);
    expect(paladin.hp).toBe(164);
    expect(paladin.senses).toContain('Truesight 60 ft.');
    expect(paladin.initialResources).toMatchObject({
      'lay-on-hands': 100,
      'free-divine-smite': 1,
      'channel-divinity': 3,
      'holy-nimbus': 1,
      'slot-5': 2,
    });
    expect(paladin.actions.some(a => a.name === 'Abjure Foes')).toBe(true);
    expect(paladin.actions.some(a => a.name === 'Holy Nimbus')).toBe(true);
  });

  it('extends the half-caster slot table through fifth-level Paladin slots', () => {
    expect(buildHero('Paladin', 13).initialResources).toMatchObject({ 'slot-4': 1 });
    expect(buildHero('Paladin', 17).initialResources).toMatchObject({ 'slot-5': 1 });
    expect(buildHero('Paladin', 20).initialResources).toMatchObject({ 'slot-5': 2 });
  });

  it('adds Radiant Strikes to melee weapon hits from level 11', () => {
    expect(buildHero('Paladin', 10).actions.find(a => a.name === 'Longsword')?.additionalDamage).toBeUndefined();
    expect(buildHero('Paladin', 11).actions.find(a => a.name === 'Longsword')?.additionalDamage).toBe('1d8 radiant');
  });
});

describe('Paladin aura and restoration features', () => {
  it('Aura of Protection adds the Paladin CHA modifier to nearby ally saves', () => {
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 6), 'blue', { x: 5, y: 5 }, 0);
    const ally = createCreatureWithFixedHp(buildHero('Fighter', 6), 'blue', { x: 6, y: 5 }, 1);
    const state = stateWith([paladin, ally]);

    const base = getEffectiveSaveModifier(ally, 'dex');
    const protectedSave = getEffectiveSaveModifier(ally, 'dex', state);

    expect(protectedSave).toBe(base + 2);
  });

  it('Aura Expansion protects allies out to 30 feet from frightened', () => {
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 18), 'blue', { x: 5, y: 5 }, 0);
    const ally = createCreatureWithFixedHp(buildHero('Fighter', 5), 'blue', { x: 11, y: 5 }, 1);
    const enemy = createCreatureWithFixedHp(makeTarget(), 'red', { x: 12, y: 5 }, 2);
    const state = stateWith([paladin, ally, enemy]);

    const applied = applyCondition(state, ally, 'frightened', enemy, '1_minute');

    expect(applied).toBe(false);
    expect(ally.conditions).not.toContain('frightened');
    expect(state.logs.some(log => log.action === 'Aura of Courage')).toBe(true);
  });

  it('Restoring Touch spends Lay on Hands pool to remove modeled conditions', () => {
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 14), 'blue', { x: 5, y: 5 }, 0);
    const ally = createCreatureWithFixedHp(buildHero('Fighter', 5), 'blue', { x: 6, y: 5 }, 1);
    ally.currentHp = Math.max(1, ally.currentHp - 20);
    ally.conditions.push('poisoned', 'stunned');
    const state = stateWith([paladin, ally]);
    const layOnHands = paladin.monsterData.actions.find(a => a.name === 'Lay on Hands')!;

    expect(executeSpell(state, paladin, layOnHands, ally)).toBe(true);

    expect(ally.conditions).not.toContain('poisoned');
    expect(ally.conditions).not.toContain('stunned');
    expect(paladin.resources['lay-on-hands']).toBe(40);
    expect(paladin.stats.actionUsage['Restoring Touch']).toBe(2);
  });

  it('Lay on Hands spends only the HP needed from the pool', () => {
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 20), 'blue', { x: 5, y: 5 }, 0);
    const ally = createCreatureWithFixedHp(buildHero('Fighter', 10), 'blue', { x: 6, y: 5 }, 1);
    ally.currentHp = ally.maxHp - 37;
    const state = stateWith([paladin, ally]);
    const layOnHands = paladin.monsterData.actions.find(a => a.name === 'Lay on Hands')!;

    expect(executeSpell(state, paladin, layOnHands, ally)).toBe(true);

    expect(ally.currentHp).toBe(ally.maxHp);
    expect(paladin.resources['lay-on-hands']).toBe(63);
    expect(paladin.stats.actionUsage['Lay on Hands']).toBe(1);
  });
});

describe('Paladin offensive features', () => {
  it('uses the free Divine Smite before spending spell slots', () => {
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 2), 'blue', { x: 5, y: 5 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 200, hpFormula: '200' }), 'red', { x: 6, y: 5 }, 1);
    const state = stateWith([paladin, target]);
    const longsword = paladin.monsterData.actions.find(a => a.name === 'Longsword')!;
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    resolveAttack(state, paladin, target, longsword);

    expect(paladin.resources['free-divine-smite']).toBe(0);
    expect(paladin.resources['slot-1']).toBe(2);
    expect(state.logs.some(log => log.action === 'Divine Smite' && log.details.includes('free use'))).toBe(true);
  });

  it('activates Sacred Weapon before melee attacks when Channel Divinity is available', () => {
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 3), 'blue', { x: 5, y: 5 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 20, hpFormula: '20' }), 'red', { x: 6, y: 5 }, 1);
    const state = stateWith([paladin, target]);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    executeTurn(state, paladin);

    expect(hasBuff(paladin, 'sacred-weapon')).toBe(true);
    expect(paladin.activeBuffs.find(b => b.key === 'sacred-weapon')?.attackBonus).toBe(2);
    expect(paladin.resources['channel-divinity']).toBe(1);
    expect(paladin.stats.actionUsage['Sacred Weapon']).toBe(1);
  });

  it('uses Abjure Foes against multiple valid enemies', () => {
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 9), 'blue', { x: 5, y: 5 }, 0);
    const first = createCreatureWithFixedHp(makeTarget({ name: 'Foe A', hp: 30, hpFormula: '30' }), 'red', { x: 8, y: 5 }, 1);
    const second = createCreatureWithFixedHp(makeTarget({ name: 'Foe B', hp: 30, hpFormula: '30' }), 'red', { x: 9, y: 5 }, 2);
    const state = stateWith([paladin, first, second]);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    executeTurn(state, paladin);

    expect(first.conditions).toContain('frightened');
    expect(second.conditions).toContain('frightened');
    expect(paladin.resources['channel-divinity']).toBe(1);
    expect(paladin.stats.actionUsage['Abjure Foes']).toBe(1);
  });

  it('Smite of Protection grants nearby allies +2 AC after Divine Smite', () => {
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 15), 'blue', { x: 5, y: 5 }, 0);
    const ally = createCreatureWithFixedHp(buildHero('Fighter', 5), 'blue', { x: 6, y: 5 }, 1);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 300, hpFormula: '300' }), 'red', { x: 6, y: 6 }, 2);
    const state = stateWith([paladin, ally, target]);
    const longsword = paladin.monsterData.actions.find(a => a.name === 'Longsword')!;
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    resolveAttack(state, paladin, target, longsword);

    expect(ally.activeBuffs.some(b => b.key === `smite-of-protection:${paladin.id}` && b.acBonus === 2)).toBe(true);
  });

  it('Holy Nimbus activates at turn start and damages enemies that start in the aura', () => {
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 20), 'blue', { x: 5, y: 5 }, 0);
    const enemy = createCreatureWithFixedHp(makeTarget({ hp: 200, hpFormula: '200' }), 'red', { x: 8, y: 5 }, 1);
    const state = stateWith([paladin, enemy]);

    executeTurn(state, paladin);

    expect(hasBuff(paladin, 'holy-nimbus')).toBe(true);
    expect(paladin.resources['holy-nimbus']).toBe(0);

    executeTurn(state, enemy);

    expect(enemy.currentHp).toBeLessThan(enemy.maxHp);
    expect(state.logs.some(log => log.action === 'Holy Nimbus')).toBe(true);
    expect(state.events.some(event => event.kind === 'hit' && event.targetId === enemy.id && event.damageType === 'radiant')).toBe(true);
  });
});
