import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applyDamage, applyHealing, createCreatureWithFixedHp, initBattle,
  runDeathSave, getStandingCreatures, getRecoverableCreatures, checkBattleComplete,
} from '../src/engine/combat';
import { applyEventToReplay, snapshotCreatures } from '../src/engine/animation-replay';
import { selectTarget } from '../src/engine/ai-targeting';
import { runMonteCarlo } from '../src/engine/ai';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { MonsterData, Creature, BattleState } from '../src/types/monster';
import { AnimationEvent } from '../src/types/animation';
import { executeTurn } from '../src/engine/ai-turn';

/**
 * Coverage for feature #35 - death saves + healing downed heroes.
 *
 * The dying state machine lives in two places: applyDamage routes hero
 * 0-HP drops into Downed, and runDeathSave resolves the per-turn d20 in
 * processTurnStart. The big invariants we want to nail down:
 *
 *  - Heroes don't get instant-killed at 0 HP unless damage is massive
 *  - Death saves resolve deterministically with snapshots in the
 *    AnimationEvent stream so replay never drifts
 *  - Healing of any amount revives from Downed
 *  - AI prioritises healing dying allies and deprioritises attacking them
 *  - Battle completes when one team has zero standing creatures (downed
 *    counts as out of the fight)
 */

function makeMonster(name: string, hp = 100): MonsterData {
  return {
    name,
    size: 'Medium',
    type: 'beast',
    alignment: 'neutral',
    ac: 12,
    hp,
    hpFormula: '20d8',
    speed: { walk: 30 },
    abilities: { str: 14, dex: 10, con: 10, int: 4, wis: 10, cha: 10 },
    senses: '',
    languages: '',
    cr: '1',
    xp: 200,
    proficiencyBonus: 2,
    actions: [
      { name: 'Slam', type: 'melee', attackBonus: 4, damage: '1d6+2', damageType: 'bludgeoning', reach: 5, description: '.' },
    ],
  };
}

function makeHero(hp = 12, pos = { x: 5, y: 5 }): Creature {
  const data: MonsterData = {
    ...makeMonster('Test Hero', hp),
    isHero: true,
    heroClass: 'Fighter',
    heroLevel: 1,
  };
  return createCreatureWithFixedHp(data, 'blue', pos, 0);
}

function makeMonsterCreature(name = 'Goblin', pos = { x: 6, y: 5 }, hp = 100): Creature {
  return createCreatureWithFixedHp(makeMonster(name, hp), 'red', pos, 1);
}

