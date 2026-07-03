import { describe, it, expect } from 'vitest';
import { Creature, MonsterData, MonsterAction } from '../src/types/monster';
import {
  BattleState, DEFAULT_TACTICS, createCreature,
  executeSpell, applyHealing, applyAutoDarts, applyBuffFromSpell,
  hasBuff, tryUseBonusActionDamageBuff,
} from '../src/engine/combat';

function makeMonsterData(overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    name: 'Test',
    size: 'Medium', type: 'Humanoid', alignment: 'Any',
    ac: 12, hp: 20, hpFormula: '20',
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

describe('applyHealing', () => {
  it('restores HP and caps at maxHp', () => {
    const h = createCreature(makeMonsterData({ hp: 20 }), 'red', { x: 0, y: 0 }, 0);
    const s = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 1);
    h.currentHp = 5;
    applyHealing(makeState([h, s]), h, 100, s, 'Cure Wounds');
    expect(h.currentHp).toBe(20);
  });

  it('no-ops on dead creatures (Cure Wounds needs a conscious target)', () => {
    const h = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    const s = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 1);
    h.isAlive = false;
    h.currentHp = 0;
    applyHealing(makeState([h, s]), h, 50, s, 'Cure Wounds');
    expect(h.currentHp).toBe(0);
    expect(h.isAlive).toBe(false);
  });

  it('emits a heal event with HP before/after', () => {
    const h = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    const s = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 1);
    const state = makeState([h, s]);
    h.currentHp = 10;
    applyHealing(state, h, 5, s, 'Cure Wounds');
    const ev = state.events.find(e => e.kind === 'heal');
    expect(ev).toBeDefined();
    if (ev?.kind === 'heal') {
      expect(ev.creatureId).toBe(h.id);
      expect(ev.creatureHpBefore).toBe(10);
      expect(ev.creatureHpAfter).toBe(15);
    }
  });
});

describe('applyAutoDarts (Magic Missile)', () => {
  it('deals damage to all targets without rolling attack', () => {
    const caster = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    const t1 = createCreature(makeMonsterData({ hp: 20 }), 'blue', { x: 5, y: 0 }, 1);
    const t2 = createCreature(makeMonsterData({ hp: 20 }), 'blue', { x: 10, y: 0 }, 2);
    const state = makeState([caster, t1, t2]);
    const action: MonsterAction = {
      name: 'Magic Missile', type: 'special',
      description: '3 darts, each 1d4+1 force',
      autoDarts: 3, autoDartDamage: '1d4+1', autoDartDamageType: 'force',
    };
    // 3 darts: split 2 to t1, 1 to t2
    applyAutoDarts(state, caster, action, [t1, t1, t2]);
    // Each dart does 2-5 damage. t1 took 2 darts (4-10), t2 took 1 (2-5).
    expect(t1.currentHp).toBeLessThan(20);
    expect(t2.currentHp).toBeLessThan(20);
    // Both hit
    expect(t1.currentHp).toBeLessThanOrEqual(20 - 4);
    expect(t2.currentHp).toBeLessThanOrEqual(20 - 2);
  });
});

