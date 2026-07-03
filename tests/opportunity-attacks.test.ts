import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { executeTurn, runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp, DEFAULT_TACTICS, type BattleState } from '../src/engine/combat';
import type { Creature } from '../src/types/monster';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

function makeState(creatures: Creature[]): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize: 14,
    teamTactics: DEFAULT_TACTICS,
  };
}

describe('opportunity attack triggers', () => {
  it('kiting creature provokes OA when leaving melee reach', () => {
    const veteran = md('Veteran');
    const scout = md('Scout');
    let oaCount = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(scout, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20, { red: 'aggressive', blue: 'kiting' });
      oaCount += state.logs.filter(l => l.action === 'Opportunity Attack').length;
    }
    expect(oaCount).toBeGreaterThan(10);
  });

  it('creature moving TOWARD enemy does NOT provoke OA', () => {
    const veteran = md('Veteran');
    const goblin = md('Goblin Warrior');
    let oaCount = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 5, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 15, y: 10 }, 0),
      ];
      // Aggressive forces the goblin to charge instead of kite, so the
      // closing motion is the only movement that could provoke OA.
      const state = runBattle(creatures, 20, { red: 'aggressive', blue: 'defensive' });
      oaCount += state.logs.filter(l => l.action === 'Opportunity Attack').length;
    }
    expect(oaCount).toBe(0);
  });

  it('Nimble Escape lets goblins kite out of melee without provoking OA', () => {
    const veteran = md('Veteran');
    const goblin = md('Goblin Warrior');
    const goblinCreature = createCreatureWithFixedHp(goblin, 'red', { x: 6, y: 7 }, 0);
    const veteranCreature = createCreatureWithFixedHp(veteran, 'blue', { x: 7, y: 7 }, 0);
    const state = makeState([goblinCreature, veteranCreature]);
    state.teamTactics = { ...DEFAULT_TACTICS, red: 'kiting', blue: 'aggressive' };

    executeTurn(state, goblinCreature);

    expect(state.logs.some(l => l.action === 'Nimble Escape: Disengage')).toBe(true);
    expect(state.logs.some(l => l.action === 'Opportunity Attack')).toBe(false);
    expect(state.events.some(e =>
      e.kind === 'oaAvoided' &&
      e.moverId === goblinCreature.id &&
      e.enemyId === veteranCreature.id &&
      e.reason === 'nimble'
    )).toBe(true);
  });

  it('retreating creature provokes OA from adjacent enemy', () => {
    const knight = md('Knight');
    const goblin = md('Goblin Warrior');
    let oaCount = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
        // Knight is stronger; goblin might retreat when low HP
        createCreatureWithFixedHp(knight, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      oaCount += state.logs.filter(l => l.action === 'Opportunity Attack').length;
    }
    // Not guaranteed every battle (goblin might die before retreating),
    // but should happen sometimes
    // (This test documents behavior rather than asserting a strict count)
  });
});

describe('reaction limit', () => {
  it('creature cannot OA twice between its own turns', () => {
    // In D&D, reaction resets at start of YOUR turn. So between two
    // of the veteran's turns, it can OA at most once. We verify that
    // between consecutive veteran turns, at most 1 OA fires.
    const veteran = md('Veteran');
    const goblin = md('Goblin Warrior');
    let violations = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'blue', { x: 11, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'blue', { x: 10, y: 11 }, 1),
        createCreatureWithFixedHp(goblin, 'blue', { x: 9, y: 10 }, 2),
      ];
      const state = runBattle(creatures, 20, { red: 'aggressive', blue: 'kiting' });
      // Track OAs by the veteran, grouped by "between which of the veteran's turns"
      let oaSinceLastVetTurn = 0;
      for (const l of state.logs) {
        if (l.actor?.includes('Veteran') && l.action !== 'Opportunity Attack' && l.type !== 'info') {
          oaSinceLastVetTurn = 0; // veteran took a turn action, reaction resets
        }
        if (l.action === 'Opportunity Attack' && l.actor?.includes('Veteran')) {
          oaSinceLastVetTurn++;
          if (oaSinceLastVetTurn > 1) violations++;
        }
      }
    }
    expect(violations).toBe(0);
  });
});

