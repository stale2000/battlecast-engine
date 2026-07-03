/**
 * Public AI barrel.
 *
 * The AI implementation used to be a single ~2700-line file. Phases 3a/3b/3c
 * of the refactor split it into five focused modules:
 *
 *   ai-movement      - moveToward / nearestFootprintEdge (single source of
 *                      truth for creature movement, including step-wise
 *                      collision + bounds checking).
 *   ai-loop          - executeRound / runBattle / runMonteCarlo orchestrators.
 *   ai-targeting     - action getters, target selection, damage estimation,
 *                      AoE / retreat / ranged-vs-melee heuristics.
 *   ai-spellcasting  - spell selection + casting decision tree.
 *   ai-turn          - per-creature turn execution (executeTurn,
 *                      executeLegendaryAction, condition timers,
 *                      multiattack parsing, passive auras).
 *
 * External callers (tests, hooks, components, the worker) keep importing
 * from './ai.js'. This file simply re-exports the public surface so the
 * split is invisible to the rest of the codebase.
 */
export { moveToward, nearestFootprintEdge } from './ai-movement.js';
export { executeRound, runBattle, runMonteCarlo } from './ai-loop.js';
export type { MonteCarloResult, MonteCarloProgress } from './ai-loop.js';
export { shouldPreferRanged } from './ai-targeting.js';
export { trySpellcast } from './ai-spellcasting.js';
export { processConditionTimers, executeTurn, executeLegendaryAction, runOpportunityAttacks } from './ai-turn.js';
