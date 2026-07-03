# battlecast-engine

A D&D 5e (2024 SRD) rules engine and combat state engine, with a built-in
[MCP](https://modelcontextprotocol.io) server. Extracted from
[BattleCast](https://battlecast.gg), the browser-based tactical combat
simulator that runs this engine in production - every rule here is
battle-tested against thousands of simulated encounters.

Any LLM agent connected over MCP can build encounters, run tactically
simulated combat, and make rules-validated state edits. Any TypeScript
program can use the same engine directly as a library. Battles are
deterministic when seeded: same seed, same result, byte for byte - which
makes it equally suited to DM assistants, encounter balancing, regression
testing, and LLM benchmarks.

**What is inside**

- Dice, attacks, advantage/disadvantage, criticals, saving throws
- Full damage pipeline: resistances, immunities, vulnerabilities, temp HP,
  Undead Fortitude, Death Ward, death saves, the dying state
- Conditions with durations and save-ends timers, ongoing effects
- Footprint-aware movement and collision on a grid (Medium through
  Gargantuan), terrain blocking, line of sight
- AoE geometry (cones, lines, spheres), spellcasting, concentration, buffs
- A complete combat AI (targeting, multiattack, smart movement, legendary
  actions) with four team tactics
- 82 SRD monsters and 12 hero classes at levels 1-20
- Seeded, reproducible battles: same seed, same result, byte for byte

## MCP server

```bash
npx battlecast-engine mcp
```

Claude Code:

```bash
claude mcp add battlecast -- npx battlecast-engine mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "battlecast": { "command": "npx", "args": ["battlecast-engine", "mcp"] }
  }
}
```

### Tools

| Group | Tools |
|---|---|
| Library | `search_monsters`, `get_monster`, `list_heroes` |
| Lifecycle | `create_encounter`, `add_creature`, `start_battle`, `get_state`, `get_creature`, `list_encounters`, `delete_encounter` |
| Simulation | `run_round`, `run_battle`, `set_team_tactics` |
| DM controls | `apply_damage`, `apply_healing`, `add_condition`, `remove_condition`, `move_creature`, `remove_creature` |
| Persistence | `export_encounter`, `import_encounter` |
| Dice | `roll_dice` |

A typical session: `create_encounter` (optionally seeded), `add_creature` a
few times, `start_battle`, then either `run_round` for narrated round-by-round
play or `run_battle` for an instant result. `get_state` returns a compact
snapshot designed to be read by a language model. Round narration comes
straight from the engine's battle log:

```
Round 1:
[R1] Fighter L5 moves 30 ft toward Goblin Warrior 2.
[R1] Fighter L5 hits Goblin Warrior 2 with Javelin (15 vs AC 15) for 10 piercing damage!
[R1] Goblin Warrior 2 has been slain!
[R1] Fighter L5 uses Action Surge for an extra attack action!
```

## Library

```ts
import { Encounter } from 'battlecast-engine';

const enc = new Encounter({ gridSize: 20, seed: 42 });
enc.addCreature({ monster: 'Goblin Warrior', team: 'red', count: 4 });
enc.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'blue' });
enc.start();

const round = enc.runRound();        // AI plays one full round
console.log(round.logs.map(l => l.details).join('\n'));

enc.damage('goblin-warrior-red-1', 8, 'fire');   // full rules pipeline
const result = enc.runToCompletion(50);
console.log(result.winner);
```

Lower-level engine primitives (`applyDamage`, `resolveAttack`, `moveToward`,
`executeRound`, monster and hero data) are exported too - see `src/index.ts`.

## Built with battlecast-engine?

The code is MIT, so you owe nothing beyond keeping the license file. But if
this engine saved you from reimplementing opportunity attacks, a link back
means a lot and helps the project:

- Link to [battlecast.gg](https://battlecast.gg) or this repo in your README
  or credits
- A "powered by battlecast-engine" line in your app's about screen is the
  gold standard

If you build something with it, open an issue and say hi - cool projects get
listed here.

## Development

```bash
npm install
npm run build       # tsc
npm test            # vitest - engine suite ported from BattleCast + api tests
```

Read `DESIGN.md` for the architecture, the sync contract with BattleCast,
and the roadmap.

## License and SRD attribution

Code is MIT licensed (see LICENSE).
Monster, spell, and class data derive from the Dungeons & Dragons 5.2 System
Reference Document, released under CC-BY-4.0 by Wizards of the Coast.