describe('applyBuffFromSpell', () => {
  it('attaches a Bless-shaped buff with the right endRound', () => {
    const caster = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    const ally = createCreature(makeMonsterData(), 'red', { x: 5, y: 0 }, 1);
    const state = makeState([caster, ally], 3);
    const action: MonsterAction = {
      name: 'Bless', type: 'special',
      description: 'Bless up to 3 creatures; +1d4 on attacks and saves.',
      spellLevel: 1,
      concentration: true,
      durationRounds: 10,
      buff: {
        name: 'Bless', key: 'bless',
        requiresConcentration: true,
        attackBonusDice: '1d4',
        saveBonusDice: '1d4',
      },
    };
    applyBuffFromSpell(state, caster, ally, action);
    expect(hasBuff(ally, 'bless')).toBe(true);
    const b = ally.activeBuffs.find(x => x.key === 'bless')!;
    expect(b.casterId).toBe(caster.id);
    expect(b.appliedRound).toBe(3);
    expect(b.endRound).toBe(13); // 3 + 10
  });

  it('casting a new concentration spell drops the prior one', () => {
    const caster = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    const a = createCreature(makeMonsterData(), 'red', { x: 5, y: 0 }, 1);
    const b = createCreature(makeMonsterData(), 'red', { x: 10, y: 0 }, 2);
    const state = makeState([caster, a, b]);
    const blessAction: MonsterAction = {
      name: 'Bless', type: 'special', description: '',
      spellLevel: 1, durationRounds: 10,
      buff: {
        name: 'Bless', key: 'bless',
        requiresConcentration: true, attackBonusDice: '1d4',
      },
    };
    const shieldAction: MonsterAction = {
      name: 'Shield of Faith', type: 'special', description: '',
      spellLevel: 1, durationRounds: 10,
      buff: {
        name: 'Shield of Faith', key: 'shield-of-faith',
        requiresConcentration: true, acBonus: 2,
      },
    };
    applyBuffFromSpell(state, caster, a, blessAction);
    expect(hasBuff(a, 'bless')).toBe(true);
    // Cast Shield of Faith - different concentration spell
    applyBuffFromSpell(state, caster, b, shieldAction);
    expect(hasBuff(a, 'bless')).toBe(false);  // dropped
    expect(hasBuff(b, 'shield-of-faith')).toBe(true);
  });

  it('Aid increases current and maximum HP for up to three allies', () => {
    const allies = Array.from({ length: 7 }, (_, i) =>
      createCreature(makeMonsterData(), 'red', { x: i + 1, y: 0 }, i)
    );
    const caster = allies[0];
    caster.resources = { 'slot-2': 1 };
    const state = makeState(allies);
    const aidAction: MonsterAction = {
      name: 'Aid',
      type: 'special',
      description: 'Bolster up to 3 allies within 30 ft.',
      spellLevel: 2,
      range: { normal: 30, long: 30 },
      targetScope: 'all_allies_in_area',
      buff: { name: 'Aid', key: 'aid', maxHpBonus: 5 },
    };

    expect(executeSpell(state, caster, aidAction, caster)).toBe(true);

    const boosted = allies.filter(a => hasBuff(a, 'aid'));
    expect(boosted).toHaveLength(3);
    for (const ally of boosted) {
      expect(ally.maxHp).toBe(25);
      expect(ally.currentHp).toBe(25);
    }
    expect(allies.filter(a => a.maxHp === 20)).toHaveLength(4);
  });
});

describe('executeSpell: slot consumption', () => {
  it('consumes the right slot level', () => {
    const caster = createCreature(makeMonsterData({
      initialResources: { 'slot-1': 2, 'slot-2': 1 },
    }), 'red', { x: 0, y: 0 }, 0);
    const target = createCreature(makeMonsterData(), 'blue', { x: 5, y: 0 }, 1);
    const state = makeState([caster, target]);
    const action: MonsterAction = {
      name: 'Magic Missile', type: 'special', description: '',
      spellLevel: 1, autoDarts: 3, autoDartDamage: '1d4+1', autoDartDamageType: 'force',
    };
    executeSpell(state, caster, action, target, [target, target, target]);
    expect(caster.resources['slot-1']).toBe(1);
    expect(caster.resources['slot-2']).toBe(1);
  });

  it('cantrips cost no slot', () => {
    const caster = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    const target = createCreature(makeMonsterData(), 'blue', { x: 5, y: 0 }, 1);
    const state = makeState([caster, target]);
    const action: MonsterAction = {
      name: 'Fire Bolt', type: 'ranged',
      attackBonus: 5, damage: '1d10', damageType: 'fire',
      range: { normal: 120, long: 120 },
      description: '',
      spellLevel: 0,
    };
    expect(caster.resources).toEqual({});
    executeSpell(state, caster, action, target);
    expect(caster.resources).toEqual({});
  });

  it('returns false and skips effect when out of slots', () => {
    const caster = createCreature(makeMonsterData(), 'red', { x: 0, y: 0 }, 0);
    const target = createCreature(makeMonsterData(), 'blue', { x: 5, y: 0 }, 1);
    const state = makeState([caster, target]);
    const startTargetHp = target.currentHp;
    const action: MonsterAction = {
      name: 'Magic Missile', type: 'special',
      spellLevel: 1, autoDarts: 3, autoDartDamage: '1d4+1', autoDartDamageType: 'force',
      description: '',
    };
    const fired = executeSpell(state, caster, action, target, [target]);
    expect(fired).toBe(false);
    expect(target.currentHp).toBe(startTargetHp);
  });
});

