/**
 * Spell action definitions - MonsterAction instances pre-shaped for the
 * engine's executeSpell() dispatcher. Each exported function takes the
 * caster's relevant spellcasting stats and returns a ready-to-use action.
 *
 * Scope: modeled combat spells for the currently unlocked hero levels.
 * Cantrips are handled inline in heroes.ts (they're tightly coupled to
 * class primary). Leveled spells live here and are shared across classes
 * where the same spell appears on multiple spell lists (Bless = Cleric +
 * Paladin; Cure Wounds = Cleric + Paladin + Druid + Bard + Ranger; etc.).
 *
 * Every spell names the MonsterAction clearly. The action.description
 * is what shows in the stat block and the battle log.
 *
 */
import type { MonsterAction, MonsterData, Abilities } from '../types/monster.js';
import { getMonsterByName } from './monsters.js';

export type SpellcastingAbility = keyof Abilities;

function saveDC(spellcastingMod: number, pb: number): number {
  return 8 + pb + spellcastingMod;
}

function spellAttackBonus(spellcastingMod: number, pb: number): number {
  return pb + spellcastingMod;
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-1 spells
// ─────────────────────────────────────────────────────────────────────────────

export function bladeWard(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Blade Ward', type: 'special', spellLevel: 0, spellSchool: 'abjuration', castingAbility: ability,
    description: 'Until the end of your next turn, you have Resistance to bludgeoning, piercing, and slashing damage.',
    durationRounds: 1, targetScope: 'self', buff: { name: 'Blade Ward', key: 'blade-ward', resistPhysical: true },
  };
}

export function resistance(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Resistance', type: 'special', spellLevel: 0, spellSchool: 'abjuration', castingAbility: ability,
    description: 'One willing creature within 10 ft adds 1d4 to a saving throw before the end of its next turn.',
    durationRounds: 1, range: { normal: 10, long: 10 }, targetScope: 'one_ally', buff: { name: 'Resistance', key: 'resistance', saveBonusDice: '1d4' },
  };
}

export function poisonSpray(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  const dice = pb >= 6 ? '4d12' : pb >= 4 ? '3d12' : pb >= 3 ? '2d12' : '1d12';
  return {
    name: 'Poison Spray', type: 'ranged', spellLevel: 0, spellSchool: 'necromancy', castingAbility: ability,
    description: `Ranged spell attack within 30 feet. Hit: ${dice} poison damage.`,
    attackBonus: spellAttackBonus(mod, pb), damage: dice, damageType: 'poison', magical: true,
    range: { normal: 30, long: 30 }, targetScope: 'one_enemy',
  };
}

/** Produce Flame's combat mode: a ranged fire spell attack. */
export function produceFlame(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  const dice = pb >= 6 ? '4d8' : pb >= 4 ? '3d8' : pb >= 3 ? '2d8' : '1d8';
  return {
    name: 'Produce Flame', type: 'ranged', spellLevel: 0, spellSchool: 'conjuration', castingAbility: ability,
    description: `Ranged spell attack within 60 feet. Hit: ${dice} fire damage.`,
    attackBonus: spellAttackBonus(mod, pb), damage: dice, damageType: 'fire', magical: true,
    range: { normal: 60, long: 60 }, targetScope: 'one_enemy',
  };
}

export function thornWhip(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  const dice = pb >= 6 ? '4d6' : pb >= 4 ? '3d6' : pb >= 3 ? '2d6' : '1d6';
  return {
    name: 'Thorn Whip', type: 'ranged', spellLevel: 0, spellSchool: 'transmutation', castingAbility: ability,
    description: `Ranged spell attack within 30 feet. Hit: ${dice} piercing damage. If the target is Large or smaller, pull it up to 10 feet toward you.`,
    attackBonus: spellAttackBonus(mod, pb), damage: dice, damageType: 'piercing', magical: true,
    range: { normal: 30, long: 30 }, targetScope: 'one_enemy', pullTowardAttackerOnHit: 10,
  };
}

export function acidSplash(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  const dice = pb >= 6 ? '4d6' : pb >= 4 ? '3d6' : pb >= 3 ? '2d6' : '1d6';
  return {
    name: 'Acid Splash', type: 'special', spellLevel: 0, spellSchool: 'evocation', castingAbility: ability,
    description: `A 5-foot-radius sphere within 60 feet. DEX save DC ${saveDC(mod, pb)} or ${dice} acid damage.`,
    damageType: 'acid', range: { normal: 60, long: 60 }, targetScope: 'area_enemies',
    savingThrow: { ability: 'dex', dc: saveDC(mod, pb), damageOnFail: dice, area: '5-foot sphere' },
  };
}

export function starryWisp(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  const dice = pb >= 6 ? '4d8' : pb >= 4 ? '3d8' : pb >= 3 ? '2d8' : '1d8';
  return {
    name: 'Starry Wisp', type: 'ranged', spellLevel: 0, spellSchool: 'evocation', castingAbility: ability,
    description: `Ranged spell attack within 60 feet. Hit: ${dice} radiant damage, and the target cannot benefit from invisibility until the end of your next turn.`,
    attackBonus: spellAttackBonus(mod, pb), damage: dice, damageType: 'radiant', magical: true,
    range: { normal: 60, long: 60 }, targetScope: 'one_enemy', durationRounds: 1,
    buffOnHit: { name: 'Starry Wisp', key: 'starry-wisp', suppressesInvisibility: true },
  };
}

export function thunderclap(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  const dice = pb >= 6 ? '4d6' : pb >= 4 ? '3d6' : pb >= 3 ? '2d6' : '1d6';
  return {
    name: 'Thunderclap', type: 'special', spellLevel: 0, spellSchool: 'evocation', castingAbility: ability,
    description: `Each enemy in a 5-foot emanation must make a CON save (DC ${saveDC(mod, pb)}) or take ${dice} thunder damage.`,
    damageType: 'thunder', targetScope: 'area_enemies',
    savingThrow: { ability: 'con', dc: saveDC(mod, pb), damageOnFail: dice, area: '5-foot emanation' },
  };
}

export function tollTheDead(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Toll the Dead', type: 'special', spellLevel: 0, spellSchool: 'necromancy', castingAbility: ability,
    description: `The target makes a Wisdom save (DC ${saveDC(mod, pb)}); it takes 2d12 necrotic damage if it is wounded, or 2d8 necrotic damage otherwise.`,
    damageType: 'necrotic', targetScope: 'one_enemy', range: { normal: 60, long: 60 },
    savingThrow: { ability: 'wis', dc: saveDC(mod, pb), damageOnFail: '2d8', damageOnFailIfTargetWounded: '2d12' },
  };
}

export function trueStrike(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'True Strike', type: 'special', spellLevel: 0, spellSchool: 'divination', castingAbility: ability,
    description: 'Guide a weapon attack with magical precision. The next time you hit with a weapon before the end of this turn, it deals 1d6 extra radiant damage.',
    targetScope: 'self', buff: { name: 'True Strike', key: 'true-strike', weaponDamageRider: '1d6 radiant', weaponAttackAbility: ability, endsOnWeaponHit: true },
  };
}

export function shillelagh(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Shillelagh', type: 'special', spellLevel: 0, spellSchool: 'transmutation', castingAbility: ability,
    description: 'Imbue the club or quarterstaff you are holding. Until the end of your next turn, it deals 1d8 damage and you can use your spellcasting ability for its attack and damage rolls; its damage is magical.',
    targetScope: 'self', durationRounds: 1,
    buff: { name: 'Shillelagh', key: 'shillelagh', weaponAttackAbility: ability, weaponAttacksMagical: true, weaponDamageDie: '1d8', weaponNames: ['Club', 'Quarterstaff'] },
  };
}

export function sorcerousBurst(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Sorcerous Burst', type: 'ranged', spellLevel: 0, spellSchool: 'evocation', castingAbility: ability,
    attackBonus: spellAttackBonus(mod, pb), damage: '1d8', damageType: 'force', explodingDamage: true,
    damageTypeChoice: { choices: ['acid', 'cold', 'fire', 'lightning', 'poison', 'thunder'] },
    range: { normal: 120, long: 120 }, targetScope: 'one_enemy', magical: true,
    description: `Ranged spell attack within 120 feet. Hit: 1d8 damage of a chosen type; each 8 rolled adds another d8.`,
  };
}

export function flameBlade(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Flame Blade', type: 'special', spellLevel: 2, spellSchool: 'evocation', castingAbility: ability,
    concentration: true, durationRounds: 10, isBonusAction: true, targetScope: 'self', flameBlade: true,
    attackBonus: spellAttackBonus(mod, pb), damage: '3d6', damageType: 'fire', magical: true,
    repeatableActionSpell: {},
    description: `A flaming blade appears in your hand. As an Action on later turns, make a melee spell attack for 3d6 fire damage. Concentration.`,
  };
}

export function magicMissile(): MonsterAction {
  return {
    name: 'Magic Missile',
    type: 'special',
    description: 'Three darts of force auto-hit creatures you can see within 120 ft. Each dart: 1d4+1 force damage. No attack roll, no save.',
    spellLevel: 1,
    spellSchool: 'evocation',
    autoDarts: 3,
    autoDartDamage: '1d4+1',
    autoDartDamageType: 'force',
    range: { normal: 120, long: 120 },
    targetScope: 'one_enemy',
  };
}

export function burningHands(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Burning Hands',
    type: 'special',
    description: `15-foot Cone. Each creature makes a DC ${saveDC(mod, pb)} DEX save; 3d6 fire damage on fail, half on success. Ignites unattended flammables.`,
    spellLevel: 1,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'fire',
    savingThrow: {
      ability: 'dex', dc: saveDC(mod, pb),
      damageOnFail: '3d6', damageOnSuccess: 'half',
      area: '15-foot Cone',
    },
    targetScope: 'area_enemies',
  };
}

export function thunderwave(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Thunderwave',
    type: 'special',
    description: `15-foot Cube from you. CON save DC ${saveDC(mod, pb)}; 2d8 thunder damage on fail, half on success. Failed saves are pushed 10 ft away.`,
    spellLevel: 1,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'thunder',
    savingThrow: {
      ability: 'con', dc: saveDC(mod, pb),
      damageOnFail: '2d8', damageOnSuccess: 'half',
      area: '15-foot emanation',
    },
    pushOnFailedSave: 10,
    targetScope: 'area_enemies',
  };
}

export function sleep(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Sleep',
    type: 'special',
    description: 'Each creature in a 5-foot sphere makes a Wisdom save or is Incapacitated until the end of its next turn. On a second failed save, it becomes Unconscious for the duration. Concentration.',
    spellLevel: 1,
    castingAbility: ability,
    concentration: true,
    durationRounds: 10,
    range: { normal: 60, long: 60 },
    savingThrow: {
      ability: 'wis', dc: saveDC(mod, pb),
      conditionOnFail: 'incapacitated', conditionDuration: 'end_of_next_turn',
      secondFailureCondition: 'unconscious', secondFailureDuration: '1_minute',
      area: '5-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

export function bless(): MonsterAction {
  return {
    name: 'Bless',
    type: 'special',
    description: 'Up to 3 creatures within 30 ft. Each target adds 1d4 to attack rolls and saves for 1 minute. Concentration.',
    spellLevel: 1,
    concentration: true,
    durationRounds: 10, // 1 minute
    buff: {
      name: 'Bless', key: 'bless',
      requiresConcentration: true,
      attackBonusDice: '1d4', saveBonusDice: '1d4',
    },
    range: { normal: 30, long: 30 },
    targetScope: 'all_allies_in_area',
    multiTargetBuff: { maxTargets: 3 },
  };
}

export function bane(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Bane',
    type: 'special',
    description: `Up to 3 enemies within 30 ft. Each makes a CHA save DC ${saveDC(mod, pb)}; on fail, the target subtracts 1d4 from its attack rolls and saves for 1 minute. Concentration.`,
    spellLevel: 1,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    savingThrow: {
      ability: 'cha',
      dc: saveDC(mod, pb),
    },
    buff: {
      name: 'Bane', key: 'bane',
      requiresConcentration: true,
      attackBonusDice: '-1d4', saveBonusDice: '-1d4',
    },
    multiTargetSave: { maxTargets: 3 },
    range: { normal: 30, long: 30 },
    targetScope: 'one_enemy',
  };
}

export function cureWounds(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Cure Wounds',
    type: 'special',
    description: 'Touch one creature and restore 2d8 + casting ability mod HP. (Undead & constructs unaffected - simplified: applied to any living ally.)',
    spellLevel: 1,
    castingAbility: ability,
    heal: { dice: '2d8', addCastingMod: true },
    range: { normal: 5, long: 5 }, // touch
    targetScope: 'one_ally',
  };
}

export function healingWord(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Healing Word',
    type: 'special',
    description: 'One creature within 60 ft regains 2d4 + casting ability mod HP. Bonus action.',
    spellLevel: 1,
    castingAbility: ability,
    isBonusAction: true,
    heal: { dice: '2d4', addCastingMod: true },
    range: { normal: 60, long: 60 },
    targetScope: 'one_ally',
  };
}

