// Dice rolling engine for D&D 5e combat

import { engineRandom } from './rng.js';

export interface RollResult {
  total: number;
  rolls: number[];
  modifier: number;
  expression: string;
  isCritical?: boolean;
  isFumble?: boolean;
}

// Parse and roll dice expressions like "2d6+3", "1d20", "4d8+2d6+5"
export function rollDice(expression: string, rerollOnes = false): RollResult {
  const cleaned = expression.replace(/\s/g, '');
  let total = 0;
  const allRolls: number[] = [];
  let totalModifier = 0;

  // Split on + and - while keeping the sign
  const parts = cleaned.match(/[+-]?[^+-]+/g) || [];

  for (const part of parts) {
    const sign = part.startsWith('-') ? -1 : 1;
    const cleaned_part = part.replace(/^[+-]/, '');

    if (cleaned_part.includes('d')) {
      const [countStr, sidesStr] = cleaned_part.split('d');
      const count = parseInt(countStr) || 1;
      const sides = parseInt(sidesStr);

      for (let i = 0; i < count; i++) {
        let roll = Math.floor(engineRandom() * sides) + 1;
        if (rerollOnes && roll === 1) roll = Math.floor(engineRandom() * sides) + 1;
        allRolls.push(roll * sign);
        total += roll * sign;
      }
    } else {
      const mod = parseInt(cleaned_part) * sign;
      totalModifier += mod;
      total += mod;
    }
  }

  return {
    total: Math.max(0, total),
    rolls: allRolls,
    modifier: totalModifier,
    expression,
  };
}

// Roll a d20 attack roll
export function rollD20(): RollResult {
  const roll = Math.floor(engineRandom() * 20) + 1;
  return {
    total: roll,
    rolls: [roll],
    modifier: 0,
    expression: '1d20',
    isCritical: roll === 20,
    isFumble: roll === 1,
  };
}

// Roll an attack with modifier and advantage/disadvantage
export function rollAttack(
  modifier: number,
  advantage: boolean = false,
  disadvantage: boolean = false,
  rerollNaturalOnes: boolean = false,
): { roll: RollResult; naturalRoll: number } {
  let roll1 = Math.floor(engineRandom() * 20) + 1;
  let roll2 = Math.floor(engineRandom() * 20) + 1;
  if (rerollNaturalOnes && roll1 === 1) roll1 = Math.floor(engineRandom() * 20) + 1;
  if (rerollNaturalOnes && roll2 === 1) roll2 = Math.floor(engineRandom() * 20) + 1;

  let naturalRoll: number;
  if (advantage && !disadvantage) {
    naturalRoll = Math.max(roll1, roll2);
  } else if (disadvantage && !advantage) {
    naturalRoll = Math.min(roll1, roll2);
  } else {
    naturalRoll = roll1;
  }

  return {
    roll: {
      total: naturalRoll + modifier,
      rolls: advantage || disadvantage ? [roll1, roll2] : [naturalRoll],
      modifier,
      expression: `1d20+${modifier}`,
      isCritical: naturalRoll === 20,
      isFumble: naturalRoll === 1,
    },
    naturalRoll,
  };
}

// Roll saving throw
export function rollSave(
  modifier: number,
  advantage: boolean = false,
  disadvantage: boolean = false,
  rerollNaturalOnes: boolean = false,
): RollResult {
  const { roll } = rollAttack(modifier, advantage, disadvantage, rerollNaturalOnes);
  return roll;
}

// Calculate modifier from ability score
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

// Roll initiative
export function rollInitiative(dexMod: number, rerollOnOne = false): number {
  let roll = Math.floor(engineRandom() * 20) + 1;
  if (rerollOnOne && roll === 1) roll = Math.floor(engineRandom() * 20) + 1;
  return roll + dexMod;
}

// Roll damage with possible critical (double dice)
export function rollDamage(expression: string, critical: boolean = false, rerollOnes = false): RollResult {
  if (!critical) {
    return rollDice(expression, rerollOnes);
  }

  // On critical, double the dice but not the modifier
  const cleaned = expression.replace(/\s/g, '');
  const parts = cleaned.match(/[+-]?[^+-]+/g) || [];
  let critExpression = '';

  for (const part of parts) {
    const sign = part.startsWith('-') ? '-' : part.startsWith('+') ? '+' : '';
    const cleaned_part = part.replace(/^[+-]/, '');

    if (cleaned_part.includes('d')) {
      const [countStr, sidesStr] = cleaned_part.split('d');
      const count = (parseInt(countStr) || 1) * 2; // double dice
      critExpression += `${sign}${count}d${sidesStr}`;
    } else {
      critExpression += `${sign}${cleaned_part}`;
    }
  }

  if (critExpression.startsWith('+')) critExpression = critExpression.slice(1);
  return rollDice(critExpression, rerollOnes);
}

/** Roll a simple exploding damage expression such as 1d8 or 2d8+2. */
export function rollExplodingDamage(expression: string, critical = false, rerollOnes = false): RollResult {
  const cleaned = expression.replace(/\s/g, '');
  const match = cleaned.match(/^([+-]?\d+)?d(\d+)([+-]\d+)?$/i);
  if (!match) return rollDamage(expression, critical, rerollOnes);
  const count = (parseInt(match[1] ?? '1', 10) || 1) * (critical ? 2 : 1);
  const sides = parseInt(match[2], 10);
  const modifier = parseInt(match[3] ?? '0', 10) || 0;
  const rolls: number[] = [];
  let total = modifier;
  let pending = count;
  let guard = 0;
  while (pending-- > 0 && guard++ < 1000) {
    let roll = Math.floor(engineRandom() * sides) + 1;
    if (rerollOnes && roll === 1) roll = Math.floor(engineRandom() * sides) + 1;
    rolls.push(roll);
    total += roll;
    if (roll === sides) pending++;
  }
  return { total: Math.max(0, total), rolls, modifier, expression };
}

// Parse a damage string to get average damage
export function averageDamage(expression: string): number {
  const cleaned = expression.replace(/\s/g, '');
  const parts = cleaned.match(/[+-]?[^+-]+/g) || [];
  let total = 0;

  for (const part of parts) {
    const sign = part.startsWith('-') ? -1 : 1;
    const cleaned_part = part.replace(/^[+-]/, '');

    if (cleaned_part.includes('d')) {
      const [countStr, sidesStr] = cleaned_part.split('d');
      const count = parseInt(countStr) || 1;
      const sides = parseInt(sidesStr);
      total += count * ((sides + 1) / 2) * sign;
    } else {
      total += parseInt(cleaned_part) * sign;
    }
  }

  return total;
}

// Parse a dice expression and return the maximum possible roll. Used by
// features such as Life Cleric Supreme Healing that replace healing dice
// rolls with their maximum values.
export function maxDiceTotal(expression: string): number {
  const cleaned = expression.replace(/\s/g, '');
  const parts = cleaned.match(/[+-]?[^+-]+/g) || [];
  let total = 0;

  for (const part of parts) {
    const sign = part.startsWith('-') ? -1 : 1;
    const cleanedPart = part.replace(/^[+-]/, '');

    if (cleanedPart.includes('d')) {
      const [countStr, sidesStr] = cleanedPart.split('d');
      const count = parseInt(countStr) || 1;
      const sides = parseInt(sidesStr);
      total += count * sides * sign;
    } else {
      total += parseInt(cleanedPart) * sign;
    }
  }

  return Math.max(0, total);
}
