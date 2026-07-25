import { kaggleStep } from 'battlecast-engine/arena';

const partyPresets = {
  balanced: () => ({ characters: [{ slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }] }),
  reverse: () => ({ characters: [{ slot: 4 }, { slot: 3 }, { slot: 2 }, { slot: 1 }] }),
};

const policies = {
  aggressive: actions => actions.find(a => a.type === 'attack')
    ?? actions.find(a => a.type === 'spell')
    ?? actions.find(a => a.type === 'end_turn')
    ?? actions[0],
  caster: actions => actions.find(a => a.type === 'spell')
    ?? actions.find(a => a.type === 'attack')
    ?? actions.find(a => a.type === 'end_turn')
    ?? actions[0],
  cautious: actions => actions.find(a => a.type === 'dodge')
    ?? actions.find(a => a.type === 'spell' && /cure wounds|healing word/i.test(a.actionName ?? ''))
    ?? actions.find(a => a.type === 'attack')
    ?? actions.find(a => a.type === 'end_turn')
    ?? actions[0],
};

function wireAction(action) {
  if (action.destination && (action.type === 'move_to' || action.type === 'move_aura' || action.type === 'species_teleport' || action.type === 'spell_teleport')) {
    return { id: action.id, x: action.destination.x, y: action.destination.y };
  }
  return action;
}

const [redPolicyName = 'aggressive', bluePolicyName = 'caster'] = process.argv.slice(2);
const redPolicy = policies[redPolicyName];
const bluePolicy = policies[bluePolicyName];
if (!redPolicy || !bluePolicy) {
  console.error(`Usage: node examples/arena-4v4.mjs [${Object.keys(policies).join('|')}] [${Object.keys(policies).join('|')}]`);
  process.exit(1);
}

let response = kaggleStep({
  version: 1, mode: 'init', seed: 7, mapId: 'open-arena', roundCap: 20,
  redParty: partyPresets.balanced(), blueParty: partyPresets.reverse(),
});
let steps = 0;
while (response.statuses.red !== 'DONE' && response.statuses.blue !== 'DONE') {
  if (++steps > 1024) throw new Error('Arena exceeded the 1,024-step safety cap.');
  const team = response.statuses.red === 'ACTIVE' ? 'red' : 'blue';
  const policy = team === 'red' ? redPolicy : bluePolicy;
  const actions = response.observations[team].legalActions;
  if (!actions.length) throw new Error(`No legal actions for ${team}.`);
  const chosen = policy(actions);
  response = kaggleStep({ version: 1, mode: 'step', state: response.state, team, action: wireAction(chosen) });
}

console.log(JSON.stringify({
  redPolicy: redPolicyName,
  bluePolicy: bluePolicyName,
  winner: response.state.winner,
  rewards: response.rewards,
  rounds: response.state.round,
  steps,
}, null, 2));
