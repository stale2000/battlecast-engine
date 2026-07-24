import { engineRandom } from './rng.js';
import { ActiveBuff, Creature, Condition, ConditionDuration, DarknessZone, MonsterAction, MonsterData, PersistentZone, RuntimeTraitEffect } from '../types/monster.js';
import { AnimationEvent, BASE_DURATIONS, OA_ATTACK_DURATIONS } from '../types/animation.js';
import { rollAttack, rollDamage, rollDice, rollInitiative, abilityModifier, rollSave, rollD20, maxDiceTotal } from './dice.js';
import { lineOfSightBlocked } from '../types/terrain.js';
import { magicalDarknessBlocksSight } from './visibility.js';
import {
  distance, getFootprintSize, creatureDistance, isPositionBlocked, canHalflingPassThrough,
  isInMeleeRange, isInCone, isInLine,
} from './combat-geometry.js';
import {
  rollAttackBuffBonus, getRageDamageBonus,
  rollSaveWithBuffs, applyBuffDamageResistance, applyDamageRollPenalty,
  getSpellSaveDcBonus,
  hasResource, consumeResource,
  lowestAvailableSlot,
  addBuff,
  dropConcentratedBuffsFrom,
  removeActiveBuff,
} from './combat-buffs.js';
import { applyHealing, applyTemporaryHp } from './combat-spellcasting.js';
import { pushTargetAwayFromCaster } from './combat-aoe.js';

export interface BattleLog {
  round: number;
  turn: number;
  actor: string;
  action: string;
  details: string;
  damage?: number;
  type: 'attack' | 'damage' | 'miss' | 'save' | 'heal' | 'death' | 'move' | 'condition' | 'info' | 'critical' | 'special';
  eventIndex: number; // index into state.events at time of creation, for lockstep log reveal
}

export type TacticType = 'aggressive' | 'smart' | 'kiting' | 'defensive';

export interface TeamTactics {
  red: TacticType;
  blue: TacticType;
  redNoFriendlyFire?: boolean;
  blueNoFriendlyFire?: boolean;
  /**
   * When true, the team's target picker treats dying enemies the same as
   * standing ones (so it'll naturally finish a downed hero off via auto-
   * fails from adjacent melee, or focus the lowest-HP target on a smart
   * tactic). Default false = deprioritise dying targets, only attack them
   * when no standing enemies remain.
   */
  redFinishDowned?: boolean;
  blueFinishDowned?: boolean;
  /**
   * When true, conscious heroes can spend their action to stabilise an
   * adjacent dying ally if no better revive-heal action was taken first.
   * Default true: this is normal table behavior and keeps non-healer
   * parties from passively watching allies bleed out.
   */
  redStabiliseAllies?: boolean;
  blueStabiliseAllies?: boolean;
}

export const DEFAULT_TACTICS: TeamTactics = {
  red: 'smart',
  blue: 'smart',
  redNoFriendlyFire: true,
  blueNoFriendlyFire: true,
  redFinishDowned: false,
  blueFinishDowned: false,
  redStabiliseAllies: true,
  blueStabiliseAllies: true,
};

export const TACTIC_LABELS: Record<TacticType, { name: string; description: string }> = {
  aggressive: { name: 'Aggressive', description: 'Charge the nearest enemy, never retreat' },
  smart:      { name: 'Smart',      description: 'Focus fire on wounded targets, retreat when low' },
  kiting:     { name: 'Kiting',     description: 'Prefer ranged, keep distance, retreat early' },
  defensive:  { name: 'Defensive',  description: 'Hold position, protect allies, stand ground' },
};

export interface BattleState {
  creatures: Creature[];
  round: number;
  turnIndex: number;
  initiativeOrder: string[]; // creature IDs in order
  logs: BattleLog[];
  events: AnimationEvent[];
  isComplete: boolean;
  winner: 'red' | 'blue' | 'draw' | null;
  gridSize?: number;
  teamTactics: TeamTactics;
  /**
   * Precomputed set of `"x,y"`-keyed cells that block movement (walls
   * + chasms from the active map preset). Read by moveToward and
   * placement logic for O(1) per-cell lookups. Undefined or empty =
   * open terrain everywhere (classic pre-terrain behavior).
   */
  terrainBlocked?: Set<string>;
  /**
   * Separate set of cells that block line of sight - walls only, NOT
   * chasms. Ranged attacks consult this to see if there's a clear
   * line between attacker and target. Kept separate from the movement
   * set because you can shoot across a lava pool you can't walk
   * through. Undefined or empty = open sight everywhere.
   */
  terrainSightBlocked?: Set<string>;
  /** Temporary magical-darkness areas, serialized with the encounter. */
  darknessZones?: DarknessZone[];
  /** Static control terrain such as Grease. */
  persistentZones?: PersistentZone[];
  /**
   * Optional environment override for research/special encounters. Land is
   * the default. Underwater uses Swim Speed when available, or half Walk
   * Speed for creatures without a swim speed.
   */
  movementEnvironment?: 'land' | 'underwater';
}

export function pushLog(state: BattleState, entry: Omit<BattleLog, 'eventIndex'>): void {
  state.logs.push({ ...entry, eventIndex: state.events.length });
}

function pushEffectEvent(
  state: BattleState,
  creatureId: string,
  label: string,
  tone: Extract<AnimationEvent, { kind: 'effect' }>['tone'] = 'arcane',
): void {
  state.events.push({
    kind: 'effect',
    creatureId,
    label: label.length > 24 ? `${label.slice(0, 22)}...` : label,
    tone,
    durationMs: BASE_DURATIONS.effect,
  });
}

export function creatureIdPrefix(name: string): string {
  const prefix = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return prefix || 'creature';
}

function getHydraHeadConfig(data: MonsterData): { startingHeads: number; damagePerHead: number; regrowHp: number } | null {
  const effect = data.traits
    ?.flatMap(trait => trait.effects ?? [])
    .find(effect => effect.kind === 'hydraHeads');
  if (effect?.kind === 'hydraHeads') return effect;
  if (data.name === 'Hydra') return { startingHeads: 5, damagePerHead: 25, regrowHp: 20 };
  return null;
}

export function createCreature(
  monsterData: MonsterData,
  team: 'red' | 'blue',
  position: { x: number; y: number },
  index: number = 0
): Creature {
  const hp = rollDice(monsterData.hpFormula).total || monsterData.hp;
  const hydraConfig = getHydraHeadConfig(monsterData);
  return {
    id: `${creatureIdPrefix(monsterData.name)}-${team}-${index}-${engineRandom().toString(36).slice(2, 6)}`,
    name: monsterData.name,
    displayName: index > 0 ? `${monsterData.name} ${index + 1}` : monsterData.name,
    monsterData,
    team,
    currentHp: hp,
    maxHp: hp,
    temporaryHp: 0,
    position,
    initiative: 0,
    conditions: [],
    conditionTimers: [],
    isAlive: true,
    hasActed: false,
    hasMovedThisTurn: false,
    movementRemaining: Math.max(monsterData.speed.walk, monsterData.speed.fly ?? 0),
    legendaryActionsRemaining: monsterData.legendaryActionUses,
    // Flyers start airborne (above grounded melee reach). Falsified the
    // moment they make a melee attack; reset true at the start of their
    // turn (they re-ascend with the first chunk of movement).
    airborne: (monsterData.speed.fly ?? 0) > 0,
    recharges: {},
    // Copy initial resources (spell slots, rage uses, ki, etc.) from the
    // static stat block into mutable per-creature state. Object is always
    // present even for monsters with no resources - the engine reads/writes
    // it freely via the consumeResource / hasResource helpers.
    resources: { ...(monsterData.initialResources || {}) },
    activeBuffs: [],
    turnFlags: {},
    hydraHeads: hydraConfig ? {
      living: hydraConfig.startingHeads,
      killedSinceTurn: 0,
      tookFireSinceTurn: false,
    } : undefined,
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

export function createCreatureWithFixedHp(
  monsterData: MonsterData,
  team: 'red' | 'blue',
  position: { x: number; y: number },
  index: number = 0
): Creature {
  return {
    ...createCreature(monsterData, team, position, index),
    currentHp: monsterData.hp,
    maxHp: monsterData.hp,
  };
}

export function getActiveSize(creature: Creature): MonsterData['size'] {
  return creature.wildShape?.size ?? creature.temporarySize ?? creature.monsterData.size;
}

export function getActiveSpeed(creature: Creature): MonsterData['speed'] {
  const speed = creature.wildShape?.speed ?? creature.monsterData.speed;
  return creature.temporaryFlightSpeed ? { ...speed, fly: Math.max(speed.fly ?? 0, creature.temporaryFlightSpeed) } : speed;
}

export function getEffectiveMoveSpeed(creature: Creature, state?: Pick<BattleState, 'movementEnvironment'>): number {
  const speed = getActiveSpeed(creature);
  const bonus = Math.max(0, ...((creature.activeBuffs ?? []).map(buff => buff.speedBonus ?? 0)));
  const penalty = Math.max(0, ...((creature.activeBuffs ?? []).map(buff => buff.speedPenalty ?? 0)));
  if (state?.movementEnvironment === 'underwater') {
    return Math.max(0, Math.max(speed.swim ?? 0, Math.floor((speed.walk ?? 0) / 2)) + bonus - penalty);
  }
  return Math.max(0, Math.max(speed.walk ?? 0, speed.fly ?? 0) + bonus - penalty);
}

export function canTakeReactions(creature: Creature): boolean {
  return !creature.reactionUsed && !(creature.activeBuffs ?? []).some(buff => buff.preventsReactions);
}

export function getActiveTraits(creature: Creature) {
  return creature.wildShape?.traits ?? creature.monsterData.traits ?? [];
}

export function getHydraHeadCount(creature: Creature): number | null {
  const config = getHydraHeadConfig(creature.monsterData);
  if (!config) return null;
  creature.hydraHeads = creature.hydraHeads ?? {
    living: config.startingHeads,
    killedSinceTurn: 0,
    tookFireSinceTurn: false,
  };
  return creature.hydraHeads.living;
}

export function hasActiveTrait(creature: Creature, traitName: string): boolean {
  return getActiveTraits(creature).some(t => t.name === traitName || t.name.includes(traitName));
}

export function getEffectiveAbilityScore(creature: Creature, ability: keyof MonsterData['abilities']): number {
  const damage = creature.abilityScoreDamage?.[ability] ?? 0;
  const base = creature.wildShape && (ability === 'str' || ability === 'dex' || ability === 'con')
    ? creature.wildShape.abilities[ability]
    : creature.monsterData.abilities[ability];
  return Math.max(0, base - damage);
}

function getBaseSaveModifier(creature: Creature, ability: keyof MonsterData['abilities']): number {
  const printedBase = creature.monsterData.saves?.[ability] ?? abilityModifier(creature.monsterData.abilities[ability]);
  const baseScore = creature.monsterData.abilities[ability];
  const scoreDelta = abilityModifier(getEffectiveAbilityScore(creature, ability)) - abilityModifier(baseScore);
  return printedBase + scoreDelta;
}

function paladinAuraRange(paladin: Creature): number {
  return (paladin.monsterData.heroLevel ?? 0) >= 18 ? 30 : 10;
}

function isPaladinAuraActive(paladin: Creature): boolean {
  return paladin.isAlive
    && paladin.monsterData.heroClass === 'Paladin'
    && !paladin.conditions.some(condition =>
      condition === 'incapacitated' ||
      condition === 'unconscious' ||
      condition === 'stunned' ||
      condition === 'paralyzed' ||
      condition === 'petrified'
    );
}

function paladinAuraSaveBonus(state: BattleState | undefined, creature: Creature): number {
  if (!state) return 0;
  return getAliveCreatures(state, creature.team)
    .filter(ally => isPaladinAuraActive(ally))
    .filter(ally => (ally.monsterData.heroLevel ?? 0) >= 6)
    .filter(ally => creatureDistance(ally, creature) <= paladinAuraRange(ally))
    .reduce((best, paladin) => Math.max(best, Math.max(1, abilityModifier(paladin.monsterData.abilities.cha))), 0);
}

export function getEffectiveSaveModifier(creature: Creature, ability: keyof MonsterData['abilities'], state?: BattleState): number {
  const base = getBaseSaveModifier(creature, ability);
  const classOrBeastSave = creature.wildShape
    ? Math.max(base, creature.wildShape.saves?.[ability] ?? abilityModifier(getEffectiveAbilityScore(creature, ability)))
    : base;
  return classOrBeastSave + paladinAuraSaveBonus(state, creature);
}

function revertWildShape(state: BattleState, target: Creature, reason: string): void {
  if (!target.wildShape) return;
  const beastName = target.wildShape.beastName;
  target.wildShape = undefined;
  state.events.push({ kind: 'wildShape', creatureId: target.id, beastName: null, durationMs: 0 });
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Wild Shape Reverted',
    details: `${target.displayName}'s ${beastName} form ends${reason ? ` (${reason})` : ''}.`,
    type: 'special'
  });
}

function removeConditionFromSource(state: BattleState, target: Creature, condition: Condition, sourceId: string): void {
  const hadCondition = target.conditions.includes(condition);
  target.conditionTimers = target.conditionTimers.filter(timer =>
    !(timer.condition === condition && timer.sourceId === sourceId)
  );
  const stillHasCondition = target.conditionTimers.some(timer => timer.condition === condition);
  if (hadCondition && !stillHasCondition) {
    target.conditions = target.conditions.filter(c => c !== condition);
    state.events.push({ kind: 'condition', creatureId: target.id, condition, applied: false, durationMs: 0 });
  }
}

function releaseSwallowedCreature(state: BattleState, source: Creature, target: Creature, prone: boolean): void {
  if (target.swallowedBy?.sourceId !== source.id) return;
  target.swallowedBy = undefined;
  if (source.swallowedTargetId === target.id) source.swallowedTargetId = undefined;
  removeConditionFromSource(state, target, 'blinded', source.id);
  removeConditionFromSource(state, target, 'restrained', source.id);
  if (prone && target.isAlive && !target.conditions.includes('prone')) {
    applyCondition(state, target, 'prone', source, 'end_of_next_turn');
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Released',
    details: `${target.displayName} is no longer swallowed by ${source.displayName}.`,
    type: 'condition'
  });
}

function releaseSwallowedTargets(state: BattleState, source: Creature): void {
  for (const target of state.creatures) {
    if (target.swallowedBy?.sourceId === source.id) {
      releaseSwallowedCreature(state, source, target, true);
    }
  }
}

function applySwallowedDamage(state: BattleState, source: Creature, target: Creature): void {
  if (!target.swallowedBy || target.swallowedBy.sourceId !== source.id || !target.isAlive) return;
  const damage = rollDice(target.swallowedBy.damageDice).total;
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: source.displayName, action: 'Swallowed',
    details: `${target.displayName} takes ${damage} ${target.swallowedBy.damageType} damage inside ${source.displayName}.`,
    damage,
    type: 'damage'
  });
  applyDamage(state, target, damage, target.swallowedBy.damageType, source, false, true);
}

export function processSwallowedTargets(state: BattleState, source: Creature): void {
  const target = source.swallowedTargetId ? getCreatureById(state, source.swallowedTargetId) : undefined;
  if (!target || !target.isAlive || target.swallowedBy?.sourceId !== source.id) {
    source.swallowedTargetId = undefined;
    return;
  }
  applySwallowedDamage(state, source, target);
}

export function resolveSwallowAction(state: BattleState, attacker: Creature, target: Creature, action: MonsterAction): boolean {
  if (action.name !== 'Swallow') return false;
  if (attacker.swallowedTargetId) return false;
  if (!target.conditions.includes('grappled')) return false;
  const grappleTimers = target.conditionTimers.filter(timer => timer.condition === 'grappled');
  if (grappleTimers.length > 0 && !grappleTimers.some(timer => timer.sourceId === attacker.id)) return false;
  if (SIZE_RANK[getActiveSize(target)] > SIZE_RANK.Medium) return false;

  removeConditionFromSource(state, target, 'grappled', attacker.id);
  target.swallowedBy = { sourceId: attacker.id, damageDice: '3d6', damageType: 'acid' };
  attacker.swallowedTargetId = target.id;
  applyCondition(state, target, 'blinded', attacker, 'permanent');
  applyCondition(state, target, 'restrained', attacker, 'permanent');
  attacker.stats.actionUsage[action.name] = (attacker.stats.actionUsage[action.name] || 0) + 1;
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: action.name,
    details: `${attacker.displayName} swallows ${target.displayName}.`,
    type: 'special'
  });
  applySwallowedDamage(state, attacker, target);
  return true;
}

export function rollAllInitiatives(creatures: Creature[]): void {
  for (const c of creatures) {
    const dexMod = abilityModifier(getEffectiveAbilityScore(c, 'dex'));
    const halflingLuck = c.monsterData.heroSpecies === 'Halfling';
    c.initiative = rollInitiative(dexMod, halflingLuck);
    if (hasOriginFeat(c, 'Alert')) c.initiative += c.monsterData.proficiencyBonus;
    if (c.monsterData.heroClass === 'Barbarian' && (c.monsterData.heroLevel ?? 0) >= 7) {
      c.initiative = Math.max(c.initiative, rollInitiative(dexMod, halflingLuck));
    }
    if (c.monsterData.heroClass === 'Bard' && (c.monsterData.heroLevel ?? 0) >= 18) {
      c.resources['bardic-inspiration'] = Math.max(c.resources['bardic-inspiration'] ?? 0, 2);
    }
    if (c.monsterData.heroClass === 'Druid' && (c.monsterData.heroLevel ?? 0) >= 20) {
      c.resources['wild-shape'] = Math.max(c.resources['wild-shape'] ?? 0, 1);
    }
    if (c.monsterData.heroClass === 'Monk' && (c.monsterData.heroLevel ?? 0) >= 15) {
      const cap = c.monsterData.initialResources?.ki ?? Infinity;
      if ((c.resources.ki ?? 0) <= 3) {
        c.resources.ki = Math.min(cap, Math.max(c.resources.ki ?? 0, 4));
      }
    }
  }
}

export function getInitiativeOrder(creatures: Creature[]): string[] {
  return creatures
    .flatMap(creature => {
      const entries = [{ creature, initiative: creature.initiative }];
      if (hasThiefsReflexes(creature)) {
        entries.push({ creature, initiative: creature.initiative - 10 });
      }
      return entries;
    })
    .sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      // Tiebreaker: higher dex mod goes first
      const aDex = abilityModifier(getEffectiveAbilityScore(a.creature, 'dex'));
      const bDex = abilityModifier(getEffectiveAbilityScore(b.creature, 'dex'));
      if (bDex !== aDex) return bDex - aDex;
      return engineRandom() - 0.5;
    })
    .map(entry => entry.creature.id);
}

export function initBattle(creatures: Creature[], gridSize?: number): BattleState {
  rollAllInitiatives(creatures);
  const order = getInitiativeOrder(creatures);

  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: order,
    logs: [{
      round: 0, turn: 0, actor: 'System', action: 'Battle Start',
      details: `Battle begins! ${creatures.filter(c => c.team === 'red').length} Red vs ${creatures.filter(c => c.team === 'blue').length} Blue.`,
      type: 'info', eventIndex: 0
    }],
    events: [],
    isComplete: false,
    winner: null,
    gridSize,
    teamTactics: DEFAULT_TACTICS,
    darknessZones: [],
    persistentZones: [],
  };
}

// Geometry primitives (getFootprintSize, creatureDistance, isPositionBlocked,
// distance, isInMeleeRange, isInCone, isInLine, parseAoEShape) live in
// ./combat-geometry. They are re-exported at the bottom of this file so
// existing import sites keep working unchanged.

function getAliveCreatures(state: BattleState, team?: 'red' | 'blue'): Creature[] {
  return state.creatures.filter(c => c.isAlive && (!team || c.team === team));
}

/**
 * "Standing" = alive AND not currently dying. Used by the AI target
 * picker and similar "active threats" lookups - a dying hero contributes
 * nothing to the fight from the enemy's perspective.
 */
function getStandingCreatures(state: BattleState, team?: 'red' | 'blue'): Creature[] {
  return state.creatures.filter(c => c.isAlive && !c.dying && (!team || c.team === team));
}

/**
 * "Recoverable" = alive AND not stuck-at-0-HP-stabilised. A stabilised
 * hero is at 0 HP, unconscious, dying=false - they need an ally to heal
 * them back and there's no in-combat path otherwise. Everything else
 * (standing, dying, Sleep'd at HP>0, paralysed, restrained, prone) can
 * still come back into the fight one way or another.
 *
 * The previous formulation excluded ALL unconscious creatures from
 * recoverable, which broke Sleep: a team that got Sleep'd would
 * immediately end the battle even though they're at full HP and would
 * be woken by the next damage instance. This version explicitly only
 * rules out the "0 HP, not rolling, stays asleep" stable case.
 *
 * Battle-complete is gated on this set so:
 *   - a lone dying hero gets to roll death saves until they pop up,
 *     stabilise, or die (preserves the demo + matches real D&D);
 *   - a team of all-stabilised heroes loses (no path back to standing);
 *   - a team of all-Sleep'd-but-healthy creatures keeps the battle going.
 */
function getRecoverableCreatures(state: BattleState, team?: 'red' | 'blue'): Creature[] {
  return state.creatures.filter(c => {
    if (!c.isAlive) return false;
    if (team && c.team !== team) return false;
    // Stabilised-at-0 case: HP=0, not actively rolling, unconscious -
    // no in-combat path back. Counts as out for battle-complete.
    if (c.currentHp === 0 && !c.dying && c.conditions.includes('unconscious')) return false;
    return true;
  });
}

function getCreatureById(state: BattleState, id: string): Creature | undefined {
  return state.creatures.find(c => c.id === id);
}

function getEnemies(state: BattleState, creature: Creature): Creature[] {
  return getAliveCreatures(state).filter(c => c.team !== creature.team);
}

function getAllies(state: BattleState, creature: Creature): Creature[] {
  return getAliveCreatures(state).filter(c => c.team === creature.team && c.id !== creature.id);
}

function hasAdjacentAlly(state: BattleState, creature: Creature, target: Creature): boolean {
  return getAllies(state, creature).some(ally =>
    creatureDistance(ally, target) <= 5 && ally.isAlive
  );
}

function hasAdvantage(state: BattleState, attacker: Creature, target: Creature, action: MonsterAction): boolean {
  let adv = false;

  // A creature that successfully hid from this target attacks with
  // Advantage. resolveAttack removes the hidden state immediately after
  // the attempt, so the benefit cannot be reused for later attacks.
  if (attacker.activeBuffs?.some(b => b.key === `hidden-from:${target.id}`)) adv = true;

  // Weapon Mastery: Vex gives this attacker Advantage on the next attack roll.
  if (target.activeBuffs?.some(b => b.advantageForAttackerId === attacker.id)) adv = true;
  // Guiding Bolt-style rider: the next attack roll against this target has Advantage.
  if (target.activeBuffs?.some(b => b.advantageForAllAttackers)) adv = true;
  // Innate Sorcery: Sorcerer spell attack rolls have Advantage while active.
  if (action.spellLevel !== undefined && action.attackBonus !== undefined &&
      attacker.activeBuffs?.some(b => b.spellAttackAdvantage)) adv = true;
  // Ranger L17 Precise Hunter: attacks have Advantage against the
  // creature currently marked by this Ranger's Hunter's Mark.
  if (attacker.monsterData.heroClass === 'Ranger' && (attacker.monsterData.heroLevel ?? 0) >= 17 &&
      target.activeBuffs?.some(b => b.key === 'hunters-mark' && b.casterId === attacker.id)) {
    adv = true;
  }
  // Rogue L3 Steady Aim: no movement this turn, spend bonus action for
  // Advantage on the next attack.
  if (attacker.turnFlags?.steadyAim && !attacker.turnFlags.steadyAimConsumed && (action.type === 'melee' || action.type === 'ranged')) adv = true;

  // Pack tactics
  const hasPT = hasActiveTrait(attacker, 'Pack Tactics');
  if (hasPT && hasAdjacentAlly(state, attacker, target)) adv = true;

  // Target is prone and melee
  if (target.conditions.includes('prone') && action.type === 'melee') adv = true;

  // Target is paralyzed, stunned, or unconscious
  if (target.conditions.includes('paralyzed') || target.conditions.includes('stunned') || target.conditions.includes('unconscious')) adv = true;

  // Target is restrained
  if (target.conditions.includes('restrained')) adv = true;

  // Target is blinded - they can't see incoming attacks
  if (target.conditions.includes('blinded')) adv = true;

  // Attacker is invisible
  if (attacker.conditions.includes('invisible')) adv = true;

  // Reckless Attack (Barbarian): advantage on STR-based melee attacks this turn
  if (attacker.turnFlags?.reckless && action.type === 'melee') adv = true;
  if (action.attackAbility === 'str' && attacker.activeBuffs?.some(b => b.strengthTestAdvantage)) adv = true;

  // Target used Reckless Attack: attackers have advantage against them
  if (target.turnFlags?.reckless) adv = true;

  return adv;
}

