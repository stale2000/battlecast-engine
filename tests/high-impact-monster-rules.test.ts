import { afterEach, describe, expect, it, vi } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { executeTurn } from '../src/engine/ai';
import {
  applyAutoDarts,
  applyDamage,
  applyHealing,
  applyHitPointMaxReduction,
  createCreatureWithFixedHp,
  DEFAULT_TACTICS,
  getEffectiveAbilityScore,
  getEffectiveSaveModifier,
  processHydraEndOfTurn,
  processRegeneration,
  processSourceTurnStartOngoingEffects,
  processTargetTurnEndOngoingEffects,
  processTargetTurnStartOngoingEffects,
  resolveAoE,
  resolveAttack,
  resolveSingleTargetSave,
  tryEscapeContainer,
  type BattleState,
} from '../src/engine/combat';
import type { Creature, MonsterAction, MonsterData } from '../src/types/monster';

function md(name: string): MonsterData {
  const monster = monsters.find(m => m.name === name);
  if (!monster) throw new Error(`Monster not found: ${name}`);
  return monster;
}

function stateWith(creatures: Creature[]): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize: 24,
    teamTactics: DEFAULT_TACTICS,
  };
}

function highHpHero(team: 'red' | 'blue', position: { x: number; y: number }, index = 0): Creature {
  const hero = createCreatureWithFixedHp(buildHero('Fighter', 10), team, position, index);
  hero.currentHp = 500;
  hero.maxHp = 500;
  return hero;
}

function testCreature(name: string, overrides: Partial<MonsterData> = {}): MonsterData {
  return {
    ...md('Commoner'),
    name,
    hp: 100,
    hpFormula: '100',
    ac: 10,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    saves: undefined,
    actions: [{ name: 'Club', type: 'melee', attackBonus: 2, damage: '1d4', damageType: 'bludgeoning', reach: 5, description: '' }],
    traits: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#88 Shadow drain and regeneration profiles', () => {
  it('Shadow Draining Swipe reduces Strength and derived Strength saves', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const shadow = createCreatureWithFixedHp(md('Shadow'), 'red', { x: 5, y: 5 }, 0);
    const target = createCreatureWithFixedHp(testCreature('Strong Target'), 'blue', { x: 6, y: 5 }, 0);
    const action = { ...md('Shadow').actions.find(a => a.name === 'Draining Swipe')!, attackBonus: 99 };
    const beforeScore = getEffectiveAbilityScore(target, 'str');
    const beforeSave = getEffectiveSaveModifier(target, 'str');
    const state = stateWith([shadow, target]);

    resolveAttack(state, shadow, target, action);

    expect(getEffectiveAbilityScore(target, 'str')).toBeLessThan(beforeScore);
    expect(getEffectiveSaveModifier(target, 'str')).toBeLessThan(beforeSave);
    expect(state.logs.some(l => l.action === 'Strength Drain')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.creatureId === target.id && e.label.startsWith('Strength -'))).toBe(true);
  });

  it('Shadow drain kills a creature whose Strength reaches 0 even if HP remains', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const shadow = createCreatureWithFixedHp(md('Shadow'), 'red', { x: 5, y: 5 }, 0);
    const target = createCreatureWithFixedHp(testCreature('Weak Target', {
      abilities: { str: 1, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      hp: 200,
      hpFormula: '200',
    }), 'blue', { x: 6, y: 5 }, 0);
    const action = { ...md('Shadow').actions.find(a => a.name === 'Draining Swipe')!, attackBonus: 99, damage: '1' };
    const state = stateWith([shadow, target]);

    resolveAttack(state, shadow, target, action);

    expect(getEffectiveAbilityScore(target, 'str')).toBe(0);
    expect(target.isAlive).toBe(false);
    expect(state.logs.some(l => l.action === 'Strength Reduced to 0')).toBe(true);
  });

  it('Oni-style regeneration does not clamp death damage to 1 HP, but heals while alive', () => {
    const oni = createCreatureWithFixedHp(md('Oni'), 'red', { x: 5, y: 5 }, 0);
    const attacker = highHpHero('blue', { x: 6, y: 5 });
    const deathState = stateWith([oni, attacker]);

    applyDamage(deathState, oni, 999, 'slashing', attacker);
    expect(oni.isAlive).toBe(false);

    const livingOni = createCreatureWithFixedHp(md('Oni'), 'red', { x: 5, y: 5 }, 1);
    livingOni.currentHp = 1;
    const regenState = stateWith([livingOni, attacker]);
    processRegeneration(regenState, livingOni);

    expect(livingOni.currentHp).toBe(11);
    expect(regenState.logs.some(l => l.action === 'Regeneration')).toBe(true);
  });

  it('Vampire Spawn regeneration is suppressed for one turn by radiant damage', () => {
    const vampire = createCreatureWithFixedHp(md('Vampire Spawn'), 'red', { x: 5, y: 5 }, 0);
    const cleric = highHpHero('blue', { x: 6, y: 5 });
    vampire.currentHp = 20;
    const state = stateWith([vampire, cleric]);

    applyDamage(state, vampire, 1, 'radiant', cleric);
    const afterDamage = vampire.currentHp;
    processRegeneration(state, vampire);

    expect(vampire.currentHp).toBe(afterDamage);
  });
});

