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
 * NOT IMPLEMENTED (flagged in each class's trait list, not added to the
 * spell action list):
 *   - Counterspell / Shield (reaction-timed - engine has no reaction step)
 *   - Misty Step (teleport - engine has no teleport primitive)
 *   - Invisibility (obscured-target mechanic not modeled)
 *   - Summoning spells (add creatures mid-battle)
 *   - Wild Shape (transformation)
 *   - Concentration spells that require sustained per-turn bookkeeping
 *     beyond simple buffs (e.g., Flaming Sphere moves each turn)
 */
import type { MonsterAction, Abilities } from '../types/monster.js';

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

export function sleep(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  void _mod;
  void _pb;
  // 2024 Sleep: 5d8 HP pool, lowest-current-HP creatures in the 20-ft sphere
  // fall Unconscious until the pool is exhausted. No saving throw.
  return {
    name: 'Sleep',
    type: 'special',
    description: '20-foot radius. Roll 5d8 as an HP pool. Starting with the lowest-HP creatures, each falls Unconscious (1 minute) and its current HP is subtracted from the pool; stop when the next creature exceeds the pool.',
    spellLevel: 1,
    castingAbility: ability,
    savingThrow: {
      ability: 'wis', dc: 0, // not used - hpPoolDice is authoritative
      hpPoolDice: '5d8',
      conditionOnFail: 'unconscious',
      conditionDuration: '1_minute',
      area: '20-foot sphere',
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
    buffOnFailedSave: { name: 'Entangle', key: 'entangle', requiresConcentration: true, appliedConditions: ['restrained'], saveEnds: { ability: 'str', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
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

/** 2024 SRD - prone battlefield control with no persistent terrain state. */
export function grease(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: 'Grease', type: 'special', spellLevel: 1, spellSchool: 'conjuration', castingAbility: ability,
    description: `10-foot square within 60 ft. DEX save DC ${saveDC(mod, pb)} or Prone.`,
    savingThrow: { ability: 'dex', dc: saveDC(mod, pb), conditionOnFail: 'prone', conditionDuration: 'end_of_next_turn', area: '10-foot square' },
    range: { normal: 60, long: 60 }, targetScope: 'area_enemies',
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

export function falseLife(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'False Life', type: 'special', spellLevel: 1, spellSchool: 'necromancy', castingAbility: ability,
    description: 'Gain 2d4 plus your spellcasting ability modifier temporary HP.', temporaryHp: { dice: '2d4', addCastingMod: true }, targetScope: 'self',
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

export function tashasHideousLaughter(ability: SpellcastingAbility, mod: number, pb: number): MonsterAction {
  return {
    name: "Tasha's Hideous Laughter", type: 'special', spellLevel: 1, spellSchool: 'enchantment', castingAbility: ability, concentration: true, durationRounds: 10,
    description: `One creature within 30 ft. WIS save DC ${saveDC(mod, pb)} or Prone and Incapacitated; repeat the save at end of each turn.`,
    savingThrow: { ability: 'wis', dc: saveDC(mod, pb), conditionOnFail: 'incapacitated', additionalConditionsOnFail: ['prone'], conditionDuration: '1_minute' }, range: { normal: 30, long: 30 }, targetScope: 'one_enemy',
    buffOnFailedSave: { name: "Tasha's Hideous Laughter", key: 'hideous-laughter', requiresConcentration: true, appliedConditions: ['incapacitated', 'prone'], saveEnds: { ability: 'wis', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
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

export function colorSpray(ability: SpellcastingAbility, _mod: number, _pb: number): MonsterAction {
  return {
    name: 'Color Spray', type: 'special', spellLevel: 1, spellSchool: 'illusion', castingAbility: ability,
    description: '15-foot cone. Roll 6d10; creatures in ascending current HP become Blinded until the end of your next turn.',
    savingThrow: { ability: 'con', dc: 0, hpPoolDice: '6d10', conditionOnFail: 'blinded', conditionDuration: 'end_of_next_turn', area: '15-foot cone' }, targetScope: 'area_enemies',
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
    buffOnFailedSave: { name: 'Web', key: 'web', requiresConcentration: true, appliedCondition: 'restrained', saveEnds: { ability: 'str', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
    targetScope: 'area_enemies',
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
    targetScope: 'area_enemies',
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
    description: `60-foot line. STR save DC ${saveDC(mod, pb)}; failed creatures take 2d8 thunder damage and are pushed 15 feet.`,
    damageType: 'thunder', savingThrow: { ability: 'str', dc: saveDC(mod, pb), damageOnFail: '2d8', area: '60-foot line' }, pushOnFailedSave: 15, targetScope: 'area_enemies',
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
    buffOnFailedSave: { name: 'Fear', key: 'fear', requiresConcentration: true, appliedConditions: ['frightened'], saveEnds: { ability: 'wis', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
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
    description: `One creature within 30 ft. WIS save DC ${saveDC(mod, pb)} or suffers the chosen combat curse for 1 minute; repeats the save at the end of each turn.`,
    savingThrow: { ability: 'wis', dc: saveDC(mod, pb) }, range: { normal: 30, long: 30 }, targetScope: 'one_enemy',
    buffOnFailedSave: { name: 'Bestow Curse', key: 'bestow-curse', requiresConcentration: true, attackDisadvantage: true, saveEnds: { ability: 'wis', dc: saveDC(mod, pb), at: 'targetTurnEnd' } },
    curseChoice: { choices: ['attack_disadvantage', 'damage_rider'], selected: 'attack_disadvantage' },
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
  ['Magic Missile', () => magicMissile()],
  ['Blade Ward', bladeWard], ['Resistance', resistance],
  ['Shield', shield],
  ['Hellish Rebuke', hellishRebuke],
  ['Burning Hands', burningHands], ['Thunderwave', thunderwave], ['Sleep', sleep],
  ['Bless', () => bless()], ['Bane', bane], ['Cure Wounds', cureWounds],
  ['Sanctuary', sanctuary],
  ['Protection from Evil and Good', protectionFromEvilAndGood],
  ['Healing Word', healingWord], ['Shield of Faith', () => shieldOfFaith()],
  ['Heroism', heroism],
  ['Guiding Bolt', guidingBolt], ['Dissonant Whispers', dissonantWhispers],
  ['Entangle', entangle], ['Command', command], ['Chromatic Orb', chromaticOrb],
  ['Inflict Wounds', inflictWounds], ['Witch Bolt', witchBolt],
  ['Arms of Hadar', armsOfHadar], ['Color Spray', colorSpray], ['Divine Favor', divineFavor],
  ['Faerie Fire', faerieFire], ['False Life', falseLife], ['Fog Cloud', fogCloud], ['Grease', grease], ['Longstrider', longstrider],
  ['Ray of Sickness', rayOfSickness], ["Tasha's Hideous Laughter", tashasHideousLaughter],
  ['Scorching Ray', scorchingRay], ['Web', web], ['Hold Person', holdPerson],
  ['Flaming Sphere', flamingSphere], ['Cloud of Daggers', cloudOfDaggers],
  ['Shatter', shatter], ['Moonbeam', moonbeam], ['Spiritual Weapon', spiritualWeapon],
  ['Aid', aid], ['Magic Weapon', magicWeapon], ['Shining Smite', shiningSmite],
  ['Blindness/Deafness', blindnessDeafness], ['Mirror Image', mirrorImage],
  ['Invisibility', invisibility],
  ['See Invisibility', seeInvisibility],
  ['Gust of Wind', gustOfWind], ['Lesser Restoration', lesserRestoration], ['Protection from Poison', protectionFromPoison],
  ['Misty Step', mistyStep],
  ['Blur', blur], ['Barkskin', barkskin],
  ['Acid Arrow', acidArrow],
  ['Fireball', fireball], ['Lightning Bolt', lightningBolt],
  ['Spirit Guardians', spiritGuardians], ['Call Lightning', callLightning],
  ['Hypnotic Pattern', hypnoticPattern], ['Dispel Magic', dispelMagic], ['Haste', haste],
  ['Fear', fear], ['Fly', fly], ['Revivify', revivify],
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