function fighterCriticalThreshold(attacker: Creature, action: MonsterAction): number {
  if (attacker.monsterData.heroClass !== 'Fighter') return 20;
  if (action.spellLevel !== undefined) return 20;
  if (action.type !== 'melee' && action.type !== 'ranged') return 20;
  const level = attacker.monsterData.heroLevel ?? 0;
  if (level >= 15) return 18;
  if (level >= 3) return 19;
  return 20;
}

function canUseCombatProwess(attacker: Creature, action: MonsterAction): boolean {
  return attacker.monsterData.heroClass === 'Fighter'
    && (attacker.monsterData.heroLevel ?? 0) >= 19
    && action.spellLevel === undefined
    && (action.type === 'melee' || action.type === 'ranged')
    && !attacker.turnFlags?.['combat-prowess-used'];
}

function isSorcererSpellAttack(attacker: Creature, action: MonsterAction): boolean {
  return attacker.monsterData.heroClass === 'Sorcerer'
    && (attacker.monsterData.heroLevel ?? 0) >= 2
    && action.spellLevel !== undefined
    && action.attackBonus !== undefined;
}

function hasInnateSorceryActive(attacker: Creature): boolean {
  return attacker.activeBuffs?.some(buff => buff.key === 'innate-sorcery') ?? false;
}

function paySorcererMetamagic(attacker: Creature, cost: number): 'free' | 'paid' | null {
  if ((attacker.monsterData.heroLevel ?? 0) >= 20 &&
      hasInnateSorceryActive(attacker) &&
      !attacker.turnFlags?.['arcane-apotheosis-metamagic-used']) {
    if (!attacker.turnFlags) attacker.turnFlags = {};
    attacker.turnFlags['arcane-apotheosis-metamagic-used'] = true;
    attacker.stats.actionUsage['Arcane Apotheosis'] = (attacker.stats.actionUsage['Arcane Apotheosis'] || 0) + 1;
    return 'free';
  }
  if (!hasResource(attacker, 'sorcery', cost)) return null;
  consumeResource(attacker, 'sorcery', cost);
  return 'paid';
}

/** Resolve the standard action to escape one source's Grappled condition. */
export function escapeGrapple(
  state: BattleState,
  target: Creature,
  sourceId: string,
  ability: 'str' | 'dex',
): boolean {
  const timer = target.conditionTimers.find(entry => entry.condition === 'grappled' && entry.sourceId === sourceId);
  const source = getCreatureById(state, sourceId);
  if (!timer || !source?.isAlive) return false;
  const dc = timer.saveDC ?? 8 + source.monsterData.proficiencyBonus + abilityModifier(getEffectiveAbilityScore(source, 'str'));
  const advantage = target.monsterData.heroSpecies === 'Goliath';
  const disadvantage = (target.activeBuffs ?? []).some(buff => buff.abilityCheckDisadvantageAbilities?.includes(ability));
  const rolled = rollAttack(0, advantage, disadvantage);
  const total = rolled.naturalRoll + abilityModifier(getEffectiveAbilityScore(target, ability));
  const success = total >= dc;
  state.events.push({ kind: 'save', targetId: target.id, success, durationMs: BASE_DURATIONS.save });
  if (success) removeConditionFromSource(state, target, 'grappled', sourceId);
  pushLog(state, {
    round: state.round, turn: state.turnIndex, actor: target.displayName, action: 'Escape Grapple',
    details: `${target.displayName} ${success ? 'escapes' : 'fails to escape'} ${source.displayName}'s grapple (${total} vs DC ${dc}).`,
    type: success ? 'special' : 'condition',
  });
  return true;
}

/** Resolve an action-based check that ends one spell buff, such as Entangle or Web. */
export function escapeBuff(
  state: BattleState,
  target: Creature,
  buffKey: string,
): boolean {
  const buff = target.activeBuffs.find(candidate => candidate.key === buffKey && candidate.escapeAction);
  if (!buff?.escapeAction) return false;
  const rolled = rollAttack(0, target.monsterData.heroSpecies === 'Goliath', (target.activeBuffs ?? []).some(candidate => candidate.abilityCheckDisadvantageAbilities?.includes(buff.escapeAction!.ability)));
  const total = rolled.naturalRoll + abilityModifier(getEffectiveAbilityScore(target, buff.escapeAction.ability));
  const success = total >= buff.escapeAction.dc;
  state.events.push({ kind: 'save', targetId: target.id, success, durationMs: BASE_DURATIONS.save });
  if (success) removeActiveBuff(state, target, buff);
  pushLog(state, {
    round: state.round, turn: state.turnIndex, actor: target.displayName, action: `Escape ${buff.name}`,
    details: `${target.displayName} ${success ? 'escapes' : 'fails to escape'} ${buff.name} (${total} vs DC ${buff.escapeAction.dc}).`,
    type: success ? 'special' : 'condition',
  });
  return true;
}

function hasOriginFeat(creature: Creature, feat: string): boolean {
  return creature.monsterData.originFeat === feat || creature.monsterData.originFeats?.includes(feat) === true;
}

function rollAttackForCreature(attacker: Creature, modifier: number, advantage: boolean, disadvantage: boolean): ReturnType<typeof rollAttack> {
  return attacker.monsterData.heroSpecies === 'Halfling'
    ? rollAttack(modifier, advantage, disadvantage, true)
    : rollAttack(modifier, advantage, disadvantage);
}

function trySeekingSpell(
  state: BattleState,
  attacker: Creature,
  action: MonsterAction,
  roll: ReturnType<typeof rollAttack>['roll'],
  naturalRoll: number,
  effectiveAdvantage: boolean,
  effectiveDisadvantage: boolean,
  buffBonus: number,
  targetAttackBonus: number,
  ac: number,
): { roll: ReturnType<typeof rollAttack>['roll']; naturalRoll: number } | null {
  if (!isSorcererSpellAttack(attacker, action)) return null;
  if (naturalRoll === 20 || (naturalRoll !== 1 && roll.total >= ac)) return null;
  const payment = paySorcererMetamagic(attacker, 1);
  if (!payment) return null;

  const reroll = rollAttackForCreature(attacker, action.attackBonus!, effectiveAdvantage, effectiveDisadvantage);
  reroll.roll.total += buffBonus + targetAttackBonus;
  reroll.roll.modifier += buffBonus + targetAttackBonus;
  attacker.stats.actionUsage['Seeking Spell'] = (attacker.stats.actionUsage['Seeking Spell'] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: attacker.displayName,
    action: 'Seeking Spell',
    details: payment === 'free'
      ? `${attacker.displayName} rerolls the missed ${action.name} attack for free via Arcane Apotheosis.`
      : `${attacker.displayName} spends 1 Sorcery Point to reroll the missed ${action.name} attack.`,
    type: 'special',
  });
  return reroll;
}

function draconicElementalAffinityBonus(attacker: Creature, action: MonsterAction, damageType: string): number {
  if (attacker.monsterData.heroClass !== 'Sorcerer' || (attacker.monsterData.heroLevel ?? 0) < 6) return 0;
  if (action.spellLevel === undefined || !/fire/i.test(damageType)) return 0;
  return Math.max(0, abilityModifier(getEffectiveAbilityScore(attacker, 'cha')));
}

function wizardEvocationBonus(attacker: Creature, action: MonsterAction): number {
  if (!isWizardEvoker(attacker, 10)) return 0;
  if (action.spellLevel === undefined || action.spellSchool !== 'evocation') return 0;
  return Math.max(0, abilityModifier(getEffectiveAbilityScore(attacker, 'int')));
}

function isWizardEvoker(creature: Creature, minLevel: number): boolean {
  return creature.monsterData.heroClass === 'Wizard'
    && (creature.monsterData.heroLevel ?? 0) >= minLevel
    && (!creature.monsterData.heroSubclass || creature.monsterData.heroSubclass === 'Evoker');
}

function tryConsumeWizardOverchannel(
  state: BattleState,
  attacker: Creature,
  action: MonsterAction,
  damageExpression: string,
): number | null {
  if (!isWizardEvoker(attacker, 14)) return null;
  const spellLevel = action.spellLevel ?? 0;
  if (spellLevel < 1 || spellLevel > 5) return null;
  if (action.resourceCost || action.atWill) return null;
  if (!action.castingAbility || !hasResource(attacker, 'overchannel')) return null;

  consumeResource(attacker, 'overchannel');
  attacker.stats.actionUsage['Overchannel'] = (attacker.stats.actionUsage['Overchannel'] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: attacker.displayName,
    action: 'Overchannel',
    details: `${attacker.displayName} overchannels ${action.name}, dealing maximum spell damage.`,
    type: 'special',
  });
  return maxDiceTotal(damageExpression);
}

function tryApplyPotentCantripMiss(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction,
): void {
  if (!isWizardEvoker(attacker, 3)) return;
  if (action.spellLevel !== 0 || !action.damage || !target.isAlive) return;

  const damageType = action.damageType || 'untyped';
  const damage = Math.floor(rollDamage(action.damage, false).total / 2);
  if (damage <= 0) return;
  attacker.stats.actionUsage['Potent Cantrip'] = (attacker.stats.actionUsage['Potent Cantrip'] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: attacker.displayName,
    action: 'Potent Cantrip',
    details: `${attacker.displayName}'s ${action.name} still deals ${damage} ${damageType} damage on a miss.`,
    damage,
    type: 'damage',
  });
  const beforeHp = target.currentHp;
  const hitEvent = pushHitEvent(state, target.id, damage, damageType, false, beforeHp);
  applyDamage(state, target, damage, damageType, attacker, false, action.magical ?? true, false);
  hitEvent.targetHpAfter = target.currentHp;
}

function isFiendPatronWarlock(creature: Creature, minLevel: number): boolean {
  return creature.isAlive
    && creature.monsterData.heroClass === 'Warlock'
    && (creature.monsterData.heroLevel ?? 0) >= minLevel
    && (!creature.monsterData.heroSubclass || creature.monsterData.heroSubclass === 'Fiend Patron');
}

function consumeHurlThroughHellUse(attacker: Creature): 'free' | 'pact-slot' | null {
  if (hasResource(attacker, 'hurl-through-hell')) {
    consumeResource(attacker, 'hurl-through-hell');
    return 'free';
  }
  if (hasResource(attacker, 'slot-5')) {
    consumeResource(attacker, 'slot-5');
    return 'pact-slot';
  }
  return null;
}

function tryHurlThroughHell(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction,
): void {
  if (!target.isAlive || !isFiendPatronWarlock(attacker, 14)) return;
  if (action.attackBonus === undefined || action.type === 'multiattack') return;
  if (attacker.turnFlags?.['hurl-through-hell-used']) return;

  const payment = consumeHurlThroughHellUse(attacker);
  if (!payment) return;
  if (!attacker.turnFlags) attacker.turnFlags = {};
  attacker.turnFlags['hurl-through-hell-used'] = true;
  attacker.stats.actionUsage['Hurl Through Hell'] = (attacker.stats.actionUsage['Hurl Through Hell'] || 0) + 1;

  const chaMod = getEffectiveSaveModifier(target, 'cha', state);
  const dc = 8 + attacker.monsterData.proficiencyBonus + abilityModifier(getEffectiveAbilityScore(attacker, 'cha'));
  const save = rollSaveWithBuffs(target, chaMod, false, dc, 'cha');
  const success = save.total >= dc;
  state.events.push({ kind: 'save', targetId: target.id, success, durationMs: BASE_DURATIONS.save });

  if (success) {
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: target.displayName,
      action: 'Save',
      details: `${target.displayName} resists Hurl Through Hell (${save.total} vs DC ${dc}).`,
      type: 'save',
    });
    return;
  }

  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: attacker.displayName,
    action: 'Hurl Through Hell',
    details: `${attacker.displayName} hurls ${target.displayName} through a nightmare realm (${payment === 'free' ? 'free use' : 'Pact Magic slot'}).`,
    type: 'special',
  });
  applyCondition(state, target, 'incapacitated', attacker, 'end_of_next_turn', dc, 'cha');

  if (target.monsterData.type.toLowerCase().includes('fiend')) {
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: target.displayName,
      action: 'Fiendish Nature',
      details: `${target.displayName} is a Fiend and takes no psychic damage from Hurl Through Hell.`,
      type: 'special',
    });
    return;
  }

  const damage = rollDice('8d10').total;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: attacker.displayName,
    action: 'Hurl Through Hell',
    details: `${target.displayName} takes ${damage} psychic damage after returning from the hellscape.`,
    damage,
    type: 'damage',
  });
  const hpBefore = target.currentHp;
  const event = pushHitEvent(state, target.id, damage, 'psychic', false, hpBefore);
  applyDamage(state, target, damage, 'psychic', attacker, false, true, false);
  if (!target.isAlive) target.stats.killedByAction = 'Hurl Through Hell';
  event.targetHpAfter = target.currentHp;
}

function monkMartialArtsDieSides(level: number): number {
  if (level >= 17) return 12;
  if (level >= 11) return 10;
  if (level >= 5) return 8;
  return 6;
}

function signedBonus(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

function isMonkWeaponOrUnarmed(action: MonsterAction): boolean {
  return action.name === 'Martial Arts (Unarmed)' ||
    (action.type === 'melee' && action.attackAbility === 'dex' && action.spellLevel === undefined);
}

function hasIrresistibleOffense(attacker: Creature | null, damageType: string): boolean {
  if (!attacker || !isPhysicalDamageType(damageType)) return false;
  const level = attacker.monsterData.heroLevel ?? 0;
  return (attacker.monsterData.heroClass === 'Barbarian' && level >= 19) ||
    (attacker.monsterData.heroClass === 'Monk' && level >= 19);
}

function irresistibleOffenseAbilityScore(attacker: Creature): number {
  return attacker.monsterData.heroClass === 'Monk'
    ? getEffectiveAbilityScore(attacker, 'dex')
    : getEffectiveAbilityScore(attacker, 'str');
}

function grantStudiedAttacksAdvantage(state: BattleState, attacker: Creature, target: Creature, action: MonsterAction): void {
  if (attacker.monsterData.heroClass !== 'Fighter') return;
  if ((attacker.monsterData.heroLevel ?? 0) < 13) return;
  if (action.spellLevel !== undefined) return;
  if (action.type !== 'melee' && action.type !== 'ranged') return;
  if (!target.isAlive) return;

  const key = `studied-attacks:${attacker.id}`;
  target.activeBuffs = (target.activeBuffs ?? []).filter(b => b.key !== key);
  target.activeBuffs.push({
    name: 'Studied Attacks',
    key,
    casterId: attacker.id,
    appliedRound: state.round,
    endRound: state.round + 2,
    advantageForAttackerId: attacker.id,
    expiresOnSourceTurnStart: true,
  });
  attacker.stats.actionUsage['Studied Attacks'] = (attacker.stats.actionUsage['Studied Attacks'] || 0) + 1;
}

function applyOpenHandTechnique(state: BattleState, attacker: Creature, target: Creature): void {
  if (!attacker.turnFlags?.openHandFlurryStrike) return;
  if (attacker.monsterData.heroClass !== 'Monk' || (attacker.monsterData.heroLevel ?? 0) < 3) return;
  if (!target.isAlive || target.conditions.includes('prone') || !isLargeOrSmaller(target)) return;

  const wisMod = abilityModifier(getEffectiveAbilityScore(attacker, 'wis'));
  const dc = 8 + attacker.monsterData.proficiencyBonus + wisMod;
  const dexMod = getEffectiveSaveModifier(target, 'dex', state);
  const save = rollSaveWithBuffs(target, dexMod, false, dc, 'dex');
  const success = save.total >= dc;
  state.events.push({ kind: 'save', targetId: target.id, success, durationMs: BASE_DURATIONS.save });
  if (success) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Open Hand Technique',
      details: `${target.displayName} keeps its footing (${save.total} vs DC ${dc}).`,
      type: 'save',
    });
    return;
  }

  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: 'Open Hand Technique',
    details: `${attacker.displayName} topples ${target.displayName} with Open Hand Technique (${save.total} vs DC ${dc}).`,
    type: 'condition',
  });
  applyCondition(state, target, 'prone', attacker, 'end_of_next_turn', dc, 'dex');
  attacker.stats.actionUsage['Open Hand Technique'] = (attacker.stats.actionUsage['Open Hand Technique'] || 0) + 1;
}

function seedQuiveringPalm(state: BattleState, attacker: Creature, target: Creature, action: MonsterAction): void {
  if (attacker.monsterData.heroClass !== 'Monk' || (attacker.monsterData.heroLevel ?? 0) < 17) return;
  if (action.name !== 'Martial Arts (Unarmed)' || !target.isAlive || !hasResource(attacker, 'ki', 4)) return;
  const key = `quivering-palm:${attacker.id}`;
  if (state.creatures.some(creature => creature.activeBuffs?.some(buff => buff.key === key))) return;

  consumeResource(attacker, 'ki', 4);
  target.activeBuffs = (target.activeBuffs ?? []).filter(buff => buff.key !== key);
  target.activeBuffs.push({
    name: 'Quivering Palm',
    key,
    casterId: attacker.id,
    appliedRound: state.round,
    endRound: Infinity,
  });
  attacker.stats.actionUsage['Quivering Palm Seed'] = (attacker.stats.actionUsage['Quivering Palm Seed'] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: attacker.displayName,
    action: 'Quivering Palm',
    details: `${attacker.displayName} seeds lethal vibrations in ${target.displayName}.`,
    type: 'special',
  });
  state.events.push({ kind: 'effect', creatureId: target.id, label: 'Quivering Palm', tone: 'danger', durationMs: BASE_DURATIONS.effect });
}

function hasDisadvantage(attacker: Creature, target: Creature, action: MonsterAction): boolean {
  let dis = false;

  // Dodge imposes Disadvantage on attacks while the dodger can see the attacker.
  // Visibility is not modeled as a separate creature sense, so the arena's open
  // map uses the engine's existing line-of-sight gate before attacks reach here.
  if (target.turnFlags?.dodge) dis = true;

  // Weapon Mastery: Sap gives the target Disadvantage on its next attack roll.
  if (attacker.activeBuffs?.some(b => b.attackDisadvantage && (!b.attackDisadvantageAgainstCaster || b.casterId === target.id)) || target.activeBuffs?.some(b => b.attackersHaveDisadvantage)) dis = true;
  if (target.activeBuffs?.some(buff => buff.attackersOfTypesHaveDisadvantage?.some(type => type.toLowerCase() === attacker.monsterData.type.toLowerCase()))) dis = true;
  if ((action.attackAbility === 'str' || (!action.attackAbility && action.type === 'melee'))
      && attacker.activeBuffs?.some(b => b.strengthTestDisadvantage)) dis = true;

  if (action.heavy && getActiveSize(attacker) === 'Small') dis = true;
  if (action.closeRangeDisadvantage && creatureDistance(attacker, target) <= 5) dis = true;

  // Target is prone and ranged
  if (target.conditions.includes('prone') && action.type === 'ranged') dis = true;

  // Attacker is blinded
  if (attacker.conditions.includes('blinded')) dis = true;

  // Attacker is frightened (within sight of source)
  if (attacker.conditions.includes('frightened')) dis = true;

  // Attacker is restrained
  if (attacker.conditions.includes('restrained')) dis = true;

  // Attacker is poisoned
  if (attacker.conditions.includes('poisoned')) dis = true;

  // Ranged-in-melee disadvantage is now handled in resolveAttack using full battle state

  return dis;
}

const SIZE_RANK: Record<MonsterData['size'], number> = {
  Tiny: 0,
  Small: 1,
  Medium: 2,
  Large: 3,
  Huge: 4,
  Gargantuan: 5,
};

function isLargeOrSmaller(creature: Creature): boolean {
  return SIZE_RANK[getActiveSize(creature)] <= SIZE_RANK.Large;
}

function sizeRank(size: MonsterData['size']): number {
  return SIZE_RANK[size];
}

export function conditionTargetMatchesActionSize(action: MonsterAction, target: Creature): boolean {
  const desc = action.description.toLowerCase();
  const size = SIZE_RANK[getActiveSize(target)];
  if (desc.includes('small or smaller')) return size <= SIZE_RANK.Small;
  if (desc.includes('medium or smaller')) return size <= SIZE_RANK.Medium;
  if (desc.includes('large or smaller')) return size <= SIZE_RANK.Large;
  if (desc.includes('huge or smaller')) return size <= SIZE_RANK.Huge;
  return true;
}

function targetFitsMaxSize(target: Creature, maxSize?: MonsterData['size']): boolean {
  if (!maxSize) return true;
  return sizeRank(getActiveSize(target)) <= sizeRank(maxSize);
}

function addMasteryBuff(state: BattleState, attacker: Creature, target: Creature, buff: Omit<ActiveBuff, 'casterId' | 'appliedRound'>): void {
  addBuff(target, {
    ...buff,
    casterId: attacker.id,
    appliedRound: state.round,
  });
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: buff.name,
    details: `${attacker.displayName}'s ${buff.name} affects ${target.displayName}.`,
    type: 'special'
  });
}

function tryRampage(state: BattleState, attacker: Creature, target: Creature, action: MonsterAction, targetWasBloodied: boolean): void {
  if (action.name !== 'Bite') return;
  if (!targetWasBloodied || !target.isAlive) return;
  if (!hasActiveTrait(attacker, 'Rampage') || !hasResource(attacker, 'rampage')) return;
  const bite = attacker.wildShape?.actions.find(a => a.name === 'Bite')
    ?? attacker.monsterData.actions.find(a => a.name === 'Bite');
  if (!bite || creatureDistance(attacker, target) > (bite.reach ?? 5)) return;
  consumeResource(attacker, 'rampage');
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: 'Rampage',
    details: `${attacker.displayName} uses Rampage to make one extra Bite attack.`,
    type: 'special'
  });
  attacker.stats.actionUsage.Rampage = (attacker.stats.actionUsage.Rampage || 0) + 1;
  resolveAttack(state, attacker, target, bite);
}

function moveTargetByPush(state: BattleState, attacker: Creature, target: Creature, feet = 10): boolean {
  if (!isLargeOrSmaller(target)) return false;
  const dx = Math.sign(target.position.x - attacker.position.x);
  const dy = Math.sign(target.position.y - attacker.position.y);
  const stepX = dx === 0 && dy === 0 ? 0 : dx;
  const stepY = dx === 0 && dy === 0 ? 1 : dy;
  let best = { ...target.position };
  const maxSquares = Math.max(1, Math.floor(feet / 5));
  for (let squares = maxSquares; squares >= 1; squares--) {
    const candidate = {
      x: target.position.x + stepX * squares,
      y: target.position.y + stepY * squares,
    };
    if (candidate.x < 0 || candidate.y < 0 ||
        candidate.x >= (state.gridSize ?? 20) || candidate.y >= (state.gridSize ?? 20)) continue;
    if (isPositionBlocked(candidate, getActiveSize(target), state.creatures, target.id, state.terrainBlocked)) continue;
    best = candidate;
    break;
  }
  if (best.x === target.position.x && best.y === target.position.y) return false;
  const from = { ...target.position };
  target.position = best;
  state.events.push({ kind: 'move', creatureId: target.id, from, to: best, durationMs: BASE_DURATIONS.move });
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: 'Push',
    details: `${attacker.displayName} pushes ${target.displayName} ${distance(from, best)} ft.`,
    type: 'move'
  });
  return true;
}

type BrutalStrikeEffect = 'hamstring' | 'staggering' | 'sundering' | 'forceful';

function chooseBrutalStrikeEffects(state: BattleState, attacker: Creature): BrutalStrikeEffect[] {
  const level = attacker.monsterData.heroLevel ?? 0;
  const hasOtherAlly = state.creatures.some(c => c.team === attacker.team && c.id !== attacker.id && c.isAlive && !c.dying);
  if (level >= 17) {
    return hasOtherAlly ? ['sundering', 'hamstring'] : ['hamstring', 'staggering'];
  }
  if (level >= 13 && hasOtherAlly) return ['sundering'];
  return ['hamstring'];
}

function applyBrutalStrikeEffects(state: BattleState, attacker: Creature, target: Creature): void {
  if (!target.isAlive) return;
  const effects = chooseBrutalStrikeEffects(state, attacker);
  const endRound = state.round + 2;
  for (const effect of effects) {
    if (!target.isAlive) return;
    switch (effect) {
      case 'hamstring':
        addMasteryBuff(state, attacker, target, {
          name: 'Hamstring Blow',
          key: `brutal-hamstring:${attacker.id}`,
          endRound,
          speedPenalty: 15,
          expiresOnSourceTurnStart: true,
        });
        break;
      case 'staggering':
        addMasteryBuff(state, attacker, target, {
          name: 'Staggering Blow',
          key: `brutal-staggering:${attacker.id}`,
          endRound,
          saveDisadvantage: true,
          preventsOpportunityAttacks: true,
          expiresOnSourceTurnStart: true,
        });
        break;
      case 'sundering':
        addMasteryBuff(state, attacker, target, {
          name: 'Sundering Blow',
          key: `brutal-sundering:${attacker.id}`,
          endRound,
          attackBonusForAllAttackers: 5,
          expiresOnSourceTurnStart: true,
        });
        break;
      case 'forceful':
        moveTargetByPush(state, attacker, target, 15);
        break;
    }
  }
}