describe('#88 Hit Point maximum reduction', () => {
  it('Specter Life Drain reduces max HP by actual damage taken and healing respects the reduced max', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const specter = createCreatureWithFixedHp(md('Specter'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 6, y: 5 });
    const action = { ...md('Specter').actions.find(a => a.name === 'Life Drain')!, attackBonus: 99 };
    const state = stateWith([specter, target]);
    const beforeMax = target.maxHp;

    resolveAttack(state, specter, target, action);

    expect(target.maxHp).toBeLessThan(beforeMax);
    expect(target.currentHp).toBeLessThanOrEqual(target.maxHp);
    expect(state.events.some(e => e.kind === 'effect' && e.creatureId === target.id && e.label.startsWith('Max HP -'))).toBe(true);
    target.currentHp = 1;
    applyHealing(state, target, 999, target, 'Test Heal');
    expect(target.currentHp).toBe(target.maxHp);
  });

  it('Clay Golem Slam reduces max HP only by the acid rider damage actually taken', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const golem = createCreatureWithFixedHp(md('Clay Golem'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 6, y: 5 });
    const action = { ...md('Clay Golem').actions.find(a => a.name === 'Slam')!, attackBonus: 99 };
    const state = stateWith([golem, target]);
    const beforeMax = target.maxHp;

    resolveAttack(state, golem, target, action);

    const reduction = beforeMax - target.maxHp;
    expect(reduction).toBeGreaterThan(0);
    expect(reduction).toBeLessThanOrEqual(12);
  });

  it('Succubus Draining Kiss reduces max HP even when the target succeeds the save', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const succubus = createCreatureWithFixedHp(md('Succubus'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 6, y: 5 });
    const base = md('Succubus').actions.find(a => a.name === 'Draining Kiss')!;
    const kiss = { ...base, savingThrow: { ...base.savingThrow!, dc: 0 } };
    const state = stateWith([succubus, target]);
    const beforeMax = target.maxHp;

    resolveSingleTargetSave(state, succubus, target, kiss);

    expect(target.maxHp).toBeLessThan(beforeMax);
    expect(state.logs.some(l => l.action === 'Hit Point Maximum Reduced')).toBe(true);
  });

  it('a creature dies when Hit Point maximum reaches 0', () => {
    const source = highHpHero('red', { x: 5, y: 5 });
    const target = highHpHero('blue', { x: 6, y: 5 });
    target.maxHp = 10;
    target.currentHp = 10;
    const state = stateWith([source, target]);

    applyHitPointMaxReduction(state, target, 10, source, 'Test Drain');

    expect(target.isAlive).toBe(false);
    expect(target.currentHp).toBe(0);
  });
});

