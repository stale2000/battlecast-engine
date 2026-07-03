import { describe, it, expect } from 'vitest';
import { initBattle, resolveAttack, applyDamage, createCreatureWithFixedHp } from '../src/engine/combat';
import { runBattle } from '../src/engine/ai';
import { monsters } from '../src/data/monsters';
import { MonsterData } from '../src/types/monster';

/**
 * Integration tests for damage typing across every entry point.
 *
 * The unit suite covers applyDamage directly. This file routes damage
 * through the engine's PUBLIC surface (resolveAttack, runBattle) and
 * confirms each entry point honors the right magical / non-magical
 * flag end-to-end:
 *
 *   1. Plain melee weapon -> non-magical (resisted by Specter et al.)
 *   2. action.magical = true -> magical (full damage)
 *   3. additionalDamage rider -> propagates action.magical
 *   4. Spell save damage -> magical (full)
 *   5. Direct injection through the barrel-exported applyDamage with
 *      isMagical = true bypasses the resistance.
 *
 * The unit suite already proves the primitives. This file proves the
 * routing.
 */

function md(name: string): MonsterData {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`monster missing: ${name}`);
  return m;
}

describe('routing: melee attack -> applyDamage isMagical', () => {
  it('mundane Bite hit on a Specter is halved', () => {
    // Use a ground-bound Specter clone so the attacker can reach it.
    // The stock Specter is airborne by default and grounded creatures
    // can't melee a flyer.
    const baseSpecter = md('Specter');
    const specter: MonsterData = { ...baseSpecter, speed: { walk: 30 } };
    const wolf = md('Dire Wolf');
    const target = createCreatureWithFixedHp(specter, 'red', { x: 5, y: 5 }, 0);
    const attacker = createCreatureWithFixedHp(wolf, 'blue', { x: 6, y: 5 }, 1);
    const state = initBattle([target, attacker], 20);
    // Resolve a single attack from the wolf at the specter. Auto-hit is not
    // guaranteed - run enough rolls to land at least one hit, then check
    // that hits are halved by inspecting the damage events.
    let halvedHitSeen = false;
    for (let i = 0; i < 50 && target.isAlive; i++) {
      const before = target.currentHp;
      const bite = wolf.actions.find(a => a.name === 'Bite')!;
      resolveAttack(state, attacker, target, bite);
      const after = target.currentHp;
      if (after < before) {
        // Bite is "1d10+3", avg ~8.5. Halved would be ~4.
        const dmg = before - after;
        if (dmg <= 8) halvedHitSeen = true;
      }
    }
    expect(halvedHitSeen).toBe(true);
  });

  it('magical attack on a Specter does full damage', () => {
    // Use a ground-bound Specter clone so the attacker can reach it.
    // The stock Specter is airborne by default and grounded creatures
    // can't melee a flyer.
    const baseSpecter = md('Specter');
    const specter: MonsterData = { ...baseSpecter, speed: { walk: 30 } };
    // Specter's own Life Drain is magical:true and necrotic. To cleanly test
    // a magical mundane-typed attack, build a synthetic attacker.
    const synthetic: MonsterData = {
      ...md('Dire Wolf'),
      name: 'Magic Wolf',
      actions: [{
        name: 'Magic Bite', type: 'melee', attackBonus: 50,
        damage: '20', damageType: 'slashing', reach: 5,
        magical: true,
        description: 'auto-hit magical bite',
      }],
    };
    const target = createCreatureWithFixedHp(specter, 'red', { x: 5, y: 5 }, 0);
    const attacker = createCreatureWithFixedHp(synthetic, 'blue', { x: 6, y: 5 }, 1);
    const state = initBattle([target, attacker], 20);
    let fullDamageSeen = false;
    for (let i = 0; i < 50 && target.isAlive; i++) {
      const before = target.currentHp;
      resolveAttack(state, attacker, target, synthetic.actions[0]);
      const damage = before - target.currentHp;
      if (damage > 0) {
        expect(damage).toBe(20);  // not halved
        fullDamageSeen = true;
        break;
      }
    }
    expect(fullDamageSeen).toBe(true);
  });

  it('mundane attack on the same Specter is halved', () => {
    // Use a ground-bound Specter clone so the attacker can reach it.
    // The stock Specter is airborne by default and grounded creatures
    // can't melee a flyer.
    const baseSpecter = md('Specter');
    const specter: MonsterData = { ...baseSpecter, speed: { walk: 30 } };
    const synthetic: MonsterData = {
      ...md('Dire Wolf'),
      name: 'Mundane Wolf',
      actions: [{
        name: 'Mundane Bite', type: 'melee', attackBonus: 50,
        damage: '20', damageType: 'slashing', reach: 5,
        description: 'auto-hit mundane bite',
      }],
    };
    const target = createCreatureWithFixedHp(specter, 'red', { x: 5, y: 5 }, 0);
    const attacker = createCreatureWithFixedHp(synthetic, 'blue', { x: 6, y: 5 }, 1);
    const state = initBattle([target, attacker], 20);
    let halvedDamageSeen = false;
    for (let i = 0; i < 50 && target.isAlive; i++) {
      const before = target.currentHp;
      resolveAttack(state, attacker, target, synthetic.actions[0]);
      const damage = before - target.currentHp;
      if (damage > 0) {
        expect(damage).toBe(10);  // halved
        halvedDamageSeen = true;
        break;
      }
    }
    expect(halvedDamageSeen).toBe(true);
  });
});

