/**
 * Hero classes.
 *
 * Produces a MonsterData-compatible stat block for a given (class, level)
 * pair so the existing combat engine, picker, and MC sim work unchanged.
 * Heroes are flagged with `isHero: true` + `heroClass` + `heroLevel` so
 * the UI can distinguish them (gold ring on tokens, "Heroes" picker tab)
 * and `getMonsterByName` still works for reload.
 *
 * Scope:
 *   - Weapon attacks: modeled with attackBonus, damage, range, and selected
 *     2024 Weapon Mastery properties for classes that have mastery.
 *   - Extra Attack at L5: modeled as a multiattack action for martial classes.
 *   - Sneak Attack: modeled as `additionalDamage` on rogue finesse weapons,
 *     scaling 1d6 → 2d6 → 3d6 at odd levels. The engine gates it by
 *     Advantage or an adjacent ally and enforces once per turn.
 *   - Cantrips: implemented as ranged attacks / DC saves. Scale to 2 dice at L5.
 *   - Leveled spells: modeled for fixed class loadouts with slot resources.
 *   - Class features: key combat resources such as Rage, Bardic Inspiration,
 *     Second Wind, Lay on Hands, Wild Shape, Action Surge, Flurry of Blows,
 *     and Divine Smite are modeled where the engine has enough hooks.
 *
 * Abilities are chosen from a fixed per-class array and deterministic ASI
 * choices. Classes are unlocked beyond level 10 only after their combat
 * features have been audited and modeled.
 * This matches a legal 2024 standard-array-plus-background-boost chassis
 * without modeling species traits or origin feats.
 */
import { MonsterData, MonsterAction, MonsterTrait, Abilities, type Speed, type WeaponMasteryProperty } from '../types/monster.js';
import { monsters } from './monsters.js';
import {
  FULL_CASTER_SLOTS, HALF_CASTER_SLOTS, WARLOCK_SLOTS, slotsToResources,
  magicMissile, burningHands, thunderwave, sleep,
  scorchingRay, web, spikeGrowth, flamingSphere, cloudOfDaggers, shatter, moonbeam, holdPerson, spiritualWeapon,
  fireball, lightningBolt, spiritGuardians, callLightning, hypnoticPattern,
  bless, bane, cureWounds, healingWord, heroism, protectionFromEvilAndGood, sanctuary, shieldOfFaith, guidingBolt,
  hex, huntersMark, dissonantWhispers, entangle,
  iceStorm, banishment, blight, fireShield, stoneskin, deathWard,
  coneOfCold, flameStrike, holdMonster, massCureWounds, synapticStatic,
  harm, heal, fireStorm, sunburst, massHeal, stormOfVengeance,
  blindingSmite, conjureBarrage, protectionFromEnergy,
  chromaticOrb, inflictWounds, command, witchBolt, counterspell,
  blindnessDeafness, invisibility, mirrorImage, seeInvisibility, dispelMagic, haste, wallOfFire,
  aid, magicWeapon, shiningSmite,
  acidArrow, armsOfHadar, barkskin, bestowCurse, blur, colorSpray, divineFavor, faerieFire, falseLife, fear, fly, fogCloud, grease, gustOfWind, lesserRestoration, mistyStep,
  armorOfAgathys, longstrider, mageArmor, rayOfSickness, revivify, tashasHideousLaughter,
  protectionFromPoison, shield, hellishRebuke,
  circleOfDeath, chainLightning, disintegrate, fingerOfDeath,
  befuddlement, powerWordHeal, powerWordKill, meteorSwarm,
} from './spells.js';

export type HeroClassName =
  | 'Barbarian' | 'Bard' | 'Cleric' | 'Druid' | 'Fighter' | 'Monk'
  | 'Paladin' | 'Ranger' | 'Rogue' | 'Sorcerer' | 'Warlock' | 'Wizard';

export type DruidSubclassName = 'Circle of the Land' | 'Circle of the Moon';
export type HeroSubclassName = DruidSubclassName | 'Path of the Berserker' | 'College of Lore' | 'Life Domain' | 'Champion' | 'Warrior of the Open Hand' | 'Oath of Devotion' | 'Hunter' | 'Thief' | 'Draconic Sorcery' | 'Fiend Patron' | 'Evoker';

export interface BuildHeroOptions {
  subclass?: HeroSubclassName;
  preferredWildShapeBeast?: string;
}

export const HERO_CLASS_NAMES: HeroClassName[] = [
  'Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk',
  'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard',
];

export const MIN_HERO_LEVEL = 1;
export const MAX_HERO_LEVEL = 20;

export const HERO_CLASS_MAX_LEVELS: Record<HeroClassName, number> = {
  Barbarian: 20,
  Bard: 20,
  Cleric: 20,
  Druid: 20,
  Fighter: 20,
  Monk: 20,
  Paladin: 20,
  Ranger: 20,
  Rogue: 20,
  Sorcerer: 20,
  Warlock: 20,
  Wizard: 20,
};

export function getMaxHeroLevelForClass(className: HeroClassName): number {
  return HERO_CLASS_MAX_LEVELS[className] ?? 10;
}

export function getHeroLevelOptions(className: HeroClassName): number[] {
  const max = getMaxHeroLevelForClass(className);
  return Array.from({ length: max - MIN_HERO_LEVEL + 1 }, (_, i) => MIN_HERO_LEVEL + i);
}

export function isSupportedHeroLevel(className: HeroClassName, level: number): boolean {
  return Number.isInteger(level) && level >= MIN_HERO_LEVEL && level <= getMaxHeroLevelForClass(className);
}

// ─────────────────────────────────────────────────────────────────────────────
// Static class data
// ─────────────────────────────────────────────────────────────────────────────

type AbilityKey = keyof Abilities;

interface ClassSpec {
  hitDie: 6 | 8 | 10 | 12;
  /** Ability used for weapon attacks (& which the class hits highest). */
  primary: AbilityKey;
  /** Second-highest ability. Gets 14 at L1 (stays 14). Reflects the class's
   *  most important secondary stat: DEX for AC on light/medium/unarmored,
   *  WIS for monks and rangers, STR for clerics, CHA for paladins. */
  secondary: AbilityKey;
  /** Optional tertiary ability bumped to 14 only when `secondary` is CON
   *  (already 14 in the default array). Without this the secondary
   *  bump is a no-op and the class ends up 4 ability points short of
   *  the 72-point standard-array budget. Pick the next-most-useful
   *  stat for combat: DEX (Initiative + DEX saves) for STR martials,
   *  WIS (Perception + WIS saves) for DEX rogues. */
  tertiary?: AbilityKey;
  /** Two saving throw proficiencies. */
  saves: [AbilityKey, AbilityKey];
  /** Standard skill proficiencies (more than RAW lets you pick  - deliberately
   *  generous so the stat block reads complete). */
  skills: string[];
  /** One-line flavour for the picker card. */
  description: string;
  /** "0" → unarmored, else armor AC before DEX (DEX added up to `dexCap`). */
  armorBase: number;
  /** Max DEX bonus the armor allows. 0 = heavy armor, 2 = medium, Infinity = light/none. */
  dexCap: number;
  shield: boolean;
  /** Extra Attack at L5 (martial-caster halves like ranger & paladin too). */
  extraAttack: boolean;
  /** Finesse = primary weapon uses DEX for atk/dmg regardless of class primary. */
  finesse: boolean;
  /** Primary weapon definition. */
  weapon: WeaponSpec;
  /** Optional secondary weapon (e.g. longbow for Fighter, javelin for Barbarian). */
  secondaryWeapon?: WeaponSpec;
  /** Rogue-only: Sneak Attack dice riders on finesse/ranged weapons. */
  sneakAttack?: boolean;
  /** Caster gets a cantrip that scales with level. */
  cantrip?: CantripSpec;
  /** Features shown as trait text, grouped by unlock level. */
  features: Record<number, Array<{ name: string; description: string }>>;
  /** Movement in feet/round. Mostly 30; monks get +10 at L2. */
  speed: number;
}

interface WeaponSpec {
  name: string;
  die: string;              // e.g., "1d8", "2d6"
  damageType: string;       // lowercase to match engine (e.g., "slashing")
  kind: 'melee' | 'ranged';
  reach?: number;
  range?: { normal: number; long: number };
  attackBonusOverride?: number;
  damageOverride?: string;
  /** If set, overrides the class primary ability for this weapon. */
  abilityOverride?: AbilityKey;
  finesse?: boolean;
  /** 2024 weapon mastery property for this weapon. Applied only when the class has mastery. */
  mastery?: WeaponMasteryProperty;
  /** 5e Loading property. Inferred for crossbows unless explicitly provided. */
  loading?: boolean;
  heavy?: boolean;
  closeRangeDisadvantage?: boolean;
}

interface CantripSpec {
  name: string;
  /** "attack" → ranged attack roll, "save" → savingThrow action. */
  resolution: 'attack' | 'save';
  spellSchool?: MonsterAction['spellSchool'];
  /** Damage die, e.g., "1d10", "1d8". Scales x2 at L5. */
  baseDie: string;
  damageType: string;
  /** For attack cantrips. */
  range?: { normal: number; long: number };
  /** For save cantrips. */
  saveAbility?: AbilityKey;
  /** "half" → takes half damage on save; undefined → no damage on save. */
  damageOnSuccess?: 'half' | undefined;
  /** Buff applied when a target fails the saving throw. */
  buffOnFailedSave?: MonsterAction['buffOnFailedSave'];
  /** Caster ability for save DC (8 + PB + mod). */
  spellcastingAbility: AbilityKey;
  /** Adds the caster's spellcasting ability mod to damage (Warlock's Agonizing Blast). */
  addAbilityToDamage?: boolean;
  /** Minimum hero level before addAbilityToDamage applies. */
  addAbilityToDamageAtLevel?: number;
  description: string;
}

// Compact wording for features so we don't have a 200-line class def.
const F = (name: string, description: string) => ({ name, description });

// ─────────────────────────────────────────────────────────────────────────────
// Class specs
// ─────────────────────────────────────────────────────────────────────────────

