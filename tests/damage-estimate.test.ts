import { describe, it, expect } from 'vitest';
import type { Creature, MonsterAction } from '../src/types/monster';
import { estimateActionDamage } from '../src/engine/ai-targeting';

/**
 * Minimal target factory. Only the fields adjustForResistance cares
 * about (immunities, resistances, vulnerabilities) actually need to be
 * present; everything else is filler so TypeScript is happy.
 */
function makeTarget(opts: { resistances?: string[]; immunities?: string[]; vulnerabilities?: string[] } = {}): Creature {
  return {
    id: 'target',
    name: 'Target',
    displayName: 'Target',
    monsterData: {
      name: 'Target',
      size: 'Medium',
      type: 'beast',
      alignment: 'neutral',
      ac: 10,
      hp: 100,
      hpFormula: '10d10',
      speed: { walk: 30 },
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      senses: '', languages: '',
      cr: '1', xp: 200, proficiencyBonus: 2,
      actions: [],
      resistances: opts.resistances,
      immunities: opts.immunities,
      vulnerabilities: opts.vulnerabilities,
    } as Creature['monsterData'],
    team: 'red',
    currentHp: 100, maxHp: 100,
    position: { x: 0, y: 0 },
    initiative: 10,
    conditions: [], conditionTimers: [],
    isAlive: true,
    hasActed: false,
    hasMovedThisTurn: false,
    movementRemaining: 30,
    recharges: {},
    stats: { damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksHit: 0, killCount: 0, roundsSurvived: 0, actionUsage: {} },
  };
}

describe('estimateActionDamage - damage type precedence', () => {
  it('applies fire resistance to a breath-weapon action (damage + savingThrow)', () => {
    // Typical breath weapon shape: typed damage + save-for-half rider.
    // The bug under test: estimateActionDamage was resolving the damage
    // type to "untyped" whenever a savingThrow.damageOnFail was present,
    // which made resistance checks silently skip typed breath weapons.
    const fireBreath: MonsterAction = {
      name: 'Fire Breath',
      type: 'special',
      damage: '8d6',
      damageType: 'fire',
      savingThrow: { ability: 'dex', dc: 15, damageOnFail: '8d6', damageOnSuccess: 'half', area: '30-foot Cone' },
      description: '30-ft cone, DC 15 Dex save, 8d6 fire (half on save).',
    };

    const fireResistantTarget = makeTarget({ resistances: ['fire'] });
    const plainTarget = makeTarget();

    const resistedDmg = estimateActionDamage(fireBreath, fireResistantTarget);
    const plainDmg = estimateActionDamage(fireBreath, plainTarget);

    expect(resistedDmg).toBeLessThan(plainDmg);
    // adjustForResistance halves (Math.floor) for resistance.
    expect(resistedDmg).toBe(Math.floor(plainDmg / 2));
  });

  it('zeroes out damage for an immune target', () => {
    const fireBreath: MonsterAction = {
      name: 'Fire Breath',
      type: 'special',
      damage: '8d6',
      damageType: 'fire',
      savingThrow: { ability: 'dex', dc: 15, damageOnFail: '8d6', damageOnSuccess: 'half' },
      description: 'Fire breath.',
    };
    const fireImmune = makeTarget({ immunities: ['fire'] });
    expect(estimateActionDamage(fireBreath, fireImmune)).toBe(0);
  });

  it('doubles damage for a vulnerable target', () => {
    const fireBreath: MonsterAction = {
      name: 'Fire Breath',
      type: 'special',
      damage: '8d6',
      damageType: 'fire',
      savingThrow: { ability: 'dex', dc: 15, damageOnFail: '8d6', damageOnSuccess: 'half' },
      description: 'Fire breath.',
    };
    const fireVulnerable = makeTarget({ vulnerabilities: ['fire'] });
    const plainTarget = makeTarget();
    expect(estimateActionDamage(fireBreath, fireVulnerable)).toBe(estimateActionDamage(fireBreath, plainTarget) * 2);
  });

  it('leaves untyped save-only actions unchanged by resistance', () => {
    // No damageType - damage truly is untyped. Resistance must not apply.
    const forceWave: MonsterAction = {
      name: 'Force Wave',
      type: 'special',
      savingThrow: { ability: 'str', dc: 15, damageOnFail: '4d6' },
      description: 'Untyped save-based damage.',
    };
    const fireResistantTarget = makeTarget({ resistances: ['fire'] });
    const plainTarget = makeTarget();
    expect(estimateActionDamage(forceWave, fireResistantTarget)).toBe(estimateActionDamage(forceWave, plainTarget));
  });
});
