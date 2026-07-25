import { describe, expect, it } from 'vitest';
import { Encounter } from '../src/api/encounter.js';
import { executeSpell } from '../src/engine/combat.js';
import { compelledDuel } from '../src/data/spells.js';
import { reachableMovementDestinations } from '../src/engine/ai-movement.js';
import { withRng } from '../src/engine/rng.js';

describe('Compelled Duel', () => {
  it('applies the caster-exception attack penalty and 30-foot movement limit', () => {
    const encounter = new Encounter({ seed: 2, gridSize: 12 });
    const [paladinRef] = encounter.addCreature({ heroClass: 'Paladin', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalResources: { 'slot-1': 1 } } });
    const [ogreRef] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 2, y: 0 } });
    encounter.start();
    const paladin = encounter.state!.creatures.find(c => c.id === paladinRef.id)!;
    const ogre = encounter.state!.creatures.find(c => c.id === ogreRef.id)!;
    expect(withRng({ next: () => 0 }, () => executeSpell(encounter.state!, paladin, compelledDuel('cha', 6, 3), ogre, [ogre]))).toBe(true);
    expect(ogre.activeBuffs.some(buff => buff.key === 'compelled-duel')).toBe(true);
    expect(ogre.activeBuffs.some(buff => buff.attackersHaveDisadvantageExceptCaster)).toBe(true);
    expect(reachableMovementDestinations(ogre, encounter.state!).some(cell => cell.x > 8)).toBe(false);
  });
});
