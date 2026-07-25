import { describe, expect, it } from 'vitest';
import { Encounter } from '../src/api/encounter.js';
import { applyLegalAction, getLegalActions, startArena } from '../src/api/arena.js';
import { buildCustomHero, getAvailableSpells } from '../src/data/heroes.js';
import { getActiveActions } from '../src/engine/ai-targeting.js';

describe("Dragon's Breath", () => {
  it('grants a serialized, reusable cone action to the chosen ally', () => {
    expect(getAvailableSpells('Wizard', 5).some(spell => spell.name === "Dragon's Breath")).toBe(true);
    expect(getAvailableSpells('Sorcerer', 5).some(spell => spell.name === "Dragon's Breath")).toBe(true);
    const encounter = new Encounter({ seed: 4, gridSize: 12 });
    const [caster] = encounter.addCreature({
      heroClass: 'Wizard', heroLevel: 5, team: 'red', position: { x: 0, y: 0 },
      heroOverrides: { additionalActions: buildCustomHero('Wizard', 5, { spells: ["Dragon's Breath"] }).actions.filter(action => action.name === "Dragon's Breath") },
    });
    const [ally] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 2, y: 0 } });
    const [enemy] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 4, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [caster.id];
    startArena(encounter);

    const cast = getLegalActions(encounter, caster.id).find(action => action.actionName === "Dragon's Breath" && action.targetId === ally.id && action.damageType === 'fire');
    expect(cast).toBeTruthy();
    applyLegalAction(encounter, cast!);
    const restored = Encounter.fromJSON(encounter.toJSON());
    const restoredAlly = restored.state!.creatures.find(creature => creature.id === ally.id)!;
    expect(restoredAlly.activeBuffs.some(buff => buff.key === 'dragons-breath' && buff.grantsAction?.name === "Dragon's Breath")).toBe(true);
    expect(getActiveActions(restoredAlly).some(action => action.name === "Dragon's Breath" && action.savingThrow?.area === '15-foot cone')).toBe(true);

    restored.state!.initiativeOrder = [restoredAlly.id];
    restored.state!.turnIndex = 0;
    restoredAlly.hasActed = false;
    const breath = getLegalActions(restored, restoredAlly.id).find(action => action.actionName === "Dragon's Breath" && action.areaShape === '15-foot cone');
    expect(breath).toBeTruthy();
    const before = restored.state!.creatures.find(creature => creature.id === enemy.id)!.currentHp;
    applyLegalAction(restored, breath!);
    const after = restored.state!.creatures.find(creature => creature.id === enemy.id)!.currentHp;
    expect(after).toBeLessThan(before);
  });
});