function brutalStrikeDamageDice(attacker: Creature): string {
  return (attacker.monsterData.heroLevel ?? 0) >= 17 ? '2d10' : '1d10';
}

function pullTargetTowardAttackerOnHit(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction,
): boolean {
  const feet = action.pullTowardAttackerOnHit;
  if (!target.isAlive || !feet || feet <= 0) return false;
  if (!conditionTargetMatchesActionSize(action, target)) return false;

  const dx = Math.sign(target.position.x - attacker.position.x);
  const dy = Math.sign(target.position.y - attacker.position.y);
  if (dx === 0 && dy === 0) return false;

  const maxSquares = Math.max(1, Math.floor(feet / 5));
  const gridSize = state.gridSize ?? 20;
  const targetSize = getActiveSize(target);
  const targetFootprint = getFootprintSize(targetSize);
  let best = { ...target.position };

  for (let squares = maxSquares; squares >= 1; squares--) {
    const candidate = {
      x: target.position.x - dx * squares,
      y: target.position.y - dy * squares,
    };
    if (candidate.x < 0 || candidate.y < 0 ||
        candidate.x + targetFootprint > gridSize ||
        candidate.y + targetFootprint > gridSize) continue;
    if (isPositionBlocked(candidate, targetSize, state.creatures, target.id, state.terrainBlocked)) continue;
    best = candidate;
    break;
  }

  if (best.x === target.position.x && best.y === target.position.y) return false;
  const from = { ...target.position };
  target.position = best;
  state.events.push({ kind: 'move', creatureId: target.id, from, to: best, durationMs: BASE_DURATIONS.move });
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: `${action.name} Pull`,
    details: `${attacker.displayName} pulls ${target.displayName} ${distance(from, best)} ft toward itself.`,
    type: 'move'
  });
  return true;
}

function resolveToppleMastery(state: BattleState, attacker: Creature, target: Creature, action: MonsterAction): void {
  if (!target.isAlive || !isLargeOrSmaller(target)) return;
  const dc = 8 + attacker.monsterData.proficiencyBonus + (action.masteryAbilityMod ?? 0);
  const conMod = getEffectiveSaveModifier(target, 'con', state);
  const save = rollSaveWithBuffs(target, conMod, false, dc, 'con');
  const success = save.total >= dc;
  state.events.push({ kind: 'save', targetId: target.id, success, durationMs: BASE_DURATIONS.save });
  if (success) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Topple Save',
      details: `${target.displayName} stays upright (${save.total} vs DC ${dc}).`,
      type: 'save'
    });
    return;
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Topple Save',
    details: `${target.displayName} falls prone (${save.total} vs DC ${dc}).`,
    type: 'save'
  });
  applyCondition(state, target, 'prone', attacker, 'end_of_next_turn', dc, 'con');
}

type HitEvent = Extract<AnimationEvent, { kind: 'hit' }>;

/**
 * Push a 'hit' animation event (targetHpAfter starts as a placeholder equal to
 * hpBefore) and return the live object. The caller runs applyDamage, then sets
 * `evt.targetHpAfter = target.currentHp` on the returned reference.
 *
 * Why return the reference instead of re-finding the event afterwards:
 * applyDamage may append further events (a 'death'), so the only robust way to
 * patch the right hit is to hold its reference. The previous idiom -
 * `state.events[length - (target.isAlive ? 1 : 2)]`, repeated at ~11 call
 * sites - hard-coded how many events applyDamage appends and would silently
 * patch the wrong event if that ever changed, corrupting the replay HP bar.
 */
function pushHitEvent(
  state: BattleState,
  targetId: string,
  damage: number,
  damageType: string,
  critical: boolean,
  hpBefore: number,
  opts?: { durationMs?: number; cause?: 'opportunity' },
): HitEvent {
  const evt: HitEvent = {
    kind: 'hit', targetId, damage, damageType, critical,
    targetHpBefore: hpBefore, targetHpAfter: hpBefore,
    durationMs: opts?.durationMs ?? BASE_DURATIONS.hit,
    ...(opts?.cause ? { cause: opts.cause } : {}),
  };
  state.events.push(evt);
  return evt;
}

function resolveCleaveMastery(state: BattleState, attacker: Creature, originalTarget: Creature, action: MonsterAction): void {
  if (attacker.turnFlags?.['mastery-cleave-used']) return;
  if (action.type !== 'melee' || action.attackBonus === undefined || !action.masteryBaseDamage) return;
  const reach = action.reach ?? 5;
  const cleaveTarget = getEnemies(state, attacker)
    .filter(enemy =>
      enemy.id !== originalTarget.id &&
      enemy.isAlive &&
      creatureDistance(enemy, originalTarget) <= 5 &&
      creatureDistance(attacker, enemy) <= reach
    )
    .sort((a, b) => a.currentHp - b.currentHp)[0];
  if (!cleaveTarget) return;

  if (!attacker.turnFlags) attacker.turnFlags = {};
  attacker.turnFlags['mastery-cleave-used'] = true;

  const adv = hasAdvantage(state, attacker, cleaveTarget, action);
  const dis = hasDisadvantage(attacker, cleaveTarget, action);
  const { roll, naturalRoll } = rollAttack(action.attackBonus, adv && !dis, dis && !adv);
  const buffBonus = rollAttackBuffBonus(attacker);
  if (buffBonus !== 0) {
    roll.total += buffBonus;
    roll.modifier += buffBonus;
  }
  const ac = getEffectiveAC(cleaveTarget);
  attacker.stats.attacksMade++;
  state.events.push({
    kind: 'attack', attackerId: attacker.id, targetId: cleaveTarget.id,
    actionName: 'Cleave', attackType: 'melee', durationMs: BASE_DURATIONS.attack,
  });

  if (naturalRoll === 1 || roll.total < ac) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: attacker.displayName, action: 'Cleave',
      details: `${attacker.displayName}'s Cleave misses ${cleaveTarget.displayName} (${roll.total} vs AC ${ac}).`,
      type: 'miss'
    });
    state.events.push({ kind: 'miss', attackerId: attacker.id, targetId: cleaveTarget.id, durationMs: BASE_DURATIONS.miss });
    return;
  }

  const crit = naturalRoll === 20;
  attacker.stats.attacksHit++;
  const dmg = rollDamage(action.masteryBaseDamage, crit).total + getRageDamageBonus(attacker, action);
  const dmgType = action.damageType || 'slashing';
  const beforeHp = cleaveTarget.currentHp;
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: 'Cleave',
    details: `${attacker.displayName} cleaves into ${cleaveTarget.displayName} for ${dmg} ${dmgType} damage.`,
    damage: dmg,
    type: 'damage'
  });
  const hitEvt = pushHitEvent(state, cleaveTarget.id, dmg, dmgType, crit, beforeHp);
  applyDamage(state, cleaveTarget, dmg, dmgType, attacker, true, action.magical ?? false, crit);
  if (!cleaveTarget.isAlive) cleaveTarget.stats.killedByAction = 'Cleave';
  hitEvt.targetHpAfter = cleaveTarget.currentHp;
}

function applyWeaponMasteryOnHit(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction,
  dealtDamage: boolean
): void {
  if (!action.weaponMastery) return;
  if (!dealtDamage) return;

  if (action.weaponMastery === 'cleave') {
    resolveCleaveMastery(state, attacker, target, action);
    return;
  }

  if (!target.isAlive) return;
  const endRound = state.round + 2;

  switch (action.weaponMastery) {
    case 'vex':
      addMasteryBuff(state, attacker, target, {
        name: 'Vex',
        key: `vex:${attacker.id}`,
        endRound,
        advantageForAttackerId: attacker.id,
      });
      break;
    case 'sap':
      addMasteryBuff(state, attacker, target, {
        name: 'Sap',
        key: `sap:${attacker.id}`,
        endRound,
        attackDisadvantage: true,
        expiresOnSourceTurnStart: true,
      });
      break;
    case 'slow':
      addMasteryBuff(state, attacker, target, {
        name: 'Slow',
        key: `slow:${attacker.id}`,
        endRound,
        speedPenalty: 10,
        expiresOnSourceTurnStart: true,
      });
      break;
    case 'topple':
      resolveToppleMastery(state, attacker, target, action);
      break;
    case 'push':
      if (action.pushOnHitOncePerTurn && attacker.turnFlags?.[`push-on-hit:${action.name}`]) break;
      moveTargetByPush(state, attacker, target, action.pushOnHit ?? 10);
      if (action.pushOnHitOncePerTurn) {
        attacker.turnFlags = { ...(attacker.turnFlags ?? {}), [`push-on-hit:${action.name}`]: true };
      }
      break;
    case 'graze':
    case 'nick':
      break;
  }
}

function applyAttackHitBuff(state: BattleState, attacker: Creature, target: Creature, action: MonsterAction, dealtDamage: boolean): void {
  if (!action.buffOnHit || !dealtDamage || !target.isAlive) return;
  const tmpl = action.buffOnHit;
  addMasteryBuff(state, attacker, target, {
    name: tmpl.name,
    key: `${tmpl.key}:${attacker.id}`,
    endRound: state.round + (action.durationRounds ?? 2),
    requiresConcentration: tmpl.requiresConcentration,
    attackBonus: tmpl.attackBonus,
    attackBonusDice: tmpl.attackBonusDice,
    saveBonusDice: tmpl.saveBonusDice,
    acBonus: tmpl.acBonus,
    damageRider: tmpl.damageRider,
    bonusActionDamage: tmpl.bonusActionDamage,
    bonusActionDamageType: tmpl.bonusActionDamageType,
    bonusActionDamageRange: tmpl.bonusActionDamageRange,
    endsWhenTargetDies: tmpl.endsWhenTargetDies,
    resistPhysical: tmpl.resistPhysical,
    resistDamageTypes: tmpl.resistDamageTypes,
    resistAllDamageExcept: tmpl.resistAllDamageExcept,
    rageDamageBonus: tmpl.rageDamageBonus,
    conditionalRider: tmpl.conditionalRider,
    reactiveDamage: tmpl.reactiveDamage,
    preventDeath: tmpl.preventDeath,
    advantageForAttackerId: tmpl.advantageForAttackerId,
    advantageForAllAttackers: tmpl.advantageForAllAttackers,
    attackDisadvantage: tmpl.attackDisadvantage,
    saveDisadvantage: tmpl.saveDisadvantage,
    speedPenalty: tmpl.speedPenalty,
    preventsOpportunityAttacks: tmpl.preventsOpportunityAttacks,
    preventsReactions: tmpl.preventsReactions,
    attackBonusForAllAttackers: tmpl.attackBonusForAllAttackers,
    spellAttackAdvantage: tmpl.spellAttackAdvantage,
    spellSaveDcBonus: tmpl.spellSaveDcBonus,
    expiresOnSourceTurnStart: tmpl.expiresOnSourceTurnStart,
  });
}

function applySmiteOfProtection(state: BattleState, paladin: Creature): void {
  if (paladin.monsterData.heroClass !== 'Paladin' || (paladin.monsterData.heroLevel ?? 0) < 15) return;
  const range = paladinAuraRange(paladin);
  for (const ally of getAliveCreatures(state, paladin.team).filter(c => creatureDistance(c, paladin) <= range)) {
    addBuff(ally, {
      name: 'Smite of Protection',
      key: `smite-of-protection:${paladin.id}`,
      casterId: paladin.id,
      appliedRound: state.round,
      endRound: state.round + 2,
      acBonus: 2,
      expiresOnSourceTurnStart: true,
    });
  }
  if (!paladin.turnFlags?.['smite-of-protection-applied']) {
    paladin.turnFlags = { ...(paladin.turnFlags ?? {}), 'smite-of-protection-applied': true };
    paladin.stats.actionUsage['Smite of Protection'] = (paladin.stats.actionUsage['Smite of Protection'] || 0) + 1;
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: paladin.displayName,
      action: 'Smite of Protection',
      details: `${paladin.displayName}'s aura grants Half Cover (+2 AC) to nearby allies until the start of their next turn.`,
      type: 'special',
    });
  }
}

function applySuperiorHuntersPrey(
  state: BattleState,
  ranger: Creature,
  markedTarget: Creature,
  markBuff: ActiveBuff,
): void {
  if (markBuff.key !== 'hunters-mark') return;
  if (ranger.monsterData.heroClass !== 'Ranger' || (ranger.monsterData.heroLevel ?? 0) < 11) return;
  if (ranger.turnFlags?.['superior-hunters-prey-used']) return;

  const secondary = getEnemies(state, ranger)
    .filter(enemy => enemy.id !== markedTarget.id && enemy.isAlive)
    .filter(enemy => creatureDistance(enemy, markedTarget) <= 30)
    .sort((a, b) => a.currentHp - b.currentHp)[0];
  if (!secondary || !markBuff.damageRider) return;

  ranger.turnFlags = { ...(ranger.turnFlags ?? {}), 'superior-hunters-prey-used': true };
  const parts = markBuff.damageRider.split(' ');
  const diceExpr = parts[0];
  const damageType = parts.slice(1).join(' ') || 'force';
  const splash = rollDamage(diceExpr, false);
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: ranger.displayName,
    action: "Superior Hunter's Prey",
    details: `${ranger.displayName}'s Hunter's Mark splashes ${splash.total} ${damageType} damage to ${secondary.displayName}.`,
    damage: splash.total,
    type: 'damage',
  });
  const beforeHp = secondary.currentHp;
  const ev = pushHitEvent(state, secondary.id, splash.total, damageType, false, beforeHp);
  applyDamage(state, secondary, splash.total, damageType, ranger, true, true);
  ev.targetHpAfter = secondary.currentHp;
  ranger.stats.actionUsage["Superior Hunter's Prey"] = (ranger.stats.actionUsage["Superior Hunter's Prey"] || 0) + 1;
}

function applyColossusSlayer(
  state: BattleState,
  ranger: Creature,
  target: Creature,
  action: MonsterAction,
  targetWasWounded: boolean,
  isCritical: boolean,
): void {
  if (ranger.monsterData.heroClass !== 'Ranger' || (ranger.monsterData.heroLevel ?? 0) < 3) return;
  if (ranger.monsterData.heroSubclass && ranger.monsterData.heroSubclass !== 'Hunter') return;
  if (action.spellLevel !== undefined || (action.type !== 'melee' && action.type !== 'ranged')) return;
  if (!target.isAlive || !targetWasWounded) return;
  if (ranger.turnFlags?.['colossus-slayer-used']) return;

  ranger.turnFlags = { ...(ranger.turnFlags ?? {}), 'colossus-slayer-used': true };
  const rider = rollDamage('1d8', isCritical);
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: ranger.displayName,
    action: 'Colossus Slayer',
    details: `${ranger.displayName} deals ${rider.total} extra damage to the wounded ${target.displayName}.`,
    damage: rider.total,
    type: 'damage',
  });
  const beforeHp = target.currentHp;
  const ev = pushHitEvent(state, target.id, rider.total, action.damageType ?? 'piercing', isCritical, beforeHp);
  applyDamage(state, target, rider.total, action.damageType ?? 'piercing', ranger, true, action.magical ?? false, isCritical);
  ev.targetHpAfter = target.currentHp;
  ranger.stats.actionUsage['Colossus Slayer'] = (ranger.stats.actionUsage['Colossus Slayer'] || 0) + 1;
}

function canUseSuperiorHuntersDefense(target: Creature): boolean {
  if (target.monsterData.heroClass !== 'Ranger') return false;
  if ((target.monsterData.heroLevel ?? 0) < 15) return false;
  if (target.monsterData.heroSubclass && target.monsterData.heroSubclass !== 'Hunter') return false;
  if (!canTakeReactions(target)) return false;
  return !target.conditions.includes('incapacitated') &&
    !target.conditions.includes('stunned') &&
    !target.conditions.includes('paralyzed') &&
    !target.conditions.includes('petrified') &&
    !target.conditions.includes('unconscious');
}

function sameDamageType(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left.includes(right) || right.includes(left);
}

function applySuperiorHuntersDefense(state: BattleState, target: Creature, damage: number, damageType: string): number {
  if (damage <= 0) return damage;
  const active = target.superiorHunterDefense;
  if (active && active.round === state.round && active.turnIndex === state.turnIndex && sameDamageType(active.damageType, damageType)) {
    const before = damage;
    const reduced = Math.floor(damage / 2);
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: target.displayName,
      action: "Superior Hunter's Defense",
      details: `${target.displayName} resists ${damageType}: ${before} → ${reduced}.`,
      type: 'info',
    });
    return reduced;
  }

  if (!canUseSuperiorHuntersDefense(target)) return damage;
  target.reactionUsed = true;
  target.superiorHunterDefense = { damageType, round: state.round, turnIndex: state.turnIndex };
  const before = damage;
  const reduced = Math.floor(damage / 2);
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: target.displayName,
    action: "Superior Hunter's Defense",
    details: `${target.displayName} uses a reaction to resist ${damageType}: ${before} → ${reduced}.`,
    type: 'info',
  });
  target.stats.actionUsage["Superior Hunter's Defense"] = (target.stats.actionUsage["Superior Hunter's Defense"] || 0) + 1;
  state.events.push({
    kind: 'effect',
    creatureId: target.id,
    label: "Superior Hunter's Defense",
    tone: 'success',
    durationMs: BASE_DURATIONS.effect,
  });
  return reduced;
}

function applyWeaponMasteryOnMiss(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction
): void {
  if (action.weaponMastery !== 'graze' || action.type !== 'melee' || !target.isAlive) return;
  const dmg = Math.max(0, action.masteryAbilityMod ?? 0);
  if (dmg <= 0) return;
  const dmgType = action.damageType || 'bludgeoning';
  const beforeHp = target.currentHp;
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: 'Graze',
    details: `${attacker.displayName}'s Graze deals ${dmg} ${dmgType} damage despite the miss.`,
    damage: dmg,
    type: 'damage'
  });
  const hitEvt = pushHitEvent(state, target.id, dmg, dmgType, false, beforeHp);
  applyDamage(state, target, dmg, dmgType, attacker, true, action.magical ?? false, false);
  if (!target.isAlive) target.stats.killedByAction = action.name;
  hitEvt.targetHpAfter = target.currentHp;
}

function canUseSneakAttack(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction,
  effectiveAdvantage: boolean,
  effectiveDisadvantage: boolean,
): boolean {
  if (!attacker.monsterData.isHero || attacker.monsterData.heroClass !== 'Rogue') return true;
  if (!action.additionalDamage) return true;
  if (attacker.turnFlags?.['sneak-attack-used']) return false;
  if (effectiveDisadvantage) return false;
  return effectiveAdvantage || hasAdjacentAlly(state, attacker, target);
}

interface RogueCunningStrikeChoice {
  name: 'Trip' | 'Poison' | 'Obscure';
  costDice: number;
  condition: Condition;
  saveAbility: keyof MonsterData['abilities'];
  duration: ConditionDuration;
}

function parseSneakAttackDice(additionalDamage: string): number {
  return Number(/^(\d+)d6\b/i.exec(additionalDamage)?.[1] ?? 0);
}

function conditionImmune(target: Creature, condition: Condition): boolean {
  return (target.monsterData.conditionImmunities ?? []).includes(condition);
}

function canApplyRogueStrike(target: Creature, choice: RogueCunningStrikeChoice): boolean {
  if (!target.isAlive || target.conditions.includes(choice.condition)) return false;
  if (conditionImmune(target, choice.condition)) return false;
  if (choice.name === 'Trip' && !isLargeOrSmaller(target)) return false;
  return true;
}

function rogueCunningStrikeDC(attacker: Creature): number {
  const dexMod = abilityModifier(getEffectiveAbilityScore(attacker, 'dex'));
  return 8 + attacker.monsterData.proficiencyBonus + dexMod;
}

function chooseRogueCunningStrikes(
  attacker: Creature,
  target: Creature,
  sneakDice: number,
): RogueCunningStrikeChoice[] {
  const level = attacker.monsterData.heroLevel ?? 0;
  if (attacker.monsterData.heroClass !== 'Rogue' || level < 5 || sneakDice <= 1) return [];

  const effects: RogueCunningStrikeChoice[] = [];
  let remaining = sneakDice;
  const maxEffects = level >= 11 ? 2 : 1;
  const candidates: RogueCunningStrikeChoice[] = [
    ...(level >= 14
      ? [{
          name: 'Obscure' as const,
          costDice: 3,
          condition: 'blinded' as const,
          saveAbility: 'dex' as const,
          duration: 'end_of_next_turn' as const,
        }]
      : []),
    {
      name: 'Trip',
      costDice: 1,
      condition: 'prone',
      saveAbility: 'dex',
      duration: 'end_of_next_turn',
    },
    {
      name: 'Poison',
      costDice: 1,
      condition: 'poisoned',
      saveAbility: 'con',
      duration: '1_minute',
    },
  ];

  for (const candidate of candidates) {
    if (effects.length >= maxEffects) break;
    if (remaining - candidate.costDice < 1) continue;
    if (!canApplyRogueStrike(target, candidate)) continue;
    effects.push(candidate);
    remaining -= candidate.costDice;
  }

  return effects;
}

function applyRogueCunningStrikes(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  choices: RogueCunningStrikeChoice[],
): void {
  if (choices.length === 0 || !target.isAlive) return;
  const dc = rogueCunningStrikeDC(attacker);

  for (const choice of choices) {
    if (!target.isAlive) break;
    if (!canApplyRogueStrike(target, choice)) continue;

    attacker.stats.actionUsage[`Cunning Strike: ${choice.name}`] =
      (attacker.stats.actionUsage[`Cunning Strike: ${choice.name}`] || 0) + 1;

    const saveMod = getEffectiveSaveModifier(target, choice.saveAbility, state);
    const save = rollSaveWithBuffs(target, saveMod, false, dc, choice.saveAbility, choice.condition);
    state.events.push({
      kind: 'save',
      targetId: target.id,
      success: save.total >= dc,
      durationMs: BASE_DURATIONS.save,
    });

    if (save.total >= dc) {
      pushLog(state, {
        round: state.round,
        turn: state.turnIndex,
        actor: target.displayName,
        action: `Cunning Strike: ${choice.name}`,
        details: `${target.displayName} resists ${choice.name}. (${save.total} vs DC ${dc})`,
        type: 'save',
      });
      continue;
    }

    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: attacker.displayName,
      action: `Cunning Strike: ${choice.name}`,
      details: `${target.displayName} fails ${choice.name}. (${save.total} vs DC ${dc})`,
      type: 'condition',
    });
    applyCondition(state, target, choice.condition, attacker, choice.duration, dc, choice.saveAbility);
  }
}

function blocksAttackAdvantage(target: Creature): boolean {
  return target.monsterData.heroClass === 'Rogue'
    && (target.monsterData.heroLevel ?? 0) >= 18
    && !target.conditions.includes('incapacitated');
}

function canUseStrokeOfLuck(attacker: Creature): boolean {
  return attacker.monsterData.heroClass === 'Rogue'
    && (attacker.monsterData.heroLevel ?? 0) >= 20
    && hasResource(attacker, 'stroke-of-luck');
}

function hasThiefsReflexes(creature: Creature): boolean {
  return creature.monsterData.heroClass === 'Rogue'
    && (creature.monsterData.heroLevel ?? 0) >= 17
    && (!creature.monsterData.heroSubclass || creature.monsterData.heroSubclass === 'Thief');
}

function getEffectiveAC(target: Creature): number {
  let ac = target.wildShape ? target.wildShape.ac : target.monsterData.ac;
  // Flat AC bonuses from buffs: Shield of Faith +2, Mage Armor (noted but
  // not applied dynamically since it's baked into hero starting AC), etc.
  for (const b of target.activeBuffs ?? []) {
    if (b.acBonus) ac += b.acBonus;
    if (b.acMinimum) ac = Math.max(ac, b.acMinimum);
    if (b.acBaseFromDex) ac = Math.max(ac, b.acBaseFromDex + abilityModifier(getEffectiveAbilityScore(target, 'dex')));
  }
  // Displacement trait gives effective AC boost (modeled as disadvantage on attacks, handled elsewhere)
  return ac;
}

/** Resolve Shield at the only moment it is legal: after a noncritical hit is known. */
function tryAutomaticShield(state: BattleState, target: Creature, rollTotal: number, naturalRoll: number, ac: number): boolean {
  if (naturalRoll === 20 || rollTotal < ac || rollTotal >= ac + 5 || !canTakeReactions(target)) return false;
  const shield = target.monsterData.actions.find(action => action.name === 'Shield' && action.reactionOnly);
  const slot = lowestAvailableSlot(target);
  if (!shield || slot === null) return false;
  consumeResource(target, `slot-${slot}`);
  target.reactionUsed = true;
  addBuff(target, { name: 'Shield', key: `shield:${target.id}`, casterId: target.id, appliedRound: state.round, endRound: state.round + 1, acBonus: 5 });
  target.stats.actionUsage.Shield = (target.stats.actionUsage.Shield || 0) + 1;
  pushLog(state, { round: state.round, turn: state.turnIndex, actor: target.displayName, action: 'Shield', details: `${target.displayName} casts Shield and turns the hit into a miss.`, type: 'special' });
  return true;
}

