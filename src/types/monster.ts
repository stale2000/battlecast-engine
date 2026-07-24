export interface Speed {
  walk: number;
  fly?: number;
  swim?: number;
  burrow?: number;
  climb?: number;
  hover?: boolean;
}

export interface Abilities {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export type MechanicsStatus =
  | { status: 'implemented'; note?: string }
  | { status: 'deferred'; reason: string };

export interface RuntimeOngoingEffect {
  key: string;
  sourceId: string;
  sourceName: string;
  condition?: Condition;
  damage?: string;
  damageType?: string;
  tick: 'sourceTurnStart' | 'targetTurnStart' | 'targetTurnEnd';
  /** Remaining damage applications for one-shot delayed effects. */
  ticksRemaining?: number;
  noHealing?: boolean;
  saveEnds?: {
    ability: keyof Abilities;
    dc: number;
    at: 'targetTurnStart' | 'targetTurnEnd';
  };
  appliedRound: number;
  expiresRound?: number;
}

export interface RuntimeContainerState {
  key: string;
  sourceId: string;
  sourceName: string;
  conditions: Condition[];
  sourceTurnDamage?: string;
  sourceTurnDamageType?: string;
  targetTurnDamage?: string;
  targetTurnDamageType?: string;
  totalCover?: boolean;
  movesWithSource?: boolean;
  escapeDc?: number;
}

export type RuntimeActionEffect =
  | {
      kind: 'abilityScoreDrain';
      ability: keyof Abilities;
      dice: string;
      deathAtZero: boolean;
      recovery: 'long_rest' | 'none';
    }
  | {
      kind: 'hpMaxReduction';
      amount: 'damageTaken' | 'damageTypeTaken';
      damageType?: string;
      deathAtZero: boolean;
    }
  | {
      kind: 'ongoingDamage';
      key: string;
      damage: string;
      damageType: string;
      tick: 'sourceTurnStart' | 'targetTurnStart' | 'targetTurnEnd';
      condition?: Condition;
      noHealing?: boolean;
      applySave?: {
        ability: keyof Abilities;
        dc: number;
      };
      saveEnds?: RuntimeOngoingEffect['saveEnds'];
      maxTicks?: number;
      expiresAfterRounds?: number;
    }
  | {
      kind: 'blocksHealing';
      key: string;
      condition?: Condition;
      tick?: 'sourceTurnStart' | 'targetTurnStart' | 'targetTurnEnd';
      expiresAfterRounds?: number;
    }
  | {
      kind: 'container';
      key: string;
      conditions: Condition[];
      maxTargetSize?: MonsterData['size'];
      sourceCapacity?: {
        maxSlots: number;
        sizeSlots?: Partial<Record<MonsterData['size'], number>>;
      };
      sourceTurnDamage?: string;
      sourceTurnDamageType?: string;
      targetTurnDamage?: string;
      targetTurnDamageType?: string;
      totalCover?: boolean;
      movesWithSource?: boolean;
      escapeDc?: number;
    };

export type RuntimeTraitEffect =
  | {
      kind: 'regeneration';
      /** BattleCast regenerates creatures only while alive with at least 1 HP. */
      profile: 'atLeastOneHp';
      amount: number;
      suppressedBy?: string[];
    }
  | {
      kind: 'deathBurst';
      area: string;
      save: { ability: keyof Abilities; dc: number };
      damage: Array<{ dice: string; type: string }>;
    }
  | {
      kind: 'spellReflection';
      spellKinds: Array<'magicMissile' | 'rangedSpellAttack'>;
      reflectOn: number[];
    }
  | { kind: 'hydraHeads'; startingHeads: number; damagePerHead: number; regrowHp: number };

export type WeaponMasteryProperty =
  | 'cleave'
  | 'graze'
  | 'nick'
  | 'push'
  | 'sap'
  | 'slow'
  | 'topple'
  | 'vex';

export interface MonsterAction {
  name: string;
  type: 'melee' | 'ranged' | 'special' | 'multiattack';
  attackBonus?: number;
  damage?: string; // dice expression like "2d6+4"
  damageType?: string;
  additionalDamage?: string; // e.g., "2d6 poison"
  reach?: number;
  range?: { normal: number; long: number };
  description: string;
  recharge?: string; // e.g., "5-6"
  conditionOnHit?: {
    condition: Condition;
    save?: {
      ability: keyof Abilities;
      dc: number;
    };
    duration?: ConditionDuration;
    stages?: Condition[]; // for petrification: [restrained, petrified]
  };
  savingThrow?: {
    ability: keyof Abilities;
    dc: number;
    damageOnFail?: string;
    damageOnSuccess?: string; // usually "half"
    /** Additional simultaneous damage parts for mixed-damage saves such as Meteor Swarm. */
    extraDamageOnFail?: Array<{ damage: string; damageType: string }>;
    area?: string; // e.g., "30-foot Cone"
    conditionOnFail?: Condition;
    additionalConditionsOnFail?: Condition[];
    conditionDuration?: ConditionDuration;
    /** 2024 cascading-save effects (Brass Dragon Sleep Breath, Silver
     *  Dragon Paralyzing Breath): when the initial conditionOnFail
     *  expires, the target rolls a repeat save. On failure the
     *  condition escalates to this with secondFailureDuration. */
    secondFailureCondition?: Condition;
    secondFailureDuration?: ConditionDuration;
    /** 2024 Sleep: roll this dice pool as an HP budget. Lowest-current-HP
     *  targets in area fall unconscious until the pool is exhausted. No
     *  saving throw. When set, `dc` is ignored for resolution (but kept
     *  for log formatting). */
    hpPoolDice?: string;
  };
  /**
   * Spell metadata. When set, the action consumes a spell slot
   * (resource key "slot-<level>") and follows spellcasting rules.
   * `level: 0` means a cantrip - no slot cost. Leveled spells check
   * the caster has the slot, then decrement.
   */
  /** True if this action uses a bonus action instead of the main action.
   *  Bonus actions can be used alongside a main action on the same turn
   *  (e.g., Rage + Greataxe, Hex + Eldritch Blast, Healing Word + Rapier). */
  isBonusAction?: boolean;
  /** The spell takes the Dash action as part of its casting. */
  dashOnCast?: boolean;
  /** Server-selected size change for Enlarge/Reduce. */
  sizeChangeChoice?: { choices: Array<'enlarge' | 'reduce'>; selected?: 'enlarge' | 'reduce' };
  /** A reaction-timed spell resolved automatically by the authoritative engine. */
  reactionOnly?: boolean;
  /** Uses one attack from an Attack action instead of consuming the whole action. */
  replacesAttack?: boolean;
  /**
   * True if this action's damage counts as magical for the purposes of
   * resistance bypass. Set on inherently magical attacks (devas, planetars,
   * weapons with a "magical" trait) and on cantrips / spells that deal
   * weapon-type damage. Default false: ordinary monster bites, claws,
   * mundane weapons. Spells handled outside `actions[]` (the spellcasting
   * resolver) treat themselves as magical regardless of this flag.
   */
  magical?: boolean;
  /** 2024 weapon mastery property, when the attacker has mastery for this weapon. */
  weaponMastery?: WeaponMasteryProperty;
  /** Ability used for the attack roll/damage. Needed for 2024 Rage with thrown STR weapons. */
  attackAbility?: keyof Abilities;
  /** Ability modifier used by weapon mastery effects such as Graze and Topple DCs. */
  masteryAbilityMod?: number;
  /** Base weapon damage die before ability modifier, used by Cleave. */
  masteryBaseDamage?: string;
  /** True for weapons with the 5e Loading property. A creature can fire a
   * loading weapon only once during a multiattack/Extra Attack action. */
  loading?: boolean;
  /** Heavy weapons impose Disadvantage on attacks by Small creatures. */
  heavy?: boolean;
  /** Lance attacks have Disadvantage against targets within 5 feet. */
  closeRangeDisadvantage?: boolean;
  /** Buff applied to the target after this attack hits and deals damage, e.g. Guiding Bolt. */
  buffOnHit?: BuffTemplate;
  /** Buff applied to targets that fail this action's saving throw, e.g. Vicious Mockery. */
  buffOnFailedSave?: BuffTemplate;
  /** Buff applied to targets that succeed on this action's saving throw. */
  buffOnSuccessfulSave?: BuffTemplate;
  /** Failed-save forced movement in feet away from the caster, e.g. Thunderwave. */
  pushOnFailedSave?: number;
  /** Forced movement after this attack hits, e.g. Tavern Brawler's 5-foot push. */
  pushOnHit?: number;
  /** Limit pushOnHit to one successful hit per turn. */
  pushOnHitOncePerTurn?: boolean;
  /** Reroll damage dice that show 1, keeping the replacement roll. */
  rerollDamageOnes?: boolean;
  /** On-hit forced movement in feet toward the attacker, e.g. Balor Flame Whip. */
  pullTowardAttackerOnHit?: number;
  /** Restrict this spell to targets of a specific creature type
   *  (e.g., Hold Person only affects Humanoids). The AI won't cast it
   *  on creatures whose `monsterData.type` doesn't match. Case-insensitive. */
  targetTypeRestriction?: string;
  spellLevel?: number;
  spellSchool?: 'abjuration' | 'conjuration' | 'divination' | 'enchantment' | 'evocation' | 'illusion' | 'necromancy' | 'transmutation';
  /**
   * Monster innate at-will spell. Skips both slot consumption and any
   * resourceCost gating, so the spell can be cast unlimited times per
   * battle. Used by 2024 stat blocks like Lich (Fireball at-will) or
   * Adult Red Dragon (Scorching Ray at-will).
   */
  atWill?: boolean;
  /**
   * True if casting this spell requires concentration. The caster
   * drops any existing concentration buff when a new concentration
   * spell is cast. Taking damage triggers a CON save (DC max(10, damage/2)).
   */
  concentration?: boolean;
  /**
   * Duration of applied effects (buffs, summoned auras) in rounds.
   * 10 rounds = 1 minute of in-game time (SRD).
   */
  durationRounds?: number;
  /**
   * Healing profile. The engine rolls dice, adds casting ability mod
   * if `addCastingMod`, and restores HP on the target (self or ally).
   */
  heal?: {
    dice: string;
    addCastingMod?: boolean;
    clearsConditions?: Array<'blinded' | 'deafened' | 'poisoned'>;
    /** Preserve Life-style cap: the heal can restore only up to this HP fraction. */
    maxTargetHpFraction?: number;
  };
  /** Conditions ended by a restorative spell such as Lesser Restoration. */
  removesConditions?: Array<'blinded' | 'deafened' | 'paralyzed' | 'poisoned'>;
  /** Temporary flight granted by a spell such as Fly. */
  grantsFlight?: { speed: number; durationRounds: number };
  /** Paladin Lay on Hands spends a variable amount from its HP pool. */
  layOnHands?: {
    resourceKey: string;
  };
  /** Temporary HP profile. Used by features such as Ranger Tireless. */
  temporaryHp?: {
    dice: string;
    addCastingMod?: boolean;
  };
  /** Circle of the Land's Land's Aid: damage enemies and heal one ally. */
  landAidHealDice?: string;
  /**
   * Power Word-style spells that do not fit normal attack/save/heal shapes.
   * The dispatcher keeps these explicit so we don't infer high-level spell
   * behavior from display names.
   */
  powerWord?: {
    kind: 'heal' | 'kill';
    /** Words of Creation can target a second creature near the first. */
    secondaryRange?: number;
    /** Power Word Kill threshold. Targets above it take fallbackDamage. */
    killThresholdHp?: number;
    fallbackDamage?: string;
    fallbackDamageType?: string;
    /** Power Word Heal clears these conditions after restoring HP. */
    clearsConditions?: Array<'charmed' | 'frightened' | 'paralyzed' | 'poisoned' | 'stunned' | 'prone'>;
  };
  /**
   * Buff to apply on cast. Engine merges with runtime fields
   * (casterId, appliedRound, endRound) before attaching to the target.
   */
  buff?: BuffTemplate;
  /**
   * What kind of target the AI should pick. Defaults to 'one_enemy'
   * when omitted (matches monster attack behavior).
   */
  targetScope?: 'self' | 'one_ally' | 'one_enemy' | 'any_one' | 'area_enemies' | 'all_allies_in_area';
  /**
   * Magic Missile: N darts that auto-hit and each roll their own damage.
   * No attack roll, no save.
   */
  autoDarts?: number;
  autoDartDamage?: string;
  autoDartDamageType?: string;
  /** Multiple independent spell attack rolls, e.g. Scorching Ray. */
  multiTargetAttack?: { count: number };
  /** A saving throw spell that selects up to this many individual targets. */
  multiTargetSave?: { maxTargets: number };
  /** A buff spell that selects up to this many allied targets. */
  multiTargetBuff?: { maxTargets: number };
  /**
   * Which ability is used for spell attack bonus / save DC. Overrides
   * the creature's primary. Set per-action because one creature can
   * theoretically have spells from multiple casting sources.
   */
  castingAbility?: keyof Abilities;
  /**
   * Classes like Paladin (Divine Smite) spend a spell slot on a
   * successful hit for bonus radiant damage. When this hook is set,
   * the engine checks for available slots after a hit, consumes the
   * lowest, and adds the dice per the smite table.
   */
  smiteOnHit?: {
    /** Damage type dealt by the smite. */
    damageType: string;
    /** dice per slot level used - e.g., [2, 3, 4, 5] means "2d8 at L1, 3d8 at L2, ...". */
    dicePerSlotLevel: number[];
    /** The die used per slot (almost always 8 for paladins). */
    die: 8 | 6;
  };
  /**
   * Non-slot resource cost for abilities like Rage ("rage"), Second
   * Wind ("second-wind"), Ki ("ki"), Channel Divinity ("channel-divinity").
   * executeSpell consumes this before applying the action; returns
   * false if the creature can't pay.
   */
  resourceCost?: { key: string; amount: number };
  /**
   * Persistent magical darkness created by this spell. The spell resolver
   * owns the zone, its concentration lifecycle, and its serialization; a
   * caller can only choose one of the server-generated legal centers.
   */
  darkness?: { radius: number; durationRounds: number; requiresConcentration?: boolean };
  /** Server-validated teleport destination, used by spells such as Misty Step. */
  teleport?: { distanceFt: number };
  /** Restores a recently dead creature to life. */
  revive?: { maxDeathRounds: number; hp: number };
  /** Chooses one server-validated damage resistance for a spell effect. */
  damageResistanceChoice?: { choices: string[]; selected?: string };
  /** Chooses one server-validated damage type for a spell effect. */
  damageTypeChoice?: { choices: string[]; selected?: string };
  /** Chooses a server-validated combat effect for Bestow Curse. */
  curseChoice?: { choices: Array<'ability_str' | 'ability_dex' | 'ability_con' | 'ability_int' | 'ability_wis' | 'ability_cha' | 'attack_disadvantage' | 'forced_dodge' | 'damage_rider'>; selected?: 'ability_str' | 'ability_dex' | 'ability_con' | 'ability_int' | 'ability_wis' | 'ability_cha' | 'attack_disadvantage' | 'forced_dodge' | 'damage_rider' };
  /** Ends one selected spell effect on a target. The selected key is server-owned. */
  dispelMagic?: { maxSpellLevel: number; selectedKey?: string };
  /** Failed targets use their Reaction to flee directly away, provoking opportunity attacks. */
  fleeOnFailedSave?: boolean;
  /** Creates a persistent spiritual weapon that can make later bonus-action attacks. */
  spiritualWeapon?: { moveFt: number };
  /** A damaging concentration area that remains after the initial cast. */
  persistentAura?: { moveFt?: number; automaticDamage?: boolean; damageOnInitialCast?: boolean };
  /** Creates a static control zone whose triggers and movement effects are resolved by the engine. */
  persistentZone?: {
    radiusFt: number;
    durationRounds: number;
    triggers: Array<'entry' | 'turnStart' | 'turnEnd'>;
    difficultTerrain?: boolean;
    difficultTerrainTowardSource?: boolean;
    damagePer5Ft?: { dice: string; type: string };
    shape?: 'line';
    pushOnFailedSave?: number;
  };
  /** Enables a later no-slot repeat of this concentration spell (Call Lightning). */
  repeatableAreaSpell?: true;
  /** The spell cannot affect a target wearing Heavy armor (Barkskin). */
  requiresNoHeavyArmor?: boolean;
  /**
   * Action exists only as the mechanical payload for a legendary action.
   * Normal turn planning ignores it; executeLegendaryAction can still
   * resolve it via LegendaryAction.actionRef.
   */
  legendaryOnly?: boolean;
  /** Structured runtime effects for high-impact monster mechanics. */
  effects?: RuntimeActionEffect[];
  /** Explicitly records whether a text-only mechanic is implemented or intentionally deferred. */
  mechanicsStatus?: MechanicsStatus;
}

/**
 * Abbreviated ActiveBuff used in action data. Engine fills
 * casterId / appliedRound / endRound at cast time.
 */
export interface BuffTemplate {
  name: string;
  key: string;
  requiresConcentration?: boolean;
  /** Flat bonus added to attack rolls. Sacred Weapon uses this. */
  attackBonus?: number;
  attackBonusDice?: string;
  saveBonusDice?: string;
  acBonus?: number;
  acMinimum?: number;
  acBaseFromDex?: number;
  /** Aid-style increase to current and maximum HP for the encounter. */
  maxHpBonus?: number;
  damageRider?: string;
  /** Damage this buff can deal when its caster spends a later bonus action (2024 Witch Bolt). */
  bonusActionDamage?: string;
  /** The affected creature can take Dash as a Bonus Action. */
  bonusActionDash?: boolean;
  /** Damage type for bonusActionDamage. */
  bonusActionDamageType?: string;
  /** Maximum range in feet for the bonus-action damage link. */
  bonusActionDamageRange?: number;
  /** Linked damage effects such as Witch Bolt end when their target dies. */
  endsWhenTargetDies?: boolean;
  resistPhysical?: boolean;
  /** Resistance to specific damage types, e.g. Hunter Superior Defense. */
  resistDamageTypes?: string[];
  /** Resistance to all damage except the listed damage types (Monk Superior Defense). */
  resistAllDamageExcept?: string[];
  rageDamageBonus?: number;
  conditionalRider?: 'targetNotFullHp';
  /** Damage dealt to melee attackers that hit this creature (e.g. Fire Shield "2d8 fire"). */
  reactiveDamage?: string;
  /** This effect ends when the temporary HP that powers it are depleted. */
  endsWhenTemporaryHpDepleted?: boolean;
  /** If true, the first time the target would drop to 0 HP, it drops to 1 HP instead (Death Ward). */
  preventDeath?: boolean;
  /** Weapon Mastery: Vex gives one attacker Advantage against this creature. */
  advantageForAttackerId?: string;
  /** Guiding Bolt-style rider: the next attack roll against this creature has Advantage. */
  advantageForAllAttackers?: boolean;
  /** Weapon Mastery: Sap gives this creature Disadvantage on attack rolls while active. */
  attackDisadvantage?: boolean;
  attackDisadvantageAgainstCaster?: boolean;
  /** Attackers have Disadvantage against this creature, e.g. Blur. */
  attackersHaveDisadvantage?: boolean;
  /** One-shot rider such as Barbarian Staggering Blow: next save has Disadvantage. */
  saveDisadvantage?: boolean;
  saveDisadvantageAbilities?: Array<keyof Abilities>;
  abilityCheckDisadvantageAbilities?: Array<keyof Abilities>;
  forcedDodgeSave?: { ability: keyof Abilities; dc: number };
  /** The target must use its action to Dash away from the caster each turn. */
  forcedFlee?: boolean;
  /** Weapon Mastery: Slow reduces this creature's speed while active. */
  speedPenalty?: number;
  /** Longstrider-style increase to all movement speeds. */
  speedBonus?: number;
  /** Flat bonus to Dexterity (Stealth) checks, e.g. Pass without Trace. */
  stealthBonus?: number;
  /** One-shot rider such as Barbarian Staggering Blow: no Opportunity Attacks. */
  preventsOpportunityAttacks?: boolean;
  /** The creature cannot take reactions while this effect lasts. */
  preventsReactions?: boolean;
  /** One-shot rider such as Barbarian Sundering Blow: next other attacker gets a flat bonus. */
  attackBonusForAllAttackers?: number;
  /** Innate Sorcery-style rider: this creature has Advantage on spell attack rolls. */
  spellAttackAdvantage?: boolean;
  /** Innate Sorcery-style rider: this creature's spell save DC increases by this amount. */
  spellSaveDcBonus?: number;
  /** Some short mastery debuffs expire at the start of the source creature's next turn. */
  expiresOnSourceTurnStart?: boolean;
  /** Disadvantage on Strength attack rolls and saving throws. */
  strengthTestDisadvantage?: boolean;
  /** Advantage on Strength attack rolls and saving throws. */
  strengthTestAdvantage?: boolean;
  /** Dice subtracted from each damage roll this creature makes. */
  damageRollPenalty?: string;
  /** Flat bonus to this creature's weapon damage, e.g. Magic Weapon. */
  weaponDamageBonus?: number;
  /** Dice added to weapon and Unarmed Strike damage, such as Enlarge. */
  weaponDamageBonusDice?: string;
  /** Dice subtracted from weapon and Unarmed Strike damage, such as Reduce. */
  weaponDamagePenaltyDice?: string;
  /** This creature's weapon attacks count as magical. */
  weaponAttacksMagical?: boolean;
  /** Extra magical damage on this creature's next weapon hit. */
  weaponDamageRider?: string;
  /** Optional save-gated condition delivered by weaponDamageRider. */
  weaponConditionOnHit?: MonsterAction['conditionOnHit'];
  /** Removes this buff when its damage rider lands. */
  endsOnWeaponHit?: boolean;
  /** Condition paired with this buff and removed whenever the buff ends. */
  appliedCondition?: Condition;
  appliedConditions?: Condition[];
  /** The effect ends as soon as its target takes damage. */
  endsOnDamage?: boolean;
  /** Temporary HP granted at the start of each of the target's turns. */
  temporaryHpAtTurnStart?: number;
  /** Conditions this buff prevents while it lasts. */
  conditionImmunities?: Condition[];
  /** Ends when this creature attacks or casts a spell, as with Invisibility. */
  endsOnAttackOrCast?: boolean;
  /** Remaining illusory duplicates that can intercept attacks. */
  mirrorImages?: number;
  /** Attackers must pass this Wisdom save before harming the protected creature. */
  sanctuarySaveDc?: number;
  /** Attackers of these creature types have Disadvantage against the target. */
  attackersOfTypesHaveDisadvantage?: string[];
  /** This creature can see Invisible creatures. */
  canSeeInvisible?: boolean;
  /** Grants the restricted one-attack/Dash/Disengage/Hide action from Haste. */
  hasteAction?: boolean;
  /** Ability-specific saving throw Advantage, such as Haste's Dexterity saves. */
  saveAdvantageAbilities?: Array<keyof Abilities>;
  /** Condition-specific saving throw Advantage, such as Protection from Poison. */
  saveAdvantageConditions?: Condition[];
  /** Repeat this save at the specified point and remove the buff on success. */
  saveEnds?: { ability: keyof Abilities; dc: number; at: 'targetTurnEnd'; advantageOnDamage?: boolean };
  /** An action-based ability check that can end this effect. */
  escapeAction?: { ability: keyof Abilities; dc: number };
}

export interface MonsterTrait {
  name: string;
  description: string;
  /** Structured runtime effects for high-impact monster traits. */
  effects?: RuntimeTraitEffect[];
  /** Explicitly records whether a text-only mechanic is implemented or intentionally deferred. */
  mechanicsStatus?: MechanicsStatus;
}

export interface LegendaryAction {
  name: string;
  description: string;
  cost?: number;
  /** If set, this legendary action executes the named action from the
   *  creature's actions array. If not set, it's descriptive only. */
  actionRef?: string;
  /** Teleport and damage creatures near the departure or arrival space. */
  teleportBurst?: {
    distanceFt: number;
    radiusFt: number;
    damage: string;
    damageType: string;
  };
}

export interface MonsterData {
  name: string;
  size: 'Tiny' | 'Small' | 'Medium' | 'Large' | 'Huge' | 'Gargantuan';
  type: string;
  alignment: string;
  ac: number;
  /** Construction metadata needed by effects such as Barkskin. */
  wearingHeavyArmor?: boolean;
  hp: number;
  hpFormula: string;
  speed: Speed;
  abilities: Abilities;
  saves?: Partial<Record<keyof Abilities, number>>;
  skills?: Record<string, number>;
  resistances?: string[];
  immunities?: string[];
  conditionImmunities?: string[];
  vulnerabilities?: string[];
  /**
   * Damage types that are halved ONLY when the incoming attack is from a
   * non-magical source (mundane weapon hit, generic monster claw / bite).
   * Magical attacks (action with `magical: true`, or any spell damage)
   * bypass these. Standard 2024 SRD spelling: each entry is a damage
   * type string, e.g. ["bludgeoning", "piercing", "slashing"].
   */
  nonmagicalResistances?: string[];
  /** Same idea as nonmagicalResistances, but zeroes the damage instead of halving. */
  nonmagicalImmunities?: string[];
  senses: string;
  languages: string;
  cr: string;
  xp: number;
  proficiencyBonus: number;
  traits?: MonsterTrait[];
  actions: MonsterAction[];
  legendaryActions?: LegendaryAction[];
  legendaryActionUses?: number;
  /**
   * Optional hero metadata. Set when a MonsterData represents a
   * player-character class at a specific level rather than an SRD
   * monster. The engine ignores these fields - they drive UI
   * distinctions (gold-ringed tokens, "Heroes" picker tab, stat-block
   * header text) and help filter "PCs" out of monster-only views.
   */
  isHero?: boolean;
  heroClass?: string;
  heroLevel?: number;
  heroSubclass?: string;
  /** SRD character-origin metadata used by validated arena construction. */
  heroSpecies?: string;
  /** Chosen lineage, legacy, or ancestry for a species with an SRD choice. */
  heroSpeciesChoice?: string;
  heroSpeciesCastingAbility?: keyof Abilities;
  heroBackground?: string;
  originFeat?: string;
  /** All Origin Feats, including the Human Versatile choice. */
  originFeats?: string[];
  originSkills?: string[];
  originTool?: string;
  /** All tool proficiencies, including the background tool and Skilled picks. */
  originTools?: string[];
  originEquipment?: string[];
  /** Healer Origin Feat permits rerolling 1s on healing dice. */
  healingRerollOnes?: boolean;
  /** Known lineage cantrips, including noncombat spells omitted from actions. */
  speciesCantrips?: string[];
  /** Always-prepared lineage spells, including effects not yet arena-playable. */
  speciesPreparedSpells?: string[];
  /** Research/config hook for Druids: prefer this eligible Beast when using Wild Shape. */
  preferredWildShapeBeast?: string;
  /**
   * Initial consumable resources for this creature's instance (spell
   * slots, rage uses, ki points, etc.). Copied into Creature.resources
   * when the creature is created. Unset = no resources.
   */
  initialResources?: Record<string, number>;
  isHomebrew?: boolean;
  homebrewId?: string;
}

// Runtime creature instance placed on the battlefield
export interface Creature {
  id: string;
  name: string;
  displayName: string;
  monsterData: MonsterData;
  team: 'red' | 'blue';
  currentHp: number;
  maxHp: number;
  temporaryHp?: number;
  position: { x: number; y: number };
  initiative: number;
  conditions: Condition[];
  conditionTimers: ConditionTimer[];
  isAlive: boolean;
  hasActed: boolean;
  hasMovedThisTurn: boolean;
  movementRemaining: number;
  temporaryFlightSpeed?: number;
  temporaryFlightExpiresRound?: number;
  /** Caster maintaining the temporary fly speed, if concentration is required. */
  temporaryFlightSourceId?: string;
  /** A temporary size change, such as a Goliath's Large Form. */
  temporarySize?: MonsterData['size'];
  temporarySizeExpiresRound?: number;
  temporarySizeSourceId?: string;
  legendaryActionsRemaining?: number;
  superiorHunterDefense?: { damageType: string; round: number; turnIndex: number };
  recharges: Record<string, boolean>; // track recharge abilities
  concentratingOn?: string;
  stats: CreatureStats;
  /**
   * Generic counter store for consumable resources: spell slots
   * ("slot-1", "slot-2", "slot-3"), rage uses ("rage"), ki points
   * ("ki"), sorcery points ("sorcery"), bardic inspiration dice
   * ("bardic-inspiration"), Action Surge uses ("action-surge"),
   * Second Wind uses ("second-wind"), Lay on Hands HP pool
   * ("lay-on-hands"), Channel Divinity ("channel-divinity").
   *
   * Initialized by createCreature from monsterData.initialResources.
   * Consumed during actions; reset to max on short/long rest (not
   * simulated - combats are assumed to be single encounters).
   */
  resources: Record<string, number>;
  /**
   * Active buffs/debuffs from spells and abilities (Bless, Hex,
   * Hunter's Mark, Shield of Faith, Rage, etc.). Applied during
   * attack/save resolution; expire via round tick or when
   * concentration drops.
   */
  activeBuffs: ActiveBuff[];
  /**
   * Per-turn flags that reset at start of this creature's turn. Used
   * for Rogue's "Sneak Attack once per turn" gate and similar.
   */
  turnFlags: Record<string, boolean>;
  /**
   * True when a creature with fly speed is currently up at altitude
   * (above grounded melee reach). Set true at the start of each of
   * the flyer's turns; flipped to false the moment they make a melee
   * attack (had to descend). Stays false through the rest of the turn
   * and the round until the flyer's next turn. Ground creatures stay
   * false / undefined.
   *
   * Drives both the OA-exemption rule (grounded enemies don't OA an
   * airborne flyer leaving reach) and the rendering treatment
   * (airborne creatures show a drop shadow + cyan badge tint).
   */
  airborne?: boolean;
  /** True if this creature has used its reaction this round (OA, Shield, etc.).
   *  Reset at the start of each of this creature's turns. */
  reactionUsed?: boolean;
  /**
   * Hero-only: creature is at 0 HP, unconscious, and making death saves
   * at the start of each of its turns. Mutually exclusive with isAlive=false
   * (a creature is either Up, Downed, or Dead - never Downed-and-Dead).
   * Monsters never enter this state - they go Up -> Dead directly.
   *
   * Cleared by any healing (returns to Up with HP = heal amount), by three
   * successful death saves (stabilised: stays unconscious, dying=false), or
   * by a nat-20 death save (pops up at 1 HP). Reset to permanently dead
   * (isAlive=false) on three failed death saves or massive damage.
   */
  dying?: boolean;
  /** Tracker for the current dying episode. Present only while dying === true. */
  deathSaves?: {
    successes: number;
    failures: number;
  };
  /** True if the bonus action has been used this turn. */
  bonusActionUsed?: boolean;
  /** Source of the one skipped turn imposed when Haste ends. */
  hasteLethargySourceId?: string;
  /** Active concentration aura spell (Spirit Guardians, Call Lightning, Moonbeam).
   *  Deals damage each round to enemies in range while concentration holds. */
  concentrationAura?: {
    spellName: string;
    damageDice: string;
    damageType: string;
    saveAbility: keyof Abilities;
    saveDC: number;
    radiusFt: number;
    endRound: number;
    moveFt?: number;
    /** The area deals its full damage without a saving throw (Cloud of Daggers). */
    automaticDamage?: boolean;
    origin: 'caster' | 'point';
    point?: { x: number; y: number };
  };
  /** Persistent state for Spiritual Weapon. It is not a creature and never blocks a cell. */
  spiritualWeapon?: {
    position: { x: number; y: number };
    endRound: number;
    moveFt: number;
    attackBonus: number;
    damage: string;
    damageType: string;
  };
  /** State for a concentration spell that can be repeated as an action without another slot. */
  repeatableAreaSpell?: {
    name: string;
    endRound: number;
    damageType: string;
    damageDice: string;
    saveAbility: keyof Abilities;
    saveDC: number;
    area: string;
  };
  /** Active 2024 Wild Shape overlay. When present, the Druid fights as a beast:
   *  beast AC/speed/attacks/physical stats replace the Druid's, spellcasting
   *  is blocked, and the form lasts until its Wild Shape temporary HP is gone. */
  wildShape?: {
    beastName: string;
    tempHp: number;
    maxTempHp: number;
    formHp: number;
    cr: string;
    ac: number;
    speed: Speed;
    actions: MonsterAction[];
    traits?: MonsterTrait[];
    saves?: Partial<Record<keyof Abilities, number>>;
    size: MonsterData['size'];
    abilities: Pick<Abilities, 'str' | 'dex' | 'con'>;
    isMoon: boolean;
  };
  /** Target swallowed by this creature, for stat blocks such as Giant Toad. */
  swallowedTargetId?: string;
  /** Source creature that swallowed this creature, if any. */
  swallowedBy?: {
    sourceId: string;
    damageDice: string;
    damageType: string;
  };
  /** Runtime ability score reductions such as Shadow strength drain. */
  abilityScoreDamage?: Partial<Record<keyof Abilities, number>>;
  /** Cumulative Hit Point maximum reduction in the current encounter. */
  hpMaxReduction?: number;
  /** Generic ongoing wounds, poison, and similar source-tied damage effects. */
  ongoingEffects?: RuntimeOngoingEffect[];
  /** Generic containment state for engulf/whelm/smother style effects. */
  containedBy?: RuntimeContainerState;
  /** Runtime head tracking for Hydra-style multiattack/reaction mechanics. */
  hydraHeads?: {
    living: number;
    killedSinceTurn: number;
    tookFireSinceTurn: boolean;
    damageTurnKey?: string;
    damageThisTurn?: number;
    headKilledThisTurn?: boolean;
  };
  /** Number of reactions used this round when a creature can take more than one. */
  reactionsUsed?: number;
  /**
   * Animation-replay overlays. These fields are written ONLY by
   * `applyEventToReplay` on the replay-state snapshot (never on the
   * engine truth in `state.creatures`). Underscore prefix is the
   * convention for "replay scratch space" so readers can tell at a
   * glance this isn't engine data.
   *
   * Replay consumers read these to render mid-battle visual state that
   * doesn't belong in the engine (the beast form a Druid is currently
   * wearing, the aura a concentration spell is projecting). The engine
   * has its own non-underscore `wildShape` / `concentrationAura`
   * fields for gameplay logic.
   */
  _wildShapeBeast?: string;
  _concentrationAura?: {
    damageType: string;
    radiusFt: number;
    origin: 'caster' | 'point';
    point?: { x: number; y: number };
  };
}

/**
 * A timed buff/debuff living on a creature. Applied during attack
 * resolution (attackBonusDice, damageRider, acBonus) or save resolution
 * (saveBonusDice). Removed when:
 *   - the endRound has passed (round-tick cleanup), OR
 *   - the caster loses concentration (for concentration spells), OR
 *   - the caster dies (for caster-tied buffs), OR
 *   - explicitly removed by another ability.
 */
export interface ActiveBuff {
  /** Human-readable name for logs. */
  name: string;
  /** Unique spell/ability key - used to check for duplicates ("hasBuff"). */
  key: string;
  /** Who placed this buff (used for concentration cleanup / attribution). */
  casterId: string;
  appliedRound: number;
  /** Round at which this buff expires; Infinity for unbounded (ends on concentration drop). */
  endRound: number;
  /** True if this buff is held up by the caster's concentration slot. */
  requiresConcentration?: boolean;
  /** Slot level of the spell that created this effect, for Dispel Magic. */
  spellLevel?: number;
  /**
   * Dice/flat bonus added to THIS creature's attack rolls. "1d4" for Bless,
   * "-1d4" for Bane.
   */
  attackBonusDice?: string;
  /** Flat bonus added to attack rolls. Sacred Weapon uses this. */
  attackBonus?: number;
  /** Bonus to saving throws THIS creature makes. Same format as attackBonusDice. */
  saveBonusDice?: string;
  /** Flat AC modifier while active. Shield of Faith: +2. */
  acBonus?: number;
  acMinimum?: number;
  acBaseFromDex?: number;
  /** Aid-style increase to current and maximum HP for the encounter. */
  maxHpBonus?: number;
  /**
   * Extra damage rolled on each of this creature's successful weapon
   * attacks (e.g. Hunter's Mark "1d6 piercing", Hex "1d6 necrotic").
   */
  damageRider?: string;
  /** Damage this buff can deal when its caster spends a later bonus action (2024 Witch Bolt). */
  bonusActionDamage?: string;
  /** The affected creature can take Dash as a Bonus Action. */
  bonusActionDash?: boolean;
  /** Damage type for bonusActionDamage. */
  bonusActionDamageType?: string;
  /** Maximum range in feet for the bonus-action damage link. */
  bonusActionDamageRange?: number;
  /** Linked damage effects such as Witch Bolt end when their target dies. */
  endsWhenTargetDies?: boolean;
  /**
   * True if this buff gives resistance to bludgeoning/piercing/slashing
   * damage (Rage).
   */
  resistPhysical?: boolean;
  /** Resistance to specific damage types, e.g. Hunter Superior Defense. */
  resistDamageTypes?: string[];
  /** Resistance to all damage except the listed damage types (Monk Superior Defense). */
  resistAllDamageExcept?: string[];
  /**
   * True if this buff adds a flat melee STR damage bonus (Rage at L1-8 = +2).
   */
  rageDamageBonus?: number;
  /**
   * For conditional damage riders (e.g. Ranger's Colossus Slayer only
   * triggers on creatures not at full HP): engine checks this hook.
   */
  conditionalRider?: 'targetNotFullHp';
  /** Damage dealt to melee attackers that hit this creature (e.g. Fire Shield "2d8 fire"). */
  reactiveDamage?: string;
  /** This effect ends when the temporary HP that powers it are depleted. */
  endsWhenTemporaryHpDepleted?: boolean;
  /** If true, the first time the target would drop to 0 HP, it drops to 1 HP instead (Death Ward). */
  preventDeath?: boolean;
  /** Weapon Mastery: Vex gives one attacker Advantage against this creature. */
  advantageForAttackerId?: string;
  /** Guiding Bolt-style rider: the next attack roll against this creature has Advantage. */
  advantageForAllAttackers?: boolean;
  /** Weapon Mastery: Sap gives this creature Disadvantage on attack rolls while active. */
  attackDisadvantage?: boolean;
  attackDisadvantageAgainstCaster?: boolean;
  attackersHaveDisadvantage?: boolean;
  /** One-shot rider such as Barbarian Staggering Blow: next save has Disadvantage. */
  saveDisadvantage?: boolean;
  saveDisadvantageAbilities?: Array<keyof Abilities>;
  abilityCheckDisadvantageAbilities?: Array<keyof Abilities>;
  forcedDodgeSave?: { ability: keyof Abilities; dc: number };
  forcedFlee?: boolean;
  /** Weapon Mastery: Slow reduces this creature's speed while active. */
  speedPenalty?: number;
  /** Longstrider-style increase to all movement speeds. */
  speedBonus?: number;
  /** Flat bonus to Dexterity (Stealth) checks, e.g. Pass without Trace. */
  stealthBonus?: number;
  /** Tremorsense range in feet. It pinpoints grounded creatures but is not sight. */
  tremorsenseRange?: number;
  /** One-shot rider such as Barbarian Staggering Blow: no Opportunity Attacks. */
  preventsOpportunityAttacks?: boolean;
  /** The creature cannot take reactions while this effect lasts. */
  preventsReactions?: boolean;
  /** One-shot rider such as Barbarian Sundering Blow: next other attacker gets a flat bonus. */
  attackBonusForAllAttackers?: number;
  /** Innate Sorcery-style rider: this creature has Advantage on spell attack rolls. */
  spellAttackAdvantage?: boolean;
  /** Innate Sorcery-style rider: this creature's spell save DC increases by this amount. */
  spellSaveDcBonus?: number;
  /** Some short mastery debuffs expire at the start of the source creature's next turn. */
  expiresOnSourceTurnStart?: boolean;
  /** Disadvantage on Strength attack rolls and saving throws. */
  strengthTestDisadvantage?: boolean;
  /** Advantage on Strength attack rolls and saving throws. */
  strengthTestAdvantage?: boolean;
  /** Dice subtracted from each damage roll this creature makes. */
  damageRollPenalty?: string;
  weaponDamageBonus?: number;
  /** Dice added to weapon and Unarmed Strike damage, such as Enlarge. */
  weaponDamageBonusDice?: string;
  /** Dice subtracted from weapon and Unarmed Strike damage, such as Reduce. */
  weaponDamagePenaltyDice?: string;
  weaponAttacksMagical?: boolean;
  weaponDamageRider?: string;
  weaponConditionOnHit?: MonsterAction['conditionOnHit'];
  endsOnWeaponHit?: boolean;
  appliedCondition?: Condition;
  appliedConditions?: Condition[];
  endsOnDamage?: boolean;
  temporaryHpAtTurnStart?: number;
  conditionImmunities?: Condition[];
  endsOnAttackOrCast?: boolean;
  mirrorImages?: number;
  sanctuarySaveDc?: number;
  attackersOfTypesHaveDisadvantage?: string[];
  canSeeInvisible?: boolean;
  hasteAction?: boolean;
  saveAdvantageAbilities?: Array<keyof Abilities>;
  saveAdvantageConditions?: Condition[];
  /** Repeat this save at the specified point and remove the buff on success. */
  saveEnds?: { ability: keyof Abilities; dc: number; at: 'targetTurnEnd'; advantageOnDamage?: boolean };
  escapeAction?: { ability: keyof Abilities; dc: number };
  /** A damage-triggered advantage marker consumed by the next save-end roll. */
  saveAdvantageOnNextSave?: boolean;
}

/** A serialized area of magical darkness on the combat grid. */
export interface DarknessZone {
  sourceId: string;
  x: number;
  y: number;
  radius: number;
  endRound: number;
  requiresConcentration: boolean;
}

/** A serialized battlefield zone that can impose a saving throw on entry or turn end. */
export interface PersistentZone {
  sourceId: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  endRound: number;
  saveAbility?: keyof Abilities;
  saveDC?: number;
  conditionOnFail?: Condition;
  conditionDuration?: ConditionDuration;
  triggers: Array<'entry' | 'turnStart' | 'turnEnd'>;
  difficultTerrain?: boolean;
  difficultTerrainTowardSource?: boolean;
  damagePer5Ft?: { dice: string; type: string };
  shape?: 'line';
  origin?: { x: number; y: number };
  direction?: { x: number; y: number };
  pushOnFailedSave?: number;
  requiresConcentration: boolean;
}

export interface CreatureStats {
  damageDealt: number;
  damageTaken: number;
  attacksMade: number;
  attacksHit: number;
  killCount: number;
  roundsSurvived: number;
  deathRound?: number;
  killedBy?: string;
  killedByAction?: string;
  actionUsage: Record<string, number>;
  /** Hero-only: how many times this hero entered the dying state in this battle. */
  timesDowned?: number;
  /** Hero-only: how many times this hero was healed back from 0 HP (any heal that
   *  revives an unconscious-at-0 hero). Distinct from timesStabilisedBySaves
   *  which is the 3-success outcome with no healer involvement. */
  timesRevived?: number;
  /** Hero-only: how many times this hero stabilised via 3 death-save successes
   *  (stays unconscious, no longer rolling). Distinct from timesRevived. */
  timesStabilisedBySaves?: number;
  /** Hero-only: how many times this hero was stabilised by an adjacent ally
   *  spending their action. Leaves the hero unconscious at 0 HP. */
  timesStabilisedByAllies?: number;
  /** Hero-only: how many times a nat-20 death save popped them back to 1 HP. */
  timesPoppedAtOneHp?: number;
  /** Hero-only: total death-save rolls made this battle (all outcomes). */
  deathSaveRolls?: number;
  /** Hero-only: true if this hero's permanent death came from 3 failed death
   *  saves (vs outright kill via massive damage / monster). Used by MC to
   *  split "deaths after saves" from "outright deaths". */
  diedFromSaves?: boolean;
  /** Healer-only: how many times this creature revived a 0-HP ally via healing. */
  alliesRevived?: number;
  /** Hero-only: how many adjacent dying allies this creature stabilised. */
  alliesStabilised?: number;
}

export type Condition =
  | 'blinded'
  | 'charmed'
  | 'deafened'
  | 'frightened'
  | 'grappled'
  | 'incapacitated'
  | 'invisible'
  | 'paralyzed'
  | 'petrified'
  | 'poisoned'
  | 'prone'
  | 'restrained'
  | 'stunned'
  | 'unconscious';

export type ConditionDuration = 'end_of_next_turn' | '1_minute' | 'permanent' | 'start_of_next_turn';

export interface ConditionTimer {
  condition: Condition;
  duration: ConditionDuration;
  appliedRound: number;
  sourceId: string;
  saveDC?: number;
  saveAbility?: keyof Abilities;
  stageInfo?: { stages: Condition[]; currentIndex: number; finalDuration?: ConditionDuration };
}
