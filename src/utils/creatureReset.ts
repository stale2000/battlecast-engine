import { Creature, CreatureStats } from '../types/monster.js';

export function freshCreatureStats(): CreatureStats {
  return {
    damageDealt: 0,
    damageTaken: 0,
    attacksMade: 0,
    attacksHit: 0,
    killCount: 0,
    roundsSurvived: 0,
    actionUsage: {},
  };
}

export function resetCreatureForBattle(
  creature: Creature,
  position: { x: number; y: number } = creature.position,
): Creature {
  const flySpeed = creature.monsterData.speed.fly ?? 0;
  return {
    ...creature,
    position: { x: position.x, y: position.y },
    currentHp: creature.maxHp,
    isAlive: true,
    hasActed: false,
    hasMovedThisTurn: false,
    movementRemaining: Math.max(creature.monsterData.speed.walk, flySpeed),
    legendaryActionsRemaining: creature.monsterData.legendaryActionUses,
    conditions: [],
    conditionTimers: [],
    recharges: {},
    resources: { ...(creature.monsterData.initialResources || {}) },
    activeBuffs: [],
    turnFlags: {},
    airborne: flySpeed > 0,
    reactionUsed: false,
    bonusActionUsed: false,
    concentrationAura: undefined,
    concentratingOn: undefined,
    wildShape: undefined,
    swallowedTargetId: undefined,
    swallowedBy: undefined,
    _wildShapeBeast: undefined,
    _concentrationAura: undefined,
    dying: false,
    deathSaves: undefined,
    stats: freshCreatureStats(),
  };
}

export function resetCreatureForBattleInPlace(
  creature: Creature,
  position: { x: number; y: number } = creature.position,
): void {
  Object.assign(creature, resetCreatureForBattle(creature, position));
}
