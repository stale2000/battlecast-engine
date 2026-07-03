import { describe, expect, it } from 'vitest';
import { monsters } from '../src/data/monsters';
import { executeRound, executeTurn } from '../src/engine/ai';
import { createCreatureWithFixedHp, creatureDistance, DEFAULT_TACTICS, type BattleState } from '../src/engine/combat';
import type { Creature } from '../src/types/monster';

function md(name: string) {
  const monster = monsters.find(candidate => candidate.name === name);
  if (!monster) throw new Error(`Missing ${name}`);
  return monster;
}

function makeState(creatures: Creature[], gridSize = 28): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: creatures.map(creature => creature.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize,
    teamTactics: DEFAULT_TACTICS,
  };
}

describe('tarrasque versus ancient dragons corner engagement', () => {
  it('lets a gargantuan dragon engage a cornered tarrasque', () => {
    const tarrasque = createCreatureWithFixedHp(md('Tarrasque'), 'red', { x: 0, y: 0 }, 0);
    const dragon = createCreatureWithFixedHp(md('Ancient Red Dragon'), 'blue', { x: 14, y: 14 }, 0);
    const state = makeState([tarrasque, dragon]);

    executeTurn(state, dragon);

    expect(creatureDistance(dragon, tarrasque)).toBeLessThanOrEqual(15);
    expect(state.logs.some(log => log.actor === dragon.displayName && log.action === 'Rend')).toBe(true);
  });

  it('keeps at least one surviving dragon engaged with a cornered tarrasque across rounds', () => {
    const tarrasque = createCreatureWithFixedHp(md('Tarrasque'), 'red', { x: 0, y: 0 }, 0);
    const dragonA = createCreatureWithFixedHp(md('Ancient Red Dragon'), 'blue', { x: 18, y: 4 }, 0);
    const dragonB = createCreatureWithFixedHp(md('Ancient Red Dragon'), 'blue', { x: 18, y: 12 }, 1);
    const dragonC = createCreatureWithFixedHp(md('Ancient Red Dragon'), 'blue', { x: 18, y: 20 }, 2);
    const state = makeState([tarrasque, dragonA, dragonB, dragonC]);

    const idleRounds: string[] = [];
    for (let i = 0; i < 8 && !state.isComplete; i++) {
      const logStart = state.logs.length;
      executeRound(state);
      const aliveDragons = state.creatures.filter(creature =>
        creature.team === 'blue' && creature.isAlive && !creature.dying
      );
      const dragonAttacked = state.logs.slice(logStart).some(log =>
        log.actor?.startsWith('Ancient Red Dragon') && ['Rend', 'Tail', 'Fireball', 'Fire Breath'].includes(log.action)
      );
      if (aliveDragons.length > 0 && !dragonAttacked) {
        idleRounds.push(`round ${state.round - 1}: ${aliveDragons.map(creature => `${creature.displayName}@${creature.position.x},${creature.position.y}`).join('; ')}`);
      }
    }

    expect(idleRounds).toEqual([]);
  });

  it('actual gallery setup keeps surviving dragons engaged instead of idling', () => {
    const creatures = [
      createCreatureWithFixedHp(md('Tarrasque'), 'red', { x: 4, y: 10 }, 0),
      createCreatureWithFixedHp(md('Ancient Red Dragon'), 'blue', { x: 18, y: 5 }, 0),
      createCreatureWithFixedHp(md('Ancient Red Dragon'), 'blue', { x: 18, y: 12 }, 1),
      createCreatureWithFixedHp(md('Ancient Red Dragon'), 'blue', { x: 18, y: 19 }, 2),
    ];
    const state = makeState(creatures, 28);

    const idleRounds: string[] = [];
    for (let i = 0; i < 12 && !state.isComplete; i++) {
      const logStart = state.logs.length;
      executeRound(state);
      const aliveDragons = state.creatures.filter(creature =>
        creature.team === 'blue' && creature.isAlive && !creature.dying
      );
      const dragonAttacked = state.logs.slice(logStart).some(log =>
        log.actor?.startsWith('Ancient Red Dragon') && ['Rend', 'Tail', 'Fireball', 'Fire Breath'].includes(log.action)
      );
      if (aliveDragons.length > 0 && !dragonAttacked) {
        idleRounds.push(`round ${state.round - 1}: ${aliveDragons.map(creature => `${creature.displayName}@${creature.position.x},${creature.position.y}`).join('; ')}`);
      }
    }

    expect(idleRounds).toEqual([]);
  });
});