function getDeathBurstRuntime(creature: Creature): Extract<RuntimeTraitEffect, { kind: 'deathBurst' }> | null {
  for (const trait of getActiveTraits(creature)) {
    const effect = trait.effects?.find(e => e.kind === 'deathBurst');
    if (effect?.kind === 'deathBurst') return effect;
  }
  return null;
}

function getSpellReflectionRuntime(
  creature: Creature,
  spellKind: 'magicMissile' | 'rangedSpellAttack',
): Extract<RuntimeTraitEffect, { kind: 'spellReflection' }> | null {
  for (const trait of getActiveTraits(creature)) {
    const effect = trait.effects?.find(e => e.kind === 'spellReflection' && e.spellKinds.includes(spellKind));
    if (effect?.kind === 'spellReflection') return effect;
  }
  return null;
}

function parseEffectRadius(area: string): number {
  return Number(area.match(/(\d+)-foot/i)?.[1] ?? 0);
}

function processDeathBurst(state: BattleState, target: Creature): void {
  const effect = getDeathBurstRuntime(target);
  if (!effect) return;
  const key = `deathBurst:${target.id}`;
  if (target.recharges[key]) return;
  target.recharges[key] = true;

  const radius = parseEffectRadius(effect.area);
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Death Throes',
    details: `${target.displayName} explodes as it dies.`,
    type: 'special'
  });
  state.events.push({
    kind: 'aoe',
    attackerId: target.id,
    center: { ...target.position },
    radius,
    shape: 'sphere',
    durationMs: BASE_DURATIONS.aoe,
    spellName: 'Death Throes',
    damageType: effect.damage[0]?.type,
  });
  pushEffectEvent(state, target.id, 'Death Throes', 'danger');

  for (const creature of state.creatures) {
    if (!creature.isAlive || creature.id === target.id) continue;
    if (radius > 0 && creatureDistance(target, creature) > radius) continue;

    const saveMod = getEffectiveSaveModifier(creature, effect.save.ability, state);
    const save = rollSaveWithBuffs(creature, saveMod, false, effect.save.dc, effect.save.ability);
    const passed = save.total >= effect.save.dc;
    state.events.push({ kind: 'save', targetId: creature.id, success: passed, durationMs: BASE_DURATIONS.save });
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: passed ? 'Save' : 'Failed Save',
      details: passed
        ? `${creature.displayName} partially avoids ${target.displayName}'s Death Throes (${save.total} vs DC ${effect.save.dc}).`
        : `${creature.displayName} is caught in ${target.displayName}'s Death Throes (${save.total} vs DC ${effect.save.dc}).`,
      type: passed ? 'save' : 'damage'
    });

    for (const burstDamage of effect.damage) {
      if (!creature.isAlive) break;
      const rolled = rollDice(burstDamage.dice).total;
      const amount = passed ? Math.floor(rolled / 2) : rolled;
      const beforeHp = creature.currentHp;
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Death Throes',
        details: `${creature.displayName} takes ${amount} ${burstDamage.type} damage from ${target.displayName}'s Death Throes.`,
        damage: amount,
        type: 'damage'
      });
      const ev = pushHitEvent(state, creature.id, amount, burstDamage.type, false, beforeHp);
      applyDamage(state, creature, amount, burstDamage.type, target, false, true);
      ev.targetHpAfter = creature.currentHp;
    }
  }
}

export function resolveSpellReflection(
  state: BattleState,
  caster: Creature,
  target: Creature,
  spellKind: 'magicMissile' | 'rangedSpellAttack',
  spellName: string,
): 'none' | 'unaffected' | 'reflected' {
  if (caster.id === target.id) return 'none';
  const effect = getSpellReflectionRuntime(target, spellKind);
  if (!effect) return 'none';
  const roll = rollDice('1d6').total;
  const reflected = effect.reflectOn.includes(roll);
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Reflective Carapace',
    details: reflected
      ? `${target.displayName} is unaffected by ${spellName} and reflects it back at ${caster.displayName} (${roll} on 1d6).`
      : `${target.displayName} is unaffected by ${spellName} (${roll} on 1d6).`,
    type: 'special'
  });
  pushEffectEvent(state, target.id, reflected ? 'Spell Reflected' : 'Spell Negated', reflected ? 'success' : 'arcane');
  if (reflected) pushEffectEvent(state, caster.id, 'Reflected', 'danger');
  return reflected ? 'reflected' : 'unaffected';
}

/**
 * Sum the dice bonuses on a creature's attack rolls (Bless = "1d4", Bane = "-1d4").
 * Returns a rolled integer; safe to add to the d20 roll total directly.
 */
// Buff bonus math (rollAttackBuffBonus, rollSaveBuffBonus, getRageDamageBonus,
// rollSaveWithBuffs, applyBuffDamageResistance) lives in ./combat-buffs.

function grantDarkOnesBlessing(state: BattleState, warlock: Creature, slainEnemy: Creature): void {
  if (!isFiendPatronWarlock(warlock, 3)) return;
  if (warlock.team === slainEnemy.team) return;
  const level = warlock.monsterData.heroLevel ?? 0;
  const tempHp = Math.max(0, abilityModifier(getEffectiveAbilityScore(warlock, 'cha'))) + level;
  if (tempHp <= 0) return;
  warlock.stats.actionUsage["Dark One's Blessing"] = (warlock.stats.actionUsage["Dark One's Blessing"] || 0) + 1;
  applyTemporaryHp(state, warlock, tempHp, warlock, "Dark One's Blessing");
}

function applyDarkOnesBlessingOnDeath(state: BattleState, slainEnemy: Creature, attacker: Creature | null): void {
  const recipients = new Set<string>();
  if (attacker && isFiendPatronWarlock(attacker, 3)) {
    recipients.add(attacker.id);
    grantDarkOnesBlessing(state, attacker, slainEnemy);
  }
  for (const creature of state.creatures) {
    if (recipients.has(creature.id)) continue;
    if (!isFiendPatronWarlock(creature, 3)) continue;
    if (creatureDistance(creature, slainEnemy) > 10) continue;
    recipients.add(creature.id);
    grantDarkOnesBlessing(state, creature, slainEnemy);
  }
}

/**
 * Permanently kill a creature. Single source of truth for "this creature
 * is dead and not coming back this battle" - shared by the legacy 0-HP
 * path for monsters, the 3-failed-death-saves path for heroes, and the
 * massive-damage shortcut on dying heroes.
 */
function markPermanentlyDead(state: BattleState, target: Creature, attacker: Creature | null, opts: { fromSaves?: boolean } = {}): void {
  if (target.wildShape) revertWildShape(state, target, 'dead');
  releaseSwallowedTargets(state, target);
  releaseContainedTargets(state, target);
  if (target.swallowedBy) {
    const source = getCreatureById(state, target.swallowedBy.sourceId);
    if (source?.swallowedTargetId === target.id) source.swallowedTargetId = undefined;
    target.swallowedBy = undefined;
  }
  target.containedBy = undefined;
  processDeathBurst(state, target);
  target.currentHp = 0;
  target.isAlive = false;
  target.dying = false;
  target.deathSaves = undefined;
  target.stats.deathRound = state.round;
  // diedFromSaves split lets MC report "deaths after death saves" vs
  // "outright deaths". Default false = outright (monster at 0 HP, massive
  // damage, etc.). True is set only by the runDeathSave 3-fail path and
  // the dying-creature damage path when failures cap.
  target.stats.diedFromSaves = !!opts.fromSaves;
  if (attacker && !target.stats.killedBy) {
    target.stats.killedBy = attacker.displayName;
  }
  target.conditions = [];
  target.conditionTimers = [];
  dropConcentratedBuffsFrom(state, target.id);
  target.activeBuffs = [];
  if (attacker) attacker.stats.killCount++;
  applyDarkOnesBlessingOnDeath(state, target, attacker);

  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Death',
    details: `${target.displayName} has been slain!`,
    type: 'death'
  });
  state.events.push({ kind: 'death', creatureId: target.id, durationMs: BASE_DURATIONS.death });
}

export interface RuntimeDamageSummary {
  totalDamageTaken: number;
  byType: Record<string, number>;
}

export function emptyDamageSummary(): RuntimeDamageSummary {
  return { totalDamageTaken: 0, byType: {} };
}

export function addDamageToSummary(summary: RuntimeDamageSummary, damage: number, damageType: string): void {
  if (damage <= 0) return;
  summary.totalDamageTaken += damage;
  const key = damageType.toLowerCase();
  summary.byType[key] = (summary.byType[key] ?? 0) + damage;
}

function abilityLabel(ability: keyof MonsterData['abilities']): string {
  return ({
    str: 'Strength',
    dex: 'Dexterity',
    con: 'Constitution',
    int: 'Intelligence',
    wis: 'Wisdom',
    cha: 'Charisma',
  })[ability];
}

export function applyHitPointMaxReduction(
  state: BattleState,
  target: Creature,
  amount: number,
  source: Creature | null,
  actionName: string,
): void {
  if (!target.isAlive || amount <= 0) return;
  target.hpMaxReduction = (target.hpMaxReduction ?? 0) + amount;
  target.maxHp = Math.max(0, target.maxHp - amount);
  if (target.currentHp > target.maxHp) target.currentHp = target.maxHp;
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Hit Point Maximum Reduced',
    details: `${target.displayName}'s Hit Point maximum is reduced by ${amount} from ${actionName} (${target.currentHp}/${target.maxHp} HP).`,
    type: 'special'
  });
  pushEffectEvent(state, target.id, `Max HP -${amount}`, 'danger');
  if (target.maxHp <= 0) {
    markPermanentlyDead(state, target, source, { fromSaves: false });
  }
}

function applyAbilityScoreDrain(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  actionName: string,
  ability: keyof MonsterData['abilities'],
  dice: string,
  deathAtZero: boolean,
): void {
  if (!target.isAlive) return;
  const before = getEffectiveAbilityScore(target, ability);
  if (before <= 0) return;
  const drain = rollDice(dice).total;
  target.abilityScoreDamage = target.abilityScoreDamage ?? {};
  target.abilityScoreDamage[ability] = (target.abilityScoreDamage[ability] ?? 0) + drain;
  const after = getEffectiveAbilityScore(target, ability);
  const label = abilityLabel(ability);
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: `${label} Drain`,
    details: `${target.displayName}'s ${label} score decreases by ${drain} from ${actionName} (${before} -> ${after}).`,
    type: 'special'
  });
  pushEffectEvent(state, target.id, `${label} -${drain}`, 'danger');
  if (deathAtZero && after <= 0) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: `${label} Reduced to 0`,
      details: `${target.displayName} dies as ${label} is reduced to 0.`,
      type: 'death'
    });
    markPermanentlyDead(state, target, attacker, { fromSaves: false });
  }
}

function attachOngoingEffect(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  effect: Extract<NonNullable<MonsterAction['effects']>[number], { kind: 'ongoingDamage' }>,
): void {
  if (!target.isAlive) return;
  target.ongoingEffects = target.ongoingEffects ?? [];
  if (effect.key.toLowerCase().includes('infernal wound') &&
      target.ongoingEffects.some(e => e.key.toLowerCase().includes('infernal wound'))) {
    return;
  }
  const existing = target.ongoingEffects.find(e => e.key === effect.key && e.sourceId === attacker.id);
  const runtime = {
    key: effect.key,
    sourceId: attacker.id,
    sourceName: attacker.displayName,
    condition: effect.condition,
    damage: effect.damage,
    damageType: effect.damageType,
    tick: effect.tick,
    noHealing: effect.noHealing,
    saveEnds: effect.saveEnds,
    ticksRemaining: effect.maxTicks,
    appliedRound: state.round,
    expiresRound: effect.expiresAfterRounds ? state.round + effect.expiresAfterRounds : undefined,
  };
  if (existing) {
    Object.assign(existing, runtime);
  } else {
    target.ongoingEffects.push(runtime);
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: 'Ongoing Effect',
    details: `${target.displayName} is affected by ${effect.key}.`,
    type: 'special'
  });
  pushEffectEvent(state, target.id, effect.key, 'danger');
}

function attachHealingBlockEffect(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  effect: Extract<NonNullable<MonsterAction['effects']>[number], { kind: 'blocksHealing' }>,
): void {
  if (!target.isAlive) return;
  target.ongoingEffects = target.ongoingEffects ?? [];
  const runtime = {
    key: effect.key,
    sourceId: attacker.id,
    sourceName: attacker.displayName,
    condition: effect.condition,
    tick: effect.tick ?? 'targetTurnStart',
    noHealing: true,
    appliedRound: state.round,
    expiresRound: effect.expiresAfterRounds ? state.round + effect.expiresAfterRounds : undefined,
  };
  const existing = target.ongoingEffects.find(e => e.key === effect.key && e.sourceId === attacker.id);
  if (existing) {
    Object.assign(existing, runtime);
  } else {
    target.ongoingEffects.push(runtime);
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: effect.key,
    details: `${target.displayName} can't regain Hit Points while affected by ${effect.key}.`,
    type: 'special'
  });
  pushEffectEvent(state, target.id, 'No Healing', 'danger');
}

function ongoingEffectApplySaveFails(
  state: BattleState,
  _attacker: Creature,
  target: Creature,
  effect: Extract<NonNullable<MonsterAction['effects']>[number], { kind: 'ongoingDamage' }>,
): boolean {
  if (!effect.applySave) return true;
  const saveMod = getEffectiveSaveModifier(target, effect.applySave.ability, state);
  const hasMR = hasActiveTrait(target, 'Magic Resistance');
  const save = rollSaveWithBuffs(target, saveMod, hasMR, effect.applySave.dc, effect.applySave.ability);
  const failed = save.total < effect.applySave.dc;
  state.events.push({ kind: 'save', targetId: target.id, success: !failed, durationMs: BASE_DURATIONS.save });
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: failed ? 'Failed Save' : 'Save',
    details: failed
      ? `${target.displayName} fails to resist ${effect.key}. (${save.total} vs DC ${effect.applySave.dc})`
      : `${target.displayName} resists ${effect.key}. (${save.total} vs DC ${effect.applySave.dc})`,
    type: failed ? 'condition' : 'save'
  });
  return failed;
}

function attachContainerEffect(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  effect: Extract<NonNullable<MonsterAction['effects']>[number], { kind: 'container' }>,
): void {
  if (!target.isAlive) return;
  if (!targetFitsMaxSize(target, effect.maxTargetSize)) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: attacker.displayName, action: effect.key,
      details: `${target.displayName} is too large to be contained by ${effect.key}.`,
      type: 'info'
    });
    return;
  }
  if (effect.sourceCapacity) {
    const slotValue = (creature: Creature) => effect.sourceCapacity!.sizeSlots?.[getActiveSize(creature)] ?? 1;
    const used = state.creatures
      .filter(c => c.id !== target.id && c.containedBy?.sourceId === attacker.id && c.containedBy.key === effect.key)
      .reduce((sum, c) => sum + slotValue(c), 0);
    const needed = slotValue(target);
    if (used + needed > effect.sourceCapacity.maxSlots) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: effect.key,
        details: `${attacker.displayName} has no room to contain ${target.displayName} with ${effect.key}.`,
        type: 'info'
      });
      return;
    }
  }
  if (target.containedBy?.sourceId === attacker.id && target.containedBy.key === effect.key) return;
  target.containedBy = {
    key: effect.key,
    sourceId: attacker.id,
    sourceName: attacker.displayName,
    conditions: effect.conditions,
    sourceTurnDamage: effect.sourceTurnDamage,
    sourceTurnDamageType: effect.sourceTurnDamageType,
    targetTurnDamage: effect.targetTurnDamage,
    targetTurnDamageType: effect.targetTurnDamageType,
    totalCover: effect.totalCover,
    movesWithSource: effect.movesWithSource,
    escapeDc: effect.escapeDc,
  };
  for (const condition of effect.conditions) {
    applyCondition(state, target, condition, attacker, 'permanent');
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: effect.key,
    details: `${target.displayName} is contained by ${attacker.displayName}.`,
    type: 'special'
  });
  pushEffectEvent(state, target.id, effect.key, 'danger');
}

function getRegenerationRuntime(creature: Creature): {
  profile: 'atLeastOneHp';
  amount: number;
  suppressedBy: string[];
} | null {
  const trait = getActiveTraits(creature).find(t => t.name === 'Regeneration');
  if (!trait) return null;
  const effect = trait.effects?.find(e => e.kind === 'regeneration');
  if (effect?.kind === 'regeneration') {
    return {
      profile: effect.profile,
      amount: effect.amount,
      suppressedBy: effect.suppressedBy ?? [],
    };
  }
  const desc = trait.description.toLowerCase();
  const amount = Number(trait.description.match(/regains (\d+) /i)?.[1] ?? 0);
  if (!amount) return null;
  const suppressedBy = ['acid', 'fire', 'radiant'].filter(type => desc.includes(type));
  return { profile: 'atLeastOneHp', amount, suppressedBy };
}

function regenerationSuppressedByDamage(
  regen: { suppressedBy: string[] } | null,
  damageType: string,
): boolean {
  if (!regen) return false;
  const dt = damageType.toLowerCase();
  return regen.suppressedBy.some(type => dt.includes(type.toLowerCase()));
}

function processHydraDamage(state: BattleState, target: Creature, damage: number, damageType: string, attacker: Creature | null): void {
  const config = getHydraHeadConfig(target.monsterData);
  if (!config || !target.isAlive || damage <= 0) return;
  const heads = target.hydraHeads ?? {
    living: config.startingHeads,
    killedSinceTurn: 0,
    tookFireSinceTurn: false,
  };
  target.hydraHeads = heads;
  const turnKey = `${state.round}:${state.turnIndex}`;
  if (heads.damageTurnKey !== turnKey) {
    heads.damageTurnKey = turnKey;
    heads.damageThisTurn = 0;
    heads.headKilledThisTurn = false;
  }
  heads.damageThisTurn = (heads.damageThisTurn ?? 0) + damage;
  if (damageType.toLowerCase().includes('fire')) {
    heads.tookFireSinceTurn = true;
  }
  if (!heads.headKilledThisTurn && heads.damageThisTurn >= config.damagePerHead && heads.living > 0) {
    heads.living -= 1;
    heads.killedSinceTurn += 1;
    heads.headKilledThisTurn = true;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Head Severed',
      details: `${target.displayName} loses a head after taking ${heads.damageThisTurn} damage this turn (${heads.living} heads remain).`,
      type: 'special'
    });
    pushEffectEvent(state, target.id, `Head Lost (${heads.living})`, 'danger');
    if (heads.living <= 0) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'All Heads Destroyed',
        details: `${target.displayName} dies as its last head is destroyed.`,
        type: 'death'
      });
      markPermanentlyDead(state, target, attacker, { fromSaves: false });
    }
  }
}

export function applyActionRuntimeEffects(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction,
  damageSummary: RuntimeDamageSummary = emptyDamageSummary(),
  opts: { savePassed?: boolean } = {},
): void {
  if (!action.effects || action.effects.length === 0 || !target.isAlive) return;
  for (const effect of action.effects) {
    if (!target.isAlive) break;
    if (opts.savePassed && effect.kind !== 'hpMaxReduction') continue;
    if (effect.kind === 'abilityScoreDrain') {
      applyAbilityScoreDrain(state, attacker, target, action.name, effect.ability, effect.dice, effect.deathAtZero);
    } else if (effect.kind === 'hpMaxReduction') {
      const amount = effect.amount === 'damageTypeTaken'
        ? damageSummary.byType[(effect.damageType ?? '').toLowerCase()] ?? 0
        : damageSummary.totalDamageTaken;
      applyHitPointMaxReduction(state, target, amount, attacker, action.name);
    } else if (effect.kind === 'ongoingDamage') {
      if (effect.condition && !target.conditions.includes(effect.condition)) continue;
      if (!ongoingEffectApplySaveFails(state, attacker, target, effect)) continue;
      attachOngoingEffect(state, attacker, target, effect);
    } else if (effect.kind === 'blocksHealing') {
      if (effect.condition && !target.conditions.includes(effect.condition)) continue;
      attachHealingBlockEffect(state, attacker, target, effect);
    } else if (effect.kind === 'container') {
      attachContainerEffect(state, attacker, target, effect);
    }
  }
}

function releaseContainedCreature(state: BattleState, target: Creature, sourceId: string, prone = false): void {
  if (target.containedBy?.sourceId !== sourceId) return;
  const container = target.containedBy;
  target.containedBy = undefined;
  for (const condition of container.conditions) {
    removeConditionFromSource(state, target, condition, sourceId);
  }
  if (prone && target.isAlive && !target.conditions.includes('prone')) {
    const source = getCreatureById(state, sourceId);
    if (source) applyCondition(state, target, 'prone', source, 'end_of_next_turn');
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Released',
    details: `${target.displayName} is no longer affected by ${container.key}.`,
    type: 'condition'
  });
  pushEffectEvent(state, target.id, 'Released', 'success');
}

function releaseContainedTargets(state: BattleState, source: Creature): void {
  for (const target of state.creatures) {
    if (target.containedBy?.sourceId === source.id) {
      releaseContainedCreature(state, target, source.id, true);
    }
  }
}

export function hasTotalCoverFromContainer(target: Creature, attacker: Creature): boolean {
  const container = target.containedBy;
  return !!container?.totalCover && container.sourceId !== attacker.id && target.id !== attacker.id;
}

export function logTotalCoverFromContainer(state: BattleState, attacker: Creature, target: Creature, actionName: string): void {
  if (!target.containedBy) return;
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: attacker.displayName, action: actionName,
    details: `${target.displayName} has total cover while contained by ${target.containedBy.sourceName}.`,
    type: 'info'
  });
}

function removeOngoingEffect(state: BattleState, target: Creature, effectKey: string, sourceId: string): void {
  const effect = target.ongoingEffects?.find(e => e.key === effectKey && e.sourceId === sourceId);
  if (!effect) return;
  target.ongoingEffects = target.ongoingEffects?.filter(e => !(e.key === effectKey && e.sourceId === sourceId));
  if (effect.condition) {
    removeConditionFromSource(state, target, effect.condition, sourceId);
  }
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Effect Ends',
    details: `${effect.key} ends on ${target.displayName}.`,
    type: 'condition'
  });
  pushEffectEvent(state, target.id, 'Effect Ends', 'success');
}

function rollOngoingEffectSave(state: BattleState, target: Creature, effect: NonNullable<Creature['ongoingEffects']>[number]): boolean {
  if (!effect.saveEnds) return false;
  const saveMod = getEffectiveSaveModifier(target, effect.saveEnds.ability, state);
  const hasMR = hasActiveTrait(target, 'Magic Resistance');
  const save = rollSave(saveMod, hasMR);
  const passed = save.total >= effect.saveEnds.dc;
  state.events.push({ kind: 'save', targetId: target.id, success: passed, durationMs: BASE_DURATIONS.save });
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: passed ? 'Save' : 'Failed Save',
    details: passed
      ? `${target.displayName} ends ${effect.key}! (${save.total} vs DC ${effect.saveEnds.dc})`
      : `${target.displayName} remains affected by ${effect.key}. (${save.total} vs DC ${effect.saveEnds.dc})`,
    type: passed ? 'save' : 'condition'
  });
  return passed;
}

function applyOngoingDamage(state: BattleState, target: Creature, effect: NonNullable<Creature['ongoingEffects']>[number]): boolean {
  if (!target.isAlive || !effect.damage || !effect.damageType) return false;
  const damage = rollDice(effect.damage).total;
  const source = getCreatureById(state, effect.sourceId) ?? null;
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: effect.sourceName, action: effect.key,
    details: `${target.displayName} takes ${damage} ${effect.damageType} damage from ${effect.key}.`,
    damage,
    type: 'damage'
  });
  const beforeHp = target.currentHp;
  const event = pushHitEvent(state, target.id, damage, effect.damageType, false, beforeHp);
  applyDamage(state, target, damage, effect.damageType, source, false, true);
  event.targetHpAfter = target.currentHp;
  if (effect.ticksRemaining === undefined) return false;
  effect.ticksRemaining--;
  return effect.ticksRemaining <= 0;
}