const CLASSES: Record<HeroClassName, ClassSpec> = {
  Barbarian: {
    hitDie: 12, primary: 'str', secondary: 'dex', saves: ['str', 'con'],
    skills: ['Athletics', 'Perception', 'Intimidation', 'Survival'],
    description: 'Rage-fueled melee tank. Unarmored Defense (AC = 10 + DEX + CON). Greataxe + javelins.',
    armorBase: 0, dexCap: Infinity, shield: false, speed: 30,
    extraAttack: true, finesse: false,
    weapon: { name: 'Greataxe', die: '1d12', damageType: 'slashing', kind: 'melee', reach: 5, mastery: 'cleave' },
    secondaryWeapon: { name: 'Javelin', die: '1d6', damageType: 'piercing', kind: 'ranged', range: { normal: 30, long: 120 }, abilityOverride: 'str', mastery: 'slow' },
    features: {
      1: [
        F('Rage', 'Bonus action: rage for 1 minute. +2 melee damage, resistance to bludgeoning/piercing/slashing while raging. Simulated.'),
        F('Unarmored Defense', 'While not wearing armor: AC = 10 + DEX + CON mod. Shield still allowed.'),
      ],
      2: [F('Reckless Attack', 'Optional advantage on STR-based melee attacks; attackers have advantage back against you. Simulated.'),
          F('Danger Sense', 'Advantage on DEX saves vs effects you can see.')],
      3: [F('Primal Path: Berserker', 'Frenzy: exhaust yourself for a bonus-action attack each round of rage. Simulated.')],
      4: [F('Ability Score Improvement', '+2 STR (already baked into stats above).')],
      5: [F('Extra Attack', 'Attack twice on the Attack action.'),
          F('Fast Movement', '+10 ft speed while unarmored.')],
      6: [F('Mindless Rage', 'Can\'t be charmed or frightened while raging.')],
      7: [F('Feral Instinct', 'Advantage on Initiative rolls. Simulated.'),
          F('Instinctive Pounce', 'Move up to half Speed when entering Rage. Simulated.')],
      8: [F('Ability Score Improvement', '+2 STR (baked in).')],
      9: [F('Brutal Strike', 'Forgo Reckless Attack advantage for +1d10 damage and a control rider. Simulated with Hamstring by default.'),
          F('Rage Damage +3', 'Rage damage bonus increases to +3. Simulated.')],
      10: [F('Retaliation (Berserker)', 'Reaction melee attack when damaged by creature within 5 ft. Simulated.')],
      11: [F('Relentless Rage', 'While raging, drop to twice Barbarian level HP on a successful CON save instead of falling. Simulated.')],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON/DEX for durability.')],
      13: [F('Improved Brutal Strike', 'Adds Staggering Blow and Sundering Blow options. Simulated with tactical rider selection.')],
      14: [F('Intimidating Presence (Berserker)', 'Bonus action: 30-foot WIS save or Frightened. Simulated.')],
      15: [F('Persistent Rage', 'Rage lasts 10 minutes and no longer needs attacks or bonus actions to extend. Simulated as battle-long duration.')],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for durability. Rage damage becomes +4.')],
      17: [F('Improved Brutal Strike', 'Brutal Strike damage becomes 2d10 and applies two different riders. Simulated.')],
      18: [F('Indomitable Might', 'Strength saves below STR score use STR score instead. Simulated for saving throws.')],
      19: [F('Epic Boon: Irresistible Offense', 'Fixed loadout takes the recommended boon: +1 STR, ignore B/P/S resistance, crits add STR damage. Simulated.')],
      20: [F('Primal Champion', '+4 STR and +4 CON, maximum 25. Baked into stats.')],
    },
  },

  Bard: {
    hitDie: 8, primary: 'cha', secondary: 'dex', saves: ['dex', 'cha'],
    skills: ['Performance', 'Persuasion', 'Deception', 'Stealth', 'Insight'],
    description: 'Full caster support. Studded leather (AC 12 + DEX) + rapier + shortbow. Vicious Mockery cantrip. College of Lore.',
    armorBase: 12, dexCap: Infinity, shield: false, speed: 30,
    extraAttack: false, finesse: true,
    weapon: { name: 'Rapier', die: '1d8', damageType: 'piercing', kind: 'melee', reach: 5 },
    secondaryWeapon: { name: 'Shortbow', die: '1d6', damageType: 'piercing', kind: 'ranged', range: { normal: 80, long: 320 } },
    cantrip: {
      name: 'Vicious Mockery', resolution: 'save', baseDie: '1d4', damageType: 'psychic',
      saveAbility: 'wis', spellcastingAbility: 'cha',
      description: 'WIS save; fail -> psychic damage + disadvantage on the next attack roll.',
      buffOnFailedSave: {
        name: 'Vicious Mockery',
        key: 'vicious-mockery-disadvantage',
        attackDisadvantage: true,
      },
    },
    features: {
      1: [F('Spellcasting', 'Full caster (CHA). Fixed level-appropriate spell loadout is simulated.'),
          F('Bardic Inspiration (d6)', 'Bonus action: give an ally a d6 to add to one attack roll or saving throw. Simulated.')],
      2: [F('Jack of All Trades', 'Half proficiency on non-proficient ability checks.'),
          F('Song of Rest (d6)', 'Extra healing during short rests. Not simulated.')],
      3: [F('Bard College: Lore', 'Cutting Words reaction, extra skill proficiencies.'),
          F('Expertise', 'Double proficiency on two chosen skills.')],
      4: [F('Ability Score Improvement', '+2 CHA (baked in).')],
      5: [F('Bardic Inspiration (d8)', 'Inspiration die upgrades to d8.'),
          F('Font of Inspiration', 'Regain Bardic Inspiration on short rest.')],
      6: [F('Countercharm', 'Reaction: reroll failed save vs Charmed/Frightened for self or ally. Simulated.'),
          F('Lore: Magical Discoveries', 'Learn 2 spells from Cleric, Druid, or Wizard. BattleCast default includes Fireball from Wizard.')],
      7: [],
      8: [F('Ability Score Improvement', '+1 CHA/+1 DEX (baked in).')],
      9: [F('Expertise', 'Two more skill expertises.')],
      10: [F('Magical Secrets', 'Can prepare spells from Bard, Cleric, Druid, and Wizard lists. Default combat loadout uses modeled SRD spells where the engine can represent them cleanly.'),
           F('Bardic Inspiration (d10)', 'Inspiration die upgrades to d10. Simulated.')],
      11: [],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout increases DEX for AC/initiative.')],
      13: [],
      14: [F('Peerless Skill (Lore)', 'Spend Bardic Inspiration on a failed attack roll; only expended if it turns the miss into a hit. Simulated.')],
      15: [F('Bardic Inspiration (d12)', 'Inspiration die upgrades to d12. Simulated.')],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for durability.')],
      17: [],
      18: [F('Superior Inspiration', 'When rolling initiative, regain Bardic Inspiration uses until you have two. Simulated.')],
      19: [F('Epic Boon: Spell Recall', 'Fixed loadout takes the recommended boon: +1 CHA and level 1-4 spell slots can be preserved on a matching d4. Simulated.')],
      20: [F('Words of Creation', 'Power Word Heal and Power Word Kill are always prepared; either can affect a second creature within 10 ft of the first. Simulated.')],
    },
  },

  Cleric: {
    hitDie: 8, primary: 'wis', secondary: 'str', saves: ['wis', 'cha'],
    skills: ['Religion', 'Insight', 'Medicine', 'Persuasion'],
    description: 'Full caster + heavy armor + shield via Divine Order: Protector. Warhammer and Sacred Flame cantrip.',
    armorBase: 16, dexCap: 0, shield: true, speed: 30,
    extraAttack: false, finesse: false,
    weapon: { name: 'Warhammer', die: '1d8', damageType: 'bludgeoning', kind: 'melee', reach: 5, abilityOverride: 'str' },
    cantrip: {
      name: 'Sacred Flame', resolution: 'save', baseDie: '1d8', damageType: 'radiant',
      saveAbility: 'dex', spellcastingAbility: 'wis',
      range: { normal: 60, long: 60 },
      description: 'Target within 60 ft makes a DEX save; no cover bonus. Damage on fail.',
    },
    features: {
      1: [F('Spellcasting', 'Full caster (WIS). Fixed level-appropriate spell loadout is simulated.'),
          F('Divine Order: Protector', 'Training with martial weapons and heavy armor. BattleCast uses chain mail + shield.')],
      2: [F('Channel Divinity (2/rest)', 'Divine Spark and Turn Undead. Divine Spark is simulated; Life Domain adds Preserve Life at L3.')],
      3: [F('Life Domain', 'Disciple of Life improves slot-based healing. Life Domain combat spells are included in the fixed loadout. Simulated.')],
      4: [F('Ability Score Improvement', '+2 WIS (baked in).')],
      5: [F('Sear Undead', 'Turn Undead can deal radiant damage to undead. Turn Undead is not part of the default combat planner yet.')],
      6: [F('Channel Divinity (3/rest)', 'Channel Divinity uses increase to 3.'),
          F('Life: Blessed Healer', 'You regain HP when casting a slot-based healing spell on an ally. Simulated.')],
      7: [F('Blessed Strikes', 'Divine Strike: +1d8 radiant on weapon hits. Simulated.')],
      8: [F('Ability Score Improvement', '+2 WIS (baked in).')],
      9: [],
      10: [F('Divine Intervention', 'Magic action: cast a Cleric spell of level 5 or lower without a spell slot. Simulated with free Flame Strike / Mass Cure Wounds choices.')],
      11: [],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for concentration and durability.')],
      13: [],
      14: [F('Improved Blessed Strikes', 'Divine Strike increases to +2d8 radiant on weapon hits. Simulated.')],
      15: [],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for concentration and durability.')],
      17: [F('Life: Supreme Healing', 'Healing dice from Cleric spells and Channel Divinity use maximum values. Simulated for spells with healing dice.')],
      18: [F('Channel Divinity (4/rest)', 'Channel Divinity uses increase to 4.')],
      19: [F('Epic Boon: Fate', 'Fixed loadout takes the recommended boon: +1 WIS. Improve Fate reaction is not yet simulated.')],
      20: [F('Greater Divine Intervention', 'Divine Intervention can choose Wish. Simulated as one free high-impact Wish-Heal option using the Divine Intervention resource.')],
    },
  },

  Druid: {
    hitDie: 8, primary: 'wis', secondary: 'dex', saves: ['int', 'wis'],
    skills: ['Nature', 'Perception', 'Survival', 'Medicine'],
    description: 'Full caster (WIS). Circle of the Land (Polar) Warden chassis with armor + wooden shield, quarterstaff, Produce Flame cantrip.',
    armorBase: 12, dexCap: Infinity, shield: true, speed: 30,
    extraAttack: false, finesse: false,
    weapon: { name: 'Quarterstaff', die: '1d8', damageType: 'bludgeoning', kind: 'melee', reach: 5, abilityOverride: 'str' },
    cantrip: {
      name: 'Produce Flame', resolution: 'attack', baseDie: '1d8', damageType: 'fire',
      range: { normal: 30, long: 30 }, spellcastingAbility: 'wis',
      addAbilityToDamage: true,
      addAbilityToDamageAtLevel: 7,
      description: 'Hurl the flame as a ranged spell attack (30 ft).',
    },
    features: {
      1: [F('Spellcasting', 'Full caster (WIS). Fixed level-appropriate spell loadout is simulated.'),
          F('Primal Order: Warden', 'BattleCast uses the tougher level-1 battle chassis with armor and shield.'),
          F('Druidic', 'Secret druid language.')],
      2: [F('Wild Shape (2024, CR 1/4, no fly)', 'Bonus action: transform into a Beast. The Druid keeps real HP and gains temporary HP equal to Druid level. Simulated.')],
      3: [F('Circle of the Land (Polar)', 'Polar Circle Spells are always prepared; Land\'s Aid spends Wild Shape to damage enemies and heal an ally. Simulated.')],
      4: [F('Wild Shape Improvement (CR 1/2, no fly)', 'Wild Shape can use stronger non-flying Beast forms.'),
          F('Ability Score Improvement', '+2 WIS (baked in).')],
      5: [F('Wild Resurgence', 'Can trade spell slots and Wild Shape uses. Slot recovery is not usually relevant with full resources in one encounter.')],
      6: [F('Natural Recovery (Land)', 'Can cast one prepared Circle Spell without a spell slot. Simulated with a free Polar circle spell.')],
      7: [F('Elemental Fury: Potent Spellcasting', 'Add WIS modifier to Druid cantrip damage. Simulated.')],
      8: [F('Ability Score Improvement', '+1 WIS / +1 CON (baked in).'),
          F('Wild Shape Improvement (CR 1, fly allowed)', 'Wild Shape can use CR 1 Beast forms and forms with Fly Speed.')],
      9: [],
      10: [F('Nature\'s Ward (Polar)', 'Immune to Poisoned and resistant to Cold damage. Simulated.')],
      11: [],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for concentration and durability.')],
      13: [],
      14: [F('Nature\'s Sanctuary (Land)', 'Spend Wild Shape to conjure sheltering terrain. Simulated as a +2 AC half-cover buff for nearby allies.')],
      15: [F('Improved Elemental Fury', 'Potent Spellcasting extends cantrip range; the current grid rarely needs the extra range, so damage remains unchanged.')],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for concentration and durability.')],
      17: [],
      18: [F('Beast Spells', 'Can cast Druid spells while Wild Shaped. Simulated.')],
      19: [F('Epic Boon: Dimensional Travel', 'Fixed loadout takes the recommended boon: +1 WIS. The teleport rider is not yet simulated.')],
      20: [F('Archdruid', 'Evergreen Wild Shape and Nature Magician improve Wild Shape / slot conversion. Evergreen refresh is simulated on initiative.')],
    },
  },

  Fighter: {
    hitDie: 10, primary: 'str', secondary: 'con', tertiary: 'dex', saves: ['str', 'con'],
    skills: ['Athletics', 'Perception', 'Intimidation', 'Survival'],
    description: 'All-round martial. Champion Fighter with chain mail/plate, longsword, shield, javelins, Defense style, and scaling Extra Attack.',
    armorBase: 16, dexCap: 0, shield: true, speed: 30,
    extraAttack: true, finesse: false,
    weapon: { name: 'Longsword', die: '1d8', damageType: 'slashing', kind: 'melee', reach: 5, mastery: 'sap' },
    secondaryWeapon: { name: 'Javelin', die: '1d6', damageType: 'piercing', kind: 'ranged', range: { normal: 30, long: 120 }, abilityOverride: 'str', mastery: 'slow' },
    features: {
      1: [F('Fighting Style: Defense', '+1 AC while wearing armor (baked into AC).'),
          F('Second Wind', 'Bonus action: heal 1d10 + level. Simulated.')],
      2: [F('Action Surge (1/rest)', 'Take an extra action on your turn. Simulated.')],
      3: [F('Martial Archetype: Champion', 'Improved Critical: weapon attacks crit on 19-20. Simulated.')],
      4: [F('Ability Score Improvement', '+2 STR (baked in).')],
      5: [F('Extra Attack', 'Attack twice on the Attack action.')],
      6: [F('Ability Score Improvement', '+1 STR / +1 CON (baked in, STR 20).')],
      7: [F('Additional Fighting Style (Champion)', 'Gain another Fighting Style feat. BattleCast keeps Defense as the combat-relevant style.')],
      8: [F('Ability Score Improvement', '+1 CON / +1 DEX (baked in).')],
      9: [F('Indomitable (1/rest)', 'Reroll a failed save + add Fighter level as bonus. Simulated.'),
          F('Tactical Master', 'Replace weapon mastery property with Push, Sap, or Slow. Not yet simulated.')],
      10: [F('Heroic Warrior (Champion)', 'Gain Heroic Inspiration at start of each turn - reroll one missed attack per turn. Simulated.')],
      11: [F('Two Extra Attacks', 'Attack three times on the Attack action. Simulated.')],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for durability.')],
      13: [F('Indomitable (2/rest)', 'Indomitable uses increase to 2.'),
           F('Studied Attacks', 'After missing a creature, gain Advantage on the next attack against it before the end of your next turn. Simulated.')],
      14: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for durability.')],
      15: [F('Superior Critical', 'Champion weapon attacks crit on 18-20. Simulated.')],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout increases DEX for initiative and Dexterity saves.')],
      17: [F('Action Surge (2/rest)', 'Action Surge uses increase to 2, still only once on a turn. Simulated.'),
           F('Indomitable (3/rest)', 'Indomitable uses increase to 3.')],
      18: [F('Survivor', 'Regain HP at turn start while Bloodied, and death saves are much stronger. Simulated.')],
      19: [F('Epic Boon: Combat Prowess', 'Fixed loadout takes the recommended boon: +1 STR and one missed attack per turn can hit instead. Simulated.')],
      20: [F('Three Extra Attacks', 'Attack four times on the Attack action. Simulated.')],
    },
  },

  Monk: {
    hitDie: 8, primary: 'dex', secondary: 'wis', saves: ['str', 'dex'],
    skills: ['Acrobatics', 'Stealth', 'Insight', 'Religion'],
    description: 'Unarmored striker (AC = 10 + DEX + WIS). Warrior of the Open Hand with Focus Points, fast movement, and scaling Martial Arts.',
    armorBase: 0, dexCap: Infinity, shield: false, speed: 30,
    extraAttack: true, finesse: true,
    // Martial Arts: die scales with level. Handle in buildHero via override.
    weapon: { name: 'Martial Arts (Unarmed)', die: '1d4', damageType: 'bludgeoning', kind: 'melee', reach: 5 },
    secondaryWeapon: { name: 'Dart', die: '1d4', damageType: 'piercing', kind: 'ranged', range: { normal: 20, long: 60 }, abilityOverride: 'dex' },
    features: {
      1: [F('Martial Arts', 'Unarmed strike uses DEX. Damage die scales from d6 at L1 and grants one bonus-action Unarmed Strike after attacking.'),
          F('Unarmored Defense', 'While not wearing armor or shield: AC = 10 + DEX + WIS.')],
      2: [F('Monk\'s Focus', 'Focus Points fuel Flurry of Blows, Stunning Strike, Disciplined Survivor, Quivering Palm, and Superior Defense. Flurry is simulated.'),
          F('Unarmored Movement', 'Speed bonus while unarmored. Simulated.'),
          F('Uncanny Metabolism', 'Can refresh Focus Points and heal after rolling Initiative. Resource refresh is represented at battle start when relevant.')],
      3: [F('Monk Subclass: Warrior of the Open Hand', 'Open Hand Technique riders on Flurry. Topple is simulated.'),
          F('Deflect Attacks', 'Reaction reduces incoming attack damage; can redirect fully deflected blows. Simulated.')],
      4: [F('Ability Score Improvement', '+2 DEX (baked in).'),
          F('Slow Fall', 'Reduce fall damage.')],
      5: [F('Extra Attack', 'Attack twice on the Attack action.'),
          F('Stunning Strike', 'Once per turn on a Monk weapon or Unarmed Strike hit, spend 1 Focus Point; target CON save or Stunned. Simulated, including the success rider.')],
      6: [F('Empowered Strikes', 'Unarmed strikes can deal Force damage. BattleCast keeps bludgeoning damage unless a feature needs Force.'),
          F('Open Hand: Wholeness of Body', 'Bonus action self-healing. Simulated.')],
      7: [F('Evasion', 'DEX save success = 0 damage, fail = half damage. Simulated.')],
      8: [F('Ability Score Improvement', '+1 DEX / +1 WIS (baked in).')],
      9: [F('Acrobatic Movement', 'Walk on vertical surfaces and liquids.')],
      10: [F('Heightened Focus', 'Flurry of Blows: 3 strikes instead of 2. Simulated.'),
           F('Self-Restoration', 'End of turn: remove Charmed, Frightened, or Poisoned. Simulated.')],
      11: [F('Open Hand: Fleet Step', 'Step of the Wind can follow another bonus action. Movement chaining is not yet simulated.')],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout increases WIS/CON for defense and save DC.')],
      13: [F('Deflect Energy', 'Deflect Attacks works against any attack damage type. Simulated.')],
      14: [F('Disciplined Survivor', 'Proficiency in all saves; failed saves can spend Focus to reroll. Simulated.')],
      15: [F('Perfect Focus', 'When rolling Initiative, regain Focus Points until at least 4 if you have 3 or fewer. Simulated.')],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout increases WIS for AC and save DC.')],
      17: [F('Open Hand: Quivering Palm', 'Unarmed hits can seed vibrations; a later action deals 10d12 force damage, CON half. Simulated.')],
      18: [F('Superior Defense', 'Spend 3 Focus Points at turn start for resistance to all damage except Force. Simulated.')],
      19: [F('Epic Boon: Irresistible Offense', 'Fixed loadout takes the recommended boon: +1 DEX, ignore B/P/S resistance, crits add DEX damage. Simulated.')],
      20: [F('Body and Mind', '+4 DEX and +4 WIS, maximum 25. Baked into stats.')],
    },
  },

  Paladin: {
    hitDie: 10, primary: 'str', secondary: 'cha', saves: ['wis', 'cha'],
    skills: ['Athletics', 'Persuasion', 'Religion', 'Medicine'],
    description: 'Holy warrior. Devotion Paladin with longsword, shield, Defense style, healing, auras, Channel Divinity, and Divine Smite.',
    armorBase: 16, dexCap: 0, shield: true, speed: 30,
    extraAttack: true, finesse: false,
    weapon: { name: 'Longsword', die: '1d8', damageType: 'slashing', kind: 'melee', reach: 5, mastery: 'sap' },
    secondaryWeapon: { name: 'Javelin', die: '1d6', damageType: 'piercing', kind: 'ranged', range: { normal: 30, long: 120 }, abilityOverride: 'str', mastery: 'slow' },
    features: {
      1: [F('Lay on Hands', '5×level HP healing pool. Simulated.'),
          F('Spellcasting', 'Half-caster (CHA). Fixed level-appropriate spell loadout is simulated.'),
          F('Weapon Mastery', 'BattleCast applies mastery for the chosen weapon loadout.'),
          F('Divine Sense', 'Detect celestials/fiends/undead. Out-of-combat.')],
      2: [F('Fighting Style: Defense', '+1 AC while wearing armor (baked in from L2).'),
          F('Paladin\'s Smite', 'Divine Smite is always prepared. One free L1 smite and slotted smites on melee hits are simulated.')],
      3: [F('Divine Health', 'Immune to disease.'),
          F('Sacred Oath: Devotion', 'Channel Divinity: Sacred Weapon is simulated. Turn the Unholy is not yet modeled.')],
      4: [F('Ability Score Improvement', '+2 STR (baked in).')],
      5: [F('Extra Attack', 'Attack twice on the Attack action.')],
      6: [F('Aura of Protection', 'You and allies within 10 ft add CHA modifier to saving throws. Simulated.')],
      7: [F('Aura of Devotion (Oath)', 'You and allies within 10 ft immune to Charmed. Simulated.')],
      8: [F('Ability Score Improvement', '+1 STR / +1 CHA (baked in).')],
      9: [F('Abjure Foes', 'Channel Divinity: Frighten up to CHA-mod creatures within 60 ft. Simulated.')],
      10: [F('Aura of Courage', 'You and allies within 10 ft immune to Frightened. Simulated.')],
      11: [F('Radiant Strikes', 'Melee weapon hits add 1d8 radiant damage. Simulated.'),
           F('Channel Divinity', 'Channel Divinity uses increase to 3.')],
      12: [F('Ability Score Improvement', '+2 CHA (baked in).')],
      13: [F('Fourth-level Spells', 'Paladin and Devotion Oath spell access expands. Modeled loadout adds Death Ward and Banishment.')],
      14: [F('Restoring Touch', 'Lay on Hands can spend 5 pool points to remove Poisoned, Blinded, Charmed, Deafened, Frightened, Paralyzed, or Stunned. Simulated.')],
      15: [F('Smite of Protection (Oath)', 'After Divine Smite, allies in your aura gain Half Cover until your next turn. Simulated as +2 AC.')],
      16: [F('Ability Score Improvement', '+2 CHA (baked in).')],
      17: [F('Fifth-level Spells', 'Devotion capstone spell loadout includes Flame Strike.')],
      18: [F('Aura Expansion', 'Aura of Protection, Devotion, Courage, Smite of Protection, and Holy Nimbus expand to 30 ft. Simulated.')],
      19: [F('Epic Boon: Truesight', 'Fixed loadout takes the recommended boon: +1 CHA and Truesight 60 ft. Simulated in senses/stat line.')],
      20: [F('Holy Nimbus (Oath)', 'Bonus action aura. Enemies that start turns in the aura take radiant damage. Simulated.')],
    },
  },

  Ranger: {
    hitDie: 10, primary: 'dex', secondary: 'wis', saves: ['str', 'dex'],
    skills: ['Survival', 'Perception', 'Nature', 'Stealth'],
    description: 'Half-caster bow-wielder. Scale mail (AC 14 + DEX max 2) + longbow + shortsword. Archery style +2 ranged. Extra Attack at 5.',
    armorBase: 14, dexCap: 2, shield: false, speed: 30,  // scale mail
    extraAttack: true, finesse: true,
    weapon: { name: 'Longbow', die: '1d8', damageType: 'piercing', kind: 'ranged', range: { normal: 150, long: 600 }, mastery: 'slow' },
    secondaryWeapon: { name: 'Shortsword', die: '1d6', damageType: 'piercing', kind: 'melee', reach: 5, mastery: 'vex' },
    features: {
      1: [F('Spellcasting', 'Half-caster (WIS). Fixed level-appropriate spell loadout is simulated.'),
          F('Favored Enemy', 'Hunter\'s Mark is always prepared and has free uses. Simulated as a free-use bonus-action mark.'),
          F('Weapon Mastery', 'BattleCast applies mastery for the chosen weapon loadout.')],
      2: [F('Fighting Style: Archery', '+2 to ranged attack rolls (baked into attackBonus).'),
          F('Spellcasting', 'Half-caster (WIS). Fixed level-appropriate spell loadout is simulated.')],
      3: [F('Ranger Archetype: Hunter', 'Hunter\'s Prey: Colossus Slayer (+1d8 once/turn vs wounded). Simulated via conditional damage rider.')],
      4: [F('Ability Score Improvement', '+2 DEX (baked in).')],
      5: [F('Extra Attack', 'Attack twice on the Attack action. Favored Enemy uses increase to 3.')],
      6: [F('Roving', '+10 ft Speed, plus Climb and Swim speeds equal to your Speed. Simulated.')],
      7: [F('Defensive Tactics (Hunter)', 'Fixed Hunter option: Escape the Horde. Opportunity attacks against you have Disadvantage. Simulated.')],
      8: [F('Ability Score Improvement', '+1 DEX / +1 WIS (baked in).')],
      9: [F('Expertise', 'Two more skill expertises.')],
      10: [F('Tireless', 'Magic action: gain 1d8+WIS temporary HP, WIS times per Long Rest. Simulated as a defensive self action.')],
      11: [F('Superior Hunter\'s Prey', 'Once per turn, damaging your Hunter\'s Mark target splashes the mark damage to a different enemy within 30 ft. Simulated.')],
      12: [F('Ability Score Improvement', '+2 WIS (baked in).')],
      13: [F('Relentless Hunter', 'Taking damage cannot break Concentration on Hunter\'s Mark. Simulated.')],
      14: [F('Nature\'s Veil', 'Bonus action: become Invisible until the end of your next turn, WIS times per Long Rest. Simulated before attacks when the bonus action is free.')],
      15: [F('Superior Hunter\'s Defense', 'Reaction: gain Resistance to damage just taken and that damage type until the end of the current turn. Simulated.')],
      16: [F('Ability Score Improvement', '+2 WIS (baked in).')],
      17: [F('Precise Hunter', 'You have Advantage on attack rolls against the creature marked by your Hunter\'s Mark. Simulated.')],
      18: [F('Feral Senses', 'Blindsight 30 ft. Simulated in senses/stat line.')],
      19: [F('Epic Boon: Dimensional Travel', 'Fixed loadout takes the recommended boon: +1 WIS. Teleport rider is not modeled because the engine already handles Ranger positioning tactically.')],
      20: [F('Foe Slayer', 'Hunter\'s Mark damage improves from 1d6 to 1d10. Simulated.')],
    },
  },

  Rogue: {
    hitDie: 8, primary: 'dex', secondary: 'con', tertiary: 'wis', saves: ['dex', 'int'],
    skills: ['Stealth', 'Acrobatics', 'Investigation', 'Perception', 'Sleight of Hand', 'Deception'],
    description: 'Finesse striker. Studded leather (AC 12 + DEX) + rapier + shortbow. Sneak Attack scales to 10d6 by L20.',
    armorBase: 12, dexCap: Infinity, shield: false, speed: 30,  // studded leather
    extraAttack: false, finesse: true,
    weapon: { name: 'Rapier', die: '1d8', damageType: 'piercing', kind: 'melee', reach: 5, mastery: 'vex' },
    secondaryWeapon: { name: 'Shortbow', die: '1d6', damageType: 'piercing', kind: 'ranged', range: { normal: 80, long: 320 }, mastery: 'vex' },
    sneakAttack: true,
    features: {
      1: [F('Expertise', 'Double proficiency on Stealth and Sleight of Hand.'),
          F('Sneak Attack', 'Once per turn: bonus damage on finesse/ranged attacks with advantage OR an ally in melee. Simulated with eligibility and once-per-turn gating.'),
          F('Weapon Mastery', 'BattleCast applies mastery for the chosen weapon loadout.'),
          F('Thieves\' Cant', 'Secret rogue language.')],
      2: [F('Cunning Action', 'Bonus action: Dash, Disengage, or Hide. Disengage is simulated (free disengage to avoid OAs).')],
      3: [F('Roguish Archetype: Thief', 'Fast Hands, Second-Story Work.'),
          F('Steady Aim', 'Bonus action: if you do not move this turn, gain Advantage on your next attack. Simulated.'),
          F('Sneak Attack (2d6)', 'Scales up.'),
          F('Second-Story Work (Thief)', 'Gain a Climb Speed equal to your Speed. Simulated.')],
      4: [F('Ability Score Improvement', '+2 DEX (baked in).')],
      5: [F('Uncanny Dodge', 'Reaction: halve damage from one attack per turn. Simulated.'),
          F('Cunning Strike', 'Forgo Sneak Attack dice for tactical effects. Trip and Poison are simulated where legal.'),
          F('Sneak Attack (3d6)', 'Scales up.')],
      6: [F('Expertise', 'Two more skill expertises.')],
      7: [F('Evasion', 'DEX save success = 0 damage, fail = half damage. Simulated.'),
          F('Reliable Talent', 'Proficient skill checks treat d20 rolls of 9 or lower as 10.')],
      8: [F('Ability Score Improvement', 'BattleCast fixed loadout improves DEX/CON for combat.')],
      9: [F('Supreme Sneak (Thief)', 'Stealth Attack cunning strike option. Deferred until Hide/cover tactics are modeled.')],
      10: [F('Ability Score Improvement', 'BattleCast fixed loadout improves CON/WIS for durability and saves.')],
      11: [F('Improved Cunning Strike', 'Use up to TWO cunning strike effects per Sneak Attack. Simulated for Trip plus Obscure/Poison when legal.')],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout improves CON for durability.')],
      13: [F('Use Magic Device (Thief)', 'Magic item attunement and scroll handling. Out-of-scope for current combat engine.')],
      14: [F('Devious Strikes', 'New cunning strike options. Obscure is simulated as Blinded until the end of the next turn; Daze/Knock Out are deferred.')],
      15: [F('Slippery Mind', 'Gain Wisdom and Charisma saving throw proficiency. Simulated.')],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout improves CON/WIS for durability and saves.')],
      17: [F('Thief\'s Reflexes', 'Take a second turn on the first round at Initiative minus 10. Simulated.')],
      18: [F('Elusive', 'No attack roll can have Advantage against you while you are not Incapacitated. Simulated.')],
      19: [F('Epic Boon: Night Spirit', 'Fixed loadout takes the recommended boon: +1 CON. Darkness-dependent benefits are not simulated.')],
      20: [F('Stroke of Luck', 'Once per battle, turn a missed attack roll into a 20. Simulated for attack rolls.')],
    },
  },

  Sorcerer: {
    hitDie: 6, primary: 'cha', secondary: 'dex', saves: ['con', 'cha'],
    skills: ['Arcana', 'Persuasion', 'Insight', 'Intimidation'],
    description: 'Full caster (CHA). Draconic Sorcery from L3, Fire Bolt cantrip, innate/metamagic spell pressure.',
    armorBase: 10, dexCap: Infinity, shield: false, speed: 30,
    extraAttack: false, finesse: false,
    weapon: { name: 'Quarterstaff', die: '1d8', damageType: 'bludgeoning', kind: 'melee', reach: 5, abilityOverride: 'str' },
    cantrip: {
      name: 'Fire Bolt', resolution: 'attack', baseDie: '1d10', damageType: 'fire',
      range: { normal: 120, long: 120 }, spellcastingAbility: 'cha',
      spellSchool: 'evocation',
      description: 'Ranged spell attack (120 ft).',
    },
    features: {
      1: [F('Spellcasting', 'Full caster (CHA). Fixed level-appropriate spell loadout is simulated.'),
          F('Innate Sorcery', 'Bonus action combat boost: spell save DC +1 and Advantage on Sorcerer spell attack rolls. Simulated.')],
      2: [F('Font of Magic', 'Sorcery Points equal Sorcerer level. Slot conversion is not simulated.'),
          F('Metamagic', 'BattleCast default option includes Seeking Spell for missed spell attacks. Simulated.')],
      3: [F('Sorcerer Subclass: Draconic Sorcery', 'Draconic Resilience and Draconic Spells. Simulated where engine-supported.')],
      4: [F('Ability Score Improvement', '+2 CHA (baked in).')],
      5: [F('Sorcerous Restoration', 'Regain Sorcery Points on a Short Rest. Not simulated because BattleCast currently models one battle from a fresh start.')],
      6: [F('Elemental Affinity (Fire)', 'Gain Fire Resistance and add CHA mod to fire spell damage. Simulated.')],
      7: [F('Sorcery Incarnate', 'Spend 2 Sorcery Points to activate Innate Sorcery if no uses remain. Simulated.')],
      8: [F('Ability Score Improvement', 'BattleCast fixed loadout improves CHA/CON.')],
      9: [],
      10: [F('Metamagic Expansion', 'Additional choices are represented by the fixed Seeking Spell combat option.')],
      11: [],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout improves CON/DEX.')],
      13: [],
      14: [F('Dragon Wings', 'Gain a 60 ft Fly Speed for the combat. Simulated as active flight.')],
      15: [],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout improves CON.')],
      17: [F('Metamagic Expansion', 'Additional choices are represented by the fixed Seeking Spell combat option.')],
      18: [F('Dragon Companion', 'Summon Dragon support is deferred until class-feature summons can add creatures mid-battle.')],
      19: [F('Epic Boon: Dimensional Travel', 'Fixed loadout takes the recommended boon: +1 CHA. The post-action teleport rider is not simulated.')],
      20: [F('Arcane Apotheosis', 'While Innate Sorcery is active, one Metamagic option per turn is free. Simulated for Seeking Spell.')],
    },
  },

  Warlock: {
    hitDie: 8, primary: 'cha', secondary: 'dex', saves: ['wis', 'cha'],
    skills: ['Arcana', 'Deception', 'Intimidation', 'Persuasion'],
    description: 'Pact caster. Fiend Patron from L3, studded leather (AC 12 + DEX), Eldritch Blast, Hex, pact slots, and Mystic Arcanum.',
    armorBase: 12, dexCap: Infinity, shield: false, speed: 30,
    extraAttack: false, finesse: false,
    weapon: { name: 'Dagger', die: '1d4', damageType: 'piercing', kind: 'melee', reach: 5, abilityOverride: 'dex' },
    cantrip: {
      name: 'Eldritch Blast', resolution: 'attack', baseDie: '1d10', damageType: 'force',
      range: { normal: 120, long: 120 }, spellcastingAbility: 'cha',
      addAbilityToDamage: true,
      addAbilityToDamageAtLevel: 2,
      description: 'Ranged spell attack (120 ft). Agonizing Blast adds CHA mod to damage from L2.',
    },
    features: {
      1: [F('Pact Magic', 'Short-rest-recharging spell slot. Fixed level-appropriate spell loadout is simulated.'),
          F('Eldritch Invocations', 'BattleCast uses a level-1 legal, neutral invocation baseline and does not apply Agonizing Blast until L2.')],
      2: [F('Eldritch Invocations', 'Agonizing Blast adds CHA modifier to Eldritch Blast damage. Simulated. Other invocations are documented in the audit until their tactical hooks are needed.')],
      3: [F('Warlock Subclass: Fiend Patron', 'Fiend expanded spells join the fixed loadout. Dark One\'s Blessing grants temporary HP when an enemy drops nearby. Simulated.'),
          F('Pact Boon', 'BattleCast default keeps the caster-focused Eldritch Blast chassis; Pact Blade-specific melee scaling is not part of this default build.')],
      4: [F('Ability Score Improvement', '+2 CHA (baked in).'),
          F('Eldritch Invocation', 'Additional invocation.')],
      5: [F('Eldritch Blast (2 beams)', 'Fire two beams, each a separate attack roll. Modeled as a multiattack.')],
      6: [F('Dark One\'s Own Luck', 'Add d10 to a failed check/save. Not yet simulated because save/check timing needs a general elective-bonus hook.')],
      7: [],
      8: [F('Ability Score Improvement', '+2 CHA (baked in).')],
      9: [F('Contact Patron', 'Cast Contact Other Plane free 1/Long Rest to contact patron.')],
      10: [F('Fiendish Resilience', 'Choose one damage resistance after each rest. BattleCast fixes the default choice to Fire resistance for this Fiend loadout. Simulated.')],
      11: [F('Mystic Arcanum (6th)', 'One 6th-level Warlock spell without a Pact Magic slot. Default: Circle of Death. Simulated.')],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for durability.')],
      13: [F('Mystic Arcanum (7th)', 'One 7th-level Warlock spell without a Pact Magic slot. Default: Finger of Death. Simulated without the zombie-creation rider.')],
      14: [F('Hurl Through Hell (Fiend)', 'Once per turn after an attack-roll hit, force a CHA save or deal psychic damage and incapacitate the target briefly. Simulated.')],
      15: [F('Mystic Arcanum (8th)', 'One 8th-level Warlock spell without a Pact Magic slot. Default: Befuddlement. Simulated.')],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout improves CON/DEX.')],
      17: [F('Mystic Arcanum (9th)', 'One 9th-level Warlock spell without a Pact Magic slot. Default: Power Word Kill. Simulated.')],
      18: [F('Eldritch Invocations', 'Invocation count increases to 10. BattleCast keeps the default caster invocation package focused on Agonizing Blast.')],
      19: [F('Epic Boon: Fate', 'Fixed loadout takes the recommended boon: +1 CHA. Improve Fate reaction is not yet simulated.')],
      20: [F('Eldritch Master', 'Magical Cunning now restores all Pact Magic slots. This is documented but rarely relevant because BattleCast starts one fresh encounter with full slots.')],
    },
  },

  Wizard: {
    hitDie: 6, primary: 'int', secondary: 'dex', saves: ['int', 'wis'],
    skills: ['Arcana', 'Investigation', 'History', 'Insight'],
    description: 'Full caster (INT). Evoker Wizard with Fire Bolt, broad area control, and high-level arcane spell pressure.',
    armorBase: 10, dexCap: Infinity, shield: false, speed: 30,
    extraAttack: false, finesse: false,
    weapon: { name: 'Quarterstaff', die: '1d8', damageType: 'bludgeoning', kind: 'melee', reach: 5, abilityOverride: 'str' },
    cantrip: {
      name: 'Fire Bolt', resolution: 'attack', baseDie: '1d10', damageType: 'fire',
      range: { normal: 120, long: 120 }, spellcastingAbility: 'int',
      spellSchool: 'evocation',
      description: 'Ranged spell attack (120 ft).',
    },
    features: {
      1: [F('Spellcasting', 'Full caster (INT). Fixed level-appropriate spell loadout is simulated.'),
          F('Ritual Adept', 'Ritual spellcasting from the spellbook is documented but not usually relevant to tactical combat.'),
          F('Arcane Recovery', 'Recover slots on short rest. Out-of-combat for the one-encounter simulator.')],
      2: [F('Scholar', 'Expertise in an Intelligence skill. Out-of-combat.')],
      3: [F('Wizard Subclass: Evoker', 'Evocation Savant and Potent Cantrip are represented in the default Evoker loadout.'),
          F('Potent Cantrip (Evoker)', 'Damaging cantrip attack misses still deal half cantrip damage. Simulated.')],
      4: [F('Ability Score Improvement', '+2 INT (baked in).')],
      5: [F('Memorize Spell', 'Can swap one prepared Wizard spell on a short rest. BattleCast uses a fixed combat preparation.')],
      6: [F('Sculpt Spells (Evoker)', 'Evocation AoEs avoid allies chosen by the Wizard. Simulated through enemy-only targeting and no-friendly-fire planning.')],
      7: [],
      8: [F('Ability Score Improvement', '+2 INT (baked in).')],
      9: [],
      10: [F('Empowered Evocation (Evoker)', 'Add INT mod to one damage roll of Evocation spells. Simulated.')],
      11: [F('Sixth-level Spells', 'Default spellbook adds Chain Lightning, Circle of Death, and Disintegrate. Simulated.')],
      12: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON/DEX for durability.')],
      13: [F('Seventh-level Spells', 'Default spellbook adds Finger of Death. Simulated without the zombie-creation rider.')],
      14: [F('Overchannel (Evoker)', 'The first level 1-5 Wizard damage spell deals maximum damage. Simulated once per battle without modeling harmful repeat uses.')],
      15: [F('Eighth-level Spells', 'Default spellbook adds Befuddlement and Sunburst. Simulated.')],
      16: [F('Ability Score Improvement', 'BattleCast fixed loadout increases CON for durability.')],
      17: [F('Ninth-level Spells', 'Default spellbook adds Power Word Kill. Simulated with the 100 HP threshold and fallback damage.')],
      18: [F('Spell Mastery', 'Magic Missile and Scorching Ray are always prepared and can be cast at their lowest level without spending slots. Simulated.')],
      19: [F('Epic Boon: Spell Recall', 'Fixed loadout takes the recommended boon: +1 INT and level 1-4 spell slots can be preserved on a matching d4. Simulated.')],
      20: [F('Signature Spells', 'Fireball and Lightning Bolt are always prepared; each has one free level-3 cast. Simulated.')],
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

/** Proficiency bonus progression (SRD 5.2). L1-4: +2, L5-8: +3  - L1-6 range: L1-4 = +2, L5-6 = +3. */
function proficiencyBonus(level: number): number {
  if (level >= 17) return 6;
  if (level >= 13) return 5;
  if (level >= 9) return 4;
  if (level >= 5) return 3;
  return 2;
}

function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

function averagePerLevel(hitDie: number): number {
  // Average of a die rounded up to favor the martial conventions (d8 → 5, d10 → 6, d12 → 7, d6 → 4)
  return Math.floor(hitDie / 2) + 1;
}

function abilityArray(primary: AbilityKey, secondary: AbilityKey, level: number, tertiary?: AbilityKey): Abilities {
  // 2024 legal standard-array chassis:
  //   standard array 15, 14, 13, 12, 10, 8
  //   background boosts +2 primary and +1 CON/secondary
  // Result at L1: primary 17, secondary 14, CON 14, then 12/10/8.
  // ASI at L4 bumps primary 17 -> 19.
  //
  // Allocation:
  //   primary    -> 17 (or 19 at L4+)
  //   secondary  -> 14
  //   con        -> 14 (durability is universal; default tertiary)
  //                  but if the spec lists CON as secondary, the
  //                  spec's `tertiary` field plays the third-14 role
  //                  (e.g. DEX for Fighter, WIS for Rogue)
  //   dump       -> 8 (CHA, unless CHA is primary/secondary, then STR
  //                  unless STR is also taken, then INT)
  //   best filler -> 12
  //   rest        -> 10
  const out: Abilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  out[primary] = level >= 4 ? 19 : 17;
  if (secondary !== primary) out[secondary] = 14;

  // Third 14: CON by default, or the spec's tertiary if secondary
  // already claims CON.
  if (primary !== 'con' && secondary !== 'con') {
    out.con = 14;
  } else if (secondary === 'con' && tertiary && tertiary !== primary && tertiary !== secondary) {
    out[tertiary] = 14;
  } else if (primary === 'con' && tertiary && tertiary !== primary && tertiary !== secondary) {
    // Edge case: CON-primary class (none in current SRD, but defensive).
    out[tertiary] = 14;
  }

  // Pick the dump stat (8). CHA first, then STR, then INT - whichever
  // is currently sitting at the filler-10 mark.
  for (const dump of ['cha', 'str', 'int'] as AbilityKey[]) {
    if (out[dump] === 10) {
      out[dump] = 8;
      break;
    }
  }

  // Preserve the remaining 12 from the standard array in a low-impact,
  // class-sensible place. It rarely changes level-1 combat, but keeps
  // the stat block legal rather than "balanced but fictional".
  const fillerPriority: AbilityKey[] = ['dex', 'wis', 'con', 'int', 'cha', 'str'];
  for (const ability of fillerPriority) {
    if (out[ability] === 10) {
      out[ability] = 12;
      break;
    }
  }

  return out;
}

function applyClassAbilityProgression(
  className: HeroClassName,
  spec: ClassSpec,
  level: number,
  abilities: Abilities,
): void {
  if (className === 'Barbarian') {
    // Fixed legal combat loadout for the level-20 Barbarian audit:
    // L4 +2 STR, L8 +1 STR/+1 CON, L12 +1 CON/+1 DEX,
    // L16 +2 CON, L19 Boon of Irresistible Offense +1 STR,
    // L20 Primal Champion +4 STR/+4 CON to max 25.
    if (level >= 8) {
      abilities.str = Math.min(20, abilities.str + 1);
      abilities.con = Math.min(20, abilities.con + 1);
    }
    if (level >= 12) {
      abilities.con = Math.min(20, abilities.con + 1);
      abilities.dex = Math.min(20, abilities.dex + 1);
    }
    if (level >= 16) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 19) {
      abilities.str = Math.min(30, abilities.str + 1);
    }
    if (level >= 20) {
      abilities.str = Math.min(25, abilities.str + 4);
      abilities.con = Math.min(25, abilities.con + 4);
    }
    return;
  }

  if (className === 'Bard') {
    // Fixed legal combat loadout for the level-20 Bard audit:
    // L4 +2 CHA, L8 +1 CHA/+1 DEX, L12 +2 DEX,
    // L16 +2 CON, L19 Boon of Spell Recall +1 CHA (max 30).
    if (level >= 8) {
      abilities[spec.primary] = Math.min(20, abilities[spec.primary] + 1);
      abilities.dex = Math.min(20, abilities.dex + 1);
    }
    if (level >= 12) {
      abilities.dex = Math.min(20, abilities.dex + 2);
    }
    if (level >= 16) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 19) {
      abilities.cha = Math.min(30, abilities.cha + 1);
    }
    return;
  }

  if (className === 'Cleric') {
    // Fixed legal combat loadout for the level-20 Life Cleric audit:
    // L4 +2 WIS, L8 +1 WIS/+1 CON, L12 +2 CON,
    // L16 +2 CON, L19 Boon of Fate +1 WIS (max 30).
    if (level >= 8) {
      abilities.wis = Math.min(20, abilities.wis + 1);
      abilities.con = Math.min(20, abilities.con + 1);
    }
    if (level >= 12) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 16) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 19) {
      abilities.wis = Math.min(30, abilities.wis + 1);
    }
    return;
  }

  if (className === 'Druid') {
    // Fixed legal combat loadout for the level-20 Land Druid audit:
    // L4 +2 WIS, L8 +1 WIS/+1 CON, L12 +2 CON,
    // L16 +2 CON, L19 Boon of Dimensional Travel +1 WIS (max 30).
    if (level >= 8) {
      abilities.wis = Math.min(20, abilities.wis + 1);
      abilities.con = Math.min(20, abilities.con + 1);
    }
    if (level >= 12) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 16) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 19) {
      abilities.wis = Math.min(30, abilities.wis + 1);
    }
    return;
  }

  if (className === 'Fighter') {
    // Fixed legal combat loadout for the level-20 Champion Fighter audit:
    // L4 +2 STR, L6 +1 STR/+1 CON, L8 +1 CON/+1 DEX,
    // L12 +2 CON, L14 +2 CON, L16 +2 DEX,
    // L19 Boon of Combat Prowess +1 STR (max 30).
    if (level >= 6) {
      abilities.str = Math.min(20, abilities.str + 1);
      abilities.con = Math.min(20, abilities.con + 1);
    }
    if (level >= 8) {
      abilities.con = Math.min(20, abilities.con + 1);
      abilities.dex = Math.min(20, abilities.dex + 1);
    }
    if (level >= 12) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 14) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 16) {
      abilities.dex = Math.min(20, abilities.dex + 2);
    }
    if (level >= 19) {
      abilities.str = Math.min(30, abilities.str + 1);
    }
    return;
  }

  if (className === 'Monk') {
    // Fixed legal combat loadout for the level-20 Open Hand Monk audit:
    // L4 +2 DEX, L8 +1 DEX/+1 WIS, L12 +1 WIS/+1 CON,
    // L16 +2 WIS, L19 Boon of Irresistible Offense +1 DEX,
    // L20 Body and Mind +4 DEX/+4 WIS to max 25.
    if (level >= 8) {
      abilities.dex = Math.min(20, abilities.dex + 1);
      abilities.wis = Math.min(20, abilities.wis + 1);
    }
    if (level >= 12) {
      abilities.wis = Math.min(20, abilities.wis + 1);
      abilities.con = Math.min(20, abilities.con + 1);
    }
    if (level >= 16) {
      abilities.wis = Math.min(20, abilities.wis + 2);
    }
    if (level >= 19) {
      abilities.dex = Math.min(30, abilities.dex + 1);
    }
    if (level >= 20) {
      abilities.dex = Math.min(25, abilities.dex + 4);
      abilities.wis = Math.min(25, abilities.wis + 4);
    }
    return;
  }

  if (className === 'Paladin') {
    // Fixed legal combat loadout for the level-20 Devotion Paladin audit:
    // L4 +2 STR, L8 +1 STR/+1 CHA, L12 +2 CHA,
    // L16 +2 CHA, L19 Boon of Truesight +1 CHA (max 30).
    if (level >= 8) {
      abilities.str = Math.min(20, abilities.str + 1);
      abilities.cha = Math.min(20, abilities.cha + 1);
    }
    if (level >= 12) {
      abilities.cha = Math.min(20, abilities.cha + 2);
    }
    if (level >= 16) {
      abilities.cha = Math.min(20, abilities.cha + 2);
    }
    if (level >= 19) {
      abilities.cha = Math.min(30, abilities.cha + 1);
    }
    return;
  }

  if (className === 'Ranger') {
    // Fixed legal combat loadout for the level-20 Hunter Ranger audit:
    // L4 +2 DEX, L8 +1 DEX/+1 WIS, L12 +2 WIS,
    // L16 +2 WIS, L19 Boon of Dimensional Travel +1 WIS.
    if (level >= 8) {
      abilities.dex = Math.min(20, abilities.dex + 1);
      abilities.wis = Math.min(20, abilities.wis + 1);
    }
    if (level >= 12) {
      abilities.wis = Math.min(20, abilities.wis + 2);
    }
    if (level >= 16) {
      abilities.wis = Math.min(20, abilities.wis + 2);
    }
    if (level >= 19) {
      abilities.wis = Math.min(30, abilities.wis + 1);
    }
    return;
  }

  if (className === 'Rogue') {
    // Fixed legal combat loadout for the level-20 Thief Rogue audit:
    // L4 +2 DEX, L8 +1 DEX/+1 CON, L10 +1 CON/+1 WIS,
    // L12 +2 CON, L16 +1 CON/+1 WIS, L19 Boon of Night Spirit +1 CON.
    if (level >= 8) {
      abilities.dex = Math.min(20, abilities.dex + 1);
      abilities.con = Math.min(20, abilities.con + 1);
    }
    if (level >= 10) {
      abilities.con = Math.min(20, abilities.con + 1);
      abilities.wis = Math.min(20, abilities.wis + 1);
    }
    if (level >= 12) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 16) {
      abilities.con = Math.min(20, abilities.con + 1);
      abilities.wis = Math.min(20, abilities.wis + 1);
    }
    if (level >= 19) {
      abilities.con = Math.min(30, abilities.con + 1);
    }
    return;
  }

  if (className === 'Sorcerer') {
    // Fixed legal combat loadout for the level-20 Draconic Sorcerer audit:
    // L4 +2 CHA, L8 +1 CHA/+1 CON, L12 +1 CON/+1 DEX,
    // L16 +2 CON, L19 Boon of Dimensional Travel +1 CHA.
    if (level >= 8) {
      abilities.cha = Math.min(20, abilities.cha + 1);
      abilities.con = Math.min(20, abilities.con + 1);
    }
    if (level >= 12) {
      abilities.con = Math.min(20, abilities.con + 1);
      abilities.dex = Math.min(20, abilities.dex + 1);
    }
    if (level >= 16) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 19) {
      abilities.cha = Math.min(30, abilities.cha + 1);
    }
    return;
  }

  if (className === 'Warlock') {
    // Fixed legal combat loadout for the level-20 Fiend Warlock audit:
    // L4 +2 CHA, L8 +1 CHA/+1 CON, L12 +2 CON,
    // L16 +1 CON/+1 DEX, L19 Boon of Fate +1 CHA.
    if (level >= 8) {
      abilities.cha = Math.min(20, abilities.cha + 1);
      abilities.con = Math.min(20, abilities.con + 1);
    }
    if (level >= 12) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 16) {
      abilities.con = Math.min(20, abilities.con + 1);
      abilities.dex = Math.min(20, abilities.dex + 1);
    }
    if (level >= 19) {
      abilities.cha = Math.min(30, abilities.cha + 1);
    }
    return;
  }

  if (className === 'Wizard') {
    // Fixed legal combat loadout for the level-20 Evoker Wizard audit:
    // L4 +2 INT, L8 +1 INT/+1 CON, L12 +1 CON/+1 DEX,
    // L16 +2 CON, L19 Boon of Spell Recall +1 INT.
    if (level >= 8) {
      abilities.int = Math.min(20, abilities.int + 1);
      abilities.con = Math.min(20, abilities.con + 1);
    }
    if (level >= 12) {
      abilities.con = Math.min(20, abilities.con + 1);
      abilities.dex = Math.min(20, abilities.dex + 1);
    }
    if (level >= 16) {
      abilities.con = Math.min(20, abilities.con + 2);
    }
    if (level >= 19) {
      abilities.int = Math.min(30, abilities.int + 1);
    }
    return;
  }

  if (level >= 8) {
    abilities[spec.primary] = Math.min(20, abilities[spec.primary] + 2);
  }
}

