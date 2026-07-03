import { Condition } from './monster.js';

export type AnimationEvent =
  | { kind: 'move'; creatureId: string; from: { x: number; y: number }; to: { x: number; y: number }; path?: { x: number; y: number }[]; durationMs: number }
  | { kind: 'attack'; attackerId: string; targetId: string; actionName: string; attackType: 'melee' | 'ranged' | 'aoe' | 'beam' | 'psychic' | 'grapple' | 'touch'; durationMs: number; cause?: 'opportunity' }
  | { kind: 'hit'; targetId: string; damage: number; damageType: string; critical: boolean; targetHpBefore: number; targetHpAfter: number; durationMs: number; cause?: 'opportunity' }
  | { kind: 'miss'; attackerId: string; targetId: string; durationMs: number; cause?: 'opportunity' }
  | { kind: 'save'; targetId: string; success: boolean; durationMs: number }
  | { kind: 'aoeDamage'; targets: AoEDamageTarget[]; durationMs: number }
  | { kind: 'aoe'; attackerId: string; center: { x: number; y: number }; radius: number; shape: 'sphere' | 'cone' | 'line' | 'cylinder'; direction?: { x: number; y: number }; durationMs: number; spellName?: string; damageType?: string }
  | { kind: 'death'; creatureId: string; durationMs: number }
  | { kind: 'deaths'; creatureIds: string[]; durationMs: number }
  | { kind: 'heal'; creatureId: string; amount: number; creatureHpBefore: number; creatureHpAfter: number; durationMs: number }
  | { kind: 'condition'; creatureId: string; condition: Condition; applied: boolean; durationMs: number }
  | { kind: 'conditionBatch'; conditions: Array<{ creatureId: string; condition: Condition; applied: boolean }>; durationMs: number }
  | { kind: 'turnStart'; creatureId: string; durationMs: number }
  | { kind: 'roundStart'; round: number; durationMs: number }
  | { kind: 'message'; text: string; durationMs: number }
  | { kind: 'effect'; creatureId: string; label: string; durationMs: number; tone?: 'default' | 'danger' | 'success' | 'arcane' }
  | { kind: 'wildShape'; creatureId: string; beastName: string | null; durationMs: number }
  | { kind: 'concentrationAura'; creatureId: string; active: boolean; spellName: string; damageType: string; radiusFt: number; origin: 'caster' | 'point'; point?: { x: number; y: number }; durationMs: number }
  | { kind: 'downed'; creatureId: string; durationMs: number }
  | { kind: 'deathSave'; creatureId: string; roll: number; outcome: 'success' | 'failure' | 'critFail' | 'popUp' | 'stabilised' | 'died'; successesAfter: number; failuresAfter: number; durationMs: number }
  | { kind: 'deathSaveFail'; creatureId: string; failuresAfter: number; fromMeleeAdj: boolean; durationMs: number }
  | { kind: 'stabilise'; creatureId: string; hpAfter: number; durationMs: number }
  | { kind: 'stabiliseAlly'; actorId: string; creatureId: string; durationMs: number }
  | { kind: 'oaAvoided'; moverId: string; enemyId: string; reason: OaAvoidedReason; durationMs: number };

/**
 * Why an opportunity attack that the geometry *would* have triggered did not
 * fire. Drives the on-grid "OA AVOIDED" badge and the reaction log entry
 * styling. Values are deliberately short - one-word labels render directly
 * over the relevant token.
 */
export type OaAvoidedReason =
  | 'disengage'      // mover took the Disengage action (action economy)
  | 'cunning'        // Rogue Cunning Action: Disengage (bonus action)
  | 'nimble'         // Nimble Escape: Disengage (Goblins etc., bonus action)
  | 'flying'         // mover is airborne, grounded enemy can't reach
  | 'reactionUsed'   // enemy already spent its reaction this round
  | 'stunned'        // enemy is stunned/paralyzed/incapacitated/unconscious
  ;

export interface AoEDamageTarget {
  targetId: string;
  saveSuccess?: boolean;
  damage?: number;
  damageType?: string;
  critical?: boolean;
  targetHpBefore?: number;
  targetHpAfter?: number;
}

export const BASE_DURATIONS: Record<AnimationEvent['kind'], number> = {
  move: 400,
  attack: 350,
  hit: 600,
  miss: 400,
  save: 500,
  aoeDamage: 700,
  aoe: 700,
  death: 700,
  deaths: 700,
  heal: 500,
  condition: 400,
  conditionBatch: 400,
  turnStart: 150,
  roundStart: 800,
  message: 0,
  effect: 650,
  wildShape: 0,
  concentrationAura: 0,
  downed: 800,
  deathSave: 700,
  deathSaveFail: 400,
  stabilise: 600,
  stabiliseAlly: 600,
  oaAvoided: 800,
};

/**
 * When a swing is tagged as `cause: 'opportunity'`, the engine emits
 * attack/hit/miss with these stretched durations instead of BASE_DURATIONS.
 * Tuned to stay unmissable even at 2x / 5x watch speed: at 1x a normal
 * attack runs ~1s, an OA runs ~3s; at 5x they're ~200ms vs ~600ms - still
 * a clear 3x feel difference.
 */
export const OA_ATTACK_DURATIONS = {
  attack: 1500,
  hit: 1500,
  miss: 1200,
} as const;
