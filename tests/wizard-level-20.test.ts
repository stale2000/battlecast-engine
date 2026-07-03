import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHero,
  getAvailableSpells,
  getMaxHeroLevelForClass,
  HERO_CLASS_NAMES,
} from '../src/data/heroes';
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

describe('Wizard level 11-20 build data', () => {
  it('unlocks Wizard and leaves every hero class available through level 20', () => {
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(HERO_CLASS_NAMES.every(className => getMaxHeroLevelForClass(className) === 20)).toBe(true);
    expect(() => buildHero('Wizard', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 21)).toThrow();
  });

  it('applies the fixed level-20 Evoker Wizard loadout', () => {
    const wizard = buildHero('Wizard', 20);

    expect(wizard.heroSubclass).toBe('Evoker');
    expect(wizard.abilities).toMatchObject({
      str: 10,
      dex: 15,
      con: 18,
      int: 21,
      wis: 12,
      cha: 8,
    });
    expect(wizard.ac).toBe(12);
    expect(wizard.hp).toBe(162);
    expect(wizard.saves).toMatchObject({ int: 11, wis: 7 });
    expect(wizard.initialResources).toMatchObject({
      'slot-7': 2,
      'slot-8': 1,
      'slot-9': 1,
      overchannel: 1,
      'signature-fireball': 1,
      'signature-lightning-bolt': 1,
    });
    expect(wizard.actions.find(action => action.name === 'Fire Bolt')).toMatchObject({
      attackBonus: 11,
      damage: '4d10',
      spellLevel: 0,
      spellSchool: 'evocation',
    });
    expect(wizard.actions.find(action => action.name === 'Magic Missile')?.atWill).toBe(true);
    expect(wizard.actions.find(action => action.name === 'Scorching Ray')?.atWill).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Chain Lightning')).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Disintegrate')).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Circle of Death')).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Finger of Death')).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Befuddlement')).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Sunburst')).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Meteor Swarm')).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Power Word Kill')).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Signature Spell: Fireball')).toBe(true);
    expect(wizard.actions.some(action => action.name === 'Signature Spell: Lightning Bolt')).toBe(true);
  });

  it('exposes high-level Wizard spells in the custom spell picker', () => {
    const names = getAvailableSpells('Wizard', 20).map(spell => spell.name);

    expect(names).toEqual(expect.arrayContaining([
      'Chain Lightning',
      'Disintegrate',
      'Circle of Death',
      'Finger of Death',
      'Befuddlement',
      'Sunburst',
      'Meteor Swarm',
      'Power Word Kill',
    ]));
  });
});

describe('Wizard Evoker high-level features', () => {
  it('casts Spell Mastery Magic Missile without spending a slot', () => {
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 18), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([wizard, target]);
    const magicMissile = wizard.monsterData.actions.find(action => action.name === 'Magic Missile')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(executeSpell(state, wizard, magicMissile, target, [target, target, target])).toBe(true);

    expect(magicMissile.atWill).toBe(true);
    expect(wizard.resources['slot-1']).toBe(4);
    expect(target.currentHp).toBe(114);
  });

  it('uses Signature Spell Fireball without spending a slot or Overchannel', () => {
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 20), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([wizard, target]);
    const fireball = wizard.monsterData.actions.find(action => action.name === 'Signature Spell: Fireball')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(executeSpell(state, wizard, fireball, target, [target], target.position)).toBe(true);

    expect(wizard.resources['signature-fireball']).toBe(0);
    expect(wizard.resources['slot-3']).toBe(3);
    expect(wizard.resources.overchannel).toBe(1);
    expect(target.currentHp).toBe(107);
  });

  it('can preserve a level 1-4 spell slot with Boon of Spell Recall', () => {
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 19), 'blue', { x: 1, y: 1 }, 0);
    wizard.resources.overchannel = 0;
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([wizard, target]);
    const fireball = wizard.monsterData.actions.find(action => action.name === 'Fireball')!;
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(executeSpell(state, wizard, fireball, target, [target], target.position)).toBe(true);

    expect(wizard.resources['slot-3']).toBe(3);
    expect(state.logs.some(log => log.action === 'Boon of Spell Recall')).toBe(true);
  });

  it('applies Potent Cantrip damage when Fire Bolt misses', () => {
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 3), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 30 }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([wizard, target]);
    const fireBolt = wizard.monsterData.actions.find(action => action.name === 'Fire Bolt')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0.9)
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.1);

    resolveAttack(state, wizard, target, fireBolt);

    expect(target.currentHp).toBe(115);
    expect(wizard.stats.actionUsage['Potent Cantrip']).toBe(1);
    expect(state.logs.some(log => log.action === 'Potent Cantrip' && log.damage === 5)).toBe(true);
  });

  it('maximizes the first eligible damage spell with Overchannel', () => {
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 14), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([wizard, target]);
    const cone = wizard.monsterData.actions.find(action => action.name === 'Cone of Cold')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(executeSpell(state, wizard, cone, target, [target], target.position)).toBe(true);

    expect(wizard.resources.overchannel).toBe(0);
    expect(target.currentHp).toBe(51);
    expect(wizard.stats.actionUsage.Overchannel).toBe(1);
    expect(state.logs.some(log => log.action === 'Overchannel')).toBe(true);
  });

  it('does not apply Empowered Evocation to non-evocation spells', () => {
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 20), 'blue', { x: 1, y: 1 }, 0);
    wizard.resources.overchannel = 0;
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([wizard, target]);
    const disintegrate = wizard.monsterData.actions.find(action => action.name === 'Disintegrate')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(executeSpell(state, wizard, disintegrate, target, [target], target.position)).toBe(true);

    expect(target.currentHp).toBe(70);
    expect(disintegrate.spellSchool).not.toBe('evocation');
  });

  it('applies Meteor Swarm fire and bludgeoning damage separately', () => {
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 20), 'blue', { x: 1, y: 1 }, 0);
    wizard.resources.overchannel = 0;
    const target = createCreatureWithFixedHp(makeTarget({
      hp: 200,
      hpFormula: '200',
      immunities: ['fire'],
      resistances: ['bludgeoning'],
    }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([wizard, target]);
    const meteor = wizard.monsterData.actions.find(action => action.name === 'Meteor Swarm')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(executeSpell(state, wizard, meteor, target, [target], target.position)).toBe(true);

    expect(wizard.resources['slot-9']).toBe(0);
    expect(target.currentHp).toBe(190);
    expect(state.logs.some(log => log.action === 'Immune' && log.details.includes('fire'))).toBe(true);
    expect(state.logs.some(log => log.action === 'Resisted' && log.details.includes('bludgeoning'))).toBe(true);
  });
});