export function shieldOfFaith(): MonsterAction {
  return {
    name: 'Shield of Faith',
    type: 'special',
    description: 'Bonus action: one creature within 60 ft gains +2 AC for 10 minutes. Concentration.',
    spellLevel: 1,
    isBonusAction: true,
    concentration: true,
    durationRounds: 100,
    buff: {
      name: 'Shield of Faith', key: 'shield-of-faith',
      requiresConcentration: true, acBonus: 2,
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_ally',
  };
}

export function guidingBolt(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Guiding Bolt',
    type: 'ranged',
    description: `Ranged spell attack +${spellAttackBonus(mod, pb)}, range 120 ft. 4d6 radiant damage; the next attack roll against the target has Advantage.`,
    spellLevel: 1,
    spellSchool: 'evocation',
    castingAbility: ability,
    attackBonus: spellAttackBonus(mod, pb),
    damage: '4d6', damageType: 'radiant',
    buffOnHit: {
      name: 'Guiding Bolt',
      key: 'guiding-bolt-advantage',
      advantageForAllAttackers: true,
    },
    range: { normal: 120, long: 120 },
    targetScope: 'one_enemy',
  };
}

export function hex(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Hex',
    type: 'special',
    description: 'Curse one creature within 90 ft. Your attacks deal extra 1d6 necrotic against the target. Concentration, up to 1 hour. Bonus action.',
    spellLevel: 1,
    isBonusAction: true,
    concentration: true,
    durationRounds: 600,
    castingAbility: ability,
    // The buff sits on the TARGET with caster = warlock. Only matches if the
    // attacker's id equals casterId, so only the warlock's attacks proc it.
    buff: {
      name: 'Hex', key: 'hex',
      requiresConcentration: true,
      damageRider: '1d6 necrotic',
    },
    range: { normal: 90, long: 90 },
    targetScope: 'one_enemy',
  };
}

export function huntersMark(_ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _ability;
  void _mod;
  void _pb;
  return {
    name: "Hunter's Mark",
    type: 'special',
    description: 'Mark a creature within 90 ft. Your weapon attacks deal extra 1d6 force damage against the target. Concentration, 1 hour. Bonus action.',
    spellLevel: 1,
    isBonusAction: true,
    concentration: true,
    durationRounds: 600,
    buff: {
      name: "Hunter's Mark", key: 'hunters-mark',
      requiresConcentration: true,
      damageRider: '1d6 force',
    },
    range: { normal: 90, long: 90 },
    targetScope: 'one_enemy',
  };
}

export function dissonantWhispers(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Dissonant Whispers',
    type: 'special',
    description: `One creature within 60 ft. WIS save DC ${saveDC(mod, pb)}; 3d6 psychic damage on fail, half on success. On failure it uses its Reaction to flee directly away, provoking opportunity attacks.`,
    spellLevel: 1,
    castingAbility: ability,
    damageType: 'psychic',
    savingThrow: {
      ability: 'wis', dc: saveDC(mod, pb),
      damageOnFail: '3d6', damageOnSuccess: 'half',
    },
    fleeOnFailedSave: true,
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function entangle(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Entangle',
    type: 'special',
    description: `20-foot square. STR save DC ${saveDC(mod, pb)}; on fail, target is Restrained for 1 minute (repeat save each turn). Concentration.`,
    spellLevel: 1,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    savingThrow: {
      ability: 'str', dc: saveDC(mod, pb),
      conditionOnFail: 'restrained',
      conditionDuration: '1_minute',
      area: '20-foot sphere',
    },
    targetScope: 'area_enemies',
    buffOnFailedSave: { name: 'Entangle', key: 'entangle', requiresConcentration: true, appliedConditions: ['restrained'], escapeAction: { ability: 'str', dc: saveDC(mod, pb) } },
    persistentZone: { radiusFt: 20, durationRounds: 10, triggers: ['entry'] },
  };
}

export function hailOfThorns(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Hail of Thorns', type: 'special', spellLevel: 1, spellSchool: 'conjuration', castingAbility: ability,
    description: `The next ranged weapon hit before concentration ends bursts in a 5-foot radius. DEX save DC ${saveDC(mod, pb)}; 1d10 piercing damage on a failed save, half on success.`,
    isBonusAction: true, concentration: true, durationRounds: 10, targetScope: 'self',
    buff: {
      name: 'Hail of Thorns', key: 'hail-of-thorns', requiresConcentration: true,
      weaponHitArea: { damage: '1d10', damageType: 'piercing', radiusFt: 5, saveAbility: 'dex', saveDc: saveDC(mod, pb) },
    },
  };
}

export function silence(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Silence', type: 'special', spellLevel: 2, spellSchool: 'illusion', castingAbility: ability,
    description: 'Create a 20-foot-radius sphere of silence for up to 10 minutes. Spells with verbal components cannot be cast inside.',
    concentration: true, durationRounds: 100, range: { normal: 120, long: 120 },
    persistentZone: { radiusFt: 20, durationRounds: 100, triggers: [], silences: true },
  };
}

export function compelledDuel(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Compelled Duel', type: 'special', spellLevel: 1, spellSchool: 'enchantment', castingAbility: ability,
    description: `One creature within 30 feet makes a WIS save (DC ${saveDC(mod, pb)}). On a failure, it has Disadvantage on attacks against creatures other than you and cannot willingly move more than 30 feet from you while you concentrate.`,
    concentration: true, durationRounds: 10, range: { normal: 30, long: 30 }, targetScope: 'one_enemy',
    savingThrow: { ability: 'wis', dc: saveDC(mod, pb) },
    buffOnFailedSave: { name: 'Compelled Duel', key: 'compelled-duel', requiresConcentration: true, attackersHaveDisadvantageExceptCaster: true, cannotMoveAwayFromCaster: true },
  };
}

export function wardingWind(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Warding Wind', type: 'special', spellLevel: 2, spellSchool: 'evocation', castingAbility: ability,
    description: 'A 10-foot aura of wind surrounds you for up to 10 minutes. Ranged weapon attacks through the aura have Disadvantage and the area is Difficult Terrain.',
    concentration: true, durationRounds: 100, targetScope: 'self',
    persistentZone: { radiusFt: 10, durationRounds: 100, triggers: [], difficultTerrain: true, rangedWeaponAttacksDisadvantage: true },
  };
}

export function lightningArrow(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  const dc = saveDC(mod, pb);
  return {
    name: 'Lightning Arrow', type: 'special', spellLevel: 3, spellSchool: 'transmutation', castingAbility: ability,
    description: `The next ranged weapon attack before concentration ends replaces its weapon damage with 4d8 lightning. On a hit, creatures within 10 feet of the target make a DEX save (DC ${dc}) for half damage; on a miss, the target takes half damage and the burst still resolves.`,
    isBonusAction: true, concentration: true, durationRounds: 10, targetScope: 'self',
    buff: {
      name: 'Lightning Arrow', key: 'lightning-arrow', requiresConcentration: true,
      weaponDamageReplacement: { damage: '4d8', damageType: 'lightning', radiusFt: 10, saveAbility: 'dex', saveDc: dc },
    },
  };
}

export function wardingBond(): MonsterAction {
  return {
    name: 'Warding Bond',
    type: 'special',
    description: 'Touch a willing creature: it gains +1 AC, +1 to saving throws, and Resistance to all damage. When it takes damage, you take the same amount.',
    spellLevel: 2,
    durationRounds: 600,
    range: { normal: 5, long: 5 },
    targetScope: 'one_ally',
    buff: {
      name: 'Warding Bond', key: 'warding-bond',
      acBonus: 1, saveBonus: 1, resistAllDamageExcept: [], wardingBond: true,
    },
  };
}

export function sanctuary(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Sanctuary', type: 'special', spellLevel: 1, spellSchool: 'abjuration', castingAbility: ability,
    isBonusAction: true, durationRounds: 10,
    description: `One creature within 30 feet is warded for 1 minute. A creature targeting it with an attack must first pass a DC ${saveDC(mod, pb)} WIS save. The ward ends if its target attacks or casts a spell.`,
    range: { normal: 30, long: 30 }, targetScope: 'one_ally',
    buff: { name: 'Sanctuary', key: 'sanctuary', sanctuarySaveDc: saveDC(mod, pb), endsOnAttackOrCast: true },
  };
}

export function protectionFromEvilAndGood(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Protection from Evil and Good', type: 'special', spellLevel: 1, spellSchool: 'abjuration', castingAbility: ability,
    concentration: true, durationRounds: 100,
    description: 'One willing creature has protection from Aberrations, Celestials, Elementals, Fey, Fiends, and Undead for 10 minutes: those creatures have Disadvantage on attacks against it, and it cannot be Charmed or Frightened by them.',
    range: { normal: 10, long: 10 }, targetScope: 'one_ally',
    buff: { name: 'Protection from Evil and Good', key: 'protection-evil-good', requiresConcentration: true, attackersOfTypesHaveDisadvantage: ['Aberration', 'Celestial', 'Elemental', 'Fey', 'Fiend', 'Undead'], conditionImmunities: ['charmed', 'frightened'] },
  };
}

export function heroism(ability: SpellcastingAbility, mod: number, _pb: number): MonsterAction {
  return {
    name: 'Heroism', type: 'special', spellLevel: 1, spellSchool: 'enchantment', castingAbility: ability, concentration: true, durationRounds: 10,
    description: `One willing creature within 10 ft gains ${Math.max(1, mod)} temporary HP at the start of each of its turns and is immune to Frightened. Concentration, 1 minute.`,
    range: { normal: 10, long: 10 }, targetScope: 'one_ally',
    buff: { name: 'Heroism', key: 'heroism', requiresConcentration: true, temporaryHpAtTurnStart: Math.max(1, mod), conditionImmunities: ['frightened'] },
  };
}

export function shield(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Shield', type: 'special', spellLevel: 1, spellSchool: 'abjuration', castingAbility: ability, reactionOnly: true,
    description: 'Reaction when hit by an attack: gain +5 AC until the start of your next turn, potentially turning the hit into a miss.',
    buff: { name: 'Shield', key: 'shield', acBonus: 5 }, targetScope: 'self',
  };
}

export function hellishRebuke(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Hellish Rebuke', type: 'special', spellLevel: 1, spellSchool: 'evocation', castingAbility: ability, reactionOnly: true,
    description: `Reaction when damaged by a creature within 60 ft: DEX save DC ${saveDC(mod, pb)}, taking 2d10 fire damage on a failure and half on a success.`,
    damageType: 'fire', savingThrow: { ability: 'dex', dc: saveDC(mod, pb), damageOnFail: '2d10', damageOnSuccess: 'half' }, range: { normal: 60, long: 60 }, targetScope: 'one_enemy',
  };
}

export function counterspell(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Counterspell', type: 'special', spellLevel: 3, spellSchool: 'abjuration', castingAbility: ability, reactionOnly: true,
    description: 'Reaction when a creature within 60 feet casts a spell: the spell fails if it is level 3 or lower.',
    range: { normal: 60, long: 60 }, targetScope: 'one_enemy',
  };
}

export function grease(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Grease', type: 'special', spellLevel: 1, spellSchool: 'conjuration', castingAbility: ability,
    description: `10-foot square within 60 ft. Difficult Terrain for 1 minute. DEX save DC ${saveDC(mod, pb)} or Prone when it appears, when a creature enters, or when it ends a turn there.`,
    savingThrow: { ability: 'dex', dc: saveDC(mod, pb), conditionOnFail: 'prone', conditionDuration: 'end_of_next_turn', area: '10-foot square' },
    range: { normal: 60, long: 60 }, targetScope: 'area_enemies',
    persistentZone: { radiusFt: 10, durationRounds: 10, triggers: ['entry', 'turnEnd'], difficultTerrain: true },
  };
}

export function faerieFire(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Faerie Fire', type: 'special', spellLevel: 1, spellSchool: 'evocation', castingAbility: ability, concentration: true, durationRounds: 10,
    description: `20-foot cube within 60 ft. DEX save DC ${saveDC(mod, pb)}; failed targets grant Advantage on attacks against them.`,
    savingThrow: { ability: 'dex', dc: saveDC(mod, pb), area: '20-foot cube' }, range: { normal: 60, long: 60 }, targetScope: 'area_enemies',
    buffOnFailedSave: { name: 'Faerie Fire', key: 'faerie-fire', requiresConcentration: true, advantageForAllAttackers: true },
  };
}

export function fogCloud(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Fog Cloud', type: 'special', spellLevel: 1, spellSchool: 'conjuration', castingAbility: ability, concentration: true,
    description: 'A 20-foot-radius heavily obscured sphere within 120 feet for 1 hour. The arena visibility resolver owns the obscured zone.',
    range: { normal: 120, long: 120 }, targetScope: 'self', darkness: { radius: 20, durationRounds: 600, requiresConcentration: true },
  };
}

export function darkness(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Darkness', type: 'special', spellLevel: 2, spellSchool: 'evocation', castingAbility: ability, concentration: true,
    description: 'Magical Darkness fills a 15-foot-radius Sphere at a visible point within 60 feet for 10 minutes. Concentration.',
    range: { normal: 60, long: 60 }, targetScope: 'self', darkness: { radius: 15, durationRounds: 100, requiresConcentration: true },
  };
}

