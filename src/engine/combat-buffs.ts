/**
 * Buff, resource, and concentration-aura management.
 *
 * Phase 4b refactor: extracted from the original monolithic combat.ts.
 * Covers the four closely-related buff-system concerns:
 *
 *   - Buff CRUD: hasBuff / getBuff / addBuff / removeBuff,
 *     dropConcentratedBuffsFrom, expireBuffsForCreature, resetTurnFlags
 *   - Buff bonus math: roll{Attack,Save}BuffBonus, rollSaveWithBuffs,
 *     getRageDamageBonus, getSpellSaveDcBonus, applyBuffDamageResistance
 *   - Resources: hasResource / consumeResource / restoreResource,
 *     lowest / highestAvailableSlot
 *   - Concentration auras: attachConcentrationAura,
 *     processConcentrationAuras, checkAuraEntry
 *
 * Several functions here delegate to combat.ts's applyDamage / pushLog,
 * which means there's an ESM cycle (combat <-> combat-buffs). This is
 * safe because every cross-module call happens inside a function body
 * (lazy named-binding), not at module init - same pattern as the
 * ai-loop <-> ai cycle from the AI refactor.
 */
import { ActiveBuff, Condition, Creature, MonsterAction } from '../types/monster.js';
import { BASE_DURATIONS } from '../types/animation.js';
import { rollDice, rollSave } from './dice.js';
import { distance } from './combat-geometry.js';
import {
  applyDamage, pushLog, getEffectiveAbilityScore, getEffectiveSaveModifier, hasActiveTrait,
  type BattleState,
} from './combat.js';
import { revealVisibleHiddenCreatures } from './visibility.js';

// ─────────────────────────────────────────────────────────────────────
// Buff bonus math
// ─────────────────────────────────────────────────────────────────────

/** Sum the dice bonuses on a creature's attack rolls (Bless = "1d4"). */
export function rollAttackBuffBonus(attacker: Creature): number {
  let total = 0;
  // Test fixtures pre-date activeBuffs; guard against missing field.
  for (const b of attacker.activeBuffs ?? []) {
    total += b.attackBonus ?? 0;
    if (b.attackBonusDice) total += rollDice(b.attackBonusDice).total;
  }
  return total;
}

/**
 * Sum the dice bonuses on a creature's saves (Bless = "1d4", Bane = "-1d4").
 * Returns a rolled integer.
 */
export function rollSaveBuffBonus(saver: Creature): number {
  let total = 0;
  for (const b of saver.activeBuffs ?? []) {
    if (b.saveBonusDice) total += rollDice(b.saveBonusDice).total;
  }
  return total;
}

/**
 * Rage damage bonus for Strength-based weapon attacks. 2024 Rage applies to
 * thrown Strength weapons too, so the action's attackAbility matters.
 */
export function getRageDamageBonus(attacker: Creature, actionOrType: MonsterAction | string | undefined): number {
  if (typeof actionOrType === 'object') {
    const action = actionOrType;
    const isWeaponAttack = action.type === 'melee' || action.type === 'ranged';
    const usesStrength = action.attackAbility ? action.attackAbility === 'str' : action.type === 'melee';
    if (!isWeaponAttack || !usesStrength) return 0;
  } else if (actionOrType !== 'melee' && actionOrType !== undefined) {
    return 0;
  }
  for (const b of attacker.activeBuffs ?? []) {
    if (b.rageDamageBonus) return b.rageDamageBonus;
  }
  return 0;
}

/** Apply effects such as Ray of Enfeeblement after a creature rolls damage. */
export function applyDamageRollPenalty(creature: Creature, damage: number): number {
  const penalty = (creature.activeBuffs ?? []).reduce(
    (total, buff) => total + (buff.damageRollPenalty ? rollDice(buff.damageRollPenalty).total : 0),
    0,
  );
  return Math.max(0, damage - penalty);
}

