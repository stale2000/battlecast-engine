// MCP server exposing the battlecast-engine state engine as tools.
// Thin adapter: every tool parses input, calls the api layer, and formats
// a text + JSON reply. All rules logic stays in src/engine and src/api.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EncounterManager } from '../api/manager.js';
import { Encounter, EncounterError, type SerializedEncounter, type Team } from '../api/encounter.js';
import { SeededRng } from '../engine/rng.js';
import { observeEncounter, formatLog, viewCreature } from '../api/observation.js';
import { getMonsterByName, searchMonsters, monsters, crToNumber } from '../data/monsters.js';
import { HERO_CLASS_NAMES, getMaxHeroLevelForClass } from '../data/heroes.js';
import { rollDice, rollAttack } from '../engine/dice.js';
import { withRng } from '../engine/rng.js';
import type { TacticType } from '../engine/combat.js';
import type { Condition, ConditionDuration } from '../types/monster.js';

const CONDITIONS = [
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated',
  'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained',
  'stunned', 'unconscious',
] as const;

const DURATIONS = ['end_of_next_turn', 'save_ends', 'permanent', 'one_round'] as const;

const teamSchema = z.enum(['red', 'blue']).describe('Which side the creature fights for');

type ToolReply = { content: { type: 'text'; text: string }[]; isError?: boolean };

function reply(text: string, data?: unknown): ToolReply {
  const content: ToolReply['content'] = [{ type: 'text', text }];
  if (data !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(data, null, 2) });
  }
  return content.length ? { content } : { content };
}

function errorReply(error: unknown): ToolReply {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Wrap a handler so api-layer errors come back as MCP tool errors. */
function guarded<A extends unknown[]>(fn: (...args: A) => ToolReply | Promise<ToolReply>) {
  return async (...args: A): Promise<ToolReply> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof EncounterError) return errorReply(error);
      throw error;
    }
  };
}

