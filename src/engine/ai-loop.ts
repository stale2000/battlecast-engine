import { engineRandom } from './rng.js';
/**
 * Round and battle orchestration - the top of the AI call stack.
 *
 * Three responsibilities, in increasing scope:
 *
 *   1. `executeRound(state)` runs one combat round: every alive creature
 *      acts in initiative order (calling into `executeTurn` from ai.ts),
 *      legendary actions are spent by eligible creatures between turns,
 *      end-of-round cleanup (LA refresh) happens, and
 *      `state.round` increments.
 *
 *   2. `runBattle(creatures, gridSize?, ...)` initialises a fresh
 *      BattleState, rolls initiative, loops `executeRound` until the
 *      battle is complete or stale, and returns the final state.
 *      Includes stalemate detection so a 100-round deadlock ends
 *      gracefully rather than spinning forever.
 *
 *   3. `runMonteCarlo(...)` runs N battles and aggregates per-creature
 *      statistics for the UI's Monte Carlo dashboard. Designed to run
 *      in a web worker: yields to the event loop periodically so
 *      postMessage-based cancel requests can interrupt a long run.
 *
 * Circular-import note: this file imports `executeTurn` and
 * `executeLegendaryAction` from `./ai` which in turn re-exports the
 * `run*` entry points from here. The cycle is safe because ESM
 * resolves named exports lazily - by the time `executeRound` actually
 * calls `executeTurn`, both modules have finished loading. The
 * simpler alternative (inline those functions here) would undo the
 * whole point of the ai.ts split. When Phase 3c moves `executeTurn`
 * into its own `ai-turn.ts`, this import will re-target there and the
 * cycle dissolves.
 */

import { Creature, MonsterData } from '../types/monster.js';
import { BASE_DURATIONS } from '../types/animation.js';
import {
  BattleState, DEFAULT_TACTICS, type TeamTactics,
  creatureIdPrefix, getAliveCreatures, checkBattleComplete, pushLog,
  rollAllInitiatives, getInitiativeOrder, hasThiefsReflexes,
} from './combat.js';
import { executeTurn, executeLegendaryAction } from './ai.js';

/** Execute one full round of combat. */
export function executeRound(state: BattleState): void {
  if (state.isComplete) return;

  state.events.push({ kind: 'roundStart', round: state.round, durationMs: BASE_DURATIONS.roundStart });
  pushLog(state, {
    round: state.round, turn: 0,
    actor: 'System', action: 'Round Start',
    details: `--- Round ${state.round} ---`,
    type: 'info'
  });

  const turnsTaken = new Map<string, number>();
  for (let i = 0; i < state.initiativeOrder.length; i++) {
    if (state.isComplete) break;

    state.turnIndex = i;
    const creature = state.creatures.find(c => c.id === state.initiativeOrder[i]);
    if (!creature || !creature.isAlive) continue;
    const turnNumberThisRound = (turnsTaken.get(creature.id) ?? 0) + 1;
    turnsTaken.set(creature.id, turnNumberThisRound);
    if (state.round > 1 && turnNumberThisRound > 1 && hasThiefsReflexes(creature)) continue;

    creature.stats.roundsSurvived = state.round;
    executeTurn(state, creature);

    // Legendary actions: after each non-legendary creature's turn,
    // legendary creatures can spend points on legendary actions.
    if (state.isComplete) break;
    for (const legend of getAliveCreatures(state)) {
      if (!legend.monsterData.legendaryActions?.length) continue;
      if (legend.id === creature.id) continue; // can't LA on own turn
      if ((legend.legendaryActionsRemaining ?? 0) <= 0) continue;
      executeLegendaryAction(state, legend);
    }
  }

  // Reset legendary action points at end of round (they reset at
  // the start of the legendary creature's turn in D&D, but resetting
  // at round end is equivalent since each creature acts once per round).
  for (const creature of getAliveCreatures(state)) {
    if (creature.monsterData.legendaryActions?.length) {
      creature.legendaryActionsRemaining = creature.monsterData.legendaryActionUses || 3;
    }
  }

  checkBattleComplete(state);
  state.round++;
}