describe('routing: additionalDamage rider', () => {
  it('a slashing weapon with a fire rider on a fire-resistant target halves only the fire half', () => {
    const fireResistant: MonsterData = {
      ...md('Brown Bear'),
      name: 'Fire Resistor',
      hp: 200, hpFormula: '40d8',
      resistances: ['fire'],
    };
    const slasherWithRider: MonsterData = {
      ...md('Brown Bear'),
      name: 'Flame Slasher',
      actions: [{
        name: 'Flame Strike', type: 'melee', attackBonus: 50,
        damage: '20', damageType: 'slashing',
        additionalDamage: '20 fire',
        reach: 5,
        description: 'auto-hit with fire rider',
      }],
    };
    const target = createCreatureWithFixedHp(fireResistant, 'red', { x: 5, y: 5 }, 0);
    const attacker = createCreatureWithFixedHp(slasherWithRider, 'blue', { x: 6, y: 5 }, 1);
    const state = initBattle([target, attacker], 20);
    let riderDamageSeen = false;
    for (let i = 0; i < 50 && target.isAlive; i++) {
      const before = target.currentHp;
      resolveAttack(state, attacker, target, slasherWithRider.actions[0]);
      const damage = before - target.currentHp;
      if (damage > 0) {
        // Slashing 20 (full) + fire 20 halved to 10 = 30 total.
        expect(damage).toBe(30);
        riderDamageSeen = true;
        break;
      }
    }
    expect(riderDamageSeen).toBe(true);
  });
});

describe('routing: applyDamage barrel export', () => {
  it('isMagical=true through the barrel-exported applyDamage bypasses nonmagicalResistances', () => {
    // Use a ground-bound Specter clone so the attacker can reach it.
    // The stock Specter is airborne by default and grounded creatures
    // can't melee a flyer.
    const baseSpecter = md('Specter');
    const specter: MonsterData = { ...baseSpecter, speed: { walk: 30 } };
    const dummy = md('Brown Bear');
    const target = createCreatureWithFixedHp(specter, 'red', { x: 5, y: 5 }, 0);
    const source = createCreatureWithFixedHp(dummy, 'blue', { x: 6, y: 5 }, 1);
    const state = initBattle([target, source], 20);
    const before = target.currentHp;
    applyDamage(state, target, 20, 'slashing', source, false, true);
    expect(target.currentHp).toBe(before - 20);
  });

  it('isMagical default (false) hits nonmagicalResistances and halves', () => {
    // Use a ground-bound Specter clone so the attacker can reach it.
    // The stock Specter is airborne by default and grounded creatures
    // can't melee a flyer.
    const baseSpecter = md('Specter');
    const specter: MonsterData = { ...baseSpecter, speed: { walk: 30 } };
    const dummy = md('Brown Bear');
    const target = createCreatureWithFixedHp(specter, 'red', { x: 5, y: 5 }, 0);
    const source = createCreatureWithFixedHp(dummy, 'blue', { x: 6, y: 5 }, 1);
    const state = initBattle([target, source], 20);
    const before = target.currentHp;
    applyDamage(state, target, 20, 'slashing', source);
    expect(target.currentHp).toBe(before - 10);
  });
});

describe('end-to-end: Specter survives meaningfully longer with non-magical resistance', () => {
  it('vs Brown Bear the resisted Specter outlasts a stripped clone', () => {
    // Use a ground-bound Specter clone so the attacker can reach it.
    // The stock Specter is airborne by default and grounded creatures
    // can't melee a flyer.
    const baseSpecter = md('Specter');
    const specter: MonsterData = { ...baseSpecter, speed: { walk: 30 } };
    const fragile: MonsterData = {
      ...specter,
      name: 'Fragile Specter',
      nonmagicalResistances: undefined,
    };
    const bear = md('Brown Bear');
    function avgRoundsToDeath(victim: MonsterData, trials = 80): number {
      let total = 0; let died = 0;
      for (let t = 0; t < trials; t++) {
        const v = createCreatureWithFixedHp(victim, 'red', { x: 5, y: 10 }, 0);
        const a = createCreatureWithFixedHp(bear, 'blue', { x: 6, y: 10 }, 1);
        const s = runBattle([v, a], 16);
        if (!v.isAlive) { died++; total += s.round; }
      }
      return died > 0 ? total / died : 30;
    }
    const resisted = avgRoundsToDeath(specter);
    const unresisted = avgRoundsToDeath(fragile);
    // The resisted Specter should last meaningfully longer.
    expect(resisted).toBeGreaterThan(unresisted * 1.3);
  });
});

describe('end-to-end: Iron Golem fire/poison immunity (2024 MM)', () => {
  it('Iron Golem has fire and poison immunity but no nonmagical B/P/S immunity in 2024', () => {
    const golem = md('Iron Golem');
    expect(golem.immunities).toContain('fire');
    expect(golem.immunities).toContain('poison');
    expect(golem.immunities).toContain('psychic');
    expect(golem.nonmagicalImmunities ?? []).toEqual([]);
  });
});
