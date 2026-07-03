import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero, HERO_CLASS_NAMES, MIN_HERO_LEVEL, getMaxHeroLevelForClass } from '../src/data/heroes';
import { rollDice } from '../src/engine/dice';
import type { MechanicsStatus, MonsterAction, MonsterTrait, RuntimeActionEffect, RuntimeTraitEffect } from '../src/types/monster';

const VALID_CONDITIONS = [
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified',
  'poisoned', 'prone', 'restrained', 'stunned', 'unconscious',
];

const VALID_SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];

const DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning',
  'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
];

type MechanicsEntry = {
  owner: string;
  kind: 'action' | 'trait';
  name: string;
  description: string;
  effects?: RuntimeActionEffect[] | RuntimeTraitEffect[];
  mechanicsStatus?: MechanicsStatus;
};

function hasImplementedOrDeferredStatus(entry: MechanicsEntry): boolean {
  return entry.mechanicsStatus?.status === 'implemented' || entry.mechanicsStatus?.status === 'deferred';
}

function hasActionEffect(entry: MechanicsEntry, kind: RuntimeActionEffect['kind']): boolean {
  return entry.kind === 'action' && (entry.effects as RuntimeActionEffect[] | undefined)?.some(effect => effect.kind === kind) === true;
}

function hasTraitEffect(entry: MechanicsEntry, kind: RuntimeTraitEffect['kind']): boolean {
  return entry.kind === 'trait' && (entry.effects as RuntimeTraitEffect[] | undefined)?.some(effect => effect.kind === kind) === true;
}

function highImpactMechanicsIssues(entries: MechanicsEntry[]): string[] {
  const issues: string[] = [];
  for (const entry of entries) {
    const desc = entry.description.toLowerCase();
    const label = `${entry.owner} → ${entry.name}`;
    const covered = hasImplementedOrDeferredStatus(entry);

    if (desc.includes('strength score decreases') && !covered && !hasActionEffect(entry, 'abilityScoreDrain')) {
      issues.push(`${label}: Strength drain text needs abilityScoreDrain or mechanicsStatus`);
    }

    if (desc.includes('hit point maximum decreases') && !covered && !hasActionEffect(entry, 'hpMaxReduction')) {
      issues.push(`${label}: HP maximum reduction text needs hpMaxReduction or mechanicsStatus`);
    }

    if ((desc.includes('if it has at least 1 hit point') || desc.includes('dies only if it starts its turn with 0 hit points')) &&
        !covered && !hasTraitEffect(entry, 'regeneration')) {
      issues.push(`${label}: regeneration profile text needs regeneration trait effect or mechanicsStatus`);
    }

    if ((/takes .* damage at the start of each of .*turns/.test(desc) || /loses .* hit points at the start of each of .*turns/.test(desc)) &&
        !covered && entry.name !== 'Swallow' && !hasActionEffect(entry, 'ongoingDamage') && !hasActionEffect(entry, 'container')) {
      issues.push(`${label}: ongoing start-of-turn damage needs ongoingDamage/container or mechanicsStatus`);
    }

    const selfOnlyNoHealing = entry.kind === 'trait' && entry.name === 'Swarm' && desc.includes("the swarm can't regain");
    if (desc.includes("can't regain hit points") && !selfOnlyNoHealing &&
        !covered && !hasActionEffect(entry, 'blocksHealing') &&
        !((entry.effects as RuntimeActionEffect[] | undefined)?.some(effect => effect.kind === 'ongoingDamage' && effect.noHealing))) {
      issues.push(`${label}: no-healing text needs blocksHealing/ongoingDamage(noHealing) or mechanicsStatus`);
    }

    if (desc.includes('engulfed') && !covered && !hasActionEffect(entry, 'container')) {
      issues.push(`${label}: engulfed text needs container effect or mechanicsStatus`);
    }

    if (desc.includes('swallowed') && !covered && entry.name !== 'Swallow' && !hasActionEffect(entry, 'container')) {
      issues.push(`${label}: swallowed text needs Swallow implementation, container effect, or mechanicsStatus`);
    }

    if (desc.includes('possessed') && !covered) {
      issues.push(`${label}: possession text needs implemented state or mechanicsStatus`);
    }

    if (desc.includes('reflects the spell') && !covered && !hasTraitEffect(entry, 'spellReflection')) {
      issues.push(`${label}: spell reflection text needs spellReflection trait effect or mechanicsStatus`);
    }

    if (desc.includes('antimagic') && !covered) {
      issues.push(`${label}: antimagic text needs implemented state or mechanicsStatus`);
    }

    if (entry.name === 'Death Throes' && !covered && !hasTraitEffect(entry, 'deathBurst')) {
      issues.push(`${label}: Death Throes needs deathBurst trait effect or mechanicsStatus`);
    }

    if (desc.includes('head dies') && !covered && !hasTraitEffect(entry, 'hydraHeads')) {
      issues.push(`${label}: hydra head text needs hydraHeads trait effect or mechanicsStatus`);
    }
  }
  return issues;
}

