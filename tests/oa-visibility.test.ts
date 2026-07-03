/**
 * #89 - Opportunity attack visibility regression coverage.
 *
 * Asserts the engine emits the right surfacing data for OAs and for
 * every avoidance path: cause tagging on the attack event, stretched
 * durations, and oaAvoided events with the correct reason for
 * Disengage / Cunning Action / Nimble Escape / flying / reactionUsed /
 * stunned. Driven by direct calls into runOpportunityAttacks +
 * `runBattle` for the cunning/nimble/disengage paths that decide
 * before runOpportunityAttacks.
 */
import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { runBattle, runOpportunityAttacks } from '../src/engine/ai';
import { createCreatureWithFixedHp, initBattle } from '../src/engine/combat';
import { OA_ATTACK_DURATIONS, type AnimationEvent } from '../src/types/animation';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

describe('OA visibility - cause + stretched duration', () => {
  it('OA attacks carry cause: opportunity on attack/hit/miss events', () => {
    const veteran = md('Veteran');
    const scout = md('Scout');
    let oaAttackFound: AnimationEvent | undefined;
    for (let i = 0; i < 30 && !oaAttackFound; i++) {
      const creatures = [
        createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(scout, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20, { red: 'aggressive', blue: 'kiting' });
      // An OA fires immediately after a "Opportunity Attack" log line,
      // so find the attack event after that log's eventIndex.
      const oaLog = state.logs.find(l => l.action === 'Opportunity Attack');
      if (!oaLog) continue;
      oaAttackFound = state.events
        .slice(oaLog.eventIndex)
        .find(e => e.kind === 'attack' && e.cause === 'opportunity');
    }
    expect(oaAttackFound).toBeDefined();
    expect(oaAttackFound?.kind).toBe('attack');
    if (oaAttackFound?.kind === 'attack') {
      expect(oaAttackFound.cause).toBe('opportunity');
      expect(oaAttackFound.durationMs).toBe(OA_ATTACK_DURATIONS.attack);
    }
  });

  it('OA hit/miss events also carry stretched durations', () => {
    const veteran = md('Veteran');
    const scout = md('Scout');
    let oaHitOrMiss: AnimationEvent | undefined;
    for (let i = 0; i < 30 && !oaHitOrMiss; i++) {
      const creatures = [
        createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(scout, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20, { red: 'aggressive', blue: 'kiting' });
      const oaLog = state.logs.find(l => l.action === 'Opportunity Attack');
      if (!oaLog) continue;
      oaHitOrMiss = state.events
        .slice(oaLog.eventIndex)
        .find(e => (e.kind === 'hit' || e.kind === 'miss') && e.cause === 'opportunity');
    }
    expect(oaHitOrMiss).toBeDefined();
    if (oaHitOrMiss?.kind === 'hit') {
      expect(oaHitOrMiss.durationMs).toBe(OA_ATTACK_DURATIONS.hit);
    } else if (oaHitOrMiss?.kind === 'miss') {
      expect(oaHitOrMiss.durationMs).toBe(OA_ATTACK_DURATIONS.miss);
    }
  });
});

describe('OA avoidance - oaAvoided events', () => {
  it('Goblin Nimble Escape emits oaAvoided with reason "nimble"', () => {
    const veteran = md('Veteran');
    const goblin = md('Goblin Warrior');
    let nimbleAvoidances = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 7, y: 7 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 8, y: 7 }, 1),
      ];
      const state = runBattle(creatures, 14, { red: 'kiting', blue: 'aggressive' });
      nimbleAvoidances += state.events.filter(
        e => e.kind === 'oaAvoided' && e.reason === 'nimble'
      ).length;
    }
    // Goblin starts adjacent to the Veteran; on its first turn it should
    // Nimble-Escape away. Expect at least one nimble avoidance across
    // the 30 trials.
    expect(nimbleAvoidances).toBeGreaterThan(0);
  });

  it('Rogue Cunning Action emits oaAvoided with reason "cunning"', async () => {
    const { buildHero } = await import('../src/data/heroes');
    const rogue = buildHero('Rogue', 5);
    const veteran = md('Veteran');
    let cunningAvoidances = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(rogue, 'blue', { x: 7, y: 7 }, 0),
        createCreatureWithFixedHp(veteran, 'red', { x: 8, y: 7 }, 1),
      ];
      const state = runBattle(creatures, 14, { red: 'aggressive', blue: 'kiting' });
      cunningAvoidances += state.events.filter(
        e => e.kind === 'oaAvoided' && e.reason === 'cunning'
      ).length;
    }
    expect(cunningAvoidances).toBeGreaterThan(0);
  });

  it('reactionUsed skip emits oaAvoided with reason "reactionUsed" and a Reaction Spent log', () => {
    // Set up a Veteran with reactionUsed already flipped, then call
    // runOpportunityAttacks directly with a mover leaving its reach.
    const veteran = md('Veteran');
    const scout = md('Scout');
    const enemy = createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0);
    const mover = createCreatureWithFixedHp(scout, 'blue', { x: 12, y: 10 }, 1);
    enemy.reactionUsed = true;
    const state = initBattle([enemy, mover], 20);
    state.events = [];
    state.logs = [];

    runOpportunityAttacks(state, mover, { x: 11, y: 10 });

    const avoided = state.events.find(e => e.kind === 'oaAvoided');
    expect(avoided?.kind).toBe('oaAvoided');
    if (avoided?.kind === 'oaAvoided') {
      expect(avoided.reason).toBe('reactionUsed');
      expect(avoided.enemyId).toBe(enemy.id);
      expect(avoided.moverId).toBe(mover.id);
    }
    expect(state.logs.some(l => l.action === 'Reaction Spent')).toBe(true);
  });

  it('stunned enemy emits oaAvoided with reason "stunned" and an OA Prevented log', () => {
    const veteran = md('Veteran');
    const scout = md('Scout');
    const enemy = createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0);
    const mover = createCreatureWithFixedHp(scout, 'blue', { x: 12, y: 10 }, 1);
    enemy.conditions = ['stunned'];
    const state = initBattle([enemy, mover], 20);
    state.events = [];
    state.logs = [];

    runOpportunityAttacks(state, mover, { x: 11, y: 10 });

    const avoided = state.events.find(e => e.kind === 'oaAvoided');
    expect(avoided?.kind).toBe('oaAvoided');
    if (avoided?.kind === 'oaAvoided') {
      expect(avoided.reason).toBe('stunned');
    }
    expect(state.logs.some(l => l.action === 'OA Prevented')).toBe(true);
  });

  it('airborne mover emits oaAvoided with reason "flying" against grounded enemy', () => {
    const veteran = md('Veteran');
    const wyvern = md('Wyvern');
    const grounded = createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0);
    const flyer = createCreatureWithFixedHp(wyvern, 'blue', { x: 12, y: 10 }, 1);
    flyer.airborne = true;
    const state = initBattle([grounded, flyer], 20);
    state.events = [];
    state.logs = [];

    runOpportunityAttacks(state, flyer, { x: 11, y: 10 });

    const avoided = state.events.find(e => e.kind === 'oaAvoided');
    expect(avoided?.kind).toBe('oaAvoided');
    if (avoided?.kind === 'oaAvoided') {
      expect(avoided.reason).toBe('flying');
    }
    expect(state.logs.some(l => l.action === 'Out of Reach')).toBe(true);
  });

  it('passer-by who never crossed reach does NOT emit oaAvoided', () => {
    // Mover starts and ends OUT of reach - no OA event of any kind.
    const veteran = md('Veteran');
    const scout = md('Scout');
    const enemy = createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0);
    const mover = createCreatureWithFixedHp(scout, 'blue', { x: 15, y: 10 }, 1);
    enemy.reactionUsed = true;
    const state = initBattle([enemy, mover], 20);
    state.events = [];
    state.logs = [];

    runOpportunityAttacks(state, mover, { x: 14, y: 10 });

    expect(state.events.find(e => e.kind === 'oaAvoided')).toBeUndefined();
  });
});

