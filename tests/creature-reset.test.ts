import { describe, expect, it } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { createCreatureWithFixedHp } from '../src/engine/combat';
import { resetCreatureForBattle, resetCreatureForBattleInPlace } from '../src/utils/creatureReset';

describe('resetCreatureForBattle', () => {
  it('clears downed and death-save state when restoring a creature', () => {
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 5), 'blue', { x: 3, y: 4 }, 0);
    cleric.currentHp = 0;
    cleric.isAlive = true;
    cleric.hasActed = true;
    cleric.hasMovedThisTurn = true;
    cleric.movementRemaining = 0;
    cleric.reactionUsed = true;
    cleric.bonusActionUsed = true;
    cleric.conditions = ['unconscious'];
    cleric.conditionTimers = [{
      condition: 'unconscious',
      duration: '1_minute',
      appliedRound: 1,
      sourceId: 'test',
    }];
    cleric.recharges = { 'Holy Symbol': false };
    cleric.resources = { 'slot-1': 0, 'slot-2': 0, 'slot-3': 0 };
    cleric.activeBuffs = [{
      name: 'Bless',
      key: 'bless',
      casterId: cleric.id,
      appliedRound: 1,
      endRound: 10,
      requiresConcentration: true,
      attackBonusDice: '1d4',
      saveBonusDice: '1d4',
    }];
    cleric.turnFlags = { sneakAttackUsed: true };
    cleric.concentrationAura = {
      spellName: 'Spirit Guardians',
      damageDice: '3d8',
      damageType: 'radiant',
      saveAbility: 'wis',
      saveDC: 15,
      radiusFt: 15,
      origin: 'caster',
    };
    cleric.concentratingOn = 'Bless';
    cleric.wildShape = {
      beastName: 'Brown Bear',
      tempHp: 12,
      maxTempHp: 12,
      formHp: 34,
      cr: '1',
      ac: 11,
      speed: { walk: 40 },
      actions: [],
      size: 'Large',
      abilities: { str: 19, dex: 10, con: 16 },
      isMoon: false,
    };
    cleric.swallowedTargetId = 'test-target';
    cleric.swallowedBy = { sourceId: 'test-source', damageDice: '3d6', damageType: 'acid' };
    cleric._wildShapeBeast = 'Brown Bear';
    cleric._concentrationAura = { damageType: 'radiant', radiusFt: 15 };
    cleric.dying = true;
    cleric.deathSaves = { successes: 1, failures: 2 };
    cleric.stats.damageTaken = 27;
    cleric.stats.timesDowned = 1;

    const reset = resetCreatureForBattle(cleric, { x: 7, y: 8 });

    expect(reset.currentHp).toBe(reset.maxHp);
    expect(reset.isAlive).toBe(true);
    expect(reset.hasActed).toBe(false);
    expect(reset.hasMovedThisTurn).toBe(false);
    expect(reset.movementRemaining).toBe(reset.monsterData.speed.walk);
    expect(reset.reactionUsed).toBe(false);
    expect(reset.bonusActionUsed).toBe(false);
    expect(reset.position).toEqual({ x: 7, y: 8 });
    expect(reset.conditions).toEqual([]);
    expect(reset.conditionTimers).toEqual([]);
    expect(reset.recharges).toEqual({});
    expect(reset.resources).toEqual(cleric.monsterData.initialResources);
    expect(reset.activeBuffs).toEqual([]);
    expect(reset.turnFlags).toEqual({});
    expect(reset.concentrationAura).toBeUndefined();
    expect(reset.concentratingOn).toBeUndefined();
    expect(reset.wildShape).toBeUndefined();
    expect(reset.swallowedTargetId).toBeUndefined();
    expect(reset.swallowedBy).toBeUndefined();
    expect(reset._wildShapeBeast).toBeUndefined();
    expect(reset._concentrationAura).toBeUndefined();
    expect(reset.dying).toBe(false);
    expect(reset.deathSaves).toBeUndefined();
    expect(reset.stats.damageTaken).toBe(0);
    expect(reset.stats.timesDowned).toBeUndefined();
  });

  it('mutates in place for battle-start and rematch flows', () => {
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 1), 'blue', { x: 1, y: 1 }, 0);
    fighter.currentHp = 0;
    fighter.dying = true;
    fighter.deathSaves = { successes: 0, failures: 1 };

    resetCreatureForBattleInPlace(fighter, { x: 2, y: 3 });

    expect(fighter.currentHp).toBe(fighter.maxHp);
    expect(fighter.position).toEqual({ x: 2, y: 3 });
    expect(fighter.dying).toBe(false);
    expect(fighter.deathSaves).toBeUndefined();
  });

  it('restores flying and legendary-action battle state for a fresh run', () => {
    const dragonData = {
      ...buildHero('Fighter', 1),
      name: 'Tiny Test Dragon',
      speed: { walk: 30, fly: 60 },
      legendaryActionUses: 3,
      legendaryActions: [{
        name: 'Tail Swipe',
        cost: 1,
        actionRef: 'Longsword',
        description: '.',
      }],
    };
    const dragon = createCreatureWithFixedHp(dragonData, 'red', { x: 1, y: 1 }, 0);
    dragon.airborne = false;
    dragon.legendaryActionsRemaining = 0;
    dragon.movementRemaining = 0;

    const reset = resetCreatureForBattle(dragon);

    expect(reset.airborne).toBe(true);
    expect(reset.legendaryActionsRemaining).toBe(3);
    expect(reset.movementRemaining).toBe(60);
  });
});
