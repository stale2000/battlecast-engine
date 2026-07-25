// The state engine: a stateful wrapper around the pure BattleCast combat
// engine. Owns creature setup, the BattleState lifecycle, per-encounter
// seeded randomness, and rules-validated manual edits (the "DM controls").
//
// Every mutation of engine state goes through the engine's sanctioned
// primitives (applyDamage, applyHealing, applyCondition, executeRound), and
// every position write is validated with isPositionBlocked + bounds - the
// same invariants BattleCast enforces.

import {
  type BattleState,
  type BattleLog,
  type TacticType,
  type TeamTactics,
  applyCondition,
  applyDamage,
  applyHealing,
  checkBattleComplete,
  createCreature,
  getActiveSize,
  getFootprintSize,
  initBattle,
  isPositionBlocked,
  pushLog,
} from '../engine/combat.js';
import { executeRound } from '../engine/ai.js';
import { SeededRng, withRng, type RandomSeed } from '../engine/rng.js';
import type { AnimationEvent } from '../types/animation.js';
import type { Condition, ConditionDuration, Creature, MonsterData } from '../types/monster.js';
import type { TerrainCell } from '../types/terrain.js';
import { getMonsterByName, searchMonsters } from '../data/monsters.js';
import {
  buildHero,
  buildCustomHero,
  isSupportedHeroLevel,
  type HeroClassName,
  type HeroOverrides,
  HERO_CLASS_NAMES,
} from '../data/heroes.js';
import { findPlacementSlots } from '../utils/placement.js';

export type Team = 'red' | 'blue';
export type EncounterPhase = 'setup' | 'active' | 'complete';

export interface EncounterOptions {
  gridSize?: number;
  /** Same seed + same call sequence = identical battle. Omit for Math.random. */
  seed?: RandomSeed;
  terrain?: TerrainCell[];
}

export interface AddCreatureOptions {
  /** SRD monster name, e.g. "Goblin". Mutually exclusive with heroClass. */
  monster?: string;
  /** Hero class, e.g. "Fighter". Requires heroLevel. */
  heroClass?: string;
  heroLevel?: number;
  /** Trusted-library overrides. Arena input validates its own narrow subset. */
  heroOverrides?: HeroOverrides;
  team: Team;
  /** Explicit origin cell. Omit to auto-place in the team's zone. */
  position?: { x: number; y: number };
  count?: number;
  /** Internal setup flag for a Find Familiar creature. Its copied stat block has no attacks. */
  familiar?: boolean;
  /** Arena-only pre-battle familiar form, resolved into a separate creature by the host. */
  familiarForm?: string;
}

export interface AddedCreature {
  id: string;
  name: string;
  position: { x: number; y: number };
}

export interface RoundResult {
  round: number;
  logs: BattleLog[];
  events: AnimationEvent[];
  isComplete: boolean;
  winner: BattleState['winner'];
}

export class EncounterError extends Error {}

export interface SerializedEncounter {
  version: 1;
  gridSize: number;
  seed: RandomSeed | null;
  rngState: number | null;
  setupCreatures: Creature[];
  setupIndexByName: [string, number][];
  battleState:
    | (Omit<BattleState, 'terrainBlocked' | 'terrainSightBlocked' | 'terrainDifficult'> & {
        terrainBlocked?: string[];
        terrainSightBlocked?: string[];
        terrainDifficult?: string[];
        terrainCover?: Record<string, 2 | 5>;
      })
    | null;
  arenaRoundCap?: number;
}

export class Encounter {
  readonly gridSize: number;
  readonly seed: RandomSeed | null;
  private rng: SeededRng | null;
  private setupCreatures: Creature[] = [];
  private battleState: BattleState | null = null;
  private setupIndexByName = new Map<string, number>();
  private arenaRoundCap?: number;
  private readonly terrain?: TerrainCell[];

  constructor(options: EncounterOptions = {}) {
    this.gridSize = options.gridSize ?? 20;
    if (!Number.isInteger(this.gridSize) || this.gridSize < 4 || this.gridSize > 100) {
      throw new EncounterError(`gridSize must be an integer between 4 and 100, got ${options.gridSize}`);
    }
    this.seed = options.seed ?? null;
    this.terrain = options.terrain;
    this.rng = this.seed === null ? null : new SeededRng(this.seed);
  }

  get phase(): EncounterPhase {
    if (!this.battleState) return 'setup';
    return this.battleState.isComplete ? 'complete' : 'active';
  }