function computeAC(spec: ClassSpec, dexMod: number, wisMod: number, conMod: number, armorOverride?: number): number {
  if (spec.armorBase === 0) {
    const unarmoredMod = spec.saves.includes('con') ? conMod : wisMod;
    return 10 + dexMod + unarmoredMod + (spec.shield ? 2 : 0);
  }
  const armorBase = armorOverride ?? spec.armorBase;
  const dexBonus = Math.min(dexMod, armorOverride ? 0 : spec.dexCap);
  return armorBase + dexBonus + (spec.shield ? 2 : 0);
}

function computeHP(hitDie: number, conMod: number, level: number): number {
  return hitDie + conMod + (level - 1) * (averagePerLevel(hitDie) + conMod);
}

function hasWeaponMastery(className: HeroClassName, level: number): boolean {
  return level >= 1 && (
    className === 'Barbarian' ||
    className === 'Fighter' ||
    className === 'Paladin' ||
    className === 'Ranger' ||
    className === 'Rogue'
  );
}

function hasDefenseStyle(className: HeroClassName, level: number): boolean {
  return className === 'Fighter' || (className === 'Paladin' && level >= 2);
}

// 2024 Monk martial arts die progression starts at d6.
function monkUnarmedDie(level: number): string {
  if (level >= 17) return '1d12';
  if (level >= 11) return '1d10';
  if (level >= 5) return '1d8';
  return '1d6';
}