describe('#88 ongoing wounds, poison, and container effects', () => {
  it('Pit Fiend poison blocks healing, ticks damage, and ends on a repeat save', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const pitFiend = createCreatureWithFixedHp(md('Pit Fiend'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 6, y: 5 });
    const baseBite = md('Pit Fiend').actions.find(a => a.name === 'Bite')!;
    const bite = {
      ...baseBite,
      attackBonus: 99,
      conditionOnHit: { ...baseBite.conditionOnHit!, save: { ability: 'con' as const, dc: 99 } },
    };
    const state = stateWith([pitFiend, target]);

    resolveAttack(state, pitFiend, target, bite);

    expect(target.conditions).toContain('poisoned');
    expect(target.ongoingEffects?.some(e => e.key === 'Pit Fiend Poison' && e.noHealing)).toBe(true);
    const hpBeforeHeal = target.currentHp;
    applyHealing(state, target, 50, target, 'Test Heal');
    expect(target.currentHp).toBe(hpBeforeHeal);

    processTargetTurnStartOngoingEffects(state, target);
    expect(target.currentHp).toBeLessThan(hpBeforeHeal);

    target.ongoingEffects![0].saveEnds!.dc = 0;
    processTargetTurnEndOngoingEffects(state, target);
    expect(target.ongoingEffects?.some(e => e.key === 'Pit Fiend Poison')).toBe(false);
    expect(target.conditions).not.toContain('poisoned');
  });

  it('infernal wounds tick each target turn and do not duplicate', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const devil = createCreatureWithFixedHp(md('Bearded Devil'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 6, y: 5 });
    const base = md('Bearded Devil').actions.find(a => a.name === 'Infernal Glaive')!;
    const glaive: MonsterAction = {
      ...base,
      attackBonus: 99,
      effects: base.effects!.map(effect =>
        effect.kind === 'ongoingDamage' ? { ...effect, applySave: { ability: 'con', dc: 99 } } : effect
      ),
    };
    const state = stateWith([devil, target]);

    resolveAttack(state, devil, target, glaive);
    resolveAttack(state, devil, target, glaive);

    expect(target.ongoingEffects?.filter(e => e.key === 'Infernal Wound')).toHaveLength(1);
    const beforeTick = target.currentHp;
    processTargetTurnStartOngoingEffects(state, target);
    expect(target.currentHp).toBeLessThan(beforeTick);
  });

  it('short poison no-healing riders use blocksHealing without fake damage ticks', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const devil = createCreatureWithFixedHp(md('Bearded Devil'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 6, y: 5 });
    const beard = { ...md('Bearded Devil').actions.find(a => a.name === 'Beard')!, attackBonus: 99 };
    const state = stateWith([devil, target]);

    resolveAttack(state, devil, target, beard);

    expect(target.conditions).toContain('poisoned');
    expect(target.ongoingEffects?.some(e => e.key === 'Beard Poison' && e.noHealing && !e.damage)).toBe(true);
    const beforeHeal = target.currentHp;
    applyHealing(state, target, 50, target, 'Test Heal');
    expect(target.currentHp).toBe(beforeHeal);
  });

  it('Vrock Spores ticks poison damage and ends on repeat save', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const vrock = createCreatureWithFixedHp(md('Vrock'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 6, y: 5 });
    const base = md('Vrock').actions.find(a => a.name === 'Spores')!;
    const spores = { ...base, savingThrow: { ...base.savingThrow!, dc: 99 } };
    const state = stateWith([vrock, target]);

    resolveAoE(state, vrock, spores, [target]);

    expect(target.conditions).toContain('poisoned');
    expect(target.ongoingEffects?.some(e => e.key === 'Vrock Spores')).toBe(true);
    const beforeTick = target.currentHp;
    processTargetTurnStartOngoingEffects(state, target);
    expect(target.currentHp).toBeLessThan(beforeTick);

    target.ongoingEffects![0].saveEnds!.dc = 0;
    processTargetTurnEndOngoingEffects(state, target);
    expect(target.ongoingEffects?.some(e => e.key === 'Vrock Spores')).toBe(false);
    expect(target.conditions).not.toContain('poisoned');
  });

  it('Gelatinous Cube Engulf contains targets, grants total cover, ticks on cube turns, and releases on cube death', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const cube = createCreatureWithFixedHp(md('Gelatinous Cube'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 5, y: 5 }, 1);
    const archer = highHpHero('blue', { x: 10, y: 5 }, 2);
    const action = {
      ...md('Gelatinous Cube').actions.find(a => a.name === 'Engulf')!,
      savingThrow: { ...md('Gelatinous Cube').actions.find(a => a.name === 'Engulf')!.savingThrow!, dc: 99 },
    };
    const state = stateWith([cube, target, archer]);

    resolveAoE(state, cube, action, [target]);

    expect(target.containedBy?.key).toBe('Engulf');
    expect(target.conditions).toContain('restrained');
    const hpBeforeArrow = target.currentHp;
    resolveAttack(state, archer, target, {
      name: 'Test Arrow',
      type: 'ranged',
      attackBonus: 99,
      damage: '1d8+4',
      damageType: 'piercing',
      range: { normal: 150, long: 600 },
      description: '',
    });
    expect(target.currentHp).toBe(hpBeforeArrow);
    expect(state.logs.some(l => l.details.includes('total cover'))).toBe(true);

    processSourceTurnStartOngoingEffects(state, cube);
    expect(target.currentHp).toBeLessThan(hpBeforeArrow);

    applyDamage(state, cube, 999, 'force', target);
    expect(target.containedBy).toBeUndefined();
    expect(target.conditions).not.toContain('restrained');
  });

  it('Water Elemental Whelm enforces one Large or two Medium-or-smaller capacity', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const elemental = createCreatureWithFixedHp(md('Water Elemental'), 'red', { x: 5, y: 5 }, 0);
    const first = highHpHero('blue', { x: 5, y: 5 }, 1);
    const second = highHpHero('blue', { x: 6, y: 5 }, 2);
    const third = highHpHero('blue', { x: 7, y: 5 }, 3);
    const action = {
      ...md('Water Elemental').actions.find(a => a.name === 'Whelm')!,
      savingThrow: { ...md('Water Elemental').actions.find(a => a.name === 'Whelm')!.savingThrow!, dc: 99 },
    };
    const state = stateWith([elemental, first, second, third]);

    resolveAoE(state, elemental, action, [first, second, third]);

    expect([first, second, third].filter(c => c.containedBy?.key === 'Whelm')).toHaveLength(2);
    expect(state.logs.some(l => l.details.includes('has no room'))).toBe(true);
  });

  it('contained creatures can spend their action to escape', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const cube = createCreatureWithFixedHp(md('Gelatinous Cube'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 5, y: 5 }, 1);
    const action = {
      ...md('Gelatinous Cube').actions.find(a => a.name === 'Engulf')!,
      savingThrow: { ...md('Gelatinous Cube').actions.find(a => a.name === 'Engulf')!.savingThrow!, dc: 99 },
    };
    const state = stateWith([cube, target]);

    resolveAoE(state, cube, action, [target]);
    target.containedBy!.escapeDc = 1;

    expect(tryEscapeContainer(state, target)).toBe(true);
    expect(target.containedBy).toBeUndefined();
    expect(target.conditions).not.toContain('restrained');
  });

  it('Shambling Mound Engulf uses target-turn container damage', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const mound = createCreatureWithFixedHp(md('Shambling Mound'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 5, y: 5 }, 1);
    const action = {
      ...md('Shambling Mound').actions.find(a => a.name === 'Engulf')!,
      savingThrow: { ...md('Shambling Mound').actions.find(a => a.name === 'Engulf')!.savingThrow!, dc: 99 },
    };
    const state = stateWith([mound, target]);

    resolveAoE(state, mound, action, [target]);
    const beforeTick = target.currentHp;
    processTargetTurnStartOngoingEffects(state, target);

    expect(target.containedBy?.key).toBe('Engulf');
    expect(target.currentHp).toBeLessThan(beforeTick);
  });
});

