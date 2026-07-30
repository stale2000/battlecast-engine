import { describe, expect, it } from 'vitest';
import { buildCustomHero, executeRound, executeTurn } from '../src/index';

describe('public package API', () => {
  it('exports round and single-turn combat executors', () => {
    expect(typeof executeRound).toBe('function');
    expect(typeof executeTurn).toBe('function');
  });

  it('exports custom hero construction for consumers with authored character sheets', () => {
    const hero = buildCustomHero('Wizard', 1, {
      abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
      hpOverride: 9,
    });

    expect(hero.abilities.int).toBe(18);
    expect(hero.hp).toBe(9);
  });
});