function monkUnarmoredMovementBonus(level: number): number {
  if (level >= 18) return 30;
  if (level >= 14) return 25;
  if (level >= 10) return 20;
  if (level >= 6) return 15;
  if (level >= 2) return 10;
  return 0;
}

function cantripDice(level: number, baseDie: string): string {
  // Scales at 5, 11, 17. For our L1-6 range: 1 die before L5, 2 dice at L5+.
  // baseDie like "1d10" → at L5+ → "2d10".
  const m = /^1d(\d+)$/.exec(baseDie);
  if (!m) return baseDie;
  const sides = m[1];
  if (level >= 17) return `4d${sides}`;
  if (level >= 11) return `3d${sides}`;
  if (level >= 5) return `2d${sides}`;
  return `1d${sides}`;
}

function extraAttackCount(className: HeroClassName, level: number): number {
  if (className === 'Fighter') {
    if (level >= 20) return 4;
    if (level >= 11) return 3;
  }
  return 2;
}

function eldritchBlastBeamCount(level: number): number {
  if (level >= 17) return 4;
  if (level >= 11) return 3;
  if (level >= 5) return 2;
  return 1;
}

function countWord(count: number): string {
  return count === 4 ? 'four' : count === 3 ? 'three' : 'two';
}

function sneakAttackDice(level: number): string {
  // SRD progression: 1d6 + 1d6 per odd level, up to 10d6 at L19+.
  return `${Math.ceil(level / 2)}d6`;
}

function formatBonus(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function hasLoadingProperty(name: string): boolean {
  return /\bcrossbow\b/i.test(name);
}

function makeWeaponAction(
  spec: ClassSpec, weaponSpec: WeaponSpec, level: number, abilities: Abilities, pb: number, masteryActive = false,
): MonsterAction {
  const useDex = weaponSpec.finesse
    ? abilities.dex >= abilities.str
    : spec.finesse && weaponSpec.kind === 'melee'
    ? true
    : weaponSpec.kind === 'ranged'
      ? true
      : false;
  const ability = weaponSpec.abilityOverride ?? (useDex ? 'dex' : spec.primary);
  const abilMod = abilityMod(abilities[ability]);
  let attackBonus = pb + abilMod;
  // Ranger L2+ Archery Fighting Style: +2 to ranged attack rolls
  if (spec === CLASSES.Ranger && weaponSpec.kind === 'ranged' && level >= 2) {
    attackBonus += 2;
  }
  attackBonus = weaponSpec.attackBonusOverride ?? attackBonus;
  const damage = weaponSpec.damageOverride ?? `${weaponSpec.die}${abilMod !== 0 ? formatBonus(abilMod) : ''}`;
  const action: MonsterAction = {
    name: weaponSpec.name,
    type: weaponSpec.kind === 'melee' ? 'melee' : 'ranged',
    attackBonus,
    damage,
    damageType: weaponSpec.damageType,
    attackAbility: ability,
    description: `${weaponSpec.kind === 'melee' ? 'Melee' : 'Ranged'} Attack Roll: ${formatBonus(attackBonus)}, ${weaponSpec.kind === 'melee' ? `reach ${weaponSpec.reach ?? 5} ft.` : `range ${weaponSpec.range?.normal ?? 30}/${weaponSpec.range?.long ?? 30} ft.`} ${damage} ${weaponSpec.damageType} damage.`,
  };
  if (weaponSpec.loading ?? hasLoadingProperty(weaponSpec.name)) {
    action.loading = true;
  }
  if (weaponSpec.heavy) action.heavy = true;
  if (weaponSpec.closeRangeDisadvantage) action.closeRangeDisadvantage = true;
  if (weaponSpec.kind === 'melee') {
    action.reach = weaponSpec.reach ?? 5;
  } else {
    action.range = weaponSpec.range ?? { normal: 30, long: 30 };
  }
  if (masteryActive && weaponSpec.mastery) {
    action.weaponMastery = weaponSpec.mastery;
    action.masteryAbilityMod = abilMod;
    action.masteryBaseDamage = weaponSpec.die;
    action.description += ` Weapon Mastery: ${weaponSpec.mastery[0].toUpperCase()}${weaponSpec.mastery.slice(1)}.`;
  }
  if (spec.sneakAttack && (weaponSpec.kind === 'ranged' || spec.finesse)) {
    action.additionalDamage = `${sneakAttackDice(level)} ${weaponSpec.damageType}`;
  }
  if (spec === CLASSES.Paladin && level >= 11 && weaponSpec.kind === 'melee') {
    action.additionalDamage = '1d8 radiant';
    action.description += ' Radiant Strikes: +1d8 radiant damage on melee weapon hits.';
  }
  if (spec === CLASSES.Monk && level >= 6 && weaponSpec.name === 'Martial Arts (Unarmed)') {
    action.magical = true;
  }
  // Blessed Strikes (Cleric L7+): +1d8 radiant on weapon hits
  if (spec === CLASSES.Cleric && level >= 7) {
    action.additionalDamage = level >= 14 ? '2d8 radiant' : '1d8 radiant';
  }
  return action;
}

function makeCantripAction(
  cantrip: CantripSpec, level: number, abilities: Abilities, pb: number,
): MonsterAction {
  const dice = cantripDice(level, cantrip.baseDie);
  const spellMod = abilityMod(abilities[cantrip.spellcastingAbility]);
  if (cantrip.resolution === 'attack') {
    const attackBonus = pb + spellMod;
    const addAbility = cantrip.addAbilityToDamage && level >= (cantrip.addAbilityToDamageAtLevel ?? 1);
    const damageStr = addAbility && spellMod !== 0
      ? `${dice}${formatBonus(spellMod)}`
      : dice;
    return {
      name: cantrip.name,
      type: 'ranged',
      attackBonus,
      damage: damageStr,
      damageType: cantrip.damageType,
      range: cantrip.range ?? { normal: 60, long: 60 },
      description: `Ranged spell attack: ${formatBonus(attackBonus)}, range ${cantrip.range?.normal ?? 60} ft. ${damageStr} ${cantrip.damageType} damage. ${cantrip.description}`,
      spellLevel: 0,
      spellSchool: cantrip.spellSchool,
      castingAbility: cantrip.spellcastingAbility,
    };
  }
  // save-based cantrip (Sacred Flame, Vicious Mockery)
  const dc = 8 + pb + spellMod;
  return {
    name: cantrip.name,
    type: 'special',
    description: `${cantrip.saveAbility!.toUpperCase()} Saving Throw: DC ${dc}, one creature within ${cantrip.range?.normal ?? 60} ft. Failure: ${dice} ${cantrip.damageType} damage${cantrip.damageOnSuccess === 'half' ? '. Success: Half damage.' : '.'}`,
    savingThrow: {
      ability: cantrip.saveAbility!,
      dc,
      damageOnFail: dice,
      ...(cantrip.damageOnSuccess === 'half' ? { damageOnSuccess: 'half' } : {}),
    },
    buffOnFailedSave: cantrip.buffOnFailedSave,
    spellLevel: 0,
    spellSchool: cantrip.spellSchool,
    castingAbility: cantrip.spellcastingAbility,
    targetScope: 'one_enemy',
  };
}

const SKILL_ABILITIES: Record<string, AbilityKey> = {
  Acrobatics: 'dex', 'Animal Handling': 'wis', Arcana: 'int', Athletics: 'str',
  Deception: 'cha', History: 'int', Insight: 'wis', Intimidation: 'cha',
  Investigation: 'int', Medicine: 'wis', Nature: 'int', Perception: 'wis',
  Performance: 'cha', Persuasion: 'cha', Religion: 'int',
  'Sleight of Hand': 'dex', Stealth: 'dex', Survival: 'wis',
};

function skillsForClass(spec: ClassSpec, abilities: Abilities, pb: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of spec.skills) {
    const abil = SKILL_ABILITIES[s] ?? spec.primary;
    out[s] = pb + abilityMod(abilities[abil]);
  }
  return out;
}

/**
 * Assemble a MonsterData for a class at a given level. Cached by key so
 * repeated `buildHero('Fighter', 3)` calls return the same object  - keeps
 * React referential equality sensible when the picker renders.
 */
const buildCache = new Map<string, MonsterData>();

function defaultSubclass(className: HeroClassName, level: number): string | undefined {
  if (className === 'Cleric' && level >= 3) return 'Life Domain';
  if (className === 'Druid' && level >= 3) return 'Circle of the Land';
  if (className === 'Fighter' && level >= 3) return 'Champion';
  if (className === 'Monk' && level >= 3) return 'Warrior of the Open Hand';
  if (className === 'Paladin' && level >= 3) return 'Oath of Devotion';
  if (className === 'Ranger' && level >= 3) return 'Hunter';
  if (className === 'Rogue' && level >= 3) return 'Thief';
  if (className === 'Sorcerer' && level >= 3) return 'Draconic Sorcery';
  if (className === 'Warlock' && level >= 3) return 'Fiend Patron';
  if (className === 'Wizard' && level >= 3) return 'Evoker';
  return undefined;
}