/** Sum active spell-save DC bonuses, e.g. Sorcerer Innate Sorcery. */
export function getSpellSaveDcBonus(caster: Creature, action?: MonsterAction): number {
  if (action && action.spellLevel === undefined) return 0;
  let total = 0;
  for (const b of caster.activeBuffs ?? []) {
    total += b.spellSaveDcBonus ?? 0;
  }
  return total;
}

/**
 * Roll a saving throw and add all active save-buff dice (Bless "+1d4",
 * Bane "-1d4"). Returns a mutated RollResult whose total reflects the
 * buffs - use this instead of raw rollSave() anywhere a creature's
 * activeBuffs should count.
 *
 * Indomitable (Fighter L9+): rerolls a failed save once per resource use.
 */
export function rollSaveWithBuffs(
  saver: Creature,
  mod: number,
  advantage: boolean = false,
  dc?: number,
  ability?: keyof Creature['monsterData']['abilities'],
  condition?: Condition,
): ReturnType<typeof rollSave> {
  const isBarbarian = saver.monsterData.heroClass === 'Barbarian';
  const barbarianLevel = saver.monsterData.heroLevel ?? 0;
  const rageActive = hasBuff(saver, 'rage');
  const barbarianSaveAdvantage =
    isBarbarian &&
    !saver.conditions.includes('incapacitated') &&
    (
      (ability === 'dex' && barbarianLevel >= 2) ||
      (ability === 'str' && rageActive)
    );
  const gnomishCunning = saver.monsterData.heroSpecies === 'Gnome'
    && (ability === 'int' || ability === 'wis' || ability === 'cha');
  const speciesConditionAdvantage =
    (saver.monsterData.heroSpecies === 'Dwarf' && condition === 'poisoned') ||
    (saver.monsterData.heroSpecies === 'Elf' && condition === 'charmed') ||
    (saver.monsterData.heroSpecies === 'Halfling' && condition === 'frightened');
  const saveDisadvantageKeys = (saver.activeBuffs ?? [])
    .filter(b => b.saveDisadvantage)
    .map(b => b.key);

  const halflingLuck = saver.monsterData.heroSpecies === 'Halfling';
  const strengthTestDisadvantage = ability === 'str' && (saver.activeBuffs ?? []).some(buff => buff.strengthTestDisadvantage);
  const result = rollSave(mod, advantage || barbarianSaveAdvantage || gnomishCunning || speciesConditionAdvantage, saveDisadvantageKeys.length > 0 || strengthTestDisadvantage, halflingLuck);
  if (saveDisadvantageKeys.length > 0) {
    saver.activeBuffs = saver.activeBuffs.filter(b => !saveDisadvantageKeys.includes(b.key));
  }
  const bonus = rollSaveBuffBonus(saver);
  if (bonus !== 0) {
    result.total += bonus;
    result.modifier += bonus;
  }
  if (ability === 'str' && isBarbarian && barbarianLevel >= 18) {
    const strengthScore = getEffectiveAbilityScore(saver, 'str');
    if (result.total < strengthScore) result.total = strengthScore;
  }
  if (dc !== undefined && result.total < dc
      && saver.monsterData.heroClass === 'Monk' && (saver.monsterData.heroLevel ?? 0) >= 14
      && hasResource(saver, 'ki')) {
    consumeResource(saver, 'ki');
    const reroll = rollSave(mod, advantage || barbarianSaveAdvantage || gnomishCunning || speciesConditionAdvantage, false, halflingLuck);
    const rerollBonus = rollSaveBuffBonus(saver);
    reroll.total += rerollBonus;
    reroll.modifier += rerollBonus;
    saver.stats.actionUsage['Disciplined Survivor'] = (saver.stats.actionUsage['Disciplined Survivor'] || 0) + 1;
    return reroll;
  }
  if (dc !== undefined && result.total < dc
      && saver.monsterData.heroClass === 'Fighter' && (saver.monsterData.heroLevel ?? 0) >= 9
      && hasResource(saver, 'indomitable')) {
    consumeResource(saver, 'indomitable');
    const reroll = rollSave(mod, advantage || speciesConditionAdvantage, false, halflingLuck);
    const rerollBonus = rollSaveBuffBonus(saver);
    reroll.total += rerollBonus + (saver.monsterData.heroLevel ?? 0);
    reroll.modifier += rerollBonus;
    saver.stats.actionUsage['Indomitable'] = (saver.stats.actionUsage['Indomitable'] || 0) + 1;
    return reroll;
  }
  return result;
}

