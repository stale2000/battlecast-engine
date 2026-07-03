import { describe, it, expect } from 'vitest';
import { applyEventToReplay, snapshotCreatures, interpolatedPosition } from '../src/engine/animation-replay';
import { Creature } from '../src/types/monster';
import { AnimationEvent } from '../src/types/animation';

function makeCreature(overrides: Partial<Creature> & { id: string }): Creature {
  return {
    id: overrides.id,
    name: overrides.name || 'Test',
    displayName: overrides.displayName || 'Test',
    monsterData: {
      name: 'Test', size: 'Medium', type: 'humanoid', alignment: 'neutral',
      ac: 10, hp: 20, hpFormula: '4d8', speed: { walk: 30 },
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      senses: '', languages: '', cr: '1', xp: 200, proficiencyBonus: 2,
      actions: [],
    },
    team: overrides.team || 'red',
    currentHp: overrides.currentHp ?? 20,
    maxHp: overrides.maxHp ?? 20,
    position: overrides.position || { x: 0, y: 0 },
    initiative: 0,
    conditions: overrides.conditions || [],
    conditionTimers: [],
    isAlive: overrides.isAlive ?? true,
    hasActed: false,
    hasMovedThisTurn: false,
    movementRemaining: 30,
    recharges: {},
    stats: { damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksHit: 0, killCount: 0, roundsSurvived: 0, actionUsage: {} },
  };
}