export function buildHero(className: HeroClassName, level: number, options: BuildHeroOptions = {}): MonsterData {
  const heroSubclass = options.subclass ?? defaultSubclass(className, level);
  const cacheKey = `${className}-${level}-${heroSubclass ?? 'base'}-${options.preferredWildShapeBeast ?? 'auto'}`;
  const cached = buildCache.get(cacheKey);
  if (cached) return cached;

  const spec = CLASSES[className];
  if (!spec) throw new Error(`Unknown class: ${className}`);
  if (!isSupportedHeroLevel(className, level)) {
    throw new Error(`Level ${level} out of supported range [${MIN_HERO_LEVEL}, ${getMaxHeroLevelForClass(className)}] for ${className}`);
  }

  const abilities = abilityArray(spec.primary, spec.secondary, level, spec.tertiary);
  applyClassAbilityProgression(className, spec, level, abilities);
  const pb = proficiencyBonus(level);
  const conMod = abilityMod(abilities.con);
  const dexMod = abilityMod(abilities.dex);
  const wisMod = abilityMod(abilities.wis);

  let hp = computeHP(spec.hitDie, conMod, level);
  if (className === 'Sorcerer' && level >= 3) hp += level;
  // Heavy armor classes upgrade to Plate (AC 18) at L5+
  const armorOverride = (className === 'Fighter' || className === 'Paladin' || className === 'Cleric') && level >= 5 ? 18 : undefined;
  let ac = computeAC(spec, dexMod, wisMod, conMod, armorOverride);
  if (className === 'Sorcerer' && level >= 3) ac = 10 + dexMod + abilityMod(abilities.cha);
  if (hasDefenseStyle(className, level)) ac += 1;
  // Monk L5+: +1 AC representing improved defensive training
  if (className === 'Monk' && level >= 5) ac += 1;

  // Monk: scale unarmed die
  const primaryWeapon: WeaponSpec = className === 'Monk'
    ? { ...spec.weapon, die: monkUnarmedDie(level) }
    : spec.weapon;
  // Monk: scaling Unarmored Movement bonus from the SRD class table.
  const speed: Speed = { walk: spec.speed + (className === 'Monk' ? monkUnarmoredMovementBonus(level) : 0) };
  // Barbarian: +10 ft at L5+
  if (className === 'Barbarian' && level >= 5) speed.walk += 10;
  if (className === 'Ranger' && level >= 6) {
    speed.walk += 10;
    speed.climb = speed.walk;
    speed.swim = speed.walk;
  }
  if (className === 'Rogue' && level >= 3) {
    speed.climb = speed.walk;
  }
  if (className === 'Sorcerer' && level >= 14) {
    speed.fly = 60;
  }

  const actions: MonsterAction[] = [];
  const masteryActive = hasWeaponMastery(className, level);
  const mainAtk = makeWeaponAction(spec, primaryWeapon, level, abilities, pb, masteryActive);
  actions.push(mainAtk);
  if (spec.secondaryWeapon) {
    actions.push(makeWeaponAction(spec, spec.secondaryWeapon, level, abilities, pb, masteryActive));
  }
  if (spec.cantrip) {
    actions.push(makeCantripAction(spec.cantrip, level, abilities, pb));
  }

  // Extra Attack (L5 martial)
  if (spec.extraAttack && level >= 5) {
    const attackCount = extraAttackCount(className, level);
    actions.unshift({
      name: 'Multiattack',
      type: 'multiattack',
      description: `The ${className.toLowerCase()} makes ${countWord(attackCount)} ${primaryWeapon.name} attacks.`,
    });
  }
  // Warlock L5+: Eldritch Blast gains extra beams; model as a cantrip multiattack.
  if (className === 'Warlock' && level >= 5) {
    const beamCount = eldritchBlastBeamCount(level);
    actions.unshift({
      name: 'Multiattack',
      type: 'multiattack',
      description: `The warlock makes ${countWord(beamCount)} Eldritch Blast attacks.`,
    });
  }

  // Leveled spells + slot resources, if this class casts. The spells-for-
  // level lookup picks the subset of the class's repertoire available at
  // the given character level (gated by the highest slot level they have).
  const spellActions = buildClassSpells(className, level, abilities, pb);
  actions.push(...spellActions);
  applyWizardSpellMastery(className, level, actions, 'int', abilityMod(abilities.int), pb);
  // Non-spell class abilities (Rage, Second Wind, Lay on Hands, ...).
  const abilityActions = buildClassAbilities(className, level, abilities, pb);
  actions.push(...abilityActions);
  const initialResources = buildClassResources(className, level);

  // Paladin Divine Smite: at L2+, the main weapon gains the smiteOnHit hook.
  // Engine burns the lowest slot on a hit and adds dice proportional to slot
  // level (2d8 at L1 → 5d8 at L4; capped at L6's 5d8 for our range).
  if (className === 'Paladin' && level >= 2) {
    const primary = actions.find(a =>
      (a.type === 'melee' || a.type === 'ranged') && a.name === spec.weapon.name
    );
    if (primary) {
      primary.smiteOnHit = {
        damageType: 'radiant',
        dicePerSlotLevel: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        die: 8,
      };
      primary.description += ` Divine Smite: on hit, burn a spell slot for bonus radiant damage (2d8 at L1, 3d8 at L2, ...).`;
    }
  }

  // Feature list as traits (all relevant levels up to `level`)
  const traits: MonsterTrait[] = [];
  for (let l = 1; l <= level; l++) {
    for (const f of spec.features[l] ?? []) {
      traits.push({ name: `L${l} - ${f.name}`, description: f.description });
    }
  }

  const saveAbilities: AbilityKey[] = className === 'Monk' && level >= 14
    ? ['str', 'dex', 'con', 'int', 'wis', 'cha']
    : className === 'Rogue' && level >= 15
      ? ['dex', 'int', 'wis', 'cha']
      : [...spec.saves];
  const saves: Partial<Record<AbilityKey, number>> = {};
  for (const s of saveAbilities) {
    saves[s] = pb + abilityMod(abilities[s]);
  }

  const name = `${className} L${level}`;
  const resistances = [
    ...(className === 'Druid' && level >= 10 ? ['cold'] : []),
    ...(className === 'Sorcerer' && level >= 6 ? ['fire'] : []),
    ...(className === 'Warlock' && level >= 10 ? ['fire'] : []),
  ];
  const conditionImmunities = className === 'Druid' && level >= 10 ? ['poisoned'] : undefined;
  const skills = skillsForClass(spec, abilities, pb);
  const passivePerception = 10 + (skills.Perception ?? abilityMod(abilities.wis));
  const senses = className === 'Paladin' && level >= 19
    ? `Truesight 60 ft., Passive Perception ${passivePerception}`
    : className === 'Ranger' && level >= 18
      ? `Blindsight 30 ft., Passive Perception ${passivePerception}`
      : `Passive Perception ${passivePerception}`;
  const data: MonsterData = {
    name,
    size: 'Medium',
    type: 'Humanoid (Hero)',
    alignment: 'Any Alignment',
    ac,
    hp,
    hpFormula: `${level}d${spec.hitDie}${conMod !== 0 ? formatBonus(conMod * level) : ''}`,
    speed,
    abilities,
    saves,
    skills,
    resistances: resistances.length ? resistances : undefined,
    conditionImmunities,
    senses,
    languages: 'Common',
    cr: '-',
    xp: 0,
    proficiencyBonus: pb,
    traits: traits.length ? traits : undefined,
    actions,
    isHero: true,
    heroClass: className,
    heroLevel: level,
    heroSubclass,
    preferredWildShapeBeast: options.preferredWildShapeBeast,
    initialResources: Object.keys(initialResources).length ? initialResources : undefined,
  };

  buildCache.set(cacheKey, data);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Class spell lists + slot tables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Highest spell level available for a full caster at character level.
 * Matches the SRD progression: L1-2 → 1st, L3-4 → 2nd, L5-6 → 3rd.
 */
function fullCasterMaxSlot(level: number): number {
  if (level >= 17) return 9;
  if (level >= 15) return 8;
  if (level >= 13) return 7;
  if (level >= 11) return 6;
  if (level >= 9) return 5;
  if (level >= 7) return 4;
  if (level >= 5) return 3;
  if (level >= 3) return 2;
  if (level >= 1) return 1;
  return 0;
}

/** 2024 half-casters (Paladin, Ranger) start spellcasting at L1. */
function halfCasterMaxSlot(level: number): number {
  if (level >= 17) return 5;
  if (level >= 13) return 4;
  if (level >= 9) return 3;
  if (level >= 5) return 2;
  if (level >= 1) return 1;
  return 0;
}

/** Warlock slot level is always the highest they have. */
function warlockSlotLevel(level: number): number {
  if (level >= 9) return 5;
  if (level >= 7) return 4;
  if (level >= 5) return 3;
  if (level >= 3) return 2;
  return 1;
}

function warlockMaxPreparedSpellLevel(level: number): number {
  if (level >= 17) return 9;
  if (level >= 15) return 8;
  if (level >= 13) return 7;
  if (level >= 11) return 6;
  return warlockSlotLevel(level);
}

function asMysticArcanum(action: MonsterAction, resourceKey: string): MonsterAction {
  return {
    ...action,
    description: `Mystic Arcanum: ${action.description}`,
    resourceCost: { key: resourceKey, amount: 1 },
  };
}

function asWizardSpellMastery(action: MonsterAction): MonsterAction {
  return {
    ...action,
    atWill: true,
    description: `Spell Mastery: ${action.description} Cast at its lowest level without expending a spell slot.`,
  };
}

function applyWizardSpellMastery(
  className: HeroClassName,
  level: number,
  actions: MonsterAction[],
  spellAbility: AbilityKey,
  mod: number,
  pb: number,
): void {
  if (className !== 'Wizard' || level < 18) return;
  const masteredSpells = [
    asWizardSpellMastery(magicMissile()),
    asWizardSpellMastery(scorchingRay(spellAbility, mod, pb)),
  ];
  for (const mastered of masteredSpells) {
    const existing = actions.find(action => action.name === mastered.name);
    if (existing) {
      existing.atWill = true;
      existing.description = mastered.description;
    } else {
      actions.push(mastered);
    }
  }
}

/**
 * Pick the list of leveled spells the class knows. Each returns a full
 * MonsterAction. The `buildHero` caller filters by character level.
 */
function buildClassSpells(
  className: HeroClassName, level: number, abilities: Abilities, pb: number,
): MonsterAction[] {
  const spec = CLASSES[className];
  if (!spec.cantrip && !['Barbarian', 'Fighter', 'Monk', 'Rogue'].includes(className)) {
    // fall through - classes without cantrip defs here are martial/no-caster
  }
  const actions: MonsterAction[] = [];

  // Which character classes have spells? (not Barbarian, Fighter, Rogue.
  // Monk has ki and a few cantrips but no "spells" in SRD L1-6 base.)
  const casterAbility = spec.cantrip?.spellcastingAbility;
  if (!casterAbility && className !== 'Paladin' && className !== 'Ranger') {
    return actions; // martial class with no spells
  }

  const spellAbility = casterAbility
    ?? (className === 'Paladin' ? 'cha' : 'wis'); // Paladin CHA, Ranger WIS
  const mod = abilityMod(abilities[spellAbility]);

  // Level caps: beyond this slot level, skip spells.
  const maxSlot =
    className === 'Paladin' || className === 'Ranger' ? halfCasterMaxSlot(level)
    : className === 'Warlock' ? warlockMaxPreparedSpellLevel(level)
    : fullCasterMaxSlot(level);

  // Class-specific repertoire.
  const repertoire: MonsterAction[] = [];
  switch (className) {
    case 'Wizard':
      repertoire.push(magicMissile(), burningHands(spellAbility, mod, pb), thunderwave(spellAbility, mod, pb), sleep(spellAbility, mod, pb));
      repertoire.push(scorchingRay(spellAbility, mod, pb), web(spellAbility, mod, pb));
      repertoire.push(fireball(spellAbility, mod, pb), lightningBolt(spellAbility, mod, pb));
      repertoire.push(iceStorm(spellAbility, mod, pb), banishment(spellAbility, mod, pb), stoneskin(spellAbility, mod, pb), fireShield(spellAbility, mod, pb));
      repertoire.push(coneOfCold(spellAbility, mod, pb), holdMonster(spellAbility, mod, pb), synapticStatic(spellAbility, mod, pb));
      repertoire.push(chainLightning(spellAbility, mod, pb), circleOfDeath(spellAbility, mod, pb), disintegrate(spellAbility, mod, pb));
      repertoire.push(fingerOfDeath(spellAbility, mod, pb));
      repertoire.push(befuddlement(spellAbility, mod, pb), sunburst(spellAbility, mod, pb));
      repertoire.push(powerWordKill(spellAbility), meteorSwarm(spellAbility, mod, pb));
      break;
    case 'Sorcerer':
      repertoire.push(magicMissile(), burningHands(spellAbility, mod, pb));
      if (level >= 3) repertoire.push(chromaticOrb(spellAbility, mod, pb), command(spellAbility, mod, pb));
      if (level >= 2) repertoire.push(thunderwave(spellAbility, mod, pb));
      repertoire.push(scorchingRay(spellAbility, mod, pb), shatter(spellAbility, mod, pb));
      repertoire.push(fireball(spellAbility, mod, pb), lightningBolt(spellAbility, mod, pb));
      repertoire.push(iceStorm(spellAbility, mod, pb), banishment(spellAbility, mod, pb), blight(spellAbility, mod, pb));
      repertoire.push(coneOfCold(spellAbility, mod, pb), holdMonster(spellAbility, mod, pb), synapticStatic(spellAbility, mod, pb));
      repertoire.push(fireStorm(spellAbility, mod, pb), sunburst(spellAbility, mod, pb), meteorSwarm(spellAbility, mod, pb), powerWordKill(spellAbility));
      break;
    case 'Warlock':
      repertoire.push(hex(spellAbility, mod, pb), witchBolt(spellAbility, mod, pb));
      if (level >= 3) repertoire.push(burningHands(spellAbility, mod, pb), command(spellAbility, mod, pb), scorchingRay(spellAbility, mod, pb));
      repertoire.push(holdPerson(spellAbility, mod, pb));
      repertoire.push(hypnoticPattern(spellAbility, mod, pb));
      if (level >= 5) repertoire.push(fireball(spellAbility, mod, pb));
      if (level >= 3) repertoire.push(hellishRebuke(spellAbility, mod, pb));
      repertoire.push(banishment(spellAbility, mod, pb), blight(spellAbility, mod, pb));
      if (level >= 7) repertoire.push(fireShield(spellAbility, mod, pb), wallOfFire(spellAbility, mod, pb));
      repertoire.push(holdMonster(spellAbility, mod, pb), synapticStatic(spellAbility, mod, pb));
      if (level >= 11) repertoire.push(asMysticArcanum(circleOfDeath(spellAbility, mod, pb), 'mystic-arcanum-6'));
      if (level >= 13) repertoire.push(asMysticArcanum(fingerOfDeath(spellAbility, mod, pb), 'mystic-arcanum-7'));
      if (level >= 15) repertoire.push(asMysticArcanum(befuddlement(spellAbility, mod, pb), 'mystic-arcanum-8'));
      if (level >= 17) repertoire.push(asMysticArcanum(powerWordKill(spellAbility), 'mystic-arcanum-9'));
      break;
    case 'Cleric':
      repertoire.push(bless(), cureWounds(spellAbility, mod, pb), healingWord(spellAbility, mod, pb), shieldOfFaith(), guidingBolt(spellAbility, mod, pb));
      repertoire.push(aid(spellAbility, mod, pb), holdPerson(spellAbility, mod, pb), spiritualWeapon(spellAbility, mod, pb));
      repertoire.push(spiritGuardians(spellAbility, mod, pb));
      repertoire.push(banishment(spellAbility, mod, pb), deathWard(spellAbility, mod, pb));
      repertoire.push(flameStrike(spellAbility, mod, pb), massCureWounds(spellAbility, mod, pb));
      repertoire.push(harm(spellAbility, mod, pb), heal(spellAbility));
      repertoire.push(fireStorm(spellAbility, mod, pb), sunburst(spellAbility, mod, pb));
      repertoire.push(massHeal(spellAbility), powerWordHeal(spellAbility));
      break;
    case 'Druid':
      repertoire.push(cureWounds(spellAbility, mod, pb), healingWord(spellAbility, mod, pb), entangle(spellAbility, mod, pb), thunderwave(spellAbility, mod, pb));
      repertoire.push(aid(spellAbility, mod, pb), holdPerson(spellAbility, mod, pb), moonbeam(spellAbility, mod, pb));
      repertoire.push(callLightning(spellAbility, mod, pb));
      repertoire.push(blight(spellAbility, mod, pb), fireShield(spellAbility, mod, pb), iceStorm(spellAbility, mod, pb), stoneskin(spellAbility, mod, pb), wallOfFire(spellAbility, mod, pb));
      repertoire.push(coneOfCold(spellAbility, mod, pb), massCureWounds(spellAbility, mod, pb));
      repertoire.push(heal(spellAbility));
      repertoire.push(fireStorm(spellAbility, mod, pb), befuddlement(spellAbility, mod, pb), sunburst(spellAbility, mod, pb));
      repertoire.push(stormOfVengeance(spellAbility, mod, pb));
      break;
    case 'Bard':
      repertoire.push(dissonantWhispers(spellAbility, mod, pb), healingWord(spellAbility, mod, pb), cureWounds(spellAbility, mod, pb), bane(spellAbility, mod, pb));
      repertoire.push(aid(spellAbility, mod, pb));
      repertoire.push(holdPerson(spellAbility, mod, pb), shatter(spellAbility, mod, pb));
      repertoire.push(hypnoticPattern(spellAbility, mod, pb));
      if (level >= 6) repertoire.push(fireball(spellAbility, mod, pb));
      repertoire.push(banishment(spellAbility, mod, pb));
      repertoire.push(holdMonster(spellAbility, mod, pb), massCureWounds(spellAbility, mod, pb), synapticStatic(spellAbility, mod, pb));
      repertoire.push(befuddlement(spellAbility, mod, pb));
      if (level >= 17) repertoire.push(powerWordHeal(spellAbility), powerWordKill(spellAbility));
      break;
    case 'Paladin':
      if (level >= 1) {
        repertoire.push(bless(), cureWounds(spellAbility, mod, pb));
      }
      if (level >= 3) repertoire.push(shieldOfFaith());
      repertoire.push(aid(spellAbility, mod, pb), magicWeapon(spellAbility, mod, pb), shiningSmite(spellAbility, mod, pb));
      repertoire.push(blindingSmite(spellAbility, mod, pb));
      repertoire.push(banishment(spellAbility, mod, pb), deathWard(spellAbility, mod, pb));
      repertoire.push(flameStrike(spellAbility, mod, pb));
      break;
    case 'Ranger':
      if (level >= 1) {
        const mark = huntersMark(spellAbility, mod, pb);
        const markDie = level >= 20 ? '1d10' : '1d6';
        mark.description = `Favored Enemy: mark a creature within 90 ft without spending a spell slot. Your weapon attacks deal extra ${markDie} force damage against the target. Concentration, 1 hour. Bonus action.`;
        if (mark.buff) mark.buff.damageRider = `${markDie} force`;
        mark.resourceCost = { key: 'favored-enemy', amount: 1 };
        repertoire.push(mark, cureWounds(spellAbility, mod, pb), entangle(spellAbility, mod, pb));
      }
      repertoire.push(aid(spellAbility, mod, pb), conjureBarrage(spellAbility, mod, pb), protectionFromEnergy(spellAbility, mod, pb), stoneskin(spellAbility, mod, pb));
      break;
  }

  for (const spell of repertoire) {
    if ((spell.spellLevel ?? 0) <= maxSlot) actions.push(spell);
  }
  return actions;
}

function buildOptionalSpells(
  className: HeroClassName, level: number, abilities: Abilities, pb: number,
): MonsterAction[] {
  const spec = CLASSES[className];
  const casterAbility = spec.cantrip?.spellcastingAbility;
  if (!casterAbility && className !== 'Paladin' && className !== 'Ranger') return [];
  const spellAbility = casterAbility ?? (className === 'Paladin' ? 'cha' : 'wis');
  const mod = abilityMod(abilities[spellAbility]);
  const maxSlot =
    className === 'Paladin' || className === 'Ranger' ? halfCasterMaxSlot(level)
    : className === 'Warlock' ? warlockMaxPreparedSpellLevel(level)
    : fullCasterMaxSlot(level);

  const pool: MonsterAction[] = [];
  switch (className) {
    case 'Wizard':
      pool.push(chromaticOrb(spellAbility, mod, pb), witchBolt(spellAbility, mod, pb));
      pool.push(shield(spellAbility, mod, pb), fogCloud(spellAbility, mod, pb));
      pool.push(falseLife(spellAbility, mod, pb), grease(spellAbility, mod, pb), mageArmor(spellAbility, mod, pb), rayOfSickness(spellAbility, mod, pb), tashasHideousLaughter(spellAbility, mod, pb));
      pool.push(blindnessDeafness(spellAbility, mod, pb), blur(spellAbility, mod, pb), cloudOfDaggers(spellAbility, mod, pb), flamingSphere(spellAbility, mod, pb), invisibility(spellAbility, mod, pb), mirrorImage(spellAbility, mod, pb), seeInvisibility(spellAbility, mod, pb));
      pool.push(acidArrow(spellAbility, mod, pb), gustOfWind(spellAbility, mod, pb));
      pool.push(mistyStep(spellAbility, mod, pb));
      pool.push(dispelMagic(spellAbility, mod, pb), haste(spellAbility, mod, pb));
      pool.push(counterspell(spellAbility, mod, pb));
      pool.push(bestowCurse(spellAbility, mod, pb), fear(spellAbility, mod, pb), fly(spellAbility, mod, pb));
      pool.push(wallOfFire(spellAbility, mod, pb));
      pool.push(blight(spellAbility, mod, pb));
      break;
    case 'Sorcerer':
      pool.push(chromaticOrb(spellAbility, mod, pb), witchBolt(spellAbility, mod, pb));
      pool.push(shield(spellAbility, mod, pb), fogCloud(spellAbility, mod, pb));
      pool.push(falseLife(spellAbility, mod, pb), grease(spellAbility, mod, pb), mageArmor(spellAbility, mod, pb), rayOfSickness(spellAbility, mod, pb), tashasHideousLaughter(spellAbility, mod, pb));
      pool.push(blindnessDeafness(spellAbility, mod, pb), blur(spellAbility, mod, pb), cloudOfDaggers(spellAbility, mod, pb), flamingSphere(spellAbility, mod, pb), invisibility(spellAbility, mod, pb), mirrorImage(spellAbility, mod, pb), seeInvisibility(spellAbility, mod, pb));
      pool.push(acidArrow(spellAbility, mod, pb), gustOfWind(spellAbility, mod, pb));
      pool.push(mistyStep(spellAbility, mod, pb));
      pool.push(dispelMagic(spellAbility, mod, pb), haste(spellAbility, mod, pb));
      pool.push(counterspell(spellAbility, mod, pb));
      pool.push(fear(spellAbility, mod, pb), fly(spellAbility, mod, pb));
      pool.push(wallOfFire(spellAbility, mod, pb));
      break;
    case 'Warlock':
      pool.push(armorOfAgathys(spellAbility, mod, pb), armsOfHadar(spellAbility, mod, pb), colorSpray(spellAbility, mod, pb));
      pool.push(bestowCurse(spellAbility, mod, pb));
      pool.push(mirrorImage(spellAbility, mod, pb));
      pool.push(dispelMagic(spellAbility, mod, pb));
      break;
    case 'Cleric':
      pool.push(inflictWounds(spellAbility, mod, pb), command(spellAbility, mod, pb), protectionFromEvilAndGood(spellAbility, mod, pb), sanctuary(spellAbility, mod, pb));
      pool.push(blindnessDeafness(spellAbility, mod, pb));
      pool.push(lesserRestoration(spellAbility, mod, pb));
      pool.push(dispelMagic(spellAbility, mod, pb));
      pool.push(counterspell(spellAbility, mod, pb));
      pool.push(revivify(spellAbility, mod, pb));
      break;
    case 'Druid':
      pool.push(barkskin(spellAbility, mod, pb), faerieFire(spellAbility, mod, pb), fogCloud(spellAbility, mod, pb), longstrider(spellAbility, mod, pb));
      pool.push(lesserRestoration(spellAbility, mod, pb), gustOfWind(spellAbility, mod, pb), spikeGrowth(spellAbility, mod, pb));
      pool.push(dispelMagic(spellAbility, mod, pb));
      pool.push(fear(spellAbility, mod, pb), fly(spellAbility, mod, pb), revivify(spellAbility, mod, pb));
      pool.push(wallOfFire(spellAbility, mod, pb));
      break;
    case 'Bard':
      pool.push(heroism(spellAbility, mod, pb));
      pool.push(faerieFire(spellAbility, mod, pb), tashasHideousLaughter(spellAbility, mod, pb));
      pool.push(command(spellAbility, mod, pb));
      pool.push(blindnessDeafness(spellAbility, mod, pb), mirrorImage(spellAbility, mod, pb));
      pool.push(dispelMagic(spellAbility, mod, pb), haste(spellAbility, mod, pb));
      pool.push(bestowCurse(spellAbility, mod, pb), fear(spellAbility, mod, pb), fly(spellAbility, mod, pb));
      break;
    case 'Paladin':
      pool.push(heroism(spellAbility, mod, pb));
      pool.push(protectionFromEvilAndGood(spellAbility, mod, pb));
      pool.push(divineFavor(spellAbility, mod, pb));
      pool.push(command(spellAbility, mod, pb));
      pool.push(holdPerson(spellAbility, mod, pb), moonbeam(spellAbility, mod, pb), spiritualWeapon(spellAbility, mod, pb));
      pool.push(lesserRestoration(spellAbility, mod, pb));
      pool.push(dispelMagic(spellAbility, mod, pb));
      break;
    case 'Ranger':
      pool.push(protectionFromPoison(spellAbility, mod, pb));
      pool.push(spikeGrowth(spellAbility, mod, pb));
      pool.push(dispelMagic(spellAbility, mod, pb));
      break;
  }
  return pool.filter(s => (s.spellLevel ?? 0) <= maxSlot);
}

/** Turn the class's slot table into Creature initialResources keys ("slot-1": 2, ...). */
function buildClassResources(className: HeroClassName, level: number): Record<string, number> {
  const base =
    className === 'Wizard' || className === 'Sorcerer' || className === 'Cleric'
    || className === 'Druid' || className === 'Bard'
      ? slotsToResources(FULL_CASTER_SLOTS[level] ?? {})
    : className === 'Paladin' || className === 'Ranger'
      ? slotsToResources(HALF_CASTER_SLOTS[level] ?? {})
    : className === 'Warlock'
      ? slotsToResources(WARLOCK_SLOTS[level] ?? {})
      : {};

  // Non-slot resources layered on top.
  const extras: Record<string, number> = {};
  if (className === 'Barbarian') {
    // Rage uses: SRD L1-2 = 2, L3-5 = 3, L6-11 = 4, L12-16 = 5, L17+ = 6.
    extras.rage = level >= 17 ? 6 : level >= 12 ? 5 : level >= 6 ? 4 : level >= 3 ? 3 : 2;
    if (level >= 11) extras['relentless-rage-dc'] = 10;
    if (level >= 14) extras['intimidating-presence'] = 1;
  }
  if (className === 'Fighter') {
    // 2024 Second Wind: 2 uses at L1, then scales up through the class table.
    extras['second-wind'] = level >= 10 ? 4 : level >= 4 ? 3 : 2;
    if (level >= 2) extras['action-surge'] = level >= 17 ? 2 : 1;
    if (level >= 9) extras['indomitable'] = level >= 17 ? 3 : level >= 13 ? 2 : 1;
  }
  if (className === 'Monk' && level >= 2) {
    // Engine key remains "ki" for backward compatibility with saved
    // encounters/tests; rules text now calls these Focus Points.
    extras.ki = level;
    if (level >= 6) {
      const spec = CLASSES[className];
      const abilities = abilityArray(spec.primary, spec.secondary, level, spec.tertiary);
      applyClassAbilityProgression(className, spec, level, abilities);
      extras['wholeness-of-body'] = Math.max(1, abilityMod(abilities.wis));
    }
  }
  if (className === 'Cleric' && level >= 2) {
    // Channel Divinity: 2 uses at L2, 3 at L6, 4 at L18.
    extras['channel-divinity'] = level >= 18 ? 4 : level >= 6 ? 3 : 2;
    if (level >= 10) extras['divine-intervention'] = 1;
  }
  if (className === 'Druid' && level >= 2) {
    extras['wild-shape'] = level >= 10 ? 4 : level >= 6 ? 3 : 2;
    if (level >= 6) extras['natural-recovery'] = 1;
  }
  if (className === 'Bard') {
    const spec = CLASSES[className];
    const abilities = abilityArray(spec.primary, spec.secondary, level, spec.tertiary);
    applyClassAbilityProgression(className, spec, level, abilities);
    extras['bardic-inspiration'] = Math.max(1, abilityMod(abilities.cha));
  }
  if (className === 'Paladin') {
    // Lay on Hands pool: 5 × level HP.
    extras['lay-on-hands'] = 5 * level;
    if (level >= 2) extras['free-divine-smite'] = 1;
    if (level >= 3) extras['channel-divinity'] = level >= 11 ? 3 : 2;
    if (level >= 20) extras['holy-nimbus'] = 1;
  }
  if (className === 'Ranger') {
    // 2024 Favored Enemy: free Hunter's Mark uses by class table.
    extras['favored-enemy'] = level >= 17 ? 6 : level >= 13 ? 5 : level >= 9 ? 4 : level >= 5 ? 3 : level >= 1 ? 2 : 0;
    if (level >= 10) {
      const spec = CLASSES[className];
      const abilities = abilityArray(spec.primary, spec.secondary, level, spec.tertiary);
      applyClassAbilityProgression(className, spec, level, abilities);
      extras.tireless = Math.max(1, abilityMod(abilities.wis));
    }
    if (level >= 14) {
      const spec = CLASSES[className];
      const abilities = abilityArray(spec.primary, spec.secondary, level, spec.tertiary);
      applyClassAbilityProgression(className, spec, level, abilities);
      extras['natures-veil'] = Math.max(1, abilityMod(abilities.wis));
    }
  }
  if (className === 'Rogue' && level >= 20) {
    extras['stroke-of-luck'] = 1;
  }
  if (className === 'Sorcerer') {
    extras['innate-sorcery'] = 2;
    if (level >= 2) extras.sorcery = level; // Sorcery points equal sorcerer level
  }
  if (className === 'Warlock') {
    const spec = CLASSES[className];
    const abilities = abilityArray(spec.primary, spec.secondary, level, spec.tertiary);
    applyClassAbilityProgression(className, spec, level, abilities);
    if (level >= 6) extras['dark-ones-own-luck'] = Math.max(1, abilityMod(abilities.cha));
    if (level >= 11) extras['mystic-arcanum-6'] = 1;
    if (level >= 13) extras['mystic-arcanum-7'] = 1;
    if (level >= 14) extras['hurl-through-hell'] = 1;
    if (level >= 15) extras['mystic-arcanum-8'] = 1;
    if (level >= 17) extras['mystic-arcanum-9'] = 1;
  }
  if (className === 'Wizard') {
    if (level >= 14) extras.overchannel = 1;
    if (level >= 20) {
      extras['signature-fireball'] = 1;
      extras['signature-lightning-bolt'] = 1;
    }
  }

  return { ...base, ...extras };
}

// ─────────────────────────────────────────────────────────────────────────────
// Class-specific ability actions (Rage, Second Wind, Divine Smite hook, etc.)
// ─────────────────────────────────────────────────────────────────────────────

/** Rage damage bonus by level: +2 (L1-8), +3 (L9-15), +4 (L16+). */
function rageDamageBonus(level: number): number {
  if (level >= 16) return 4;
  if (level >= 9) return 3;
  return 2;
}

/** Build class-abilities list (Rage, Second Wind, etc.) as MonsterAction entries. */
function buildClassAbilities(
  className: HeroClassName,
  level: number,
  abilities: Abilities,
  pb: number,
): MonsterAction[] {
  const out: MonsterAction[] = [];

  if (className === 'Cleric' && level >= 2) {
    const wisMod = abilityMod(abilities.wis);
    const sparkDice = level >= 18 ? '4d8' : level >= 13 ? '3d8' : level >= 7 ? '2d8' : '1d8';
    const sparkAmount = `${sparkDice}${wisMod !== 0 ? formatBonus(wisMod) : ''}`;
    const sparkDc = 8 + pb + wisMod;
    out.push({
      name: 'Channel Divinity: Divine Spark Heal',
      type: 'special',
      description: `Magic action: restore ${sparkAmount} HP to one creature within 30 ft. Uses 1 Channel Divinity.`,
      resourceCost: { key: 'channel-divinity', amount: 1 },
      heal: { dice: sparkAmount, addCastingMod: false },
      range: { normal: 30, long: 30 },
      targetScope: 'one_ally',
    });
    out.push({
      name: 'Channel Divinity: Divine Spark Harm',
      type: 'special',
      description: `Magic action: one creature within 30 ft makes a DC ${sparkDc} CON save; ${sparkAmount} radiant damage on fail, half on success. Uses 1 Channel Divinity.`,
      resourceCost: { key: 'channel-divinity', amount: 1 },
      castingAbility: 'wis',
      damageType: 'radiant',
      savingThrow: {
        ability: 'con',
        dc: sparkDc,
        damageOnFail: sparkAmount,
        damageOnSuccess: 'half',
      },
      range: { normal: 30, long: 30 },
      targetScope: 'one_enemy',
    });
  }

  if (className === 'Cleric' && level >= 3) {
    const healPool = 5 * level;
    out.push({
      name: 'Channel Divinity: Preserve Life',
      type: 'special',
      description: `Action: restore up to ${healPool} HP divided among creatures within 30 ft. Each target can't exceed half its HP max. Uses 1 Channel Divinity.`,
      resourceCost: { key: 'channel-divinity', amount: 1 },
      heal: { dice: `${healPool}`, addCastingMod: false, maxTargetHpFraction: 0.5 },
      range: { normal: 30, long: 30 },
      targetScope: 'one_ally',
    });
  }

  if (className === 'Cleric' && level >= 10) {
    const wisMod = abilityMod(abilities.wis);
    const withDivineIntervention = (action: MonsterAction, name: string, description: string): MonsterAction => ({
      ...action,
      name,
      description,
      resourceCost: { key: 'divine-intervention', amount: 1 },
    });
    out.push(withDivineIntervention(
      flameStrike('wis', wisMod, pb),
      'Divine Intervention: Flame Strike',
      'Magic action: Divine Intervention casts Flame Strike without expending a spell slot. Uses Divine Intervention.',
    ));
    out.push(withDivineIntervention(
      massCureWounds('wis', wisMod, pb),
      'Divine Intervention: Mass Cure Wounds',
      'Magic action: Divine Intervention casts Mass Cure Wounds without expending a spell slot. Uses Divine Intervention.',
    ));
    if (level >= 20) {
      out.push(withDivineIntervention(
        heal('wis'),
        'Greater Divine Intervention: Wish-Heal',
        'Magic action: Greater Divine Intervention uses Wish to duplicate Heal without expending a spell slot. Uses Divine Intervention.',
      ));
      out.push(withDivineIntervention(
        sunburst('wis', wisMod, pb),
        'Greater Divine Intervention: Wish-Sunburst',
        'Magic action: Greater Divine Intervention uses Wish to duplicate Sunburst without expending a spell slot. Uses Divine Intervention.',
      ));
    }
  }

  if (className === 'Druid' && level >= 3) {
    const wisMod = abilityMod(abilities.wis);
    const dc = 8 + pb + wisMod;
    const landAidDice = level >= 14 ? '4d6' : level >= 10 ? '3d6' : '2d6';
    out.push({
      name: "Land's Aid",
      type: 'special',
      description: `Magic action: spend Wild Shape to create a 10-foot-radius bloom within 60 ft. Enemies make a DC ${dc} CON save or take ${landAidDice} necrotic damage, half on success; one wounded ally regains ${landAidDice} HP.`,
      resourceCost: { key: 'wild-shape', amount: 1 },
      castingAbility: 'wis',
      damageType: 'necrotic',
      savingThrow: {
        ability: 'con',
        dc,
        damageOnFail: landAidDice,
        damageOnSuccess: 'half',
        area: '10-foot sphere',
      },
      landAidHealDice: landAidDice,
      range: { normal: 60, long: 60 },
      targetScope: 'area_enemies',
    });
  }

  if (className === 'Druid' && level >= 6) {
    const wisMod = abilityMod(abilities.wis);
    const freeCircleSpell =
      level >= 9 ? coneOfCold('wis', wisMod, pb)
      : level >= 7 ? iceStorm('wis', wisMod, pb)
      : holdPerson('wis', wisMod, pb);
    out.push({
      ...freeCircleSpell,
      name: `Natural Recovery: ${freeCircleSpell.name}`,
      description: `Natural Recovery casts ${freeCircleSpell.name} without expending a spell slot. Uses 1 Natural Recovery.`,
      resourceCost: { key: 'natural-recovery', amount: 1 },
    });
  }

  if (className === 'Druid' && level >= 14) {
    out.push({
      name: "Nature's Sanctuary",
      type: 'special',
      description: 'Magic action: spend Wild Shape to create sheltering land spirits. Modeled as nearby allies gaining +2 AC for 1 minute.',
      resourceCost: { key: 'wild-shape', amount: 1 },
      durationRounds: 10,
      buff: {
        name: "Nature's Sanctuary",
        key: 'natures-sanctuary',
        requiresConcentration: false,
        acBonus: 2,
      },
      range: { normal: 120, long: 120 },
      targetScope: 'all_allies_in_area',
    });
  }

  if (className === 'Bard') {
    const inspDie = level >= 15 ? '1d12' : level >= 10 ? '1d10' : level >= 5 ? '1d8' : '1d6';
    out.push({
      name: 'Bardic Inspiration',
      type: 'special',
      isBonusAction: true,
      description: `Bonus action: give one ally within 60 ft a ${inspDie} Bardic Inspiration die to add to their next attack roll or saving throw.`,
      resourceCost: { key: 'bardic-inspiration', amount: 1 },
      durationRounds: 10,
      buff: {
        name: 'Bardic Inspiration', key: 'bardic-inspiration',
        attackBonusDice: inspDie, saveBonusDice: inspDie,
      },
      range: { normal: 60, long: 60 },
      targetScope: 'one_ally',
    });
  }

  if (className === 'Barbarian') {
    const rageDuration = level >= 15 ? 100 : 10;
    out.push({
      name: 'Rage',
      type: 'special',
      isBonusAction: true,
      description: `Bonus action: enter a rage${level >= 15 ? ' for the battle' : ' for 1 minute (10 rounds)'}. While raging: +${rageDamageBonus(level)} damage on Strength-based weapon attacks; resistance to bludgeoning/piercing/slashing damage. Costs 1 rage use.`,
      durationRounds: rageDuration,
      resourceCost: { key: 'rage', amount: 1 },
      buff: {
        name: 'Rage', key: 'rage',
        rageDamageBonus: rageDamageBonus(level),
        resistPhysical: true,
      },
      targetScope: 'self',
    });

    if (level >= 14) {
      const dc = 8 + pb + abilityMod(abilities.str);
      out.push({
        name: 'Intimidating Presence',
        type: 'special',
        isBonusAction: true,
        description: `Bonus action: each chosen enemy in a 30-foot emanation makes a DC ${dc} Wisdom save or is Frightened for 1 minute.`,
        resourceCost: { key: 'intimidating-presence', amount: 1 },
        savingThrow: {
          ability: 'wis',
          dc,
          area: '30-foot Emanation',
          conditionOnFail: 'frightened',
          conditionDuration: '1_minute',
        },
        targetScope: 'area_enemies',
        range: { normal: 30, long: 30 },
      });
    }
  }

  if (className === 'Fighter') {
    const heal = `1d10+${level}`;
    out.push({
      name: 'Second Wind',
      type: 'special',
      isBonusAction: true,
      description: `Bonus action: regain ${heal} HP. Costs 1 second-wind use.`,
      resourceCost: { key: 'second-wind', amount: 1 },
      heal: { dice: heal, addCastingMod: false },
      targetScope: 'self',
    });
  }

  if (className === 'Monk' && level >= 6) {
    const wisMod = abilityMod(abilities.wis);
    const heal = `${monkUnarmedDie(level)}${wisMod !== 0 ? formatBonus(wisMod) : ''}`;
    out.push({
      name: 'Wholeness of Body',
      type: 'special',
      isBonusAction: true,
      description: `Bonus action: regain ${heal} HP. Costs 1 Wholeness of Body use.`,
      resourceCost: { key: 'wholeness-of-body', amount: 1 },
      heal: { dice: heal, addCastingMod: false },
      targetScope: 'self',
    });
  }

  if (className === 'Ranger') {
    const wisMod = abilityMod(abilities.wis);
    if (level >= 10) {
      const tempHp = `1d8${wisMod !== 0 ? formatBonus(wisMod) : ''}`;
      out.push({
        name: 'Tireless',
        type: 'special',
        description: `Magic action: gain ${tempHp} temporary HP. Costs 1 Tireless use.`,
        resourceCost: { key: 'tireless', amount: 1 },
        temporaryHp: { dice: tempHp, addCastingMod: false },
        targetScope: 'self',
      });
    }
    if (level >= 14) {
      out.push({
        name: "Nature's Veil",
        type: 'special',
        isBonusAction: true,
        description: 'Bonus action: become Invisible until the end of your next turn. Costs 1 Nature\'s Veil use.',
        resourceCost: { key: 'natures-veil', amount: 1 },
        targetScope: 'self',
      });
    }
  }

  if (className === 'Sorcerer') {
    out.push({
      name: 'Innate Sorcery',
      type: 'special',
      isBonusAction: true,
      description: 'Bonus action: for 1 minute, Sorcerer spell save DC increases by 1 and Sorcerer spell attack rolls have Advantage. Costs 1 Innate Sorcery use.',
      durationRounds: 10,
      resourceCost: { key: 'innate-sorcery', amount: 1 },
      buff: {
        name: 'Innate Sorcery',
        key: 'innate-sorcery',
        spellAttackAdvantage: true,
        spellSaveDcBonus: 1,
      },
      targetScope: 'self',
    });
    if (level >= 7) {
      out.push({
        name: 'Sorcery Incarnate',
        type: 'special',
        isBonusAction: true,
        description: 'Bonus action: spend 2 Sorcery Points to activate Innate Sorcery when no Innate Sorcery uses remain.',
        durationRounds: 10,
        resourceCost: { key: 'sorcery', amount: 2 },
        buff: {
          name: 'Innate Sorcery',
          key: 'innate-sorcery',
          spellAttackAdvantage: true,
          spellSaveDcBonus: 1,
        },
        targetScope: 'self',
      });
    }
  }

  if (className === 'Paladin' && level >= 1) {
    // Lay on Hands: restore HP from a pool. The dispatcher spends exactly
    // the useful amount for the chosen target, then Restoring Touch can spend
    // 5-point chunks from the same pool to remove conditions.
    out.push({
      name: 'Lay on Hands',
      type: 'special',
      isBonusAction: true,
      description: `Bonus action touch: restore HP to an ally (or self), spending points from your Lay on Hands pool (${5 * level} HP max).`,
      layOnHands: { resourceKey: 'lay-on-hands' },
      heal: { dice: `${5 * level}`, addCastingMod: false },
      range: { normal: 5, long: 5 },
      targetScope: 'one_ally',
    });

    if (level >= 9) {
      const dc = 8 + pb + abilityMod(abilities.cha);
      out.push({
        name: 'Abjure Foes',
        type: 'special',
        description: `Magic action: spend Channel Divinity. Up to CHA-mod enemies within 60 ft make a DC ${dc} WIS save or become Frightened.`,
        resourceCost: { key: 'channel-divinity', amount: 1 },
        castingAbility: 'cha',
        savingThrow: {
          ability: 'wis',
          dc,
          conditionOnFail: 'frightened',
          conditionDuration: '1_minute',
        },
        range: { normal: 60, long: 60 },
        targetScope: 'area_enemies',
      });
    }

    if (level >= 20) {
      out.push({
        name: 'Holy Nimbus',
        type: 'special',
        isBonusAction: true,
        description: 'Bonus action: emit a holy aura. Enemies starting their turn in your aura take radiant damage.',
        durationRounds: 10,
        resourceCost: { key: 'holy-nimbus', amount: 1 },
        buff: {
          name: 'Holy Nimbus',
          key: 'holy-nimbus',
          requiresConcentration: false,
        },
        targetScope: 'self',
      });
    }
  }

  if (className === 'Wizard' && level >= 20) {
    const intMod = abilityMod(abilities.int);
    const withSignatureSpell = (action: MonsterAction, name: string, resourceKey: string): MonsterAction => ({
      ...action,
      name,
      description: `Signature Spell: ${action.description} Cast once at level 3 without expending a spell slot.`,
      resourceCost: { key: resourceKey, amount: 1 },
    });
    out.push(withSignatureSpell(
      fireball('int', intMod, pb),
      'Signature Spell: Fireball',
      'signature-fireball',
    ));
    out.push(withSignatureSpell(
      lightningBolt('int', intMod, pb),
      'Signature Spell: Lightning Bolt',
      'signature-lightning-bolt',
    ));
  }

  return out;
}

/** Shortcut: every (class, level) combination, flat list. Used by the picker. */
export function allHeroBuilds(): MonsterData[] {
  const out: MonsterData[] = [];
  for (const cls of HERO_CLASS_NAMES) {
    for (let lv = MIN_HERO_LEVEL; lv <= getMaxHeroLevelForClass(cls); lv++) {
      out.push(buildHero(cls, lv));
    }
  }
  return out;
}

/** For picker card preview: a compact stat summary without building the full MonsterData. */
export function heroSummary(className: HeroClassName, level: number): {
  name: string; hp: number; ac: number; primary: string; weapon: string;
} {
  const m = buildHero(className, level);
  const weapon = m.actions.find(a => a.type !== 'multiattack')?.name ?? '-';
  return {
    name: `${className} L${level}`,
    hp: m.hp,
    ac: m.ac,
    primary: CLASSES[className].primary.toUpperCase(),
    weapon,
  };
}

export function getHeroClassSpec(className: HeroClassName) {
  return CLASSES[className];
}

export function getDefaultSpellNames(className: HeroClassName, level: number): Set<string> {
  const spec = CLASSES[className];
  const abilities = abilityArray(spec.primary, spec.secondary, level, spec.tertiary);
  applyClassAbilityProgression(className, spec, level, abilities);
  const pb = proficiencyBonus(level);
  const spells = buildClassSpells(className, level, abilities, pb);
  const names = new Set(spells.map(s => s.name));
  if (spec.cantrip) names.add(spec.cantrip.name);
  return names;
}

export function getDefaultAbilities(className: HeroClassName, level: number): Abilities {
  const spec = CLASSES[className];
  const abilities = abilityArray(spec.primary, spec.secondary, level, spec.tertiary);
  applyClassAbilityProgression(className, spec, level, abilities);
  return abilities;
}

/** 2024 Wild Shape beast forms available by Druid level/subclass. */
export interface WildShapeBeast {
  name: string;
  formHp: number;
  ac: number;
  speed: Speed;
  size: MonsterData['size'];
  abilities: Pick<Abilities, 'str' | 'dex' | 'con'>;
  saves?: Partial<Record<keyof Abilities, number>>;
  traits?: MonsterTrait[];
  initialResources?: Record<string, number>;
  actions: MonsterAction[];
  cr: string;
  crValue: number;
}

export interface WildShapeEligibilityOptions {
  level: number;
  subclass?: string;
  includeSwarms?: boolean;
}

function crToNumber(cr: string): number {
  if (cr.includes('/')) {
    const [num, den] = cr.split('/').map(Number);
    return den ? num / den : 0;
  }
  return Number(cr) || 0;
}

function maxWildShapeCR(level: number, subclass?: string): number {
  if (subclass === 'Circle of the Moon' && level >= 3) return Math.floor(level / 3);
  if (level >= 8) return 1;
  if (level >= 4) return 0.5;
  if (level >= 2) return 0.25;
  return 0;
}

function isSwarm(monster: MonsterData): boolean {
  return monster.name.startsWith('Swarm of ') || !!monster.traits?.some(t => t.name === 'Swarm');
}

function toWildShapeBeast(monster: MonsterData): WildShapeBeast {
  return {
    name: monster.name,
    formHp: monster.hp,
    ac: monster.ac,
    speed: { ...monster.speed },
    size: monster.size,
    abilities: {
      str: monster.abilities.str,
      dex: monster.abilities.dex,
      con: monster.abilities.con,
    },
    saves: monster.saves ? { ...monster.saves } : undefined,
    traits: monster.traits ? monster.traits.map(t => ({ ...t })) : undefined,
    initialResources: monster.initialResources ? { ...monster.initialResources } : undefined,
    actions: monster.actions.map(a => ({ ...a })),
    cr: monster.cr,
    crValue: crToNumber(monster.cr),
  };
}

function averageDice(dice: string | undefined): number {
  if (!dice) return 0;
  const match = dice.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!match) return Number(dice) || 0;
  const count = match[1] ? Number(match[1]) : 1;
  const sides = Number(match[2]);
  const mod = match[3] ? Number(match[3]) : 0;
  return count * (sides + 1) / 2 + mod;
}

