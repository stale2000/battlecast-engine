// battlecast-engine - D&D 5e rules engine and combat state engine.
//
// Library surface: the Encounter state engine plus the underlying pure
// engine primitives for advanced callers. The MCP server (src/mcp/) is a
// thin adapter over this same surface.

export { Encounter, EncounterError } from './api/encounter.js';
export type {
  AddCreatureOptions,
  AddedCreature,
  EncounterOptions,
  EncounterPhase,
  RoundResult,
  Team,
} from './api/encounter.js';
export { EncounterManager } from './api/manager.js';
export { observeEncounter, viewCreature, formatLog } from './api/observation.js';
export type { CreatureView, EncounterView } from './api/observation.js';
export { getActiveCreature, getLegalActions, applyLegalAction } from './api/arena.js';
export type { ArenaAction } from './api/arena.js';

// Randomness
export { SeededRng, withRng, engineRandom } from './engine/rng.js';
export type { RandomSeed, RandomSource } from './engine/rng.js';

// Dice
export { rollDice, rollD20, rollAttack, rollSave, abilityModifier, averageDamage } from './engine/dice.js';
export type { RollResult } from './engine/dice.js';

// Engine primitives (escape hatch - same invariants as BattleCast)
export {
  initBattle,
  createCreature,
  createCreatureWithFixedHp,
  applyDamage,
  applyCondition,
  applyHealing,
  checkBattleComplete,
  isPositionBlocked,
  getFootprintSize,
  creatureDistance,
  distance,
  DEFAULT_TACTICS,
  TACTIC_LABELS,
} from './engine/combat.js';
export type { BattleState, BattleLog, TacticType, TeamTactics } from './engine/combat.js';
export { executeRound, executeTurn, runBattle, runMonteCarlo, moveToward } from './engine/ai.js';

// Content library
export { monsters, getMonsterByName, searchMonsters, getMonstersByCR, crToNumber } from './data/monsters.js';
export {
  buildHero,
  buildCustomHero,
  HERO_CLASS_NAMES,
  getMaxHeroLevelForClass,
  isSupportedHeroLevel,
} from './data/heroes.js';
export type { HeroClassName, HeroOverrides } from './data/heroes.js';

// Types
export type { Creature, MonsterData, Condition, ConditionDuration, Abilities, Speed } from './types/monster.js';
export type { AnimationEvent } from './types/animation.js';
export {
  parseTerrainMask,
  buildMovementBlockedSet,
  buildSightBlockedSet,
  buildDifficultTerrainSet,
  buildCoverMap,
  coverLevelBetween,
} from './types/terrain.js';
export type { TerrainCell, TerrainKind } from './types/terrain.js';

// Encounter difficulty
export * from './engine/difficulty.js';