function setupHero(opts: { hp?: number; pos?: { x: number; y: number }; attackerPos?: { x: number; y: number } } = {}): { state: BattleState; hero: Creature; attacker: Creature } {
  const hero = makeHero(opts.hp ?? 12, opts.pos);
  const attacker = makeMonsterCreature('Goblin', opts.attackerPos ?? { x: 6, y: 5 });
  const state = initBattle([hero, attacker], 20);
  return { state, hero, attacker };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
// State entry: hero hits 0 HP
// ────────────────────────────────────────────────────────────────────

describe('hero hitting 0 HP', () => {
  it('enters Downed (dying=true, isAlive=true, unconscious) instead of dying outright', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    expect(hero.isAlive).toBe(true);
    expect(hero.dying).toBe(true);
    expect(hero.currentHp).toBe(0);
    expect(hero.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(hero.conditions).toContain('unconscious');
    expect(hero.stats.timesDowned).toBe(1);
  });

  it('pushes a `downed` AnimationEvent so replay can show the state change', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    const downedEvt = state.events.find(e => e.kind === 'downed');
    expect(downedEvt).toBeDefined();
    expect(downedEvt && (downedEvt as { creatureId: string }).creatureId).toBe(hero.id);
  });

  it('monsters at 0 HP still die immediately (no downed state for them)', () => {
    const goblin = makeMonsterCreature('Goblin', { x: 5, y: 5 }, 10);
    const attacker = makeMonsterCreature('Bigger Goblin', { x: 6, y: 5 }, 100);
    attacker.team = 'blue';
    const state = initBattle([goblin, attacker], 20);
    applyDamage(state, goblin, 30, 'slashing', attacker, true);
    expect(goblin.isAlive).toBe(false);
    expect(goblin.dying).toBeFalsy();
  });

  it('massive damage (overflow >= maxHp) kills outright, skipping Downed', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    // hero at 10 HP, take 30 damage. overflow = 20 >= maxHp 12 → instant death.
    applyDamage(state, hero, 30, 'slashing', attacker, true);
    expect(hero.isAlive).toBe(false);
    expect(hero.dying).toBeFalsy();
  });

  it('non-massive damage at 0 HP correctly Downs the hero', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 12, 'slashing', attacker, true);
    // overflow = 2 < maxHp 12 → Downed, not dead
    expect(hero.isAlive).toBe(true);
    expect(hero.dying).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Damage on a dying hero
// ────────────────────────────────────────────────────────────────────

describe('damage to a dying hero', () => {
  it('ranged hit adds 1 death-save failure, leaves HP at 0', () => {
    const { state, hero, attacker } = setupHero({ hp: 10, attackerPos: { x: 15, y: 5 } });
    applyDamage(state, hero, 15, 'slashing', attacker, true); // Down
    applyDamage(state, hero, 5, 'piercing', attacker, true);  // Ranged (10 ft away)
    expect(hero.currentHp).toBe(0);
    expect(hero.deathSaves?.failures).toBe(1);
  });

  it('melee hit from within 5 ft adds 2 death-save failures (SRD 2024 simplification)', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true); // Down
    applyDamage(state, hero, 5, 'slashing', attacker, true);  // melee, adjacent
    expect(hero.deathSaves?.failures).toBe(2);
  });

  it('AoE damage (no attacker provided) adds 1 death-save failure', () => {
    const { state, hero } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', null);
    expect(hero.dying).toBe(true);
    applyDamage(state, hero, 8, 'fire', null);
    expect(hero.deathSaves?.failures).toBe(1);
  });

  it('massive damage on a dying hero kills outright', () => {
    const { state, hero, attacker } = setupHero({ hp: 12 });
    applyDamage(state, hero, 12, 'slashing', attacker, true); // Down (no overflow)
    expect(hero.dying).toBe(true);
    applyDamage(state, hero, 12, 'slashing', attacker, true); // massive damage at maxHp threshold
    expect(hero.isAlive).toBe(false);
    expect(hero.dying).toBeFalsy();
  });

  it('three accumulated failures from damage kill the hero', () => {
    const { state, hero, attacker } = setupHero({ hp: 10, attackerPos: { x: 15, y: 5 } });
    applyDamage(state, hero, 15, 'slashing', attacker, true); // Down
    applyDamage(state, hero, 1, 'piercing', attacker, true);  // 1 fail
    applyDamage(state, hero, 1, 'piercing', attacker, true);  // 2 fails
    applyDamage(state, hero, 1, 'piercing', attacker, true);  // 3 fails → dead
    expect(hero.isAlive).toBe(false);
  });

  it('pushes deathSaveFail events for replay determinism', () => {
    const { state, hero, attacker } = setupHero({ hp: 10, attackerPos: { x: 15, y: 5 } });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    applyDamage(state, hero, 3, 'piercing', attacker, true);
    const failEvt = state.events.find(e => e.kind === 'deathSaveFail');
    expect(failEvt).toBeDefined();
    if (failEvt && failEvt.kind === 'deathSaveFail') {
      expect(failEvt.creatureId).toBe(hero.id);
      expect(failEvt.failuresAfter).toBe(1);
      expect(failEvt.fromMeleeAdj).toBe(false);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Death save rolls
// ────────────────────────────────────────────────────────────────────

describe('runDeathSave roll outcomes', () => {
  function setupDyingHero(): { state: BattleState; hero: Creature } {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    return { state, hero };
  }

  it('roll 10-19 adds one success', () => {
    const { state, hero } = setupDyingHero();
    vi.spyOn(Math, 'random').mockReturnValue(0.55); // → 12
    runDeathSave(state, hero);
    expect(hero.deathSaves?.successes).toBe(1);
    expect(hero.deathSaves?.failures).toBe(0);
    expect(hero.dying).toBe(true);
  });

  it('roll 2-9 adds one failure', () => {
    const { state, hero } = setupDyingHero();
    vi.spyOn(Math, 'random').mockReturnValue(0.25); // → 6
    runDeathSave(state, hero);
    expect(hero.deathSaves?.failures).toBe(1);
    expect(hero.dying).toBe(true);
  });

  it('roll 1 adds two failures (crit fail)', () => {
    const { state, hero } = setupDyingHero();
    vi.spyOn(Math, 'random').mockReturnValue(0.0); // → 1
    runDeathSave(state, hero);
    expect(hero.deathSaves?.failures).toBe(2);
  });

  it('roll 20 pops the hero back at 1 HP and clears dying + unconscious', () => {
    const { state, hero } = setupDyingHero();
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // → 20
    runDeathSave(state, hero);
    expect(hero.dying).toBeFalsy();
    expect(hero.currentHp).toBe(1);
    expect(hero.conditions).not.toContain('unconscious');
    expect(hero.stats.timesPoppedAtOneHp).toBe(1);
    expect(hero.deathSaves).toBeUndefined();
  });

  it('three successes stabilise the hero (stays unconscious, dying cleared)', () => {
    const { state, hero } = setupDyingHero();
    vi.spyOn(Math, 'random').mockReturnValue(0.55); // 12 - success
    runDeathSave(state, hero);
    runDeathSave(state, hero);
    runDeathSave(state, hero);
    expect(hero.dying).toBeFalsy();
    expect(hero.isAlive).toBe(true);
    expect(hero.conditions).toContain('unconscious'); // still out for the fight
    expect(hero.currentHp).toBe(0);
  });

  it('three failures kill the hero permanently', () => {
    const { state, hero } = setupDyingHero();
    vi.spyOn(Math, 'random').mockReturnValue(0.25); // 6 - failure
    runDeathSave(state, hero);
    runDeathSave(state, hero);
    runDeathSave(state, hero);
    expect(hero.isAlive).toBe(false);
    expect(hero.dying).toBeFalsy();
  });

  it('pushes a deathSave event with the rolled d20 for replay', () => {
    const { state, hero } = setupDyingHero();
    vi.spyOn(Math, 'random').mockReturnValue(0.55); // → 12
    runDeathSave(state, hero);
    const saveEvt = state.events.find(e => e.kind === 'deathSave');
    expect(saveEvt).toBeDefined();
    if (saveEvt && saveEvt.kind === 'deathSave') {
      expect(saveEvt.roll).toBe(12);
      expect(saveEvt.outcome).toBe('success');
      expect(saveEvt.successesAfter).toBe(1);
      expect(saveEvt.failuresAfter).toBe(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Healing a dying hero
// ────────────────────────────────────────────────────────────────────

describe('applyHealing on a dying hero', () => {
  it('reviving heal sets HP to the heal amount and clears dying + unconscious', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    expect(hero.dying).toBe(true);
    const healer = makeHero(20, { x: 4, y: 5 });
    healer.team = 'blue';
    state.creatures.push(healer);

    applyHealing(state, hero, 6, healer, 'Healing Word');
    expect(hero.dying).toBeFalsy();
    expect(hero.currentHp).toBe(6);
    expect(hero.conditions).not.toContain('unconscious');
    expect(hero.stats.timesRevived).toBe(1);
    expect(healer.stats.alliesRevived).toBe(1);
  });

  it('reviving heal pushes a `stabilise` event for replay', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    const healer = makeHero(20, { x: 4, y: 5 });
    healer.team = 'blue';
    state.creatures.push(healer);
    applyHealing(state, hero, 5, healer, 'Healing Word');
    const stab = state.events.find(e => e.kind === 'stabilise');
    expect(stab).toBeDefined();
    if (stab && stab.kind === 'stabilise') {
      expect(stab.hpAfter).toBe(5);
    }
  });

  it('healing a permanently-dead creature is a no-op', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 50, 'slashing', attacker, true); // massive damage → dead
    expect(hero.isAlive).toBe(false);
    const healer = makeHero();
    applyHealing(state, hero, 10, healer, 'Healing Word');
    expect(hero.isAlive).toBe(false);
    expect(hero.currentHp).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Concentration drops on going Downed
// ────────────────────────────────────────────────────────────────────

describe('concentration on Downed', () => {
  it('drops concentration buffs the dying hero was holding', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    const ally = makeHero(20, { x: 4, y: 5 });
    ally.team = 'blue';
    state.creatures.push(ally);
    // Simulate hero casting Bless (concentration) on ally
    hero.concentratingOn = 'bless';
    ally.activeBuffs = [{
      name: 'Bless', key: 'bless', casterId: hero.id,
      appliedRound: 1, endRound: 100,
      requiresConcentration: true,
      attackBonusDice: '1d4',
    }];
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    expect(hero.dying).toBe(true);
    expect(ally.activeBuffs).toHaveLength(0);
    expect(hero.concentratingOn).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// AI behaviour
// ────────────────────────────────────────────────────────────────────

describe('AI target selection', () => {
  it('deprioritises dying enemies in favor of standing ones', () => {
    const { state, hero, attacker } = setupHero({ hp: 10, pos: { x: 5, y: 5 }, attackerPos: { x: 6, y: 5 } });
    const standingHero = makeHero(20, { x: 10, y: 5 });
    standingHero.team = 'blue';
    state.creatures.push(standingHero);
    applyDamage(state, hero, 15, 'slashing', attacker, true); // Down hero
    expect(hero.dying).toBe(true);

    const target = selectTarget(state, attacker, 'nearest');
    expect(target?.id).toBe(standingHero.id);
  });

  it('falls back to dying enemy when no standing enemies remain', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    const target = selectTarget(state, attacker, 'nearest');
    expect(target?.id).toBe(hero.id);
  });

  it('the finishDowned tactic flips behaviour: dying enemy gets picked over standing one', () => {
    const { state, hero, attacker } = setupHero({ hp: 10, pos: { x: 5, y: 5 }, attackerPos: { x: 6, y: 5 } });
    const standingHero = makeHero(20, { x: 10, y: 5 });
    standingHero.team = 'blue';
    state.creatures.push(standingHero);
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    expect(hero.dying).toBe(true);
    // Attacker is red, so set redFinishDowned. With the toggle on,
    // the dying hero is adjacent (1 ft) and the standing hero is 5
    // squares away. Nearest tactic picks the dying one.
    state.teamTactics = { ...state.teamTactics, redFinishDowned: true };
    const target = selectTarget(state, attacker, 'nearest');
    expect(target?.id).toBe(hero.id);
  });
});

describe('multiattack respects finishDowned across follow-up swings', () => {
  it('attack #1 downs the hero -> attack #2 retargets a standing ally when finishDowned=false', () => {
    // Setup: Owlbear-style attacker with multiattack. Hero A goes down
    // on the first Rend; the second Rend should retarget to hero B
    // (still standing) rather than landing another hit on dying A.
    const heroA = makeHero(10, { x: 5, y: 5 });
    const heroB = makeHero(20, { x: 5, y: 6 });
    heroB.team = 'blue';
    const beastData: MonsterData = {
      ...makeMonster('Big Beast', 100),
      actions: [
        { name: 'Multiattack', type: 'multiattack', description: 'The beast makes two Rend attacks.' },
        { name: 'Rend', type: 'melee', attackBonus: 20, damage: '1d4', damageType: 'slashing', reach: 5, description: '.' },
      ],
    };
    const beast = createCreatureWithFixedHp(beastData, 'red', { x: 6, y: 5 }, 0);
    const state = initBattle([heroA, heroB, beast], 20);
    state.teamTactics = { ...state.teamTactics, red: 'smart', redFinishDowned: false };

    // Drop heroA to dying first so the multiattack picker sees the
    // post-down state when it re-evaluates between swings.
    applyDamage(state, heroA, 15, 'slashing', beast, true);
    expect(heroA.dying).toBe(true);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    executeTurn(state, beast);

    // With finishDowned off, the beast should switch to heroB after
    // dropping heroA. Verify heroA didn't accumulate extra death-save
    // failures from a follow-up swing.
    expect(heroA.deathSaves?.failures ?? 0).toBe(0);
    // And heroB should have taken hits (damage > 0).
    expect(heroB.stats.damageTaken).toBeGreaterThan(0);
  });

  it('attack #1 downs the hero -> attack #2 finishes them off when finishDowned=true', () => {
    const heroA = makeHero(10, { x: 5, y: 5 });
    const heroB = makeHero(20, { x: 5, y: 6 });
    heroB.team = 'blue';
    const beastData: MonsterData = {
      ...makeMonster('Big Beast', 100),
      actions: [
        { name: 'Multiattack', type: 'multiattack', description: 'The beast makes two Rend attacks.' },
        { name: 'Rend', type: 'melee', attackBonus: 20, damage: '1d4', damageType: 'slashing', reach: 5, description: '.' },
      ],
    };
    const beast = createCreatureWithFixedHp(beastData, 'red', { x: 6, y: 5 }, 0);
    const state = initBattle([heroA, heroB, beast], 20);
    state.teamTactics = { ...state.teamTactics, red: 'smart', redFinishDowned: true };

    applyDamage(state, heroA, 15, 'slashing', beast, true);
    expect(heroA.dying).toBe(true);
    const heroBDamageBefore = heroB.stats.damageTaken;

    executeTurn(state, beast);

    // With finishDowned on, the beast should keep hitting heroA -
    // adjacent melee = 2 fails per hit. Two swings could either land
    // 2 fails (one hit) or 3+ (both hit, cap kills). Either way at
    // least one failure landed on heroA, and heroB should have been
    // ignored (no damage delta).
    const heroAdied = !heroA.isAlive;
    const heroAfailures = heroA.deathSaves?.failures ?? (heroAdied ? 3 : 0);
    expect(heroAdied || heroAfailures >= 2).toBe(true);
    expect(heroB.stats.damageTaken).toBe(heroBDamageBefore);
  });
});

describe('AI healer behaviour', () => {
  it("Cleric's Healing Word picks a dying ally over a wounded standing ally", () => {
    const cleric = buildHero('Cleric', 3);
    const c = createCreatureWithFixedHp(cleric, 'blue', { x: 5, y: 5 }, 0);
    c.resources['slot-1'] = 2;
    c.resources['slot-2'] = 2;

    const dying = makeHero(15, { x: 4, y: 5 });
    dying.team = 'blue';
    const wounded = makeHero(12, { x: 6, y: 5 });
    wounded.team = 'blue';
    wounded.currentHp = 4; // hurt but conscious
    const enemy = makeMonsterCreature('Wolf', { x: 10, y: 5 }, 50);
    const state = initBattle([c, dying, wounded, enemy], 20);
    // Down the dying hero
    applyDamage(state, dying, 18, 'slashing', enemy, true);
    expect(dying.dying).toBe(true);

    // Execute cleric's turn - they should heal the dying ally
    executeTurn(state, c);

    // After cleric's turn the dying hero is either healed back up, or a
    // heal event was pushed targeting the dying hero. We don't assume
    // which heal spell got picked, just that healing happened on the
    // dying target.
    const healEvent = state.events.find(e => e.kind === 'heal' && e.creatureId === dying.id);
    expect(healEvent).toBeDefined();
    expect(dying.dying).toBeFalsy();
  });
});

// ────────────────────────────────────────────────────────────────────
// Battle completion
// ────────────────────────────────────────────────────────────────────

describe('battle completion', () => {
  it('getStandingCreatures excludes dying heroes', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    expect(getStandingCreatures(state, 'blue')).toHaveLength(0);
    expect(getStandingCreatures(state, 'red')).toHaveLength(1);
  });

  it('getRecoverableCreatures INCLUDES a dying hero (still in the fight)', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    expect(getRecoverableCreatures(state, 'blue')).toHaveLength(1);
  });

  it('a team with a dying hero keeps the battle going (so they can roll death saves)', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    checkBattleComplete(state);
    expect(state.isComplete).toBe(false);
  });

  it('battle ends once the lone dying hero is permanently dead', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 50, 'slashing', attacker, true); // massive damage → instant death
    checkBattleComplete(state);
    expect(state.isComplete).toBe(true);
    expect(state.winner).toBe('red');
  });

  it('battle ends once the lone dying hero stabilises (no healer = no path back)', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    vi.spyOn(Math, 'random').mockReturnValue(0.55); // 12 - success
    runDeathSave(state, hero);
    runDeathSave(state, hero);
    runDeathSave(state, hero); // stabilises - dying=false, unconscious=true
    expect(hero.dying).toBeFalsy();
    expect(hero.conditions).toContain('unconscious');
    checkBattleComplete(state);
    expect(state.isComplete).toBe(true);
    expect(state.winner).toBe('red');
  });
});

// ────────────────────────────────────────────────────────────────────
// Replay determinism
// ────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// Edge cases surfaced in code review
// ────────────────────────────────────────────────────────────────────

describe('healing a stabilised-unconscious hero', () => {
  it('wakes them up and restores HP (any heal on a 0-HP unconscious creature)', () => {
    // Build a stabilised hero: 3 successful death saves, dying cleared,
    // still unconscious at 0 HP. This is the "healer arrived too late
    // to revive but in time to wake them after their saves landed" case.
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    vi.spyOn(Math, 'random').mockReturnValue(0.55); // 12 - success
    runDeathSave(state, hero);
    runDeathSave(state, hero);
    runDeathSave(state, hero);
    expect(hero.dying).toBeFalsy();
    expect(hero.conditions).toContain('unconscious');
    expect(hero.currentHp).toBe(0);
    vi.restoreAllMocks();

    const healer = makeHero(20, { x: 4, y: 5 });
    healer.team = 'blue';
    state.creatures.push(healer);
    applyHealing(state, hero, 6, healer, 'Cure Wounds');
    expect(hero.currentHp).toBe(6);
    expect(hero.conditions).not.toContain('unconscious');
    expect(hero.stats.timesRevived).toBe(1);
  });
});

describe('Sleep-ed creatures + battle completion', () => {
  it('a team of all-Sleeped-but-healthy creatures keeps the battle going', () => {
    // Existing engine pre-#35 left the battle running while creatures
    // were merely unconscious from Sleep. My first cut of
    // getRecoverableCreatures broke this. Lock down the fix: a creature
    // at full HP with the unconscious condition (Sleep) is still
    // recoverable.
    const sleeper = makeMonsterCreature('Sleeper', { x: 5, y: 5 }, 30);
    sleeper.conditions = ['unconscious'];
    const attacker = makeMonsterCreature('Attacker', { x: 6, y: 5 }, 30);
    attacker.team = 'blue';
    const state = initBattle([sleeper, attacker], 20);
    checkBattleComplete(state);
    expect(state.isComplete).toBe(false);
  });
});

describe('Uncanny Dodge does not fire on a dying Rogue', () => {
  it('a dying Rogue takes a ranged hit as a death-save failure, not a halved-damage event', () => {
    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 5), 'blue', { x: 5, y: 5 }, 0);
    const archer = makeMonsterCreature('Archer', { x: 15, y: 5 }, 50);
    const state = initBattle([rogue, archer], 20);
    // Pre-fire Uncanny Dodge so the down-hit doesn't get halved.
    rogue.reactionUsed = true;
    applyDamage(state, rogue, rogue.maxHp + 2, 'slashing', archer, true);
    expect(rogue.dying).toBe(true);
    // Now reset the reaction (a new round) and confirm that the next hit
    // on the dying Rogue does NOT consume Uncanny Dodge - they're
    // unconscious, can't take reactions.
    rogue.reactionUsed = false;
    const failsBefore = rogue.deathSaves!.failures;
    applyDamage(state, rogue, 8, 'piercing', archer, true);
    expect(rogue.reactionUsed).toBe(false);
    expect(rogue.deathSaves?.failures).toBe(failsBefore + 1);
  });
});

describe('critical hits on a dying hero', () => {
  it('ranged critical hit adds 2 death-save failures', () => {
    const { state, hero, attacker } = setupHero({ hp: 10, attackerPos: { x: 15, y: 5 } });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    expect(hero.dying).toBe(true);
    // Ranged crit (isAttack=true, isCritical=true, melee distance > 5 ft)
    applyDamage(state, hero, 6, 'piercing', attacker, true, false, true);
    expect(hero.deathSaves?.failures).toBe(2);
  });

  it('non-critical ranged hit still adds 1 failure (regression check on the new arg)', () => {
    const { state, hero, attacker } = setupHero({ hp: 10, attackerPos: { x: 15, y: 5 } });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    applyDamage(state, hero, 6, 'piercing', attacker, true, false, false);
    expect(hero.deathSaves?.failures).toBe(1);
  });
});

describe('Wild Shape Druid going Downed', () => {
  it("overflow damage past Wild Shape temporary HP routes through Downed, not instant death", () => {
    // 2024 Wild Shape keeps the Druid's real HP and uses temporary HP for
    // the form. Here 5 temp HP absorbs part of a 30-damage hit, then the
    // overflow drops the Druid to 0 without crossing the instant-death line.
    const druidData: MonsterData = {
      ...makeMonster('Druid', 18),
      isHero: true,
      heroClass: 'Druid',
      heroLevel: 4,
    };
    const druid = createCreatureWithFixedHp(druidData, 'blue', { x: 5, y: 5 }, 0);
    druid.wildShape = {
      beastName: 'Brown Bear',
      tempHp: 5, maxTempHp: 5, formHp: 34, cr: '1', ac: 11, size: 'Medium',
      speed: { walk: 40 }, actions: [],
      abilities: { str: 19, dex: 10, con: 16 },
      isMoon: false,
    };
    const attacker = makeMonsterCreature('Big Hit', { x: 6, y: 5 }, 50);
    const state = initBattle([druid, attacker], 20);
    // Temp HP absorbs 5, overflow 25 hits Druid real HP. 18 - 25 = -7
    // (overflow into Druid = 7), which is less than maxHp 18 -> Downed.
    applyDamage(state, druid, 30, 'slashing', attacker, true);
    expect(druid.wildShape).toBeUndefined();        // form destroyed
    expect(druid.isAlive).toBe(true);                // not permanently dead
    expect(druid.dying).toBe(true);                  // routed to Downed
    expect(druid.currentHp).toBe(0);
    expect(druid.conditions).toContain('unconscious');
  });
});

describe('multiattack against a dying hero', () => {
  it('each sub-hit adds its own death-save failure (per-hit accumulation, capped at 3)', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    // Same attacker swings 3 times in a multiattack (melee, adjacent).
    // Each hit = 2 fails (melee within 5 ft). After the first hit,
    // failures = 2. After the second, failures cap at 3 and the hero
    // dies via markPermanentlyDead. The third hit is a no-op (dying
    // branch sees !isAlive at the top - actually applyDamage is gated
    // by the caller; we just verify the kill state is correct after
    // hits 1+2).
    applyDamage(state, hero, 5, 'slashing', attacker, true); // 2 fails
    expect(hero.isAlive).toBe(true);
    expect(hero.deathSaves?.failures).toBe(2);
    applyDamage(state, hero, 5, 'slashing', attacker, true); // -> 3 fails cap -> dead
    expect(hero.isAlive).toBe(false);
    expect(hero.stats.diedFromSaves).toBe(true);
  });
});

describe('multi-target healing revives multiple dying allies', () => {
  it('applyHealing called on each of three dying allies brings all back', () => {
    // Mass Cure Wounds routes through applyHealing per-target. Probe
    // the loop manually so we don't depend on a specific spell action.
    const { state, hero: hero1, attacker } = setupHero({ hp: 10 });
    const hero2 = makeHero(10, { x: 6, y: 5 });
    const hero3 = makeHero(10, { x: 7, y: 5 });
    state.creatures.push(hero2, hero3);
    applyDamage(state, hero1, 15, 'slashing', attacker, true);
    applyDamage(state, hero2, 15, 'slashing', attacker, true);
    applyDamage(state, hero3, 15, 'slashing', attacker, true);
    expect([hero1.dying, hero2.dying, hero3.dying]).toEqual([true, true, true]);

    const cleric = makeHero(20, { x: 5, y: 6 });
    applyHealing(state, hero1, 8, cleric, 'Mass Cure Wounds');
    applyHealing(state, hero2, 8, cleric, 'Mass Cure Wounds');
    applyHealing(state, hero3, 8, cleric, 'Mass Cure Wounds');
    expect([hero1.dying, hero2.dying, hero3.dying]).toEqual([false, false, false]);
    expect(hero1.currentHp).toBe(8);
    expect(hero2.currentHp).toBe(8);
    expect(hero3.currentHp).toBe(8);
    expect(cleric.stats.alliesRevived).toBe(3);
  });
});

describe('MC heroSummary aggregation', () => {
  it('populates heroSummary.blue when only blue team has heroes', async () => {
    const fighter = buildHero('Fighter', 1);
    const goblin = monsters.find(m => m.name === 'Goblin Warrior')!;
    const r = await runMonteCarlo(
      [{ data: goblin, count: 3 }],
      [{ data: fighter, count: 1 }],
      15,
      20,
    );
    expect(r.heroSummary).toBeDefined();
    expect(r.heroSummary!.red).toBeUndefined();          // no heroes on red
    expect(r.heroSummary!.blue).toBeDefined();
    expect(r.heroSummary!.blue!.heroAppearances).toBe(15);
    expect(r.heroSummary!.blue!.totalDowns).toBeGreaterThan(0);
    // Down events resolve into revive / stabilise-on-saves / pop / die-on-saves
    // / still-dying-at-end. Resolutions never exceed total downs.
    const resolutions = r.heroSummary!.blue!.totalRevived
      + r.heroSummary!.blue!.totalStabilisedBySaves
      + r.heroSummary!.blue!.totalStabilisedByAllies
      + r.heroSummary!.blue!.totalPoppedAtOneHp
      + r.heroSummary!.blue!.heroDeathsFromSaves;
    expect(resolutions).toBeLessThanOrEqual(r.heroSummary!.blue!.totalDowns);
  });

  it('populates both heroSummary.red and heroSummary.blue when both teams have heroes', async () => {
    const fighter = buildHero('Fighter', 1);
    const wizard = buildHero('Wizard', 1);
    const r = await runMonteCarlo(
      [{ data: fighter, count: 2 }],
      [{ data: wizard, count: 2 }],
      10,
      20,
    );
    expect(r.heroSummary).toBeDefined();
    expect(r.heroSummary!.red).toBeDefined();
    expect(r.heroSummary!.blue).toBeDefined();
    expect(r.heroSummary!.red!.heroAppearances).toBe(20);   // 2 heroes * 10 battles
    expect(r.heroSummary!.blue!.heroAppearances).toBe(20);
  });
});

describe('death-from-saves vs outright-death split', () => {
  it('hero killed by 3 failed death saves has diedFromSaves=true', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    vi.spyOn(Math, 'random').mockReturnValue(0.0); // nat 1 = 2 fails
    runDeathSave(state, hero); // 2 fails
    runDeathSave(state, hero); // would-be 3rd roll → at 3 → permadeath
    // Actually nat 1 the second time also adds 2, capping. Death triggers.
    expect(hero.isAlive).toBe(false);
    expect(hero.stats.diedFromSaves).toBe(true);
  });

  it('hero killed by massive damage has diedFromSaves=false', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 100, 'slashing', attacker, true);
    expect(hero.isAlive).toBe(false);
    expect(hero.stats.diedFromSaves).toBe(false);
  });

  it('monster death has diedFromSaves=false', () => {
    const goblin = makeMonsterCreature('Goblin', { x: 5, y: 5 }, 10);
    const attacker = makeMonsterCreature('Attacker', { x: 6, y: 5 }, 50);
    attacker.team = 'blue';
    const state = initBattle([goblin, attacker], 20);
    applyDamage(state, goblin, 30, 'slashing', attacker, true);
    expect(goblin.isAlive).toBe(false);
    expect(goblin.stats.diedFromSaves).toBe(false);
  });
});

