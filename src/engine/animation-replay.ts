import { Creature } from '../types/monster.js';
import { AnimationEvent } from '../types/animation.js';

/**
 * Deep-ish clone for replay - copies position, currentHp, isAlive, conditions.
 * monsterData is shared (read-only during replay).
 */
export function cloneCreatureForReplay(c: Creature): Creature {
  return {
    ...c,
    position: { ...c.position },
    conditions: [...c.conditions],
    conditionTimers: c.conditionTimers.map(t => ({ ...t })),
    stats: { ...c.stats },
    recharges: { ...c.recharges },
    deathSaves: c.deathSaves ? { ...c.deathSaves } : undefined,
  };
}

export function snapshotCreatures(creatures: Creature[]): Creature[] {
  return creatures.map(cloneCreatureForReplay);
}

/**
 * Apply a completed event to the replay state (mutates in place for perf).
 * Called after an event's animation finishes, before advancing the cursor.
 */
export function applyEventToReplay(state: Creature[], evt: AnimationEvent): void {
  switch (evt.kind) {
    case 'move': {
      const c = state.find(x => x.id === evt.creatureId);
      if (c) c.position = { ...evt.to };
      return;
    }
    case 'hit': {
      const c = state.find(x => x.id === evt.targetId);
      if (!c) return;
      // Only the dedicated `death` / `downed` events should change
      // life-state flags. A hit on a dying hero (HP already 0) leaves
      // targetHpAfter at 0 - flipping isAlive here would falsely "kill"
      // them in the replay even though the engine kept them in Downed.
      // Trust the engine: it pushes a death event when this hit actually
      // killed; we just write the HP number through.
      c.currentHp = Math.max(0, evt.targetHpAfter);
      return;
    }
    case 'aoeDamage': {
      for (const target of evt.targets) {
        if (target.targetHpAfter === undefined) continue;
        const c = state.find(x => x.id === target.targetId);
        if (c) c.currentHp = Math.max(0, target.targetHpAfter);
      }
      return;
    }
    case 'heal': {
      const c = state.find(x => x.id === evt.creatureId);
      if (c) c.currentHp = evt.creatureHpAfter;
      return;
    }
    case 'death': {
      const c = state.find(x => x.id === evt.creatureId);
      if (c) {
        c.isAlive = false;
        c.currentHp = 0;
        c.dying = false;
        c.deathSaves = undefined;
      }
      return;
    }
    case 'deaths': {
      const ids = new Set(evt.creatureIds);
      for (const c of state) {
        if (!ids.has(c.id)) continue;
        c.isAlive = false;
        c.currentHp = 0;
        c.dying = false;
        c.deathSaves = undefined;
      }
      return;
    }
    case 'downed': {
      const c = state.find(x => x.id === evt.creatureId);
      if (!c) return;
      c.currentHp = 0;
      c.dying = true;
      c.deathSaves = { successes: 0, failures: 0 };
      if (!c.conditions.includes('unconscious')) c.conditions.push('unconscious');
      return;
    }
    case 'deathSave': {
      const c = state.find(x => x.id === evt.creatureId);
      if (!c) return;
      if (evt.outcome === 'popUp') {
        c.dying = false;
        c.deathSaves = undefined;
        c.currentHp = 1;
        c.conditions = c.conditions.filter(x => x !== 'unconscious');
      } else if (evt.outcome === 'died') {
        c.isAlive = false;
        c.dying = false;
        c.deathSaves = undefined;
        c.currentHp = 0;
      } else if (evt.outcome === 'stabilised') {
        c.dying = false;
        c.deathSaves = undefined;
      } else {
        c.deathSaves = {
          successes: evt.successesAfter,
          failures: evt.failuresAfter,
        };
      }
      return;
    }
    case 'deathSaveFail': {
      const c = state.find(x => x.id === evt.creatureId);
      if (!c) return;
      if (c.deathSaves) {
        c.deathSaves.failures = evt.failuresAfter;
      } else {
        c.deathSaves = { successes: 0, failures: evt.failuresAfter };
      }
      return;
    }
    case 'stabilise': {
      const c = state.find(x => x.id === evt.creatureId);
      if (!c) return;
      c.dying = false;
      c.deathSaves = undefined;
      c.currentHp = evt.hpAfter;
      c.conditions = c.conditions.filter(x => x !== 'unconscious');
      return;
    }
    case 'stabiliseAlly': {
      const c = state.find(x => x.id === evt.creatureId);
      if (!c) return;
      c.isAlive = true;
      c.dying = false;
      c.deathSaves = undefined;
      c.currentHp = 0;
      if (!c.conditions.includes('unconscious')) c.conditions.push('unconscious');
      return;
    }
    case 'condition': {
      const c = state.find(x => x.id === evt.creatureId);
      if (!c) return;
      if (evt.applied) {
        if (!c.conditions.includes(evt.condition)) {
          c.conditions.push(evt.condition);
        }
      } else {
        c.conditions = c.conditions.filter(x => x !== evt.condition);
      }
      return;
    }
    case 'conditionBatch': {
      for (const appliedCondition of evt.conditions) {
        const c = state.find(x => x.id === appliedCondition.creatureId);
        if (!c) continue;
        if (appliedCondition.applied) {
          if (!c.conditions.includes(appliedCondition.condition)) {
            c.conditions.push(appliedCondition.condition);
          }
        } else {
          c.conditions = c.conditions.filter(x => x !== appliedCondition.condition);
        }
      }
      return;
    }
    case 'wildShape': {
      const c = state.find(x => x.id === evt.creatureId);
      if (!c) return;
      if (evt.beastName) {
        c._wildShapeBeast = evt.beastName;
      } else {
        c._wildShapeBeast = undefined;
      }
      return;
    }
    case 'concentrationAura': {
      const c = state.find(x => x.id === evt.creatureId);
      if (!c) return;
      if (evt.active) {
        c._concentrationAura = {
          damageType: evt.damageType,
          radiusFt: evt.radiusFt,
          origin: evt.origin,
          point: evt.point,
        };
      } else {
        c._concentrationAura = undefined;
      }
      return;
    }
    // Cosmetic events: they animate but do not change replayed creature
    // state, so they are intentional no-ops here. Listing them explicitly
    // (rather than a catch-all default) means a NEW AnimationEvent kind that
    // is neither handled above nor listed here fails to compile at the
    // assertNever below - forcing whoever adds it to decide how replay
    // should treat it, instead of silently desyncing the grid.
    case 'attack':
    case 'miss':
    case 'save':
    case 'aoe':
    case 'effect':
    case 'oaAvoided':
    case 'turnStart':
    case 'roundStart':
    case 'message':
      return;
    default:
      return assertNever(evt);
  }
}

