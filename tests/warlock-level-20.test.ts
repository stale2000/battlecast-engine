import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero, getAvailableSpells, getMaxHeroLevelForClass } from '../src/data/heroes';
import type { Creature, MonsterData } from '../src/types/monster';
import {
  applyDamage,
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

describe('Warlock level 11-20 build data', () => {
  it('unlocks Warlock through level 20 with Wizard now fully unlocked', () => {
    expect(getMaxHeroLevelForClass('Warlock')).toBe(20);
    expect(getMaxHeroLevelForClass('Wizard')).toBe(20);
    expect(() => buildHero('Warlock', 20)).not.toThrow();
    expect(() => buildHero('Wizard', 20)).not.toThrow();
  });

  it('applies the fixed level-20 Fiend Warlock loadout', () => {
    const warlock = buildHero('Warlock', 20);

    expect(warlock.heroSubclass).toBe('Fiend Patron');
    expect(warlock.abilities).toMatchObject({
      str: 8,
      dex: 15,
      con: 18,
      int: 10,
      wis: 12,
      cha: 21,
    });
    expect(warlock.ac).toBe(14);
    expect(warlock.hp).toBe(183);
    expect(warlock.saves).toMatchObject({ wis: 7, cha: 11 });
    expect(warlock.resistances).toContain('fire');
    expect(warlock.initialResources).toMatchObject({
      'slot-5': 4,
      'dark-ones-own-luck': 5,
      'mystic-arcanum-6': 1,
      'mystic-arcanum-7': 1,
      'mystic-arcanum-8': 1,
      'mystic-arcanum-9': 1,
      'hurl-through-hell': 1,
    });
    expect(warlock.actions.find(action => action.name === 'Eldritch Blast')).toMatchObject({
      attackBonus: 11,
      damage: '4d10+5',
      spellLevel: 0,
    });
    expect(warlock.actions.find(action => action.name === 'Multiattack')?.description).toContain('four Eldritch Blast attacks');
    expect(warlock.actions.some(action => action.name === 'Fireball')).toBe(true);
    expect(warlock.actions.some(action => action.name === 'Wall of Fire')).toBe(true);
    expect(warlock.actions.some(action => action.name === 'Circle of Death')).toBe(true);
    expect(warlock.actions.some(action => action.name === 'Finger of Death')).toBe(true);
    expect(warlock.actions.some(action => action.name === 'Befuddlement')).toBe(true);
    expect(warlock.actions.some(action => action.name === 'Power Word Kill')).toBe(true);
    expect(warlock.traits?.some(trait => trait.name.includes('Hurl Through Hell'))).toBe(true);
  });

  it('scales Pact Magic slots and Eldritch Blast beams beyond level 10', () => {
    expect(buildHero('Warlock', 10).initialResources).toMatchObject({ 'slot-5': 2 });
    expect(buildHero('Warlock', 11).initialResources).toMatchObject({ 'slot-5': 3, 'mystic-arcanum-6': 1 });
    expect(buildHero('Warlock', 16).initialResources).toMatchObject({ 'slot-5': 3, 'mystic-arcanum-8': 1 });
    expect(buildHero('Warlock', 17).initialResources).toMatchObject({ 'slot-5': 4, 'mystic-arcanum-9': 1 });
    expect(buildHero('Warlock', 11).actions.find(action => action.name === 'Multiattack')?.description).toContain('three Eldritch Blast attacks');
    expect(buildHero('Warlock', 17).actions.find(action => action.name === 'Multiattack')?.description).toContain('four Eldritch Blast attacks');
  });

  it('exposes Mystic Arcanum spells in the custom spell picker', () => {
    const names = getAvailableSpells('Warlock', 20).map(spell => spell.name);

    expect(names).toEqual(expect.arrayContaining([
      'Circle of Death',
      'Finger of Death',
      'Befuddlement',
      'Power Word Kill',
    ]));
  });
});

describe('Warlock Fiend Patron features', () => {
  it('casts Mystic Arcanum without spending Pact Magic slots', () => {
    const warlock = createCreatureWithFixedHp(buildHero('Warlock', 11), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget(), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([warlock, target]);
    const circle = warlock.monsterData.actions.find(action => action.name === 'Circle of Death')!;
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(executeSpell(state, warlock, circle, target, [target], target.position)).toBe(true);

    expect(warlock.resources['mystic-arcanum-6']).toBe(0);
    expect(warlock.resources['slot-5']).toBe(3);
    expect(target.currentHp).toBe(112);
    expect(warlock.stats.actionUsage['Circle of Death']).toBe(1);
  });

  it("grants Dark One's Blessing when the Warlock reduces an enemy to 0 HP", () => {
    const warlock = createCreatureWithFixedHp(buildHero('Warlock', 3), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 1, hpFormula: '1' }), 'red', { x: 2, y: 1 }, 1);
    const state = stateWith([warlock, target]);

    applyDamage(state, target, 1, 'force', warlock, true, true, false);

    expect(target.isAlive).toBe(false);
    expect(warlock.temporaryHp).toBe(6);
    expect(warlock.stats.actionUsage["Dark One's Blessing"]).toBe(1);
    expect(state.logs.some(log => log.action === "Dark One's Blessing")).toBe(true);
  });

  it("grants nearby Fiend Warlocks Dark One's Blessing when an ally drops an enemy", () => {
    const warlock = createCreatureWithFixedHp(buildHero('Warlock', 3), 'blue', { x: 2, y: 1 }, 0);
    const ally = createCreatureWithFixedHp(buildHero('Fighter', 3), 'blue', { x: 1, y: 1 }, 1);
    const target = createCreatureWithFixedHp(makeTarget({ hp: 1, hpFormula: '1' }), 'red', { x: 3, y: 1 }, 2);
    const state = stateWith([warlock, ally, target]);

    applyDamage(state, target, 1, 'slashing', ally, true, false, false);

    expect(target.isAlive).toBe(false);
    expect(warlock.temporaryHp).toBe(6);
    expect(ally.temporaryHp).toBe(0);
  });

  it('uses Hurl Through Hell after an attack-roll hit', () => {
    const warlock = createCreatureWithFixedHp(buildHero('Warlock', 14), 'blue', { x: 1, y: 1 }, 0);
    const target = createCreatureWithFixedHp(makeTarget({ ac: 1 }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([warlock, target]);
    const blast = warlock.monsterData.actions.find(action => action.name === 'Eldritch Blast')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5);

    resolveAttack(state, warlock, target, blast);

    expect(warlock.resources['hurl-through-hell']).toBe(0);
    expect(warlock.resources['slot-5']).toBe(3);
    expect(target.currentHp).toBe(104);
    expect(target.conditions).toContain('incapacitated');
    expect(warlock.stats.actionUsage['Hurl Through Hell']).toBe(1);
    expect(state.logs.some(log => log.action === 'Hurl Through Hell' && log.damage === 8)).toBe(true);
  });

  it('can restore Hurl Through Hell by spending a Pact Magic slot', () => {
    const warlock = createCreatureWithFixedHp(buildHero('Warlock', 14), 'blue', { x: 1, y: 1 }, 0);
    warlock.resources['hurl-through-hell'] = 0;
    warlock.resources['slot-5'] = 1;
    const target = createCreatureWithFixedHp(makeTarget({ ac: 1 }), 'red', { x: 4, y: 1 }, 1);
    const state = stateWith([warlock, target]);
    const blast = warlock.monsterData.actions.find(action => action.name === 'Eldritch Blast')!;
    vi.spyOn(Math, 'random')
      .mockReturnValue(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5);

    resolveAttack(state, warlock, target, blast);

    expect(warlock.resources['hurl-through-hell']).toBe(0);
    expect(warlock.resources['slot-5']).toBe(0);
    expect(target.currentHp).toBe(104);
    expect(state.logs.some(log => log.action === 'Hurl Through Hell' && log.details.includes('Pact Magic slot'))).toBe(true);
  });

  it('applies Fiendish Resilience as fire resistance from level 10', () => {
    const warlock = createCreatureWithFixedHp(buildHero('Warlock', 10), 'blue', { x: 1, y: 1 }, 0);
    const state = stateWith([warlock]);

    applyDamage(state, warlock, 10, 'fire', null, false, true, false);

    expect(warlock.currentHp).toBe(warlock.maxHp - 5);
  });
});
