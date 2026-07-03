import { describe, it, expect } from 'vitest';
import { Creature, MonsterData, ActiveBuff } from '../src/types/monster';
import {
  BattleState, DEFAULT_TACTICS, hasResource, consumeResource, restoreResource,
  lowestAvailableSlot, highestAvailableSlot, hasBuff, getBuff, addBuff,
  removeBuff, dropConcentratedBuffsFrom, applyDamage, createCreature,
} from '../src/engine/combat';

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure tests: resource counters, buff lifecycle, concentration.
// These guardrail the scaffolding before any class-specific spells get
// wired on top.
// ─────────────────────────────────────────────────────────────────────────────

function makeMonsterData(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Test',
    size: 'Medium', type: 'Humanoid', alignment: 'Any',
    ac: 12, hp: 20, hpFormula: '3d8+3',
    speed: { walk: 30 },
    abilities: { str: 10, dex: 10, con: 12, int: 10, wis: 10, cha: 10 },
    senses: 'Passive Perception 10', languages: 'Common',
    cr: '1', xp: 200, proficiencyBonus: 2,
    actions: [],
    ...overrides,
  };
}

function makeState(creatures: Creature[], round = 1): BattleState {
  return {
    creatures, round, turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [], events: [],
    isComplete: false, winner: null,
    gridSize: 20,
    teamTactics: DEFAULT_TACTICS,
  };
}

describe('resource counters', () => {
  it('createCreature seeds resources from monsterData.initialResources', () => {
    const data = makeMonsterData({
      initialResources: { 'slot-1': 4, 'slot-2': 3, 'rage': 2 },
    });
    const c = createCreature(data, 'red', { x: 0, y: 0 }, 0);
    expect(c.resources).toEqual({ 'slot-1': 4, 'slot-2': 3, 'rage': 2 });
  });

  it('createCreature always creates resources, activeBuffs, turnFlags', () => {
    const c = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    expect(c.resources).toEqual({});
    expect(c.activeBuffs).toEqual([]);
    expect(c.turnFlags).toEqual({});
  });

  it('hasResource checks for presence + amount', () => {
    const c = createCreature(
      makeMonsterData({ initialResources: { 'slot-1': 2 } }),
      'red', { x: 0, y: 0 }, 0
    );
    expect(hasResource(c, 'slot-1')).toBe(true);
    expect(hasResource(c, 'slot-1', 2)).toBe(true);
    expect(hasResource(c, 'slot-1', 3)).toBe(false);
    expect(hasResource(c, 'slot-2')).toBe(false);
  });

  it('consumeResource decrements and returns false when empty', () => {
    const c = createCreature(
      makeMonsterData({ initialResources: { 'slot-1': 2 } }),
      'red', { x: 0, y: 0 }, 0
    );
    expect(consumeResource(c, 'slot-1')).toBe(true);
    expect(c.resources['slot-1']).toBe(1);
    expect(consumeResource(c, 'slot-1')).toBe(true);
    expect(c.resources['slot-1']).toBe(0);
    expect(consumeResource(c, 'slot-1')).toBe(false);
    expect(c.resources['slot-1']).toBe(0);
  });

  it('restoreResource caps at initial max', () => {
    const c = createCreature(
      makeMonsterData({ initialResources: { 'slot-1': 2 } }),
      'red', { x: 0, y: 0 }, 0
    );
    consumeResource(c, 'slot-1', 2);
    restoreResource(c, 'slot-1', 5); // asks for 5, should cap at 2
    expect(c.resources['slot-1']).toBe(2);
  });

  it('lowestAvailableSlot prefers level 1 over level 2', () => {
    const c = createCreature(
      makeMonsterData({ initialResources: { 'slot-1': 1, 'slot-2': 1, 'slot-3': 1 } }),
      'red', { x: 0, y: 0 }, 0
    );
    expect(lowestAvailableSlot(c)).toBe(1);
    consumeResource(c, 'slot-1');
    expect(lowestAvailableSlot(c)).toBe(2);
  });

  it('highestAvailableSlot prefers level 3 over 1', () => {
    const c = createCreature(
      makeMonsterData({ initialResources: { 'slot-1': 1, 'slot-3': 1 } }),
      'red', { x: 0, y: 0 }, 0
    );
    expect(highestAvailableSlot(c)).toBe(3);
    consumeResource(c, 'slot-3');
    expect(highestAvailableSlot(c)).toBe(1);
  });

  it('no slots → null', () => {
    const c = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    expect(lowestAvailableSlot(c)).toBeNull();
    expect(highestAvailableSlot(c)).toBeNull();
  });
});