function actionScore(action: MonsterAction): number {
  const base = averageDice(action.damage);
  const rider = action.additionalDamage ? averageDice(action.additionalDamage.split(' ')[0]) : 0;
  const condition = action.conditionOnHit?.condition ?? action.savingThrow?.conditionOnFail;
  const control =
    condition === 'restrained' ? 10
    : condition === 'frightened' ? 8
    : condition === 'grappled' ? 5
    : condition === 'prone' ? 4
    : condition ? 3
    : 0;
  return base + rider + control;
}

function wildShapeScore(beast: WildShapeBeast): number {
  const bestAction = Math.max(0, ...beast.actions.filter(a => a.type !== 'multiattack').map(actionScore));
  const multiattackBonus = beast.actions.some(a => a.type === 'multiattack') ? 4 : 0;
  const mobility = Math.max(beast.speed.walk, beast.speed.climb ?? 0, beast.speed.swim ?? 0, beast.speed.fly ?? 0) / 10;
  const traitBonus =
    (beast.traits?.some(t => t.name === 'Pack Tactics') ? 3 : 0) +
    (beast.traits?.some(t => t.name === 'Nimble Escape') ? 2 : 0);
  return beast.ac * 1.5 + bestAction + multiattackBonus + mobility + traitBonus;
}

