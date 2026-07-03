import { describe, expect, it } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { monsters } from '../src/data/monsters';
import { executeTurn } from '../src/engine/ai';
import { createCreatureWithFixedHp, initBattle, DEFAULT_TACTICS, creatureDistance } from '../src/engine/combat';
import { deriveProfile } from '../src/engine/ai-movement-evaluator';

describe('Ranger positioning against reach monsters', () => {
  it('does not walk into Black Pudding reach just to fire a longbow', () => {
    const blackPudding = monsters.find(m => m.name === 'Black Pudding');
    expect(blackPudding).toBeDefined();

    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 5), 'blue', { x: 5, y: 5 }, 0);
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 5), 'blue', { x: 4, y: 5 }, 1);
    const paladin = createCreatureWithFixedHp(buildHero('Paladin', 5), 'blue', { x: 6, y: 5 }, 2);
    const pudding = createCreatureWithFixedHp(blackPudding!, 'red', { x: 10, y: 5 }, 0);
    const state = initBattle([ranger, fighter, paladin, pudding], 20);
    state.teamTactics = { ...DEFAULT_TACTICS, blue: 'smart', red: 'smart' };

    expect(deriveProfile(ranger).archetype).toBe('ranged');

    executeTurn(state, ranger);

    const rangerDistanceToPudding = creatureDistance(ranger, pudding);
    expect(rangerDistanceToPudding).toBeGreaterThan(10);
    expect(state.logs.some(l => l.actor === ranger.displayName && l.action === 'Longbow')).toBe(true);
  });
});