describe('#88 signature monster traits', () => {
  it('Hydra loses heads, regrows without fire, and fire suppresses regrowth', () => {
    const hydra = createCreatureWithFixedHp(md('Hydra'), 'red', { x: 5, y: 5 }, 0);
    const attacker = highHpHero('blue', { x: 7, y: 5 });
    hydra.currentHp = 100;
    const state = stateWith([hydra, attacker]);

    applyDamage(state, hydra, 25, 'slashing', attacker);
    expect(hydra.hydraHeads?.living).toBe(4);
    expect(state.events.some(e => e.kind === 'effect' && e.creatureId === hydra.id && e.label === 'Head Lost (4)')).toBe(true);
    processHydraEndOfTurn(state, hydra);
    expect(hydra.hydraHeads?.living).toBe(6);
    expect(hydra.currentHp).toBe(95);
    expect(state.events.some(e => e.kind === 'effect' && e.creatureId === hydra.id && e.label === 'Heads +2')).toBe(true);

    applyDamage(state, hydra, 25, 'fire', attacker);
    expect(hydra.hydraHeads?.living).toBe(5);
    processHydraEndOfTurn(state, hydra);
    expect(hydra.hydraHeads?.living).toBe(5);
    expect(state.events.some(e => e.kind === 'effect' && e.creatureId === hydra.id && e.label === 'No Regrowth')).toBe(true);
  });

  it('Hydra bite count follows living head count', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const hydra = createCreatureWithFixedHp(md('Hydra'), 'red', { x: 5, y: 5 }, 0);
    const target = highHpHero('blue', { x: 7, y: 5 });
    hydra.hydraHeads = { living: 3, killedSinceTurn: 0, tookFireSinceTurn: false };
    const state = stateWith([hydra, target]);

    executeTurn(state, hydra);

    expect(state.events.filter(e => e.kind === 'attack' && e.attackerId === hydra.id)).toHaveLength(3);
  });

  it('Balor Death Throes damages nearby creatures once when it dies', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const balor = createCreatureWithFixedHp(md('Balor'), 'red', { x: 5, y: 5 }, 0);
    const near = highHpHero('blue', { x: 6, y: 5 }, 1);
    const far = highHpHero('blue', { x: 20, y: 20 }, 2);
    const state = stateWith([balor, near, far]);
    const nearBefore = near.currentHp;
    const farBefore = far.currentHp;

    applyDamage(state, balor, 999, 'cold', near);

    expect(balor.isAlive).toBe(false);
    expect(near.currentHp).toBeLessThan(nearBefore);
    expect(far.currentHp).toBe(farBefore);
    expect(state.logs.filter(l => l.action === 'Death Throes')).toHaveLength(3);
  });

  it('Tarrasque Reflective Carapace negates Magic Missile on 1-5', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 5), 'blue', { x: 5, y: 5 }, 0);
    const tarrasque = createCreatureWithFixedHp(md('Tarrasque'), 'red', { x: 12, y: 5 }, 0);
    const action = buildHero('Wizard', 5).actions.find(a => a.name === 'Magic Missile')!;
    const state = stateWith([wizard, tarrasque]);
    const wizardBefore = wizard.currentHp;
    const tarrasqueBefore = tarrasque.currentHp;

    applyAutoDarts(state, wizard, action, [tarrasque, tarrasque, tarrasque]);

    expect(tarrasque.currentHp).toBe(tarrasqueBefore);
    expect(wizard.currentHp).toBe(wizardBefore);
    expect(state.logs.some(l => l.action === 'Reflective Carapace')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.creatureId === tarrasque.id && e.label === 'Spell Negated')).toBe(true);
  });

  it('Tarrasque Reflective Carapace reflects Magic Missile on 6', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 5), 'blue', { x: 5, y: 5 }, 0);
    const tarrasque = createCreatureWithFixedHp(md('Tarrasque'), 'red', { x: 12, y: 5 }, 0);
    const action = buildHero('Wizard', 5).actions.find(a => a.name === 'Magic Missile')!;
    const state = stateWith([wizard, tarrasque]);
    const wizardBefore = wizard.currentHp;
    const tarrasqueBefore = tarrasque.currentHp;

    applyAutoDarts(state, wizard, action, [tarrasque, tarrasque, tarrasque]);

    expect(tarrasque.currentHp).toBe(tarrasqueBefore);
    expect(wizard.currentHp).toBeLessThan(wizardBefore);
    expect(state.events.some(e => e.kind === 'effect' && e.creatureId === tarrasque.id && e.label === 'Spell Reflected')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.creatureId === wizard.id && e.label === 'Reflected')).toBe(true);
  });

  it('Tarrasque reflects ranged spell attacks but not ordinary ranged weapon attacks', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 5), 'blue', { x: 5, y: 5 }, 0);
    const tarrasque = createCreatureWithFixedHp(md('Tarrasque'), 'red', { x: 12, y: 5 }, 0);
    const fireBolt = buildHero('Wizard', 5).actions.find(a => a.name === 'Fire Bolt')!;
    const spellState = stateWith([wizard, tarrasque]);
    const wizardBefore = wizard.currentHp;
    const tarrasqueBefore = tarrasque.currentHp;

    resolveAttack(spellState, wizard, tarrasque, fireBolt);

    expect(tarrasque.currentHp).toBe(tarrasqueBefore);
    expect(wizard.currentHp).toBeLessThan(wizardBefore);

    vi.restoreAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const archer = highHpHero('blue', { x: 5, y: 5 }, 1);
    const freshTarrasque = createCreatureWithFixedHp(md('Tarrasque'), 'red', { x: 12, y: 5 }, 1);
    const weaponState = stateWith([archer, freshTarrasque]);
    const freshBefore = freshTarrasque.currentHp;

    resolveAttack(weaponState, archer, freshTarrasque, {
      name: 'Test Arrow',
      type: 'ranged',
      attackBonus: 99,
      damage: '1d8+4',
      damageType: 'piercing',
      range: { normal: 150, long: 600 },
      description: '',
    });

    expect(freshTarrasque.currentHp).toBeLessThan(freshBefore);
    expect(weaponState.logs.some(l => l.action === 'Reflective Carapace')).toBe(false);
  });
});
