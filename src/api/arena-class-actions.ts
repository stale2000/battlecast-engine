import { consumeResource, pushLog } from '../engine/combat.js';
import type { BattleState } from '../engine/combat.js';
import type { Creature } from '../types/monster.js';
import type { ClassFeatureArenaAction } from './arena-actions.js';

/** Class features with fully implemented player-controlled effects. */
export function getClassFeatureLegalActions(active: Creature): ClassFeatureArenaAction[] {
  const actions: ClassFeatureArenaAction[] = [];
  if (active.monsterData.heroClass === 'Fighter' && active.hasActed && !active.turnFlags.arenaActionSurge && active.resources['action-surge'] > 0) {
    actions.push({ id: 'class_feature:action_surge', type: 'action_surge' });
  }
  if (active.monsterData.heroClass === 'Rogue' && !active.bonusActionUsed && !active.hasMovedThisTurn && !active.turnFlags.steadyAim) {
    actions.push({ id: 'class_feature:steady_aim', type: 'steady_aim' });
  }
  return actions;
}

/** Applies an already-catalogued class feature and owns every mutation it makes. */
export function applyClassFeatureLegalAction(state: BattleState, active: Creature, action: ClassFeatureArenaAction): void {
  if (action.type === 'action_surge') {
    if (!active.hasActed || active.turnFlags.arenaActionSurge || !consumeResource(active, 'action-surge')) {
      throw new Error('Illegal or stale arena Action Surge.');
    }
    active.turnFlags.arenaActionSurge = true;
    for (const key of Object.keys(active.turnFlags)) if (key.startsWith('arena-attack-')) delete active.turnFlags[key];
    active.hasActed = false;
    pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Action Surge', details: `${active.displayName} gains another action.`, type: 'special' });
    return;
  }
  if (active.monsterData.heroClass !== 'Rogue' || active.bonusActionUsed || active.hasMovedThisTurn || active.turnFlags.steadyAim) {
    throw new Error('Illegal or stale arena Steady Aim.');
  }
  active.turnFlags.steadyAim = true;
  active.bonusActionUsed = true;
  active.movementRemaining = 0;
  pushLog(state, { round: state.round, turn: state.turnIndex, actor: active.displayName, action: 'Steady Aim', details: `${active.displayName} gains advantage on their next attack.`, type: 'special' });
}
