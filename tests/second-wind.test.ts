import { describe, it, expect } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';

describe('Second Wind is a bonus action', () => {
  it('Second Wind action has isBonusAction flag', () => {
    const fighter = buildHero('Fighter', 3);
    const sw = fighter.actions.find(a => a.name === 'Second Wind');
    expect(sw).toBeDefined();
    expect(sw!.isBonusAction).toBe(true);
  });

  it('Fighter attacks AND heals in the same turn', () => {
    const fighter = buildHero('Fighter', 3);
    const barbarian = buildHero('Barbarian', 3);
    let healAndAttackSameTurn = false;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(fighter, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(barbarian, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      // Find turns where Fighter both healed (Second Wind) and attacked
      const fighterLogs = state.logs.filter(l => l.actor?.includes('Fighter'));
      let currentRound = -1;
      let healedThisTurn = false;
      let attackedThisTurn = false;
      for (const l of fighterLogs) {
        if (l.round !== currentRound) {
          if (healedThisTurn && attackedThisTurn) {
            healAndAttackSameTurn = true;
            break;
          }
          currentRound = l.round!;
          healedThisTurn = false;
          attackedThisTurn = false;
        }
        if (l.action === 'Second Wind') healedThisTurn = true;
        if (l.action === 'Longsword' && (l.damage ?? 0) > 0) attackedThisTurn = true;
      }
      if (healedThisTurn && attackedThisTurn) healAndAttackSameTurn = true;
      if (healAndAttackSameTurn) break;
    }
    expect(healAndAttackSameTurn).toBe(true);
  });
});