export function getEligibleWildShapeBeasts(options: WildShapeEligibilityOptions): WildShapeBeast[] {
  const maxCR = maxWildShapeCR(options.level, options.subclass);
  if (maxCR <= 0) return [];
  return monsters
    .filter(monster => monster.type === 'Beast')
    .filter(monster => crToNumber(monster.cr) <= maxCR)
    .filter(monster => options.includeSwarms || !isSwarm(monster))
    .filter(monster => options.level >= 8 || !monster.speed.fly)
    .map(toWildShapeBeast)
    .sort((a, b) => wildShapeScore(b) - wildShapeScore(a));
}

export function getWildShapeBeast(druidLevel: number, subclass?: string): WildShapeBeast | null {
  const eligible = getEligibleWildShapeBeasts({ level: druidLevel, subclass });
  return eligible[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom hero builder (for the party builder feature)
// ─────────────────────────────────────────────────────────────────────────────

export interface WeaponOverride {
  name: string;
  die: string;
  damageType: string;
  type: 'melee' | 'ranged';
  reach?: number;
  range?: { normal: number; long: number };
  attackBonusOverride?: number;
  damageOverride?: string;
  loading?: boolean;
  heavy?: boolean;
  closeRangeDisadvantage?: boolean;
  mastery?: WeaponMasteryProperty;
  attackAbility?: AbilityKey;
  finesse?: boolean;
}

export interface HeroOverrides {
  displayName?: string;
  alignmentOverride?: string;
  subclass?: HeroSubclassName;
  preferredWildShapeBeast?: string;
  abilities?: Abilities;
  hpOverride?: number;
  acOverride?: number;
  armorBaseOverride?: number;
  armorDexCapOverride?: number;
  wearingHeavyArmor?: boolean;
  shieldOverride?: boolean;
  speedPenaltyOverride?: number;
  speedOverride?: number;
  sizeOverride?: MonsterData['size'];
  hitPointBonus?: number;
  additionalResistances?: string[];
  species?: string;
  speciesChoice?: string;
  speciesCastingAbility?: keyof Abilities;
  background?: string;
  originFeat?: string;
  originFeats?: string[];
  originSkills?: string[];
  originTool?: string;
  originTools?: string[];
  originEquipment?: string[];
  speciesCantrips?: string[];
  speciesPreparedSpells?: string[];
  additionalSenses?: string;
  additionalLanguages?: string[];
  additionalResources?: Record<string, number>;
  additionalActions?: MonsterAction[];
  weapon?: WeaponOverride;
  weapons?: WeaponOverride[];
  spells?: string[];
  spellSelectionIncludesCantrips?: boolean;
}

function weaponOverrideToSpec(weapon: WeaponOverride): WeaponSpec {
  return {
    name: weapon.name,
    die: weapon.die,
    damageType: weapon.damageType,
    kind: weapon.type,
    reach: weapon.type === 'melee' ? (weapon.reach ?? 5) : undefined,
    range: weapon.type === 'ranged' ? (weapon.range ?? { normal: 30, long: 30 }) : undefined,
    attackBonusOverride: weapon.attackBonusOverride,
    damageOverride: weapon.damageOverride,
    loading: weapon.loading,
    heavy: weapon.heavy,
    closeRangeDisadvantage: weapon.closeRangeDisadvantage,
    mastery: weapon.mastery,
    abilityOverride: weapon.attackAbility,
    finesse: weapon.finesse,
  };
}

/**
 * Returns all spell names available for a class at a given level,
 * grouped by spell level. Used by the party builder spell picker.
 */
export function getAvailableSpells(
  className: HeroClassName, level: number,
): { spellLevel: number; name: string }[] {
  const spec = CLASSES[className];
  if (!spec) return [];

  const casterAbility = spec.cantrip?.spellcastingAbility;
  if (!casterAbility && className !== 'Paladin' && className !== 'Ranger') return [];

  const spellAbility = casterAbility ?? (className === 'Paladin' ? 'cha' : 'wis');
  const abilities = abilityArray(spec.primary, spec.secondary, level, spec.tertiary);
  applyClassAbilityProgression(className, spec, level, abilities);

  const mod = abilityMod(abilities[spellAbility]);
  const pb = proficiencyBonus(level);
  const maxSlot =
    className === 'Paladin' || className === 'Ranger' ? halfCasterMaxSlot(level)
    : className === 'Warlock' ? warlockMaxPreparedSpellLevel(level)
    : fullCasterMaxSlot(level);

  const repertoire: MonsterAction[] = [];
  if (spec.cantrip) {
    repertoire.push(makeCantripAction(spec.cantrip, level, abilities, pb));
  }
  switch (className) {
    case 'Wizard':
      repertoire.push(magicMissile(), burningHands(spellAbility, mod, pb), thunderwave(spellAbility, mod, pb), sleep(spellAbility, mod, pb));
      repertoire.push(scorchingRay(spellAbility, mod, pb), web(spellAbility, mod, pb));
      repertoire.push(fireball(spellAbility, mod, pb), lightningBolt(spellAbility, mod, pb));
      repertoire.push(iceStorm(spellAbility, mod, pb), banishment(spellAbility, mod, pb), stoneskin(spellAbility, mod, pb), fireShield(spellAbility, mod, pb));
      repertoire.push(coneOfCold(spellAbility, mod, pb), holdMonster(spellAbility, mod, pb), synapticStatic(spellAbility, mod, pb));
      repertoire.push(chainLightning(spellAbility, mod, pb), circleOfDeath(spellAbility, mod, pb), disintegrate(spellAbility, mod, pb));
      repertoire.push(fingerOfDeath(spellAbility, mod, pb));
      repertoire.push(befuddlement(spellAbility, mod, pb), sunburst(spellAbility, mod, pb));
      repertoire.push(powerWordKill(spellAbility), meteorSwarm(spellAbility, mod, pb));
      break;
    case 'Sorcerer':
      repertoire.push(magicMissile(), burningHands(spellAbility, mod, pb));
      if (level >= 3) repertoire.push(chromaticOrb(spellAbility, mod, pb), command(spellAbility, mod, pb));
      repertoire.push(thunderwave(spellAbility, mod, pb));
      repertoire.push(scorchingRay(spellAbility, mod, pb), shatter(spellAbility, mod, pb));
      repertoire.push(fireball(spellAbility, mod, pb), lightningBolt(spellAbility, mod, pb));
      repertoire.push(iceStorm(spellAbility, mod, pb), banishment(spellAbility, mod, pb), blight(spellAbility, mod, pb));
      repertoire.push(coneOfCold(spellAbility, mod, pb), holdMonster(spellAbility, mod, pb), synapticStatic(spellAbility, mod, pb));
      repertoire.push(fireStorm(spellAbility, mod, pb), sunburst(spellAbility, mod, pb), meteorSwarm(spellAbility, mod, pb), powerWordKill(spellAbility));
      break;
    case 'Warlock':
      repertoire.push(hex(spellAbility, mod, pb), witchBolt(spellAbility, mod, pb));
      if (level >= 3) repertoire.push(burningHands(spellAbility, mod, pb), command(spellAbility, mod, pb), scorchingRay(spellAbility, mod, pb));
      repertoire.push(holdPerson(spellAbility, mod, pb));
      repertoire.push(hypnoticPattern(spellAbility, mod, pb));
      if (level >= 5) repertoire.push(fireball(spellAbility, mod, pb));
      if (level >= 3) repertoire.push(hellishRebuke(spellAbility, mod, pb));
      repertoire.push(banishment(spellAbility, mod, pb), blight(spellAbility, mod, pb));
      if (level >= 7) repertoire.push(fireShield(spellAbility, mod, pb), wallOfFire(spellAbility, mod, pb));
      repertoire.push(holdMonster(spellAbility, mod, pb), synapticStatic(spellAbility, mod, pb));
      if (level >= 11) repertoire.push(asMysticArcanum(circleOfDeath(spellAbility, mod, pb), 'mystic-arcanum-6'));
      if (level >= 13) repertoire.push(asMysticArcanum(fingerOfDeath(spellAbility, mod, pb), 'mystic-arcanum-7'));
      if (level >= 15) repertoire.push(asMysticArcanum(befuddlement(spellAbility, mod, pb), 'mystic-arcanum-8'));
      if (level >= 17) repertoire.push(asMysticArcanum(powerWordKill(spellAbility), 'mystic-arcanum-9'));
      break;
    case 'Cleric':
      repertoire.push(bless(), cureWounds(spellAbility, mod, pb), healingWord(spellAbility, mod, pb), shieldOfFaith(), guidingBolt(spellAbility, mod, pb));
      repertoire.push(aid(spellAbility, mod, pb), holdPerson(spellAbility, mod, pb), spiritualWeapon(spellAbility, mod, pb));
      repertoire.push(spiritGuardians(spellAbility, mod, pb));
      repertoire.push(banishment(spellAbility, mod, pb), deathWard(spellAbility, mod, pb));
      repertoire.push(flameStrike(spellAbility, mod, pb), massCureWounds(spellAbility, mod, pb));
      repertoire.push(harm(spellAbility, mod, pb), heal(spellAbility));
      repertoire.push(fireStorm(spellAbility, mod, pb), sunburst(spellAbility, mod, pb));
      repertoire.push(massHeal(spellAbility), powerWordHeal(spellAbility));
      break;
    case 'Druid':
      repertoire.push(cureWounds(spellAbility, mod, pb), healingWord(spellAbility, mod, pb), entangle(spellAbility, mod, pb), thunderwave(spellAbility, mod, pb));
      repertoire.push(aid(spellAbility, mod, pb), holdPerson(spellAbility, mod, pb), moonbeam(spellAbility, mod, pb));
      repertoire.push(callLightning(spellAbility, mod, pb));
      repertoire.push(blight(spellAbility, mod, pb), fireShield(spellAbility, mod, pb), iceStorm(spellAbility, mod, pb), stoneskin(spellAbility, mod, pb), wallOfFire(spellAbility, mod, pb));
      repertoire.push(coneOfCold(spellAbility, mod, pb), massCureWounds(spellAbility, mod, pb));
      repertoire.push(heal(spellAbility));
      repertoire.push(fireStorm(spellAbility, mod, pb), befuddlement(spellAbility, mod, pb), sunburst(spellAbility, mod, pb));
      repertoire.push(stormOfVengeance(spellAbility, mod, pb));
      break;
    case 'Bard':
      repertoire.push(dissonantWhispers(spellAbility, mod, pb), healingWord(spellAbility, mod, pb), cureWounds(spellAbility, mod, pb), bane(spellAbility, mod, pb), aid(spellAbility, mod, pb));
      repertoire.push(holdPerson(spellAbility, mod, pb), shatter(spellAbility, mod, pb));
      repertoire.push(hypnoticPattern(spellAbility, mod, pb));
      repertoire.push(banishment(spellAbility, mod, pb));
      repertoire.push(holdMonster(spellAbility, mod, pb), massCureWounds(spellAbility, mod, pb), synapticStatic(spellAbility, mod, pb));
      break;
    case 'Paladin':
      repertoire.push(bless(), cureWounds(spellAbility, mod, pb), shieldOfFaith());
      repertoire.push(aid(spellAbility, mod, pb), magicWeapon(spellAbility, mod, pb), shiningSmite(spellAbility, mod, pb));
      repertoire.push(blindingSmite(spellAbility, mod, pb));
      repertoire.push(banishment(spellAbility, mod, pb), deathWard(spellAbility, mod, pb));
      repertoire.push(flameStrike(spellAbility, mod, pb));
      break;
    case 'Ranger':
      repertoire.push(huntersMark(spellAbility, mod, pb), cureWounds(spellAbility, mod, pb), entangle(spellAbility, mod, pb));
      repertoire.push(aid(spellAbility, mod, pb), conjureBarrage(spellAbility, mod, pb), protectionFromEnergy(spellAbility, mod, pb));
      break;
  }

  // Optional spells: available in the party builder picker but not in default loadouts.
  // Mapped per class according to SRD 5.2 spell lists.
  const optional: MonsterAction[] = [];
  switch (className) {
    case 'Wizard':
      optional.push(chromaticOrb(spellAbility, mod, pb), witchBolt(spellAbility, mod, pb));
      optional.push(shield(spellAbility, mod, pb), fogCloud(spellAbility, mod, pb));
      optional.push(falseLife(spellAbility, mod, pb), grease(spellAbility, mod, pb), mageArmor(spellAbility, mod, pb), rayOfSickness(spellAbility, mod, pb), tashasHideousLaughter(spellAbility, mod, pb));
      optional.push(blindnessDeafness(spellAbility, mod, pb), blur(spellAbility, mod, pb), cloudOfDaggers(spellAbility, mod, pb), mirrorImage(spellAbility, mod, pb));
      optional.push(acidArrow(spellAbility, mod, pb), gustOfWind(spellAbility, mod, pb));
      optional.push(mistyStep(spellAbility, mod, pb));
      optional.push(dispelMagic(spellAbility, mod, pb), haste(spellAbility, mod, pb));
      optional.push(counterspell(spellAbility, mod, pb));
      optional.push(bestowCurse(spellAbility, mod, pb), fear(spellAbility, mod, pb), fly(spellAbility, mod, pb));
      optional.push(wallOfFire(spellAbility, mod, pb));
      break;
    case 'Sorcerer':
      optional.push(chromaticOrb(spellAbility, mod, pb), witchBolt(spellAbility, mod, pb));
      optional.push(shield(spellAbility, mod, pb), fogCloud(spellAbility, mod, pb));
      optional.push(falseLife(spellAbility, mod, pb), grease(spellAbility, mod, pb), mageArmor(spellAbility, mod, pb), rayOfSickness(spellAbility, mod, pb), tashasHideousLaughter(spellAbility, mod, pb));
      optional.push(blindnessDeafness(spellAbility, mod, pb), blur(spellAbility, mod, pb), cloudOfDaggers(spellAbility, mod, pb), mirrorImage(spellAbility, mod, pb));
      optional.push(acidArrow(spellAbility, mod, pb), gustOfWind(spellAbility, mod, pb));
      optional.push(mistyStep(spellAbility, mod, pb));
      optional.push(dispelMagic(spellAbility, mod, pb), haste(spellAbility, mod, pb));
      optional.push(counterspell(spellAbility, mod, pb));
      optional.push(fear(spellAbility, mod, pb), fly(spellAbility, mod, pb));
      optional.push(wallOfFire(spellAbility, mod, pb));
      break;
    case 'Warlock':
      optional.push(armorOfAgathys(spellAbility, mod, pb), armsOfHadar(spellAbility, mod, pb), colorSpray(spellAbility, mod, pb));
      optional.push(bestowCurse(spellAbility, mod, pb));
      optional.push(mirrorImage(spellAbility, mod, pb));
      optional.push(dispelMagic(spellAbility, mod, pb));
      break;
    case 'Cleric':
      optional.push(inflictWounds(spellAbility, mod, pb), command(spellAbility, mod, pb));
      optional.push(blindnessDeafness(spellAbility, mod, pb));
      optional.push(lesserRestoration(spellAbility, mod, pb));
      optional.push(dispelMagic(spellAbility, mod, pb));
      optional.push(counterspell(spellAbility, mod, pb));
      optional.push(revivify(spellAbility, mod, pb));
      break;
    case 'Druid':
      optional.push(barkskin(spellAbility, mod, pb), faerieFire(spellAbility, mod, pb), fogCloud(spellAbility, mod, pb), longstrider(spellAbility, mod, pb));
      optional.push(lesserRestoration(spellAbility, mod, pb), gustOfWind(spellAbility, mod, pb), spikeGrowth(spellAbility, mod, pb));
      optional.push(dispelMagic(spellAbility, mod, pb));
      optional.push(fear(spellAbility, mod, pb), fly(spellAbility, mod, pb), revivify(spellAbility, mod, pb));
      optional.push(wallOfFire(spellAbility, mod, pb));
      break;
    case 'Bard':
      optional.push(heroism(spellAbility, mod, pb));
      optional.push(faerieFire(spellAbility, mod, pb), tashasHideousLaughter(spellAbility, mod, pb));
      optional.push(command(spellAbility, mod, pb));
      optional.push(blindnessDeafness(spellAbility, mod, pb), cloudOfDaggers(spellAbility, mod, pb), mirrorImage(spellAbility, mod, pb));
      optional.push(dispelMagic(spellAbility, mod, pb), haste(spellAbility, mod, pb));
      optional.push(bestowCurse(spellAbility, mod, pb), fear(spellAbility, mod, pb), fly(spellAbility, mod, pb));
      break;
    case 'Paladin':
      optional.push(heroism(spellAbility, mod, pb));
      optional.push(divineFavor(spellAbility, mod, pb));
      optional.push(command(spellAbility, mod, pb));
      optional.push(holdPerson(spellAbility, mod, pb), moonbeam(spellAbility, mod, pb), spiritualWeapon(spellAbility, mod, pb));
      optional.push(lesserRestoration(spellAbility, mod, pb));
      optional.push(dispelMagic(spellAbility, mod, pb));
      break;
    case 'Ranger':
      optional.push(faerieFire(spellAbility, mod, pb), longstrider(spellAbility, mod, pb));
      optional.push(protectionFromPoison(spellAbility, mod, pb), spikeGrowth(spellAbility, mod, pb));
      optional.push(dispelMagic(spellAbility, mod, pb));
      break;
  }
  repertoire.push(...optional);

  const seen = new Set<string>();
  return repertoire
    .filter(s => (s.spellLevel ?? 0) <= maxSlot)
    .filter(s => { if (seen.has(s.name)) return false; seen.add(s.name); return true; })
    .map(s => ({ spellLevel: s.spellLevel ?? 0, name: s.name }));
}

/**
 * Build a hero with user-specified overrides. Unlike `buildHero` (which is
 * cached and uses fixed stat arrays), this always creates a fresh MonsterData
 * with the overrides applied. Derived stats (attack bonus, save DCs, HP, AC)
 * are recalculated from the overridden ability scores.
 */
export function buildCustomHero(
  className: HeroClassName, level: number, overrides: HeroOverrides,
): MonsterData {
  const spec = CLASSES[className];
  if (!spec) throw new Error(`Unknown class: ${className}`);
  if (!isSupportedHeroLevel(className, level)) {
    throw new Error(`Level ${level} out of supported range [${MIN_HERO_LEVEL}, ${getMaxHeroLevelForClass(className)}] for ${className}`);
  }
  const heroSubclass = overrides.subclass ?? defaultSubclass(className, level);

  // Start with default abilities, then apply overrides
  const abilities = overrides.abilities
    ? { ...overrides.abilities }
    : abilityArray(spec.primary, spec.secondary, level, spec.tertiary);

  if (!overrides.abilities) {
    applyClassAbilityProgression(className, spec, level, abilities);
  }

  const pb = proficiencyBonus(level);
  const conMod = abilityMod(abilities.con);
  const dexMod = abilityMod(abilities.dex);
  const wisMod = abilityMod(abilities.wis);

  let hp = overrides.hpOverride ?? computeHP(spec.hitDie, conMod, level);
  if (overrides.hpOverride === undefined && className === 'Sorcerer' && level >= 3) hp += level;
  if (overrides.hpOverride === undefined) hp += overrides.hitPointBonus ?? 0;
  const rolledHpBonus = conMod * level + (className === 'Sorcerer' && level >= 3 ? level : 0) + (overrides.hitPointBonus ?? 0);
  const armorOverride = overrides.armorBaseOverride ?? ((className === 'Fighter' || className === 'Paladin' || className === 'Cleric') && level >= 5 ? 18 : undefined);
  const shieldBonus = (overrides.shieldOverride ?? spec.shield) ? 2 : 0;
  let ac = overrides.acOverride ?? (overrides.armorDexCapOverride === undefined ? computeAC({ ...spec, shield: shieldBonus > 0 }, dexMod, wisMod, conMod, armorOverride) : armorOverride! + Math.min(dexMod, overrides.armorDexCapOverride) + shieldBonus);
  if (!overrides.acOverride && className === 'Sorcerer' && level >= 3) ac = 10 + dexMod + abilityMod(abilities.cha);
  if (!overrides.acOverride && hasDefenseStyle(className, level)) ac += 1;
  if (!overrides.acOverride && className === 'Monk' && level >= 5) ac += 1;

  const customWeapons = overrides.weapons?.length
    ? overrides.weapons.map(weaponOverrideToSpec)
    : overrides.weapon
      ? [weaponOverrideToSpec(overrides.weapon)]
      : undefined;
  const weaponSpecs = customWeapons ?? [
    className === 'Monk' ? { ...spec.weapon, die: monkUnarmedDie(level) } : spec.weapon,
    ...(spec.secondaryWeapon ? [spec.secondaryWeapon] : []),
  ];
  const primaryWeapon = weaponSpecs[0];

  const speed: Speed = { walk: (overrides.speedOverride ?? spec.speed) + (className === 'Monk' ? monkUnarmoredMovementBonus(level) : 0) };
  if (className === 'Barbarian' && level >= 5) speed.walk += 10;
  if (className === 'Ranger' && level >= 6) {
    speed.walk += 10;
    speed.climb = speed.walk;
    speed.swim = speed.walk;
  }
  if (className === 'Rogue' && level >= 3) {
    speed.climb = speed.walk;
  }
  if (className === 'Sorcerer' && level >= 14) {
    speed.fly = 60;
  }
  if (overrides.speedPenaltyOverride) speed.walk = Math.max(5, speed.walk - overrides.speedPenaltyOverride);

  const actions: MonsterAction[] = [];
  const masteryActive = hasWeaponMastery(className, level);
  for (const weapon of weaponSpecs) {
    actions.push(makeWeaponAction(spec, weapon, level, abilities, pb, masteryActive));
  }
  const selectedSpells = overrides.spells ? new Set(overrides.spells) : undefined;
  const includeCantrip = Boolean(spec.cantrip) && (
    !selectedSpells ||
    !overrides.spellSelectionIncludesCantrips ||
    selectedSpells.has(spec.cantrip!.name)
  );
  if (spec.cantrip && includeCantrip) {
    actions.push(makeCantripAction(spec.cantrip, level, abilities, pb));
  }

  if (spec.extraAttack && level >= 5) {
    const attackCount = extraAttackCount(className, level);
    actions.unshift({
      name: 'Multiattack',
      type: 'multiattack',
      description: `The ${className.toLowerCase()} makes ${countWord(attackCount)} ${primaryWeapon.name} attacks.`,
    });
  }
  if (className === 'Warlock' && level >= 5 && includeCantrip) {
    const beamCount = eldritchBlastBeamCount(level);
    actions.unshift({
      name: 'Multiattack',
      type: 'multiattack',
      description: `The warlock makes ${countWord(beamCount)} Eldritch Blast attacks.`,
    });
  }

  // Spells: if user specified a spell selection, build from the full available
  // pool (defaults + optional). Otherwise use default class spells only.
  const defaultSpells = buildClassSpells(className, level, abilities, pb);
  if (selectedSpells) {
    const optionalPool = buildOptionalSpells(className, level, abilities, pb);
    const fullPool = [...defaultSpells, ...optionalPool];
    const seen = new Set<string>();
    actions.push(...fullPool.filter(s => {
      if (!selectedSpells.has(s.name) || seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    }));
  } else {
    actions.push(...defaultSpells);
  }
  applyWizardSpellMastery(className, level, actions, 'int', abilityMod(abilities.int), pb);

  const abilityActions = buildClassAbilities(className, level, abilities, pb);
  actions.push(...abilityActions);
  actions.push(...(overrides.additionalActions ?? []));
  const initialResources = { ...buildClassResources(className, level), ...(overrides.additionalResources ?? {}) };

  if (className === 'Paladin' && level >= 2) {
    const weaponNames = new Set(weaponSpecs.map(weapon => weapon.name));
    for (const action of actions) {
      if (action.type !== 'melee' || !weaponNames.has(action.name)) continue;
      action.smiteOnHit = {
        damageType: 'radiant',
        dicePerSlotLevel: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        die: 8,
      };
    }
  }

  const traits: MonsterTrait[] = [];
  for (let l = 1; l <= level; l++) {
    for (const f of spec.features[l] ?? []) {
      traits.push({ name: `L${l} - ${f.name}`, description: f.description });
    }
  }

  const saveAbilities: AbilityKey[] = className === 'Monk' && level >= 14
    ? ['str', 'dex', 'con', 'int', 'wis', 'cha']
    : className === 'Rogue' && level >= 15
      ? ['dex', 'int', 'wis', 'cha']
    : [...spec.saves];
  const saves: Partial<Record<AbilityKey, number>> = {};
  for (const s of saveAbilities) {
    saves[s] = pb + abilityMod(abilities[s]);
  }

  const name = overrides.displayName || `${className} L${level}`;
  const skills = skillsForClass(spec, abilities, pb);
  for (const skill of overrides.originSkills ?? []) {
    const ability = SKILL_ABILITIES[skill];
    if (ability) skills[skill] = Math.max(skills[skill] ?? -Infinity, pb + abilityMod(abilities[ability]));
  }
  const passivePerception = 10 + (skills.Perception ?? abilityMod(abilities.wis));
  const baseSenses = className === 'Paladin' && level >= 19
    ? `Truesight 60 ft., Passive Perception ${passivePerception}`
    : className === 'Ranger' && level >= 18
    ? `Blindsight 30 ft., Passive Perception ${passivePerception}`
    : `Passive Perception ${passivePerception}`;
  const senses = [baseSenses, overrides.additionalSenses].filter(Boolean).join(', ');
  const resistances = [
    ...(className === 'Druid' && level >= 10 ? ['cold'] : []),
    ...(className === 'Sorcerer' && level >= 6 ? ['fire'] : []),
    ...(className === 'Warlock' && level >= 10 ? ['fire'] : []),
    ...(overrides.additionalResistances ?? []),
  ];
  const conditionImmunities = className === 'Druid' && level >= 10 ? ['poisoned'] : undefined;
  const data: MonsterData = {
    name,
    size: overrides.sizeOverride ?? 'Medium',
    type: 'Humanoid (Hero)',
    alignment: overrides.alignmentOverride ?? 'Any Alignment',
    ac, hp,
    wearingHeavyArmor: overrides.wearingHeavyArmor,
    hpFormula: overrides.hpOverride === undefined
      ? `${level}d${spec.hitDie}${rolledHpBonus !== 0 ? formatBonus(rolledHpBonus) : ''}`
      : String(hp),
    speed, abilities, saves,
    skills,
    resistances: resistances.length ? resistances : undefined,
    conditionImmunities,
    senses,
    languages: ['Common', ...(overrides.additionalLanguages ?? [])].join(', '),
    cr: '-', xp: 0,
    proficiencyBonus: pb,
    traits: traits.length ? traits : undefined,
    actions,
    isHero: true,
    heroClass: className,
    heroLevel: level,
    heroSubclass,
    heroSpecies: overrides.species,
    heroSpeciesChoice: overrides.speciesChoice,
    heroSpeciesCastingAbility: overrides.speciesCastingAbility,
    heroBackground: overrides.background,
    originFeat: overrides.originFeat,
    originFeats: overrides.originFeats,
    originSkills: overrides.originSkills,
    originTool: overrides.originTool,
    originTools: overrides.originTools,
    originEquipment: overrides.originEquipment,
    speciesCantrips: overrides.speciesCantrips,
    speciesPreparedSpells: overrides.speciesPreparedSpells,
    preferredWildShapeBeast: overrides.preferredWildShapeBeast,
    initialResources: Object.keys(initialResources).length ? initialResources : undefined,
  };

  return data;
}
