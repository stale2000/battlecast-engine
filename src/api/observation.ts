// Compact, LLM-friendly snapshots of encounter state. The full BattleState
// (and especially each creature's embedded MonsterData) is far too large to
// hand to a language model every turn; observe() distills it to what a DM
// needs to narrate and decide.

import type { BattleLog, BattleState } from '../engine/combat.js';
import { getActiveSize } from '../engine/combat.js';
import type { Condition, Creature } from '../types/monster.js';
import type { Encounter, EncounterPhase, Team } from './encounter.js';

export interface CreatureView {
  id: string;
  name: string;
  team: Team;
  hp: string; // "12/30 (+5 temp)"
  position: { x: number; y: number };
  size: string;
  ac: number;
  speed: number;
  conditions: Condition[];
  status: 'ok' | 'bloodied' | 'dying' | 'dead';
  initiative: number;
}

export interface EncounterView {
  phase: EncounterPhase;
  gridSize: number;
  round: number;
  currentTurn: string | null;
  initiativeOrder: string[];
  teams: Record<Team, { alive: number; total: number }>;
  creatures: CreatureView[];
  winner: BattleState['winner'];
  recentLog: string[];
}

function creatureStatus(c: Creature): CreatureView['status'] {
  if (!c.isAlive) return 'dead';
  if (c.deathSaves) return 'dying';
  if (c.currentHp * 2 <= c.maxHp) return 'bloodied';
  return 'ok';
}

export function viewCreature(c: Creature): CreatureView {
  const temp = (c.temporaryHp ?? 0) > 0 ? ` (+${c.temporaryHp} temp)` : '';
  return {
    id: c.id,
    name: c.displayName,
    team: c.team,
    hp: `${c.currentHp}/${c.maxHp}${temp}`,
    position: { ...c.position },
    size: getActiveSize(c),
    ac: c.monsterData.ac,
    speed: c.monsterData.speed.walk,
    conditions: [...c.conditions],
    status: creatureStatus(c),
    initiative: c.initiative,
  };
}

export function formatLog(log: BattleLog): string {
  return `[R${log.round}] ${log.details}`;
}

export function observeEncounter(encounter: Encounter, recentLogLines: number = 15): EncounterView {
  const creatures = encounter.creatures;
  const state = encounter.state;
  const count = (team: Team) => ({
    alive: creatures.filter(c => c.team === team && c.isAlive).length,
    total: creatures.filter(c => c.team === team).length,
  });
  const order = state ? [...new Set(state.initiativeOrder)] : [];
  return {
    phase: encounter.phase,
    gridSize: encounter.gridSize,
    round: state?.round ?? 0,
    currentTurn: state && !state.isComplete ? order[state.turnIndex % order.length] ?? null : null,
    initiativeOrder: order,
    teams: { red: count('red'), blue: count('blue') },
    creatures: creatures.map(viewCreature),
    winner: state?.winner ?? null,
    recentLog: (state?.logs ?? []).slice(-recentLogLines).map(formatLog),
  };
}