export function passWithoutTrace(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Pass without Trace', type: 'special', spellLevel: 2, spellSchool: 'abjuration', castingAbility: ability, concentration: true, durationRounds: 600,
    description: 'You and allies within 30 feet gain +10 to Dexterity (Stealth) checks for 1 hour. Concentration.',
    range: { normal: 30, long: 30 }, targetScope: 'all_allies_in_area',
    buff: { name: 'Pass without Trace', key: 'pass-without-trace', requiresConcentration: true, stealthBonus: 10 },
  };
}

export function enlargeReduce(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Enlarge/Reduce', type: 'special', spellLevel: 2, spellSchool: 'transmutation', castingAbility: ability, concentration: true, durationRounds: 10,
    description: 'Change one creature’s size by one category for 1 minute. Enlarge grants Strength advantage and +1d4 weapon damage; Reduce imposes Strength disadvantage and -1d4 weapon damage. Concentration.',
    range: { normal: 30, long: 30 }, targetScope: 'any_one', sizeChangeChoice: { choices: ['enlarge', 'reduce'] },
  };
}

export function falseLife(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'False Life', type: 'special', spellLevel: 1, spellSchool: 'necromancy', castingAbility: ability,
    description: 'Gain 2d4 plus your spellcasting ability modifier temporary HP.', temporaryHp: { dice: '2d4', addCastingMod: true }, targetScope: 'self',
  };
}

export function armorOfAgathys(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Armor of Agathys', type: 'special', spellLevel: 1, spellSchool: 'abjuration', castingAbility: ability, isBonusAction: true, durationRounds: 600,
    description: 'You gain 5 Temporary Hit Points for 1 hour. While you have those hit points, a creature that hits you with a melee attack takes 5 cold damage.', targetScope: 'self',
    temporaryHp: { dice: '5' },
    buff: { name: 'Armor of Agathys', key: 'armor-of-agathys', reactiveDamage: '5 cold', endsWhenTemporaryHpDepleted: true },
  };
}

export function expeditiousRetreat(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Expeditious Retreat', type: 'special', spellLevel: 1, spellSchool: 'transmutation', castingAbility: ability, isBonusAction: true, dashOnCast: true, concentration: true, durationRounds: 100,
    description: 'You take the Dash action. Until the spell ends, you can take the Dash action as a Bonus Action.', targetScope: 'self',
    buff: { name: 'Expeditious Retreat', key: 'expeditious-retreat', requiresConcentration: true, bonusActionDash: true },
  };
}

export function mageArmor(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Mage Armor', type: 'special', spellLevel: 1, spellSchool: 'abjuration', castingAbility: ability, durationRounds: 4800,
    description: 'One willing creature you touch has a base AC of 13 plus its Dexterity modifier for 8 hours.', range: { normal: 5, long: 5 }, targetScope: 'one_ally',
    buff: { name: 'Mage Armor', key: 'mage-armor', acBaseFromDex: 13 },
  };
}

export function longstrider(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Longstrider', type: 'special', spellLevel: 1, spellSchool: 'transmutation', castingAbility: ability, durationRounds: 600,
    description: 'One creature gains 10 feet of Speed for 1 hour.', range: { normal: 5, long: 5 }, targetScope: 'one_ally',
    buff: { name: 'Longstrider', key: 'longstrider', speedBonus: 10 },
  };
}

export function rayOfSickness(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Ray of Sickness', type: 'ranged', spellLevel: 1, spellSchool: 'necromancy', castingAbility: ability,
    description: `Ranged spell attack +${spellAttackBonus(mod, pb)}, range 60 ft. 2d8 poison damage; CON save DC ${saveDC(mod, pb)} or Poisoned until your next turn.`,
    attackBonus: spellAttackBonus(mod, pb), damage: '2d8', damageType: 'poison', range: { normal: 60, long: 60 }, targetScope: 'one_enemy',
    conditionOnHit: { condition: 'poisoned', save: { ability: 'con', dc: saveDC(mod, pb) }, duration: 'end_of_next_turn' },
  };
}

export function rayOfEnfeeblement(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Ray of Enfeeblement', type: 'special', spellLevel: 2, spellSchool: 'necromancy', castingAbility: ability, concentration: true, durationRounds: 10,
    description: `60-foot ray. CON save DC ${saveDC(mod, pb)}; on a failure, the target has Disadvantage on Strength tests and subtracts 1d8 from damage rolls. It repeats the save at the end of each turn.`,
    range: { normal: 60, long: 60 }, targetScope: 'one_enemy', savingThrow: { ability: 'con', dc: saveDC(mod, pb) },
    buffOnFailedSave: { name: 'Ray of Enfeeblement', key: 'ray-of-enfeeblement', requiresConcentration: true, strengthTestDisadvantage: true, damageRollPenalty: '1d8', saveEnds: { ability: 'con', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
    buffOnSuccessfulSave: { name: 'Ray of Enfeeblement', key: 'ray-of-enfeeblement-success', attackDisadvantage: true, expiresOnSourceTurnStart: true },
  };
}

export function tashasHideousLaughter(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: "Tasha's Hideous Laughter", type: 'special', spellLevel: 1, spellSchool: 'enchantment', castingAbility: ability, concentration: true, durationRounds: 10,
    description: `One creature within 30 ft. WIS save DC ${saveDC(mod, pb)} or Prone and Incapacitated; repeat the save at end of each turn.`,
    savingThrow: { ability: 'wis', dc: saveDC(mod, pb), conditionOnFail: 'incapacitated', additionalConditionsOnFail: ['prone'], conditionDuration: '1_minute' }, range: { normal: 30, long: 30 }, targetScope: 'one_enemy',
    buffOnFailedSave: { name: "Tasha's Hideous Laughter", key: 'hideous-laughter', requiresConcentration: true, appliedConditions: ['incapacitated', 'prone'], saveEnds: { ability: 'wis', dc: saveDC(mod, pb), at: 'targetTurnEnd', advantageOnDamage: true } },
  };
}

export function armsOfHadar(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Arms of Hadar', type: 'special', spellLevel: 1, spellSchool: 'conjuration', castingAbility: ability,
    description: `10-foot emanation. STR save DC ${saveDC(mod, pb)}; 2d6 necrotic damage on a failed save and no Reactions until your next turn.`,
    damageType: 'necrotic', savingThrow: { ability: 'str', dc: saveDC(mod, pb), damageOnFail: '2d6', area: '10-foot emanation' }, targetScope: 'area_enemies',
    buffOnFailedSave: { name: 'Arms of Hadar', key: 'arms-of-hadar', preventsReactions: true, expiresOnSourceTurnStart: true },
  };
}

export function colorSpray(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Color Spray', type: 'special', spellLevel: 1, spellSchool: 'illusion', castingAbility: ability,
    description: 'Each creature in a 15-foot cone must make a Constitution save or be Blinded until the end of your next turn.',
    savingThrow: { ability: 'con', dc: saveDC(mod, pb), conditionOnFail: 'blinded', conditionDuration: 'end_of_next_turn', area: '15-foot cone' }, targetScope: 'area_enemies',
  };
}

export function divineFavor(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Divine Favor', type: 'special', spellLevel: 1, spellSchool: 'transmutation', castingAbility: ability, isBonusAction: true, durationRounds: 10,
    description: 'Your weapon attacks deal an extra 1d4 radiant damage for 1 minute.', targetScope: 'self',
    buff: { name: 'Divine Favor', key: 'divine-favor', damageRider: '1d4 radiant' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-2 spells
// ─────────────────────────────────────────────────────────────────────────────

function bestialSpirit(kind: 'air' | 'land' | 'water', mod: number, pb: number): MonsterData {
  const air = kind === 'air';
  const water = kind === 'water';
  return {
    name: `Bestial Spirit (${kind[0]!.toUpperCase()}${kind.slice(1)})`, size: 'Small', type: 'Beast', alignment: 'Unaligned',
    ac: 13, hp: air ? 20 : 30, hpFormula: String(air ? 20 : 30),
    speed: air ? { walk: 30, fly: 60 } : water ? { walk: 30, swim: 30 } : { walk: 30, climb: 30 },
    abilities: { str: 18, dex: 11, con: 16, int: 4, wis: 14, cha: 5 },
    senses: 'Darkvision 60 ft., Passive Perception 12', languages: 'Understands the languages you speak', cr: '0', xp: 0, proficiencyBonus: pb,
    traits: air
      ? [{ name: 'Flyby', description: "The spirit doesn't provoke Opportunity Attacks when it flies out of an enemy's reach." }]
      : [{ name: 'Pack Tactics', description: "The spirit has Advantage on an attack roll against a creature if at least one of the spirit's allies is within 5 feet of the creature and isn't Incapacitated." }],
    actions: [{ name: 'Maul', type: 'melee', attackBonus: spellAttackBonus(mod, pb), damage: '1d8+6', damageType: 'piercing', reach: 5, magical: true, description: 'Melee Spell Attack: your spell attack modifier to hit, reach 5 ft. Hit: 1d8 + 4 + the spell level piercing damage.' }],
  };
}

export function summonBeast(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Summon Beast', type: 'special', spellLevel: 2, spellSchool: 'conjuration', castingAbility: ability, concentration: true, durationRounds: 600,
    description: 'Summon a Bestial Spirit in an unoccupied space you can see within 90 feet. The spirit takes its turn immediately after yours and disappears when the spell ends or it drops to 0 Hit Points.',
    targetScope: 'self',
    summon: {
      rangeFt: 90, durationRounds: 600,
      variants: (['air', 'land', 'water'] as const).map(key => ({
        key, monsterData: bestialSpirit(key, mod, pb), hpPerSlotLevel: 5, acPerSlotLevel: 1,
        attack: { actionName: 'Maul', dice: '1d8', baseBonus: 4, baseSpellLevel: 2, attacksPerSpellLevels: 2 },
      })),
    },
  };
}

function otherworldlySteed(kind: 'celestial' | 'fey' | 'fiend', mod: number, pb: number): MonsterData {
  const damageType = kind === 'celestial' ? 'radiant' : kind === 'fey' ? 'psychic' : 'necrotic';
  const actions: MonsterAction[] = [{
    name: 'Otherworldly Slam', type: 'melee', attackBonus: spellAttackBonus(mod, pb), damage: '1d8+2', damageType, reach: 5, magical: true,
    description: `Melee Attack Roll: your spell attack modifier, reach 5 ft. Hit: 1d8 + the spell's level ${damageType} damage.`,
  }];
  if (kind === 'celestial') actions.push({ name: 'Healing Touch', type: 'special', isBonusAction: true, targetScope: 'one_ally', range: { normal: 5, long: 5 }, resourceCost: { key: 'healing-touch', amount: 1 }, heal: { dice: '2d8+2', addCastingMod: false }, description: 'One creature within 5 feet regains 2d8 plus the spell’s level Hit Points. (1/Long Rest)' });
  if (kind === 'fey') actions.push({ name: 'Fey Step', type: 'special', isBonusAction: true, targetScope: 'self', resourceCost: { key: 'fey-step', amount: 1 }, teleport: { distanceFt: 60 }, description: 'Teleport, along with your rider, to an unoccupied space within 60 feet. (1/Long Rest)' });
  if (kind === 'fiend') actions.push({ name: 'Fell Glare', type: 'special', targetScope: 'one_enemy', range: { normal: 60, long: 60 }, resourceCost: { key: 'fell-glare', amount: 1 }, savingThrow: { ability: 'wis', dc: saveDC(mod, pb), conditionOnFail: 'frightened', conditionDuration: 'end_of_next_turn' }, description: 'One creature within 60 feet makes a Wisdom save or is Frightened until the end of your next turn. (1/Long Rest)' });
  return {
    name: `Otherworldly Steed (${kind[0]!.toUpperCase()}${kind.slice(1)})`, size: 'Large', type: kind[0]!.toUpperCase() + kind.slice(1), alignment: 'Neutral', ac: 12, hp: 25, hpFormula: '25', speed: { walk: 60 },
    abilities: { str: 18, dex: 12, con: 14, int: 6, wis: 12, cha: 8 }, saves: { str: 7, dex: 4, con: 5, int: 1, wis: 4, cha: 2 }, senses: 'Passive Perception 11', languages: 'Telepathy 1 mile (works only with its summoner)', cr: '0', xp: 0, proficiencyBonus: pb,
    actions, initialResources: kind === 'celestial' ? { 'healing-touch': 1 } : kind === 'fey' ? { 'fey-step': 1 } : { 'fell-glare': 1 },
  };
}

export function findSteed(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Find Steed', type: 'special', spellLevel: 2, spellSchool: 'conjuration', castingAbility: ability, targetScope: 'self',
    description: 'Summon a loyal Otherworldly Steed in an unoccupied space within 30 feet. It is a controlled mount while you ride it and disappears if you die or it drops to 0 Hit Points.',
    summon: {
      rangeFt: 30, controlledMount: true, requiresConcentration: false,
      variants: (['celestial', 'fey', 'fiend'] as const).map(key => ({ key, monsterData: otherworldlySteed(key, mod, pb), hpPerSlotLevel: 10, acPerSlotLevel: 1, attack: { actionName: 'Otherworldly Slam', dice: '1d8', baseBonus: 0, baseSpellLevel: 2 } })),
    },
  };
}