export function processTargetTurnStartOngoingEffects(state: BattleState, target: Creature): void {
  if (!target.isAlive) return;
  triggerPersistentZones(state, target, 'turnStart');
  if (!target.isAlive) return;
  if (target.ongoingEffects?.length) {
    for (const effect of [...target.ongoingEffects]) {
      if (!target.isAlive) break;
      if (effect.expiresRound !== undefined && state.round > effect.expiresRound) {
        removeOngoingEffect(state, target, effect.key, effect.sourceId);
        continue;
      }
      if (effect.tick === 'targetTurnStart') {
        if (applyOngoingDamage(state, target, effect)) removeOngoingEffect(state, target, effect.key, effect.sourceId);
      }
      if (target.isAlive && effect.saveEnds?.at === 'targetTurnStart' && rollOngoingEffectSave(state, target, effect)) {
        removeOngoingEffect(state, target, effect.key, effect.sourceId);
      }
    }
  }
  const container = target.containedBy;
  if (target.isAlive && container?.targetTurnDamage && container.targetTurnDamageType) {
    const source = getCreatureById(state, container.sourceId);
    if (!source || !source.isAlive) {
      releaseContainedCreature(state, target, container.sourceId, true);
      return;
    }
    const damage = rollDice(container.targetTurnDamage).total;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: container.sourceName, action: container.key,
      details: `${target.displayName} takes ${damage} ${container.targetTurnDamageType} damage while contained by ${container.sourceName}.`,
      damage,
      type: 'damage'
    });
    const beforeHp = target.currentHp;
    const event = pushHitEvent(state, target.id, damage, container.targetTurnDamageType, false, beforeHp);
    applyDamage(state, target, damage, container.targetTurnDamageType, source, false, true);
    event.targetHpAfter = target.currentHp;
  }
}

export function processSourceTurnStartOngoingEffects(state: BattleState, source: Creature): void {
  if (!source.isAlive) return;
  for (const target of state.creatures) {
    if (!target.isAlive) continue;
    for (const effect of [...(target.ongoingEffects ?? [])]) {
      if (effect.sourceId === source.id && effect.tick === 'sourceTurnStart') {
        if (applyOngoingDamage(state, target, effect)) removeOngoingEffect(state, target, effect.key, effect.sourceId);
      }
    }
    const container = target.containedBy;
    if (container?.sourceId === source.id && container.sourceTurnDamage && container.sourceTurnDamageType) {
      const damage = rollDice(container.sourceTurnDamage).total;
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: source.displayName, action: container.key,
        details: `${target.displayName} takes ${damage} ${container.sourceTurnDamageType} damage while contained by ${source.displayName}.`,
        damage,
        type: 'damage'
      });
      const beforeHp = target.currentHp;
      const event = pushHitEvent(state, target.id, damage, container.sourceTurnDamageType, false, beforeHp);
      applyDamage(state, target, damage, container.sourceTurnDamageType, source, false, true);
      event.targetHpAfter = target.currentHp;
    }
  }
}

export function processTargetTurnEndOngoingEffects(state: BattleState, target: Creature): void {
  if (!target.isAlive) return;
  triggerPersistentZones(state, target, 'turnEnd');
  if (!target.isAlive) return;
  for (const timer of target.conditionTimers.filter(candidate => candidate.duration === 'end_of_current_turn')) {
    target.conditionTimers = target.conditionTimers.filter(candidate => candidate !== timer);
    if (!target.conditionTimers.some(candidate => candidate.condition === timer.condition)) target.conditions = target.conditions.filter(condition => condition !== timer.condition);
  }
  for (const buff of [...(target.activeBuffs ?? [])]) {
    if (buff.saveEnds?.at !== 'targetTurnEnd') continue;
    const save = rollSaveWithBuffs(target, getEffectiveSaveModifier(target, buff.saveEnds.ability, state), buff.saveAdvantageOnNextSave === true, buff.saveEnds.dc, buff.saveEnds.ability);
    buff.saveAdvantageOnNextSave = false;
    const passed = save.total >= buff.saveEnds.dc;
    state.events.push({ kind: 'save', targetId: target.id, success: passed, durationMs: BASE_DURATIONS.save });
    pushLog(state, {
      round: state.round, turn: state.turnIndex, actor: target.displayName, action: buff.name,
      details: passed ? `${target.displayName} ends ${buff.name}. (${save.total} vs DC ${buff.saveEnds.dc})` : `${target.displayName} remains affected by ${buff.name}. (${save.total} vs DC ${buff.saveEnds.dc})`,
      type: passed ? 'save' : 'condition',
    });
    if (passed) {
      target.activeBuffs = target.activeBuffs.filter(candidate => candidate !== buff);
      for (const condition of buff.appliedConditions ?? (buff.appliedCondition ? [buff.appliedCondition] : [])) {
        target.conditionTimers = target.conditionTimers.filter(timer => !(timer.condition === condition && timer.sourceId === buff.casterId));
        if (!target.conditionTimers.some(timer => timer.condition === condition)) target.conditions = target.conditions.filter(candidate => candidate !== condition);
      }
    }
  }
  if (!target.ongoingEffects?.length) return;
  for (const effect of [...target.ongoingEffects]) {
    if (effect.expiresRound !== undefined && state.round >= effect.expiresRound) {
      removeOngoingEffect(state, target, effect.key, effect.sourceId);
      continue;
    }
    if (effect.tick === 'targetTurnEnd' && applyOngoingDamage(state, target, effect)) {
      removeOngoingEffect(state, target, effect.key, effect.sourceId);
      continue;
    }
    if (effect.saveEnds?.at === 'targetTurnEnd' && rollOngoingEffectSave(state, target, effect)) {
      removeOngoingEffect(state, target, effect.key, effect.sourceId);
    }
  }
}

export function processHydraEndOfTurn(state: BattleState, creature: Creature): void {
  const config = getHydraHeadConfig(creature.monsterData);
  const heads = creature.hydraHeads;
  if (!config || !heads || !creature.isAlive) return;
  if (heads.killedSinceTurn > 0) {
    if (heads.tookFireSinceTurn) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: creature.displayName, action: 'Multiple Heads',
        details: `${creature.displayName}'s lost heads do not regrow because it took fire damage.`,
        type: 'special'
      });
      pushEffectEvent(state, creature.id, 'No Regrowth', 'danger');
    } else {
      const regrown = heads.killedSinceTurn * 2;
      heads.living += regrown;
      const before = creature.currentHp;
      const healed = gainHp(creature, config.regrowHp);
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: creature.displayName, action: 'Multiple Heads',
        details: `${creature.displayName} regrows ${regrown} heads and regains ${healed} HP (${heads.living} heads).`,
        type: 'heal'
      });
      pushEffectEvent(state, creature.id, `Heads +${regrown}`, 'success');
      if (healed > 0) {
        state.events.push({ kind: 'heal', creatureId: creature.id, amount: healed, creatureHpBefore: before, creatureHpAfter: creature.currentHp, durationMs: BASE_DURATIONS.heal });
      }
    }
  }
  heads.killedSinceTurn = 0;
  heads.tookFireSinceTurn = false;
  heads.damageTurnKey = undefined;
  heads.damageThisTurn = 0;
  heads.headKilledThisTurn = false;
}

export function tryEscapeContainer(state: BattleState, creature: Creature): boolean {
  const container = creature.containedBy;
  if (!container || !creature.isAlive) return false;
  const source = getCreatureById(state, container.sourceId);
  if (!source || !source.isAlive) {
    releaseContainedCreature(state, creature, container.sourceId, true);
    return false;
  }
  if (!container.escapeDc) return false;
  let roll = rollD20();
  if (creature.monsterData.heroSpecies === 'Halfling' && roll.total === 1) roll = rollD20();
  const total = roll.total + abilityModifier(getEffectiveAbilityScore(creature, 'str'));
  const success = total >= container.escapeDc;
  state.events.push({ kind: 'save', targetId: creature.id, success, durationMs: BASE_DURATIONS.save });
  if (success) {
    releaseContainedCreature(state, creature, container.sourceId, false);
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: 'Escape',
      details: `${creature.displayName} escapes ${container.key}! (${total} vs DC ${container.escapeDc})`,
      type: 'special'
    });
  } else {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: 'Escape',
      details: `${creature.displayName} fails to escape ${container.key}. (${total} vs DC ${container.escapeDc})`,
      type: 'condition'
    });
  }
  return true;
}

function canActToStabilise(actor: Creature): boolean {
  if (!actor.monsterData.isHero) return false;
  if (!actor.isAlive || actor.dying) return false;
  return !actor.conditions.some(c =>
    c === 'unconscious' || c === 'incapacitated' || c === 'paralyzed' ||
    c === 'petrified' || c === 'stunned'
  );
}

function stabiliseDyingAlly(state: BattleState, actor: Creature, target: Creature): boolean {
  if (!canActToStabilise(actor)) return false;
  if (target.team !== actor.team || !target.monsterData.isHero) return false;
  if (!target.isAlive || !target.dying) return false;
  if (creatureDistance(actor, target) > 5) return false;

  target.currentHp = 0;
  target.dying = false;
  target.deathSaves = undefined;
  if (!target.conditions.includes('unconscious')) {
    target.conditions.push('unconscious');
    target.conditionTimers.push({
      condition: 'unconscious',
      duration: 'permanent',
      appliedRound: state.round,
      sourceId: 'stabilised',
    });
  }
  target.stats.timesStabilisedByAllies = (target.stats.timesStabilisedByAllies ?? 0) + 1;
  actor.stats.alliesStabilised = (actor.stats.alliesStabilised ?? 0) + 1;
  actor.stats.actionUsage.Stabilise = (actor.stats.actionUsage.Stabilise ?? 0) + 1;

  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: actor.displayName, action: 'Stabilise',
    details: `${actor.displayName} stabilises ${target.displayName}. ${target.displayName} remains unconscious at 0 HP but stops making death saves.`,
    type: 'special'
  });
  state.events.push({
    kind: 'stabiliseAlly',
    actorId: actor.id,
    creatureId: target.id,
    durationMs: BASE_DURATIONS.stabiliseAlly,
  });
  return true;
}

/**
 * Roll a death save for a dying hero at the start of their turn. Pure
 * state mutation - the caller (processTurnStart) decides what to do
 * afterwards based on the resulting flags (isAlive, dying). Replay-safe:
 * the rolled value is captured in a deathSave event so replay is
 * deterministic.
 *
 *  Nat 1   => 2 failures
 *  2-9     => 1 failure
 *  10-19   => 1 success
 *  Nat 20  => pop back to 1 HP, clear dying
 *  3 successes => stabilised (stays unconscious, dying false)
 *  3 failures  => permanently dead
 */
function runDeathSave(state: BattleState, creature: Creature): void {
  if (!creature.dying || !creature.deathSaves) return;
  // Count every roll for the MC death-save report card. Tracked here
  // (the single roll site) so it stays accurate even if outcomes branch.
  creature.stats.deathSaveRolls = (creature.stats.deathSaveRolls ?? 0) + 1;
  const survivor = creature.monsterData.heroClass === 'Fighter' && (creature.monsterData.heroLevel ?? 0) >= 18;
  const halflingLuck = creature.monsterData.heroSpecies === 'Halfling';
  const result = survivor ? rollAttack(0, true, false, halflingLuck).roll : rollD20();
  const roll = halflingLuck && result.total === 1 ? rollD20().total : result.total;
  let outcome: 'success' | 'failure' | 'critFail' | 'popUp' | 'stabilised' | 'died';

  if (roll >= (survivor ? 18 : 20)) {
    // Nat 20, or Champion Survivor 18-20: pop up at 1 HP, conscious, dying cleared. The hero acts
    // normally this turn (the unconscious-skip check in processTurnStart
    // sees the cleared condition and lets them through).
    creature.dying = false;
    creature.deathSaves = undefined;
    creature.currentHp = 1;
    creature.conditions = creature.conditions.filter(c => c !== 'unconscious');
    creature.conditionTimers = creature.conditionTimers.filter(t => t.condition !== 'unconscious');
    creature.stats.timesPoppedAtOneHp = (creature.stats.timesPoppedAtOneHp ?? 0) + 1;
    outcome = 'popUp';
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: 'Death Save',
      details: survivor && roll < 20
        ? `${creature.displayName} rolls ${roll} on their death save; Survivor brings them back at 1 HP!`
        : `${creature.displayName} rolls a nat 20 on their death save - back on their feet at 1 HP!`,
      type: 'special'
    });
    state.events.push({
      kind: 'deathSave', creatureId: creature.id, roll, outcome,
      successesAfter: 0, failuresAfter: 0,
      durationMs: BASE_DURATIONS.deathSave,
    });
    state.events.push({
      kind: 'condition', creatureId: creature.id, condition: 'unconscious', applied: false, durationMs: 0,
    });
    return;
  }

  if (roll === 1) {
    creature.deathSaves.failures = Math.min(3, creature.deathSaves.failures + 2);
    outcome = 'critFail';
  } else if (roll <= 9) {
    creature.deathSaves.failures = Math.min(3, creature.deathSaves.failures + 1);
    outcome = 'failure';
  } else {
    creature.deathSaves.successes = Math.min(3, creature.deathSaves.successes + 1);
    outcome = 'success';
  }

  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: creature.displayName, action: 'Death Save',
    details: `${creature.displayName} rolls ${roll} on their death save - ${outcome === 'critFail' ? '2 failures!' : outcome === 'failure' ? 'failure.' : 'success.'} (${creature.deathSaves.successes} successes / ${creature.deathSaves.failures} failures)`,
    type: outcome === 'success' ? 'info' : 'death'
  });
  state.events.push({
    kind: 'deathSave', creatureId: creature.id, roll, outcome,
    successesAfter: creature.deathSaves.successes,
    failuresAfter: creature.deathSaves.failures,
    durationMs: BASE_DURATIONS.deathSave,
  });

  if (creature.deathSaves.failures >= 3) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: 'Death',
      details: `${creature.displayName} fails their third death save and dies.`,
      type: 'death'
    });
    markPermanentlyDead(state, creature, null, { fromSaves: true });
    return;
  }
  if (creature.deathSaves.successes >= 3) {
    // Stabilised: stays unconscious, no more death saves. Stays effectively
    // out of the fight for this combat (we don't simulate the 1d4-hour
    // wake-up because battles are single encounters).
    creature.dying = false;
    creature.deathSaves = undefined;
    creature.stats.timesStabilisedBySaves = (creature.stats.timesStabilisedBySaves ?? 0) + 1;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: 'Stabilised',
      details: `${creature.displayName} is stabilised - still unconscious but no longer rolling death saves.`,
      type: 'special'
    });
    state.events.push({
      kind: 'deathSave', creatureId: creature.id, roll, outcome: 'stabilised',
      successesAfter: 3, failuresAfter: 0,
      durationMs: BASE_DURATIONS.deathSave,
    });
  }
}

/**
 * The single clamped HP-restore primitive - the counterpart to applyDamage.
 * Every path that RAISES a creature's current HP through healing or
 * regeneration funnels through here (applyHealing for spells,
 * processRegeneration, and Hydra head-regrowth), so "where does HP go up?"
 * has one answer, mirroring "applyDamage is the only place damage lowers it".
 *
 * It deliberately does NOT handle revive / wake-from-downed (that life-state
 * transition lives in applyHealing) and does NOT push events or logs - callers
 * own their own messaging. Returns the amount actually healed after clamping
 * at maxHp.
 */
export function gainHp(target: Creature, amount: number): number {
  if (amount <= 0) return 0;
  const before = target.currentHp;
  target.currentHp = Math.min(target.maxHp, target.currentHp + amount);
  return target.currentHp - before;
}

/**
 * True if `target` is immune to `damageType` by its stat block. Shared by
 * applyDamage and the AoE resolver so "what counts as immune" has one home.
 * `untyped` damage is never immune-able (matches the AoE guard).
 */
export function isImmuneToDamageType(target: Creature, damageType: string): boolean {
  if (!damageType || damageType === 'untyped') return false;
  const dt = damageType.toLowerCase();
  return (target.monsterData.immunities || []).some(i => dt.includes(i.toLowerCase()));
}

function isPhysicalDamageType(damageType: string): boolean {
  return /bludgeon|pierc|slash/i.test(damageType);
}

function ignoresPhysicalResistance(attacker: Creature | null, damageType: string): boolean {
  return hasIrresistibleOffense(attacker, damageType);
}

function tryRelentlessRage(state: BattleState, target: Creature): boolean {
  const level = target.monsterData.heroLevel ?? 0;
  if (target.monsterData.heroClass !== 'Barbarian' || level < 11) return false;
  if (!target.activeBuffs?.some(b => b.key === 'rage')) return false;
  const overflow = Math.abs(target.currentHp);
  if (overflow >= target.maxHp) return false;

  const dc = target.resources['relentless-rage-dc'] ?? 10;
  target.resources['relentless-rage-dc'] = dc + 5;
  const conMod = getEffectiveSaveModifier(target, 'con', state);
  const save = rollSaveWithBuffs(target, conMod, false, dc, 'con');
  state.events.push({ kind: 'save', targetId: target.id, success: save.total >= dc, durationMs: BASE_DURATIONS.save });
  if (save.total < dc) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Relentless Rage',
      details: `${target.displayName} fails Relentless Rage (${save.total} vs DC ${dc}).`,
      type: 'save',
    });
    return false;
  }

  const hp = Math.min(target.maxHp, level * 2);
  target.currentHp = hp;
  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: 'Relentless Rage',
    details: `${target.displayName} succeeds Relentless Rage (${save.total} vs DC ${dc}) and stays up at ${hp} HP.`,
    type: 'special',
  });
  target.stats.actionUsage['Relentless Rage'] = (target.stats.actionUsage['Relentless Rage'] || 0) + 1;
  state.events.push({
    kind: 'heal',
    creatureId: target.id,
    amount: hp,
    creatureHpBefore: 0,
    creatureHpAfter: hp,
    durationMs: BASE_DURATIONS.heal,
  });
  return true;
}

/**
 * Apply stat-block resistance / immunity / vulnerability to a raw damage
 * number, logging the outcome. Returns the adjusted damage and whether the
 * target was immune (in which case the caller should stop - damage is 0 and
 * no further effects should fire). Does NOT handle buff-based resistance
 * (Rage); that stays in applyDamage as a separate, later step.
 */
function resolveDamageResistance(
  state: BattleState, target: Creature, damage: number, damageType: string, isMagical: boolean, attacker: Creature | null = null,
): { damage: number; immune: boolean } {
  const dt = damageType.toLowerCase();
  const md = target.monsterData;
  const ignoreResistance = ignoresPhysicalResistance(attacker, damageType);

  if (isImmuneToDamageType(target, damageType)) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Immune',
      details: `${target.displayName} is immune to ${damageType} damage!`,
      type: 'info'
    });
    return { damage: 0, immune: true };
  }

  // Non-magical immunity: zero damage from mundane sources only.
  if (!isMagical && (md.nonmagicalImmunities || []).some(i => dt.includes(i.toLowerCase()))) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Immune',
      details: `${target.displayName} ignores non-magical ${damageType} damage!`,
      type: 'info'
    });
    return { damage: 0, immune: true };
  }

  if (!ignoreResistance && (md.resistances || []).some(r => dt.includes(r.toLowerCase()))) {
    damage = Math.floor(damage / 2);
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Resisted',
      details: `${target.displayName} resists ${damageType} - damage halved to ${damage}!`,
      type: 'info'
    });
  } else if (!ignoreResistance && !isMagical && (md.nonmagicalResistances || []).some(r => dt.includes(r.toLowerCase()))) {
    // Non-magical resistance: halve only when the source is mundane.
    damage = Math.floor(damage / 2);
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Resisted',
      details: `${target.displayName} resists non-magical ${damageType} - damage halved to ${damage}!`,
      type: 'info'
    });
  }

  if ((md.vulnerabilities || []).some(v => dt.includes(v.toLowerCase()))) {
    damage = damage * 2;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Vulnerable',
      details: `${target.displayName} is vulnerable to ${damageType} - damage doubled to ${damage}!`,
      type: 'info'
    });
  }

  return { damage, immune: false };
}

function activeBuffResistanceName(target: Creature, damageType: string): string {
  const dt = damageType.toLowerCase();
  for (const buff of target.activeBuffs ?? []) {
    if (buff.resistAllDamageExcept && !buff.resistAllDamageExcept.some(except => dt.includes(except.toLowerCase()))) {
      return buff.name;
    }
    if (buff.resistDamageTypes?.some(type => dt.includes(type.toLowerCase()))) {
      return buff.name;
    }
  }
  if (isPhysicalDamageType(damageType) && target.activeBuffs?.some(buff => buff.resistPhysical)) {
    return 'Rage Resistance';
  }
  return 'Damage Resistance';
}

function canMonkDeflectDamage(target: Creature, damageType: string, isAttack: boolean): boolean {
  const level = target.monsterData.heroClass === 'Monk' ? (target.monsterData.heroLevel ?? 0) : 0;
  if (level < 3 || !isAttack || !canTakeReactions(target) || target.currentHp <= 0) return false;
  if (target.conditions.includes('incapacitated') || target.conditions.includes('stunned') ||
      target.conditions.includes('paralyzed') || target.conditions.includes('petrified') ||
      target.conditions.includes('unconscious')) return false;
  if (level >= 13) return true;
  return isPhysicalDamageType(damageType);
}

function applyMonkDeflectDamage(
  state: BattleState,
  target: Creature,
  attacker: Creature | null,
  damage: number,
  damageType: string,
): number {
  if (!canMonkDeflectDamage(target, damageType, true) || damage <= 0) return damage;

  const level = target.monsterData.heroLevel ?? 0;
  const dexMod = abilityModifier(getEffectiveAbilityScore(target, 'dex'));
  const reduction = rollDice('1d10').total + dexMod + level;
  const reduced = Math.max(0, damage - reduction);
  target.reactionUsed = true;
  const action = level >= 13 && !isPhysicalDamageType(damageType) ? 'Deflect Energy' : 'Deflect Attacks';
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: target.displayName,
    action,
    details: `${target.displayName} reduces ${damageType} attack damage by ${reduction}: ${damage} → ${reduced}.`,
    type: 'info',
  });
  target.stats.actionUsage[action] = (target.stats.actionUsage[action] || 0) + 1;
  state.events.push({ kind: 'effect', creatureId: target.id, label: action, tone: 'success', durationMs: BASE_DURATIONS.effect });

  if (reduced === 0 && attacker?.isAlive && hasResource(target, 'ki')) {
    consumeResource(target, 'ki');
    const dice = `2d${monkMartialArtsDieSides(level)}${signedBonus(dexMod)}`;
    const redirect = rollDamage(dice, false).total;
    const wisMod = abilityModifier(getEffectiveAbilityScore(target, 'wis'));
    const dc = 8 + target.monsterData.proficiencyBonus + wisMod;
    const saveMod = getEffectiveSaveModifier(attacker, 'dex', state);
    const save = rollSaveWithBuffs(attacker, saveMod, false, dc, 'dex');
    const success = save.total >= dc;
    state.events.push({ kind: 'save', targetId: attacker.id, success, durationMs: BASE_DURATIONS.save });
    if (success) {
      pushLog(state, {
        round: state.round,
        turn: state.turnIndex,
        actor: attacker.displayName,
        action: `${action} Redirect Save`,
        details: `${attacker.displayName} avoids the redirected force (${save.total} vs DC ${dc}).`,
        type: 'save',
      });
    } else {
      pushLog(state, {
        round: state.round,
        turn: state.turnIndex,
        actor: target.displayName,
        action: `${action} Redirect`,
        details: `${target.displayName} redirects the blow into ${attacker.displayName} for ${redirect} ${damageType} damage (${save.total} vs DC ${dc}).`,
        damage: redirect,
        type: 'damage',
      });
      const before = attacker.currentHp;
      state.events.push({
        kind: 'hit',
        targetId: attacker.id,
        damage: redirect,
        damageType,
        critical: false,
        targetHpBefore: before,
        targetHpAfter: before,
        durationMs: BASE_DURATIONS.hit,
      });
      const hitEvent = state.events[state.events.length - 1];
      applyDamage(state, attacker, redirect, damageType, target, false, true, false);
      if (hitEvent.kind === 'hit') hitEvent.targetHpAfter = attacker.currentHp;
    }
    target.stats.actionUsage['Deflect Redirect'] = (target.stats.actionUsage['Deflect Redirect'] || 0) + 1;
  }

  return reduced;
}

