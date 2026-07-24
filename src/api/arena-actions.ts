import type { GoliathAttackFeature, OriginArenaAction } from './arena-origin-actions.js';

export type ClassFeatureArenaAction =
  | { id: 'class_feature:action_surge'; type: 'action_surge' }
  | { id: 'class_feature:steady_aim'; type: 'steady_aim' };

/**
 * Wire-safe, server-generated arena choices. Semantic parameters are included
 * only where the engine will validate and consume them.
 */
export type ArenaAction =
  | { id: string; type: 'attack'; actionName: string; actionIndex: number; targetId: string; goliathFeature?: GoliathAttackFeature; hasteAction?: boolean }
  | { id: string; type: 'spell'; actionName: string; actionIndex: number; targetId: string; targetIds?: string[]; center?: { x: number; y: number }; areaShape?: string; effectKey?: string; damageResistance?: string; damageType?: string; sizeChange?: 'enlarge' | 'reduce'; curseChoice?: 'ability_str' | 'ability_dex' | 'ability_con' | 'ability_int' | 'ability_wis' | 'ability_cha' | 'attack_disadvantage' | 'forced_dodge' | 'damage_rider' }
  | { id: string; type: 'spell_teleport'; actionName: string; actionIndex: number; destination?: { x: number; y: number } }
  | { id: string; type: 'spell_summon'; actionName: string; actionIndex: number; variantKey: string; destination?: { x: number; y: number } }
  | { id: string; type: 'repeat_spell'; buffKey: string; targetId: string }
  | { id: string; type: 'spiritual_weapon'; targetId: string }
  | { id: string; type: 'repeat_area_spell'; spellName: string; targetId: string; targetIds: string[]; center?: { x: number; y: number }; areaShape?: string }
  | { id: string; type: 'repeat_action_spell'; spellName: string; targetId: string }
  | { id: 'move_aura'; type: 'move_aura'; destination?: { x: number; y: number } }
  | { id: 'dash' | 'bonus_dash' | 'haste_dash' | 'spell_bonus_dash'; type: 'dash'; isBonusAction: boolean; hasteAction?: boolean }
  | { id: 'dodge'; type: 'dodge' }
  | { id: 'disengage' | 'bonus_disengage' | 'haste_disengage'; type: 'disengage'; isBonusAction: boolean; hasteAction?: boolean }
  | { id: 'hide' | 'bonus_hide' | 'haste_hide'; type: 'hide'; isBonusAction: boolean; hasteAction?: boolean }
  | { id: string; type: 'escape_grapple'; sourceId: string; ability: 'str' | 'dex' }
  | { id: string; type: 'escape_condition'; buffKey: string }
  | { id: string; type: 'help'; targetId: string }
  | { id: string; type: 'healer_battle_medic'; targetId: string }
  | { id: string; type: 'mount'; mountId: string }
  | { id: string; type: 'dismount'; mountId: string; destination: { x: number; y: number } }
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