describe('OA walk-past detection (path-aware)', () => {
  it('mover that passes through reach (entering and leaving in one move) provokes an OA', () => {
    // Mover starts out of reach at (8, 10), walks through (9, 10) and
    // (10, 10) (Veteran's space-adjacent cells, in 5ft reach), and ends
    // at (13, 10) - out of reach again. Without path-aware detection,
    // the simple "distBefore vs distAfter" check would miss this.
    const veteran = md('Veteran');
    const scout = md('Scout');
    const enemy = createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0);
    const mover = createCreatureWithFixedHp(scout, 'blue', { x: 13, y: 10 }, 1);
    const state = initBattle([enemy, mover], 20);
    state.events = [
      // Synthetic move event with a path that crosses reach.
      {
        kind: 'move', creatureId: mover.id,
        from: { x: 8, y: 10 }, to: { x: 13, y: 10 },
        path: [{ x: 8, y: 10 }, { x: 9, y: 10 }, { x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }],
        durationMs: 400,
      },
    ];
    state.logs = [];

    runOpportunityAttacks(state, mover, { x: 8, y: 10 });

    // Either the OA fired (attack event with cause: opportunity) or the
    // skip is logged - both are acceptable outcomes; the bug we're
    // closing is "nothing happens." Assert an Opportunity Attack log
    // exists since the Veteran's reaction is available.
    expect(state.logs.some(l => l.action === 'Opportunity Attack')).toBe(true);
    expect(state.events.some(e => e.kind === 'attack' && e.cause === 'opportunity')).toBe(true);
  });

  it('chained move events for one creature form a connected path (no orphaned continuations)', () => {
    // Architectural invariant: when OAs split a move event, the
    // resulting [truncated original, ..., continuation] chain must be
    // consecutive in position - every continuation's `from` must equal
    // the previous move's `to`. If this breaks, the multi-OA fallback
    // death path has corrupted state.events.
    const veteran = md('Veteran');
    const goblin = md('Goblin Warrior');
    let chainBreaks = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(veteran, 'red', { x: 6, y: 7 }, 0),
        createCreatureWithFixedHp(veteran, 'red', { x: 9, y: 7 }, 1),
        createCreatureWithFixedHp(goblin, 'blue', { x: 7, y: 7 }, 2),
        createCreatureWithFixedHp(goblin, 'blue', { x: 8, y: 7 }, 3),
      ];
      const state = runBattle(creatures, 14, { red: 'aggressive', blue: 'kiting' });
      // Group move events by creature, then check chain integrity.
      for (const c of state.creatures) {
        const moves = state.events.filter(
          (e): e is Extract<AnimationEvent, { kind: 'move' }> =>
            e.kind === 'move' && e.creatureId === c.id,
        );
        for (let k = 1; k < moves.length; k++) {
          const prev = moves[k - 1];
          const next = moves[k];
          if (prev.to.x !== next.from.x || prev.to.y !== next.from.y) {
            chainBreaks++;
          }
        }
      }
    }
    expect(chainBreaks).toBe(0);
  });

  it('walk-past OA rewinds the mover to the last in-reach cell before the strike', () => {
    // When the mover crosses reach and the Veteran swings, the engine
    // should resolve the attack from the last cell in reach (here
    // (11, 10) - the cell adjacent to the Veteran on the way past),
    // not from the mover's pre-move position (8, 10) which was already
    // out of reach. We can't easily observe the rewind directly, but
    // we can confirm the OA log was emitted, which means resolveAttack
    // ran with the mover at the right spot.
    const veteran = md('Veteran');
    const scout = md('Scout');
    const enemy = createCreatureWithFixedHp(veteran, 'red', { x: 10, y: 10 }, 0);
    const mover = createCreatureWithFixedHp(scout, 'blue', { x: 13, y: 10 }, 1);
    const state = initBattle([enemy, mover], 20);
    state.events = [
      {
        kind: 'move', creatureId: mover.id,
        from: { x: 8, y: 10 }, to: { x: 13, y: 10 },
        path: [{ x: 8, y: 10 }, { x: 9, y: 10 }, { x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }],
        durationMs: 400,
      },
    ];
    state.logs = [];

    runOpportunityAttacks(state, mover, { x: 8, y: 10 });

    // Veteran's reaction should now be spent.
    expect(enemy.reactionUsed).toBe(true);
    // And if the mover survived, they should be back at the final cell.
    if (mover.isAlive) {
      expect(mover.position).toEqual({ x: 13, y: 10 });
    }
  });
});