describe('Monster data validation', () => {
  it('all monsters have valid size', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      if (!VALID_SIZES.includes(m.size)) {
        issues.push(`${m.name}: invalid size "${m.size}"`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('hpFormula parses without error', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      try {
        rollDice(m.hpFormula);
      } catch {
        issues.push(`${m.name}: hpFormula "${m.hpFormula}" fails to parse`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('actions with damage have damageType', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      for (const a of m.actions) {
        if (a.damage && !a.damageType) {
          issues.push(`${m.name} → ${a.name}: has damage "${a.damage}" but no damageType`);
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('AoE spells with damageOnFail have damageType or parseable type in description', () => {
    const typePattern = /\b(acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder)\b/i;
    const issues: string[] = [];
    for (const m of monsters) {
      for (const a of m.actions) {
        if (a.savingThrow?.damageOnFail && !a.damageType) {
          if (!typePattern.test(a.description)) {
            issues.push(`${m.name} → ${a.name}: AoE damage but no damageType and can't infer from description`);
          }
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('multiattack descriptions reference existing actions', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      const multi = m.actions.find(a => a.type === 'multiattack');
      if (!multi) continue;
      const desc = multi.description.toLowerCase();
      const otherActions = m.actions.filter(a => a.type !== 'multiattack');
      // Check that at least one named action from the creature appears in the multiattack description
      const anyMatch = otherActions.some(a =>
        desc.includes(a.name.toLowerCase().split('(')[0].trim())
      );
      if (!anyMatch && !desc.includes('eye ray') && !desc.includes('reel')) {
        issues.push(`${m.name}: multiattack "${multi.description}" doesn't reference any known action`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('legendaryActionUses > 0 requires legendaryActions array', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      if ((m.legendaryActionUses ?? 0) > 0 && (!m.legendaryActions || m.legendaryActions.length === 0)) {
        issues.push(`${m.name}: has legendaryActionUses=${m.legendaryActionUses} but no legendaryActions`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('legendary action actionRef matches an existing action name', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      if (!m.legendaryActions) continue;
      for (const la of m.legendaryActions) {
        if (la.actionRef) {
          const found = m.actions.some(a => a.name === la.actionRef);
          if (!found) {
            issues.push(`${m.name} LA "${la.name}": actionRef "${la.actionRef}" not found in actions`);
          }
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('conditionOnHit uses valid condition names', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      for (const a of m.actions) {
        if (a.conditionOnHit?.condition && !VALID_CONDITIONS.includes(a.conditionOnHit.condition)) {
          issues.push(`${m.name} → ${a.name}: invalid condition "${a.conditionOnHit.condition}"`);
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('savingThrow conditionOnFail uses valid condition names', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      for (const a of m.actions) {
        if (a.savingThrow?.conditionOnFail && !VALID_CONDITIONS.includes(a.savingThrow.conditionOnFail)) {
          issues.push(`${m.name} → ${a.name}: invalid save condition "${a.savingThrow.conditionOnFail}"`);
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('initialResources keys referenced by resourceCost exist', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      for (const a of m.actions) {
        if (a.resourceCost) {
          const key = a.resourceCost.key;
          // Spell slots (slot-1, slot-2, etc.) are dynamically created, skip
          if (key.startsWith('slot-')) continue;
          if (!m.initialResources || !(key in m.initialResources)) {
            issues.push(`${m.name} → ${a.name}: resourceCost key "${key}" not in initialResources`);
          }
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('melee actions with "or range" in description have range field', () => {
    const rangePattern = /reach \d+ ft\. or range (\d+)/i;
    const issues: string[] = [];
    for (const m of monsters) {
      for (const a of m.actions) {
        if (rangePattern.test(a.description) && !a.range) {
          issues.push(`${m.name} → ${a.name}: description says ranged but no range field`);
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('all damageType values are valid D&D damage types', () => {
    const issues: string[] = [];
    for (const m of monsters) {
      for (const a of m.actions) {
        if (a.damageType && !DAMAGE_TYPES.includes(a.damageType)) {
          issues.push(`${m.name} → ${a.name}: unknown damageType "${a.damageType}"`);
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('creatures with resistances/immunities use valid damage types', () => {
    const validTypes = [...DAMAGE_TYPES, 'nonmagical', 'bludgeoning, piercing, and slashing from nonmagical attacks'];
    const issues: string[] = [];
    for (const m of monsters) {
      for (const r of m.resistances ?? []) {
        if (!validTypes.some(v => r.toLowerCase().includes(v))) {
          issues.push(`${m.name}: unknown resistance "${r}"`);
        }
      }
      for (const i of m.immunities ?? []) {
        if (!validTypes.some(v => i.toLowerCase().includes(v))) {
          issues.push(`${m.name}: unknown immunity "${i}"`);
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('high-impact monster rules are either modeled with runtime hooks or explicitly deferred', () => {
    const entries: MechanicsEntry[] = monsters.flatMap(monster => [
      ...(monster.traits ?? []).map((trait: MonsterTrait) => ({
        owner: monster.name,
        kind: 'trait' as const,
        name: trait.name,
        description: trait.description,
        effects: trait.effects,
        mechanicsStatus: trait.mechanicsStatus,
      })),
      ...monster.actions.map((action: MonsterAction) => ({
        owner: monster.name,
        kind: 'action' as const,
        name: action.name,
        description: action.description,
        effects: action.effects,
        mechanicsStatus: action.mechanicsStatus,
      })),
    ]);

    expect(highImpactMechanicsIssues(entries)).toEqual([]);
  });

  it('high-impact validation fails for unmodeled synthetic HP max reduction text', () => {
    const issues = highImpactMechanicsIssues([{
      owner: 'Synthetic Monster',
      kind: 'action',
      name: 'Life Drain',
      description: "The target's Hit Point maximum decreases by an amount equal to the damage taken.",
    }]);

    expect(issues).toEqual([
      'Synthetic Monster → Life Drain: HP maximum reduction text needs hpMaxReduction or mechanicsStatus',
    ]);
  });
});

describe('Hero data validation', () => {
  it('all hero classes build without error at every level', () => {
    const issues: string[] = [];
    for (const cls of HERO_CLASS_NAMES) {
      for (let level = MIN_HERO_LEVEL; level <= getMaxHeroLevelForClass(cls); level++) {
        try {
          const hero = buildHero(cls, level);
          if (!hero.name) issues.push(`${cls} L${level}: empty name`);
          if (hero.hp <= 0) issues.push(`${cls} L${level}: HP <= 0`);
          if (hero.ac <= 0) issues.push(`${cls} L${level}: AC <= 0`);
          if (hero.actions.length === 0) issues.push(`${cls} L${level}: no actions`);
        } catch (e) {
          issues.push(`${cls} L${level}: build failed: ${e}`);
        }
      }
    }
    expect(issues).toEqual([]);
  });

  it('hero weapon actions have attack bonus and damage', () => {
    const issues: string[] = [];
    for (const cls of HERO_CLASS_NAMES) {
      const hero = buildHero(cls, 5);
      const weapons = hero.actions.filter(a => a.type === 'melee' || a.type === 'ranged');
      for (const w of weapons) {
        if (w.attackBonus === undefined) issues.push(`${cls} → ${w.name}: no attackBonus`);
        if (!w.damage) issues.push(`${cls} → ${w.name}: no damage`);
        if (!w.damageType) issues.push(`${cls} → ${w.name}: no damageType`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('hero AC increases or stays stable from L1 to L6', () => {
    const issues: string[] = [];
    for (const cls of HERO_CLASS_NAMES) {
      let prevAC = 0;
      for (let level = MIN_HERO_LEVEL; level <= getMaxHeroLevelForClass(cls); level++) {
        const hero = buildHero(cls, level);
        if (hero.ac < prevAC) {
          issues.push(`${cls}: AC decreased from L${level - 1} (${prevAC}) to L${level} (${hero.ac})`);
        }
        prevAC = hero.ac;
      }
    }
    expect(issues).toEqual([]);
  });

  it('hero HP increases each level', () => {
    const issues: string[] = [];
    for (const cls of HERO_CLASS_NAMES) {
      let prevHP = 0;
      for (let level = MIN_HERO_LEVEL; level <= getMaxHeroLevelForClass(cls); level++) {
        const hero = buildHero(cls, level);
        if (hero.hp <= prevHP) {
          issues.push(`${cls}: HP did not increase from L${level - 1} (${prevHP}) to L${level} (${hero.hp})`);
        }
        prevHP = hero.hp;
      }
    }
    expect(issues).toEqual([]);
  });
});
