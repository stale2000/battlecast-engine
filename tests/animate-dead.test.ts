import { describe, expect, it } from 'vitest';
import { Encounter } from '../src/api/encounter.js';
import { executeSpell } from '../src/engine/combat.js';
import { animateDead } from '../src/data/spells.js';

describe('Animate Dead', () => {
  it('summons a server-owned Skeleton using the shared summon lifecycle', () => {
    const encounter = new Encounter({ seed: 5, gridSize: 12 });
    const [casterRef] = encounter.addCreature({ heroClass: 'Wizard', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalResources: { 'slot-3': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 5, y: 0 } });
    encounter.start();
    const caster = encounter.state!.creatures.find(c => c.id === casterRef.id)!;
    expect(executeSpell(encounter.state!, caster, animateDead('int', 3, 3), caster, undefined, { x: 1, y: 0 })).toBe(true);
    const skeleton = encounter.state!.creatures.find(c => c.summonedById === caster.id);
    expect(skeleton?.monsterData.name).toBe('Skeleton');
    expect(skeleton?.team).toBe('red');
    expect(caster.concentratingOn).toBeUndefined();
  });
});