/** Run full battle to completion. */
export function runBattle(
  creatures: Creature[],
  gridSize: number = 100,
  teamTactics?: TeamTactics,
  /**
   * Optional set of movement-blocked cells (walls + chasms) from the
   * active map preset. When provided, moveToward and placement checks
   * will respect it. Omit for a no-terrain battle (existing behavior).
   */
  terrainBlocked?: Set<string>,
  /**
   * Optional set of sight-blocked cells (walls only, NOT chasms).
   * Ranged attack resolution consults this for line-of-sight. Omit
   * or empty = no walls → LoS always passes (classic behavior).
   */
  terrainSightBlocked?: Set<string>,
): BattleState {
  const state: BattleState = {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: [],
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize,
    teamTactics: teamTactics || DEFAULT_TACTICS,
    terrainBlocked,
    terrainSightBlocked,
  };

  rollAllInitiatives(creatures);
  state.initiativeOrder = getInitiativeOrder(creatures);

  pushLog(state, {
    round: 0, turn: 0, actor: 'System', action: 'Battle Start',
    details: `Battle begins! Red: ${creatures.filter(c => c.team === 'red').map(c => c.displayName).join(', ')} vs Blue: ${creatures.filter(c => c.team === 'blue').map(c => c.displayName).join(', ')}`,
    type: 'info'
  });

  let consecutiveStaleRounds = 0;
  while (!state.isComplete && state.round <= 100) {
    const eventsBefore = state.events.length;
    executeRound(state);

    // Stalemate detection: if a round produced no meaningful combat
    // events (no attacks, hits, heals, AoEs, saves, or movement),
    // nobody can reach anyone. After 3 consecutive idle rounds, end
    // the battle early instead of spinning for 100 rounds.
    const hadAction = state.events.slice(eventsBefore).some(e =>
      e.kind === 'attack' || e.kind === 'hit' || e.kind === 'miss' ||
      e.kind === 'heal' || e.kind === 'aoe' || e.kind === 'save' ||
      e.kind === 'stabiliseAlly'
    );
    if (hadAction) {
      consecutiveStaleRounds = 0;
    } else {
      consecutiveStaleRounds++;
      if (consecutiveStaleRounds >= 3) {
        const aliveR = getAliveCreatures(state, 'red');
        const aliveB = getAliveCreatures(state, 'blue');
        const rHp = aliveR.reduce((s, c) => s + c.currentHp, 0);
        const bHp = aliveB.reduce((s, c) => s + c.currentHp, 0);
        state.isComplete = true;
        state.winner = rHp > bHp ? 'red' : bHp > rHp ? 'blue' : 'draw';
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: 'System', action: 'Stalemate',
          details: `Stalemate - no creature could reach an enemy for ${consecutiveStaleRounds} rounds. ${state.winner === 'draw' ? 'Draw' : `${state.winner} wins`} by remaining HP (${rHp} red vs ${bHp} blue).`,
          type: 'info',
        });
        break;
      }
    }
  }

  // Safety net: executeRound increments state.round *after* calling
  // checkBattleComplete, so if the round cap was the thing that stopped the
  // loop we exit with winner===null. Decide by remaining HP (or declare a
  // genuine draw) instead of leaving the battle unresolved.
  if (!state.isComplete) {
    const aliveRed = getAliveCreatures(state, 'red');
    const aliveBlue = getAliveCreatures(state, 'blue');
    const redHp = aliveRed.reduce((s, c) => s + c.currentHp, 0);
    const blueHp = aliveBlue.reduce((s, c) => s + c.currentHp, 0);
    state.isComplete = true;
    state.winner = redHp > blueHp ? 'red' : blueHp > redHp ? 'blue' : 'draw';
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: 'System', action: 'Battle Over',
      details: `Battle reached 100 rounds! ${state.winner === 'draw' ? 'Genuine draw' : `${state.winner} wins`} by HP remaining (${redHp} red vs ${blueHp} blue).`,
      type: 'info',
    });
  }

  return state;
}