export function conjureAnimals(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Conjure Animals', type: 'special', spellLevel: 3, spellSchool: 'conjuration', castingAbility: ability,
    concentration: true, durationRounds: 100,
    description: `Conjure a Large spectral pack within 60 feet. Creatures you can see take 3d10 slashing damage on a failed DEX save when the pack moves within 10 feet, enters the pack, or ends a turn there. You have Advantage on STR saves within 5 feet of the pack.`,
    damageType: 'slashing', range: { normal: 60, long: 60 }, targetScope: 'area_enemies',
    savingThrow: { ability: 'dex', dc: saveDC(mod, pb), damageOnFail: '3d10', damageOnSuccess: 'none', area: '10-foot sphere' },
    persistentAura: {
      moveFt: 30, damageOnInitialCast: false, triggers: ['entry', 'turnEnd'],
      moveRequiresCasterMove: true, moveUsesAction: false,
      saveAdvantageWithinFt: { ability: 'str', radiusFt: 5 },
    },
  };
}

/** Build the level-3 Summon Fey spirit. Form-specific charm/fear riders are
 * intentionally not exposed until the action resolver can stage them safely. */
function feySpirit(form: 'fuming' | 'mirthful' | 'tricksy', mod: number, pb: number): MonsterData {
  return {
    name: `Fey Spirit (${form})`, size: 'Small', type: 'Fey', alignment: 'Neutral',
    ac: 12, hp: 30, hpFormula: '30', speed: { walk: 30 },
    abilities: { str: 13, dex: 16, con: 15, int: 14, wis: 11, cha: 16 },
    senses: 'Darkvision 60 ft., Passive Perception 10', languages: 'Sylvan', cr: '0', xp: 0, proficiencyBonus: pb,
    actions: [{ name: 'Fey Blade', type: 'melee', attackBonus: spellAttackBonus(mod, pb), damage: '1d6+3', damageType: 'psychic', reach: 5, magical: true,
      description: 'Melee Spell Attack: your spell attack modifier, reach 5 ft. Hit: 1d6 + 3 psychic damage.' }],
  };
}

/** Summon Fey (3rd-level). The summoned spirit is a normal controlled
 * creature, so its attack and concentration lifecycle use the shared engine. */
export function summonFey(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Summon Fey', type: 'special', spellLevel: 3, spellSchool: 'conjuration', castingAbility: ability, concentration: true, durationRounds: 600,
    description: 'Summon a Fey Spirit in an unoccupied space you can see within 90 feet. It takes its turn immediately after yours and disappears when the spell ends or it drops to 0 Hit Points.',
    targetScope: 'self', summon: {
      rangeFt: 90, durationRounds: 600,
      variants: (['fuming', 'mirthful', 'tricksy'] as const).map(key => ({
        key, monsterData: feySpirit(key, mod, pb), hpPerSlotLevel: 10, acPerSlotLevel: 1,
        attack: { actionName: 'Fey Blade', dice: '1d6', baseBonus: 3, baseSpellLevel: 3 },
      })),
    },
  };
}

function undeadSpirit(form: 'ghostly' | 'putrid' | 'skeletal', mod: number, pb: number): MonsterData {
  const ghostly = form === 'ghostly';
  const putrid = form === 'putrid';
  return {
    name: `Undead Spirit (${form})`, size: 'Medium', type: 'Undead', alignment: 'Neutral',
    ac: 12, hp: 30, hpFormula: '30', speed: ghostly ? { walk: 30, fly: 40 } : { walk: 30 },
    abilities: { str: 12, dex: 16, con: 15, int: 4, wis: 10, cha: 9 },
    resistances: ['necrotic'], senses: 'Darkvision 60 ft., Passive Perception 10', languages: 'Understands the languages you speak', cr: '0', xp: 0, proficiencyBonus: pb,
    actions: [{ name: 'Deathly Touch', type: ghostly ? 'melee' : 'ranged', attackBonus: spellAttackBonus(mod, pb), damage: '1d10+3', damageType: 'necrotic', reach: ghostly ? 5 : undefined, range: ghostly ? undefined : { normal: 60, long: 60 }, magical: true,
      ...(putrid ? { conditionOnHit: { condition: 'paralyzed' as const, save: { ability: 'con' as const, dc: saveDC(mod, pb) }, duration: 'end_of_next_turn' as const } } : {}),
      description: `${ghostly ? 'Melee' : 'Ranged'} Spell Attack: your spell attack modifier. Hit: 1d10 + 3 necrotic damage.` }],
  };
}

/** Summon Undead (3rd-level). The putrid form's on-hit paralysis save uses the
 * shared attack-condition resolver; other form-specific riders remain hidden. */
export function summonUndead(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Summon Undead', type: 'special', spellLevel: 3, spellSchool: 'necromancy', castingAbility: ability, concentration: true, durationRounds: 600,
    description: 'Summon an Undead Spirit in an unoccupied space you can see within 90 feet. It takes its turn immediately after yours and disappears when the spell ends or it drops to 0 Hit Points.',
    targetScope: 'self', summon: {
      rangeFt: 90, durationRounds: 600,
      variants: (['ghostly', 'putrid', 'skeletal'] as const).map(key => ({
        key, monsterData: undeadSpirit(key, mod, pb), hpPerSlotLevel: 10, acPerSlotLevel: 1,
        attack: { actionName: 'Deathly Touch', dice: '1d10', baseBonus: 3, baseSpellLevel: 3 },
      })),
    },
  };
}

export function animateDead(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  const skeleton = getMonsterByName('Skeleton');
  if (!skeleton) throw new Error('Animate Dead requires the Skeleton SRD stat block');
  return {
    name: 'Animate Dead', type: 'special', spellLevel: 3, spellSchool: 'necromancy', castingAbility: ability,
    description: 'Animate a Skeleton in an unoccupied space you can see within 10 feet. It obeys your commands for 24 hours.',
    targetScope: 'self', summon: {
      rangeFt: 10, durationRounds: 1440, variants: [{ key: 'skeleton', monsterData: { ...skeleton, actions: skeleton.actions.map(action => ({ ...action })) } }],
    },
  };
}

export function scorchingRay(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Scorching Ray',
    type: 'ranged',
    description: `Three rays of fire. Each is a ranged spell attack +${spellAttackBonus(mod, pb)}, range 120 ft, 2d6 fire damage per hit.`,
    spellLevel: 2,
    spellSchool: 'evocation',
    castingAbility: ability,
    attackBonus: spellAttackBonus(mod, pb),
    damage: '2d6', damageType: 'fire', multiTargetAttack: { count: 3 },
    range: { normal: 120, long: 120 },
    targetScope: 'one_enemy',
  };
}

export function web(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Web',
    type: 'special',
    description: `20-foot sphere. DEX save DC ${saveDC(mod, pb)}; on fail, Restrained until it succeeds on a STR save at the end of its turn. Concentration.`,
    spellLevel: 2,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    savingThrow: {
      ability: 'dex', dc: saveDC(mod, pb),
      conditionOnFail: 'restrained',
      conditionDuration: '1_minute',
      area: '20-foot sphere',
    },
    buffOnFailedSave: { name: 'Web', key: 'web', requiresConcentration: true, appliedCondition: 'restrained', escapeAction: { ability: 'str', dc: saveDC(mod, pb) } },
    targetScope: 'area_enemies',
    persistentZone: { radiusFt: 20, durationRounds: 10, triggers: ['entry', 'turnStart'] },
  };
}

export function holdPerson(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Hold Person',
    type: 'special',
    description: `One Humanoid within 60 ft. WIS save DC ${saveDC(mod, pb)}; on fail, Paralyzed for 1 minute (repeat save each turn). Concentration.`,
    spellLevel: 2,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    targetTypeRestriction: 'Humanoid',
    conditionOnHit: {
      condition: 'paralyzed',
      save: { ability: 'wis', dc: saveDC(mod, pb) },
      duration: '1_minute',
    },
    // We model it as a save-based single-target action. The savingThrow
    // block does the work at executeSpell time.
    savingThrow: {
      ability: 'wis', dc: saveDC(mod, pb),
      conditionOnFail: 'paralyzed',
      conditionDuration: '1_minute',
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
    buffOnFailedSave: { name: 'Hold Person', key: 'hold-person', requiresConcentration: true, appliedConditions: ['paralyzed'], saveEnds: { ability: 'wis', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
  };
}

export function shatter(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Shatter',
    type: 'special',
    description: `10-foot sphere within 60 ft. CON save DC ${saveDC(mod, pb)}; 3d8 thunder damage on fail, half on success.`,
    spellLevel: 2,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'thunder',
    savingThrow: {
      ability: 'con', dc: saveDC(mod, pb),
      damageOnFail: '3d8', damageOnSuccess: 'half',
      area: '10-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

export function moonbeam(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Moonbeam',
    type: 'special',
    description: `5-foot cylinder within 120 ft. CON save DC ${saveDC(mod, pb)}; 2d10 radiant damage on fail, half on success. Concentration; deals damage each turn.`,
    spellLevel: 2,
    concentration: true,
    durationRounds: 10,
    persistentAura: { moveFt: 60 },
    castingAbility: ability,
    damageType: 'radiant',
    savingThrow: {
      ability: 'con', dc: saveDC(mod, pb),
      damageOnFail: '2d10', damageOnSuccess: 'half',
      area: '5-foot cylinder',
    },
    targetScope: 'area_enemies',
  };
}

export function aid(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Aid',
    type: 'special',
    description: 'Bolster up to 3 allies within 30 ft. Each target\'s Hit Point maximum and current Hit Points increase by 5 for the encounter.',
    spellLevel: 2,
    castingAbility: ability,
    buff: {
      name: 'Aid',
      key: 'aid',
      maxHpBonus: 5,
    },
    durationRounds: 1000,
    range: { normal: 30, long: 30 },
    targetScope: 'all_allies_in_area',
    multiTargetBuff: { maxTargets: 3 },
  };
}

export function magicWeapon(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Magic Weapon',
    type: 'special',
    description: 'One ally within 30 ft gains +1 to weapon attack and damage rolls for 1 hour. Its weapon attacks count as magical. Concentration.',
    spellLevel: 2,
    concentration: true,
    durationRounds: 600,
    castingAbility: ability,
    buff: {
      name: 'Magic Weapon', key: 'magic-weapon',
      requiresConcentration: true,
      attackBonusDice: '1',
      weaponDamageBonus: 1,
      weaponAttacksMagical: true,
    },
    range: { normal: 30, long: 30 },
    targetScope: 'one_ally',
  };
}

export function shiningSmite(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Shining Smite',
    type: 'special',
    description: 'Bonus action. The next time you hit the marked enemy with a weapon attack, it takes 2d6 radiant damage. Concentration.',
    spellLevel: 2,
    isBonusAction: true,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    damageType: 'radiant',
    buff: {
      name: 'Shining Smite', key: 'shining-smite',
      requiresConcentration: true,
      damageRider: '2d6 radiant',
      endsOnWeaponHit: true,
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function spiritualWeapon(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Spiritual Weapon',
    type: 'ranged',
    description: `Create a spectral weapon within 60 ft. It immediately makes a melee spell attack +${spellAttackBonus(mod, pb)}, 1d8 + mod force damage; on later turns it can move 20 ft. and attack as a Bonus Action.`,
    spellLevel: 2,
    isBonusAction: true,
    castingAbility: ability,
    attackBonus: spellAttackBonus(mod, pb),
    damage: `1d8+${mod}`,
    damageType: 'force',
    spiritualWeapon: { moveFt: 20 },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function ensnaringStrike(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Ensnaring Strike', type: 'special', spellLevel: 1, spellSchool: 'conjuration', castingAbility: ability,
    description: `Bonus action immediately after a weapon hit. The target makes a Strength save (DC ${saveDC(mod, pb)}) or is Restrained; while restrained it takes 1d6 piercing damage at the start of each of its turns. Concentration.`,
    isBonusAction: true, concentration: true, postHit: { trigger: 'weapon_hit' }, targetScope: 'one_enemy',
    savingThrow: { ability: 'str', dc: saveDC(mod, pb), conditionOnFail: 'restrained', conditionDuration: '1_minute' },
    effects: [{ kind: 'ongoingDamage', key: 'Ensnaring Strike', damage: '1d6', damageType: 'piercing', tick: 'targetTurnStart', condition: 'restrained', requiresConcentration: true }],
  };
}

export function searingSmite(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Searing Smite', type: 'special', spellLevel: 1, spellSchool: 'evocation', castingAbility: ability,
    description: `Bonus action immediately after a melee or unarmed hit. The hit deals 1d6 extra fire damage; the target takes 1d6 fire damage at the start of each turn until it succeeds on a Constitution save (DC ${saveDC(mod, pb)}). Concentration.`,
    isBonusAction: true, concentration: true, postHit: { trigger: 'melee_hit' }, targetScope: 'one_enemy', damage: '1d6', damageType: 'fire',
    effects: [{ kind: 'ongoingDamage', key: 'Searing Smite', damage: '1d6', damageType: 'fire', tick: 'targetTurnStart', saveEnds: { ability: 'con', dc: saveDC(mod, pb), at: 'targetTurnStart' }, maxTicks: 10, requiresConcentration: true }],
  };
}

export function wrathfulSmite(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Wrathful Smite', type: 'special', spellLevel: 1, spellSchool: 'necromancy', castingAbility: ability,
    description: `Bonus action immediately after a melee or unarmed hit. The hit deals 1d6 psychic damage and the target makes a Wisdom save (DC ${saveDC(mod, pb)}) or is Frightened until the end of your next turn.`,
    isBonusAction: true, postHit: { trigger: 'melee_hit' }, targetScope: 'one_enemy', damage: '1d6', damageType: 'psychic',
    savingThrow: { ability: 'wis', dc: saveDC(mod, pb), conditionOnFail: 'frightened', conditionDuration: 'end_of_next_turn' },
  };
}

export function thunderousSmite(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Thunderous Smite', type: 'special', spellLevel: 1, spellSchool: 'evocation', castingAbility: ability,
    description: `Bonus action immediately after a melee or unarmed hit. The hit deals 2d6 thunder damage and the target makes a Strength save (DC ${saveDC(mod, pb)}) or is pushed 10 feet away.`,
    isBonusAction: true, postHit: { trigger: 'melee_hit' }, targetScope: 'one_enemy', damage: '2d6', damageType: 'thunder',
    savingThrow: { ability: 'str', dc: saveDC(mod, pb) }, pushOnFailedSave: 10,
  };
}

