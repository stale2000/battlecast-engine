import { describe, expect, it } from 'vitest';
import { Encounter } from '../src/api/encounter.js';
import { executeSpell } from '../src/engine/combat.js';
import { wardingWind } from '../src/data/spells.js';

describe('Warding Wind', () => {
  it('creates a difficult-terrain aura that penalizes ranged weapon attacks', () => {
    const encounter = new Encounter({ seed: 8, gridSize: 12 });
    const [casterRef] = encounter.addCreature({ heroClass: 'Wizard', heroLevel: 5, team: 'red', position: { x: 2, y: 2 }, heroOverrides: { additionalResources: { 'slot-2': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 5, y: 2 } });
    encounter.start();
    const caster = encounter.state!.creatures.find(c => c.id === casterRef.id)!;
    expect(executeSpell(encounter.state!, caster, wardingWind('int', 3, 3), caster)).toBe(true);
    expect(encounter.state!.persistentZones?.some(zone => zone.difficultTerrain && zone.rangedWeaponAttacksDisadvantage)).toBe(true);
    expect(caster.concentratingOn).toBe('Warding Wind');
  });
});