// ─────────────────────────────────────────────────────────────────
// Monte Carlo simulation
// ─────────────────────────────────────────────────────────────────

export interface MonteCarloResult {
  totalBattles: number;
  redWins: number;
  blueWins: number;
  draws: number;
  redWinPct: number;
  blueWinPct: number;
  avgRounds: number;
  /**
   * Raw list of battle lengths (one entry per completed battle, each
   * the number of rounds that battle ran before resolving). Used by the
   * MonteCarloModal to render a histogram - lets DMs see "how long will
   * this fight last?" and spot bimodal fights (a 25/75 win% with a
   * distribution that clusters on 3 OR 18 rounds means "usually a rout,
   * sometimes a grind" - different flavor than a 50/50 coin flip).
   *
   * Cheap to store: ~80KB at 10K battles. Sent over postMessage from
   * the worker; the UI layer buckets it.
   */
  roundsDistribution: number[];
  perCreature: Map<string, {
    name: string;
    team: 'red' | 'blue';
    survivalRate: number;
    avgDamageDealt: number;
    avgDamageTaken: number;
    avgKills: number;
    /** Mean round number at which this creature type was killed, averaged
     *  over battles in which it actually died. `null` if it never died in
     *  any battle across the run (e.g. always on the winning side). */
    avgDeathRound: number | null;
    /** Number of battles (creature-appearances) in which this type died.
     *  Useful for weighting avgDeathRound confidence. */
    deathCount: number;
    /** Avg times this hero hit 0 HP per battle (counts re-downs too). */
    avgTimesDowned: number;
    /** Avg times this hero was healed back from 0 HP per battle (revived). */
    avgTimesRevived: number;
    /** Avg times this hero stabilised via 3 death-save successes per battle. */
    avgTimesStabilisedBySaves: number;
    /** Avg times this hero was stabilised by an adjacent ally action per battle. */
    avgTimesStabilisedByAllies: number;
    /** Avg times this creature revived a 0-HP ally per battle - healer card. */
    avgAlliesRevived: number;
    /** Avg times this creature stabilised a dying ally per battle. */
    avgAlliesStabilised: number;
    /** Avg times a nat-20 death save popped this hero back up at 1 HP. */
    avgTimesPoppedAtOneHp: number;
    /** Avg death-save rolls per battle (all outcomes). */
    avgDeathSaveRolls: number;
    /** Fraction of deaths that came from 3 failed death saves (vs outright
     *  kill via massive damage / monster). Only meaningful for heroes;
     *  monsters always have deathsFromSavesRate=0. */
    deathsFromSavesRate: number;
  }>;
  /**
   * Aggregate death-save activity across every hero appearance in the
   * run, split by team. Each side renders as its own "Hero report card"
   * panel in MonteCarloModal so red-heroes-vs-blue-heroes fights show
   * the two teams separately.
   *
   * A side is undefined when that team had no heroes; both undefined
   * for pure monster-vs-monster runs. Counts use raw totals across all
   * battles; the modal converts to percentages.
   */
  heroSummary?: {
    red?: HeroDeathSaveSummary;
    blue?: HeroDeathSaveSummary;
  };
}

export interface HeroDeathSaveSummary {
  /** Number of (hero, battle) appearances across the run. A party of 4
   *  heroes simulated 100 times = 400 appearances. */
  heroAppearances: number;
  /** Number of distinct hero deaths across the run (any cause). */
  heroDeaths: number;
  /** Number of hero deaths that came from 3 failed death saves. */
  heroDeathsFromSaves: number;
  /** Total times any hero entered the dying state (counts re-downs). */
  totalDowns: number;
  /** Total times any hero was healed back from 0 HP. */
  totalRevived: number;
  /** Total times any hero stabilised via 3 successful death saves. */
  totalStabilisedBySaves: number;
  /** Total times any hero was stabilised by an adjacent ally action. */
  totalStabilisedByAllies: number;
  /** Total nat-20-pop-up events. */
  totalPoppedAtOneHp: number;
  /** Total death-save d20s rolled across the run. */
  totalDeathSaveRolls: number;
}

