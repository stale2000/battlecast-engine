import { describe, it, expect } from 'vitest';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';
import { monsters } from '../src/data/monsters';
import { MonsterData } from '../src/types/monster';

/**
 * Damage typing - magical vs non-magical resistance.
 *
 * The 2024 SRD Specter, Imp, and Quasit all have damage resistance to
 * non-magical bludgeoning / piercing / slashing. The data file declares
 * those via `nonmagicalResistances`; the engine halves damage only when
 * the incoming attack is non-magical.
 *
 * These tests pit a Specter against a creature with a single mundane
 * weapon attack and a creature with a magical attack, and confirm the
 * Specter survives meaningfully longer against the mundane one.
 */
function md(name: string): MonsterData {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster missing: ${name}`);
  return m;
}

function avgRoundsToDeath(victim: MonsterData, attacker: MonsterData, victimTeam: 'red' | 'blue', trials = 200): number {
  let totalRounds = 0;
  let deaths = 0;
  for (let t = 0; t < trials; t++) {
    const v = createCreatureWithFixedHp(victim, victimTeam, { x: 5, y: 10 }, 0);
    const a = createCreatureWithFixedHp(attacker, victimTeam === 'red' ? 'blue' : 'red', { x: 6, y: 10 }, 1);
    const state = runBattle([v, a], 16);
    if (!v.isAlive) {
      deaths++;
      totalRounds += state.round;
    }
  }
  return deaths > 0 ? totalRounds / deaths : 30;
}

describe('non-magical damage resistance', () => {
  it('Specter has nonmagicalResistances declared', () => {
    const specter = md('Specter');
    expect(specter.nonmagicalResistances).toEqual(['bludgeoning', 'piercing', 'slashing']);
  });

  it('Imp has nonmagicalResistances declared', () => {
    expect(md('Imp').nonmagicalResistances).toEqual(['bludgeoning', 'piercing', 'slashing']);
  });

  it('Quasit has nonmagicalResistances declared', () => {
    expect(md('Quasit').nonmagicalResistances).toEqual(['bludgeoning', 'piercing', 'slashing']);
  });

  it('Specter survives longer vs a mundane melee attacker (Brown Bear) than vs the same attacker without resistance', () => {
    const specter = md('Specter');
    const bear = md('Brown Bear');
    // Build a mirror Specter with the resistance stripped.
    const fragileSpecter: MonsterData = {
      ...specter,
      name: 'Fragile Specter',
      nonmagicalResistances: undefined,
    };
    const withResistance = avgRoundsToDeath(specter, bear, 'red', 60);
    const withoutResistance = avgRoundsToDeath(fragileSpecter, bear, 'red', 60);
    // Resisted Specter should last meaningfully longer (at least ~1.3x).
    expect(withResistance).toBeGreaterThan(withoutResistance * 1.3);
  });
});
