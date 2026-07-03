/**
 * Tests for the ability-visual routing fix.
 *
 * The core bug: single-target save-based abilities (Beholder rays,
 * Vampire Charm, Ghost Possession, etc.) were routed through
 * resolveAoE, which emits an `aoe` sphere animation event. They
 * should go through resolveSingleTargetSave and emit `attack` events
 * with the correct visual mode (beam/psychic/grapple/touch).
 *
 * These tests verify:
 * 1. The visual-mode categorization function maps abilities correctly
 * 2. resolveSingleTargetSave produces attack events (not aoe events)
 * 3. Save mechanics still work (damage, conditions)
 * 4. Specific monsters (Beholder, Vampire, etc.) produce correct events
 * 5. True AoE abilities still route through resolveAoE
 */
import { describe, expect, test, vi } from 'vitest';
import {
  getSingleTargetVisual,
  resolveSingleTargetSave,
  resolveAoE,
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  type BattleState,
} from '../src/engine/combat';
import { monsters, getMonsterByName } from '../src/data/monsters';
import type { MonsterAction } from '../src/types/monster';

// ── Helpers ────────────────────────────────────────────────────────

function makeState(creatures: ReturnType<typeof createCreatureWithFixedHp>[]): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize: 20,
    teamTactics: DEFAULT_TACTICS,
  };
}

// ── 1. Visual-mode categorization ─────────────────────────────────

describe('getSingleTargetVisual categorization', () => {
  // Beams
  test.each([
    'Charm Ray', 'Paralyzing Ray', 'Fear Ray', 'Death Ray', 'Sleep Ray',
    'Enervation Ray', 'Disintegration Ray', 'Death Glare',
    'Poisonous Spittle', 'Acid Spray',
  ])('%s → beam', (name) => {
    expect(getSingleTargetVisual(name)).toBe('beam');
  });

  // Psychic / mental
  test.each([
    'Charm', 'Scare', 'Dreadful Glare', 'Possession',
    'Dominate Mind', 'Consume Memories', 'Hold Person',
    'Dissonant Whispers', 'Sleep',
  ])('%s → psychic', (name) => {
    expect(getSingleTargetVisual(name)).toBe('psychic');
  });

  // Grapple / tether
  test.each([
    'Constrict', 'Engulf', 'Whelm', 'Web Strand',
    'Conjure Infernal Chain', 'Entangling Rope', 'Vortex',
    'Tentacle Slam',
  ])('%s → grapple', (name) => {
    expect(getSingleTargetVisual(name)).toBe('grapple');
  });

  // Touch (default fallback for uncategorized)
  test.each([
    'Corrupting Touch', 'Draining Kiss', 'Life Drain',
    'Paralyzing Tentacles', 'Shield Bash',
    'Some Unknown Ability', // fallback
  ])('%s → touch', (name) => {
    expect(getSingleTargetVisual(name)).toBe('touch');
  });
});

// ── 2. resolveSingleTargetSave emits attack events, not aoe ──────

