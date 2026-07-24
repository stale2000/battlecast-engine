import { describe, expect, it } from 'vitest';
import { Encounter } from '../src/api/encounter.js';
import { executeSpell } from '../src/engine/combat.js';
import { fireball, silence } from '../src/data/spells.js';

describe('Silence', () => {
  it('creates a persistent zone that blocks spell casting inside it', () => {
    const encounter = new Encounter({ seed: 3, gridSize: 12 });
    const [casterRef] = encounter.addCreature({ heroClass: 'Bard', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalResources: { 'slot-2': 1, 'slot-3': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 2, y: 0 } });
    encounter.start();
    const caster = encounter.state!.creatures.find(c => c.id === casterRef.id)!;
    const silenceAction = silence('cha', 3, 3);
    expect(executeSpell(encounter.state!, caster, silenceAction, caster, undefined, { x: 1, y: 0 })).toBe(true);
    expect(encounter.state!.persistentZones?.some(zone => zone.silences)).toBe(true);
    expect(executeSpell(encounter.state!, caster, fireball('cha', 3, 3), caster, [], { x: 1, y: 0 })).toBe(false);
  });
});
