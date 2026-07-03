import { describe, expect, it } from 'vitest';
import {
  applyDamage,
  createCreatureWithFixedHp,
  gainHp,
  initBattle,
} from '../src/engine/combat';
import { executeTurn } from '../src/engine/ai-turn';
import { buildHero } from '../src/data/heroes';
import { Creature, MonsterData } from '../src/types/monster';

function testEnemy(pos = { x: 15, y: 5 }): Creature {
  const data: MonsterData = {
    name: 'Test Ogre',
    size: 'Large',
    type: 'giant',
    alignment: 'neutral',
    ac: 11,
    hp: 80,
    hpFormula: '10d10+25',
    speed: { walk: 30 },
    abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
    senses: '',
    languages: '',
    cr: '2',
    xp: 450,
    proficiencyBonus: 2,
    actions: [
      { name: 'Club', type: 'melee', attackBonus: 6, damage: '2d8+4', damageType: 'bludgeoning', reach: 5, description: '.' },
    ],
  };
  return createCreatureWithFixedHp(data, 'red', pos, 0);
}

function hero(
  heroClass: Parameters<typeof buildHero>[0],
  level: number,
  pos: { x: number; y: number },
  index: number,
): Creature {
  return createCreatureWithFixedHp(buildHero(heroClass, level), 'blue', pos, index);
}

function downWithoutMassiveDamage(state: ReturnType<typeof initBattle>, target: Creature, attacker: Creature): void {
  target.currentHp = 1;
  applyDamage(state, target, 2, 'bludgeoning', attacker, true);
  expect(target.dying).toBe(true);
}

describe('#86 healer decision behavior', () => {
  it('moves a touch healer before reviving a dying ally with Lay on Hands', () => {
    const paladin = hero('Paladin', 1, { x: 5, y: 5 }, 0);
    const ally = hero('Fighter', 1, { x: 8, y: 5 }, 1);
    const enemy = testEnemy({ x: 15, y: 5 });
    const state = initBattle([paladin, ally, enemy], 20);
    downWithoutMassiveDamage(state, ally, enemy);

    executeTurn(state, paladin);

    expect(ally.dying).toBe(false);
    expect(ally.conditions).not.toContain('unconscious');
    expect(ally.currentHp).toBeGreaterThan(0);
    expect(paladin.stats.actionUsage['Lay on Hands']).toBe(1);
    expect(state.events.some(e => e.kind === 'move' && e.creatureId === paladin.id)).toBe(true);
  });

  it('heals a reachable critical ally when a dying ally is too far away this turn', () => {
    const paladin = hero('Paladin', 1, { x: 5, y: 5 }, 0);
    const unreachableDying = hero('Rogue', 1, { x: 18, y: 5 }, 1);
    const reachableWounded = hero('Fighter', 1, { x: 6, y: 5 }, 2);
    const enemy = testEnemy({ x: 15, y: 10 });
    const state = initBattle([paladin, unreachableDying, reachableWounded, enemy], 20);
    downWithoutMassiveDamage(state, unreachableDying, enemy);
    reachableWounded.currentHp = 1;

    executeTurn(state, paladin);

    expect(unreachableDying.dying).toBe(true);
    expect(reachableWounded.currentHp).toBeGreaterThan(1);
    expect(paladin.stats.actionUsage['Lay on Hands']).toBe(1);
  });

  it('uses Mass Cure Wounds instead of Healing Word when several allies are dying', () => {
    const cleric = hero('Cleric', 9, { x: 5, y: 5 }, 0);
    const allyA = hero('Fighter', 1, { x: 6, y: 5 }, 1);
    const allyB = hero('Rogue', 1, { x: 7, y: 5 }, 2);
    const allyC = hero('Paladin', 1, { x: 8, y: 5 }, 3);
    const enemy = testEnemy({ x: 15, y: 5 });
    const state = initBattle([cleric, allyA, allyB, allyC, enemy], 20);
    cleric.resources['slot-1'] = 2;
    cleric.resources['slot-5'] = 1;
    downWithoutMassiveDamage(state, allyA, enemy);
    downWithoutMassiveDamage(state, allyB, enemy);
    downWithoutMassiveDamage(state, allyC, enemy);

    executeTurn(state, cleric);

    expect(cleric.stats.actionUsage['Mass Cure Wounds']).toBe(1);
    expect(cleric.stats.actionUsage['Healing Word'] ?? 0).toBe(0);
    expect([allyA, allyB, allyC].every(a => !a.dying && a.currentHp > 0)).toBe(true);
  });
});

describe('gainHp primitive', () => {
  function woundedHero(currentHp: number) {
    const c = createCreatureWithFixedHp(buildHero('Fighter', 5), 'blue', { x: 5, y: 5 }, 0);
    c.maxHp = 40;
    c.currentHp = currentHp;
    return c;
  }

  it('adds HP and returns the amount actually healed', () => {
    const c = woundedHero(10);
    expect(gainHp(c, 15)).toBe(15);
    expect(c.currentHp).toBe(25);
  });

  it('clamps at maxHp and reports only the HP that fit', () => {
    const c = woundedHero(35);
    expect(gainHp(c, 20)).toBe(5);
    expect(c.currentHp).toBe(40);
  });

  it('is a no-op for non-positive amounts', () => {
    const c = woundedHero(20);
    expect(gainHp(c, 0)).toBe(0);
    expect(gainHp(c, -5)).toBe(0);
    expect(c.currentHp).toBe(20);
  });
});