/**
 * Apply Rage-style physical damage resistance (halves bludgeoning, piercing,
 * slashing damage). Returns the post-resist damage integer.
 */
export function applyBuffDamageResistance(target: Creature, damage: number, damageType: string): number {
  const dt = damageType.toLowerCase();
  for (const b of target.activeBuffs ?? []) {
    if (b.resistAllDamageExcept && !b.resistAllDamageExcept.some(except => dt.includes(except.toLowerCase()))) {
      return Math.floor(damage / 2);
    }
    if (b.resistDamageTypes?.some(type => dt.includes(type.toLowerCase()))) {
      return Math.floor(damage / 2);
    }
  }
  const physical = /bludgeon|pierc|slash/i.test(damageType);
  if (!physical) return damage;
  for (const b of target.activeBuffs ?? []) {
    if (b.resistPhysical) return Math.floor(damage / 2);
  }
  return damage;
}

// ─────────────────────────────────────────────────────────────────────
// Resources (spell slots, ki, action surge, indomitable, etc.)
// ─────────────────────────────────────────────────────────────────────

export function hasResource(creature: Creature, key: string, amount: number = 1): boolean {
  return (creature.resources[key] ?? 0) >= amount;
}

/**
 * Spend `amount` of the named resource. Returns true if successfully
 * consumed, false if the creature doesn't have enough (and state is
 * unchanged). Callers should check hasResource first or handle the false.
 */
export function consumeResource(creature: Creature, key: string, amount: number = 1): boolean {
  const have = creature.resources[key] ?? 0;
  if (have < amount) return false;
  creature.resources[key] = have - amount;
  return true;
}

/** Restore resource up to its max (from initialResources). Used for short-rest recharges. */
export function restoreResource(creature: Creature, key: string, amount: number = 1): void {
  const cap = creature.monsterData.initialResources?.[key] ?? Infinity;
  const curr = creature.resources[key] ?? 0;
  creature.resources[key] = Math.min(cap, curr + amount);
}

/**
 * Returns the lowest spell-slot level the creature still has available,
 * or null if out. Used by casting logic + Paladin Divine Smite (which
 * burns the lowest slot for a fixed smite size).
 */
export function lowestAvailableSlot(creature: Creature): number | null {
  for (let lvl = 1; lvl <= 9; lvl++) {
    if (hasResource(creature, `slot-${lvl}`)) return lvl;
  }
  return null;
}