function applyDamage(state: BattleState, target: Creature, damage: number, damageType: string, attacker: Creature | null, isAttack: boolean = false, isMagical: boolean = false, isCritical: boolean = false): number {
  const resisted = resolveDamageResistance(state, target, damage, damageType, isMagical, attacker);
  if (resisted.immune) return 0;
  damage = resisted.damage;
  if (damage > 0) {
    for (const buff of target.activeBuffs ?? []) {
      if (buff.saveEnds?.advantageOnDamage) buff.saveAdvantageOnNextSave = true;
    }
  }

  // Buff-sourced damage resistance (Rage halves bludgeoning/piercing/slashing).
  const postBuff = ignoresPhysicalResistance(attacker, damageType)
    ? damage
    : applyBuffDamageResistance(target, damage, damageType);
  if (postBuff !== damage) {
    const resistanceName = activeBuffResistanceName(target, damageType);
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: resistanceName,
      details: `${target.displayName} resists ${damageType}: ${damage} → ${postBuff}.`,
      type: 'info'
    });
    damage = postBuff;
  }

  // Dying creatures (heroes at 0 HP, unconscious, rolling death saves) do
  // not take HP damage. Each incoming damage instance adds a death-save
  // failure instead - 1 normally, or 2 if the hit is a critical OR comes
  // from a melee attack within 5 ft (per SRD 2024). A single hit equal
  // to or exceeding maxHp is massive damage and kills outright.
  //
  // This block MUST come before reaction-based defenses (Uncanny Dodge),
  // Wild Shape absorption, HP subtraction, concentration check, the
  // Sleep-wake branch, and Retaliation. An unconscious creature can't
  // take reactions and shouldn't lose more HP - everything downstream
  // of this branch assumes a conscious target.
  if (target.dying) {
    if (damage >= target.maxHp) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Massive Damage',
        details: `${target.displayName} takes ${damage} ${damageType} while dying - massive damage, killed outright.`,
        type: 'death'
      });
      markPermanentlyDead(state, target, attacker, { fromSaves: false });
      return damage;
    }
    const meleeAdj = !!(isAttack && attacker && creatureDistance(attacker, target) <= 5);
    // Two failures for crits OR melee within 5 ft (melee adj implies auto-
    // crit per SRD 2024, but a ranged crit on a dying hero is also 2 fails).
    const fails = (isCritical || meleeAdj) ? 2 : 1;
    target.deathSaves = target.deathSaves ?? { successes: 0, failures: 0 };
    target.deathSaves.failures = Math.min(3, target.deathSaves.failures + fails);
    if (attacker) attacker.stats.damageDealt += damage;
    const failureReason = isCritical && !meleeAdj ? ' (critical hit = 2 failures)'
      : meleeAdj ? ' (melee within 5 ft = 2 failures)'
      : '';
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Death Save Fail',
      details: `${target.displayName} takes ${damage} ${damageType} while dying${failureReason}. Failures: ${target.deathSaves.failures}/3.`,
      type: 'death'
    });
    state.events.push({
      kind: 'deathSaveFail', creatureId: target.id,
      failuresAfter: target.deathSaves.failures, fromMeleeAdj: meleeAdj,
      durationMs: BASE_DURATIONS.deathSaveFail,
    });
    if (target.deathSaves.failures >= 3) {
      markPermanentlyDead(state, target, attacker, { fromSaves: true });
    }
    return damage;
  }

  if (canMonkDeflectDamage(target, damageType, isAttack)) {
    damage = applyMonkDeflectDamage(state, target, attacker, damage, damageType);
    if (damage <= 0) return 0;
  }

  // Arena reactions are automatic. Stone's Endurance is the only Goliath
  // ancestry reaction that changes incoming damage before HP is applied.
  if (target.monsterData.heroSpecies === 'Goliath' && target.monsterData.heroSpeciesChoice === 'Stone'
      && canTakeReactions(target) && damage > 0 && consumeResource(target, 'goliath-giant-ancestry')) {
    target.reactionUsed = true;
    const reduction = rollDice('1d12').total + abilityModifier(getEffectiveAbilityScore(target, 'con'));
    const before = damage;
    damage = Math.max(0, damage - reduction);
    target.stats.actionUsage["Stone's Endurance"] = (target.stats.actionUsage["Stone's Endurance"] || 0) + 1;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: "Stone's Endurance",
      details: `${target.displayName} reduces ${before} damage by ${reduction}.`,
      type: 'info',
    });
    if (damage <= 0) return 0;
  }

  damage = applySuperiorHuntersDefense(state, target, damage, damageType);

  // Uncanny Dodge (Rogue L5+): reaction to halve damage from one attack
  // (not saves). Guarded against dying targets above - an unconscious
  // Rogue can't take a reaction.
  if (isAttack && target.monsterData.heroClass === 'Rogue' && (target.monsterData.heroLevel ?? 0) >= 5
      && canTakeReactions(target) && damage > 0) {
    target.reactionUsed = true;
    const before = damage;
    damage = Math.floor(damage / 2);
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Uncanny Dodge',
      details: `${target.displayName} uses Uncanny Dodge! Damage halved: ${before} → ${damage}.`,
      type: 'info'
    });
    target.stats.actionUsage['Uncanny Dodge'] = (target.stats.actionUsage['Uncanny Dodge'] || 0) + 1;
  }

  const tempBefore = target.temporaryHp ?? 0;
  if (tempBefore > 0 && damage > 0) {
    const absorbed = Math.min(tempBefore, damage);
    target.temporaryHp = tempBefore - absorbed;
    damage -= absorbed;
    target.stats.damageTaken += absorbed;
    if (attacker) attacker.stats.damageDealt += absorbed;
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: target.displayName,
      action: 'Temporary HP',
      details: `${target.displayName}'s temporary HP absorbs ${absorbed} damage (${target.temporaryHp} temporary HP left).`,
      type: 'info',
    });
    if (damage <= 0) {
      target.activeBuffs = target.activeBuffs.filter(buff => !buff.endsWhenTemporaryHpDepleted || (target.temporaryHp ?? 0) > 0);
      return 0;
    }
  }

  // 2024 Wild Shape: the Druid keeps real HP and the form's temporary HP
  // absorbs damage first. When those temporary HP are gone, the form ends
  // and any overflow hits the Druid's real HP.
  if (target.wildShape && damage > 0) {
    const tempBefore = target.wildShape.tempHp;
    const overflow = Math.max(0, damage - tempBefore);
    target.wildShape.tempHp = Math.max(0, tempBefore - damage);
    if (target.wildShape.tempHp === 0) {
      revertWildShape(state, target, overflow > 0 ? `${overflow} overflow damage` : 'temporary HP depleted');
    }
    if (overflow > 0) {
      target.currentHp -= overflow;
      target.stats.damageTaken += damage;
      if (attacker) attacker.stats.damageDealt += damage;
    } else {
      target.stats.damageTaken += damage;
      if (attacker) attacker.stats.damageDealt += damage;
    }
  } else {
    target.currentHp -= damage;
    target.stats.damageTaken += damage;
    if (attacker) attacker.stats.damageDealt += damage;
  }

  processHydraDamage(state, target, damage, damageType, attacker);
  target.activeBuffs = target.activeBuffs.filter(buff => !buff.endsWhenTemporaryHpDepleted || (target.temporaryHp ?? 0) > 0);
  if (!target.isAlive) return damage;

  for (const buff of [...(target.activeBuffs ?? [])]) {
    if (!buff.endsOnDamage) continue;
    target.activeBuffs = target.activeBuffs.filter(candidate => candidate !== buff);
    for (const condition of buff.appliedConditions ?? (buff.appliedCondition ? [buff.appliedCondition] : [])) {
      target.conditionTimers = target.conditionTimers.filter(timer => !(timer.condition === condition && timer.sourceId === buff.casterId));
      if (!target.conditionTimers.some(timer => timer.condition === condition)) target.conditions = target.conditions.filter(candidate => candidate !== condition);
    }
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: target.displayName, action: buff.name, details: `${target.displayName} takes damage and ends ${buff.name}.`, type: 'condition' });
  }

  // Concentration check: a caster taking damage makes a CON save at
  // DC = max(10, floor(damage / 2)). Fail drops every concentration
  // buff they placed on anyone (their buffs typically live on
  // beneficiaries, not on themselves - so we scan state-wide for any
  // buff flagged requiresConcentration whose casterId matches target).
  if (damage > 0 && target.isAlive) {
    const isConcentrating = !!target.concentratingOn || state.creatures.some(c =>
      c.activeBuffs?.some(b => b.requiresConcentration && b.casterId === target.id)
    );
    if (isConcentrating) {
      const dc = Math.max(10, Math.floor(damage / 2));
      const conMod = getEffectiveSaveModifier(target, 'con', state);
      const result = rollSaveWithBuffs(target, conMod, false, dc, 'con');
      if (result.total < dc) {
        const preserveHuntersMark = target.monsterData.heroClass === 'Ranger'
          && (target.monsterData.heroLevel ?? 0) >= 13
          && state.creatures.some(c => c.activeBuffs?.some(b =>
            b.requiresConcentration && b.casterId === target.id && b.key === 'hunters-mark'
          ));
        if (preserveHuntersMark) {
          pushLog(state, {
            round: state.round, turn: state.turnIndex,
            actor: target.displayName, action: 'Relentless Hunter',
            details: `${target.displayName} fails concentration (${result.total} vs DC ${dc}) but keeps Hunter's Mark.`,
            type: 'info'
          });
          dropConcentratedBuffsFrom(state, target.id, { preserveRelentlessHunter: true });
          if (target.concentratingOn !== 'hunters-mark') target.concentratingOn = undefined;
        } else {
          pushLog(state, {
            round: state.round, turn: state.turnIndex,
            actor: target.displayName, action: 'Concentration Broken',
            details: `${target.displayName} fails concentration (${result.total} vs DC ${dc}). Their active spell ends.`,
            type: 'info'
          });
          dropConcentratedBuffsFrom(state, target.id);
          target.concentratingOn = undefined;
        }
      }
    }
  }

  // Sleep (and similar effects): taking any damage removes the unconscious condition
  if (damage > 0 && target.isAlive && target.conditions.includes('unconscious')) {
    target.conditions = target.conditions.filter(c => c !== 'unconscious');
    target.conditionTimers = target.conditionTimers.filter(t => t.condition !== 'unconscious');
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Wakes Up',
      details: `${target.displayName} takes damage and wakes up!`,
      type: 'condition'
    });
    state.events.push({ kind: 'condition', creatureId: target.id, condition: 'unconscious', applied: false, durationMs: 0 });
  }

  if (target.currentHp <= 0) {
    tryRelentlessRage(state, target);
  }

  if (damage > 0 && target.isAlive && target.currentHp > 0 && attacker && attacker.isAlive
      && target.monsterData.heroSpecies === 'Goliath' && target.monsterData.heroSpeciesChoice === 'Storm'
      && canTakeReactions(target) && creatureDistance(target, attacker) <= 60
      && consumeResource(target, 'goliath-giant-ancestry')) {
    target.reactionUsed = true;
    const thunder = rollDice('1d8').total;
    const before = attacker.currentHp;
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: "Storm's Thunder",
      details: `${target.displayName} deals ${thunder} thunder damage to ${attacker.displayName}.`,
      damage: thunder, type: 'damage',
    });
    const event = pushHitEvent(state, attacker.id, thunder, 'thunder', false, before);
    applyDamage(state, attacker, thunder, 'thunder', target, false, true);
    event.targetHpAfter = attacker.currentHp;
    target.stats.actionUsage["Storm's Thunder"] = (target.stats.actionUsage["Storm's Thunder"] || 0) + 1;
  }

  if (damage > 0 && target.isAlive && target.currentHp > 0 && attacker && attacker.isAlive
      && target.monsterData.heroSpecies === 'Tiefling' && target.monsterData.heroSpeciesChoice === 'Infernal'
      && canTakeReactions(target) && creatureDistance(target, attacker) <= 60
      && consumeResource(target, 'infernal-hellish-rebuke')) {
    target.reactionUsed = true;
    const ability = target.monsterData.heroSpeciesCastingAbility ?? 'cha';
    const dc = 8 + target.monsterData.proficiencyBonus + abilityModifier(getEffectiveAbilityScore(target, ability));
    const save = rollSaveWithBuffs(attacker, getEffectiveSaveModifier(attacker, 'dex', state), false, dc, 'dex');
    const amount = save.total >= dc ? Math.floor(rollDice('2d10').total / 2) : rollDice('2d10').total;
    const event = pushHitEvent(state, attacker.id, amount, 'fire', false, attacker.currentHp);
    applyDamage(state, attacker, amount, 'fire', target, false, true);
    event.targetHpAfter = attacker.currentHp;
    target.stats.actionUsage['Hellish Rebuke'] = (target.stats.actionUsage['Hellish Rebuke'] || 0) + 1;
  }

  const hellishRebuke = target.monsterData.actions.find(action => action.name === 'Hellish Rebuke' && action.reactionOnly);
  if (damage > 0 && target.isAlive && target.currentHp > 0 && attacker && attacker.isAlive && hellishRebuke
      && canTakeReactions(target) && creatureDistance(target, attacker) <= (hellishRebuke.range?.normal ?? 60)) {
    const resourceKey = hellishRebuke.resourceCost?.key;
    const slot = resourceKey ? null : lowestAvailableSlot(target);
    const canPay = resourceKey
      ? consumeResource(target, resourceKey, hellishRebuke.resourceCost!.amount)
      : slot !== null && consumeResource(target, `slot-${slot}`);
    if (canPay && hellishRebuke.savingThrow?.damageOnFail) {
      target.reactionUsed = true;
      const save = rollSaveWithBuffs(attacker, getEffectiveSaveModifier(attacker, hellishRebuke.savingThrow.ability, state), false, hellishRebuke.savingThrow.dc, hellishRebuke.savingThrow.ability);
      const amount = save.total >= hellishRebuke.savingThrow.dc
        ? Math.floor(rollDice(hellishRebuke.savingThrow.damageOnFail).total / 2)
        : rollDice(hellishRebuke.savingThrow.damageOnFail).total;
      const event = pushHitEvent(state, attacker.id, amount, hellishRebuke.damageType ?? 'fire', false, attacker.currentHp);
      applyDamage(state, attacker, amount, hellishRebuke.damageType ?? 'fire', target, false, true);
      event.targetHpAfter = attacker.currentHp;
      target.stats.actionUsage['Hellish Rebuke'] = (target.stats.actionUsage['Hellish Rebuke'] || 0) + 1;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: target.displayName, action: 'Hellish Rebuke', details: `${target.displayName} rebukes ${attacker.displayName}.`, damage: amount, type: 'damage' });
    }
  }

  // Retaliation (Barbarian L10): reaction melee attack when damaged by adjacent creature
  if (damage > 0 && target.isAlive && target.currentHp > 0 && attacker && attacker.isAlive
      && target.monsterData.heroClass === 'Barbarian' && (target.monsterData.heroLevel ?? 0) >= 10
      && canTakeReactions(target) && creatureDistance(target, attacker) <= 5) {
    target.reactionUsed = true;
    const meleeAction = target.monsterData.actions.find(a => a.type === 'melee' && a.damage);
    if (meleeAction) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Retaliation',
        details: `${target.displayName} retaliates against ${attacker.displayName}!`,
        type: 'special'
      });
      resolveAttack(state, target, attacker, meleeAction);
      target.stats.actionUsage['Retaliation'] = (target.stats.actionUsage['Retaliation'] || 0) + 1;
    }
  }

  const regeneration = getRegenerationRuntime(target);
  // Suppress regeneration if the damage type matches the suppression clause.
  if (damage > 0 && regeneration) {
    if (regenerationSuppressedByDamage(regeneration, damageType)) {
      target.recharges['regenSuppressed'] = true;
    }
  }

  if (target.currentHp <= 0) {
    // Orc Relentless Endurance is automatic: it cannot prevent massive damage
    // and is available once per Long Rest (once per arena encounter).
    const overflow = Math.abs(target.currentHp);
    if (target.monsterData.heroSpecies === 'Orc' && !target.turnFlags.orcRelentlessEndurance && overflow < target.maxHp) {
      target.currentHp = 1;
      target.turnFlags.orcRelentlessEndurance = true;
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Relentless Endurance',
        details: `${target.displayName} drops to 1 HP instead of 0.`,
        type: 'special',
      });
      return damage;
    }

    // Death Ward: first time target would drop to 0 HP, set to 1 instead
    const deathWardIdx = target.activeBuffs?.findIndex(b => b.key === 'death-ward' && b.preventDeath);
    if (deathWardIdx !== undefined && deathWardIdx >= 0) {
      target.currentHp = 1;
      target.activeBuffs!.splice(deathWardIdx, 1);
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Death Ward',
        details: `${target.displayName}'s Death Ward triggers - drops to 1 HP instead of 0!`,
        type: 'special'
      });
      return damage;
    }

    // Check Undead Fortitude
    const hasUndeadFort = target.monsterData.traits?.some(t => t.name === 'Undead Fortitude');
    if (hasUndeadFort && damageType !== 'radiant') {
      const dc = 5 + damage;
      const save = rollSave(getEffectiveSaveModifier(target, 'con', state));
      if (save.total >= dc) {
        target.currentHp = 1;
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: target.displayName, action: 'Undead Fortitude',
          details: `${target.displayName} makes its Undead Fortitude save (${save.total} vs DC ${dc}) and stays up with 1 HP!`,
          type: 'special'
        });
        return damage;
      }
    }

    // Heroes at 0 HP enter the Downed state (unconscious, rolling death
     // saves at the start of each turn) instead of dying outright. Monsters
     // skip this branch and fall through to permanent death. Massive damage
     // (overflow >= maxHp) bypasses Downed and kills the hero outright -
     // matches SRD 2024 "Instant Death" wording.
    if (target.monsterData.isHero && !target.dying) {
      const overflow = Math.abs(target.currentHp);
      if (overflow < target.maxHp) {
        target.currentHp = 0;
        target.dying = true;
        target.deathSaves = { successes: 0, failures: 0 };
        if (!target.conditions.includes('unconscious')) {
          target.conditions.push('unconscious');
          target.conditionTimers.push({
            condition: 'unconscious', duration: 'permanent',
            appliedRound: state.round, sourceId: 'dying',
          });
        }
        dropConcentratedBuffsFrom(state, target.id);
        target.concentratingOn = undefined;
        target.stats.timesDowned = (target.stats.timesDowned ?? 0) + 1;
        if (attacker && !target.stats.killedBy) {
          target.stats.killedBy = attacker.displayName;
        }
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: target.displayName, action: 'Downed',
          details: `${target.displayName} drops to 0 HP and falls unconscious - rolling death saves at the start of each turn until stabilised or killed.`,
          type: 'death'
        });
        state.events.push({ kind: 'downed', creatureId: target.id, durationMs: BASE_DURATIONS.downed });
        state.events.push({ kind: 'condition', creatureId: target.id, condition: 'unconscious', applied: true, durationMs: 0 });
        return damage;
      }
      // overflow >= maxHp: massive damage = instant death, fall through.
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Massive Damage',
        details: `${target.displayName} suffers massive damage (${overflow} overflow vs ${target.maxHp} max HP) and dies outright.`,
        type: 'death'
      });
    }

    markPermanentlyDead(state, target, attacker);
  }
  return damage;
}

function applyCondition(
  state: BattleState,
  target: Creature,
  condition: Condition,
  source: Creature,
  duration: ConditionDuration = 'end_of_next_turn',
  saveDC?: number,
  saveAbility?: keyof typeof target.monsterData.abilities,
  stageInfo?: { stages: Condition[]; currentIndex: number }
): boolean {
  if (!target.isAlive) return false;

  // Check condition immunity
  const immunities = [...(target.monsterData.conditionImmunities || []), ...(target.activeBuffs?.flatMap(buff => buff.conditionImmunities ?? []) ?? [])];
  if (immunities.includes(condition)) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Immune',
      details: `${target.displayName} is immune to ${condition}!`,
      type: 'condition'
    });
    return false;
  }

  // Paladin Aura of Devotion (L7): allies within 10ft immune to charmed
  // Paladin Aura of Courage (L10): allies within 10ft immune to frightened
  if ((condition === 'charmed' || condition === 'frightened') && target.isAlive) {
    if (
      target.monsterData.heroClass === 'Barbarian' &&
      (target.monsterData.heroLevel ?? 0) >= 6 &&
      target.activeBuffs?.some(b => b.key === 'rage')
    ) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Mindless Rage',
        details: `${target.displayName}'s Rage makes them immune to ${condition}.`,
        type: 'condition'
      });
      return false;
    }
    const auraLevel = condition === 'charmed' ? 7 : 10;
    const auraName = condition === 'charmed' ? 'Aura of Devotion' : 'Aura of Courage';
    const nearbyPaladin = getAliveCreatures(state, target.team).some(ally =>
      isPaladinAuraActive(ally)
      && (ally.monsterData.heroLevel ?? 0) >= auraLevel
      && creatureDistance(ally, target) <= paladinAuraRange(ally)
    );
    if (nearbyPaladin) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: auraName,
        details: `${target.displayName} is protected by ${auraName} - immune to ${condition}!`,
        type: 'condition'
      });
      return false;
    }
  }

  // Don't duplicate conditions
  if (target.conditions.includes(condition)) return false;

  target.conditions.push(condition);
  target.conditionTimers.push({
    condition,
    duration,
    appliedRound: state.round,
    sourceId: source.id,
    saveDC,
    saveAbility,
    ...(stageInfo ? { stageInfo } : {}),
  });

  pushLog(state, {
    round: state.round, turn: state.turnIndex,
    actor: target.displayName, action: condition.charAt(0).toUpperCase() + condition.slice(1),
    details: `${target.displayName} is now ${condition}!`,
    type: 'condition'
  });

  state.events.push({
    kind: 'condition', creatureId: target.id, condition, applied: true,
    durationMs: BASE_DURATIONS.condition,
  });

  if (target.wildShape && (condition === 'incapacitated' || condition === 'unconscious')) {
    revertWildShape(state, target, condition);
  }

  return true;
}

function resolveConditionOnHit(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction
): void {
  if (!action.conditionOnHit || !target.isAlive) return;
  if (!conditionTargetMatchesActionSize(action, target)) return;

  const { condition, save, duration, stages } = action.conditionOnHit;

  // Handle petrification stages
  if (stages && stages.length > 1) {
    const currentStageIndex = stages.findIndex(s => target.conditions.includes(s));
    const nextCondition = currentStageIndex < 0 ? stages[0] : stages[Math.min(currentStageIndex + 1, stages.length - 1)];

    // If already at final stage, nothing to do
    if (currentStageIndex >= stages.length - 1) return;

    if (save) {
      const saveMod = getEffectiveSaveModifier(target, save.ability, state);
      const hasMR = hasActiveTrait(target, 'Magic Resistance');
      const saveResult = rollSaveWithBuffs(target, saveMod, hasMR, save.dc, save.ability);

      state.events.push({ kind: 'save', targetId: target.id, success: saveResult.total >= save.dc, durationMs: BASE_DURATIONS.save });

      if (saveResult.total >= save.dc) {
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: target.displayName, action: 'Save',
          details: `${target.displayName} resists the ${nextCondition} effect! (${saveResult.total} vs DC ${save.dc})`,
          type: 'save'
        });
        return;
      }

      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Failed Save',
        details: `${target.displayName} fails the save! (${saveResult.total} vs DC ${save.dc})`,
        type: 'save'
      });
    }

    // Upgrade from previous stage if needed
    if (currentStageIndex >= 0) {
      const prevCondition = stages[currentStageIndex];
      target.conditions = target.conditions.filter(c => c !== prevCondition);
      target.conditionTimers = target.conditionTimers.filter(t => t.condition !== prevCondition);
      state.events.push({
        kind: 'condition', creatureId: target.id, condition: prevCondition, applied: false,
        durationMs: 0,
      });
    }

    const nextIndex = currentStageIndex < 0 ? 0 : currentStageIndex + 1;
    const nextDuration = nextCondition === stages[stages.length - 1] ? 'permanent' as ConditionDuration : (duration || 'end_of_next_turn');
    const nextStageInfo = nextDuration !== 'permanent' ? { stages: [...stages], currentIndex: nextIndex } : undefined;
    applyCondition(state, target, nextCondition, attacker, nextDuration, save?.dc, save?.ability, nextStageInfo);
    return;
  }

  // Standard (non-staged) condition on hit
  if (save) {
    const saveMod = getEffectiveSaveModifier(target, save.ability, state);
    const hasMR = hasActiveTrait(target, 'Magic Resistance');
    const saveResult = rollSaveWithBuffs(target, saveMod, hasMR, save.dc, save.ability);

    state.events.push({ kind: 'save', targetId: target.id, success: saveResult.total >= save.dc, durationMs: BASE_DURATIONS.save });

    if (saveResult.total >= save.dc) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: target.displayName, action: 'Save',
        details: `${target.displayName} resists the ${condition} effect! (${saveResult.total} vs DC ${save.dc})`,
        type: 'save'
      });
      return;
    }

    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: target.displayName, action: 'Failed Save',
      details: `${target.displayName} fails the save! (${saveResult.total} vs DC ${save.dc})`,
      type: 'save'
    });
  }

  const applied = applyCondition(state, target, condition, attacker, duration || 'end_of_next_turn', save?.dc, save?.ability);
  if (applied && condition === 'grappled' && action.description.toLowerCase().includes('while grappled') &&
      action.description.toLowerCase().includes('restrained')) {
    applyCondition(state, target, 'restrained', attacker, duration || 'end_of_next_turn', save?.dc, save?.ability);
  }
}

/**
 * Range / altitude / line-of-sight gate for an attack. Returns the distance
 * to the target if the attack may proceed, or null if it auto-fails - out of
 * reach, out of range, swinging at an airborne target the attacker can't
 * reach, or no line of sight - in which case it has already logged why. Pure
 * check: it rolls nothing and does not touch turn flags (the caller owns the
 * "this creature engaged in melee this turn" side effects).
 */
