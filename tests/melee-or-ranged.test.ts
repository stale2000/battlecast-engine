import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { executeTurn, runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp, DEFAULT_TACTICS, type BattleState } from '../src/engine/combat';
import type { Creature } from '../src/types/monster';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

function makeState(creatures: Creature[], gridSize = 20): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize,
    teamTactics: DEFAULT_TACTICS,
  };
}

describe('Melee-or-ranged actions work at range', () => {
  it('all "reach X or range Y" actions have a range field', () => {
    const rangePattern = /reach \d+ ft\. or range (\d+)\/(\d+) ft\./i;
    const rangePatternSimple = /reach \d+ ft\. or range (\d+) ft\./i;
    const issues: string[] = [];
    for (const m of monsters) {
      for (const a of m.actions) {
        const match = a.description.match(rangePattern) || a.description.match(rangePatternSimple);
        if (match && !a.range) {
          issues.push(`${m.name} → ${a.name}: description says ranged but no range field`);
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('Mage Arcane Burst can hit at 120 ft', () => {
    const mage = md('Mage');
    const burst = mage.actions.find(a => a.name === 'Arcane Burst');
    expect(burst).toBeDefined();
    expect(burst!.range).toBeDefined();
    expect(burst!.range!.normal).toBeGreaterThanOrEqual(120);
  });

  it('Lich Eldritch Burst can hit at 120 ft', () => {
    const lich = md('Lich');
    const burst = lich.actions.find(a => a.name === 'Eldritch Burst');
    expect(burst).toBeDefined();
    expect(burst!.range).toBeDefined();
    expect(burst!.range!.normal).toBeGreaterThanOrEqual(120);
  });

  it('Mage actually attacks from range instead of walking and failing', () => {
    const mage = md('Mage');
    const commoner = md('Commoner');
    let attacksMade = 0;
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(mage, 'red', { x: 2, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 18, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      // After the spellcasting overhaul, the Mage may open with Fireball
      // or Cone of Cold instead of Arcane Burst; any of those firing
      // proves the Mage is reaching the target from range.
      attacksMade += state.logs.filter(l =>
        l.action === 'Arcane Burst' || l.action === 'Fireball' || l.action === 'Cone of Cold'
      ).length;
    }
    expect(attacksMade).toBeGreaterThan(0);
  });

  it('Mage uses Arcane Burst as a repeatable ranged attack', () => {
    const mage = {
      ...md('Mage'),
      initialResources: {},
      actions: md('Mage').actions.filter(a => a.name === 'Arcane Burst' || a.name === 'Multiattack'),
    };
    const attacker = createCreatureWithFixedHp(mage, 'red', { x: 2, y: 10 }, 0);
    const target = createCreatureWithFixedHp(md('Commoner'), 'blue', { x: 18, y: 10 }, 1);
    target.currentHp = 100;
    target.maxHp = 100;
    const state = makeState([attacker, target], 20);

    executeTurn(state, attacker);

    const attackEvents = state.events.filter(e => e.kind === 'attack') as { kind: 'attack'; actionName: string; attackType: string }[];
    expect(attackEvents.some(e => e.actionName === 'Arcane Burst' && e.attackType === 'ranged')).toBe(true);
  });

  it.each([
    ['Guard', 'Spear'],
    ['Goblin Minion', 'Dagger'],
  ])('%s closes to melee before using %s', (monsterName, actionName) => {
    const attacker = createCreatureWithFixedHp(md(monsterName), 'red', { x: 2, y: 10 }, 0);
    const target = createCreatureWithFixedHp(md('Commoner'), 'blue', { x: 6, y: 10 }, 1);
    const state = makeState([attacker, target]);

    executeTurn(state, attacker);

    const attackEvents = state.events.filter(e => e.kind === 'attack') as { kind: 'attack'; actionName: string; attackType: string }[];
    expect(attackEvents.some(e => e.actionName === actionName && e.attackType === 'melee')).toBe(true);
    expect(attackEvents.some(e => e.actionName === actionName && e.attackType === 'ranged')).toBe(false);
    expect(attacker.stats.attacksMade).toBeGreaterThan(0);
    expect(state.logs.some(l => l.details.includes('cannot reach'))).toBe(false);
  });

  it('Goblin Minion does not throw Dagger when still outside melee after moving', () => {
    const goblin = createCreatureWithFixedHp(md('Goblin Minion'), 'red', { x: 2, y: 10 }, 0);
    const target = createCreatureWithFixedHp(md('Commoner'), 'blue', { x: 16, y: 10 }, 1);
    const state = makeState([goblin, target], 20);

    executeTurn(state, goblin);

    expect(goblin.position.x).toBeGreaterThan(2);
    expect(goblin.position.x).toBeLessThan(16);
    const attackEvents = state.events.filter(e => e.kind === 'attack') as { kind: 'attack'; actionName: string; attackType: string }[];
    expect(attackEvents.some(e => e.actionName === 'Dagger')).toBe(false);
    expect(state.logs.some(l => l.actor.includes('Goblin Minion') && l.action === 'Dash')).toBe(true);
  });

  it('Goblin Minion eventually reaches melee and attacks in a full battle', () => {
    const goblin = createCreatureWithFixedHp(md('Goblin Minion'), 'red', { x: 2, y: 10 }, 0);
    const target = createCreatureWithFixedHp(md('Commoner'), 'blue', { x: 16, y: 10 }, 1);
    target.currentHp = 100;
    target.maxHp = 100;

    const state = runBattle([goblin, target], 20);

    expect(state.logs.some(l => l.actor.includes('Goblin Minion') && l.action === 'Dagger')).toBe(true);
    expect(state.events.some(e => e.kind === 'attack'
      && e.attackerId === goblin.id
      && e.actionName === 'Dagger'
      && e.attackType === 'melee')).toBe(true);
  });
});
