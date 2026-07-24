import { describe, expect, it } from 'vitest';
import { Encounter } from '../src/api/encounter.js';
import { applyLegalAction, getLegalActions, startArena } from '../src/api/arena.js';
import { buildCustomHero } from '../src/data/heroes.js';
import { buildSpellAction, summonFey, summonUndead } from '../src/data/spells.js';
import { dropConcentratedBuffsFrom } from '../src/engine/combat-buffs.js';

describe('level-three summon spells', () => {
  it('exposes complete executable summon definitions and class access', () => {
    for (const [name, spell] of [['Summon Fey', summonFey('int', 3, 3)], ['Summon Undead', summonUndead('int', 3, 3)] as const]) {
      expect(buildSpellAction(name, 'int', 3, 3)?.summon?.variants).toHaveLength(3);
      expect(spell.concentration).toBe(true);
      expect(spell.summon?.variants.every(variant => variant.monsterData.actions.length > 0)).toBe(true);
    }
    expect(buildCustomHero('Wizard', 5, { spells: ['Summon Fey', 'Summon Undead'] }).actions.map(action => action.name)).toEqual(expect.arrayContaining(['Summon Fey', 'Summon Undead']));
    expect(buildCustomHero('Warlock', 5, { spells: ['Summon Fey', 'Summon Undead'] }).actions.map(action => action.name)).toEqual(expect.arrayContaining(['Summon Fey', 'Summon Undead']));
    const putrid = summonUndead('int', 3, 3).summon!.variants.find(variant => variant.key === 'putrid')!;
    expect(putrid.monsterData.actions[0].conditionOnHit).toMatchObject({ condition: 'paralyzed', save: { ability: 'con', dc: 14 }, duration: 'end_of_next_turn' });
  });

  it('creates an owned spirit, inserts it after the caster, and dismisses it on concentration loss', () => {
    const encounter = new Encounter({ seed: 7, gridSize: 12 });
    const [caster] = encounter.addCreature({ heroClass: 'Wizard', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [summonFey('int', 3, 3)], additionalResources: { 'slot-3': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 8, y: 8 } });
    encounter.start();
    encounter.state!.initiativeOrder = [caster.id];
    startArena(encounter);
    const choice = getLegalActions(encounter, caster.id).find(action => action.type === 'spell_summon' && action.variantKey === 'fuming' && action.destination?.x === 2 && action.destination?.y === 2)!;
    expect(choice).toBeTruthy();
    applyLegalAction(encounter, choice);
    const spirit = encounter.state!.creatures.find(creature => creature.summonedById === caster.id)!;
    expect(spirit).toMatchObject({ team: 'red', summonRequiresConcentration: true, position: { x: 2, y: 2 } });
    expect(encounter.state!.initiativeOrder).toEqual([caster.id, spirit.id]);
    expect(spirit.monsterData.actions.some(action => action.name === 'Fey Blade')).toBe(true);
    const restored = Encounter.fromJSON(encounter.toJSON()).state!.creatures.find(creature => creature.id === spirit.id)!;
    expect(restored.summonedById).toBe(caster.id);
    const casterState = encounter.state!.creatures.find(creature => creature.id === caster.id)!;
    casterState.concentratingOn = undefined;
    // The shared concentration cleanup is authoritative for all summon spells.
    dropConcentratedBuffsFrom(encounter.state!, caster.id);
    expect(encounter.state!.creatures.some(creature => creature.id === spirit.id)).toBe(false);
  });
});