function validateAttackRange(
  state: BattleState, attacker: Creature, target: Creature, action: MonsterAction,
): number | null {
  const dist = creatureDistance(attacker, target);
  const isMelee = action.type === 'melee' || action.type === undefined;
  if (isMelee) {
    // Altitude gate: a grounded creature can't melee an airborne target.
    // Attackers WITH fly speed can engage at altitude (flyer-vs-flyer);
    // attackers with no fly capability swing at empty air.
    const attackerCanFly = (getActiveSpeed(attacker).fly ?? 0) > 0;
    if (target.airborne && !attackerCanFly) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: action.name,
        details: `${attacker.displayName} can't reach ${target.displayName} - flying above melee range.`,
        type: 'info'
      });
      return null;
    }
    const reach = action.reach ?? 5;
    if (dist > reach) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: action.name,
        details: `${attacker.displayName} cannot reach ${target.displayName} with ${action.name} (${dist} ft > reach ${reach} ft).`,
        type: 'info'
      });
      return null;
    }
  } else if (action.type === 'ranged') {
    const normal = action.range?.normal ?? 5;
    const long = action.range?.long ?? normal;
    if (dist > long) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: action.name,
        details: `${attacker.displayName} is out of range for ${action.name} (${dist} ft > max range ${long} ft).`,
        type: 'info'
      });
      return null;
    }
    // Line of sight - walls block ranged attacks, chasms don't. The
    // check is cheap (Bresenham over a ~20-cell line + Set lookups)
    // and skipped entirely when no sight-blocking terrain exists.
    const sightBlocked = state.terrainSightBlocked;
    if (magicalDarknessBlocksSight(state.darknessZones, state.round, attacker, target)
      || (sightBlocked && sightBlocked.size > 0 &&
        lineOfSightBlocked(attacker.position, target.position, getFootprintSize(getActiveSize(attacker)), getFootprintSize(getActiveSize(target)), sightBlocked))) {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: action.name,
        details: `${attacker.displayName} has no line of sight to ${target.displayName}.`,
        type: 'info'
      });
      return null;
    }
  }
  return dist;
}

function bardicInspirationDieForLevel(level: number): string {
  if (level >= 15) return '1d12';
  if (level >= 10) return '1d10';
  if (level >= 5) return '1d8';
  return '1d6';
}

function maxRollForDie(die: string): number {
  const match = /^1d(\d+)$/.exec(die);
  return match ? Number(match[1]) : 0;
}

function findCuttingWordsBard(state: BattleState, protectedCreature: Creature, hostileCreature: Creature): Creature | undefined {
  return getAliveCreatures(state)
    .filter(c => c.team === protectedCreature.team)
    .filter(c => c.monsterData.heroClass === 'Bard' && (c.monsterData.heroLevel ?? 0) >= 3)
    .filter(c => canTakeReactions(c) && hasResource(c, 'bardic-inspiration'))
    .filter(c => creatureDistance(c, hostileCreature) <= 60)
    .sort((a, b) => (b.monsterData.heroLevel ?? 0) - (a.monsterData.heroLevel ?? 0))[0];
}

function useCuttingWords(state: BattleState, bard: Creature, attacker: Creature, amount: number, mode: 'attack' | 'damage'): void {
  consumeResource(bard, 'bardic-inspiration');
  bard.reactionUsed = true;
  bard.stats.actionUsage['Cutting Words'] = (bard.stats.actionUsage['Cutting Words'] || 0) + 1;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: bard.displayName,
    action: 'Cutting Words',
    details: mode === 'attack'
      ? `${bard.displayName} distracts ${attacker.displayName}, subtracting ${amount} from the attack roll.`
      : `${bard.displayName} distracts ${attacker.displayName}, subtracting ${amount} from the damage roll.`,
    type: 'special',
  });
}

function applyCuttingWordsToAttackRoll(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  roll: ReturnType<typeof rollAttack>['roll'],
  naturalRoll: number,
  ac: number,
): void {
  if (naturalRoll === 20 || roll.total < ac) return;
  const bard = findCuttingWordsBard(state, target, attacker);
  if (!bard) return;
  const die = bardicInspirationDieForLevel(bard.monsterData.heroLevel ?? 1);
  if (roll.total - maxRollForDie(die) >= ac) return;
  const penalty = rollDice(die).total;
  useCuttingWords(state, bard, attacker, penalty, 'attack');
  roll.total -= penalty;
  roll.modifier -= penalty;
}

function applyPeerlessSkillToAttackRoll(
  state: BattleState,
  attacker: Creature,
  roll: ReturnType<typeof rollAttack>['roll'],
  naturalRoll: number,
  ac: number,
): void {
  if (naturalRoll === 1 || naturalRoll === 20 || roll.total >= ac) return;
  if (attacker.monsterData.heroClass !== 'Bard' || (attacker.monsterData.heroLevel ?? 0) < 14) return;
  if (!hasResource(attacker, 'bardic-inspiration')) return;
  const die = bardicInspirationDieForLevel(attacker.monsterData.heroLevel ?? 1);
  const bonus = rollDice(die).total;
  attacker.stats.actionUsage['Peerless Skill'] = (attacker.stats.actionUsage['Peerless Skill'] || 0) + 1;
  if (roll.total + bonus < ac) {
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: attacker.displayName,
      action: 'Peerless Skill',
      details: `${attacker.displayName} tries Peerless Skill (+${bonus}) but still misses; the Bardic Inspiration use is not expended.`,
      type: 'special',
    });
    return;
  }
  consumeResource(attacker, 'bardic-inspiration');
  roll.total += bonus;
  roll.modifier += bonus;
  pushLog(state, {
    round: state.round,
    turn: state.turnIndex,
    actor: attacker.displayName,
    action: 'Peerless Skill',
    details: `${attacker.displayName} adds ${bonus} from Bardic Inspiration, turning the miss into a hit.`,
    type: 'special',
  });
}

function applyCuttingWordsToDamageRoll(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  damage: number,
): number {
  if (damage <= 0) return damage;
  const bard = findCuttingWordsBard(state, target, attacker);
  if (!bard) return damage;
  const die = bardicInspirationDieForLevel(bard.monsterData.heroLevel ?? 1);
  const reduction = Math.min(damage, rollDice(die).total);
  useCuttingWords(state, bard, attacker, reduction, 'damage');
  return Math.max(0, damage - reduction);
}

export function passesSanctuary(state: BattleState, attacker: Creature, target: Creature): boolean {
  const sanctuary = target.activeBuffs?.find(buff => buff.sanctuarySaveDc !== undefined);
  if (!sanctuary || attacker.id === target.id) return true;
  const sanctuaryDc = sanctuary.sanctuarySaveDc!;
  const save = rollSaveWithBuffs(attacker, getEffectiveSaveModifier(attacker, 'wis', state), false, sanctuaryDc, 'wis');
  state.events.push({ kind: 'save', targetId: attacker.id, success: save.total >= sanctuaryDc, durationMs: BASE_DURATIONS.save });
  if (save.total >= sanctuaryDc) return true;
  pushLog(state, {
    round: state.round, turn: state.turnIndex, actor: attacker.displayName, action: 'Sanctuary',
    details: `${attacker.displayName} cannot bring itself to attack ${target.displayName} (${save.total} vs DC ${sanctuaryDc}).`, type: 'save',
  });
  return false;
}

export function createPersistentZone(state: BattleState, caster: Creature, action: MonsterAction, center: { x: number; y: number } | undefined): void {
  const config = action.persistentZone;
  const save = action.savingThrow;
  if (!config || !center) return;
  state.persistentZones = (state.persistentZones ?? []).filter(zone => !(zone.sourceId === caster.id && zone.name === action.name));
  state.persistentZones.push({
    sourceId: caster.id, name: action.name, x: center.x, y: center.y, radius: config.radiusFt,
    endRound: state.round + config.durationRounds, saveAbility: save?.ability, saveDC: save ? save.dc + getSpellSaveDcBonus(caster, action) : undefined,
    conditionOnFail: save?.conditionOnFail, conditionDuration: save?.conditionDuration ?? 'end_of_next_turn', triggers: config.triggers,
    difficultTerrain: config.difficultTerrain, difficultTerrainTowardSource: config.difficultTerrainTowardSource, damagePer5Ft: config.damagePer5Ft,
    shape: config.shape, origin: config.shape === 'line' ? { ...caster.position } : undefined, direction: config.shape === 'line' ? { ...center } : undefined, pushOnFailedSave: config.pushOnFailedSave,
    skipActionsOnFailedSave: config.skipActionsOnFailedSave,
    requiresConcentration: action.concentration === true,
  });
}

function isInPersistentZone(zone: PersistentZone, position: { x: number; y: number }): boolean {
  if (zone.shape === 'line' && zone.origin && zone.direction) {
    const dx = position.x - zone.origin.x;
    const dy = position.y - zone.origin.y;
    const ddx = zone.direction.x - zone.origin.x;
    const ddy = zone.direction.y - zone.origin.y;
    const directionLength = Math.hypot(ddx, ddy);
    const targetDistance = Math.hypot(dx, dy) * 5;
    if (targetDistance <= 0 || targetDistance > zone.radius || directionLength === 0 || (dx * ddx + dy * ddy) < 0) return false;
    return Math.abs(dx * ddy - dy * ddx) / directionLength <= 1.2;
  }
  return distance(position, { x: zone.x, y: zone.y }) <= zone.radius;
}

export function persistentZoneMovementCost(state: BattleState, creature: Creature, from: { x: number; y: number }, position: { x: number; y: number }): number {
  if (creature.airborne) return 1;
  return (state.persistentZones ?? []).some(zone => zone.endRound > state.round && isInPersistentZone(zone, position) && (
    zone.difficultTerrain || (zone.difficultTerrainTowardSource && zone.origin && isInPersistentZone(zone, from) && distance(position, zone.origin) < distance(from, zone.origin))
  )) ? 2 : 1;
}

export function applyPersistentZoneMovementEffects(state: BattleState, creature: Creature, path: Array<{ x: number; y: number }>, from: { x: number; y: number }): void {
  if (creature.airborne) return;
  let previous = from;
  for (const position of path) {
    for (const zone of state.persistentZones ?? []) {
      if (zone.endRound <= state.round || !zone.damagePer5Ft || (!isInPersistentZone(zone, previous) && !isInPersistentZone(zone, position))) continue;
      const source = getCreatureById(state, zone.sourceId) ?? null;
      const damage = rollDice(zone.damagePer5Ft.dice).total;
      const beforeHp = creature.currentHp;
      pushLog(state, { round: state.round, turn: state.turnIndex, actor: source?.displayName ?? zone.name, action: zone.name, details: `${creature.displayName} takes ${damage} ${zone.damagePer5Ft.type} damage moving through ${zone.name}.`, damage, type: 'damage' });
      const event = pushHitEvent(state, creature.id, damage, zone.damagePer5Ft.type, false, beforeHp);
      applyDamage(state, creature, damage, zone.damagePer5Ft.type, source, false, true);
      event.targetHpAfter = creature.currentHp;
      if (!creature.isAlive) return;
    }
    previous = position;
  }
}

export function triggerPersistentZones(state: BattleState, target: Creature, trigger: 'entry' | 'turnStart' | 'turnEnd'): void {
  state.persistentZones = (state.persistentZones ?? []).filter(zone => zone.endRound > state.round);
  for (const zone of state.persistentZones ?? []) {
    if (!zone.triggers.includes(trigger) || zone.saveAbility === undefined || zone.saveDC === undefined || !isInPersistentZone(zone, target.position)) continue;
    const source = getCreatureById(state, zone.sourceId);
    if (!source) continue;
    const save = rollSaveWithBuffs(target, getEffectiveSaveModifier(target, zone.saveAbility, state), hasActiveTrait(target, 'Magic Resistance'), zone.saveDC, zone.saveAbility, zone.conditionOnFail);
    const passed = save.total >= zone.saveDC;
    state.events.push({ kind: 'save', targetId: target.id, success: passed, durationMs: BASE_DURATIONS.save });
    if (passed) continue;
    if (zone.conditionOnFail) applyCondition(state, target, zone.conditionOnFail, source, zone.conditionDuration, zone.saveDC, zone.saveAbility);
    if (zone.skipActionsOnFailedSave) {
      target.hasActed = true;
      target.bonusActionUsed = true;
    }
    if (zone.pushOnFailedSave) pushTargetAwayFromCaster(state, source, target, zone.pushOnFailedSave, zone.name);
  }
}

