import { describe, it, expect } from 'vitest';
import {
  applyDamage,
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  initBattle,
  stabiliseDyingAlly,
} from '../src/engine/combat';
import { executeTurn } from '../src/engine/ai-turn';
import { applyEventToReplay, snapshotCreatures } from '../src/engine/animation-replay';
import { buildHero } from '../src/data/heroes';
import { Creature, MonsterData } from '../src/types/monster';
import { AnimationEvent } from '../src/types/animation';

function makeMonsterData(name = 'Test Wolf', hp = 40): MonsterData {
  return {
    name,
    size: 'Medium',
    type: 'beast',
    alignment: 'neutral',
    ac: 12,
    hp,
    hpFormula: `${hp}d1`,
    speed: { walk: 30 },
    abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 10, cha: 8 },
    senses: '',
    languages: '',
    cr: '1',
    xp: 200,
    proficiencyBonus: 2,
    actions: [
      { name: 'Bite', type: 'melee', attackBonus: 4, damage: '1d6+2', damageType: 'piercing', reach: 5, description: '.' },
    ],
  };
}

function makeHero(
  heroClass: Parameters<typeof buildHero>[0] = 'Fighter',
  level = 1,
  team: 'red' | 'blue' = 'blue',
  pos = { x: 5, y: 5 },
  index = 0,
): Creature {
  return createCreatureWithFixedHp(buildHero(heroClass, level), team, pos, index);
}

function makeEnemy(pos = { x: 12, y: 5 }, hp = 40): Creature {
  return createCreatureWithFixedHp(makeMonsterData('Test Wolf', hp), 'red', pos, 0);
}

function downHero(state: ReturnType<typeof initBattle>, hero: Creature, attacker: Creature): void {
  applyDamage(state, hero, hero.currentHp + 2, 'piercing', attacker, true);
  expect(hero.dying).toBe(true);
}

describe('stabiliseDyingAlly', () => {
  it('stabilises an adjacent dying hero without reviving them', () => {
    const rescuer = makeHero('Fighter', 1, 'blue', { x: 5, y: 5 }, 0);
    const dying = makeHero('Rogue', 1, 'blue', { x: 6, y: 5 }, 1);
    const enemy = makeEnemy();
    const state = initBattle([rescuer, dying, enemy], 20);
    downHero(state, dying, enemy);

    const ok = stabiliseDyingAlly(state, rescuer, dying);

    expect(ok).toBe(true);
    expect(dying.isAlive).toBe(true);
    expect(dying.dying).toBe(false);
    expect(dying.currentHp).toBe(0);
    expect(dying.deathSaves).toBeUndefined();
    expect(dying.conditions).toContain('unconscious');
    expect(dying.stats.timesStabilisedByAllies).toBe(1);
    expect(rescuer.stats.alliesStabilised).toBe(1);
    expect(rescuer.stats.actionUsage.Stabilise).toBe(1);
    expect(state.logs.some(log => log.action === 'Stabilise' && log.actor === rescuer.displayName)).toBe(true);
    expect(state.events.some(e => e.kind === 'stabiliseAlly' && e.creatureId === dying.id)).toBe(true);
  });

  it('refuses non-adjacent stabilise attempts', () => {
    const rescuer = makeHero('Fighter', 1, 'blue', { x: 5, y: 5 }, 0);
    const dying = makeHero('Rogue', 1, 'blue', { x: 8, y: 5 }, 1);
    const enemy = makeEnemy();
    const state = initBattle([rescuer, dying, enemy], 20);
    downHero(state, dying, enemy);

    expect(stabiliseDyingAlly(state, rescuer, dying)).toBe(false);
    expect(dying.dying).toBe(true);
    expect(rescuer.stats.alliesStabilised ?? 0).toBe(0);
  });
});