describe('replay layer', () => {
  it('downed event toggles dying + unconscious in replay snapshot', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    const replay = snapshotCreatures(state.creatures);
    const downedEvt: AnimationEvent = { kind: 'downed', creatureId: hero.id, durationMs: 800 };
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    applyEventToReplay(replay, downedEvt);
    const c = replay.find(x => x.id === hero.id)!;
    expect(c.dying).toBe(true);
    expect(c.currentHp).toBe(0);
    expect(c.conditions).toContain('unconscious');
  });

  it('deathSave success event increments successesAfter in replay', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    const replay = snapshotCreatures(state.creatures);
    const downedEvt: AnimationEvent = { kind: 'downed', creatureId: hero.id, durationMs: 800 };
    applyEventToReplay(replay, downedEvt);
    const saveEvt: AnimationEvent = {
      kind: 'deathSave', creatureId: hero.id, roll: 14,
      outcome: 'success', successesAfter: 1, failuresAfter: 0,
      durationMs: 700,
    };
    applyEventToReplay(replay, saveEvt);
    const c = replay.find(x => x.id === hero.id)!;
    expect(c.deathSaves?.successes).toBe(1);
    expect(c.dying).toBe(true);
  });

  it('popUp event clears dying and sets HP to 1 in replay', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    const replay = snapshotCreatures(state.creatures);
    applyEventToReplay(replay, { kind: 'downed', creatureId: hero.id, durationMs: 800 });
    applyEventToReplay(replay, {
      kind: 'deathSave', creatureId: hero.id, roll: 20,
      outcome: 'popUp', successesAfter: 0, failuresAfter: 0, durationMs: 700,
    });
    const c = replay.find(x => x.id === hero.id)!;
    expect(c.dying).toBeFalsy();
    expect(c.currentHp).toBe(1);
    expect(c.conditions).not.toContain('unconscious');
  });

  it('hit event on a dying hero (HP 0) does NOT flip isAlive in replay', () => {
    const { state, hero, attacker } = setupHero({ hp: 10 });
    applyDamage(state, hero, 15, 'slashing', attacker, true);
    const replay = snapshotCreatures(state.creatures);
    applyEventToReplay(replay, { kind: 'downed', creatureId: hero.id, durationMs: 800 });
    // Simulate a hit event with targetHpAfter=0 (a follow-up attack on dying)
    applyEventToReplay(replay, {
      kind: 'hit', targetId: hero.id, damage: 3, damageType: 'slashing',
      critical: false, targetHpBefore: 0, targetHpAfter: 0, durationMs: 600,
    });
    const c = replay.find(x => x.id === hero.id)!;
    expect(c.isAlive).toBe(true);
    expect(c.dying).toBe(true);
  });
});
