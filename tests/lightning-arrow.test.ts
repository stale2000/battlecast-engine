import { describe, expect, it } from 'vitest';
import { Encounter } from '../src/api/encounter.js';
import { applyLegalAction, getLegalActions, startArena } from '../src/api/arena.js';
import { lightningArrow } from '../src/data/spells.js';

describe('Lightning Arrow', () => {
  it('replaces a ranged hit and bursts around the target', () => {
    const encounter = new Encounter({ seed: 9, gridSize: 12 });
    const [ranger] = encounter.addCreature({ heroClass: 'Ranger', heroLevel: 10, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [lightningArrow('wis', 3, 4)], additionalResources: { 'slot-3': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 2, y: 0 } });
    const [nearby] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 2, y: 2 } });
    encounter.start(); encounter.state!.initiativeOrder = [ranger.id]; startArena(encounter);
    const target = encounter.state!.creatures.find(c => c.team === 'blue' && c.id !== nearby.id)!;
    target.monsterData.ac = 1;
    const cast = getLegalActions(encounter, ranger.id).find(a => a.actionName === 'Lightning Arrow' && a.targetId === ranger.id)!;
    applyLegalAction(encounter, cast);
    const nearbyState = encounter.state!.creatures.find(c => c.id === nearby.id)!;
    const before = nearbyState.currentHp;
    const attack = getLegalActions(encounter, ranger.id).find(a => a.type === 'attack' && a.targetId === target.id)!;
    applyLegalAction(encounter, attack);
    expect(nearbyState.currentHp).toBeLessThan(before);
    expect((encounter.state!.creatures.find(c => c.id === ranger.id)!.activeBuffs ?? []).some(b => b.key === 'lightning-arrow')).toBe(false);
  });

  it('deals half replacement damage on a miss', () => {
    const encounter = new Encounter({ seed: 12, gridSize: 12 });
    const [ranger] = encounter.addCreature({ heroClass: 'Ranger', heroLevel: 10, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [lightningArrow('wis', 3, 4)], additionalResources: { 'slot-3': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 2, y: 0 } });
    encounter.start(); encounter.state!.initiativeOrder = [ranger.id]; startArena(encounter);
    const target = encounter.state!.creatures.find(c => c.team === 'blue')!;
    target.monsterData.ac = 100;
    applyLegalAction(encounter, getLegalActions(encounter, ranger.id).find(a => a.actionName === 'Lightning Arrow' && a.targetId === ranger.id)!);
    const before = target.currentHp;
    applyLegalAction(encounter, getLegalActions(encounter, ranger.id).find(a => a.type === 'attack' && a.targetId === target.id)!);
    expect(target.currentHp).toBeLessThan(before);
    expect((encounter.state!.creatures.find(c => c.id === ranger.id)!.activeBuffs ?? []).some(b => b.key === 'lightning-arrow')).toBe(false);
  });
});