describe('applyEventToReplay', () => {
  it('move updates position, nothing else', () => {
    const creatures = [makeCreature({ id: 'a', position: { x: 0, y: 0 }, currentHp: 20 })];
    const evt: AnimationEvent = { kind: 'move', creatureId: 'a', from: { x: 0, y: 0 }, to: { x: 3, y: 4 }, durationMs: 400 };

    applyEventToReplay(creatures, evt);

    expect(creatures[0].position).toEqual({ x: 3, y: 4 });
    expect(creatures[0].currentHp).toBe(20);
    expect(creatures[0].isAlive).toBe(true);
  });

  it('hit sets currentHp to targetHpAfter, marks dead at 0', () => {
    const creatures = [makeCreature({ id: 'a', currentHp: 15, maxHp: 20 })];
    const evt: AnimationEvent = {
      kind: 'hit', targetId: 'a', damage: 10, damageType: 'slashing',
      critical: false, targetHpBefore: 15, targetHpAfter: 5, durationMs: 600,
    };

    applyEventToReplay(creatures, evt);
    expect(creatures[0].currentHp).toBe(5);
    expect(creatures[0].isAlive).toBe(true);
  });

  it('hit writes targetHpAfter but no longer auto-kills - death event handles isAlive', () => {
    // Since #35 (death saves), the `hit` event only writes the HP number.
    // The dedicated `death` event is the single authority for flipping
    // isAlive=false. This keeps Downed heroes (HP=0 but still alive)
    // from being falsely killed during replay.
    const creatures = [makeCreature({ id: 'b', currentHp: 3, maxHp: 20 })];
    const evt: AnimationEvent = {
      kind: 'hit', targetId: 'b', damage: 10, damageType: 'fire',
      critical: false, targetHpBefore: 3, targetHpAfter: 0, durationMs: 600,
    };

    applyEventToReplay(creatures, evt);
    expect(creatures[0].currentHp).toBe(0);
    expect(creatures[0].isAlive).toBe(true);

    // Engine always pushes a death event in step with a fatal hit; the
    // death event flips isAlive.
    applyEventToReplay(creatures, { kind: 'death', creatureId: 'b', durationMs: 700 });
    expect(creatures[0].isAlive).toBe(false);
  });

  it('aoeDamage updates every damaged target in one replay step', () => {
    const creatures = [
      makeCreature({ id: 'a', currentHp: 20, maxHp: 20 }),
      makeCreature({ id: 'b', currentHp: 15, maxHp: 15 }),
      makeCreature({ id: 'c', currentHp: 10, maxHp: 10 }),
    ];
    const evt: AnimationEvent = {
      kind: 'aoeDamage',
      targets: [
        {
          targetId: 'a',
          saveSuccess: false,
          damage: 12,
          damageType: 'fire',
          critical: false,
          targetHpBefore: 20,
          targetHpAfter: 8,
        },
        {
          targetId: 'b',
          saveSuccess: true,
          damage: 6,
          damageType: 'fire',
          critical: false,
          targetHpBefore: 15,
          targetHpAfter: 9,
        },
        {
          targetId: 'c',
          saveSuccess: true,
        },
      ],
      durationMs: 700,
    };

    applyEventToReplay(creatures, evt);

    expect(creatures.map(c => c.currentHp)).toEqual([8, 9, 10]);
    expect(creatures.every(c => c.isAlive)).toBe(true);
  });

  it('conditionBatch applies and removes multiple conditions in one replay step', () => {
    const creatures = [
      makeCreature({ id: 'a', conditions: [] }),
      makeCreature({ id: 'b', conditions: ['prone'] }),
      makeCreature({ id: 'c', conditions: ['frightened', 'restrained'] }),
    ];
    const evt: AnimationEvent = {
      kind: 'conditionBatch',
      conditions: [
        { creatureId: 'a', condition: 'frightened', applied: true },
        { creatureId: 'b', condition: 'prone', applied: true },
        { creatureId: 'c', condition: 'frightened', applied: false },
      ],
      durationMs: 400,
    };

    applyEventToReplay(creatures, evt);

    expect(creatures[0].conditions).toEqual(['frightened']);
    expect(creatures[1].conditions).toEqual(['prone']);
    expect(creatures[2].conditions).toEqual(['restrained']);
  });

  it('heal sets currentHp to creatureHpAfter', () => {
    const creatures = [makeCreature({ id: 'c', currentHp: 10, maxHp: 20 })];
    const evt: AnimationEvent = {
      kind: 'heal', creatureId: 'c', amount: 5,
      creatureHpBefore: 10, creatureHpAfter: 15, durationMs: 500,
    };

    applyEventToReplay(creatures, evt);
    expect(creatures[0].currentHp).toBe(15);
  });

  it('death marks creature dead with 0 hp', () => {
    const creatures = [makeCreature({ id: 'd', currentHp: 0, isAlive: true })];
    const evt: AnimationEvent = { kind: 'death', creatureId: 'd', durationMs: 700 };

    applyEventToReplay(creatures, evt);
    expect(creatures[0].isAlive).toBe(false);
    expect(creatures[0].currentHp).toBe(0);
  });

  it('deaths marks multiple creatures dead in one replay step', () => {
    const creatures = [
      makeCreature({ id: 'a', currentHp: 0, isAlive: true }),
      makeCreature({ id: 'b', currentHp: 0, isAlive: true }),
      makeCreature({ id: 'c', currentHp: 5, isAlive: true }),
    ];
    const evt: AnimationEvent = { kind: 'deaths', creatureIds: ['a', 'b'], durationMs: 700 };

    applyEventToReplay(creatures, evt);

    expect(creatures[0].isAlive).toBe(false);
    expect(creatures[1].isAlive).toBe(false);
    expect(creatures[2].isAlive).toBe(true);
  });

  it('cosmetic events (attack, miss, save, turnStart, roundStart, message) do not change state', () => {
    const creatures = [makeCreature({ id: 'e', currentHp: 20, position: { x: 5, y: 5 } })];
    const snapshot = JSON.stringify(creatures);

    const cosmetics: AnimationEvent[] = [
      { kind: 'attack', attackerId: 'e', targetId: 'other', actionName: 'Bite', attackType: 'melee', durationMs: 350 },
      { kind: 'miss', attackerId: 'e', targetId: 'other', durationMs: 400 },
      { kind: 'save', targetId: 'e', success: true, durationMs: 500 },
      { kind: 'turnStart', creatureId: 'e', durationMs: 150 },
      { kind: 'roundStart', round: 1, durationMs: 800 },
      { kind: 'message', text: 'test', durationMs: 0 },
    ];

    for (const evt of cosmetics) {
      applyEventToReplay(creatures, evt);
    }

    expect(JSON.stringify(creatures)).toBe(snapshot);
  });
});