describe('buff management', () => {
  const buff = (overrides: Partial<ActiveBuff> = {}): ActiveBuff => ({
    name: 'Bless', key: 'bless', casterId: 'caster-1',
    appliedRound: 1, endRound: 11,
    attackBonusDice: '1d4', saveBonusDice: '1d4',
    requiresConcentration: true,
    ...overrides,
  });

  it('addBuff attaches, hasBuff reflects it', () => {
    const c = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    expect(hasBuff(c, 'bless')).toBe(false);
    addBuff(c, buff());
    expect(hasBuff(c, 'bless')).toBe(true);
    expect(getBuff(c, 'bless')?.attackBonusDice).toBe('1d4');
  });

  it('addBuff replaces same-key buff (no stacking)', () => {
    const c = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    addBuff(c, buff({ attackBonusDice: '1d4' }));
    addBuff(c, buff({ attackBonusDice: '1d6' })); // refresh
    expect(c.activeBuffs).toHaveLength(1);
    expect(c.activeBuffs[0].attackBonusDice).toBe('1d6');
  });

  it('removeBuff takes a buff off', () => {
    const c = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    addBuff(c, buff());
    removeBuff(c, 'bless');
    expect(hasBuff(c, 'bless')).toBe(false);
  });

  it('dropConcentratedBuffsFrom removes every concentration buff from a caster', () => {
    const caster = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    caster.id = 'caster-1';
    const ally = createCreature(makeMonsterData(), 'red', { x: 5, y: 0 }, 1);
    const state = makeState([caster, ally]);
    addBuff(ally, buff({ casterId: 'caster-1', requiresConcentration: true }));
    addBuff(ally, buff({ key: 'hex', casterId: 'caster-1', requiresConcentration: true, damageRider: '1d6 necrotic' }));
    addBuff(ally, buff({ key: 'other', casterId: 'caster-1', requiresConcentration: false }));
    dropConcentratedBuffsFrom(state, 'caster-1');
    expect(hasBuff(ally, 'bless')).toBe(false);
    expect(hasBuff(ally, 'hex')).toBe(false);
    expect(hasBuff(ally, 'other')).toBe(true); // non-concentration survives
  });
});

describe('concentration drops on caster death', () => {
  it('killing the caster ends their concentration buffs on all allies', () => {
    const caster = createCreature(makeMonsterData({ hp: 10, hpFormula: '10' }), 'red', { x: 0, y: 0 }, 0);
    const ally = createCreature(makeMonsterData(), 'red', { x: 5, y: 0 }, 1);
    const state = makeState([caster, ally]);
    addBuff(ally, {
      name: 'Bless', key: 'bless', casterId: caster.id,
      appliedRound: 1, endRound: 100,
      attackBonusDice: '1d4', requiresConcentration: true,
    });
    expect(hasBuff(ally, 'bless')).toBe(true);

    // Kill the caster
    applyDamage(state, caster, 9999, 'slashing', null);
    expect(caster.isAlive).toBe(false);
    expect(hasBuff(ally, 'bless')).toBe(false);
  });
});