export function brandingSmite(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Branding Smite', type: 'special', spellLevel: 2, spellSchool: 'evocation', castingAbility: ability,
    description: 'Bonus action immediately after a melee or unarmed hit. The hit deals 2d6 radiant damage, and the target is outlined in light and cannot benefit from the Invisible condition while you maintain Concentration.',
    isBonusAction: true, concentration: true, postHit: { trigger: 'melee_hit' }, targetScope: 'one_enemy', damage: '2d6', damageType: 'radiant',
    buff: {
      name: 'Branding Smite', key: 'branding-smite', requiresConcentration: true,
      suppressesInvisibility: true,
    },
  };
}

export function spikeGrowth(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Spike Growth', type: 'special', spellLevel: 2, spellSchool: 'transmutation', castingAbility: ability, concentration: true, durationRounds: 100,
    description: `20-foot-radius sphere within 150 feet becomes Difficult Terrain. A creature takes 2d4 piercing damage for every 5 feet it moves into or within the area. Concentration, 10 minutes.`,
    range: { normal: 150, long: 150 }, targetScope: 'area_enemies',
    persistentZone: { radiusFt: 20, durationRounds: 100, triggers: [], difficultTerrain: true, damagePer5Ft: { dice: '2d4', type: 'piercing' } },
  };
}

export function plantGrowth(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Plant Growth', type: 'special', spellLevel: 3, spellSchool: 'transmutation', castingAbility: ability,
    description: 'Plants overgrow a 100-foot-radius area for 8 hours, making the area Difficult Terrain.',
    range: { normal: 150, long: 150 }, targetScope: 'area_enemies',
    persistentZone: { radiusFt: 100, durationRounds: 96, triggers: [], difficultTerrain: true },
  };
}

export function cloudOfDaggers(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Cloud of Daggers',
    type: 'special',
    description: '5-foot cube within 60 ft. Creatures in the cube take 4d4 slashing damage when entering it or starting their turns there. Concentration, 1 minute.',
    spellLevel: 2,
    spellSchool: 'conjuration',
    concentration: true,
    durationRounds: 10,
    persistentAura: { automaticDamage: true, damageOnInitialCast: false },
    castingAbility: ability,
    damageType: 'slashing',
    savingThrow: {
      // The aura infrastructure shares the normal area payload. This spell's
      // persistentAura marker makes this metadata rather than a real save.
      ability: 'dex', dc: saveDC(mod, pb), damageOnFail: '4d4', area: '5-foot cube',
    },
    range: { normal: 60, long: 60 }, targetScope: 'area_enemies',
  };
}

export function flamingSphere(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Flaming Sphere', type: 'special', spellLevel: 2, spellSchool: 'conjuration', castingAbility: ability,
    concentration: true, durationRounds: 10, persistentAura: { moveFt: 30 },
    description: `A 5-foot sphere of fire within 60 feet. Creatures it enters or starts beside make a DC ${saveDC(mod, pb)} DEX save, taking 2d6 fire damage on a failure and half on a success. You can move it 30 feet as an action.`,
    damageType: 'fire', savingThrow: { ability: 'dex', dc: saveDC(mod, pb), damageOnFail: '2d6', damageOnSuccess: 'half', area: '5-foot sphere' },
    range: { normal: 60, long: 60 }, targetScope: 'area_enemies',
  };
}

export function heatMetal(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Heat Metal', type: 'special', spellLevel: 2, spellSchool: 'transmutation', castingAbility: ability,
    concentration: true, durationRounds: 10, range: { normal: 60, long: 60 }, targetScope: 'one_enemy', damageType: 'fire',
    description: 'Heat a manufactured metal object within 60 feet. The creature in contact with it takes 2d8 fire damage immediately and can take the damage again as a Bonus Action on later turns. Concentration.',
    initialDamage: '2d8', initialDamageType: 'fire',
    buff: { name: 'Heat Metal', key: 'heat-metal', requiresConcentration: true, bonusActionDamage: '2d8', bonusActionDamageType: 'fire', bonusActionDamageRange: 60, endsWhenTargetDies: true },
  };
}

export function lesserRestoration(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Lesser Restoration', type: 'special', spellLevel: 2, spellSchool: 'abjuration', castingAbility: ability,
    description: 'End Blinded, Deafened, Paralyzed, or Poisoned on one creature within 30 feet.',
    removesConditions: ['blinded', 'deafened', 'paralyzed', 'poisoned'], range: { normal: 30, long: 30 }, targetScope: 'one_ally',
  };
}

export function mistyStep(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Misty Step', type: 'special', spellLevel: 2, spellSchool: 'conjuration', castingAbility: ability, isBonusAction: true,
    description: 'Bonus action: teleport up to 30 feet to an unoccupied space you can see.', teleport: { distanceFt: 30 }, targetScope: 'self',
  };
}

export function blur(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return { name: 'Blur', type: 'special', spellLevel: 2, spellSchool: 'illusion', castingAbility: ability, concentration: true, durationRounds: 10, description: 'For 1 minute, attack rolls against you have Disadvantage.', targetScope: 'self', buff: { name: 'Blur', key: 'blur', requiresConcentration: true, attackersHaveDisadvantage: true } };
}

export function barkskin(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return { name: 'Barkskin', type: 'special', spellLevel: 2, spellSchool: 'transmutation', castingAbility: ability, durationRounds: 600, description: 'One willing creature has AC 17 for 1 hour while it is not wearing Heavy armor.', range: { normal: 30, long: 30 }, targetScope: 'one_ally', requiresNoHeavyArmor: true, buff: { name: 'Barkskin', key: 'barkskin', acMinimum: 17 } };
}

export function protectionFromPoison(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Protection from Poison', type: 'special', spellLevel: 2, spellSchool: 'abjuration', castingAbility: ability, durationRounds: 600,
    description: 'End Poisoned on one creature within 30 feet; it has resistance to poison damage for 1 hour.',
    removesConditions: ['poisoned'], range: { normal: 30, long: 30 }, targetScope: 'one_ally',
    buff: { name: 'Protection from Poison', key: 'protection-from-poison', resistDamageTypes: ['poison'], saveAdvantageConditions: ['poisoned'] },
  };
}

export function gustOfWind(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Gust of Wind', type: 'special', spellLevel: 2, spellSchool: 'evocation', castingAbility: ability, concentration: true, durationRounds: 10,
    description: `A 60-foot-long, 10-foot-wide line of wind. STR save DC ${saveDC(mod, pb)} or be pushed 15 feet away; creatures ending turns in the line repeat the save. Moving closer to you in the line costs double movement.`,
    savingThrow: { ability: 'str', dc: saveDC(mod, pb), area: '60-foot line' }, pushOnFailedSave: 15, targetScope: 'area_enemies',
    persistentZone: { radiusFt: 60, durationRounds: 10, triggers: ['turnEnd'], shape: 'line', pushOnFailedSave: 15, difficultTerrainTowardSource: true },
  };
}

export function acidArrow(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Acid Arrow', type: 'ranged', spellLevel: 2, spellSchool: 'evocation', castingAbility: ability,
    description: `Ranged spell attack +${spellAttackBonus(mod, pb)}, range 90 ft. 4d4 acid damage on a hit, then 2d4 acid at the end of the target's next turn.`,
    attackBonus: spellAttackBonus(mod, pb), damage: '4d4', damageType: 'acid', range: { normal: 90, long: 90 }, targetScope: 'one_enemy',
    effects: [{ kind: 'ongoingDamage', key: 'Acid Arrow', damage: '2d4', damageType: 'acid', tick: 'targetTurnEnd', maxTicks: 1 }],
  };
}

export function fly(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Fly', type: 'special', spellLevel: 3, spellSchool: 'transmutation', castingAbility: ability, concentration: true, durationRounds: 100,
    description: 'One willing creature within 30 feet gains a 60-foot Fly Speed for 10 minutes.', range: { normal: 30, long: 30 }, targetScope: 'one_ally',
    grantsFlight: { speed: 60, durationRounds: 100 },
  };
}

export function fear(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Fear', type: 'special', spellLevel: 3, spellSchool: 'illusion', castingAbility: ability, concentration: true, durationRounds: 10,
    description: `30-foot cone. WIS save DC ${saveDC(mod, pb)} or Frightened for 1 minute; repeat the save at the end of each turn.`,
    savingThrow: { ability: 'wis', dc: saveDC(mod, pb), conditionOnFail: 'frightened', conditionDuration: '1_minute', area: '30-foot cone' }, targetScope: 'area_enemies',
    buffOnFailedSave: { name: 'Fear', key: 'fear', requiresConcentration: true, appliedConditions: ['frightened'], forcedFlee: true, saveEnds: { ability: 'wis', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
  };
}

export function revivify(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Revivify', type: 'special', spellLevel: 3, spellSchool: 'necromancy', castingAbility: ability,
    description: 'A creature that died within the last minute returns to life with 1 HP.',
    revive: { maxDeathRounds: 10, hp: 1 }, range: { normal: 5, long: 5 }, targetScope: 'one_ally',
  };
}