/**
 * Compile-time exhaustiveness guard. If the AnimationEvent union gains a
 * kind that applyEventToReplay does not handle, `evt` here is no longer
 * `never` and tsc fails the build. At runtime it should be unreachable.
 */
function assertNever(evt: never): void {
  throw new Error(`applyEventToReplay: unhandled AnimationEvent kind: ${(evt as { kind?: string }).kind}`);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * For the currently-playing event, compute the interpolated render position for one creature.
 */
export function interpolatedPosition(
  creature: Creature,
  currentEvent: AnimationEvent | null,
  progress: number,
): { x: number; y: number } {
  if (!currentEvent) return creature.position;
  if (currentEvent.kind === 'move' && currentEvent.creatureId === creature.id) {
    const waypoints = currentEvent.path;
    if (waypoints && waypoints.length > 1) {
      // Follow the A* path so the creature visually walks around walls
      // and chasms instead of lerping through them in a straight line.
      const segments = waypoints.length - 1;
      const raw = progress * segments;
      const idx = Math.min(Math.floor(raw), segments - 1);
      const t = raw - idx;
      return {
        x: lerp(waypoints[idx].x, waypoints[idx + 1].x, t),
        y: lerp(waypoints[idx].y, waypoints[idx + 1].y, t),
      };
    }
    return {
      x: lerp(currentEvent.from.x, currentEvent.to.x, progress),
      y: lerp(currentEvent.from.y, currentEvent.to.y, progress),
    };
  }
  return creature.position;
}