describe('executeSpell: dispatch', () => {
  it('dispatches heal spell to applyHealing', () => {
    const caster = createCreature(makeMonsterData({
      initialResources: { 'slot-1': 1 },
    }), 'red', { x: 0, y: 0 }, 0);
    const ally = createCreature(makeMonsterData(), 'red', { x: 5, y: 0 }, 1);
    ally.currentHp = 5;
    const state = makeState([caster, ally]);
    const action: MonsterAction = {
      name: 'Cure Wounds', type: 'special',
      description: '',
      spellLevel: 1,
      heal: { dice: '1d8', addCastingMod: true },
      castingAbility: 'wis',
    };
    executeSpell(state, caster, action, ally);
    expect(ally.currentHp).toBeGreaterThan(5);
    expect(caster.resources['slot-1']).toBe(0);
  });

  it('dispatches attack-roll spell to resolveAttack', () => {
    // Run 3 times to avoid nat-1 auto-miss flake (5% per trial)
    let hitAtLeastOnce = false;
    for (let i = 0; i < 3; i++) {
      const caster = createCreature(makeMonsterData({
        abilities: { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 },
      }), 'red', { x: 0, y: 0 }, 0);
      const target = createCreature(makeMonsterData({ ac: 5 }), 'blue', { x: 2, y: 0 }, 1);
      const state = makeState([caster, target]);
      const startHp = target.currentHp;
      const action: MonsterAction = {
        name: 'Fire Bolt', type: 'ranged',
        attackBonus: 10,
        damage: '1d10', damageType: 'fire',
        range: { normal: 120, long: 120 },
        description: '',
        spellLevel: 0,
      };
      executeSpell(state, caster, action, target);
      if (target.currentHp < startHp) { hitAtLeastOnce = true; break; }
    }
    expect(hitAtLeastOnce).toBe(true);
  });
});

describe('spell slot upcasting', () => {
  it('Warlock with only L2 slots can cast Hex (spellLevel 1)', () => {
    // Mimics Warlock L3's initialResources: { 'slot-2': 2 } - no slot-1.
    const caster = createCreature(makeMonsterData({
      initialResources: { 'slot-2': 2 },
    }), 'red', { x: 0, y: 0 }, 0);
    const target = createCreature(makeMonsterData(), 'blue', { x: 5, y: 0 }, 1);
    const state = makeState([caster, target]);
    const hex: MonsterAction = {
      name: 'Hex', type: 'special', description: '',
      spellLevel: 1, concentration: true, durationRounds: 30,
      buff: {
        name: 'Hex', key: 'hex',
        requiresConcentration: true, damageRider: '1d6 necrotic',
      },
      targetScope: 'one_enemy',
    };
    const cast = executeSpell(state, caster, hex, target);
    expect(cast).toBe(true);
    expect(caster.resources['slot-2']).toBe(1);    // L2 slot consumed
    expect(hasBuff(target, 'hex')).toBe(true);     // Hex attached
  });

  it('consumes the LOWEST viable slot, not always the matching level', () => {
    // Caster has 1 × slot-1 and 2 × slot-2. Casting Hex (spellLevel 1)
    // should spend the L1 slot, leaving L2 slots intact for bigger spells.
    const caster = createCreature(makeMonsterData({
      initialResources: { 'slot-1': 1, 'slot-2': 2 },
    }), 'red', { x: 0, y: 0 }, 0);
    const target = createCreature(makeMonsterData(), 'blue', { x: 5, y: 0 }, 1);
    const state = makeState([caster, target]);
    const hex: MonsterAction = {
      name: 'Hex', type: 'special', description: '',
      spellLevel: 1, concentration: true, durationRounds: 30,
      buff: {
        name: 'Hex', key: 'hex',
        requiresConcentration: true, damageRider: '1d6 necrotic',
      },
      targetScope: 'one_enemy',
    };
    executeSpell(state, caster, hex, target);
    expect(caster.resources['slot-1']).toBe(0);    // lowest first
    expect(caster.resources['slot-2']).toBe(2);    // L2 untouched
  });
});