  /** Raw engine state - escape hatch for advanced callers. Null during setup. */
  get state(): BattleState | null {
    return this.battleState;
  }

  get creatures(): Creature[] {
    return this.battleState ? this.battleState.creatures : this.setupCreatures;
  }

  private run<T>(fn: () => T): T {
    return withRng(this.rng, fn);
  }

  /** Runs a narrow external rules adapter under this encounter's RNG. */
  runWithRng<T>(fn: () => T): T {
    return this.run(fn);
  }

  setArenaRoundCap(roundCap: number): void {
    if (!Number.isInteger(roundCap) || roundCap < 1) {
      throw new EncounterError(`roundCap must be a positive integer, got ${roundCap}`);
    }
    this.arenaRoundCap = roundCap;
  }

  getArenaRoundCap(): number | undefined {
    return this.arenaRoundCap;
  }

  private requireActiveState(): BattleState {
    if (!this.battleState) {
      throw new EncounterError('Battle has not started. Call start() first.');
    }
    return this.battleState;
  }

  private findCreature(id: string): Creature {
    const creature = this.creatures.find(c => c.id === id);
    if (!creature) {
      const known = this.creatures.map(c => c.id).join(', ') || '(none)';
      throw new EncounterError(`No creature with id "${id}". Known ids: ${known}`);
    }
    return creature;
  }

  private resolveMonsterData(options: AddCreatureOptions): MonsterData {
    if (options.monster && options.heroClass) {
      throw new EncounterError('Pass either monster or heroClass, not both.');
    }
    if (options.monster) {
      const data = getMonsterByName(options.monster);
      if (!data) {
        const suggestions = searchMonsters(options.monster).slice(0, 5).map(m => m.name);
        throw new EncounterError(
          `Unknown monster "${options.monster}".` +
          (suggestions.length ? ` Closest matches: ${suggestions.join(', ')}.` : ' Use search_monsters to browse the library.')
        );
      }
      return data;
    }
    if (options.heroClass) {
      const heroClass = HERO_CLASS_NAMES.find(n => n.toLowerCase() === options.heroClass!.toLowerCase());
      if (!heroClass) {
        throw new EncounterError(`Unknown hero class "${options.heroClass}". Available: ${HERO_CLASS_NAMES.join(', ')}.`);
      }
      const level = options.heroLevel ?? 1;
      if (!isSupportedHeroLevel(heroClass, level)) {
        throw new EncounterError(`Level ${level} is not supported for ${heroClass}.`);
      }
      return this.run(() => options.heroOverrides
        ? buildCustomHero(heroClass as HeroClassName, level, options.heroOverrides)
        : buildHero(heroClass as HeroClassName, level));
    }
    throw new EncounterError('Pass a monster name or a heroClass.');
  }

  addCreature(options: AddCreatureOptions): AddedCreature[] {
    if (this.battleState) {
      throw new EncounterError('Battle already started - creatures can only be added during setup.');
    }
    const resolvedData = this.resolveMonsterData(options);
    // Find Familiar explicitly prevents its spirit from taking the Attack
    // action. Keep that invariant in its creature data, rather than relying
    // on a caller to filter the familiar's action catalogue.
    const data = options.familiar ? { ...resolvedData, actions: [] } : resolvedData;
    const count = options.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new EncounterError(`count must be an integer between 1 and 50, got ${count}`);
    }

    let positions: { x: number; y: number }[];
    if (options.position) {
      if (count !== 1) {
        throw new EncounterError('An explicit position only works with count 1. Omit position to auto-place groups.');
      }
      this.validatePosition(options.position, data.size, undefined);
      positions = [options.position];
    } else {
      positions = findPlacementSlots(data.size, count, options.team, this.setupCreatures, this.gridSize);
      if (positions.length < count) {
        throw new EncounterError(
          `Only ${positions.length} of ${count} ${data.name}(s) fit in the ${options.team} team's zone on a ${this.gridSize}x${this.gridSize} grid.`
        );
      }
    }

