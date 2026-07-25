import { describe, expect, it } from 'vitest';
import { Encounter } from '../src/api/encounter.js';
import { applyLegalAction, getLegalActions, startArena } from '../src/api/arena.js';
import { hailOfThorns } from '../src/data/spells.js';

describe('Hail of Thorns', () => {
  it('bursts around the next ranged weapon hit and then ends concentration', () => {
    const encounter = new Encounter({ seed: 4, gridSize: 12 });
    const [ranger] = encounter.addCreature({
      heroClass: 'Ranger', heroLevel: 5, team: 'red', position: { x: 0, y: 0 },
      heroOverrides: { additionalActions: [hailOfThorns('wis', 3, 3)], additionalResources: { 'slot-1': 1 } },
    });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 2, y: 0 } });
    const [splashSetup] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 2, y: 2 } });
    encounter.start();
    encounter.state!.initiativeOrder = [ranger.id];
    startArena(encounter);
    const active = encounter.state!.creatures.find(creature => creature.id === ranger.id)!;
    const splashTarget = encounter.state!.creatures.find(creature => creature.id === splashSetup.id)!;
    const target = encounter.state!.creatures.find(creature => creature.team === 'blue' && creature.id !== splashTarget.id)!;
    target.monsterData.ac = 1;
    const cast = getLegalActions(encounter, ranger.id).find(action => action.actionName === 'Hail of Thorns' && action.targetId === ranger.id)!;
    applyLegalAction(encounter, cast);
    expect(active.activeBuffs.some(buff => buff.key === 'hail-of-thorns')).toBe(true);
    const attack = getLegalActions(encounter, ranger.id).find(action => action.type === 'attack' && action.targetId === target.id)!;
    const splashBefore = splashTarget.currentHp;
    applyLegalAction(encounter, attack);
    expect(splashTarget.currentHp).toBeLessThan(splashBefore);
    expect(active.activeBuffs.some(buff => buff.key === 'hail-of-thorns')).toBe(false);
    expect(active.concentratingOn).toBeUndefined();
  });
});