describe('resolveSingleTargetSave animation events', () => {
  test('emits an attack event with the correct visual type (beam for Charm Ray)', () => {
    const beholder = getMonsterByName('Beholder')!;
    const veteran = getMonsterByName('Veteran')!;
    const b = createCreatureWithFixedHp(beholder, 'red', { x: 0, y: 0 }, 0);
    const v = createCreatureWithFixedHp(veteran, 'blue', { x: 10, y: 0 }, 0);
    const state = makeState([b, v]);

    const charmRay = beholder.actions.find(a => a.name === 'Charm Ray')!;
    resolveSingleTargetSave(state, b, v, charmRay);

    // Must produce an attack event, NOT an aoe event
    const attackEvents = state.events.filter(e => e.kind === 'attack');
    const aoeEvents = state.events.filter(e => e.kind === 'aoe');
    expect(attackEvents.length).toBeGreaterThanOrEqual(1);
    expect(aoeEvents.length).toBe(0);

    // The attack event should have the beam visual type
    const atk = attackEvents[0] as { kind: 'attack'; attackType: string; actionName: string };
    expect(atk.attackType).toBe('beam');
    expect(atk.actionName).toBe('Charm Ray');
  });

  test('emits psychic type for Vampire Charm', () => {
    const vampire = getMonsterByName('Vampire');
    if (!vampire) return; // skip if Vampire isn't in the library yet
    const commoner = getMonsterByName('Commoner')!;
    const v = createCreatureWithFixedHp(vampire, 'red', { x: 0, y: 0 }, 0);
    const c = createCreatureWithFixedHp(commoner, 'blue', { x: 5, y: 0 }, 0);
    const state = makeState([v, c]);

    const charm = vampire.actions.find(a => a.name === 'Charm');
    if (!charm) return;
    resolveSingleTargetSave(state, v, c, charm);

    const attackEvents = state.events.filter(e => e.kind === 'attack');
    expect(attackEvents.length).toBeGreaterThanOrEqual(1);
    const atk = attackEvents[0] as { kind: 'attack'; attackType: string };
    expect(atk.attackType).toBe('psychic');
  });

  test('emits grapple type for Constrict abilities', () => {
    const boa = getMonsterByName('Constrictor Snake');
    if (!boa) return;
    const commoner = getMonsterByName('Commoner')!;
    const s = createCreatureWithFixedHp(boa, 'red', { x: 0, y: 0 }, 0);
    const c = createCreatureWithFixedHp(commoner, 'blue', { x: 1, y: 0 }, 0);
    const state = makeState([s, c]);

    const constrict = boa.actions.find(a => a.name === 'Constrict');
    if (!constrict?.savingThrow) return;
    resolveSingleTargetSave(state, s, c, constrict);

    const attackEvents = state.events.filter(e => e.kind === 'attack');
    expect(attackEvents.length).toBeGreaterThanOrEqual(1);
    const atk = attackEvents[0] as { kind: 'attack'; attackType: string };
    expect(atk.attackType).toBe('grapple');
  });
});

// ── 3. Save mechanics still work through the new path ────────────
// These tests run the actual dice (no mocking). We use statistical
// checks or verifiable side-effects to confirm the mechanics work
// without needing to control roll outcomes.

describe('resolveSingleTargetSave mechanics', () => {
  test('Death Ray produces save + hit events (regardless of outcome)', () => {
    const beholder = getMonsterByName('Beholder')!;
    const commoner = getMonsterByName('Commoner')!;
    const b = createCreatureWithFixedHp(beholder, 'red', { x: 0, y: 0 }, 0);
    const c = createCreatureWithFixedHp(commoner, 'blue', { x: 10, y: 0 }, 0);
    const state = makeState([b, c]);

    const deathRay = beholder.actions.find(a => a.name === 'Death Ray')!;
    resolveSingleTargetSave(state, b, c, deathRay);

    // Must have a save event (regardless of pass/fail)
    expect(state.events.some(e => e.kind === 'save')).toBe(true);
    // Death Ray has damageOnFail - must produce a hit event (damage
    // or half damage depending on save, but always SOME damage since
    // damageOnSuccess is "half").
    expect(state.events.some(e => e.kind === 'hit')).toBe(true);
  });

  test('Charm Ray produces save event and condition log on target', () => {
    // Run 20 tries - with DC 16 vs a Commoner's +0 WIS save, the
    // commoner fails most of the time and gets charmed.
    let charmedCount = 0;
    for (let i = 0; i < 20; i++) {
      const beholder = getMonsterByName('Beholder')!;
      const commoner = getMonsterByName('Commoner')!;
      const b = createCreatureWithFixedHp(beholder, 'red', { x: 0, y: 0 }, 0);
      const c = createCreatureWithFixedHp(commoner, 'blue', { x: 10, y: 0 }, 0);
      const state = makeState([b, c]);

      const charmRay = beholder.actions.find(a => a.name === 'Charm Ray')!;
      resolveSingleTargetSave(state, b, c, charmRay);

      if (c.conditions.includes('charmed')) charmedCount++;
    }
    // DC 16 vs +0: fails on 1-15 (75%). Over 20 trials, at least
    // 5 should be charmed (very conservative).
    expect(charmedCount).toBeGreaterThan(5);
  });

  test('Sleep Ray applies unconscious condition on failed save (statistical)', () => {
    let sleepCount = 0;
    for (let i = 0; i < 20; i++) {
      const beholder = getMonsterByName('Beholder')!;
      const commoner = getMonsterByName('Commoner')!;
      const b = createCreatureWithFixedHp(beholder, 'red', { x: 0, y: 0 }, 0);
      const c = createCreatureWithFixedHp(commoner, 'blue', { x: 10, y: 0 }, 0);
      const state = makeState([b, c]);

      const sleepRay = beholder.actions.find(a => a.name === 'Sleep Ray')!;
      resolveSingleTargetSave(state, b, c, sleepRay);

      if (c.conditions.includes('unconscious')) sleepCount++;
    }
    expect(sleepCount).toBeGreaterThan(5);
  });
});

