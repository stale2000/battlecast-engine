import type { OriginArenaAction } from './arena-origin-actions.js';

export type ClassFeatureArenaAction =
  | { id: 'class_feature:action_surge'; type: 'action_surge' }
  | { id: 'class_feature:steady_aim'; type: 'steady_aim' };

/**
 * Wire-safe, server-generated arena choices. Semantic parameters are included
 * only where the engine will validate and consume them.
 */
export type ArenaAction =
  | { id: string; type: 'attack'; actionName: string; actionIndex: number; targetId: string }
  | { id: string; type: 'spell'; actionName: string; actionIndex: number; targetId: string; targetIds?: string[]; center?: { x: number; y: number }; areaShape?: string }
  | { id: 'dash' | 'bonus_dash'; type: 'dash'; isBonusAction: boolean }
  | { id: 'dodge'; type: 'dodge' }
  | { id: 'disengage' | 'bonus_disengage'; type: 'disengage'; isBonusAction: boolean }
  | { id: string; type: 'help'; targetId: string }
  | ClassFeatureArenaAction
  | OriginArenaAction
  | { id: string; type: 'wild_shape'; beastName: string }
  | { id: string; type: 'monk_strike'; actionIndex: number; targetId: string; flurry: boolean }
  | { id: 'move_to'; type: 'move_to'; destination?: { x: number; y: number } }
  | { id: 'end_turn'; type: 'end_turn' };

/** Exact structural equality prevents clients from smuggling target or cost changes. */
export function sameArenaAction(left: ArenaAction, right: ArenaAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
