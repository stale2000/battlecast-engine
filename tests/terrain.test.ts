import { describe, expect, it } from 'vitest';
import { Encounter } from '../src/api/encounter.js';
import { moveToDestination } from '../src/engine/ai-movement.js';
import { buildDifficultTerrainSet, buildCoverMap, coverLevelBetween } from '../src/types/terrain.js';

describe('arena terrain rules', () => {
  it('records difficult terrain and cover cells', () => {
    const terrain = [
      { x: 1, y: 0, kind: 'difficult' as const },
      { x: 2, y: 0, kind: 'half-cover' as const },
      { x: 3, y: 0, kind: 'three-quarters-cover' as const },
    ];
    expect(buildDifficultTerrainSet(terrain)).toEqual(new Set(['1,0']));
    expect(buildCoverMap(terrain)).toEqual({ '2,0': 2, '3,0': 5 });
  });

  it('uses the strongest cover crossed by the attack line', () => {
    const cover = { '1,0': 2, '2,0': 5 } as const;
    expect(coverLevelBetween({ x: 0, y: 0 }, { x: 3, y: 0 }, 1, 1, cover)).toBe(5);
    expect(coverLevelBetween({ x: 0, y: 1 }, { x: 3, y: 1 }, 1, 1, cover)).toBe(0);
  });

  it('charges difficult terrain and preserves terrain through encounter serialization', () => {
    const encounter = new Encounter({
      seed: 1,
      terrain: [{ x: 1, y: 0, kind: 'difficult' }, { x: 2, y: 0, kind: 'half-cover' }],
    });
    const [fighter] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 8, y: 0 } });
    encounter.start();

    const state = encounter.state!;
    const creature = state.creatures.find(candidate => candidate.id === fighter.id)!;
    creature.movementRemaining = 10;
    expect(moveToDestination(creature, { x: 1, y: 0 }, state)).toEqual({ x: 1, y: 0 });
    expect(creature.movementRemaining).toBe(0);

    const restored = Encounter.fromJSON(encounter.toJSON());
    expect(restored.state!.terrainDifficult).toEqual(new Set(['1,0']));
    expect(restored.state!.terrainCover).toEqual({ '2,0': 2 });
  });
});