export function createServer(): McpServer {
  const manager = new EncounterManager();

  const server = new McpServer({
    name: 'battlecast-engine',
    version: '0.1.0',
  });

  // ---- Content library ----

  server.registerTool('search_monsters', {
    title: 'Search monsters',
    description: 'Search the SRD monster library by name, type, or CR. Returns summaries; use get_monster for a full statblock.',
    inputSchema: {
      query: z.string().optional().describe('Name or type substring, e.g. "dragon"'),
      minCr: z.number().optional().describe('Minimum challenge rating, e.g. 0.25'),
      maxCr: z.number().optional().describe('Maximum challenge rating'),
    },
  }, guarded(({ query, minCr, maxCr }) => {
    let results = query ? searchMonsters(query) : [...monsters];
    if (minCr !== undefined) results = results.filter(m => crToNumber(m.cr) >= minCr);
    if (maxCr !== undefined) results = results.filter(m => crToNumber(m.cr) <= maxCr);
    const summaries = results.map(m => ({ name: m.name, cr: m.cr, type: m.type, size: m.size, hp: m.hp, ac: m.ac }));
    return reply(`${summaries.length} monster(s) found.`, summaries);
  }));

  server.registerTool('get_monster', {
    title: 'Get monster statblock',
    description: 'Full statblock for one monster by exact name (case-insensitive).',
    inputSchema: { name: z.string() },
  }, guarded(({ name }) => {
    const monster = getMonsterByName(name);
    if (!monster) {
      const close = searchMonsters(name).slice(0, 5).map(m => m.name);
      return errorReply(new Error(`Unknown monster "${name}".${close.length ? ` Closest: ${close.join(', ')}` : ''}`));
    }
    return reply(`${monster.name} (CR ${monster.cr})`, monster);
  }));

  server.registerTool('list_heroes', {
    title: 'List hero classes',
    description: 'Hero classes that can be added to an encounter, with supported level ranges.',
    inputSchema: {},
  }, guarded(() => {
    const heroes = HERO_CLASS_NAMES.map(name => ({ class: name, minLevel: 1, maxLevel: getMaxHeroLevelForClass(name) }));
    return reply('Available hero classes.', heroes);
  }));

  // ---- Encounter lifecycle ----

  server.registerTool('create_encounter', {
    title: 'Create encounter',
    description: 'Create a new empty encounter on a square grid (1 cell = 5 ft). Returns the encounterId used by every other tool. Pass a seed for reproducible battles.',
    inputSchema: {
      gridSize: z.number().int().min(4).max(100).optional().describe('Grid width/height in cells, default 20'),
      seed: z.union([z.string(), z.number()]).optional().describe('Deterministic RNG seed'),
    },
  }, guarded(({ gridSize, seed }) => {
    const { id } = manager.create({ gridSize, seed });
    return reply(`Encounter ${id} created (${gridSize ?? 20}x${gridSize ?? 20} grid${seed !== undefined ? `, seed ${seed}` : ''}).`, { encounterId: id });
  }));

  server.registerTool('add_creature', {
    title: 'Add creature',
    description: 'Add a monster (by name) or a hero (by class and level) to an encounter during setup. Auto-places in the team zone unless a position is given.',
    inputSchema: {
      encounterId: z.string(),
      monster: z.string().optional().describe('SRD monster name, e.g. "Goblin"'),
      heroClass: z.string().optional().describe(`Hero class: ${HERO_CLASS_NAMES.join(', ')}`),
      heroLevel: z.number().int().min(1).max(20).optional(),
      team: teamSchema,
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      count: z.number().int().min(1).max(50).optional(),
    },
  }, guarded(({ encounterId, monster, heroClass, heroLevel, team, x, y, count }) => {
    const enc = manager.get(encounterId);
    const position = x !== undefined && y !== undefined ? { x, y } : undefined;
    const added = enc.addCreature({ monster, heroClass, heroLevel, team: team as Team, position, count });
    const names = added.map(a => `${a.name} [${a.id}] at (${a.position.x}, ${a.position.y})`).join('; ');
    return reply(`Added ${added.length} creature(s): ${names}`, added);
  }));

  server.registerTool('start_battle', {
    title: 'Start battle',
    description: 'Roll initiative and begin combat. No more creatures can be added after this.',
    inputSchema: { encounterId: z.string() },
  }, guarded(({ encounterId }) => {
    const { initiativeOrder } = manager.get(encounterId).start();
    const order = initiativeOrder.map((e, i) => `${i + 1}. ${e.name} [${e.id}] (${e.initiative})`).join('\n');
    return reply(`Battle started. Initiative order:\n${order}`, initiativeOrder);
  }));

  server.registerTool('get_state', {
    title: 'Get encounter state',
    description: 'Snapshot of the encounter: round, teams, every creature with hp/position/conditions, and recent battle log.',
    inputSchema: {
      encounterId: z.string(),
      logLines: z.number().int().min(0).max(200).optional().describe('How many recent log lines to include, default 15'),
    },
  }, guarded(({ encounterId, logLines }) => {
    const view = observeEncounter(manager.get(encounterId), logLines ?? 15);
    return reply(`Encounter ${encounterId}: ${view.phase}, round ${view.round}. Red ${view.teams.red.alive}/${view.teams.red.total} alive, Blue ${view.teams.blue.alive}/${view.teams.blue.total} alive.`, view);
  }));

  server.registerTool('get_creature', {
    title: 'Get creature detail',
    description: 'Full runtime detail for one creature: statblock, current hp, conditions, position, resources.',
    inputSchema: { encounterId: z.string(), creatureId: z.string() },
  }, guarded(({ encounterId, creatureId }) => {
    const enc = manager.get(encounterId);
    const creature = enc.creatures.find(c => c.id === creatureId);
    if (!creature) return errorReply(new Error(`No creature "${creatureId}" in ${encounterId}.`));
    return reply(`${creature.displayName}`, { view: viewCreature(creature), statblock: creature.monsterData, conditionTimers: creature.conditionTimers });
  }));

  server.registerTool('list_encounters', {
    title: 'List encounters',
    description: 'All encounters in this server session.',
    inputSchema: {},
  }, guarded(() => reply('Active encounters.', manager.list())));

  server.registerTool('delete_encounter', {
    title: 'Delete encounter',
    description: 'Remove an encounter from the session.',
    inputSchema: { encounterId: z.string() },
  }, guarded(({ encounterId }) => {
    manager.delete(encounterId);
    return reply(`Encounter ${encounterId} deleted.`);
  }));

  // ---- Simulation ----

  server.registerTool('run_round', {
    title: 'Run one round',
    description: 'The engine AI plays one full round for every creature in initiative order. Returns the round narration.',
    inputSchema: { encounterId: z.string() },
  }, guarded(({ encounterId }) => {
    const result = manager.get(encounterId).runRound();
    const narration = result.logs.map(formatLog).join('\n') || '(nothing happened)';
    const status = result.isComplete ? `Battle complete - winner: ${result.winner}.` : 'Battle continues.';
    return reply(`Round ${result.round}:\n${narration}\n\n${status}`, {
      round: result.round,
      isComplete: result.isComplete,
      winner: result.winner,
      eventCount: result.events.length,
    });
  }));

  server.registerTool('run_battle', {
    title: 'Run battle to completion',
    description: 'Loop rounds until one side wins or maxRounds is reached. Returns the winner and a summary; use get_state for details.',
    inputSchema: {
      encounterId: z.string(),
      maxRounds: z.number().int().min(1).max(200).optional().describe('Default 50'),
    },
  }, guarded(({ encounterId, maxRounds }) => {
    const enc = manager.get(encounterId);
    const result = enc.runToCompletion(maxRounds ?? 50);
    const view = observeEncounter(enc, 10);
    const outcome = result.isComplete
      ? `Winner: ${result.winner} after ${view.round - 1} round(s).`
      : `No winner after ${result.rounds} round(s) (maxRounds reached).`;
    return reply(outcome, { ...result, survivors: view.creatures.filter(c => c.status !== 'dead').map(c => `${c.name} (${c.hp})`) });
  }));

  server.registerTool('set_team_tactics', {
    title: 'Set team tactics',
    description: 'Change how the AI plays a team: aggressive, smart, kiting, or defensive.',
    inputSchema: {
      encounterId: z.string(),
      team: teamSchema,
      tactic: z.enum(['aggressive', 'smart', 'kiting', 'defensive']),
    },
  }, guarded(({ encounterId, team, tactic }) => {
    manager.get(encounterId).setTeamTactics(team as Team, tactic as TacticType);
    return reply(`Team ${team} now plays ${tactic}.`);
  }));

  // ---- DM controls ----

  server.registerTool('apply_damage', {
    title: 'Apply damage',
    description: 'Deal damage to a creature through the full rules pipeline (resistances, immunities, temp HP, death and dying).',
    inputSchema: {
      encounterId: z.string(),
      creatureId: z.string(),
      amount: z.number().min(1),
      damageType: z.string().optional().describe('e.g. fire, slashing. Default force.'),
    },
  }, guarded(({ encounterId, creatureId, amount, damageType }) => {
    const result = manager.get(encounterId).damage(creatureId, amount, damageType ?? 'force');
    return reply(`${creatureId} takes ${result.taken} damage. Now ${result.currentHp} hp${result.isAlive ? '' : ' - DEAD'}.`, result);
  }));

  server.registerTool('apply_healing', {
    title: 'Apply healing',
    description: 'Heal a creature (clamped at max hp, revives the dying).',
    inputSchema: { encounterId: z.string(), creatureId: z.string(), amount: z.number().min(1) },
  }, guarded(({ encounterId, creatureId, amount }) => {
    const result = manager.get(encounterId).heal(creatureId, amount);
    return reply(`${creatureId} healed to ${result.currentHp}/${result.maxHp} hp.`, result);
  }));

  server.registerTool('add_condition', {
    title: 'Add condition',
    description: 'Apply a condition to a creature (respects condition immunities).',
    inputSchema: {
      encounterId: z.string(),
      creatureId: z.string(),
      condition: z.enum(CONDITIONS),
      duration: z.enum(DURATIONS).optional().describe('Default permanent (until removed)'),
    },
  }, guarded(({ encounterId, creatureId, condition, duration }) => {
    const result = manager.get(encounterId).addCondition(creatureId, condition as Condition, (duration ?? 'permanent') as ConditionDuration);
    return reply(`${creatureId} is now ${condition}. Conditions: ${result.conditions.join(', ')}.`, result);
  }));

  server.registerTool('remove_condition', {
    title: 'Remove condition',
    description: 'Remove a condition from a creature.',
    inputSchema: { encounterId: z.string(), creatureId: z.string(), condition: z.enum(CONDITIONS) },
  }, guarded(({ encounterId, creatureId, condition }) => {
    const result = manager.get(encounterId).removeCondition(creatureId, condition as Condition);
    return reply(`${condition} removed. Conditions: ${result.conditions.join(', ') || '(none)'}.`, result);
  }));

  server.registerTool('move_creature', {
    title: 'Move creature',
    description: 'DM-place a creature at a grid cell. Validated against grid bounds, other creatures, and terrain; does not consume movement.',
    inputSchema: { encounterId: z.string(), creatureId: z.string(), x: z.number().int(), y: z.number().int() },
  }, guarded(({ encounterId, creatureId, x, y }) => {
    const result = manager.get(encounterId).moveCreature(creatureId, { x, y });
    return reply(`${creatureId} moved to (${result.position.x}, ${result.position.y}).`, result);
  }));

  server.registerTool('remove_creature', {
    title: 'Remove creature',
    description: 'Remove a creature from the encounter entirely.',
    inputSchema: { encounterId: z.string(), creatureId: z.string() },
  }, guarded(({ encounterId, creatureId }) => {
    manager.get(encounterId).removeCreature(creatureId);
    return reply(`${creatureId} removed.`);
  }));

  // ---- Persistence ----

  server.registerTool('export_encounter', {
    title: 'Export encounter',
    description: 'Serialize an encounter (including RNG state) to JSON for saving. Restore with import_encounter.',
    inputSchema: { encounterId: z.string() },
  }, guarded(({ encounterId }) => {
    const snapshot = manager.get(encounterId).toJSON();
    return reply(`Encounter ${encounterId} exported.`, snapshot);
  }));

  server.registerTool('import_encounter', {
    title: 'Import encounter',
    description: 'Restore an encounter from an export_encounter snapshot. Returns a new encounterId.',
    inputSchema: { snapshot: z.string().describe('JSON produced by export_encounter') },
  }, guarded(({ snapshot }) => {
    let parsed: SerializedEncounter;
    try {
      parsed = JSON.parse(snapshot) as SerializedEncounter;
    } catch {
      return errorReply(new Error('snapshot is not valid JSON.'));
    }
    const encounter = Encounter.fromJSON(parsed);
    const id = manager.adopt(encounter);
    return reply(`Encounter imported as ${id} (${encounter.phase}).`, { encounterId: id });
  }));

  // ---- Dice ----

  server.registerTool('roll_dice', {
    title: 'Roll dice',
    description: 'Roll dice notation like "2d6+3" or a d20 with advantage/disadvantage.',
    inputSchema: {
      notation: z.string().optional().describe('e.g. "2d6+3", "8d6"'),
      d20: z.enum(['normal', 'advantage', 'disadvantage']).optional().describe('Roll a d20 instead of notation'),
      modifier: z.number().int().optional().describe('Modifier for d20 rolls'),
      seed: z.union([z.string(), z.number()]).optional().describe('Optional deterministic seed for this roll'),
    },
  }, guarded(({ notation, d20, modifier, seed }) => {
    const roll = () => {
      if (d20) {
        const r = rollAttack(modifier ?? 0, d20 === 'advantage', d20 === 'disadvantage');
        return reply(
          `d20 (${d20}): rolled ${r.naturalRoll}${modifier ? ` + ${modifier} = ${r.roll.total}` : ''}`,
          { naturalRoll: r.naturalRoll, modifier: modifier ?? 0, total: r.roll.total }
        );
      }
      if (!notation) return errorReply(new Error('Pass notation (e.g. "2d6+3") or d20.'));
      const r = rollDice(notation);
      return reply(`${notation}: [${r.rolls.join(', ')}]${r.modifier ? ` + ${r.modifier}` : ''} = ${r.total}`, r);
    };
    if (seed !== undefined) {
      return withRng(new SeededRng(seed), roll);
    }
    return roll();
  }));

  return server;
}