    const baseIndex = this.setupIndexByName.get(data.name) ?? 0;
    const added: AddedCreature[] = [];
    for (let i = 0; i < positions.length; i++) {
      const creature = this.run(() => createCreature(data, options.team, positions[i], baseIndex + i));
      // Deterministic, human-friendly ids: goblin-red-1. createCreature appends
      // a random suffix for React key uniqueness; the API layer replaces it so
      // MCP clients can address creatures by a stable, guessable id.
      creature.id = this.nextStableId(data.name, options.team);
      this.setupCreatures.push(creature);
      added.push({ id: creature.id, name: creature.displayName, position: { ...creature.position } });
    }
    this.setupIndexByName.set(data.name, baseIndex + positions.length);
    return added;
  }

  private nextStableId(name: string, team: Team): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let n = 1;
    let id = `${slug}-${team}-${n}`;
    const taken = new Set(this.creatures.map(c => c.id));
    while (taken.has(id)) {
      n += 1;
      id = `${slug}-${team}-${n}`;
    }
    return id;
  }

  removeCreature(id: string): void {
    const creature = this.findCreature(id);
    if (this.battleState) {
      const state = this.battleState;
      state.creatures = state.creatures.filter(c => c.id !== id);
      state.initiativeOrder = state.initiativeOrder.filter(cid => cid !== id);
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: 'DM', action: 'Remove',
        details: `${creature.displayName} is removed from the battle.`,
        type: 'info',
      });
      this.run(() => checkBattleComplete(state));
    } else {
      this.setupCreatures = this.setupCreatures.filter(c => c.id !== id);
    }
  }

  setTeamTactics(team: Team, tactic: TacticType): void {
    const state = this.requireActiveState();
    state.teamTactics = { ...state.teamTactics, [team]: tactic } as TeamTactics;
  }

  start(): { initiativeOrder: { id: string; name: string; initiative: number }[] } {
    if (this.battleState) {
      throw new EncounterError('Battle already started.');
    }
    if (this.setupCreatures.filter(c => c.team === 'red').length === 0 ||
        this.setupCreatures.filter(c => c.team === 'blue').length === 0) {
      throw new EncounterError('Both teams need at least one creature before starting.');
    }
    this.battleState = this.run(() => initBattle(this.setupCreatures, this.gridSize, this.terrain));
    const state = this.battleState;
    return {
      initiativeOrder: [...new Set(state.initiativeOrder)].map(id => {
        const c = state.creatures.find(cr => cr.id === id)!;
        return { id, name: c.displayName, initiative: c.initiative };
      }),
    };
  }

  /** AI plays one full round for every creature in initiative order. */
  runRound(): RoundResult {
    const state = this.requireActiveState();
    if (state.isComplete) {
      throw new EncounterError('Battle is already complete.');
    }
    const round = state.round;
    const logCursor = state.logs.length;
    const eventCursor = state.events.length;
    this.run(() => executeRound(state));
    return {
      round,
      logs: state.logs.slice(logCursor),
      events: state.events.slice(eventCursor),
      isComplete: state.isComplete,
      winner: state.winner,
    };
  }

  runToCompletion(maxRounds: number = 50): { rounds: number; isComplete: boolean; winner: BattleState['winner'] } {
    const state = this.requireActiveState();
    let rounds = 0;
    while (!state.isComplete && rounds < maxRounds) {
      this.run(() => executeRound(state));
      rounds += 1;
    }
    return { rounds, isComplete: state.isComplete, winner: state.winner };
  }

  // ---- DM controls ----

  damage(id: string, amount: number, damageType: string = 'force'): { taken: number; currentHp: number; isAlive: boolean } {
    const state = this.requireActiveState();
    const target = this.findCreature(id);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new EncounterError(`Damage amount must be a positive number, got ${amount}`);
    }
    const taken = this.run(() => applyDamage(state, target, Math.floor(amount), damageType, null, false, true));
    this.run(() => checkBattleComplete(state));
    return { taken, currentHp: target.currentHp, isAlive: target.isAlive };
  }

  heal(id: string, amount: number): { currentHp: number; maxHp: number } {
    const state = this.requireActiveState();
    const target = this.findCreature(id);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new EncounterError(`Heal amount must be a positive number, got ${amount}`);
    }
    this.run(() => applyHealing(state, target, Math.floor(amount), target, 'DM Healing'));
    return { currentHp: target.currentHp, maxHp: target.maxHp };
  }

  addCondition(id: string, condition: Condition, duration: ConditionDuration = 'permanent'): { conditions: Condition[] } {
    const state = this.requireActiveState();
    const target = this.findCreature(id);
    const applied = this.run(() => applyCondition(state, target, condition, target, duration));
    if (!applied) {
      throw new EncounterError(
        `${target.displayName} was not affected by ${condition} (immune, dead, or already affected).`
      );
    }
    return { conditions: [...target.conditions] };
  }

  removeCondition(id: string, condition: Condition): { conditions: Condition[] } {
    this.requireActiveState();
    const target = this.findCreature(id);
    if (!target.conditions.includes(condition)) {
      throw new EncounterError(`${target.displayName} does not have the ${condition} condition.`);
    }
    target.conditions = target.conditions.filter(c => c !== condition);
    target.conditionTimers = target.conditionTimers.filter(t => t.condition !== condition);
    return { conditions: [...target.conditions] };
  }

  /**
   * DM teleport: places the creature at `to` if the destination is in bounds
   * and unblocked. This is a forced relocation in BattleCast's taxonomy - it
   * does not consume movement or provoke opportunity attacks.
   */
  moveCreature(id: string, to: { x: number; y: number }): { position: { x: number; y: number } } {
    const state = this.requireActiveState();
    const creature = this.findCreature(id);
    this.validatePosition(to, getActiveSize(creature), creature.id);
    creature.position = { x: to.x, y: to.y };
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: 'DM', action: 'Move',
      details: `${creature.displayName} is placed at (${to.x}, ${to.y}).`,
      type: 'move',
    });
    return { position: { ...creature.position } };
  }

  // ---- Serialization ----
  //
  // BattleState is plain data except terrainBlocked/terrainSightBlocked
  // (Sets, stored as arrays) and the RNG (stored as a state snapshot).
  // Creatures embed their MonsterData, so a snapshot is self-contained.

  toJSON(): SerializedEncounter {
    const state = this.battleState;
    return {
      version: 1,
      gridSize: this.gridSize,
      seed: this.seed,
      rngState: this.rng?.snapshot() ?? null,
      setupCreatures: this.battleState ? [] : this.setupCreatures,
      setupIndexByName: [...this.setupIndexByName.entries()],
      battleState: state
        ? {
            ...state,
            terrainBlocked: state.terrainBlocked ? [...state.terrainBlocked] : undefined,
            terrainSightBlocked: state.terrainSightBlocked ? [...state.terrainSightBlocked] : undefined,
            terrainDifficult: state.terrainDifficult ? [...state.terrainDifficult] : undefined,
            terrainCover: state.terrainCover,
          }
        : null,
      arenaRoundCap: this.arenaRoundCap,
    };
  }

  static fromJSON(snapshot: SerializedEncounter): Encounter {
    const copy = structuredClone(snapshot);
    if (copy.version !== 1) {
      throw new EncounterError(`Unsupported snapshot version ${copy.version}.`);
    }
    const encounter = new Encounter({ gridSize: copy.gridSize, seed: copy.seed ?? undefined });
    if (encounter.rng && copy.rngState !== null) {
      encounter.rng.restore(copy.rngState);
    }
    encounter.setupCreatures = copy.setupCreatures;
    encounter.setupIndexByName = new Map(copy.setupIndexByName);
    encounter.arenaRoundCap = copy.arenaRoundCap;
    if (copy.battleState) {
      encounter.battleState = {
        ...copy.battleState,
        terrainBlocked: copy.battleState.terrainBlocked
          ? new Set(copy.battleState.terrainBlocked)
          : undefined,
        terrainSightBlocked: copy.battleState.terrainSightBlocked
          ? new Set(copy.battleState.terrainSightBlocked)
          : undefined,
        terrainDifficult: copy.battleState.terrainDifficult
          ? new Set(copy.battleState.terrainDifficult)
          : undefined,
        terrainCover: copy.battleState.terrainCover,
      };
    }
    return encounter;
  }

  private validatePosition(pos: { x: number; y: number }, size: string, excludeId?: string): void {
    const fp = getFootprintSize(size);
    if (!Number.isInteger(pos.x) || !Number.isInteger(pos.y) ||
        pos.x < 0 || pos.y < 0 || pos.x + fp > this.gridSize || pos.y + fp > this.gridSize) {
      throw new EncounterError(
        `Position (${pos.x}, ${pos.y}) with footprint ${fp}x${fp} is outside the ${this.gridSize}x${this.gridSize} grid.`
      );
    }
    const blocked = isPositionBlocked(pos, size, this.creatures, excludeId, this.battleState?.terrainBlocked);
    if (blocked) {
      throw new EncounterError(`Position (${pos.x}, ${pos.y}) is blocked by another creature or terrain.`);
    }
  }
}
