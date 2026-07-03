# battlecast-engine - instructions for AI coding agents

Read DESIGN.md before changing anything - it explains the architecture, the
sync contract with BattleCast, and the MCP tool surface.

## What this is

A D&D 5e rules engine + combat state engine + MCP server, extracted from the
BattleCast repo (../battlecast). Published as one npm package: library entry
`src/index.ts`, MCP stdio server via `battlecast-engine mcp`.

## Layout and rules

- `src/engine`, `src/types`, `src/data`, `src/utils` are COPIED from
  BattleCast (2026-07-03) plus one deliberate divergence: all Math.random()
  call sites go through `engineRandom()` in `src/engine/rng.ts`. Do not let
  these directories drift from upstream casually - fixes to rules logic
  belong in BattleCast first, then get re-copied here (re-apply the RNG
  patch and the `.js` import-extension rewrite).
- `src/api` is the state engine (Encounter, EncounterManager, observation,
  serialization). `src/mcp` is a thin adapter - no rules logic there.
- All BattleCast engine invariants apply: damage only through `applyDamage`,
  healing only through `gainHp`/`applyHealing`, every position write
  validated with `isPositionBlocked` + bounds, engine stays pure (no React,
  no DOM, no Node-only APIs in src/engine).
- ESM with NodeNext resolution: relative imports need explicit `.js`
  extensions.
- No em dashes in docs or user-facing copy - use hyphens.

## Commands

```bash
npm run build     # tsc -b, must be clean
npm test          # vitest, must be green (engine suite + api suite)
npm run mcp       # run the MCP server from dist/
```

Tests in `tests/` are mostly ported from BattleCast and pin rules behavior -
they protect future re-syncs. New feature work needs new tests.

## Before publishing to npm

The LICENSE is a proprietary placeholder. Bartosz must pick a public license
(MIT or Apache-2.0 recommended) and keep the CC-BY-4.0 SRD attribution.

## Owner

Bartosz Jedrzejewski (github: opengandalf / bjedrzejewski). Related repos:
../battlecast (upstream engine), ../D20bench (LLM benchmark that vendors an
older copy of the same engine; its legal-actions.ts is the model for the
planned per-action LLM control mode - see DESIGN.md roadmap).
