# Rules coverage

What the engine actually implements, verified against the source (not
inferred from names), as of the 2026-07-03 extraction. Ruleset flavor is
the 2024 SRD 5.2. The honest gaps are listed at the bottom - read those
before assuming a rule exists.

## Conditions

14 conditions are tracked; 13 have mechanical effects:

| Condition | Effect |
|---|---|
| blinded | attackers gain advantage; blinded attacker has disadvantage |
| charmed | AI will not target the charm source; cleansable; Paladin Aura of Devotion grants immunity |
| deafened | tracked, cleansable, but **no mechanical effect** |
| frightened | disadvantage on attacks; cannot move closer to the fear source |
| grappled | speed 0; enables Swallow; escapable via STR check |
| incapacitated | no actions, reactions, or opportunity attacks |
| invisible | your attacks have advantage; the disadvantage-to-hit-you half is not modeled |
| paralyzed | cannot act; auto-fail; attackers advantage; melee within 5 ft auto-crits |
| petrified | treated as fully incapacitating |
| poisoned | disadvantage on attacks; carrier for ongoing damage and healing blocks |
| prone | melee attackers advantage; ranged attackers disadvantage |
| restrained | speed 0; attackers advantage; own attacks disadvantage |
| stunned | incapacitated + auto-fail saves + attackers advantage |
| unconscious | prone + incapacitated + melee auto-crit; damage wakes Sleep victims |

Advantage and disadvantage cancel to a straight roll, per the rules.
Sub-clauses not modeled: petrified/paralyzed/stunned do not grant the
nonmagical damage resistance or auto-fail-STR/DEX-saves riders beyond
what is listed above.

## Attack resolution

- d20 vs AC, melee and ranged, natural 1 fumble, crits at natural 20
  (Champion Fighter widens to 19-20 then 18-20)
- Advantage sources: Pack Tactics, Reckless Attack, Vex weapon mastery,
  Steady Aim, prone/paralyzed/stunned/unconscious/restrained/blinded
  targets, invisible attacker, Guiding Bolt rider, and more
- Disadvantage sources: prone attacker (ranged), frightened/poisoned/
  restrained/blinded attacker, long range, ranged with an adjacent enemy,
  Sap mastery, Displacement
- Auto-crit on melee attacks against paralyzed/unconscious targets
- Saving throws with per-monster save modifiers, Legendary Resistance
  (modeled as a 3-use resource), save-ends timers, 2024-style cascading
  saves (fail again, worse condition)

## Damage pipeline

- Resistances, immunities, vulnerabilities by damage type, including the
  nonmagical-only variants (bypassed by spells and magical attacks)
- Buff-sourced resistance: Rage, Fire Shield, Stoneskin, and class
  features that resist all-but-listed types
- Temporary HP absorbed before real HP; Druid Wild Shape form HP acts as
  a second pool
- HP-max reduction (Wight/Wraith Life Drain, Succubus, Clay Golem), with
  death at zero max
- Ability score drain (Shadow STR drain, death at 0 STR)
- Ongoing damage effects, including ones that block healing (Mummy Rot,
  devil poisons)

## Death and dying

Heroes go down, monsters die. Heroes at 0 HP fall unconscious and roll
death saves at turn start: 3 successes stabilise, 3 failures kill,
natural 20 pops back up at 1 HP. Damage while dying adds failures (two
for crits or adjacent melee), massive damage kills outright. A conscious
adjacent ally can spend its action to stabilise. Death-avoidance traits:
Undead Fortitude, Death Ward, Barbarian Relentless Rage.

## Movement and the grid

- Square grid, 1 cell = 5 ft, Chebyshev distance (diagonals cost 5 ft)
- Size footprints: Large 2x2, Huge 3x3, Gargantuan 4x4, with AABB
  collision everywhere (movement, placement, AoE, opportunity attacks)
- Terrain: walls (block movement + sight) and chasms (block movement
  only); line of sight via Bresenham rays gates ranged attacks and AI
  target visibility
- Flying creatures are airborne (no opportunity attacks from grounded
  melee) until they make a melee attack
- Underwater environment: halved walk speed, swim speeds used, no flight
- Forced movement: push on hit or failed save, pull toward attacker,
  weapon-mastery Push, teleports - all validated against collision

## Actions and turn economy

