import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Encounter } from '../src/api/encounter.js';
import { getActiveCreature, getLegalActions, applyLegalAction, startArena } from '../src/api/arena.js';
import { reachableMovementDestinations } from '../src/engine/ai-movement.js';
import { hasDisadvantage, resolveAttack } from '../src/engine/combat.js';
import { ARENA_ROUND_CAP, kaggleStep } from '../src/arena.js';
import { HERO_CLASS_NAMES } from '../src/data/heroes.js';

const party = { characters: [{ slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }] };
const init = () => ({ version: 1 as const, mode: 'init' as const, seed: 7, mapId: 'open-arena', roundCap: ARENA_ROUND_CAP, redParty: party, blueParty: party });

describe('Kaggle arena bridge', () => {
  it('is deterministic and validates the fixed four-member party', () => {
    expect(kaggleStep(init())).toEqual(kaggleStep(init()));
    expect(() => kaggleStep({ ...init(), roundCap: ARENA_ROUND_CAP - 1 })).toThrow(/roundCap/);
    expect(() => kaggleStep({ ...init(), redParty: { characters: [{ slot: 1 }] } })).toThrow(/exactly four/);
    expect(() => kaggleStep({ ...init(), blueParty: { characters: [{ slot: 1 }, { slot: 1 }, { slot: 3 }, { slot: 4 }] } })).toThrow(/once/);
  });

  it('accepts every current legal action and rejects stale or wrong-team actions without mutation', () => {
    const initial = kaggleStep(init());
    const team = initial.statuses.red === 'ACTIVE' ? 'red' : 'blue';
    const inactiveTeam = team === 'red' ? 'blue' : 'red';
    const actions = initial.observations[team].legalActions;
    const active = initial.observations[team].activeCreatureIds[0];
    expect(kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: actions.find(action => action.type !== 'move_to')! }).state).toBeTruthy();
    for (const action of actions) {
      const encounter = Encounter.fromJSON(initial.state);
      if (action.type === 'move_to') {
        const activeCreature = getActiveCreature(encounter)!;
        const destination = reachableMovementDestinations(activeCreature, encounter.state!)[0]!;
        applyLegalAction(encounter, { ...action, destination: { x: destination.x, y: destination.y } });
      } else {
        applyLegalAction(encounter, action);
      }
    }
    const before = JSON.stringify(initial.state);
    expect(() => kaggleStep({ version: 1, mode: 'step', state: initial.state, team: inactiveTeam, action: 'end_turn' })).toThrow(/does not own/);
    expect(JSON.stringify(initial.state)).toBe(before);
    expect(() => kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: 'stale' })).toThrow(/Illegal or stale/);
    if (actions.some(action => action.type === 'move_to')) {
      expect(() => kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: { id: 'move_to', x: -1, y: -1 } })).toThrow(/move destination/);
      expect(JSON.stringify(initial.state)).toBe(before);
    }
    expect(active).toBeTruthy();
  });

  it('rejects a restored arena state with a changed round cap', () => {
    const initial = kaggleStep(init());
    const team = initial.statuses.red === 'ACTIVE' ? 'red' : 'blue';
    const tampered = structuredClone(initial.state);
    tampered.arenaRoundCap = 1;
    expect(() => kaggleStep({ version: 1, mode: 'step', state: tampered, team, action: 'end_turn' })).toThrow(/roundCap/);
  });

  it('makes Dodge impose disadvantage and consumes Steady Aim after one attack', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Rogue', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    const state = encounter.state!;
    const rogue = state.creatures.find(creature => creature.team === 'red')!;
    const target = state.creatures.find(creature => creature.team === 'blue')!;
    const attack = rogue.monsterData.actions.find(action => action.attackBonus !== undefined)!;
    target.turnFlags.dodge = true;
    expect(hasDisadvantage(rogue, target, attack)).toBe(true);
    delete target.turnFlags.dodge;
    rogue.turnFlags.steadyAim = true;
    encounter.runWithRng(() => resolveAttack(state, rogue, target, attack));
    expect(rogue.turnFlags.steadyAimConsumed).toBe(true);
  });

  it('keeps opponent build details out of team observations and validates custom point-buy heroes', () => {
    const customParty = {
      characters: Array.from({ length: 4 }, () => ({
        heroClass: 'Fighter',
        abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
      })),
    };
    const result = kaggleStep({ ...init(), redParty: customParty, blueParty: customParty });
    expect(result.observations.red.publicCombatState.creatures.filter(c => c.team === 'blue').every(c => !('build' in c) && !('hp' in c) && 'creatureType' in c && 'visibleEquipment' in c)).toBe(true);
    expect(result.observations.red.publicCombatState.creatures.filter(c => c.team === 'red').every(c => 'build' in c && 'preparedSpells' in c.build && 'equipment' in c.build)).toBe(true);
    expect(() => kaggleStep({ ...init(), redParty: { characters: [{ heroClass: 'Fighter', abilities: { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 } }] } })).toThrow(/exactly four/);
  });

  it('accepts only engine-listed spell selections for custom casters', () => {
    const wizard = {
      heroClass: 'Wizard', abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      spells: ['Magic Missile', 'Burning Hands', 'Thunderwave', 'Sleep', 'Scorching Ray', 'Web', 'Fireball', 'Lightning Bolt'],
    };
    const casterParty = { characters: Array.from({ length: 4 }, () => wizard) };
    expect(kaggleStep({ ...init(), redParty: casterParty, blueParty: casterParty }).state).toBeTruthy();
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...wizard, spells: ['Wish'] })) }, blueParty: casterParty })).toThrow(/spells/);
  });

  it('accepts only exact reachable move destinations and runs opportunity attacks', () => {
    const encounter = new Encounter({ seed: 1 });
    const [mover] = encounter.addCreature({ monster: 'Goblin Warrior', team: 'red', position: { x: 0, y: 0 } });
    const [guard] = encounter.addCreature({ monster: 'Goblin Warrior', team: 'blue', position: { x: 1, y: 0 } });
    encounter.addCreature({ monster: 'Goblin Warrior', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [mover.id];
    startArena(encounter);
    const action = getLegalActions(encounter, mover.id).find(candidate => candidate.type === 'move_to');
    expect(action).toBeTruthy();
    const destination = reachableMovementDestinations(getActiveCreature(encounter)!, encounter.state!).find(cell => cell.x === 0 && cell.y === 2)!;
    expect(destination).toBeTruthy();
    applyLegalAction(encounter, { ...action!, destination: { x: destination.x, y: destination.y } });
    expect(encounter.state!.creatures.find(creature => creature.id === guard.id)!.reactionUsed).toBe(true);
  });

  it('offers and resolves supported resource actions without trusting client parameters', () => {
    const encounter = new Encounter({ seed: 1 });
    const [fighter] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [fighter.id];
    const active = encounter.state!.creatures.find(creature => creature.id === fighter.id)!;
    active.currentHp -= 10;
    startArena(encounter);
    const action = getLegalActions(encounter, fighter.id).find(candidate => candidate.type === 'spell' && candidate.actionName === 'Second Wind');
    expect(action).toBeTruthy();
    const before = active.currentHp;
    const uses = active.resources['second-wind'];
    applyLegalAction(encounter, action!);
    expect(active.currentHp).toBeGreaterThan(before);
    expect(active.resources['second-wind']).toBe(uses - 1);
  });

  it('keeps a multiattack creature active until every attack roll is spent', () => {
    const encounter = new Encounter({ seed: 1 });
    const [fighter] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [fighter.id];
    startArena(encounter);
    const first = getLegalActions(encounter, fighter.id).find(action => action.type === 'attack')!;
    applyLegalAction(encounter, first);
    expect(getLegalActions(encounter, fighter.id).some(action => action.type === 'attack')).toBe(true);
    applyLegalAction(encounter, getLegalActions(encounter, fighter.id).find(action => action.type === 'attack')!);
    expect(getLegalActions(encounter, fighter.id).some(action => action.type === 'attack')).toBe(false);
    const surge = getLegalActions(encounter, fighter.id).find(action => action.type === 'action_surge');
    expect(surge).toBeTruthy();
    applyLegalAction(encounter, surge!);
    expect(getLegalActions(encounter, fighter.id).some(action => action.type === 'attack')).toBe(true);
  });

  it('keeps canonical AoE and dart target sets engine-owned', () => {
    const initial = kaggleStep(init());
    const team = initial.statuses.red === 'ACTIVE' ? 'red' : 'blue';
    const darts = initial.observations[team].legalActions.find(action => action.type === 'spell' && action.actionName === 'Magic Missile');
    const area = initial.observations[team].legalActions.find(action => action.type === 'spell' && action.actionName === 'Fireball');
    expect(darts?.targetIds).toHaveLength(3);
    expect(area?.targetIds?.length).toBeGreaterThan(0);
    expect(kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: darts! }).state).toBeTruthy();
  });

  it('applies every exposed action across a complete party turn cycle', () => {
    let result = kaggleStep(init());
    for (let turn = 0; turn < 8; turn++) {
      const team = result.statuses.red === 'ACTIVE' ? 'red' : 'blue';
      for (const action of result.observations[team].legalActions) {
        if (action.type === 'move_to') {
          const encounter = Encounter.fromJSON(result.state);
          const destination = reachableMovementDestinations(getActiveCreature(encounter)!, encounter.state!)[0]!;
          expect(() => kaggleStep({ version: 1, mode: 'step', state: result.state, team, action: { id: action.id, x: destination.x, y: destination.y } })).not.toThrow();
        } else {
          expect(() => kaggleStep({ version: 1, mode: 'step', state: result.state, team, action })).not.toThrow();
        }
      }
      result = kaggleStep({ version: 1, mode: 'step', state: result.state, team, action: 'end_turn' });
    }
  });

  it('offers only valid Wild Shape forms and applies the selected form', () => {
    const encounter = new Encounter({ seed: 1 });
    const [druid] = encounter.addCreature({ heroClass: 'Druid', heroLevel: 5, heroOverrides: { subclass: 'Circle of the Moon' }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 5, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [druid.id];
    startArena(encounter);
    const action = getLegalActions(encounter, druid.id).find(candidate => candidate.type === 'wild_shape');
    expect(action).toBeTruthy();
    applyLegalAction(encounter, action!);
    expect(encounter.state!.creatures.find(creature => creature.id === druid.id)!.wildShape?.beastName).toBe(action!.beastName);
  });

  it('resolves Monk Flurry of Blows as two server-selected strikes', () => {
    const encounter = new Encounter({ seed: 1 });
    const [monk] = encounter.addCreature({ heroClass: 'Monk', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [monk.id];
    startArena(encounter);
    applyLegalAction(encounter, getLegalActions(encounter, monk.id).find(action => action.type === 'attack')!);
    applyLegalAction(encounter, getLegalActions(encounter, monk.id).find(action => action.type === 'attack')!);
    const flurry = getLegalActions(encounter, monk.id).find(action => action.type === 'monk_strike' && action.flurry);
    expect(flurry).toBeTruthy();
    applyLegalAction(encounter, flurry!);
    expect(getLegalActions(encounter, monk.id).some(action => action.type === 'monk_strike' && action.flurry)).toBe(true);
  });

  it('resolves every exposed action for every supported level-5 class', () => {
    for (const heroClass of HERO_CLASS_NAMES) {
      const encounter = new Encounter({ seed: 1 });
      const [hero] = encounter.addCreature({ heroClass, heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
      encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
      encounter.start();
      encounter.state!.initiativeOrder = [hero.id];
      startArena(encounter);
      const snapshot = encounter.toJSON();
      for (const action of getLegalActions(encounter, hero.id)) {
        const copy = Encounter.fromJSON(snapshot);
        if (action.type === 'move_to') {
          const destination = reachableMovementDestinations(getActiveCreature(copy)!, copy.state!)[0]!;
          expect(() => applyLegalAction(copy, { ...action, destination: { x: destination.x, y: destination.y } })).not.toThrow();
        } else {
          expect(() => applyLegalAction(copy, action)).not.toThrow();
        }
      }
    }
  });

  it('ends at the configured round cap and keeps CLI protocol output on stdout', () => {
    const playToCap = () => {
      let result = kaggleStep(init());
      while (result.statuses.red !== 'DONE') {
        const team = result.statuses.red === 'ACTIVE' ? 'red' : 'blue';
        result = kaggleStep({ version: 1, mode: 'step', state: result.state, team, action: 'end_turn' });
      }
      return result;
    };
    const result = playToCap();
    expect(playToCap()).toEqual(result);
    expect(result.rewards.red).toBeGreaterThanOrEqual(-1);
    const cli = spawnSync(process.execPath, ['dist/mcp/cli.js', 'arena', 'kaggle-step'], { input: JSON.stringify(init()), encoding: 'utf8' });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout).state).toBeTruthy();
    expect(cli.stderr).toBe('');
    const malformed = spawnSync(process.execPath, ['dist/mcp/cli.js', 'arena', 'kaggle-step'], { input: '{', encoding: 'utf8' });
    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toBe('');
    expect(malformed.stderr).toMatch(/^INVALID_REQUEST:/);
    const validParty = spawnSync(process.execPath, ['dist/mcp/cli.js', 'arena', 'validate-party'], {
      input: JSON.stringify({ team: 'red', party }), encoding: 'utf8',
    });
    expect(validParty.status).toBe(0);
    expect(validParty.stdout).toBe('{"valid":true}\n');
  });
});