/**
 * Progress snapshot streamed by `runMonteCarlo` to `onProgress` while a
 * run is in flight. Carries the live win-count tallies so a worker can
 * forward them to the UI for real-time win-% display, plus a
 * `totalRounds` sum so the caller can compute avg-rounds on partial
 * results if the run gets cancelled before completion.
 */
export interface MonteCarloProgress {
  completed: number;
  total: number;
  redWins: number;
  blueWins: number;
  draws: number;
  totalRounds: number;
}

/**
 * How often `runMonteCarlo` fires `onProgress`. Tuned so the UI gets
 * ~4 updates per second on typical modern hardware without flooding
 * postMessage. Measured via wall clock inside the loop.
 */
const PROGRESS_INTERVAL_MS = 250;

/**
 * Yields to the event loop. Required in a worker context so that
 * pending postMessages (specifically cancel requests) can be
 * processed - a synchronous battle loop would starve them until
 * completion and the cancel button would never take effect.
 * setTimeout(0) is the portable way to do this in workers.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

interface HeroAgg {
  heroAppearances: number;
  heroDeaths: number;
  heroDeathsFromSaves: number;
  totalDowns: number;
  totalRevived: number;
  totalStabilisedBySaves: number;
  totalStabilisedByAllies: number;
  totalPoppedAtOneHp: number;
  totalDeathSaveRolls: number;
}

function emptyHeroAgg(): HeroAgg {
  return {
    heroAppearances: 0,
    heroDeaths: 0,
    heroDeathsFromSaves: 0,
    totalDowns: 0,
    totalRevived: 0,
    totalStabilisedBySaves: 0,
    totalStabilisedByAllies: 0,
    totalPoppedAtOneHp: 0,
    totalDeathSaveRolls: 0,
  };
}

export async function runMonteCarlo(
  redMonsters: { data: MonsterData; count: number }[],
  blueMonsters: { data: MonsterData; count: number }[],
  numBattles: number,
  gridSize: number = 20,
  onProgress?: (progress: MonteCarloProgress) => void,
  teamTactics?: TeamTactics,
  terrainBlocked?: Set<string>,
  terrainSightBlocked?: Set<string>,
  /**
   * Cooperative cancellation. Checked at the top of each battle-loop
   * iteration; when it returns true, the loop breaks and the function
   * returns a result built from however many battles completed - with
   * full per-creature stats for those completed battles. In a worker
   * context this must read a flag that the worker's message handler
   * flips on postMessage - so the loop yields periodically to let
   * those messages through (see yieldToEventLoop below).
   */
  shouldStop?: () => boolean,
  /**
   * If provided, every battle starts from these exact starting positions
   * (each creature is cloned fresh per battle - HP/conditions/stats reset).
   * When set, the redMonsters / blueMonsters count-based randomized spawn
   * logic is ignored. Lets the UI pass the user's manually-placed layout
   * through to MC instead of re-randomizing each time.
   */
  fixedPlacement?: Array<{ data: MonsterData; team: 'red' | 'blue'; position: { x: number; y: number } }>,
): Promise<MonteCarloResult> {
  let redWins = 0;
  let blueWins = 0;
  let draws = 0;
  let totalRounds = 0;
  // Per-battle round counts - one entry per completed battle. Sized
  // to numBattles up front to avoid resize churn on 10K runs.
  const roundsDistribution: number[] = [];
  // Last wall-clock time onProgress was fired. Seeded to 0 so the
  // first iteration's onProgress call acts as a synchronous "just
  // starting" ping - the UI can then show 0-of-total immediately
  // rather than a ghost empty bar.
  let lastProgressMs = 0;

  // Track per-creature-type stats
  const creatureStats = new Map<string, {
    name: string;
    team: 'red' | 'blue';
    battles: number;
    survivalCount: number;
    totalDamageDealt: number;
    totalDamageTaken: number;
    totalKills: number;
    /** Sum of `state.round` values at which this type's instances died,
     *  across all battles. Used with deathCount to compute avgDeathRound. */
    totalDeathRound: number;
    /** How many creature-appearances of this type resulted in a death. */
    deathCount: number;
    totalTimesDowned: number;
    totalTimesRevived: number;
    totalTimesStabilisedBySaves: number;
    totalTimesStabilisedByAllies: number;
    totalAlliesRevived: number;
    totalAlliesStabilised: number;
    totalTimesPoppedAtOneHp: number;
    totalDeathSaveRolls: number;
    deathsFromSaves: number;
  }>();

  // Actual number of battles we finish. Stays == numBattles unless
  // shouldStop fires mid-run, in which case it's the partial count
  // that the result should reflect.
  let battlesCompleted = 0;

  // Aggregate hero death-save activity across all battles, split per
  // team. Populated inside the per-creature loop below when
  // c.monsterData.isHero. Each team only ends up in the final result
  // if that team actually had hero appearances.
  const heroAgg = {
    red: emptyHeroAgg(),
    blue: emptyHeroAgg(),
  };

  for (let battle = 0; battle < numBattles; battle++) {
    if (shouldStop && shouldStop()) break;
    const creatures: Creature[] = [];
    if (fixedPlacement && fixedPlacement.length > 0) {
      // Clone each placed creature fresh: positions are preserved, HP/conditions/stats reset.
      // Per-team idx resets so displayNames ("Giant Rat", "Giant Rat 2", ...) stay stable.
      let redIdx = 0;
      let blueIdx = 0;
      for (const p of fixedPlacement) {
        const idx = p.team === 'red' ? redIdx++ : blueIdx++;
        creatures.push(createCreatureForSim(p.data, p.team, { ...p.position }, idx));
      }
    } else {
      // Default: random placement from count-based setup (red in left third, blue in right third).
      let idx = 0;
      for (const { data, count } of redMonsters) {
        for (let i = 0; i < count; i++) {
          const x = Math.floor(engineRandom() * Math.floor(gridSize / 3));
          const y = Math.floor(engineRandom() * gridSize);
          creatures.push(createCreatureForSim(data, 'red', { x, y }, idx++));
        }
      }
      idx = 0;
      for (const { data, count } of blueMonsters) {
        for (let i = 0; i < count; i++) {
          const x = Math.floor(gridSize * 2 / 3) + Math.floor(engineRandom() * Math.floor(gridSize / 3));
          const y = Math.floor(engineRandom() * gridSize);
          creatures.push(createCreatureForSim(data, 'blue', { x, y }, idx++));
        }
      }
    }

    const result = runBattle(creatures, gridSize, teamTactics, terrainBlocked, terrainSightBlocked);

    if (result.winner === 'red') redWins++;
    else if (result.winner === 'blue') blueWins++;
    else draws++;

    const battleLength = result.round - 1;
    totalRounds += battleLength;
    roundsDistribution.push(battleLength);

    // Aggregate per-creature stats
    for (const c of result.creatures) {
      const key = `${c.monsterData.name}-${c.team}`;
      if (!creatureStats.has(key)) {
        creatureStats.set(key, {
          name: c.monsterData.name,
          team: c.team,
          battles: 0,
          survivalCount: 0,
          totalDamageDealt: 0,
          totalDamageTaken: 0,
          totalKills: 0,
          totalDeathRound: 0,
          deathCount: 0,
          totalTimesDowned: 0,
          totalTimesRevived: 0,
          totalTimesStabilisedBySaves: 0,
          totalTimesStabilisedByAllies: 0,
          totalAlliesRevived: 0,
          totalAlliesStabilised: 0,
          totalTimesPoppedAtOneHp: 0,
          totalDeathSaveRolls: 0,
          deathsFromSaves: 0,
        });
      }
      const stats = creatureStats.get(key)!;
      stats.battles++;
      if (c.isAlive) {
        stats.survivalCount++;
      } else if (typeof c.stats.deathRound === 'number') {
        // combat.applyDamage / markPermanentlyDead set this at the moment of death.
        stats.totalDeathRound += c.stats.deathRound;
        stats.deathCount++;
        if (c.stats.diedFromSaves) stats.deathsFromSaves++;
      }
      stats.totalDamageDealt += c.stats.damageDealt;
      stats.totalDamageTaken += c.stats.damageTaken;
      stats.totalKills += c.stats.killCount;
      stats.totalTimesDowned += c.stats.timesDowned ?? 0;
      stats.totalTimesRevived += c.stats.timesRevived ?? 0;
      stats.totalTimesStabilisedBySaves += c.stats.timesStabilisedBySaves ?? 0;
      stats.totalTimesStabilisedByAllies += c.stats.timesStabilisedByAllies ?? 0;
      stats.totalAlliesRevived += c.stats.alliesRevived ?? 0;
      stats.totalAlliesStabilised += c.stats.alliesStabilised ?? 0;
      stats.totalTimesPoppedAtOneHp += c.stats.timesPoppedAtOneHp ?? 0;
      stats.totalDeathSaveRolls += c.stats.deathSaveRolls ?? 0;

      // Hero-summary aggregates - split per team so the modal can render
      // separate panels for red and blue. Monsters skip this block since
      // they never enter the dying state.
      if (c.monsterData.isHero) {
        const teamAgg = heroAgg[c.team];
        teamAgg.heroAppearances++;
        if (!c.isAlive) {
          teamAgg.heroDeaths++;
          if (c.stats.diedFromSaves) teamAgg.heroDeathsFromSaves++;
        }
        teamAgg.totalDowns += c.stats.timesDowned ?? 0;
        teamAgg.totalRevived += c.stats.timesRevived ?? 0;
        teamAgg.totalStabilisedBySaves += c.stats.timesStabilisedBySaves ?? 0;
        teamAgg.totalStabilisedByAllies += c.stats.timesStabilisedByAllies ?? 0;
        teamAgg.totalPoppedAtOneHp += c.stats.timesPoppedAtOneHp ?? 0;
        teamAgg.totalDeathSaveRolls += c.stats.deathSaveRolls ?? 0;
      }
    }

    battlesCompleted = battle + 1;

    // Wall-clock-rate-limited progress. Fires on the first battle (to
    // surface 0/total immediately), then roughly every
    // PROGRESS_INTERVAL_MS. Always fires on the LAST battle so the UI
    // sees completed=total before the final `done` message.
    //
    // We yield to the event loop right after each progress tick so
    // that pending postMessages (specifically cancel requests) can be
    // processed. Without this yield, a synchronous loop starves the
    // worker's message handler and the cancel button appears dead.
    // The yield happens at most ~4x/sec which is a negligible cost.
    if (onProgress) {
      const now = Date.now();
      if (lastProgressMs === 0 || now - lastProgressMs >= PROGRESS_INTERVAL_MS || battle === numBattles - 1) {
        onProgress({
          completed: battle + 1,
          total: numBattles,
          redWins,
          blueWins,
          draws,
          totalRounds,
        });
        lastProgressMs = now;
        await yieldToEventLoop();
      }
    }
  }

  const perCreature: MonteCarloResult['perCreature'] = new Map();

  for (const [key, stats] of creatureStats) {
    perCreature.set(key, {
      name: stats.name,
      team: stats.team,
      survivalRate: stats.survivalCount / stats.battles,
      avgDamageDealt: stats.totalDamageDealt / stats.battles,
      avgDamageTaken: stats.totalDamageTaken / stats.battles,
      avgKills: stats.totalKills / stats.battles,
      avgDeathRound: stats.deathCount > 0 ? stats.totalDeathRound / stats.deathCount : null,
      deathCount: stats.deathCount,
      avgTimesDowned: stats.totalTimesDowned / stats.battles,
      avgTimesRevived: stats.totalTimesRevived / stats.battles,
      avgTimesStabilisedBySaves: stats.totalTimesStabilisedBySaves / stats.battles,
      avgTimesStabilisedByAllies: stats.totalTimesStabilisedByAllies / stats.battles,
      avgAlliesRevived: stats.totalAlliesRevived / stats.battles,
      avgAlliesStabilised: stats.totalAlliesStabilised / stats.battles,
      avgTimesPoppedAtOneHp: stats.totalTimesPoppedAtOneHp / stats.battles,
      avgDeathSaveRolls: stats.totalDeathSaveRolls / stats.battles,
      deathsFromSavesRate: stats.deathCount > 0 ? stats.deathsFromSaves / stats.deathCount : 0,
    });
  }

  // Result reflects actual completed battles, NOT the originally
  // requested count. On normal completion battlesCompleted === numBattles;
  // on cooperative cancel it's the partial count. The UI layer decides
  // how to present partial vs full (e.g. "cancelled after N of M").
  const denom = Math.max(1, battlesCompleted); // avoid /0 if cancel fires before the first battle finishes

  const summaryFor = (a: HeroAgg): HeroDeathSaveSummary | undefined =>
    a.heroAppearances > 0
      ? {
          heroAppearances: a.heroAppearances,
          heroDeaths: a.heroDeaths,
          heroDeathsFromSaves: a.heroDeathsFromSaves,
          totalDowns: a.totalDowns,
          totalRevived: a.totalRevived,
          totalStabilisedBySaves: a.totalStabilisedBySaves,
          totalStabilisedByAllies: a.totalStabilisedByAllies,
          totalPoppedAtOneHp: a.totalPoppedAtOneHp,
          totalDeathSaveRolls: a.totalDeathSaveRolls,
        }
      : undefined;
  const redSummary = summaryFor(heroAgg.red);
  const blueSummary = summaryFor(heroAgg.blue);
  const heroSummary = (redSummary || blueSummary)
    ? { red: redSummary, blue: blueSummary }
    : undefined;

  return {
    totalBattles: battlesCompleted,
    redWins,
    blueWins,
    draws,
    redWinPct: (redWins / denom) * 100,
    blueWinPct: (blueWins / denom) * 100,
    avgRounds: totalRounds / denom,
    roundsDistribution,
    perCreature,
    heroSummary,
  };
}

