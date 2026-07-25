import { getActiveSize } from '../engine/combat.js';
import type { BattleState } from '../engine/combat.js';
import type { Creature } from '../types/monster.js';
import type { ArenaAction } from './arena.js';
import type { Team } from './encounter.js';

function status(creature: Creature): 'ok' | 'bloodied' | 'dying' | 'dead' {
  if (!creature.isAlive) return 'dead';
  if (creature.deathSaves) return 'dying';
  return creature.currentHp * 2 <= creature.maxHp ? 'bloodied' : 'ok';
}

function visibleEquipment(creature: Creature): string[] {
  return [...new Set(creature.monsterData.actions
    .filter(action => action.attackBonus !== undefined && action.spellLevel === undefined)
    .map(action => action.name))];
}

function preparedSpells(creature: Creature): string[] {
  return [...new Set(creature.monsterData.actions
    .filter(action => (action.spellLevel ?? 0) > 0)
    .map(action => action.name).concat(creature.monsterData.speciesPreparedSpells ?? []))];
}

export function buildArenaObservation(
  state: BattleState,
  team: Team,
  active: Creature | undefined,
  legalActions: ArenaAction[],
  complete: boolean,
) {
  const creature = (current: Creature) => current.team === team
    ? {
        id: current.id, name: current.displayName, team: current.team, hp: `${current.currentHp}/${current.maxHp}`, temporaryHp: current.temporaryHp ?? 0,
        position: { ...current.position }, size: getActiveSize(current), conditions: [...current.conditions], status: status(current), resources: { ...current.resources },
        build: {
          heroClass: current.monsterData.heroClass, heroLevel: current.monsterData.heroLevel, heroSubclass: current.monsterData.heroSubclass,
          species: current.monsterData.heroSpecies, speciesChoice: current.monsterData.heroSpeciesChoice, speciesCastingAbility: current.monsterData.heroSpeciesCastingAbility, background: current.monsterData.heroBackground, originFeat: current.monsterData.originFeat, originFeats: current.monsterData.originFeats,
          abilities: { ...current.monsterData.abilities }, ac: current.monsterData.ac, speed: { ...current.monsterData.speed },
          equipment: visibleEquipment(current), cantrips: current.monsterData.speciesCantrips, preparedSpells: preparedSpells(current),
          reactionPreferences: current.monsterData.reactionPreferences ? structuredClone(current.monsterData.reactionPreferences) : undefined,
        },
      }
    : {
        id: current.id, name: current.displayName, team: current.team, position: { ...current.position }, size: getActiveSize(current),
        conditions: [...current.conditions], status: status(current), creatureType: current.monsterData.type, visibleEquipment: visibleEquipment(current),
      };
  return {
    phase: complete ? 'complete' : 'combat',
    round: state.round,
    activeCreatureIds: active?.team === team ? [active.id] : [],
    publicCombatState: {
      teams: {
        red: { alive: state.creatures.filter(current => current.team === 'red' && current.isAlive).length, total: state.creatures.filter(current => current.team === 'red').length },
        blue: { alive: state.creatures.filter(current => current.team === 'blue' && current.isAlive).length, total: state.creatures.filter(current => current.team === 'blue').length },
      },
      creatures: state.creatures.map(creature),
      winner: state.winner,
    },
    legalActions,
  };
}
