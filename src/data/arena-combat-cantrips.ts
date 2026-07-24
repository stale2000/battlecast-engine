import type { MonsterAction } from '../types/monster.js';
import type { SpellcastingAbility } from './spells.js';

export type ArenaCombatCantripName = 'Ray of Frost' | 'Chill Touch' | 'Shocking Grasp';

function cantripDice(pb: number, die: string): string {
  return `${pb >= 6 ? 4 : pb >= 4 ? 3 : pb >= 3 ? 2 : 1}${die}`;
}

/** Combat cantrips whose rule riders are already supported by the arena engine. */
export function arenaCombatCantrip(
  name: ArenaCombatCantripName, ability: SpellcastingAbility, mod: number, pb: number,
): MonsterAction {
  const attackBonus = mod + pb;
  const dice = cantripDice(pb, 'd8');
  if (name === 'Ray of Frost') return {
    name, type: 'ranged', description: `Ranged spell attack, ${dice} cold damage and the target’s Speed is reduced by 10 feet until your next turn.`,
    spellLevel: 0, spellSchool: 'evocation', castingAbility: ability, attackBonus, damage: dice, damageType: 'cold', range: { normal: 60, long: 60 }, magical: true, targetScope: 'one_enemy',
    buffOnHit: { name, key: 'ray-of-frost', speedPenalty: 10, expiresOnSourceTurnStart: true },
  };
  if (name === 'Shocking Grasp') return {
    name, type: 'melee', description: `Melee spell attack, ${dice} lightning damage. The target cannot take Reactions until your next turn.`,
    spellLevel: 0, spellSchool: 'evocation', castingAbility: ability, attackBonus, damage: dice, damageType: 'lightning', reach: 5, magical: true, targetScope: 'one_enemy',
    buffOnHit: { name, key: 'shocking-grasp', preventsReactions: true, expiresOnSourceTurnStart: true },
  };
  return {
    name, type: 'ranged', description: `Ranged spell attack, ${dice} necrotic damage. The target cannot regain HP until your next turn.`,
    spellLevel: 0, spellSchool: 'necromancy', castingAbility: ability, attackBonus, damage: dice, damageType: 'necrotic', range: { normal: 120, long: 120 }, magical: true, targetScope: 'one_enemy',
    effects: [{ kind: 'blocksHealing', key: name, tick: 'sourceTurnStart', expiresAfterRounds: 1 }],
  };
}