- Multiattack parsed from statblock text ("makes two Claw attacks and
  one Bite"), Extra Attack for martial heroes (up to 4 for Fighters)
- Opportunity attacks, footprint-aware, with free-Disengage features
  (Cunning Action, Nimble Escape) respected
- Bonus actions (Rage, Second Wind, Healing Word, Flurry of Blows...)
- Reactions: opportunity attacks, Uncanny Dodge, Deflect Attacks,
  Cutting Words, Retaliation
- Recharge abilities (breath weapons) rolled at turn start
- Legendary actions with scored plan selection; grapple + Swallow;
  container effects (Engulf, Whelm) with escape checks; death bursts
  (Balor); spell reflection (Tarrasque); Hydra head loss and regrowth
- Initiative: d20 + DEX with DEX tiebreak; Barbarian Feral Instinct;
  Rogue Thief's Reflexes (two turns in round 1)

## Spellcasting

65 leveled spells (L1 Magic Missile through L9 Meteor Swarm and Power
Word Kill) plus class cantrips. Slot tables per class and level, Warlock
Pact Magic, Mystic Arcanum, Spell Mastery and Signature Spells as free
casts. One concentration spell at a time, CON save DC max(10, damage/2)
on damage, concentration auras that tick (Spirit Guardians, Moonbeam,
Call Lightning). Upcasting is real: the AI picks the lowest sufficient
slot and scales dice by the extra levels.

## Heroes

12 classes, levels 1-20, built on a fixed 2024 standard-array chassis
with a curated feature loadout per level. Highlights actually wired into
the engine (not just statblock text):

- **Barbarian** - Rage, Reckless Attack, Brutal Strike, Retaliation, Relentless Rage
- **Bard** - Bardic Inspiration, Cutting Words, Words of Creation (L20)
- **Cleric** - Life Domain healing riders, Divine Strike, Divine Intervention
- **Druid** - Wild Shape (2024 overlay with form HP), Circle of the Land
- **Fighter** - Action Surge, Second Wind, Champion crits, 4 attacks at L20
- **Monk** - Flurry of Blows, Stunning Strike, Deflect Attacks, Quivering Palm
- **Paladin** - Divine Smite, Lay on Hands, the three Auras
- **Ranger** - Hunter's Mark, Archery style, Colossus Slayer, Nature's Veil
- **Rogue** - Sneak Attack with proper once-per-turn gating, Cunning Strike, Thief's Reflexes
- **Sorcerer** - Innate Sorcery, Seeking Spell, Elemental Affinity, Dragon Wings
- **Warlock** - Eldritch Blast + Agonizing Blast, Hex, Hurl Through Hell
- **Wizard** - Evoker: Sculpt Spells (no friendly fire), Potent Cantrip, Overchannel

## Monsters

317 statblocks, CR 0 to CR 30 (Tarrasque). Trait implementations that go
beyond numbers: Regeneration (with damage-type suppression), Pack
Tactics, Legendary Resistance, Undead Fortitude, condition-on-hit,
swallow/engulf containers, life drain, death throes, spell reflection,
Hydra heads.

## The AI

Four team tactics: `aggressive` (charge nearest, never retreat), `smart`
(default: INT-scaled targeting - smart creatures focus-fire the lowest
HP%, dumb ones hit the nearest; retreats when low), `kiting` (stay at
range, back off, retreat early), `defensive` (hold position, punish what
comes). The turn loop covers escape attempts, death saves, retreat,
target selection with line of sight, AoE placement (fires when 2+
enemies are in the area, avoids allies, respects Sculpt Spells), spell
and slot selection with upcasting, healing triage, smites, Action Surge,
and bonus actions.

## Not implemented

Be aware of these before relying on the engine for a ruling:

- **Vision and light** - no darkness, dim light, darkvision, or obscurement
- **Stealth and hiding** - the arena action path supports Hide and hidden-from observers; the general AI remains simplified
- **The Ready action** and readied triggers
- **Mounted combat** outside the arena action path; arena-controlled mounts
  and dismounts are modeled
- **Elevation** - no height model
- **PC-initiated grapple/shove** - grappling is monster-action driven
- **Rests and ritual casting** - single-encounter model, resources start full
- Assorted statblock abilities explicitly marked deferred in the data
  (Beholder Antimagic Cone, Ghost Possession, Vampire Misty Escape,
  Rust Monster corrosion, Stirge attachment), each with a reason in
  `src/data/monsters.ts`

Deafened is tracked but currently has no mechanical effect.