describe('Witch Bolt 2024 link', () => {
  it('creates a concentration link on cast and spends a later bonus action for automatic damage', () => {
    const caster = createCreature(makeMonsterData({
      initialResources: { 'slot-1': 1 },
      abilities: { str: 8, dex: 14, con: 14, int: 10, wis: 12, cha: 17 },
    }), 'red', { x: 0, y: 0 }, 0);
    const target = createCreature(makeMonsterData({ ac: 30, hp: 100, hpFormula: '100' }), 'blue', { x: 5, y: 0 }, 1);
    const state = makeState([caster, target]);
    const witchBolt: MonsterAction = {
      name: 'Witch Bolt', type: 'ranged', description: '',
      spellLevel: 1, concentration: true, durationRounds: 10,
      attackBonus: -99, damage: '2d12', damageType: 'lightning',
      buff: {
        name: 'Witch Bolt', key: 'witch-bolt',
        requiresConcentration: true,
        bonusActionDamage: '1d12',
        bonusActionDamageType: 'lightning',
        bonusActionDamageRange: 60,
        endsWhenTargetDies: true,
      },
      range: { normal: 60, long: 60 },
      targetScope: 'one_enemy',
    };

    expect(executeSpell(state, caster, witchBolt, target)).toBe(true);
    expect(hasBuff(target, 'witch-bolt')).toBe(true);
    expect(caster.concentratingOn).toBe('witch-bolt');

    const hpAfterCast = target.currentHp;
    state.round = 2;
    expect(tryUseBonusActionDamageBuff(state, caster)).toBe(true);
    expect(caster.bonusActionUsed).toBe(true);
    expect(target.currentHp).toBeLessThan(hpAfterCast);
  });
});

describe('concentration dropped when caster casts a different concentration spell', () => {
  it('drops bless when shield-of-faith is cast', () => {
    const caster = createCreature(makeMonsterData({
      initialResources: { 'slot-1': 5 },
    }), 'red', { x: 0, y: 0 }, 0);
    const a = createCreature(makeMonsterData(), 'red', { x: 1, y: 0 }, 1);
    const b = createCreature(makeMonsterData(), 'red', { x: 2, y: 0 }, 2);
    const state = makeState([caster, a, b]);
    const bless: MonsterAction = {
      name: 'Bless', type: 'special', description: '',
      spellLevel: 1, durationRounds: 10,
      buff: { name: 'Bless', key: 'bless', requiresConcentration: true, attackBonusDice: '1d4' },
    };
    const shield: MonsterAction = {
      name: 'Shield of Faith', type: 'special', description: '',
      spellLevel: 1, durationRounds: 10,
      buff: { name: 'Shield of Faith', key: 'shield-of-faith', requiresConcentration: true, acBonus: 2 },
    };
    executeSpell(state, caster, bless, a);
    executeSpell(state, caster, shield, b);
    expect(hasBuff(a, 'bless')).toBe(false);
    expect(hasBuff(b, 'shield-of-faith')).toBe(true);
  });
});

describe('Sleep (2024 HP-pool rules)', () => {
  function sleepAction(): MonsterAction {
    return {
      name: 'Sleep', type: 'special',
      description: '',
      spellLevel: 1, castingAbility: 'int',
      savingThrow: {
        ability: 'wis', dc: 0,
        hpPoolDice: '5d8',
        conditionOnFail: 'unconscious',
        conditionDuration: '1_minute',
        area: '20-foot sphere',
      },
      targetScope: 'area_enemies',
    };
  }

  it('knocks out the lowest-HP enemy; skips the 100-HP one even on max roll', () => {
    const caster = createCreature(makeMonsterData({ initialResources: { 'slot-1': 1 } }),
      'red', { x: 0, y: 0 }, 0);
    // 5d8 range is 5-40. 1-HP target always fits; 100-HP target never fits.
    const weak = createCreature(makeMonsterData({ hp: 1, hpFormula: '1' }), 'blue', { x: 1, y: 0 }, 1);
    const tough = createCreature(makeMonsterData({ hp: 100, hpFormula: '100' }), 'blue', { x: 2, y: 0 }, 2);
    const state = makeState([caster, weak, tough]);

    executeSpell(state, caster, sleepAction(), weak, [weak, tough]);

    expect(weak.conditions).toContain('unconscious');
    expect(tough.conditions).not.toContain('unconscious');
  });

  it('pushes an aoe event with Sleep as spellName (no save events)', () => {
    const caster = createCreature(makeMonsterData({ initialResources: { 'slot-1': 1 } }),
      'red', { x: 0, y: 0 }, 0);
    const t = createCreature(makeMonsterData({ hp: 3 }), 'blue', { x: 1, y: 0 }, 1);
    const state = makeState([caster, t]);

    executeSpell(state, caster, sleepAction(), t, [t]);

    const aoe = state.events.find(e => e.kind === 'aoe');
    expect(aoe).toBeDefined();
    if (aoe?.kind === 'aoe') expect(aoe.spellName).toBe('Sleep');
    // No save events - Sleep has no save under the HP-pool rule.
    expect(state.events.find(e => e.kind === 'save')).toBeUndefined();
  });
});