export function bestowCurse(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Bestow Curse', type: 'special', spellLevel: 3, spellSchool: 'necromancy', castingAbility: ability, concentration: true, durationRounds: 10,
    description: `One creature you touch. WIS save DC ${saveDC(mod, pb)} or suffers the chosen combat curse for 1 minute.`,
    savingThrow: { ability: 'wis', dc: saveDC(mod, pb) }, range: { normal: 5, long: 5 }, targetScope: 'one_enemy',
    buffOnFailedSave: { name: 'Bestow Curse', key: 'bestow-curse', requiresConcentration: true, attackDisadvantage: true, attackDisadvantageAgainstCaster: true },
    curseChoice: { choices: ['ability_str', 'ability_dex', 'ability_con', 'ability_int', 'ability_wis', 'ability_cha', 'attack_disadvantage', 'forced_dodge', 'damage_rider'], selected: 'attack_disadvantage' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-3 spells
// ─────────────────────────────────────────────────────────────────────────────

export function fireball(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Fireball',
    type: 'special',
    description: `20-foot sphere within 150 ft. DEX save DC ${saveDC(mod, pb)}; 8d6 fire damage on fail, half on success.`,
    spellLevel: 3,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'fire',
    savingThrow: {
      ability: 'dex', dc: saveDC(mod, pb),
      damageOnFail: '8d6', damageOnSuccess: 'half',
      area: '20-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

export function lightningBolt(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Lightning Bolt',
    type: 'special',
    description: `100-foot line. DEX save DC ${saveDC(mod, pb)}; 8d6 lightning damage on fail, half on success.`,
    spellLevel: 3,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'lightning',
    savingThrow: {
      ability: 'dex', dc: saveDC(mod, pb),
      damageOnFail: '8d6', damageOnSuccess: 'half',
      area: '100-foot line',
    },
    targetScope: 'area_enemies',
  };
}

export function spiritGuardians(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Spirit Guardians',
    type: 'special',
    description: `15-foot emanation centered on you. WIS save DC ${saveDC(mod, pb)}; 3d8 radiant/necrotic damage on fail, half on success. Concentration for 10 minutes; damage repeats when enemies enter or start their turns in the aura.`,
    spellLevel: 3,
    concentration: true,
    durationRounds: 10,
    persistentAura: {},
    castingAbility: ability,
    damageType: 'radiant',
    savingThrow: {
      ability: 'wis', dc: saveDC(mod, pb),
      damageOnFail: '3d8', damageOnSuccess: 'half',
      area: '15-foot emanation',
    },
    targetScope: 'area_enemies',
  };
}

export function callLightning(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Call Lightning',
    type: 'special',
    description: `5-foot cylinder within 120 ft. DEX save DC ${saveDC(mod, pb)}; 3d10 lightning damage on fail, half on success. Concentration; repeat the bolt as an action on later turns.`,
    spellLevel: 3,
    concentration: true,
    durationRounds: 10,
    repeatableAreaSpell: true,
    castingAbility: ability,
    damageType: 'lightning',
    savingThrow: {
      ability: 'dex', dc: saveDC(mod, pb),
      damageOnFail: '3d10', damageOnSuccess: 'half',
      area: '5-foot cylinder',
    },
    targetScope: 'area_enemies',
  };
}

export function hypnoticPattern(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Hypnotic Pattern',
    type: 'special',
    description: `30-foot cube within 120 ft. WIS save DC ${saveDC(mod, pb)}; on fail, Incapacitated for 1 minute (breaks on damage). Concentration.`,
    spellLevel: 3,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    savingThrow: {
      ability: 'wis', dc: saveDC(mod, pb),
      conditionOnFail: 'incapacitated',
      conditionDuration: '1_minute',
      area: '30-foot sphere',
    },
    targetScope: 'area_enemies',
    buffOnFailedSave: { name: 'Hypnotic Pattern', key: 'hypnotic-pattern', requiresConcentration: true, appliedConditions: ['incapacitated'], endsOnDamage: true },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-3 spells (half-caster)
// ─────────────────────────────────────────────────────────────────────────────

export function blindingSmite(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Blinding Smite',
    type: 'special',
    description: `Bonus action. Next melee hit deals extra 3d8 radiant + target CON save DC ${saveDC(mod, pb)} or Blinded until end of your next turn. Concentration.`,
    spellLevel: 3,
    isBonusAction: true,
    concentration: true,
    durationRounds: 1,
    castingAbility: ability,
    damageType: 'radiant',
    buff: {
      name: 'Blinding Smite', key: 'blinding-smite',
      requiresConcentration: true,
      weaponDamageRider: '3d8 radiant',
      weaponConditionOnHit: { condition: 'blinded', save: { ability: 'con', dc: saveDC(mod, pb) }, duration: 'end_of_next_turn' },
      endsOnWeaponHit: true,
    },
    targetScope: 'self',
  };
}

export function conjureBarrage(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Conjure Barrage',
    type: 'special',
    description: `60-foot Cone. DEX save DC ${saveDC(mod, pb)}; 3d8 force damage on fail, half on success.`,
    spellLevel: 3,
    castingAbility: ability,
    damageType: 'force',
    savingThrow: {
      ability: 'dex', dc: saveDC(mod, pb),
      damageOnFail: '3d8', damageOnSuccess: 'half',
      area: '60-foot Cone',
    },
    targetScope: 'area_enemies',
  };
}

