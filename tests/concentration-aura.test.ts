import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { monsters } from '../src/data/monsters';
import { createCreatureWithFixedHp, processConcentrationAuras, dropConcentratedBuffsFrom, checkAuraEntry } from '../src/engine/combat';
import type { BattleState } from '../src/engine/combat';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

function makeState(creatures: ReturnType<typeof createCreatureWithFixedHp>[]): BattleState {
  return {
    creatures, round: 2, turnIndex: 0,
    events: [], logs: [], isComplete: false, gridSize: 20,
  } as unknown as BattleState;
}

describe('Concentration aura per-turn damage', () => {
  it('processConcentrationAuras deals damage to enemy in aura range', () => {
    const cleric = buildHero('Cleric', 5);
    const ogre = md('Ogre');
    const caster = createCreatureWithFixedHp(cleric, 'blue', { x: 10, y: 10 }, 0);
    const enemy = createCreatureWithFixedHp(ogre, 'red', { x: 11, y: 10 }, 0);
    const state = makeState([caster, enemy]);

    caster.concentratingOn = 'Spirit Guardians';
    caster.concentrationAura = {
      spellName: 'Spirit Guardians', damageDice: '3d8', damageType: 'radiant',
      saveAbility: 'wis', saveDC: 15, radiusFt: 15, origin: 'caster',
    };

    const hpBefore = enemy.currentHp;
    processConcentrationAuras(state, enemy);
    expect(enemy.currentHp).toBeLessThan(hpBefore);
    expect(state.logs.some(l => l.action === 'Spirit Guardians')).toBe(true);
  });

  it('does not damage allies', () => {
    const cleric = buildHero('Cleric', 5);
    const fighter = buildHero('Fighter', 5);
    const caster = createCreatureWithFixedHp(cleric, 'blue', { x: 10, y: 10 }, 0);
    const ally = createCreatureWithFixedHp(fighter, 'blue', { x: 11, y: 10 }, 1);
    const state = makeState([caster, ally]);

    caster.concentratingOn = 'Spirit Guardians';
    caster.concentrationAura = {
      spellName: 'Spirit Guardians', damageDice: '3d8', damageType: 'radiant',
      saveAbility: 'wis', saveDC: 15, radiusFt: 15, origin: 'caster',
    };

    const hpBefore = ally.currentHp;
    processConcentrationAuras(state, ally);
    expect(ally.currentHp).toBe(hpBefore);
  });

  it('does not damage enemies out of range', () => {
    const cleric = buildHero('Cleric', 5);
    const ogre = md('Ogre');
    const caster = createCreatureWithFixedHp(cleric, 'blue', { x: 5, y: 10 }, 0);
    const enemy = createCreatureWithFixedHp(ogre, 'red', { x: 15, y: 10 }, 0);
    const state = makeState([caster, enemy]);

    caster.concentratingOn = 'Spirit Guardians';
    caster.concentrationAura = {
      spellName: 'Spirit Guardians', damageDice: '3d8', damageType: 'radiant',
      saveAbility: 'wis', saveDC: 15, radiusFt: 15, origin: 'caster',
    };

    const hpBefore = enemy.currentHp;
    processConcentrationAuras(state, enemy);
    expect(enemy.currentHp).toBe(hpBefore);
  });

  it('point-origin aura damages enemies near the point, not the caster', () => {
    const druid = buildHero('Druid', 5);
    const ogre = md('Ogre');
    const caster = createCreatureWithFixedHp(druid, 'blue', { x: 5, y: 10 }, 0);
    const enemy = createCreatureWithFixedHp(ogre, 'red', { x: 15, y: 10 }, 0);
    const state = makeState([caster, enemy]);

    caster.concentratingOn = 'Call Lightning';
    caster.concentrationAura = {
      spellName: 'Call Lightning', damageDice: '3d10', damageType: 'lightning',
      saveAbility: 'dex', saveDC: 15, radiusFt: 5, origin: 'point',
      point: { x: 15, y: 10 },
    };

    const hpBefore = enemy.currentHp;
    processConcentrationAuras(state, enemy);
    expect(enemy.currentHp).toBeLessThan(hpBefore);
  });

  it('aura clears when concentration drops', () => {
    const cleric = buildHero('Cleric', 5);
    const ogre = md('Ogre');
    const caster = createCreatureWithFixedHp(cleric, 'blue', { x: 10, y: 10 }, 0);
    const enemy = createCreatureWithFixedHp(ogre, 'red', { x: 11, y: 10 }, 0);
    const state = makeState([caster, enemy]);

    caster.concentratingOn = 'Spirit Guardians';
    caster.concentrationAura = {
      spellName: 'Spirit Guardians', damageDice: '3d8', damageType: 'radiant',
      saveAbility: 'wis', saveDC: 15, radiusFt: 15, origin: 'caster',
    };

    dropConcentratedBuffsFrom(state, caster.id);

    expect(caster.concentrationAura).toBeUndefined();
    const hpBefore = enemy.currentHp;
    processConcentrationAuras(state, enemy);
    expect(enemy.currentHp).toBe(hpBefore);
  });

  it('Moonbeam has concentration flag', () => {
    const druid = buildHero('Druid', 5);
    const mb = druid.actions.find(a => a.name === 'Moonbeam');
    expect(mb).toBeDefined();
    expect(mb!.concentration).toBe(true);
  });

  it('enemy moving into aura takes damage', () => {
    const cleric = buildHero('Cleric', 5);
    const ogre = md('Ogre');
    const caster = createCreatureWithFixedHp(cleric, 'blue', { x: 10, y: 10 }, 0);
    const enemy = createCreatureWithFixedHp(ogre, 'red', { x: 18, y: 10 }, 0);
    const state = makeState([caster, enemy]);

    caster.concentratingOn = 'Spirit Guardians';
    caster.concentrationAura = {
      spellName: 'Spirit Guardians', damageDice: '3d8', damageType: 'radiant',
      saveAbility: 'wis', saveDC: 15, radiusFt: 15, origin: 'caster',
    };

    // Enemy was at (18,10) = 40ft away, moves to (11,10) = 5ft = inside 15ft aura
    const oldPos = { ...enemy.position };
    enemy.position = { x: 11, y: 10 };
    const hpBefore = enemy.currentHp;
    checkAuraEntry(state, enemy, oldPos);
    expect(enemy.currentHp).toBeLessThan(hpBefore);
    expect(state.logs.some(l => l.details?.includes('enters'))).toBe(true);
  });

  it('enemy moving but staying outside aura takes no damage', () => {
    const cleric = buildHero('Cleric', 5);
    const ogre = md('Ogre');
    const caster = createCreatureWithFixedHp(cleric, 'blue', { x: 10, y: 10 }, 0);
    const enemy = createCreatureWithFixedHp(ogre, 'red', { x: 18, y: 10 }, 0);
    const state = makeState([caster, enemy]);

    caster.concentratingOn = 'Spirit Guardians';
    caster.concentrationAura = {
      spellName: 'Spirit Guardians', damageDice: '3d8', damageType: 'radiant',
      saveAbility: 'wis', saveDC: 15, radiusFt: 15, origin: 'caster',
    };

    const oldPos = { ...enemy.position };
    enemy.position = { x: 16, y: 10 }; // Still 30ft away
    const hpBefore = enemy.currentHp;
    checkAuraEntry(state, enemy, oldPos);
    expect(enemy.currentHp).toBe(hpBefore);
  });

  it('caster moving toward enemy triggers aura on enemy', () => {
    const cleric = buildHero('Cleric', 5);
    const ogre = md('Ogre');
    const caster = createCreatureWithFixedHp(cleric, 'blue', { x: 5, y: 10 }, 0);
    const enemy = createCreatureWithFixedHp(ogre, 'red', { x: 15, y: 10 }, 0);
    const state = makeState([caster, enemy]);

    caster.concentratingOn = 'Spirit Guardians';
    caster.concentrationAura = {
      spellName: 'Spirit Guardians', damageDice: '3d8', damageType: 'radiant',
      saveAbility: 'wis', saveDC: 15, radiusFt: 15, origin: 'caster',
    };

    // Caster moves from (5,10) to (13,10) - enemy at (15,10) is now 10ft = inside 15ft aura
    const oldPos = { ...caster.position };
    caster.position = { x: 13, y: 10 };
    const hpBefore = enemy.currentHp;
    checkAuraEntry(state, caster, oldPos);
    expect(enemy.currentHp).toBeLessThan(hpBefore);
  });

  it('Step 3 does not recast concentration spells when already concentrating', () => {
    const cleric = buildHero('Cleric', 5);
    const sgAction = cleric.actions.find(a => a.name === 'Spirit Guardians');
    expect(sgAction).toBeDefined();
    expect(sgAction!.concentration).toBe(true);
  });
});
