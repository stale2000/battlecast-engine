# Simulate a 4v4 arena battle

The arena bridge is turn based. Send one `init` request, then send one `step`
request for each action. Keep the returned `state` exactly as received. The
host owns that state; an agent submits only an action.

## Fastest runnable example

Create `simulate.mjs` in a directory with `battlecast-engine` installed:

```js
import { kaggleStep } from 'battlecast-engine/arena';

const slots = () => ({ characters: [
  { slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 },
] });

let result = kaggleStep({
  version: 1,
  mode: 'init',
  seed: 7,
  mapId: 'open-arena',
  roundCap: 20,
  redParty: slots(),
  blueParty: slots(),
});

while (result.statuses.red !== 'DONE' && result.statuses.blue !== 'DONE') {
  const team = result.statuses.red === 'ACTIVE' ? 'red' : 'blue';
  const actions = result.observations[team].legalActions;
  if (!actions.length) throw new Error(`No legal actions for ${team}`);

  // This policy makes a complete deterministic smoke-test battle. Replace it
  // with an agent policy that chooses from this exact catalogue.
  const chosen = actions.find(action => action.type === 'attack')
    ?? actions.find(action => action.type === 'spell')
    ?? actions.find(action => action.type === 'end_turn')
    ?? actions[0];
  const action = chosen.type === 'move_to' && chosen.destination
    ? { id: chosen.id, x: chosen.destination.x, y: chosen.destination.y }
    : chosen;

  result = kaggleStep({ version: 1, mode: 'step', state: result.state, team, action });
}

console.log({ winner: result.state.winner, rewards: result.rewards, round: result.state.round });
```

Run it with:

```bash
npm install battlecast-engine
node simulate.mjs
```

The fixed slot party is four level-5 characters: Fighter, Cleric, Wizard, and
Rogue. For custom builds, replace each `{ slot: n }` with a validated level-5
character build. The validator enforces exactly four characters, 27-point buy,
class and equipment proficiency, the arena equipment budget, and supported
spells and species choices.

## CLI protocol

The same requests can be sent through the trusted-host CLI. Each invocation
reads exactly one JSON document and writes exactly one response document:

```bash
printf '%s\n' '{"version":1,"mode":"init","seed":7,"mapId":"open-arena","roundCap":20,"redParty":{"characters":[{"slot":1},{"slot":2},{"slot":3},{"slot":4}]},"blueParty":{"characters":[{"slot":1},{"slot":2},{"slot":3},{"slot":4}]}}' \
  | npx battlecast-engine arena kaggle-step > init-response.json
```

Read `observations.red` and `observations.blue` from the response. The team
whose status is `ACTIVE` owns the active creature and may submit one action.
Submit one object from that team's `legalActions`, preserving its ID and
engine-selected parameters. For a `move_to` action, send its destination in
the CLI shape `{ "id": "move_to", "x": 4, "y": 7 }`. Then pass the returned
`state` into the next request.

Stop when both statuses are `DONE`. Terminal rewards are `1` for the winner,
`-1` for the loser, and `0` for a draw. A non-terminal response always has
zero rewards.

## Sample AIs

The repository includes a small deterministic simulator with three intentionally
simple policies. It uses two legal level-5 presets: a balanced Fighter/Cleric/
Wizard/Rogue party and the same party in reverse slot order.

```bash
npm run build
node examples/arena-4v4.mjs aggressive caster
```

Available policies are:

- `aggressive` - prefer weapon attacks, then spells, then movement.
- `caster` - prefer any available spell, then attacks and movement.
- `cautious` - prefer Dodge, healing spells, attacks, then ending the turn.

Run a different matchup with:

```bash
node examples/arena-4v4.mjs cautious aggressive
node examples/arena-4v4.mjs caster caster
```

These are reference policies, not competitive agents. They choose only from
the current legal-action catalogue; the engine still validates every target,
destination, resource cost, roll, and state transition.

## What is authoritative

- The serialized state returned by the engine is authoritative and must not be
  edited by a caller.
- Legal actions are regenerated from that state on every step.
- Unknown, stale, malformed, or wrong-team actions are rejected before any
  mutation.
- Targets, damage, dice, movement legality, resources, and the seeded RNG are
  selected and resolved by the engine.