export function protectionFromEnergy(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Protection from Energy',
    type: 'special',
    description: `Touch one creature. Grants Resistance to acid, cold, fire, lightning, or thunder damage. Concentration, up to 1 hour.`,
    spellLevel: 3,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    buff: {
      name: 'Protection from Energy', key: 'protection-energy',
      requiresConcentration: true,
    },
    damageResistanceChoice: { choices: ['acid', 'cold', 'fire', 'lightning', 'thunder'] },
    targetScope: 'one_ally',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-4 spells
// ─────────────────────────────────────────────────────────────────────────────

export function iceStorm(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Ice Storm',
    type: 'special',
    description: `20-foot sphere within 300 ft. DEX save DC ${saveDC(mod, pb)}; 2d8 bludgeoning + 4d6 cold on fail, half on success.`,
    spellLevel: 4,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'cold',
    savingThrow: {
      ability: 'dex', dc: saveDC(mod, pb),
      damageOnFail: '2d8+4d6', damageOnSuccess: 'half',
      area: '20-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

export function banishment(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Banishment',
    type: 'special',
    description: `One creature within 60 ft. CHA save DC ${saveDC(mod, pb)}; on fail, Incapacitated for 1 minute (banished to a harmless demiplane). Concentration.`,
    spellLevel: 4,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    savingThrow: {
      ability: 'cha', dc: saveDC(mod, pb),
      conditionOnFail: 'incapacitated',
      conditionDuration: '1_minute',
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function blight(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Blight',
    type: 'special',
    description: `One creature within 30 ft. CON save DC ${saveDC(mod, pb)}; 8d8 necrotic on fail, half on success.`,
    spellLevel: 4,
    castingAbility: ability,
    damageType: 'necrotic',
    savingThrow: {
      ability: 'con', dc: saveDC(mod, pb),
      damageOnFail: '8d8', damageOnSuccess: 'half',
    },
    range: { normal: 30, long: 30 },
    targetScope: 'one_enemy',
  };
}

export function fireShield(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Fire Shield',
    type: 'special',
    description: `Self. For 10 minutes, gain Resistance to cold or fire damage. When a creature within 5 ft hits you with a melee attack, it takes 2d8 fire damage. No concentration.`,
    spellLevel: 4,
    spellSchool: 'evocation',
    castingAbility: ability,
    buff: {
      name: 'Fire Shield', key: 'fire-shield',
      requiresConcentration: false,
      resistPhysical: false,
      reactiveDamage: '2d8 fire',
    },
    durationRounds: 100,
    targetScope: 'self',
  };
}

export function stoneskin(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Stoneskin',
    type: 'special',
    description: `Self or one willing creature. Resistance to bludgeoning, piercing, and slashing damage. Concentration, up to 1 hour.`,
    spellLevel: 4,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    buff: {
      name: 'Stoneskin', key: 'stoneskin',
      requiresConcentration: true,
      resistPhysical: true,
    },
    targetScope: 'self',
  };
}

export function deathWard(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Death Ward',
    type: 'special',
    description: `Touch one creature. For 8 hours, the first time the target would drop to 0 HP, it drops to 1 HP instead. No concentration.`,
    spellLevel: 4,
    castingAbility: ability,
    buff: {
      name: 'Death Ward', key: 'death-ward',
      requiresConcentration: false,
      preventDeath: true,
    },
    durationRounds: 100,
    targetScope: 'one_ally',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-5 spells
// ─────────────────────────────────────────────────────────────────────────────

export function coneOfCold(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Cone of Cold',
    type: 'special',
    description: `60-foot Cone. CON save DC ${saveDC(mod, pb)}; 8d8 cold damage on fail, half on success.`,
    spellLevel: 5,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'cold',
    savingThrow: {
      ability: 'con', dc: saveDC(mod, pb),
      damageOnFail: '8d8', damageOnSuccess: 'half',
      area: '60-foot Cone',
    },
    targetScope: 'area_enemies',
  };
}

export function flameStrike(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Flame Strike',
    type: 'special',
    description: `10-foot radius, 40-foot high cylinder within 60 ft. DEX save DC ${saveDC(mod, pb)}; 5d6 fire + 5d6 radiant on fail, half on success.`,
    spellLevel: 5,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'radiant',
    savingThrow: {
      ability: 'dex', dc: saveDC(mod, pb),
      damageOnFail: '5d6+5d6', damageOnSuccess: 'half',
      area: '10-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

export function holdMonster(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Hold Monster',
    type: 'special',
    description: `One creature within 60 ft. WIS save DC ${saveDC(mod, pb)}; on fail, Paralyzed for 1 minute (repeat save each turn). Concentration. Works on any creature type.`,
    spellLevel: 5,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    savingThrow: {
      ability: 'wis', dc: saveDC(mod, pb),
      conditionOnFail: 'paralyzed',
      conditionDuration: '1_minute',
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function massCureWounds(ability: SpellcastingAbility, mod: number, _pb: number): MonsterAction {
  void _pb;
  return {
    name: 'Mass Cure Wounds',
    type: 'special',
    description: `Up to 6 creatures within 30 ft. Each regains 5d8 + ${mod} HP.`,
    spellLevel: 5,
    castingAbility: ability,
    heal: { dice: `5d8+${mod}`, addCastingMod: false },
    targetScope: 'all_allies_in_area',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-6 Cleric/Druid spells
// ─────────────────────────────────────────────────────────────────────────────

export function harm(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Harm',
    type: 'special',
    description: `One creature within 60 ft. CON save DC ${saveDC(mod, pb)}; 14d6 necrotic damage on fail, half on success. Hit point maximum reduction is not yet modeled for hero spells.`,
    spellLevel: 6,
    castingAbility: ability,
    damageType: 'necrotic',
    savingThrow: {
      ability: 'con',
      dc: saveDC(mod, pb),
      damageOnFail: '14d6',
      damageOnSuccess: 'half',
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function circleOfDeath(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Circle of Death',
    type: 'special',
    description: `60-foot sphere within 150 ft. CON save DC ${saveDC(mod, pb)}; 8d6 necrotic damage on fail, half on success.`,
    spellLevel: 6,
    castingAbility: ability,
    damageType: 'necrotic',
    savingThrow: {
      ability: 'con',
      dc: saveDC(mod, pb),
      damageOnFail: '8d6',
      damageOnSuccess: 'half',
      area: '60-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

export function chainLightning(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Chain Lightning',
    type: 'special',
    description: `One target within 150 ft, then lightning arcs to up to three nearby enemies. DEX save DC ${saveDC(mod, pb)}; 10d8 lightning damage on fail, half on success. Modeled as a targeted enemy-only chain area.`,
    spellLevel: 6,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'lightning',
    savingThrow: {
      ability: 'dex',
      dc: saveDC(mod, pb),
      damageOnFail: '10d8',
      damageOnSuccess: 'half',
      area: '30-foot sphere',
    },
    range: { normal: 150, long: 150 },
    targetScope: 'area_enemies',
  };
}

export function disintegrate(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Disintegrate',
    type: 'special',
    description: `One creature within 60 ft. DEX save DC ${saveDC(mod, pb)}; 10d6+40 force damage on fail, no damage on success. The disintegration-at-0 visual rider is not simulated.`,
    spellLevel: 6,
    castingAbility: ability,
    damageType: 'force',
    savingThrow: {
      ability: 'dex',
      dc: saveDC(mod, pb),
      damageOnFail: '10d6+40',
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function fingerOfDeath(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Finger of Death',
    type: 'special',
    description: `One creature within 60 ft. CON save DC ${saveDC(mod, pb)}; 7d8+30 necrotic damage on fail, half on success. Zombie-creation rider is not simulated.`,
    spellLevel: 7,
    castingAbility: ability,
    damageType: 'necrotic',
    savingThrow: {
      ability: 'con',
      dc: saveDC(mod, pb),
      damageOnFail: '7d8+30',
      damageOnSuccess: 'half',
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function heal(ability: SpellcastingAbility): MonsterAction {
  return {
    name: 'Heal',
    type: 'special',
    description: 'One creature within 60 ft regains 70 HP and ends Blinded, Deafened, and Poisoned.',
    spellLevel: 6,
    castingAbility: ability,
    heal: { dice: '70', addCastingMod: false, clearsConditions: ['blinded', 'deafened', 'poisoned'] },
    range: { normal: 60, long: 60 },
    targetScope: 'one_ally',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-7 and Level-8 spells
// ─────────────────────────────────────────────────────────────────────────────

export function fireStorm(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Fire Storm',
    type: 'special',
    description: `Up to ten contiguous 10-foot cubes within 150 ft. DEX save DC ${saveDC(mod, pb)}; 7d10 fire damage on fail, half on success. Modeled as a broad targeted AoE.`,
    spellLevel: 7,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'fire',
    savingThrow: {
      ability: 'dex',
      dc: saveDC(mod, pb),
      damageOnFail: '7d10',
      damageOnSuccess: 'half',
      area: '20-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

export function sunburst(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Sunburst',
    type: 'special',
    description: `60-foot sphere within 150 ft. CON save DC ${saveDC(mod, pb)}; 12d6 radiant damage on fail and Blinded for 1 minute, half damage on success.`,
    spellLevel: 8,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'radiant',
    savingThrow: {
      ability: 'con',
      dc: saveDC(mod, pb),
      damageOnFail: '12d6',
      damageOnSuccess: 'half',
      conditionOnFail: 'blinded',
      conditionDuration: '1_minute',
      area: '60-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

export function meteorSwarm(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Meteor Swarm',
    type: 'special',
    description: `Four 40-foot spheres within 1 mile. DEX save DC ${saveDC(mod, pb)}; 20d6 fire plus 20d6 bludgeoning damage on fail, half on success.`,
    spellLevel: 9,
    spellSchool: 'evocation',
    castingAbility: ability,
    damageType: 'fire',
    savingThrow: {
      ability: 'dex',
      dc: saveDC(mod, pb),
      damageOnFail: '20d6',
      damageOnSuccess: 'half',
      extraDamageOnFail: [{ damage: '20d6', damageType: 'bludgeoning' }],
      area: '40-foot sphere',
    },
    range: { normal: 5280, long: 5280 },
    targetScope: 'area_enemies',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-9 Cleric spells
// ─────────────────────────────────────────────────────────────────────────────

export function massHeal(ability: SpellcastingAbility): MonsterAction {
  return {
    name: 'Mass Heal',
    type: 'special',
    description: 'Restore up to 700 HP divided among any number of creatures within 60 ft; healed targets also end Blinded, Deafened, and Poisoned. Modeled as a full-party emergency heal.',
    spellLevel: 9,
    castingAbility: ability,
    heal: { dice: '700', addCastingMod: false, clearsConditions: ['blinded', 'deafened', 'poisoned'] },
    range: { normal: 60, long: 60 },
    targetScope: 'all_allies_in_area',
  };
}

export function stormOfVengeance(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Storm of Vengeance',
    type: 'special',
    description: `A raging storm forms over the battlefield. CON save DC ${saveDC(mod, pb)}; 6d10 lightning and thunder damage on fail, half on success. Concentration; modeled as a persistent large storm aura.`,
    spellLevel: 9,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    damageType: 'lightning',
    savingThrow: {
      ability: 'con',
      dc: saveDC(mod, pb),
      damageOnFail: '6d10',
      damageOnSuccess: 'half',
      area: '60-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

export function synapticStatic(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Synaptic Static',
    type: 'special',
    description: `20-foot sphere within 120 ft. INT save DC ${saveDC(mod, pb)}; 8d6 psychic on fail, half on success. Failed targets subtract 1d6 from attack rolls and ability checks for 1 minute. Not concentration.`,
    spellLevel: 5,
    castingAbility: ability,
    damageType: 'psychic',
    savingThrow: {
      ability: 'int', dc: saveDC(mod, pb),
      damageOnFail: '8d6', damageOnSuccess: 'half',
      area: '20-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Level-8 and Level-9 spells
// ─────────────────────────────────────────────────────────────────────────────

export function befuddlement(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Befuddlement',
    type: 'special',
    description: `One creature within 150 ft. INT save DC ${saveDC(mod, pb)}; 10d12 psychic damage on fail, half on success. The no-Magic-action rider is not yet simulated.`,
    spellLevel: 8,
    castingAbility: ability,
    damageType: 'psychic',
    savingThrow: {
      ability: 'int',
      dc: saveDC(mod, pb),
      damageOnFail: '10d12',
      damageOnSuccess: 'half',
    },
    range: { normal: 150, long: 150 },
    targetScope: 'one_enemy',
  };
}

export function powerWordHeal(ability: SpellcastingAbility): MonsterAction {
  return {
    name: 'Power Word Heal',
    type: 'special',
    description: 'One creature within 60 ft regains all HP and ends Charmed, Frightened, Paralyzed, Poisoned, and Stunned. A Prone target stands if its Reaction is available. Bard L20 Words of Creation can affect a second creature within 10 ft of the first.',
    spellLevel: 9,
    castingAbility: ability,
    range: { normal: 60, long: 60 },
    targetScope: 'one_ally',
    powerWord: {
      kind: 'heal',
      secondaryRange: 10,
      clearsConditions: ['charmed', 'frightened', 'paralyzed', 'poisoned', 'stunned'],
    },
  };
}

export function powerWordKill(ability: SpellcastingAbility): MonsterAction {
  return {
    name: 'Power Word Kill',
    type: 'special',
    description: 'One creature within 60 ft dies if it has 100 HP or fewer; otherwise it takes 12d12 psychic damage. Bard L20 Words of Creation can affect a second creature within 10 ft of the first.',
    spellLevel: 9,
    castingAbility: ability,
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
    powerWord: {
      kind: 'kill',
      secondaryRange: 10,
      killThresholdHp: 100,
      fallbackDamage: '12d12',
      fallbackDamageType: 'psychic',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional spells (available in party builder, not in default class loadouts)
// ─────────────────────────────────────────────────────────────────────────────

export function chromaticOrb(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Chromatic Orb',
    type: 'ranged',
    description: `Ranged spell attack +${spellAttackBonus(mod, pb)}, range 90 ft. 3d8 damage (choose acid, cold, fire, lightning, poison, or thunder).`,
    spellLevel: 1,
    spellSchool: 'evocation',
    castingAbility: ability,
    attackBonus: spellAttackBonus(mod, pb),
    damage: '3d8', damageType: 'fire',
    damageTypeChoice: { choices: ['acid', 'cold', 'fire', 'lightning', 'poison', 'thunder'] },
    range: { normal: 90, long: 90 },
    targetScope: 'one_enemy',
  };
}

export function inflictWounds(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Inflict Wounds',
    type: 'special',
    description: `One creature within 15 ft. CON save DC ${saveDC(mod, pb)}; 2d10 necrotic damage on a failed save, half on a successful one.`,
    spellLevel: 1,
    spellSchool: 'necromancy',
    castingAbility: ability,
    damageType: 'necrotic',
    savingThrow: { ability: 'con', dc: saveDC(mod, pb), damageOnFail: '2d10', damageOnSuccess: 'half' },
    range: { normal: 15, long: 15 },
    targetScope: 'one_enemy',
  };
}

export function iceKnife(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Ice Knife', type: 'ranged', spellLevel: 1, spellSchool: 'conjuration', castingAbility: ability,
    description: `Ranged spell attack within 60 feet for 1d10 piercing damage. Hit or miss, the shard explodes; the target and each creature within 5 feet make a Dexterity save (DC ${saveDC(mod, pb)}) or take 2d6 cold damage.`,
    attackBonus: spellAttackBonus(mod, pb), damage: '1d10', damageType: 'piercing', magical: true,
    range: { normal: 60, long: 60 }, targetScope: 'one_enemy',
    attackThenArea: { damage: '2d6', damageType: 'cold', radiusFt: 5, saveAbility: 'dex', saveDc: saveDC(mod, pb) },
  };
}

export function command(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Command',
    type: 'special',
    description: `One creature within 60 ft. WIS save DC ${saveDC(mod, pb)}; on fail, incapacitated until end of its next turn.`,
    spellLevel: 1,
    castingAbility: ability,
    savingThrow: {
      ability: 'wis', dc: saveDC(mod, pb),
      conditionOnFail: 'incapacitated',
      conditionDuration: 'end_of_next_turn',
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function witchBolt(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Witch Bolt',
    type: 'ranged',
    description: `Ranged spell attack +${spellAttackBonus(mod, pb)}, range 60 ft. 2d12 lightning damage. Concentration. On later turns, bonus action for 1d12 automatic lightning damage to the linked target.`,
    spellLevel: 1,
    spellSchool: 'evocation',
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    attackBonus: spellAttackBonus(mod, pb),
    damage: '2d12', damageType: 'lightning',
    buff: {
      name: 'Witch Bolt', key: 'witch-bolt',
      requiresConcentration: true,
      bonusActionDamage: '1d12',
      bonusActionDamageType: 'lightning',
      bonusActionDamageRange: 60,
      endsWhenTargetDies: true,
    },
    range: { normal: 60, long: 60 },
    targetScope: 'one_enemy',
  };
}

export function blindnessDeafness(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Blindness/Deafness',
    type: 'special',
    description: `One creature within 120 ft. CON save DC ${saveDC(mod, pb)}; on fail, blinded for 1 minute (save each turn). No concentration.`,
    spellLevel: 2,
    castingAbility: ability,
    savingThrow: {
      ability: 'con', dc: saveDC(mod, pb),
      conditionOnFail: 'blinded',
      conditionDuration: '1_minute',
    },
    buffOnFailedSave: { name: 'Blindness/Deafness', key: 'blindness-deafness', appliedCondition: 'blinded', saveEnds: { ability: 'con', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
    range: { normal: 120, long: 120 },
    targetScope: 'one_enemy',
  };
}

export function mirrorImage(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Mirror Image',
    type: 'special',
    description: 'Self. Three illusory duplicates can intercept attacks for 1 minute. No concentration.',
    spellLevel: 2,
    castingAbility: ability,
    buff: {
      name: 'Mirror Image', key: 'mirror-image',
      requiresConcentration: false,
      mirrorImages: 3,
    },
    durationRounds: 10,
    targetScope: 'self',
  };
}

export function charmPerson(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Charm Person', type: 'special', spellLevel: 1, spellSchool: 'enchantment', castingAbility: ability,
    description: `One Humanoid within 30 feet makes a WIS save (DC ${saveDC(mod, pb)}). On a failure, it is Charmed by you for 1 minute.`,
    range: { normal: 30, long: 30 }, targetScope: 'one_enemy', targetTypeRestriction: 'Humanoid',
    savingThrow: { ability: 'wis', dc: saveDC(mod, pb), conditionOnFail: 'charmed', conditionDuration: '1_minute' },
  };
}

export function invisibility(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Invisibility', type: 'special', spellLevel: 2, spellSchool: 'illusion', castingAbility: ability,
    concentration: true, durationRounds: 600,
    description: 'One willing creature within 30 feet becomes Invisible until concentration ends, it attacks, or it casts a spell.',
    range: { normal: 30, long: 30 }, targetScope: 'one_ally',
    buff: { name: 'Invisibility', key: 'invisibility', requiresConcentration: true, appliedCondition: 'invisible', endsOnAttackOrCast: true },
  };
}

export function seeInvisibility(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'See Invisibility', type: 'special', spellLevel: 2, spellSchool: 'divination', castingAbility: ability,
    durationRounds: 600,
    description: 'For 1 hour, you can see Invisible creatures and objects as though they were visible.',
    targetScope: 'self', buff: { name: 'See Invisibility', key: 'see-invisibility', canSeeInvisible: true },
  };
}

export function dispelMagic(_ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _ability;
  void _mod;
  void _pb;
  return {
    name: 'Dispel Magic',
    type: 'special',
    description: 'End one spell or buff on a creature within 120 ft. Automatically ends spells of 3rd level or lower.',
    spellLevel: 3,
    dispelMagic: { maxSpellLevel: 3 },
    targetScope: 'any_one',
    range: { normal: 120, long: 120 },
  };
}

export function haste(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  return {
    name: 'Haste',
    type: 'special',
    description: 'One willing creature within 30 ft. +2 AC, +30 feet of Speed, Advantage on DEX saves, and one restricted extra action each turn (one attack, Dash, Disengage, or Hide). Concentration, 1 minute.',
    spellLevel: 3,
    concentration: true,
    durationRounds: 10,
    castingAbility: ability,
    buff: {
      name: 'Haste', key: 'haste',
      requiresConcentration: true,
      acBonus: 2,
      speedBonus: 30,
      hasteAction: true,
      saveAdvantageAbilities: ['dex'],
    },
    range: { normal: 30, long: 30 },
    targetScope: 'one_ally',
  };
}

export function slow(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Slow', type: 'special', spellLevel: 3, spellSchool: 'transmutation', castingAbility: ability, concentration: true, durationRounds: 10,
    description: `Up to 6 creatures within 120 feet make a WIS save (DC ${saveDC(mod, pb)}). On a failure, Speed is halved, AC is reduced by 2, Dexterity saves have Disadvantage, Reactions are unavailable, it can take only one attack, and it cannot take both an Action and a Bonus Action.`,
    range: { normal: 120, long: 120 }, targetScope: 'one_enemy', multiTargetSave: { maxTargets: 6 }, savingThrow: { ability: 'wis', dc: saveDC(mod, pb) },
    buffOnFailedSave: { name: 'Slow', key: 'slow', requiresConcentration: true, acBonus: -2, speedPenalty: 15, saveDisadvantageAbilities: ['dex'], preventsReactions: true, limitAttacksToOne: true, restrictActionBonusCombination: true, saveEnds: { ability: 'wis', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
  };
}

export function beaconOfHope(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Beacon of Hope', type: 'special', spellLevel: 3, spellSchool: 'abjuration', castingAbility: ability, concentration: true, durationRounds: 10,
    description: 'Up to 6 creatures within 30 feet have Advantage on Wisdom saving throws and receive the maximum possible healing from spells. Concentration, 1 minute.',
    range: { normal: 30, long: 30 }, targetScope: 'all_allies_in_area', multiTargetBuff: { maxTargets: 6 },
    buff: { name: 'Beacon of Hope', key: 'beacon-of-hope', requiresConcentration: true, saveAdvantageAbilities: ['wis'], maximizesHealing: true },
  };
}

export function massHealingWord(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Mass Healing Word', type: 'special', spellLevel: 3, spellSchool: 'abjuration', castingAbility: ability, isBonusAction: true,
    description: 'Up to six creatures within 60 feet regain 2d4 plus your spellcasting ability modifier Hit Points. Bonus action.',
    range: { normal: 60, long: 60 }, targetScope: 'all_allies_in_area', multiTargetHeal: { maxTargets: 6 }, heal: { dice: '2d4', addCastingMod: true },
  };
}

/**
 * Sleet Storm creates a persistent, heavily obscured area. The generic zone
 * resolver handles its difficult terrain and the Dexterity save made when a
 * creature enters or starts its turn there.
 */
export function sleetStorm(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Sleet Storm', type: 'special', spellLevel: 3, spellSchool: 'conjuration',
    castingAbility: ability, concentration: true, durationRounds: 10,
    description: `A 20-foot-radius sphere within 150 feet is heavily obscured and difficult terrain. A creature that enters the area for the first time on a turn or starts its turn there makes a Dexterity save (DC ${saveDC(mod, pb)}) or falls Prone. Concentration, 1 minute.`,
    range: { normal: 150, long: 150 }, targetScope: 'area_enemies',
    savingThrow: { ability: 'dex', dc: saveDC(mod, pb), conditionOnFail: 'prone', conditionDuration: 'end_of_current_turn', area: '20-foot sphere' },
    persistentZone: { radiusFt: 20, durationRounds: 10, triggers: ['entry', 'turnStart'], difficultTerrain: true, obscuresSight: true },
  };
}

export function hungerOfHadar(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Hunger of Hadar', type: 'special', spellLevel: 3, spellSchool: 'conjuration', castingAbility: ability,
    concentration: true, durationRounds: 10,
    description: `A 20-foot-radius sphere within 150 feet is difficult terrain and heavily obscured. Creatures in the area make a Constitution save (DC ${saveDC(mod, pb)}) or take 2d6 cold damage; the area damages creatures at the start and end of their turns. Concentration, 1 minute.`,
    range: { normal: 150, long: 150 }, targetScope: 'area_enemies', damageType: 'cold',
    savingThrow: { ability: 'con', dc: saveDC(mod, pb), damageOnFail: '2d6', damageOnSuccess: 'half', area: '20-foot sphere' },
    persistentAura: { automaticDamage: true, damageOnInitialCast: true, triggers: ['turnStart', 'turnEnd'] },
  };
}

export function windWall(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Wind Wall', type: 'special', spellLevel: 3, spellSchool: 'evocation', castingAbility: ability,
    concentration: true, durationRounds: 10,
    description: `A 60-foot line of strong wind appears within 120 feet. Creatures in it make a Strength save (DC ${saveDC(mod, pb)}) for 4d8 bludgeoning damage, half on a success. Concentration, 1 minute.`,
    range: { normal: 120, long: 120 }, targetScope: 'area_enemies', damageType: 'bludgeoning',
    savingThrow: { ability: 'str', dc: saveDC(mod, pb), damageOnFail: '4d8', damageOnSuccess: 'half', area: '60-foot line' },
    persistentZone: { radiusFt: 60, durationRounds: 10, triggers: ['entry', 'turnStart'], shape: 'line' },
  };
}

export function stinkingCloud(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Stinking Cloud', type: 'special', spellLevel: 3, spellSchool: 'conjuration', castingAbility: ability, concentration: true, durationRounds: 10,
    description: 'A 20-foot-radius cloud is heavily obscured. A creature that starts its turn there makes a Constitution save or is Poisoned and cannot take Actions or Bonus Actions until the end of that turn.',
    range: { normal: 90, long: 90 }, targetScope: 'area_enemies',
    savingThrow: { ability: 'con', dc: saveDC(_mod, _pb), conditionOnFail: 'poisoned', conditionDuration: 'end_of_current_turn', area: '20-foot sphere' },
    persistentZone: { radiusFt: 20, durationRounds: 10, triggers: ['turnStart'], skipActionsOnFailedSave: true, obscuresSight: true },
  };
}

export function vampiricTouch(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return { name: 'Vampiric Touch', type: 'melee', description: 'Make a melee spell attack for 3d6 necrotic damage and regain half the damage dealt. Repeat as an Action while concentrating.', spellLevel: 3, spellSchool: 'necromancy', castingAbility: ability, concentration: true, durationRounds: 10, attackBonus: mod + pb, damage: '3d6', damageType: 'necrotic', magical: true, range: { normal: 5, long: 5 }, targetScope: 'one_enemy', repeatableActionSpell: { healFromDamage: true } };
}

export function wallOfFire(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Wall of Fire',
    type: 'special',
    description: `60-foot-long wall of fire within 120 ft. Creatures within 10 ft of one side take 5d8 fire damage (DEX save DC ${saveDC(mod, pb)} for half) when entering or starting turn. Concentration, 1 minute.`,
    spellLevel: 4,
    spellSchool: 'evocation',
    concentration: true,
    durationRounds: 600,
    persistentAura: {},
    castingAbility: ability,
    damageType: 'fire',
    savingThrow: {
      ability: 'dex', dc: saveDC(mod, pb),
      damageOnFail: '5d8', damageOnSuccess: 'half',
      area: '20-foot sphere',
    },
    targetScope: 'area_enemies',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spell catalog (for homebrew monster spell picker)
// ─────────────────────────────────────────────────────────────────────────────

type SpellFactory = (ability: SpellcastingAbility, mod: number, pb: number) => MonsterAction;
const SPELL_FACTORIES: [string, SpellFactory][] = [
  ['Magic Missile', () => magicMissile()], ['Lightning Arrow', lightningArrow], ['Silence', silence], ['Compelled Duel', compelledDuel], ['Warding Wind', wardingWind],
  ['Blade Ward', bladeWard], ['Resistance', resistance], ['Shillelagh', shillelagh], ['Sorcerous Burst', sorcerousBurst], ['Poison Spray', poisonSpray], ['Produce Flame', produceFlame], ['Thorn Whip', thornWhip], ['Acid Splash', acidSplash], ['Starry Wisp', starryWisp], ['Thunderclap', thunderclap], ['Toll the Dead', tollTheDead], ['True Strike', trueStrike],
  ['Shield', shield], ['Hail of Thorns', hailOfThorns],
  ['Hellish Rebuke', hellishRebuke],
  ['Burning Hands', burningHands], ['Thunderwave', thunderwave], ['Sleep', sleep],
  ['Bless', () => bless()], ['Bane', bane], ['Cure Wounds', cureWounds],
  ['Sanctuary', sanctuary],
  ['Protection from Evil and Good', protectionFromEvilAndGood],
  ['Healing Word', healingWord], ['Shield of Faith', () => shieldOfFaith()], ['Warding Bond', () => wardingBond()],
  ['Heroism', heroism],
  ['Guiding Bolt', guidingBolt], ['Dissonant Whispers', dissonantWhispers],
  ['Entangle', entangle], ['Command', command], ['Chromatic Orb', chromaticOrb],
  ['Inflict Wounds', inflictWounds], ['Witch Bolt', witchBolt],
  ['Ice Knife', iceKnife], ['Charm Person', charmPerson],
  ['Arms of Hadar', armsOfHadar], ['Color Spray', colorSpray], ['Divine Favor', divineFavor],
  ['Armor of Agathys', armorOfAgathys], ['Faerie Fire', faerieFire], ['False Life', falseLife], ['Fog Cloud', fogCloud], ['Grease', grease], ['Longstrider', longstrider],
  ['Expeditious Retreat', expeditiousRetreat],
  ['Darkness', darkness],
  ['Pass without Trace', passWithoutTrace],
  ['Enlarge/Reduce', enlargeReduce],
  ['Mage Armor', mageArmor],
  ['Ray of Enfeeblement', rayOfEnfeeblement], ['Ray of Sickness', rayOfSickness], ["Tasha's Hideous Laughter", tashasHideousLaughter],
  ['Scorching Ray', scorchingRay], ['Summon Beast', summonBeast], ['Summon Fey', summonFey], ['Summon Undead', summonUndead], ['Animate Dead', animateDead], ['Find Steed', findSteed], ['Conjure Animals', conjureAnimals], ['Web', web], ['Spike Growth', spikeGrowth], ['Plant Growth', plantGrowth], ['Hold Person', holdPerson],
  ['Flaming Sphere', flamingSphere], ['Flame Blade', flameBlade], ['Heat Metal', heatMetal], ['Cloud of Daggers', cloudOfDaggers],
  ['Shatter', shatter], ['Moonbeam', moonbeam], ['Spiritual Weapon', spiritualWeapon],
  ['Aid', aid], ['Magic Weapon', magicWeapon], ['Shining Smite', shiningSmite],
  ['Branding Smite', brandingSmite], ['Ensnaring Strike', ensnaringStrike], ['Searing Smite', searingSmite], ['Thunderous Smite', thunderousSmite], ['Wrathful Smite', wrathfulSmite],
  ['Blindness/Deafness', blindnessDeafness], ['Mirror Image', mirrorImage],
  ['Invisibility', invisibility],
  ['Counterspell', counterspell],
  ['See Invisibility', seeInvisibility],
  ['Gust of Wind', gustOfWind], ['Lesser Restoration', lesserRestoration], ['Protection from Poison', protectionFromPoison],
  ['Misty Step', mistyStep],
  ['Blur', blur], ['Barkskin', barkskin],
  ['Acid Arrow', acidArrow],
  ['Fireball', fireball], ['Lightning Bolt', lightningBolt],
  ['Spirit Guardians', spiritGuardians], ['Call Lightning', callLightning],
  ['Hypnotic Pattern', hypnoticPattern], ['Dispel Magic', dispelMagic], ['Haste', haste],
  ['Fear', fear], ['Fly', fly], ['Revivify', revivify],
  ['Beacon of Hope', beaconOfHope],
  ['Mass Healing Word', massHealingWord],
  ['Sleet Storm', sleetStorm],
  ['Hunger of Hadar', hungerOfHadar],
  ['Wind Wall', windWall],
  ['Stinking Cloud', stinkingCloud],
  ['Vampiric Touch', vampiricTouch],
  ['Slow', slow],
  ['Bestow Curse', bestowCurse],
  ['Ice Storm', iceStorm], ['Banishment', banishment], ['Blight', blight],
  ['Fire Shield', fireShield], ['Stoneskin', stoneskin], ['Death Ward', deathWard],
  ['Wall of Fire', wallOfFire],
  ['Cone of Cold', coneOfCold], ['Flame Strike', flameStrike],
  ['Hold Monster', holdMonster], ['Mass Cure Wounds', massCureWounds],
  ['Harm', harm], ['Heal', (ability) => heal(ability)],
  ['Fire Storm', fireStorm], ['Sunburst', sunburst], ['Meteor Swarm', meteorSwarm],
  ['Mass Heal', (ability) => massHeal(ability)], ['Storm of Vengeance', stormOfVengeance],
  ['Synaptic Static', synapticStatic],
];

export function getAllSpellNames(): string[] {
  return SPELL_FACTORIES.map(([name]) => name);
}

export function buildSpellAction(spellName: string, castingAbility: SpellcastingAbility, mod: number, pb: number): MonsterAction | null {
  const entry = SPELL_FACTORIES.find(([name]) => name === spellName);
  if (!entry) return null;
  return entry[1](castingAbility, mod, pb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot tables (SRD).
// ─────────────────────────────────────────────────────────────────────────────

/** Full caster slots per character level (Wizard, Sorcerer, Cleric, Druid, Bard). */
export const FULL_CASTER_SLOTS: Record<number, Record<number, number>> = {
  1: { 1: 2 },
  2: { 1: 3 },
  3: { 1: 4, 2: 2 },
  4: { 1: 4, 2: 3 },
  5: { 1: 4, 2: 3, 3: 2 },
  6: { 1: 4, 2: 3, 3: 3 },
  7: { 1: 4, 2: 3, 3: 3, 4: 1 },
  8: { 1: 4, 2: 3, 3: 3, 4: 2 },
  9: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  10: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
  11: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  12: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  13: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  14: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  15: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  16: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  17: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1 },
  18: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 1 },
  19: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 1, 8: 1, 9: 1 },
  20: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 },
};

/** Half-caster slots per character level (Paladin, Ranger). */
export const HALF_CASTER_SLOTS: Record<number, Record<number, number>> = {
  1: { 1: 2 },
  2: { 1: 2 },
  3: { 1: 3 },
  4: { 1: 3 },
  5: { 1: 4, 2: 2 },
  6: { 1: 4, 2: 2 },
  7: { 1: 4, 2: 3 },
  8: { 1: 4, 2: 3 },
  9: { 1: 4, 2: 3, 3: 2 },
  10: { 1: 4, 2: 3, 3: 2 },
  11: { 1: 4, 2: 3, 3: 3 },
  12: { 1: 4, 2: 3, 3: 3 },
  13: { 1: 4, 2: 3, 3: 3, 4: 1 },
  14: { 1: 4, 2: 3, 3: 3, 4: 1 },
  15: { 1: 4, 2: 3, 3: 3, 4: 2 },
  16: { 1: 4, 2: 3, 3: 3, 4: 2 },
  17: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  18: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  19: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
  20: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
};

/** Warlock pact slots (short-rest recharging; we treat as a single pool per combat). */
export const WARLOCK_SLOTS: Record<number, Record<number, number>> = {
  1: { 1: 1 },
  2: { 1: 2 },
  3: { 2: 2 },
  4: { 2: 2 },
  5: { 3: 2 },
  6: { 3: 2 },
  7: { 4: 2 },
  8: { 4: 2 },
  9: { 5: 2 },
  10: { 5: 2 },
  11: { 5: 3 },
  12: { 5: 3 },
  13: { 5: 3 },
  14: { 5: 3 },
  15: { 5: 3 },
  16: { 5: 3 },
  17: { 5: 4 },
  18: { 5: 4 },
  19: { 5: 4 },
  20: { 5: 4 },
};

/** Turn slot table into Creature.initialResources. */
export function slotsToResources(slots: Record<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [level, count] of Object.entries(slots)) {
    out[`slot-${level}`] = count;
  }
  return out;
}