describe('AI stabilise tactic', () => {
  it('is on by default and spends a non-healer hero action on an adjacent dying ally', () => {
    const rescuer = makeHero('Fighter', 1, 'blue', { x: 5, y: 5 }, 0);
    const dying = makeHero('Rogue', 1, 'blue', { x: 6, y: 5 }, 1);
    const enemy = makeEnemy({ x: 12, y: 5 });
    const state = initBattle([rescuer, dying, enemy], 20);
    state.teamTactics = { ...DEFAULT_TACTICS };
    downHero(state, dying, enemy);

    executeTurn(state, rescuer);

    expect(dying.dying).toBe(false);
    expect(dying.currentHp).toBe(0);
    expect(dying.conditions).toContain('unconscious');
    expect(rescuer.hasActed).toBe(true);
    expect(rescuer.stats.actionUsage.Stabilise).toBe(1);
  });

  it('can be switched off per team', () => {
    const rescuer = makeHero('Fighter', 1, 'blue', { x: 5, y: 5 }, 0);
    const dying = makeHero('Rogue', 1, 'blue', { x: 6, y: 5 }, 1);
    const enemy = makeEnemy({ x: 12, y: 5 });
    const state = initBattle([rescuer, dying, enemy], 20);
    state.teamTactics = { ...DEFAULT_TACTICS, blueStabiliseAllies: false };
    downHero(state, dying, enemy);

    executeTurn(state, rescuer);

    expect(dying.dying).toBe(true);
    expect(rescuer.stats.actionUsage.Stabilise ?? 0).toBe(0);
    expect(state.events.some(e => e.kind === 'stabiliseAlly')).toBe(false);
  });

  it('prefers revive healing over stabilising when a healer can bring the ally back up', () => {
    const cleric = makeHero('Cleric', 3, 'blue', { x: 5, y: 5 }, 0);
    const dying = makeHero('Fighter', 1, 'blue', { x: 6, y: 5 }, 1);
    const enemy = makeEnemy({ x: 12, y: 5 });
    const state = initBattle([cleric, dying, enemy], 20);
    downHero(state, dying, enemy);

    executeTurn(state, cleric);

    expect(dying.dying).toBe(false);
    expect(dying.currentHp).toBeGreaterThan(0);
    expect(dying.conditions).not.toContain('unconscious');
    expect(dying.stats.timesRevived).toBe(1);
    expect(cleric.stats.alliesRevived).toBe(1);
    expect(cleric.stats.actionUsage.Stabilise ?? 0).toBe(0);
    expect(state.events.some(e => e.kind === 'stabiliseAlly')).toBe(false);
  });

  it('uses bonus-action healing first, then stabilises a second adjacent ally with the action', () => {
    const bard = makeHero('Bard', 2, 'blue', { x: 5, y: 5 }, 0);
    const farDying = makeHero('Fighter', 1, 'blue', { x: 8, y: 5 }, 1);
    const adjacentDying = makeHero('Rogue', 1, 'blue', { x: 6, y: 5 }, 2);
    const enemy = makeEnemy({ x: 12, y: 5 });
    const state = initBattle([bard, farDying, adjacentDying, enemy], 20);
    downHero(state, farDying, enemy);
    downHero(state, adjacentDying, enemy);

    executeTurn(state, bard);

    expect(farDying.dying).toBe(false);
    expect(farDying.currentHp).toBeGreaterThan(0);
    expect(farDying.stats.timesRevived).toBe(1);
    expect(adjacentDying.dying).toBe(false);
    expect(adjacentDying.currentHp).toBe(0);
    expect(adjacentDying.conditions).toContain('unconscious');
    expect(adjacentDying.stats.timesStabilisedByAllies).toBe(1);
    expect(bard.stats.alliesRevived).toBe(1);
    expect(bard.stats.alliesStabilised).toBe(1);
  });
});

describe('stabilise replay', () => {
  it('keeps the hero unconscious at 0 HP after the stabiliseAlly event', () => {
    const rescuer = makeHero('Fighter', 1, 'blue', { x: 5, y: 5 }, 0);
    const dying = makeHero('Rogue', 1, 'blue', { x: 6, y: 5 }, 1);
    const enemy = makeEnemy();
    const state = initBattle([rescuer, dying, enemy], 20);
    downHero(state, dying, enemy);
    const replay = snapshotCreatures(state.creatures);
    const event: AnimationEvent = {
      kind: 'stabiliseAlly',
      actorId: rescuer.id,
      creatureId: dying.id,
      durationMs: 600,
    };

    applyEventToReplay(replay, event);

    const replayDying = replay.find(c => c.id === dying.id)!;
    expect(replayDying.isAlive).toBe(true);
    expect(replayDying.dying).toBe(false);
    expect(replayDying.currentHp).toBe(0);
    expect(replayDying.deathSaves).toBeUndefined();
    expect(replayDying.conditions).toContain('unconscious');
  });
});