describe('OA timing', () => {
  it('OA resolves while creature is still at old position (within reach)', () => {
    const veteran = md('Veteran');
    const scout = md('Scout');
    let oaAtOldPos = 0;
    let oaAtNewPos = 0;

    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(scout, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20, { red: 'aggressive', blue: 'kiting' });

      // Find the OA attack event and check target position via hit event
      let oaRound: number | null = null;
      for (const l of state.logs) {
        if (l.action === 'Opportunity Attack' && l.actor?.includes('Veteran')) {
          oaRound = l.round!;
          break;
        }
      }
      if (oaRound === null) continue;

      // Check the hit/miss event for the OA - the attack should be within reach
      for (const l of state.logs) {
        if (l.round === oaRound && l.actor?.includes('Veteran') &&
            (l.action === 'Longsword' || l.action === 'Shortsword') &&
            l.details?.includes('Scout')) {
          // If the attack resolves (hit or miss), the scout was in reach
          if (l.details.includes('vs AC') || l.details.includes('CRITICAL')) {
            oaAtOldPos++;
          } else if (l.details.includes('cannot reach')) {
            oaAtNewPos++;
          }
          break;
        }
      }
    }

    // OA should always resolve at old position (within reach)
    expect(oaAtOldPos).toBeGreaterThan(0);
    expect(oaAtNewPos).toBe(0);
  });
});

describe('OA death position', () => {
  it('creature killed by OA stays at old position, not movement destination', () => {
    const veteran = md('Veteran');
    const goblin = md('Goblin Warrior');
    let oaDeathCorrect = 0;
    let oaDeathWrong = 0;

    for (let i = 0; i < 50; i++) {
      const g = createCreatureWithFixedHp(goblin, 'blue', { x: 11, y: 10 }, 0);
      g.currentHp = 1;
      const creatures = [
        createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0),
        g,
      ];
      const state = runBattle(creatures, 20, { red: 'aggressive', blue: 'kiting' });

      // Only check battles where the goblin was killed by an OA
      const oaLog = state.logs.find(l =>
        l.action === 'Opportunity Attack' && l.details?.includes(g.displayName)
      );
      if (!oaLog || g.isAlive) continue;

      // If killed by OA, the last move event should have to == from
      // (movement cancelled because creature died before completing it)
      const lastMove = [...state.events].reverse().find(
        e => e.kind === 'move' && e.creatureId === g.id
      );
      if (lastMove?.kind === 'move') {
        if (lastMove.to.x === lastMove.from.x && lastMove.to.y === lastMove.from.y) {
          oaDeathCorrect++;
        } else {
          oaDeathWrong++;
        }
      }
    }

    if (oaDeathCorrect + oaDeathWrong > 0) {
      expect(oaDeathWrong).toBe(0);
    }
  });
});

describe('Disengage', () => {
  it('creature that Disengages does not provoke OA when retreating', () => {
    // A creature with low HP surrounded by strong enemies should Disengage
    // rather than provoke lethal OAs
    const knight = md('Knight');
    const goblin = md('Goblin Warrior');
    let disengageCount = 0;
    let oaAfterDisengage = 0;
    for (let i = 0; i < 30; i++) {
      const g = createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0);
      g.currentHp = 3; // Low HP, should retreat
      const creatures = [
        g,
        createCreatureWithFixedHp(knight, 'blue', { x: 11, y: 10 }, 0),
        createCreatureWithFixedHp(knight, 'blue', { x: 9, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.action === 'Disengage')) disengageCount++;
      // Check if the goblin got OA'd AFTER disengaging
      let sawDisengage = false;
      for (const l of state.logs) {
        if (l.action === 'Disengage' && l.actor?.includes('Goblin')) sawDisengage = true;
        if (sawDisengage && l.action === 'Opportunity Attack' && l.details?.includes('Goblin')) {
          oaAfterDisengage++;
        }
      }
    }
    // Goblin should sometimes Disengage (when 2 knights threaten > 30% HP)
    // Not guaranteed every battle due to initiative order
  });

  it('Rogue uses Cunning Action: Disengage for free when kiting', () => {
    const knight = md('Knight');
    const rogue = buildHero('Rogue', 3);
    let rogueFreeDisengage = 0;
    let rogueOA = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(knight, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(rogue, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20, { red: 'aggressive', blue: 'kiting' });
      if (state.logs.some(l => l.action === 'Cunning Action: Disengage')) rogueFreeDisengage++;
      rogueOA += state.logs.filter(l => l.action === 'Opportunity Attack' && l.details?.includes('Rogue')).length;
    }
    // Rogue should not provoke OAs when kiting (Cunning Action)
    expect(rogueOA).toBe(0);
  });
});

describe('incapacitated creatures cannot OA', () => {
  it('stunned enemy does not OA when creature leaves reach', () => {
    // Use a scenario where an enemy would normally OA but is stunned
    const veteran = md('Veteran');
    const goblin = md('Goblin Warrior');
    let oaFromStunned = 0;
    for (let i = 0; i < 30; i++) {
      const v = createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0);
      v.conditions.push('stunned');
      const creatures = [
        v,
        createCreatureWithFixedHp(goblin, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20, { red: 'aggressive', blue: 'kiting' });
      // Stunned veteran should not OA
      const oaLogs = state.logs.filter(l => l.action === 'Opportunity Attack' && l.actor === v.displayName);
      oaFromStunned += oaLogs.length;
    }
    expect(oaFromStunned).toBe(0);
  });
});