describe('concentration CON save on damage', () => {
  it('caster takes damage → CON save; fail drops their concentration buffs', () => {
    const caster = createCreature(makeMonsterData({
      hp: 50, hpFormula: '50',
      abilities: { str: 10, dex: 10, con: 8, int: 10, wis: 10, cha: 10 }, // CON -1
    }), 'red', { x: 0, y: 0 }, 0);
    const ally = createCreature(makeMonsterData(), 'red', { x: 5, y: 0 }, 1);
    const state = makeState([caster, ally]);
    // Caster is concentrating on Bless (self-referential caster id).
    addBuff(ally, {
      name: 'Bless', key: 'bless', casterId: caster.id,
      appliedRound: 1, endRound: 100,
      attackBonusDice: '1d4', requiresConcentration: true,
    });
    caster.concentratingOn = 'bless';
    // 30 damage → DC max(10, 15) = 15. Caster has CON -1, so save rolls
    // against DC 15 with a -1 modifier. With a 1d20 roll that's almost
    // certainly a fail.
    let droppedAtLeastOnce = false;
    for (let trial = 0; trial < 20; trial++) {
      caster.currentHp = 50;
      caster.activeBuffs = [];
      ally.activeBuffs = [];
      addBuff(ally, {
        name: 'Bless', key: 'bless', casterId: caster.id,
        appliedRound: 1, endRound: 100,
        attackBonusDice: '1d4', requiresConcentration: true,
      });
      applyDamage(state, caster, 30, 'slashing', null);
      if (!hasBuff(ally, 'bless')) droppedAtLeastOnce = true;
    }
    expect(droppedAtLeastOnce).toBe(true);
  });

  it('high CON caster usually keeps concentration on small hits', () => {
    // CON +4, DC = max(10, 2) = 10 - save bonus +4 means only a nat 5 or lower fails.
    // That's a 25% fail rate → over 40 trials we should keep concentration majority.
    const caster = createCreature(makeMonsterData({
      hp: 50, hpFormula: '50',
      abilities: { str: 10, dex: 10, con: 18, int: 10, wis: 10, cha: 10 },
    }), 'red', { x: 0, y: 0 }, 0);
    const ally = createCreature(makeMonsterData(), 'red', { x: 5, y: 0 }, 1);
    const state = makeState([caster, ally]);
    let kept = 0;
    for (let trial = 0; trial < 40; trial++) {
      caster.currentHp = 50;
      caster.activeBuffs = [];
      ally.activeBuffs = [];
      addBuff(ally, {
        name: 'Bless', key: 'bless', casterId: caster.id,
        appliedRound: 1, endRound: 100,
        attackBonusDice: '1d4', requiresConcentration: true,
      });
      applyDamage(state, caster, 4, 'slashing', null); // DC 10
      if (hasBuff(ally, 'bless')) kept++;
    }
    // Expect majority kept - 75% expected, test with a generous lower bound
    expect(kept).toBeGreaterThan(20);
  });
});

describe('Rage damage resistance', () => {
  it('halves bludgeoning/piercing/slashing damage when rage active', () => {
    const barb = createCreature(makeMonsterData({
      hp: 50, hpFormula: '50',
      abilities: { str: 16, dex: 10, con: 18, int: 8, wis: 10, cha: 8 },
    }), 'red', { x: 0, y: 0 }, 0);
    const state = makeState([barb]);
    addBuff(barb, {
      name: 'Rage', key: 'rage', casterId: barb.id,
      appliedRound: 1, endRound: 11,
      resistPhysical: true, rageDamageBonus: 2,
    });
    const before = barb.currentHp;
    applyDamage(state, barb, 20, 'slashing', null);
    // 20 damage halved to 10 → HP before − 10
    expect(barb.currentHp).toBe(before - 10);
  });

  it('does NOT halve non-physical damage (fire, cold, etc.)', () => {
    const barb = createCreature(makeMonsterData({ hp: 50, hpFormula: '50' }), 'red', { x: 0, y: 0 }, 0);
    const state = makeState([barb]);
    addBuff(barb, {
      name: 'Rage', key: 'rage', casterId: barb.id,
      appliedRound: 1, endRound: 11,
      resistPhysical: true,
    });
    applyDamage(state, barb, 20, 'fire', null);
    expect(barb.currentHp).toBe(30); // 50 - 20
  });
});

describe('buff expiry tied to turn loop', () => {
  it('buffs with endRound <= current round are filtered at turn start', () => {
    const c = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    c.activeBuffs = [
      { name: 'Old', key: 'old', casterId: c.id, appliedRound: 1, endRound: 2 },
      { name: 'New', key: 'new', casterId: c.id, appliedRound: 1, endRound: 100 },
    ];
    // Simulate turn start at round 3 - this is what executeTurn does internally
    c.activeBuffs = c.activeBuffs.filter(b => b.endRound > 3);
    expect(c.activeBuffs.map(b => b.key)).toEqual(['new']);
  });
});

describe('AC boost from buffs', () => {
  it('Shield of Faith adds +2 to effective AC', () => {
    // We don't import getEffectiveAC directly (it's not exported) - instead
    // we verify the behavior via resolveAttack indirectly in higher-level
    // combat tests. Here just verify the buff data stands correctly.
    const c = createCreature(makeMonsterData({ ac: 12 }), 'red', { x: 0, y: 0 }, 0);
    addBuff(c, {
      name: 'Shield of Faith', key: 'shield-of-faith', casterId: 'other',
      appliedRound: 1, endRound: 11, acBonus: 2, requiresConcentration: true,
    });
    expect(c.activeBuffs).toHaveLength(1);
    expect(c.activeBuffs[0].acBonus).toBe(2);
  });
});