/** Highest slot level the creature has available (for best-spell casting). */
export function highestAvailableSlot(creature: Creature): number | null {
  for (let lvl = 9; lvl >= 1; lvl--) {
    if (hasResource(creature, `slot-${lvl}`)) return lvl;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Buff CRUD
// ─────────────────────────────────────────────────────────────────────

/** True if a buff with the given key is currently on the creature. */
export function hasBuff(creature: Creature, key: string): boolean {
  return (creature.activeBuffs ?? []).some(b => b.key === key);
}

export function getBuff(creature: Creature, key: string): ActiveBuff | undefined {
  return creature.activeBuffs.find(b => b.key === key);
}

/**
 * Attach a buff to the target. If a buff with the same key is already
 * present, it's replaced (i.e., refreshed - never stack Bless with Bless).
 */
export function addBuff(creature: Creature, buff: ActiveBuff): void {
  creature.activeBuffs = creature.activeBuffs.filter(b => b.key !== buff.key);
  creature.activeBuffs.push(buff);
}

/** Remove a buff by key. No-op if not present. */
export function removeBuff(creature: Creature, key: string): void {
  creature.activeBuffs = creature.activeBuffs.filter(b => b.key !== key);
}

/**
 * Remove every buff sourced by the given caster that requires that caster's
 * concentration. Called when the caster loses concentration (fails a CON
 * save, starts a new concentration spell, or dies).
 */
export function dropConcentratedBuffsFrom(
  state: BattleState,
  casterId: string,
  options: { preserveRelentlessHunter?: boolean } = {},
): void {
  state.darknessZones = state.darknessZones?.filter(zone =>
    !(zone.requiresConcentration && zone.sourceId === casterId)
  );
  const caster = state.creatures.find(c => c.id === casterId);
  const preserveHuntersMark = options.preserveRelentlessHunter
    && caster?.monsterData.heroClass === 'Ranger'
    && (caster.monsterData.heroLevel ?? 0) >= 13;
  for (const c of state.creatures) {
    if (!c.activeBuffs) continue;
    c.activeBuffs = c.activeBuffs.filter(b =>
      !(b.requiresConcentration && b.casterId === casterId && !(preserveHuntersMark && b.key === 'hunters-mark'))
    );
    if (c.id === casterId && c.concentrationAura) {
      state.events.push({
        kind: 'concentrationAura', creatureId: c.id, active: false,
        spellName: c.concentrationAura.spellName, damageType: c.concentrationAura.damageType,
        radiusFt: c.concentrationAura.radiusFt, origin: c.concentrationAura.origin,
        point: c.concentrationAura.point, durationMs: 0,
      });
      c.concentrationAura = undefined;
    }
  }
  const stillConcentrating = state.creatures.some(creature =>
    creature.activeBuffs?.some(buff => buff.requiresConcentration && buff.casterId === casterId)
  ) || state.darknessZones?.some(zone => zone.requiresConcentration && zone.sourceId === casterId);
  if (caster?.concentratingOn && !stillConcentrating) caster.concentratingOn = undefined;
  revealVisibleHiddenCreatures(state);
}

/**
 * Tick buff durations at the START of the casting-creature's turn (SRD
 * "beginning of your turn" rule). Buffs whose endRound has passed are
 * removed, along with their concentration effects.
 */
export function expireBuffsForCreature(creature: Creature, currentRound: number): void {
  creature.activeBuffs = creature.activeBuffs.filter(b => b.endRound > currentRound);
}

/** Remove source-turn mastery debuffs at the start of the source creature's next turn. */
export function expireSourceTurnBuffs(state: BattleState, source: Creature): void {
  for (const c of state.creatures) {
    c.activeBuffs = (c.activeBuffs ?? []).filter(b =>
      !(b.expiresOnSourceTurnStart && b.casterId === source.id && b.appliedRound < state.round)
    );
  }
}

/**
 * Resource housekeeping at turn start. Clears Sneak Attack's
 * once-per-turn gate, resets reaction availability, etc.
 */
export function resetTurnFlags(creature: Creature): void {
  creature.turnFlags = {};
}

// ─────────────────────────────────────────────────────────────────────
// Concentration auras (Moonbeam, Spirit Guardians, Call Lightning, ...)
// ─────────────────────────────────────────────────────────────────────

/**
 * Attach a concentration aura to the caster (Moonbeam, Spirit Guardians, etc.).
 * Tracks the aura's center / radius / save info so per-turn ticks and
 * movement-entry checks can re-resolve damage.
 */
export function attachConcentrationAura(state: BattleState, caster: Creature, action: MonsterAction, center?: { x: number; y: number }): void {
  if (!action.concentration || !action.savingThrow?.damageOnFail || !(action.durationRounds && action.durationRounds > 0)) return;
  caster.concentratingOn = action.name;
  const area = action.savingThrow.area ?? '';
  const radiusMatch = area.match(/(\d+)[\s-]?foot/i);
  const radiusFt = radiusMatch ? parseInt(radiusMatch[1]) : 15;
  const isEmanation = area.toLowerCase().includes('emanation');
  const origin: 'caster' | 'point' = isEmanation ? 'caster' : 'point';
  const point = isEmanation ? undefined : (center ?? { ...caster.position });
  caster.concentrationAura = {
    spellName: action.name,
    damageDice: action.savingThrow.damageOnFail,
    damageType: action.damageType || 'untyped',
    saveAbility: action.savingThrow.ability,
    saveDC: action.savingThrow.dc + getSpellSaveDcBonus(caster, action),
    radiusFt, origin, point,
  };
  state.events.push({
    kind: 'concentrationAura', creatureId: caster.id, active: true,
    spellName: action.name, damageType: action.damageType || 'untyped',
    radiusFt, origin, point, durationMs: 0,
  });
}

/**
 * On the affected creature's turn start, tick every enemy concentration
 * aura the creature is currently inside. One save per aura per round.
 */
export function processConcentrationAuras(state: BattleState, creature: Creature): void {
  for (const other of state.creatures) {
    if (!other.isAlive || !other.concentrationAura || other.id === creature.id) continue;
    if (other.team === creature.team) continue;

    const aura = other.concentrationAura!;
    const center = aura.origin === 'caster' ? other.position : aura.point!;
    const dist = distance(creature.position, center);
    if (dist > aura.radiusFt) continue;

    const saveMod = getEffectiveSaveModifier(creature, aura.saveAbility, state);
    const hasMR = hasActiveTrait(creature, 'Magic Resistance');
    const save = rollSaveWithBuffs(creature, saveMod, hasMR, aura.saveDC, aura.saveAbility);
    const passed = save.total >= aura.saveDC;

    state.events.push({ kind: 'save', targetId: creature.id, success: passed, durationMs: BASE_DURATIONS.save });

    const dmg = rollDice(aura.damageDice).total;
    const actualDmg = passed ? Math.floor(dmg / 2) : dmg;

    pushLog(state, {
      round: state.round, turn: state.turnIndex,
      actor: creature.displayName, action: aura.spellName,
      details: `${creature.displayName} ${passed ? 'resists' : 'fails against'} ${other.displayName}'s ${aura.spellName}! (${save.total} vs DC ${aura.saveDC}) Takes ${actualDmg} ${aura.damageType} damage${passed ? ' (half)' : ''}!`,
      damage: actualDmg,
      type: 'damage'
    });

    const hpBefore = creature.currentHp;
    state.events.push({ kind: 'hit', targetId: creature.id, damage: actualDmg, damageType: aura.damageType, critical: false, targetHpBefore: hpBefore, targetHpAfter: hpBefore, durationMs: BASE_DURATIONS.hit });
    applyDamage(state, creature, actualDmg, aura.damageType, other, false, true);
    const hitEvt = state.events[state.events.length - (creature.isAlive ? 1 : 2)] as { kind: 'hit'; targetHpAfter: number };
    if (hitEvt.kind === 'hit') hitEvt.targetHpAfter = creature.currentHp;
  }
}

/**
 * Movement-entry check: when `creature` moves from `oldPos` to its new
 * position, resolve damage for every enemy aura it just entered, plus
 * (if the creature itself has a caster-centered aura) every enemy that
 * just entered the creature's aura.
 */
export function checkAuraEntry(
  state: BattleState, creature: Creature,
  oldPos: { x: number; y: number },
): void {
  if (!creature.isAlive) return;
  for (const other of state.creatures) {
    if (!other.isAlive || !other.concentrationAura || other.id === creature.id) continue;
    if (other.team === creature.team) continue;
    const aura = other.concentrationAura;
    const center = aura.origin === 'caster' ? other.position : aura.point!;
    const distNow = distance(creature.position, center);
    const distBefore = distance(oldPos, center);
    if (distNow <= aura.radiusFt && distBefore > aura.radiusFt) {
      const saveMod = getEffectiveSaveModifier(creature, aura.saveAbility, state);
      const hasMR = hasActiveTrait(creature, 'Magic Resistance');
      const save = rollSaveWithBuffs(creature, saveMod, hasMR, aura.saveDC, aura.saveAbility);
      const passed = save.total >= aura.saveDC;
      state.events.push({ kind: 'save', targetId: creature.id, success: passed, durationMs: BASE_DURATIONS.save });
      const dmg = rollDice(aura.damageDice).total;
      const actualDmg = passed ? Math.floor(dmg / 2) : dmg;
      pushLog(state, {
        round: state.round, turn: state.turnIndex,
        actor: creature.displayName, action: aura.spellName,
        details: `${creature.displayName} enters ${other.displayName}'s ${aura.spellName}! ${passed ? 'Resists' : 'Fails'} (${save.total} vs DC ${aura.saveDC}) Takes ${actualDmg} ${aura.damageType} damage${passed ? ' (half)' : ''}!`,
        damage: actualDmg, type: 'damage'
      });
      const hpBefore = creature.currentHp;
      state.events.push({ kind: 'hit', targetId: creature.id, damage: actualDmg, damageType: aura.damageType, critical: false, targetHpBefore: hpBefore, targetHpAfter: hpBefore, durationMs: BASE_DURATIONS.hit });
      applyDamage(state, creature, actualDmg, aura.damageType, other, false, true);
      const hitEvt = state.events[state.events.length - (creature.isAlive ? 1 : 2)] as { kind: 'hit'; targetHpAfter: number };
      if (hitEvt.kind === 'hit') hitEvt.targetHpAfter = creature.currentHp;
    }
  }
  // Also check: did this creature's own aura catch new enemies after moving?
  if (creature.concentrationAura && creature.concentrationAura.origin === 'caster') {
    for (const enemy of state.creatures) {
      if (!enemy.isAlive || enemy.id === creature.id || enemy.team === creature.team) continue;
      const distNow = distance(enemy.position, creature.position);
      const distBefore = distance(enemy.position, oldPos);
      if (distNow <= creature.concentrationAura.radiusFt && distBefore > creature.concentrationAura.radiusFt) {
        const aura = creature.concentrationAura;
        const saveMod = getEffectiveSaveModifier(enemy, aura.saveAbility, state);
        const hasMR = hasActiveTrait(enemy, 'Magic Resistance');
        const save = rollSaveWithBuffs(enemy, saveMod, hasMR, aura.saveDC, aura.saveAbility);
        const passed = save.total >= aura.saveDC;
        state.events.push({ kind: 'save', targetId: enemy.id, success: passed, durationMs: BASE_DURATIONS.save });
        const dmg = rollDice(aura.damageDice).total;
        const actualDmg = passed ? Math.floor(dmg / 2) : dmg;
        pushLog(state, {
          round: state.round, turn: state.turnIndex,
          actor: enemy.displayName, action: aura.spellName,
          details: `${enemy.displayName} enters ${creature.displayName}'s ${aura.spellName}! ${passed ? 'Resists' : 'Fails'} (${save.total} vs DC ${aura.saveDC}) Takes ${actualDmg} ${aura.damageType} damage${passed ? ' (half)' : ''}!`,
          damage: actualDmg, type: 'damage'
        });
        const hpBefore = enemy.currentHp;
        state.events.push({ kind: 'hit', targetId: enemy.id, damage: actualDmg, damageType: aura.damageType, critical: false, targetHpBefore: hpBefore, targetHpAfter: hpBefore, durationMs: BASE_DURATIONS.hit });
        applyDamage(state, enemy, actualDmg, aura.damageType, creature, false, true);
        const hitEvt = state.events[state.events.length - (enemy.isAlive ? 1 : 2)] as { kind: 'hit'; targetHpAfter: number };
        if (hitEvt.kind === 'hit') hitEvt.targetHpAfter = enemy.currentHp;
      }
    }
  }
}
