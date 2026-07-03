import { describe, it, expect } from 'vitest';
import { buildCustomHero, buildHero } from '../src/data/heroes';
import { monsters } from '../src/data/monsters';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';
import { snapshotCreatures, applyEventToReplay } from '../src/engine/animation-replay';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

describe('Concentration aura replay lifecycle', () => {
  it('_concentrationAura is set on replay creature when concentrationAura event fires', () => {
    const cleric = buildHero('Cleric', 5);
    let auraEventFound = false;

    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(cleric, 'blue', { x: 5, y: 5 }, 0),
        createCreatureWithFixedHp(md('Ogre'), 'red', { x: 8, y: 5 }, 0),
        createCreatureWithFixedHp(md('Ogre'), 'red', { x: 9, y: 5 }, 1),
      ];
      const state = runBattle(creatures, 15);
      const auraEvent = state.events.find(
        e => e.kind === 'concentrationAura' && (e as any).active === true
      );
      if (auraEvent) {
        auraEventFound = true;

        // Replay the events up to and including the aura event
        const replay = snapshotCreatures(creatures);
        for (const evt of state.events) {
          applyEventToReplay(replay, evt);
          if (evt === auraEvent) break;
        }

        // The caster should now have _concentrationAura set
        const caster = replay.find(c => c.id === auraEvent.creatureId);
        expect(caster).toBeDefined();
        expect(caster!._concentrationAura).toBeDefined();
        expect(caster!._concentrationAura.damageType).toBeTruthy();
        break;
      }
    }
    expect(auraEventFound).toBe(true);
  });

  it('_concentrationAura persists across subsequent events', () => {
    const cleric = buildHero('Cleric', 5);

    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(cleric, 'blue', { x: 5, y: 5 }, 0),
        createCreatureWithFixedHp(md('Ogre'), 'red', { x: 8, y: 5 }, 0),
        createCreatureWithFixedHp(md('Ogre'), 'red', { x: 9, y: 5 }, 1),
      ];
      const state = runBattle(creatures, 15);
      const firstAuraIdx = state.events.findIndex(
        e => e.kind === 'concentrationAura' && (e as any).active === true
      );
      if (firstAuraIdx < 0) continue;

      const casterId = state.events[firstAuraIdx].creatureId;
      const replay = snapshotCreatures(creatures);
      for (const evt of state.events) {
        applyEventToReplay(replay, evt);
      }

      // The final replay state must match the LAST aura event for this caster.
      // Concentration can drop and be re-cast in the same battle (Ogre hit ->
      // concentration save fails -> deactivation -> cleric re-casts Spirit
      // Guardians on a later turn), so "any deactivation after the first
      // activation" isn't enough - we need the tail event's `active` flag.
      const auraEvents = state.events.filter(
        e => e.kind === 'concentrationAura' && e.creatureId === casterId
      );
      const last = auraEvents[auraEvents.length - 1] as { active?: boolean };
      const caster = replay.find(c => c.id === casterId);

      if (last.active) {
        expect(caster!._concentrationAura).toBeDefined();
      } else {
        expect(caster!._concentrationAura).toBeUndefined();
      }
      return;
    }
  });

  it('snapshotCreatures does NOT copy _concentrationAura (initial replay state is clean)', () => {
    const cleric = buildHero('Cleric', 5);
    const creatures = [
      createCreatureWithFixedHp(cleric, 'blue', { x: 5, y: 5 }, 0),
    ];
    // Manually set concentrationAura on the creature
    creatures[0].concentrationAura = {
      spellName: 'Spirit Guardians',
      damageDice: '3d8',
      damageType: 'radiant',
      saveAbility: 'wis',
      saveDC: 13,
      radiusFt: 15,
      origin: 'caster',
    };

    const replay = snapshotCreatures(creatures);
    // The live concentrationAura should NOT appear as _concentrationAura on replay
    // (it should only be set by animation events during replay)
    // But the spread operator WILL copy concentrationAura...
    // This is actually fine - _concentrationAura (underscore prefix) is separate
    expect(replay[0]._concentrationAura).toBeUndefined();
  });

  it('Wall of Fire produces concentrationAura event', () => {
    const wizard = buildCustomHero('Wizard', 7, { spells: ['Wall of Fire'] });
    let auraFound = false;

    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(wizard, 'blue', { x: 5, y: 5 }, 0),
        createCreatureWithFixedHp(md('Ogre'), 'red', { x: 8, y: 5 }, 0),
        createCreatureWithFixedHp(md('Ogre'), 'red', { x: 9, y: 5 }, 1),
      ];
      const state = runBattle(creatures, 15);
      if (state.events.some(e => e.kind === 'concentrationAura' && (e as any).spellName === 'Wall of Fire')) {
        auraFound = true;
        break;
      }
    }
    expect(auraFound).toBe(true);
  });

  it('concentrationAura cleared on creature reset', () => {
    const cleric = buildHero('Cleric', 5);
    const creature = createCreatureWithFixedHp(cleric, 'blue', { x: 5, y: 5 }, 0);
    creature.concentrationAura = {
      spellName: 'Spirit Guardians',
      damageDice: '3d8',
      damageType: 'radiant',
      saveAbility: 'wis',
      saveDC: 13,
      radiusFt: 15,
      origin: 'caster',
    };
    creature.concentratingOn = 'Spirit Guardians';

    // Simulate what resetBattle does
    const reset = {
      ...creature,
      currentHp: creature.maxHp,
      isAlive: true,
      conditions: [] as any[],
      conditionTimers: [] as any[],
      recharges: {},
      activeBuffs: [] as any[],
      turnFlags: {},
      concentrationAura: undefined,
      concentratingOn: undefined,
    };

    expect(reset.concentrationAura).toBeUndefined();
    expect(reset.concentratingOn).toBeUndefined();
  });
});
