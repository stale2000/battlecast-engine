import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Encounter } from '../src/api/encounter.js';
import { getActiveCreature, getLegalActions, applyLegalAction, startArena } from '../src/api/arena.js';
import { kaggleStep } from '../src/arena.js';

const party = { characters: [{ slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }] };
const init = () => ({ version: 1 as const, mode: 'init' as const, seed: 7, mapId: 'open-arena', roundCap: 2, redParty: party, blueParty: party });

describe('Kaggle arena bridge', () => {
  it('is deterministic and validates the fixed four-member party', () => {
    expect(kaggleStep(init())).toEqual(kaggleStep(init()));
    expect(() => kaggleStep({ ...init(), redParty: { characters: [{ slot: 1 }] } })).toThrow(/exactly four/);
    expect(() => kaggleStep({ ...init(), blueParty: { characters: [{ slot: 1 }, { slot: 1 }, { slot: 3 }, { slot: 4 }] } })).toThrow(/once/);
  });

  it('accepts every current legal action and rejects stale or wrong-team actions without mutation', () => {
    const initial = kaggleStep(init());
    const team = initial.statuses.red === 'ACTIVE' ? 'red' : 'blue';
    const inactiveTeam = team === 'red' ? 'blue' : 'red';
    const actions = initial.observations[team].legalActions;
    const active = initial.observations[team].activeCreatureIds[0];
    expect(kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: actions[0] }).state).toBeTruthy();
    for (const action of actions) {
      const encounter = Encounter.fromJSON(initial.state);
      applyLegalAction(encounter, action);
    }
    const before = JSON.stringify(initial.state);
    expect(() => kaggleStep({ version: 1, mode: 'step', state: initial.state, team: inactiveTeam, action: 'end_turn' })).toThrow(/does not own/);
    expect(JSON.stringify(initial.state)).toBe(before);
    expect(() => kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: 'stale' })).toThrow(/Illegal or stale/);
    expect(active).toBeTruthy();
  });

  it('keeps opponent build details out of team observations and validates custom point-buy heroes', () => {
    const customParty = {
      characters: Array.from({ length: 4 }, () => ({
        heroClass: 'Fighter',
        abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
      })),
    };
    const result = kaggleStep({ ...init(), redParty: customParty, blueParty: customParty });
    expect(result.observations.red.publicCombatState.creatures.filter(c => c.team === 'blue').every(c => !('build' in c) && !('hp' in c))).toBe(true);
    expect(() => kaggleStep({ ...init(), redParty: { characters: [{ heroClass: 'Fighter', abilities: { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 } }] } })).toThrow(/exactly four/);
  });

  it('runs opportunity attacks caused by arena movement', () => {
    const encounter = new Encounter({ seed: 1 });
    const [mover] = encounter.addCreature({ monster: 'Goblin Warrior', team: 'red', position: { x: 0, y: 0 } });
    const [guard] = encounter.addCreature({ monster: 'Goblin Warrior', team: 'blue', position: { x: 1, y: 0 } });
    const [target] = encounter.addCreature({ monster: 'Goblin Warrior', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [mover.id];
    startArena(encounter);
    const action = getLegalActions(encounter, mover.id).find(candidate => candidate.type === 'move_toward' && candidate.targetId === target.id);
    expect(action).toBeTruthy();
    applyLegalAction(encounter, action!);
    expect(encounter.state!.creatures.find(creature => creature.id === guard.id)!.reactionUsed).toBe(true);
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
  });
});