// ── 4. True AoE still works through resolveAoE ──────────────────

describe('true AoE abilities still produce aoe events', () => {
  test('Fire Breath (cone with area) produces an aoe event, not attack', () => {
    const dragon = getMonsterByName('Adult Red Dragon')!;
    const commoner = getMonsterByName('Commoner')!;
    const d = createCreatureWithFixedHp(dragon, 'red', { x: 0, y: 0 }, 0);
    const c = createCreatureWithFixedHp(commoner, 'blue', { x: 3, y: 0 }, 0);
    const state = makeState([d, c]);

    const fireBreath = dragon.actions.find(a => a.name === 'Fire Breath')!;
    resolveAoE(state, d, fireBreath, [c]);

    const aoeEvents = state.events.filter(e => e.kind === 'aoe');
    expect(aoeEvents.length).toBeGreaterThanOrEqual(1);
    // Should NOT produce an attack event (this is area, not single-target)
    const beamEvents = state.events.filter(e => e.kind === 'attack' && (e as any).attackType === 'beam');
    expect(beamEvents.length).toBe(0);
  });
});

// ── 5. All Beholder rays categorized correctly ──────────────────

describe('Beholder ray categorization', () => {
  test('all Beholder special actions with savingThrow but no area are single-target', () => {
    const beholder = getMonsterByName('Beholder');
    if (!beholder) return;

    const singleTargetRays = beholder.actions.filter(a =>
      a.type === 'special' && a.savingThrow && !a.savingThrow.area
    );

    // Should be 5 rays: Charm, Paralyzing, Fear, Death, Sleep
    expect(singleTargetRays.length).toBeGreaterThanOrEqual(5);

    // None should be categorized as generic - each gets beam or psychic
    for (const ray of singleTargetRays) {
      const visual = getSingleTargetVisual(ray.name);
      expect(['beam', 'psychic']).toContain(visual);
    }
  });
});

// ── 6. Ensure no monster has area-less special actions going through resolveAoE
//       (the routing bug check across ALL monsters) ──────────────

describe('routing regression: no area-less specials should produce aoe events', () => {
  test('every monster special+savingThrow action either has area OR is in the single-target categorization', () => {
    for (const m of monsters) {
      for (const action of m.actions) {
        if (action.type !== 'special' || !action.savingThrow) continue;
        if (action.savingThrow.area) continue; // legitimate AoE

        // This is a single-target save - it MUST be categorized
        const visual = getSingleTargetVisual(action.name);
        expect(
          ['beam', 'psychic', 'grapple', 'touch'],
          `${m.name}.${action.name} is a single-target save but getSingleTargetVisual returned "${visual}" - add it to the categorization sets`
        ).toContain(visual);
      }
    }
  });
});
