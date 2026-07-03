# battlecast-engine - Design

A D&D 5e (2024 SRD) rules engine and combat state engine, extracted from
[BattleCast](https://battlecast.gg) and published as a standalone library with a
built-in MCP server. The goal: any LLM agent (Claude, a DM assistant, a benchmark
harness) can create encounters, drive combat, and query state through MCP tools,
and any TypeScript program can use the same engine directly as a library.

## Why extract

BattleCast's engine (`src/engine/`) is already pure TypeScript with zero React
imports - enforced by that repo's architecture rules. It implements:

- Dice, attack rolls, advantage/disadvantage, criticals, saves
- Damage pipeline with resistances/immunities/vulnerabilities, temp HP,
  Undead Fortitude, Death Ward, death saves and the Downed state
- Conditions with durations, save-ends timers, ongoing effects
- Footprint-aware movement and collision (Large 2x2 through Gargantuan 4x4),
  terrain blocking, line of sight
- AoE geometry (cones, lines, spheres), spellcasting, concentration, buffs
- Full AI turn loop (targeting, multiattack, smart movement, legendary actions)
- 317 SRD monsters, 12 hero classes at levels 1-20, spell data

This repo copies that engine verbatim (same file names, same invariants) and adds
two layers on top: a **state engine API** (`src/api/`) and an **MCP server**
(`src/mcp/`). D20bench proved this extraction works - it vendored the same engine
and drove it headlessly with LLM agents.

## Package layout

```
battlecast-engine/
  src/
    engine/     copied from battlecast src/engine - DO NOT diverge casually
    types/      copied from battlecast src/types (monster, animation, terrain)
    data/       copied from battlecast src/data (monsters, heroes, spells, maps, presets)
    utils/      copied pure helpers (placement)
    api/        NEW - Encounter state engine (the library's public face)
    mcp/        NEW - MCP server exposing the api layer as tools
    index.ts    library entry point
  tests/        pure vitest tests copied from battlecast + new api/mcp tests
  DESIGN.md     this file
  README.md     usage
```

Published as one npm package with two consumption modes:

1. **Library**: `import { Encounter, monsters, rollDice } from 'battlecast-engine'`
2. **MCP server**: `npx battlecast-engine mcp` (stdio transport), configured in
   any MCP client as a stdio server.

## The sync contract with BattleCast

`src/engine`, `src/types`, `src/data`, `src/utils` are a copy of BattleCast's
files, taken 2026-07-03. The single deliberate divergence is randomness (below).
When BattleCast's engine improves, re-copy the files and re-apply the RNG patch
(kept small on purpose). Long term the two repos should share this package as the
single source, with BattleCast importing it - that is the endgame, not the v0.1
requirement.

All of BattleCast's engine invariants carry over unchanged:

- `applyDamage` is the only place damage lowers HP; `gainHp` the only place
  healing raises it
- `moveToward` is the authority for voluntary movement; every position write is
  validated by `isPositionBlocked` + bounds
- Events carry `hpBefore`/`hpAfter` snapshots so replay never recomputes math
- No React, no DOM, no CSS - the engine stays pure

## Randomness and determinism

BattleCast calls `Math.random()` directly (dice, creature id suffixes, random ray
selection, random placement). A benchmark or reproducible MCP session needs
seeded determinism. Following D20bench's proven approach, but without
`node:async_hooks` so the library stays runtime-agnostic:

- New `src/engine/rng.ts`: a mulberry32 `SeededRng` plus a module-level
  `engineRandom()` that reads an injectable `RandomSource` and falls back to
  `Math.random()`
- Every `Math.random()` call site in engine code is replaced with
  `engineRandom()` (a handful of sites: dice.ts, ai-turn.ts, ai-loop.ts,
  combat.ts id suffix)
- The `Encounter` API owns a `SeededRng` per encounter and installs it around
  every engine call (`withRng(this.rng, () => ...)`). Engine calls are fully
  synchronous, so scoped install/restore is safe even with many encounters in
  one process

Same seed + same sequence of API calls = identical battle, byte for byte.

## API layer (`src/api/`)

The engine's `BattleState` is a mutable bag mutated in place by `executeRound`.
The API layer wraps it in an `Encounter` class - the "state engine":

```ts
const enc = new Encounter({ gridSize: 20, seed: 42 });
enc.addCreature('Goblin', 'red', { count: 4 });        // auto-placed
enc.addCreature('Ogre', 'blue', { position: {x: 15, y: 10} });
enc.start();                                            // rolls initiative
enc.runRound();                                         // AI plays everyone
enc.runToCompletion({ maxRounds: 50 });
enc.state                                               // raw BattleState (escape hatch)
enc.observe()                                           // LLM-friendly snapshot
enc.eventsSince(cursor)                                 // incremental event log
```

Plus manual DM controls that route through the sanctioned engine primitives:

- `damage(id, amount, type?)` -> `applyDamage`
- `heal(id, amount)` -> `applyHealing`
- `addCondition(id, condition, duration?)` / `removeCondition`
- `moveCreature(id, to)` -> validated via `isPositionBlocked` + bounds
- `removeCreature(id)`

`observe()` returns a compact, serialization-safe view designed to be read by an
LLM: round, whose turn, initiative order, per-creature hp/position/conditions/
key stats, team status, and the last N log lines. It deliberately does not dump
full statblocks (a separate `get_creature` gives detail on demand).

Serialization: `enc.toJSON()` / `Encounter.fromJSON()`. `BattleState` is plain
data except `terrainBlocked`/`terrainSightBlocked` (Sets, serialized as arrays)
and the RNG state (snapshot int). Hero/monster data referenced by creatures is
embedded on the creature (`monsterData`), so a save file is self-contained.

`EncounterManager` holds a `Map<string, Encounter>` for the MCP server: create,
get, list, delete, with generated short ids.

## MCP server (`src/mcp/`)

Built on `@modelcontextprotocol/sdk`, stdio transport, tools defined with zod
schemas. Tool surface for v0.1 (grouped):

**Content library**
- `search_monsters` - query by name substring and/or CR range, returns name/CR/type/size summaries
- `get_monster` - full statblock by name
- `list_heroes` - hero classes and level range
- (spell search deferred: spell data ships as MonsterAction factory functions,
  not a queryable table - roadmap item)

**Encounter lifecycle**
- `create_encounter` - gridSize, optional seed, optional map preset; returns encounterId
- `add_creature` - monster name or hero class+level, team red/blue, optional position, count
- `start_battle` - rolls initiative, returns order
- `get_state` - the `observe()` view; `detail: 'summary' | 'full'`
- `get_creature` - full runtime detail for one creature
- `list_encounters` / `delete_encounter`

**Simulation**
- `run_round` - AI plays one full round; returns round narration (from logs/events) + state delta
- `run_battle` - loop rounds until complete or maxRounds; returns winner + summary
- `set_team_tactics` - aggressive / smart / kiting / defensive per team

**DM controls (rules-validated state edits)**
- `apply_damage`, `apply_healing`
- `add_condition`, `remove_condition`
- `move_creature` - validated move, fails with reason if blocked/out of range... v0.1 validates blocked+bounds only
- `remove_creature`

**Dice**
- `roll_dice` - "2d6+3" notation, optional advantage/disadvantage d20 mode

Design rules for tools:

1. Every tool returns human-readable text plus structured JSON content, so both
   chat-oriented and programmatic MCP clients work
2. Errors are returned as MCP tool errors with actionable messages ("position
   (25,3) is outside the 20x20 grid"), never throws that kill the server
3. Round narration is generated from `BattleLog` entries - the engine already
   writes prose-quality log lines
4. State stays in memory, keyed by encounterId. Persistence beyond process
   lifetime is out of scope for v0.1 (an `export_encounter`/`import_encounter`
   pair covers save/load via the client)

## Testing

- Copy BattleCast's pure engine tests (the ~95 vitest suites that only import
  engine/types/data) - they pin rules behavior and protect future re-syncs
- New tests: seeded determinism (same seed twice = identical event log),
  Encounter API lifecycle, serialization round-trip, MCP tool handlers invoked
  in-process
- CI gate: `tsc -b` clean, `vitest run` green

## Licensing

Code is MIT (decided 2026-07-03). BattleCast's own LICENSE is proprietary,
which is fine for the extraction since the same author owns both repos. The
monster/spell/hero data derives from the 5.2 SRD, which is CC-BY-4.0 - the
Wizards of the Coast attribution lives in LICENSE and README and must ship
with the package.

## Roadmap after v0.1

1. **Legal-actions mode** - port D20bench's `legal-actions.ts` +
   `llm-observation.ts` so an LLM can *play a creature* action by action
   (choose from enumerated legal moves) instead of letting the AI take whole
   turns. This is the DRACE/D20bench integration point.
2. **Terrain/map tools** - expose map presets and custom wall/chasm painting
3. **Encounter difficulty tool** - `difficulty.ts` is already copied
4. **BattleCast imports this package** - close the fork
5. **Streaming** - MCP progress notifications during `run_battle`