describe('snapshotCreatures', () => {
  it('creates deep-ish clones that do not share position references', () => {
    const original = [makeCreature({ id: 'a', position: { x: 1, y: 2 } })];
    const snap = snapshotCreatures(original);

    snap[0].position.x = 99;
    snap[0].currentHp = 0;

    expect(original[0].position.x).toBe(1);
    expect(original[0].currentHp).toBe(20);
  });
});

describe('interpolatedPosition', () => {
  it('returns creature position when no event', () => {
    const c = makeCreature({ id: 'a', position: { x: 5, y: 3 } });
    expect(interpolatedPosition(c, null, 0)).toEqual({ x: 5, y: 3 });
  });

  it('interpolates during move event', () => {
    const c = makeCreature({ id: 'a', position: { x: 0, y: 0 } });
    const evt: AnimationEvent = { kind: 'move', creatureId: 'a', from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, durationMs: 400 };

    const pos = interpolatedPosition(c, evt, 0.5);
    expect(pos.x).toBe(5); // linear lerp at 50%
    expect(pos.y).toBe(0);
  });

  it('returns creature position for non-matching move event', () => {
    const c = makeCreature({ id: 'a', position: { x: 2, y: 3 } });
    const evt: AnimationEvent = { kind: 'move', creatureId: 'OTHER', from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, durationMs: 400 };

    expect(interpolatedPosition(c, evt, 0.5)).toEqual({ x: 2, y: 3 });
  });
});

describe('full event sequence replay', () => {
  it('replaying all events from a mock battle matches expected final state', () => {
    const creatures = snapshotCreatures([
      makeCreature({ id: 'red1', team: 'red', currentHp: 20, maxHp: 20, position: { x: 0, y: 0 } }),
      makeCreature({ id: 'blue1', team: 'blue', currentHp: 15, maxHp: 15, position: { x: 5, y: 5 } }),
    ]);

    const events: AnimationEvent[] = [
      { kind: 'roundStart', round: 1, durationMs: 800 },
      { kind: 'turnStart', creatureId: 'red1', durationMs: 150 },
      { kind: 'move', creatureId: 'red1', from: { x: 0, y: 0 }, to: { x: 3, y: 3 }, durationMs: 400 },
      { kind: 'attack', attackerId: 'red1', targetId: 'blue1', actionName: 'Sword', attackType: 'melee', durationMs: 350 },
      { kind: 'hit', targetId: 'blue1', damage: 8, damageType: 'slashing', critical: false, targetHpBefore: 15, targetHpAfter: 7, durationMs: 600 },
      { kind: 'turnStart', creatureId: 'blue1', durationMs: 150 },
      { kind: 'move', creatureId: 'blue1', from: { x: 5, y: 5 }, to: { x: 4, y: 4 }, durationMs: 400 },
      { kind: 'attack', attackerId: 'blue1', targetId: 'red1', actionName: 'Claw', attackType: 'melee', durationMs: 350 },
      { kind: 'hit', targetId: 'red1', damage: 20, damageType: 'slashing', critical: true, targetHpBefore: 20, targetHpAfter: 0, durationMs: 600 },
      { kind: 'death', creatureId: 'red1', durationMs: 700 },
    ];

    for (const evt of events) {
      applyEventToReplay(creatures, evt);
    }

    // red1: dead at (3,3) with 0 hp
    expect(creatures[0].position).toEqual({ x: 3, y: 3 });
    expect(creatures[0].currentHp).toBe(0);
    expect(creatures[0].isAlive).toBe(false);

    // blue1: alive at (4,4) with 7 hp
    expect(creatures[1].position).toEqual({ x: 4, y: 4 });
    expect(creatures[1].currentHp).toBe(7);
    expect(creatures[1].isAlive).toBe(true);
  });
});