function resolveAttack(
  state: BattleState,
  attacker: Creature,
  target: Creature,
  action: MonsterAction,
  opts?: { cause?: 'opportunity' }
): void {
  if (!action.attackBonus && action.attackBonus !== 0) return;
  if (!target.isAlive) return;
  if (action.type === 'multiattack') return;
  if (!passesSanctuary(state, attacker, target)) return;
  for (const buff of [...attacker.activeBuffs].filter(candidate => candidate.endsOnAttackOrCast)) {
    removeActiveBuff(state, attacker, buff);
  }
  if (hasTotalCoverFromContainer(target, attacker)) {
    logTotalCoverFromContainer(state, attacker, target, action.name);
    return;
  }

  if (action.spellLevel !== undefined && action.attackBonus !== undefined && target.id !== attacker.id) {
    const reflection = resolveSpellReflection(state, attacker, target, 'rangedSpellAttack', action.name);
    if (reflection === 'unaffected') return;
    if (reflection === 'reflected') {
      resolveAttack(state, attacker, attacker, action, opts);
      return;
    }
  }

  // Range / altitude / line-of-sight gate - out-of-range attacks auto-fail
  // (already logged) without rolling.
  const dist = validateAttackRange(state, attacker, target, action);
  if (dist === null) return;

  // Steady Aim grants Advantage on one attack, not every attack this turn.
  const consumesSteadyAim = Boolean(attacker.turnFlags?.steadyAim && !attacker.turnFlags.steadyAimConsumed && (action.type === 'melee' || action.type === 'ranged'));

  // A valid melee swing engages the attacker this turn. Used by the
  // flying-OA-exemption rule (a flyer that bit something had to drop to
  // engage, so it provokes OAs from grounded enemies on departure), and it
  // flips the persistent `airborne` state down to melee until the next turn.
  // Older test fixtures predate turnFlags; guard with an init.
  if (action.type === 'melee' || action.type === undefined) {
    if (!attacker.turnFlags) attacker.turnFlags = {};
    attacker.turnFlags.madeMeleeAttack = true;
    if (attacker.airborne) attacker.airborne = false;
  }

  // Ranged disadvantage: beyond normal range OR enemy adjacent to attacker
  let rangedDisadvantage = false;
  if (action.type === 'ranged') {
    const normal = action.range?.normal ?? 5;
    if (dist > normal) rangedDisadvantage = true;
    const anyEnemyAdjacent = getAliveCreatures(state).some(e =>
      e.team !== attacker.team && creatureDistance(e, attacker) <= 5
    );
    if (anyEnemyAdjacent) rangedDisadvantage = true;
  }

  attacker.stats.attacksMade++;
  attacker.stats.actionUsage[action.name] = (attacker.stats.actionUsage[action.name] || 0) + 1;
  const usesBrutalStrike = !!attacker.turnFlags?.brutalStrike && action.type === 'melee';
  if (usesBrutalStrike) {
    attacker.turnFlags.brutalStrike = false;
    attacker.turnFlags.brutalStrikeUsed = true;
  }

  const vexBuffKeys = (target.activeBuffs ?? [])
    .filter(b => b.advantageForAttackerId === attacker.id)
    .map(b => b.key);
  const guidingBuffKeys = (target.activeBuffs ?? [])
    .filter(b => b.advantageForAllAttackers)
    .map(b => b.key);
  const sunderingBuffs = (target.activeBuffs ?? [])
    .filter(b => b.attackBonusForAllAttackers && b.casterId !== attacker.id);
  const sunderingBuffKeys = sunderingBuffs.map(b => b.key);
  const sapBuffKeys = (attacker.activeBuffs ?? [])
    .filter(b => b.attackDisadvantage)
    .map(b => b.key);

  const adv = hasAdvantage(state, attacker, target, action);
  // Making an attack reveals a hidden creature, hit or miss. Resolve the
  // attack's Advantage first, then remove the state before any follow-up.
  attacker.activeBuffs = attacker.activeBuffs.filter(buff => !buff.key.startsWith('hidden-from:'));
  const escapeTheHordeDisadvantage = opts?.cause === 'opportunity'
    && target.monsterData.heroClass === 'Ranger'
    && (target.monsterData.heroLevel ?? 0) >= 7
    && (!target.monsterData.heroSubclass || target.monsterData.heroSubclass === 'Hunter');
  const hiddenTarget = target.activeBuffs?.some(buff => buff.key === `hidden-from:${attacker.id}`) ?? false;
  const dis = hasDisadvantage(attacker, target, action) || rangedDisadvantage || escapeTheHordeDisadvantage || hiddenTarget;

  // Check displacement
  const hasDisplacement = hasActiveTrait(target, 'Displacement');
  const effectiveDis = dis || (hasDisplacement ? true : false);
  const advantageBlocked = blocksAttackAdvantage(target);
  const effectiveAdv = adv && !advantageBlocked && !effectiveDis;
  const attackHasDisadvantage = effectiveDis && (!adv || advantageBlocked);

  // Base d20 roll. Bless etc. dice bonuses are added on top of the total.
  let { roll, naturalRoll } = rollAttackForCreature(attacker, action.attackBonus!, effectiveAdv, attackHasDisadvantage);
  if (consumesSteadyAim) attacker.turnFlags.steadyAimConsumed = true;
  const buffBonus = rollAttackBuffBonus(attacker);
  if (buffBonus !== 0) {
    roll.total += buffBonus;
    roll.modifier += buffBonus;
  }
  const targetAttackBonus = sunderingBuffs.reduce((sum, b) => sum + (b.attackBonusForAllAttackers ?? 0), 0);
  if (targetAttackBonus !== 0) {
    roll.total += targetAttackBonus;
    roll.modifier += targetAttackBonus;
  }
  const ac = getEffectiveAC(target);

  // Heroic Warrior (Fighter L10) and Human Resourceful inspiration reroll a missed attack.
  const humanInspiration = (attacker.resources?.['heroic-inspiration'] ?? 0) > 0;
  if (naturalRoll !== 20 && roll.total < ac && (attacker.turnFlags?.heroicInspiration || humanInspiration)) {
    const reroll = rollAttackForCreature(attacker, action.attackBonus!, effectiveAdv, attackHasDisadvantage);
    const rerollBuff = rollAttackBuffBonus(attacker);
    reroll.roll.total += rerollBuff + targetAttackBonus;
    if (reroll.roll.total > roll.total) {
      roll = reroll.roll;
      naturalRoll = reroll.naturalRoll;
    }
    if (attacker.turnFlags?.heroicInspiration) {
      delete attacker.turnFlags.heroicInspiration;
      attacker.stats.actionUsage['Heroic Warrior'] = (attacker.stats.actionUsage['Heroic Warrior'] || 0) + 1;
    } else {
      consumeResource(attacker, 'heroic-inspiration');
      attacker.stats.actionUsage['Heroic Inspiration'] = (attacker.stats.actionUsage['Heroic Inspiration'] || 0) + 1;
    }
  }

  applyCuttingWordsToAttackRoll(state, attacker, target, roll, naturalRoll, ac);
  applyPeerlessSkillToAttackRoll(state, attacker, roll, naturalRoll, ac);
  const seekingReroll = trySeekingSpell(
    state,
    attacker,
    action,
    roll,
    naturalRoll,
    effectiveAdv,
    attackHasDisadvantage,
    buffBonus,
    targetAttackBonus,
    ac,
  );
  if (seekingReroll) {
    roll = seekingReroll.roll;
    naturalRoll = seekingReroll.naturalRoll;
  }

  const critThreshold = fighterCriticalThreshold(attacker, action);
  if (naturalRoll !== 20 && (naturalRoll === 1 || roll.total < ac) && canUseStrokeOfLuck(attacker)) {
    consumeResource(attacker, 'stroke-of-luck');
    naturalRoll = 20;
    roll.total = 20 + action.attackBonus! + buffBonus + targetAttackBonus;
    roll.modifier = action.attackBonus! + buffBonus + targetAttackBonus;
    attacker.stats.actionUsage['Stroke of Luck'] = (attacker.stats.actionUsage['Stroke of Luck'] || 0) + 1;
    pushLog(state, {
      round: state.round,
      turn: state.turnIndex,
      actor: attacker.displayName,
      action: 'Stroke of Luck',
      details: `${attacker.displayName} turns a missed ${action.name} attack roll into a 20.`,
      type: 'special',
    });
  }
  let combatProwessHit = false;
  const wouldMiss = naturalRoll === 1 || (naturalRoll < critThreshold && roll.total < ac);
  if (wouldMiss && canUseCombatProwess(attacker, action)) {
    attacker.turnFlags['combat-prowess-used'] = true;
    attacker.stats.actionUsage['Boon of Combat Prowess'] = (attacker.stats.actionUsage['Boon of Combat Prowess'] || 0) + 1;
    combatProwessHit = true;
    roll.total = Math.max(roll.total, ac);
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: attacker.displayName, action: 'Boon of Combat Prowess',
      details: `${attacker.displayName} turns a missed ${action.name} attack into a hit.`,
      type: 'special',
    });
  }

  const isCrit = naturalRoll >= critThreshold;
  const isFumble = naturalRoll === 1 && !combatProwessHit;
  const mirrorImage = target.activeBuffs?.find(buff => (buff.mirrorImages ?? 0) > 0);
  if (!isFumble && mirrorImage && !attacker.conditions.includes('blinded')) {
    const redirectThreshold = mirrorImage.mirrorImages === 3 ? 6 : mirrorImage.mirrorImages === 2 ? 8 : 11;
    if (rollD20().total >= redirectThreshold) {
      const duplicateAc = 10 + abilityModifier(target.monsterData.abilities.dex);
      const hitsDuplicate = isCrit || roll.total >= duplicateAc;
      if (hitsDuplicate) {
        mirrorImage.mirrorImages!--;
        if (mirrorImage.mirrorImages === 0) target.activeBuffs = target.activeBuffs.filter(buff => buff !== mirrorImage);
      }
      state.events.push({
        kind: 'attack', attackerId: attacker.id, targetId: target.id,
        actionName: action.name, attackType: action.type === 'ranged' ? 'ranged' : 'melee', durationMs: BASE_DURATIONS.attack,
      });
      pushLog(state, {
        round: state.round, turn: state.turnIndex, actor: attacker.displayName, action: action.name,
        details: hitsDuplicate
          ? `${attacker.displayName}'s ${action.name} destroys one of ${target.displayName}'s Mirror Image duplicates.`
          : `${attacker.displayName}'s ${action.name} misses one of ${target.displayName}'s Mirror Image duplicates.`,
        type: hitsDuplicate ? 'special' : 'miss',
      });
      return;
    }
  }
  const shielded = !isFumble && !isCrit && tryAutomaticShield(state, target, roll.total, naturalRoll, ac);

  // OA-tagged swings stretch attack/hit/miss durations and carry a
  // `cause: 'opportunity'` flag through to the replay layer so the grid
  // can paint the arc amber and float the REACTION! badge.
  const isOa = opts?.cause === 'opportunity';
  const attackDur = isOa ? OA_ATTACK_DURATIONS.attack : BASE_DURATIONS.attack;
  const hitDur = isOa ? OA_ATTACK_DURATIONS.hit : BASE_DURATIONS.hit;
  const missDur = isOa ? OA_ATTACK_DURATIONS.miss : BASE_DURATIONS.miss;

  // Push attack event
  state.events.push({
    kind: 'attack', attackerId: attacker.id, targetId: target.id,
    actionName: action.name, attackType: action.type === 'ranged' ? 'ranged' : 'melee',
    durationMs: attackDur,
    ...(isOa && { cause: 'opportunity' as const }),
  });

  if (vexBuffKeys.length > 0) {
    target.activeBuffs = target.activeBuffs.filter(b => !vexBuffKeys.includes(b.key));
  }
  if (guidingBuffKeys.length > 0) {
    target.activeBuffs = target.activeBuffs.filter(b => !guidingBuffKeys.includes(b.key));
  }
  if (sunderingBuffKeys.length > 0) {
    target.activeBuffs = target.activeBuffs.filter(b => !sunderingBuffKeys.includes(b.key));
  }
  if (sapBuffKeys.length > 0) {
    attacker.activeBuffs = attacker.activeBuffs.filter(b => !sapBuffKeys.includes(b.key));
  }

  if (isFumble) {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: attacker.displayName, action: action.name,
      details: `${attacker.displayName} attacks ${target.displayName} with ${action.name} - Natural 1! Miss!`,
      type: 'miss'
    });
    state.events.push({
      kind: 'miss', attackerId: attacker.id, targetId: target.id, durationMs: missDur,
      ...(isOa && { cause: 'opportunity' as const }),
    });
    applyWeaponMasteryOnMiss(state, attacker, target, action);
    tryApplyPotentCantripMiss(state, attacker, target, action);
    return;
  }

  if (!shielded && (isCrit || combatProwessHit || roll.total >= ac)) {
    attacker.stats.attacksHit++;
    const reactiveBuffsAtHit = (action.type === 'melee' || action.type === undefined)
      ? (target.activeBuffs ?? []).filter(buff => buff.reactiveDamage && (!buff.endsWhenTemporaryHpDepleted || (target.temporaryHp ?? 0) > 0))
      : [];
    let dealtActionDamage = false;
    const actionDamageSummary = emptyDamageSummary();
    // D&D 5e: attacks within 5ft of a paralyzed OR unconscious creature are auto-crits
    const autoCrit = action.damage ? (
      (target.conditions.includes('paralyzed') || target.conditions.includes('unconscious'))
      && action.type === 'melee'
    ) : false;

    if (action.damage) {
      const overchannelDamage = tryConsumeWizardOverchannel(state, attacker, action, action.damage);
      let totalDmg = applyDamageRollPenalty(attacker, overchannelDamage ?? rollDamage(action.damage, isCrit, action.rerollDamageOnes).total);
      if (overchannelDamage === null && hasOriginFeat(attacker, 'Savage Attacker') && !attacker.turnFlags.savageAttackerUsed && action.spellLevel === undefined && (action.type === 'melee' || action.type === 'ranged')) {
        totalDmg = Math.max(totalDmg, applyDamageRollPenalty(attacker, rollDamage(action.damage, isCrit, action.rerollDamageOnes).total));
        attacker.turnFlags.savageAttackerUsed = true;
      }
      const mainType = action.damageType || 'bludgeoning';
      const draconicBonus = draconicElementalAffinityBonus(attacker, action, mainType);
      if (draconicBonus > 0) {
        totalDmg += draconicBonus;
        attacker.stats.actionUsage['Elemental Affinity'] = (attacker.stats.actionUsage['Elemental Affinity'] || 0) + 1;
        pushLog(state, {
          round: state.round,
          turn: state.turnIndex,
          actor: attacker.displayName,
          action: 'Elemental Affinity',
          details: `${attacker.displayName}'s fire affinity adds ${draconicBonus} fire damage.`,
          damage: draconicBonus,
          type: 'damage',
        });
      }
      const evocationBonus = wizardEvocationBonus(attacker, action);
      if (evocationBonus > 0) totalDmg += evocationBonus;
      const rageBonus = getRageDamageBonus(attacker, action);
      if (rageBonus !== 0) totalDmg += rageBonus;

      // Brutal Strike (Barbarian L9+): forgo Reckless advantage for +1d10 damage
      if (usesBrutalStrike) {
        const brutalDmg = rollDice(brutalStrikeDamageDice(attacker)).total;
        totalDmg += brutalDmg;
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: attacker.displayName, action: 'Brutal Strike',
          details: `${attacker.displayName} channels a Brutal Strike for +${brutalDmg} damage!`,
          damage: brutalDmg, type: 'damage',
        });
        attacker.stats.actionUsage['Brutal Strike'] = (attacker.stats.actionUsage['Brutal Strike'] || 0) + 1;
        applyBrutalStrikeEffects(state, attacker, target);
      }

      if (isCrit) {
        const irresistibleOffense = hasIrresistibleOffense(attacker, mainType);
        if (irresistibleOffense && isPhysicalDamageType(mainType)) {
          const boonDamage = irresistibleOffenseAbilityScore(attacker);
          totalDmg += boonDamage;
          pushLog(state, {
            round: state.round, turn: state.turnIndex,
            actor: attacker.displayName, action: 'Irresistible Offense',
            details: `${attacker.displayName}'s epic boon adds ${boonDamage} ${mainType} damage on a critical hit.`,
            damage: boonDamage,
            type: 'critical',
          });
          attacker.stats.actionUsage['Irresistible Offense'] = (attacker.stats.actionUsage['Irresistible Offense'] || 0) + 1;
        }
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: attacker.displayName, action: 'CRITICAL HIT!',
          details: `${attacker.displayName} scores a CRITICAL HIT on ${target.displayName} with ${action.name}!`,
          type: 'critical'
        });
      }

      if (autoCrit && !isCrit) {
        const critDmg = rollDamage(action.damage, true, action.rerollDamageOnes);
        totalDmg = applyDamageRollPenalty(attacker, critDmg.total);
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: attacker.displayName, action: 'Auto-Critical!',
          details: `${target.displayName} is ${target.conditions.includes('paralyzed') ? 'Paralyzed' : 'Unconscious'} - melee hit is automatically a critical!`,
          type: 'critical'
        });
      }

      totalDmg = applyCuttingWordsToDamageRoll(state, attacker, target, totalDmg);
      const weaponMagic = action.spellLevel === undefined && attacker.activeBuffs?.some(buff => buff.weaponAttacksMagical) === true;
      const weaponDamageBonus = action.spellLevel === undefined
        ? attacker.activeBuffs?.reduce((sum, buff) => sum + (buff.weaponDamageBonus ?? 0), 0) ?? 0
        : 0;
      totalDmg += weaponDamageBonus;
      if (action.spellLevel === undefined) {
        const bonusDice = attacker.activeBuffs?.map(buff => buff.weaponDamageBonusDice).filter((dice): dice is string => Boolean(dice)) ?? [];
        const penaltyDice = attacker.activeBuffs?.map(buff => buff.weaponDamagePenaltyDice).filter((dice): dice is string => Boolean(dice)) ?? [];
        totalDmg = Math.max(1, totalDmg + bonusDice.reduce((sum, dice) => sum + rollDamage(dice, isCrit).total, 0) - penaltyDice.reduce((sum, dice) => sum + rollDamage(dice, false).total, 0));
      }

      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: action.name,
        details: `${attacker.displayName} hits ${target.displayName} with ${action.name} (${roll.total} vs AC ${ac}) for ${totalDmg} ${mainType} damage!`,
        damage: totalDmg,
        type: 'damage'
      });
      const hpBefore = target.currentHp;
      const targetWasBloodied = hpBefore > 0 && hpBefore <= Math.floor(target.maxHp / 2);
      const targetWasWounded = hpBefore > 0 && hpBefore < target.maxHp;
      const hitEvt = pushHitEvent(state, target.id, totalDmg, mainType, isCrit || autoCrit, hpBefore,
        { durationMs: hitDur, ...(isOa ? { cause: 'opportunity' as const } : {}) });

      const appliedMainDamage = applyDamage(state, target, totalDmg, mainType, attacker, true, (action.magical ?? false) || weaponMagic, isCrit || autoCrit);
      addDamageToSummary(actionDamageSummary, appliedMainDamage, mainType);
      dealtActionDamage = appliedMainDamage > 0;
      if (!target.isAlive) target.stats.killedByAction = action.name;
      hitEvt.targetHpAfter = target.currentHp;
      if (dealtActionDamage) tryRampage(state, attacker, target, action, targetWasBloodied);
      if (dealtActionDamage) applyColossusSlayer(state, attacker, target, action, targetWasWounded, isCrit || autoCrit);
    } else {
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: action.name,
        details: `${attacker.displayName} hits ${target.displayName} with ${action.name}! (${roll.total} vs AC ${ac})`,
        type: 'damage'
      });
      // Zero-damage "the swing connected" marker - no applyDamage, so
      // targetHpAfter stays at the current HP (no patch needed).
      pushHitEvent(state, target.id, 0, 'none', false, target.currentHp,
        { durationMs: hitDur, ...(isOa ? { cause: 'opportunity' as const } : {}) });
    }

    applyWeaponMasteryOnHit(state, attacker, target, action, dealtActionDamage);
    applyAttackHitBuff(state, attacker, target, action, dealtActionDamage);
    if (dealtActionDamage) {
      applyOpenHandTechnique(state, attacker, target);
      seedQuiveringPalm(state, attacker, target, action);
    }

    // Divine Smite
    if (action.smiteOnHit && attacker.monsterData.isHero && target.isAlive) {
      let slotLevel = lowestAvailableSlot(attacker);
      let usedFreeSmite = false;
      if (hasResource(attacker, 'free-divine-smite')) {
        consumeResource(attacker, 'free-divine-smite');
        slotLevel = 1;
        usedFreeSmite = true;
      } else if (slotLevel !== null) {
        consumeResource(attacker, `slot-${slotLevel}`);
      }
      if (slotLevel !== null) {
        const diceCount = action.smiteOnHit.dicePerSlotLevel[slotLevel - 1]
          ?? action.smiteOnHit.dicePerSlotLevel[0];
        const smiteExpr = `${diceCount}d${action.smiteOnHit.die}`;
        const smite = rollDamage(smiteExpr, isCrit);
        smite.total = applyDamageRollPenalty(attacker, smite.total);
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: attacker.displayName, action: 'Divine Smite',
          details: `${attacker.displayName} smites for ${smite.total} ${action.smiteOnHit.damageType} damage (${usedFreeSmite ? 'free use' : `slot-${slotLevel}`})!`,
          damage: smite.total, type: 'damage',
        });
        const beforeHp = target.currentHp;
        const ev = pushHitEvent(state, target.id, smite.total, action.smiteOnHit.damageType, false, beforeHp);
        applyDamage(state, target, smite.total, action.smiteOnHit.damageType, attacker, true, true, isCrit);
        ev.targetHpAfter = target.currentHp;
        applySmiteOfProtection(state, attacker);
      }
    }

    // Buff-sourced damage riders (Hex, Hunter's Mark)
    for (const b of target.activeBuffs ?? []) {
      if (!b.damageRider || b.casterId !== attacker.id || !target.isAlive) continue;
      if (b.conditionalRider === 'targetNotFullHp' && target.currentHp >= target.maxHp) continue;
      const parts = b.damageRider.split(' ');
      const diceExpr = parts[0];
      const type = parts.slice(1).join(' ') || 'untyped';
      const rider = rollDamage(diceExpr, isCrit);
      rider.total = applyDamageRollPenalty(attacker, rider.total);
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: b.name,
        details: `${b.name} adds ${rider.total} ${type} damage.`,
        damage: rider.total, type: 'damage',
      });
      const beforeHp = target.currentHp;
      const ev = pushHitEvent(state, target.id, rider.total, type, false, beforeHp);
      // Damage riders from spells (Hex, Hunter's Mark) are magical.
      applyDamage(state, target, rider.total, type, attacker, true, true, isCrit);
      ev.targetHpAfter = target.currentHp;
      applySuperiorHuntersPrey(state, attacker, target, b);
      if (b.endsOnWeaponHit) dropConcentratedBuffsFrom(state, attacker.id);
    }

    // Caster-sourced next-hit riders (Blinding Smite and similar effects).
    for (const b of [...(attacker.activeBuffs ?? [])]) {
      if (!b.weaponDamageRider || !target.isAlive) continue;
      const parts = b.weaponDamageRider.split(' ');
      const diceExpr = parts[0];
      const type = parts.slice(1).join(' ') || 'untyped';
      const rider = rollDamage(diceExpr, isCrit);
      rider.total = applyDamageRollPenalty(attacker, rider.total);
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: b.name,
        details: `${b.name} adds ${rider.total} ${type} damage.`, damage: rider.total, type: 'damage',
      });
      const beforeHp = target.currentHp;
      const ev = pushHitEvent(state, target.id, rider.total, type, false, beforeHp);
      applyDamage(state, target, rider.total, type, attacker, true, true, isCrit);
      ev.targetHpAfter = target.currentHp;
      if (b.weaponConditionOnHit && target.isAlive) {
        const save = b.weaponConditionOnHit.save;
        if (!save || rollSaveWithBuffs(target, getEffectiveSaveModifier(target, save.ability, state), false, save.dc, save.ability, b.weaponConditionOnHit.condition).total < save.dc) {
          applyCondition(state, target, b.weaponConditionOnHit.condition, attacker, b.weaponConditionOnHit.duration);
        }
      }
      if (b.endsOnWeaponHit) dropConcentratedBuffsFrom(state, attacker.id);
    }

    // Sneak Attack / additional damage
    const isRogueSneak = attacker.monsterData.isHero &&
      attacker.monsterData.heroClass === 'Rogue' &&
      !!action.additionalDamage;
    const skipAdditionalDamage = isRogueSneak && !canUseSneakAttack(
      state,
      attacker,
      target,
      action,
      effectiveAdv,
      attackHasDisadvantage,
    );

    if (action.additionalDamage && target.isAlive && !skipAdditionalDamage) {
      if (isRogueSneak) {
        if (!attacker.turnFlags) attacker.turnFlags = {};
        attacker.turnFlags['sneak-attack-used'] = true;
      }
      const parts = action.additionalDamage.split(' ');
      let addDmgExpr = parts[0];
      const addDmgType = parts.slice(1).join(' ') || 'untyped';
      let cunningStrikes: RogueCunningStrikeChoice[] = [];
      if (isRogueSneak) {
        const sneakDice = parseSneakAttackDice(action.additionalDamage);
        cunningStrikes = chooseRogueCunningStrikes(attacker, target, sneakDice);
        const spentDice = cunningStrikes.reduce((sum, choice) => sum + choice.costDice, 0);
        if (spentDice > 0) {
          addDmgExpr = `${Math.max(0, sneakDice - spentDice)}d6`;
        }
      }
      const addDmg = rollDamage(addDmgExpr, isCrit || autoCrit);
      addDmg.total = applyDamageRollPenalty(attacker, addDmg.total);

      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: attacker.displayName, action: action.name,
        details: `Plus ${addDmg.total} ${addDmgType} damage!`,
        damage: addDmg.total,
        type: 'damage'
      });

      const addHpBefore = target.currentHp;
      const addHitEvt = pushHitEvent(state, target.id, addDmg.total, addDmgType, isCrit || autoCrit, addHpBefore);
      const appliedAdditionalDamage = applyDamage(state, target, addDmg.total, addDmgType, attacker, true, action.magical ?? false, isCrit || autoCrit);
      addDamageToSummary(actionDamageSummary, appliedAdditionalDamage, addDmgType);
      addHitEvt.targetHpAfter = target.currentHp;
      applyRogueCunningStrikes(state, attacker, target, cunningStrikes);
    }

    tryHurlThroughHell(state, attacker, target, action);

    pullTargetTowardAttackerOnHit(state, attacker, target, action);

    // Life drain: Vampire Bite heals attacker for necrotic damage dealt.
    // Route through applyHealing so HP writes stay centralised (matches
    // the "applyDamage is the only HP subtractor" invariant on the
    // healing side).
    if (action.additionalDamage?.includes('necrotic') && action.description.includes('regains Hit Points equal')) {
      const parts = action.additionalDamage.split(' ');
      const drainAmount = applyDamageRollPenalty(attacker, rollDamage(parts[0], isCrit || autoCrit).total);
      applyHealing(state, attacker, drainAmount, attacker, 'Life Drain');
    }

    // Condition on hit (e.g., Wolf bite → Prone, Ghoul claws → Paralyzed, Roper Tentacle → Grappled)
    resolveConditionOnHit(state, attacker, target, action);
    applyActionRuntimeEffects(state, attacker, target, action, actionDamageSummary);

    // Stunning Strike (Monk L5+): once per turn on a Monk weapon or
    // Unarmed Strike hit, spend 1 Focus Point. Failed save stuns; success
    // halves speed and gives the next attack against the target Advantage.
    if (attacker.monsterData.heroClass === 'Monk' && (attacker.monsterData.heroLevel ?? 0) >= 5
        && isMonkWeaponOrUnarmed(action) && target.isAlive && hasResource(attacker, 'ki')
        && !target.conditions.includes('stunned') && !attacker.turnFlags?.['stunning-strike-used']) {
      if (!attacker.turnFlags) attacker.turnFlags = {};
      attacker.turnFlags['stunning-strike-used'] = true;
      consumeResource(attacker, 'ki');
      const wisMod = abilityModifier(getEffectiveAbilityScore(attacker, 'wis'));
      const dc = 8 + attacker.monsterData.proficiencyBonus + wisMod;
      const conMod = getEffectiveSaveModifier(target, 'con', state);
      const save = rollSaveWithBuffs(target, conMod, false, undefined, 'con');
      state.events.push({ kind: 'save', targetId: target.id, success: save.total >= dc, durationMs: BASE_DURATIONS.save });
      if (save.total < dc) {
        applyCondition(state, target, 'stunned', attacker, 'end_of_next_turn', dc, 'con');
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: attacker.displayName, action: 'Stunning Strike',
          details: `${target.displayName} is stunned! (CON save ${save.total} vs DC ${dc})`,
          type: 'condition'
        });
      } else {
        const keyBase = `stunning-strike-success:${attacker.id}:${target.id}`;
        target.activeBuffs = (target.activeBuffs ?? []).filter(b => !b.key.startsWith(keyBase));
        target.activeBuffs.push({
          name: 'Stunning Strike Slow',
          key: `${keyBase}:slow`,
          casterId: attacker.id,
          appliedRound: state.round,
          endRound: state.round + 2,
          speedPenalty: Math.max(5, Math.floor((target.monsterData.speed.walk ?? 30) / 2)),
          expiresOnSourceTurnStart: true,
        });
        target.activeBuffs.push({
          name: 'Stunning Strike Opening',
          key: `${keyBase}:opening`,
          casterId: attacker.id,
          appliedRound: state.round,
          endRound: state.round + 2,
          advantageForAllAttackers: true,
        });
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: target.displayName, action: 'Save',
          details: `${target.displayName} resists Stunning Strike (${save.total} vs DC ${dc}) but is slowed and left open to the next attack.`,
          type: 'save'
        });
      }
      attacker.stats.actionUsage['Stunning Strike'] = (attacker.stats.actionUsage['Stunning Strike'] || 0) + 1;
    }

    // Fire Shield (and similar reactive damage buffs): when hit by a melee
    // attack, the attacker takes damage from the target's reactive buff.
    if (reactiveBuffsAtHit.length && attacker.isAlive) {
      for (const b of reactiveBuffsAtHit) {
        const parts = b.reactiveDamage!.split(' ');
        const diceExpr = parts[0];
        const dmgType = parts.slice(1).join(' ') || 'fire';
        const reactiveDmg = applyDamageRollPenalty(target, rollDamage(diceExpr, false).total);
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: target.displayName, action: b.name,
          details: `${target.displayName}'s ${b.name} burns ${attacker.displayName} for ${reactiveDmg} ${dmgType} damage!`,
          damage: reactiveDmg, type: 'damage',
        });
        const beforeHp = attacker.currentHp;
        const ev = pushHitEvent(state, attacker.id, reactiveDmg, dmgType, false, beforeHp);
        // Reactive damage from buffs (Fire Shield etc.) is magical.
        // Fire Shield etc. - reactive damage isn't an attack, can't crit.
        applyDamage(state, attacker, reactiveDmg, dmgType, target, false, true, false);
        ev.targetHpAfter = attacker.currentHp;
      }
    }
  } else {
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: attacker.displayName, action: action.name,
      details: `${attacker.displayName} attacks ${target.displayName} with ${action.name} (${roll.total} vs AC ${ac}) - Miss!`,
      type: 'miss'
    });
    state.events.push({ kind: 'miss', attackerId: attacker.id, targetId: target.id, durationMs: BASE_DURATIONS.miss });
    applyWeaponMasteryOnMiss(state, attacker, target, action);
    grantStudiedAttacksAdvantage(state, attacker, target, action);
    tryApplyPotentCantripMiss(state, attacker, target, action);
  }
}

// Single-target save resolution + AoE resolution + AoE target picking
// (getSingleTargetVisual, resolveSingleTargetSave, resolveAoE,
// bestDirectionalTargets, getAoETargets) live in ./combat-aoe.



function processRegeneration(state: BattleState, creature: Creature): void {
  const regeneration = getRegenerationRuntime(creature);
  if (!regeneration || !creature.isAlive) return;
  if (regeneration.profile === 'atLeastOneHp' && creature.currentHp <= 0) return;

  // Check if regeneration is suppressed (took acid/fire damage last turn)
  if (creature.recharges['regenSuppressed']) {
    creature.recharges['regenSuppressed'] = false;
    return;
  }

  if (creature.currentHp < creature.maxHp) {
    const healHpBefore = creature.currentHp;
    const healed = gainHp(creature, regeneration.amount);
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: 'Regeneration',
      details: `${creature.displayName} regenerates ${healed} HP! (${creature.currentHp}/${creature.maxHp})`,
      type: 'heal'
    });
    pushEffectEvent(state, creature.id, 'Regeneration', 'success');
    state.events.push({ kind: 'heal', creatureId: creature.id, amount: healed, creatureHpBefore: healHpBefore, creatureHpAfter: creature.currentHp, durationMs: BASE_DURATIONS.heal });
  }
}

function processRecharges(creature: Creature): void {
  const actions = creature.wildShape?.actions ?? creature.monsterData.actions;
  for (const action of actions) {
    if (action.recharge && creature.recharges[action.name] === false) {
      // "5-6" -> [5, 6]; "6" -> [6]. Respect both ends so a bounded range
      // like "3-5" doesn't accidentally accept a 6, which the one-sided
      // `roll >= min` form used to do.
      const [min, max = min] = action.recharge.split('-').map(Number);
      const roll = Math.floor(engineRandom() * 6) + 1;
      if (roll >= min && roll <= max) {
        creature.recharges[action.name] = true;
      }
    }
  }
}

function checkBattleComplete(state: BattleState): void {
  // Battle ends when one (or both) sides have no RECOVERABLE creatures
  // left. Recoverable = standing or still-rolling-death-saves. A team
  // whose last hero just went Downed isn't out yet - the hero might pop
  // up at 1 HP on a nat 20 or stabilise out, and we want the user to see
  // that loop play out. The team only truly loses when everyone is dead
  // or unconscious-stabilised with no path back.
  const standingRed = getRecoverableCreatures(state, 'red');
  const standingBlue = getRecoverableCreatures(state, 'blue');

  if (standingRed.length === 0 && standingBlue.length === 0) {
    state.isComplete = true;
    state.winner = 'draw';
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: 'System', action: 'Battle Over',
      details: 'Both sides are out of the fight - draw!',
      type: 'info'
    });
  } else if (standingRed.length === 0) {
    state.isComplete = true;
    state.winner = 'blue';
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: 'System', action: 'Battle Over',
      details: `Blue team wins in ${state.round} rounds!`,
      type: 'info'
    });
  } else if (standingBlue.length === 0) {
    state.isComplete = true;
    state.winner = 'red';
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: 'System', action: 'Battle Over',
      details: `Red team wins in ${state.round} rounds!`,
      type: 'info'
    });
  }

  // Safety: end after 100 rounds
  if (state.round > 100) {
    state.isComplete = true;
    const redHp = standingRed.reduce((sum, c) => sum + c.currentHp, 0);
    const blueHp = standingBlue.reduce((sum, c) => sum + c.currentHp, 0);
    state.winner = redHp > blueHp ? 'red' : blueHp > redHp ? 'blue' : 'draw';
    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: 'System', action: 'Battle Over',
      details: `Battle reached 100 rounds! ${state.winner === 'draw' ? 'Draw' : `${state.winner} team wins`} by HP remaining.`,
      type: 'info'
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Hero spell + ability execution lives in ./combat-spellcasting
// (applyHealing, applyAutoDarts, applyBuffFromSpell, executeSpell).
// ═══════════════════════════════════════════════════════════════════════════

// Hero resource + buff machinery (hasResource, consumeResource, restoreResource,
// lowestAvailableSlot, highestAvailableSlot, hasBuff, getBuff, addBuff,
// removeBuff, dropConcentratedBuffsFrom, expireBuffsForCreature,
// resetTurnFlags) plus the concentration-aura helpers (attachConcentrationAura,
// processConcentrationAuras, checkAuraEntry) live in ./combat-buffs.

export { distance, getFootprintSize, creatureDistance, isPositionBlocked, canHalflingPassThrough, getEnemies, getAllies, getAliveCreatures, getStandingCreatures, getRecoverableCreatures, getCreatureById, resolveAttack, isInMeleeRange, applyDamage, applyCondition, resolveConditionOnHit, processRegeneration, processRecharges, checkBattleComplete, hasAdvantage, hasDisadvantage, isInCone, isInLine, runDeathSave, stabiliseDyingAlly, revertWildShape, hasThiefsReflexes };
// AoE resolution lives in ./combat-aoe; re-export so external imports work.
export {
  getSingleTargetVisual, resolveSingleTargetSave,
  resolveAoE, bestDirectionalTargets, getAoETargets, pickRangedSphereCenter,
} from './combat-aoe.js';
// Spellcasting lives in ./combat-spellcasting; re-export the same way.
export {
  applyHealing, applyTemporaryHp, applyAutoDarts, applyBuffFromSpell, executeSpell, tryUseBonusActionDamageBuff, useSpiritualWeaponAttack,
} from './combat-spellcasting.js';
// Buff / resource / concentration-aura helpers live in ./combat-buffs;
// re-export them here so external `from './combat.js'` imports keep working.
export {
  rollAttackBuffBonus, rollSaveBuffBonus, getRageDamageBonus, getSpellSaveDcBonus,
  rollSaveWithBuffs, applyBuffDamageResistance, applyDamageRollPenalty,
  hasResource, consumeResource, restoreResource,
  lowestAvailableSlot, highestAvailableSlot,
  hasBuff, getBuff, addBuff, removeBuff, removeActiveBuff,
  dropConcentratedBuffsFrom, expireBuffsForCreature, expireSourceTurnBuffs, resetTurnFlags,
  attachConcentrationAura, processConcentrationAuras, checkAuraEntry, moveConcentrationAura,
} from './combat-buffs.js';
export type { AnimationEvent } from '../types/animation.js';
