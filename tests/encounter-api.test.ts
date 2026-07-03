import { describe, expect, it } from 'vitest';
import { Encounter, EncounterError } from '../src/api/encounter';
import { EncounterManager } from '../src/api/manager';
import { observeEncounter } from '../src/api/observation';

function goblinsVsOgre(seed: number | string): Encounter {
  const enc = new Encounter({ gridSize: 20, seed });
  enc.addCreature({ monster: 'Goblin Warrior', team: 'red', count: 4 });
  enc.addCreature({ monster: 'Ogre', team: 'blue' });
  return enc;
}

describe('Encounter lifecycle', () => {
  it('adds creatures with stable, guessable ids', () => {
    const enc = goblinsVsOgre(1);
    const ids = enc.creatures.map(c => c.id);
    expect(ids).toEqual(['goblin-warrior-red-1', 'goblin-warrior-red-2', 'goblin-warrior-red-3', 'goblin-warrior-red-4', 'ogre-blue-1']);
  });

  it('rejects unknown monsters with suggestions', () => {
    const enc = new Encounter({ seed: 1 });
    expect(() => enc.addCreature({ monster: 'Goblin', team: 'red' })).toThrow(/Goblin Warrior/);
  });

  it('builds heroes by class and level', () => {
    const enc = new Encounter({ seed: 1 });
    const [added] = enc.addCreature({ heroClass: 'fighter', heroLevel: 5, team: 'blue' });
    expect(added.name).toMatch(/Fighter/);
  });

  it('refuses to start without both teams', () => {
    const enc = new Encounter({ seed: 1 });
    enc.addCreature({ monster: 'Ogre', team: 'blue' });
    expect(() => enc.start()).toThrow(EncounterError);
  });

  it('runs a battle to completion with a winner', () => {
    const enc = goblinsVsOgre(42);
    enc.start();
    const result = enc.runToCompletion(50);
    expect(result.isComplete).toBe(true);
    expect(['red', 'blue', 'draw']).toContain(result.winner);
  });

  it('refuses setup mutations after start', () => {
    const enc = goblinsVsOgre(1);
    enc.start();
    expect(() => enc.addCreature({ monster: 'Ogre', team: 'blue' })).toThrow(/setup/);
  });
});

describe('Determinism', () => {
  it('same seed produces an identical battle', () => {
    const run = (seed: number) => {
      const enc = goblinsVsOgre(seed);
      enc.start();
      enc.runToCompletion(50);
      return enc.state!.logs.map(l => l.details).join('|');
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('unseeded encounters still work', () => {
    const enc = new Encounter({ gridSize: 12 });
    enc.addCreature({ monster: 'Goblin Warrior', team: 'red' });
    enc.addCreature({ monster: 'Goblin Warrior', team: 'blue' });
    enc.start();
    const result = enc.runToCompletion(100);
    expect(result.isComplete).toBe(true);
  });
});

describe('DM controls', () => {
  function started() {
    const enc = goblinsVsOgre(7);
    enc.start();
    return enc;
  }

  it('applies damage through the rules pipeline', () => {
    const enc = started();
    const before = enc.creatures.find(c => c.id === 'ogre-blue-1')!.currentHp;
    const result = enc.damage('ogre-blue-1', 10, 'fire');
    expect(result.currentHp).toBe(before - result.taken);
    expect(result.taken).toBeGreaterThan(0);
  });

  it('heals but clamps at max hp', () => {
    const enc = started();
    enc.damage('ogre-blue-1', 10, 'fire');
    const result = enc.heal('ogre-blue-1', 9999);
    expect(result.currentHp).toBe(result.maxHp);
  });

  it('adds and removes conditions', () => {
    const enc = started();
    expect(enc.addCondition('ogre-blue-1', 'prone').conditions).toContain('prone');
    expect(enc.removeCondition('ogre-blue-1', 'prone').conditions).not.toContain('prone');
  });

  it('validates moves against bounds and occupancy', () => {
    const enc = started();
    expect(() => enc.moveCreature('ogre-blue-1', { x: 99, y: 0 })).toThrow(/outside/);
    const goblinPos = enc.creatures.find(c => c.id === 'goblin-warrior-red-1')!.position;
    expect(() => enc.moveCreature('ogre-blue-1', goblinPos)).toThrow(/blocked/);
    expect(enc.moveCreature('ogre-blue-1', { x: 10, y: 10 }).position).toEqual({ x: 10, y: 10 });
  });

  it('gives a helpful error for unknown creature ids', () => {
    const enc = started();
    expect(() => enc.damage('nope', 5)).toThrow(/Known ids/);
  });
});

describe('Serialization', () => {
  it('round-trips mid-battle and stays deterministic', () => {
    const a = goblinsVsOgre('save-test');
    a.start();
    a.runRound();

    const b = Encounter.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
    expect(observeEncounter(b)).toEqual(observeEncounter(a));

    a.runToCompletion(50);
    b.runToCompletion(50);
    expect(b.state!.logs.map(l => l.details)).toEqual(a.state!.logs.map(l => l.details));
  });

  it('round-trips during setup', () => {
    const a = goblinsVsOgre(3);
    const b = Encounter.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
    b.start();
    expect(b.phase).toBe('active');
  });
});

describe('EncounterManager', () => {
  it('creates, lists, adopts, and deletes encounters', () => {
    const m = new EncounterManager();
    const { id } = m.create({ seed: 1 });
    expect(m.list()).toHaveLength(1);
    const adopted = m.adopt(goblinsVsOgre(2));
    expect(m.get(adopted).creatures).toHaveLength(5);
    m.delete(id);
    expect(m.list()).toHaveLength(1);
    expect(() => m.get(id)).toThrow(/No encounter/);
  });
});