/**
 * Per-battle creature factory used inside the Monte Carlo loop. A
 * fresh Creature is allocated for each simulated battle (HP, conditions,
 * stats all reset to initial) so successive runs don't inherit state
 * from each other. `idx` is per-team so displayNames remain stable
 * ("Giant Rat", "Giant Rat 2", ...).
 */
function createCreatureForSim(
  data: MonsterData,
  team: 'red' | 'blue',
  pos: { x: number; y: number },
  idx: number
): Creature {
  return {
    id: `${creatureIdPrefix(data.name)}-${team}-${idx}-${engineRandom().toString(36).slice(2, 6)}`,
    name: data.name,
    displayName: `${data.name}${idx > 0 ? ` ${idx + 1}` : ''}`,
    monsterData: data,
    team,
    currentHp: data.hp,
    maxHp: data.hp,
    position: pos,
    initiative: 0,
    conditions: [],
    conditionTimers: [],
    isAlive: true,
    hasActed: false,
    hasMovedThisTurn: false,
    movementRemaining: Math.max(data.speed.walk, data.speed.fly ?? 0),
    legendaryActionsRemaining: data.legendaryActionUses,
    recharges: {},
    resources: { ...(data.initialResources || {}) },
    activeBuffs: [],
    turnFlags: {},
    stats: {
      damageDealt: 0,
      damageTaken: 0,
      attacksMade: 0,
      attacksHit: 0,
      killCount: 0,
      roundsSurvived: 0,
      actionUsage: {},
    },
  };
}
