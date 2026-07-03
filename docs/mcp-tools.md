# MCP tool reference

The server (`npx battlecast-engine mcp`, stdio transport) exposes 22 tools.
Every tool returns a human-readable text block plus a JSON payload, so it
works for both chat-style agents and programmatic clients. Errors come back
as MCP tool errors with actionable messages, never as protocol failures.

Grid coordinates are zero-based cells; 1 cell = 5 ft. Creatures get stable,
guessable ids like `goblin-warrior-red-2`.

## Content library

### search_monsters
Search the SRD monster library.
- `query` (optional): name or type substring, e.g. `"dragon"`, `"undead"`
- `minCr`, `maxCr` (optional): challenge rating bounds as numbers (`0.25` = CR 1/4)

Returns name/CR/type/size/hp/ac summaries. Omit all arguments to list all 317.

### get_monster
- `name`: exact monster name, case-insensitive

Returns the full statblock (abilities, actions, traits, resistances). Unknown
names return the closest matches.

### list_heroes
No arguments. Returns the 12 hero classes with their supported level ranges
(all start at level 1; most cap at 20).

## Encounter lifecycle

### create_encounter
- `gridSize` (optional): 4-100 cells square, default 20
- `seed` (optional): string or number. Seeded encounters are fully
  deterministic: same seed + same tool calls = identical battle

Returns the `encounterId` every other tool needs.

### add_creature
Only valid before `start_battle`.
- `encounterId`
- `monster` OR `heroClass` (+ `heroLevel`, default 1)
- `team`: `red` | `blue`
- `x`, `y` (optional): explicit origin cell, validated against bounds and
  occupancy. Omit to auto-place inside the team's zone (red left, blue right)
- `count` (optional): 1-50, auto-placement only

Returns each added creature's id, display name, and position.

### start_battle
- `encounterId`

Rolls initiative for everyone and returns the turn order. Setup is frozen
from this point.

### get_state
- `encounterId`
- `logLines` (optional): recent battle-log lines to include, default 15

Returns a compact snapshot: phase, round, whose turn, per-creature
hp/position/conditions/status (ok, bloodied, dying, dead), team tallies,
and the recent log. Designed to fit in an LLM context comfortably.

### get_creature
- `encounterId`, `creatureId`

Full detail for one creature: current view, complete statblock, and active
condition timers. Use this when get_state's summary is not enough.

### list_encounters / delete_encounter
Session housekeeping. Encounters live in server memory.

## Simulation

### run_round
- `encounterId`

The engine AI plays one complete round: every creature moves, attacks,
casts, and reacts in initiative order. Returns the round's narration
(from the battle log) and whether the battle ended.

### run_battle
- `encounterId`
- `maxRounds` (optional): default 50

Loops rounds until a side wins or the cap is hit. Returns winner, rounds
played, and the survivors with remaining hp.

### set_team_tactics
- `encounterId`, `team`, `tactic`

Tactics change how the AI plays that side:
- `aggressive` - charge the nearest enemy, never retreat
- `smart` - focus fire on wounded targets, retreat when low (default)
- `kiting` - prefer ranged, keep distance, retreat early
- `defensive` - hold position, protect allies, stand ground

## DM controls

Rules-validated state edits for narrating a game rather than pure
simulation. All require an active battle.

### apply_damage
- `encounterId`, `creatureId`, `amount`, `damageType` (optional, default `force`)

Runs the full damage pipeline: resistances, immunities, vulnerabilities,
temp HP, death-avoidance traits, and the dying/dead transition. Returns
damage actually taken.

### apply_healing
- `encounterId`, `creatureId`, `amount`

Clamped at max hp; healing a dying creature revives it.

### add_condition / remove_condition
- `encounterId`, `creatureId`, `condition`, `duration` (add only, optional)

Conditions: blinded, charmed, deafened, frightened, grappled, incapacitated,
invisible, paralyzed, petrified, poisoned, prone, restrained, stunned,
unconscious. Durations: `end_of_next_turn`, `save_ends`, `one_round`,
`permanent` (default; lasts until removed). Condition immunities are
respected - applying a condition to an immune creature returns an error.

### move_creature
- `encounterId`, `creatureId`, `x`, `y`

DM teleport: validated against grid bounds, other creatures' footprints,
and terrain, but consumes no movement and provokes nothing.

### remove_creature
- `encounterId`, `creatureId`

Removes the creature entirely and re-checks the win condition.

## Persistence

### export_encounter
- `encounterId`

Returns a self-contained JSON snapshot including creature state, battle
log, and the RNG position, so a restored battle continues identically.

### import_encounter
- `snapshot`: the JSON string from export_encounter

Restores under a new encounterId.

## Dice

### roll_dice
- `notation` (e.g. `"2d6+3"`) OR `d20`: `normal` | `advantage` | `disadvantage`
- `modifier` (optional, d20 mode)
- `seed` (optional): deterministic one-off roll

## Example session

```
create_encounter { gridSize: 16, seed: 99 }        -> enc-1
add_creature    { encounterId: "enc-1", monster: "Goblin Warrior", team: "red", count: 3 }
add_creature    { encounterId: "enc-1", heroClass: "Fighter", heroLevel: 5, team: "blue" }
start_battle    { encounterId: "enc-1" }
run_round       { encounterId: "enc-1" }           -> narrated round 1
apply_damage    { encounterId: "enc-1", creatureId: "goblin-warrior-red-1", amount: 5, damageType: "fire" }
get_state       { encounterId: "enc-1" }
run_battle      { encounterId: "enc-1" }           -> winner + survivors
```
