import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp, DEFAULT_TACTICS, isInCone, isInLine, resolveAoE, type BattleState } from '../src/engine/combat';
import type { Creature, MonsterAction } from '../src/types/monster';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

function makeState(creatures: Creature[], gridSize = 20): BattleState {
  return {
    creatures,
    round: 1,
    turnIndex: 0,
    initiativeOrder: creatures.map(c => c.id),
    logs: [],
    events: [],
    isComplete: false,
    winner: null,
    gridSize,
    teamTactics: DEFAULT_TACTICS,
  };
}

describe('cone geometry', () => {
  const origin = { x: 10, y: 10 };
  const dirRight = { x: 15, y: 10 };

  it('hits targets directly ahead', () => {
    expect(isInCone(origin, dirRight, { x: 14, y: 10 }, 30)).toBe(true);
  });

  it('hits targets slightly off-axis', () => {
    expect(isInCone(origin, dirRight, { x: 14, y: 11 }, 30)).toBe(true);
  });

  it('misses targets behind the caster', () => {
    expect(isInCone(origin, dirRight, { x: 5, y: 10 }, 30)).toBe(false);
  });

  it('misses targets perpendicular to the cone', () => {
    expect(isInCone(origin, dirRight, { x: 10, y: 5 }, 30)).toBe(false);
  });

  it('misses targets beyond range', () => {
    expect(isInCone(origin, dirRight, { x: 20, y: 10 }, 30)).toBe(false);
  });

  it('hits at max range', () => {
    expect(isInCone(origin, dirRight, { x: 16, y: 10 }, 30)).toBe(true);
  });
});

describe('line geometry', () => {
  const origin = { x: 10, y: 10 };
  const dirRight = { x: 15, y: 10 };

  it('hits targets directly in the line', () => {
    expect(isInLine(origin, dirRight, { x: 15, y: 10 }, 100)).toBe(true);
  });

  it('misses targets 1 cell to the side', () => {
    expect(isInLine(origin, dirRight, { x: 15, y: 11 }, 100)).toBe(false);
  });

  it('misses targets behind the caster', () => {
    expect(isInLine(origin, dirRight, { x: 5, y: 10 }, 100)).toBe(false);
  });

  it('misses targets perpendicular', () => {
    expect(isInLine(origin, dirRight, { x: 10, y: 5 }, 100)).toBe(false);
  });

  it('hits adjacent cells in the line', () => {
    expect(isInLine(origin, dirRight, { x: 12, y: 10 }, 100)).toBe(true);
  });

  it('works with diagonal directions', () => {
    const dirDiag = { x: 15, y: 15 };
    expect(isInLine(origin, dirDiag, { x: 13, y: 13 }, 100)).toBe(true);
    expect(isInLine(origin, dirDiag, { x: 13, y: 10 }, 100)).toBe(false);
  });
});

describe('dragon breath uses cone geometry', () => {
  it('multi-target AoE damage is emitted as one grouped animation event', () => {
    const dragon = md('Adult Red Dragon');
    const commoner = md('Commoner');
    const d = createCreatureWithFixedHp(dragon, 'red', { x: 0, y: 0 }, 0);
    const targets = [
      createCreatureWithFixedHp(commoner, 'blue', { x: 3, y: 0 }, 0),
      createCreatureWithFixedHp(commoner, 'blue', { x: 4, y: 0 }, 1),
      createCreatureWithFixedHp(commoner, 'blue', { x: 5, y: 0 }, 2),
    ];
    const state = makeState([d, ...targets]);
    const fireBreath = dragon.actions.find(a => a.name === 'Fire Breath')!;

    resolveAoE(state, d, fireBreath, targets);

    const grouped = state.events.filter(e => e.kind === 'aoeDamage');
    expect(grouped).toHaveLength(1);
    expect(grouped[0].targets).toHaveLength(targets.length);
    expect(state.events.filter(e => e.kind === 'save')).toHaveLength(0);
    expect(state.events.filter(e => e.kind === 'hit')).toHaveLength(0);
    expect(state.events.filter(e => e.kind === 'death')).toHaveLength(0);

    const aoeIndex = state.events.findIndex(e => e.kind === 'aoe');
    const damageIndex = state.events.findIndex(e => e.kind === 'aoeDamage');
    const deathsIndex = state.events.findIndex(e => e.kind === 'deaths');
    const deaths = state.events.find(e => e.kind === 'deaths');
    expect(aoeIndex).toBeGreaterThanOrEqual(0);
    expect(damageIndex).toBeGreaterThan(aoeIndex);
    expect(deathsIndex).toBeGreaterThan(damageIndex);
    expect(deaths?.creatureIds).toEqual(targets.map(t => t.id));
  });

  it('multi-target AoE conditions are emitted as one grouped animation event', () => {
    const caster = createCreatureWithFixedHp(md('Commoner'), 'red', { x: 0, y: 0 }, 0);
    const guard = md('Guard');
    const targets = [
      createCreatureWithFixedHp(guard, 'blue', { x: 3, y: 0 }, 0),
      createCreatureWithFixedHp(guard, 'blue', { x: 4, y: 0 }, 1),
      createCreatureWithFixedHp(guard, 'blue', { x: 5, y: 0 }, 2),
    ];
    const state = makeState([caster, ...targets]);
    const massFrighten: MonsterAction = {
      name: 'Mass Frighten',
      type: 'special',
      description: 'Each target must make a Wisdom saving throw or become frightened.',
      savingThrow: {
        ability: 'wis',
        dc: 30,
        area: '30-foot Cone',
        conditionOnFail: 'frightened',
        conditionDuration: 'end_of_next_turn',
      },
    };

    resolveAoE(state, caster, massFrighten, targets);

    const grouped = state.events.filter(e => e.kind === 'conditionBatch');
    expect(grouped).toHaveLength(1);
    expect(grouped[0].conditions).toEqual(targets.map(t => ({
      creatureId: t.id,
      condition: 'frightened',
      applied: true,
    })));
    expect(state.events.filter(e => e.kind === 'condition')).toHaveLength(0);

    const damageIndex = state.events.findIndex(e => e.kind === 'aoeDamage');
    const conditionIndex = state.events.findIndex(e => e.kind === 'conditionBatch');
    expect(damageIndex).toBeGreaterThanOrEqual(0);
    expect(conditionIndex).toBeGreaterThan(damageIndex);
    expect(targets.every(t => t.conditions.includes('frightened'))).toBe(true);
  });

  it('Young Red Dragon breathes on enemies in front, not behind', () => {
    const dragon = md('Young Red Dragon');
    const commoner = md('Commoner');
    let behindHit = 0;
    let breathCasts = 0;

    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(dragon, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 14, y: 9 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 14, y: 10 }, 1),
        createCreatureWithFixedHp(commoner, 'blue', { x: 14, y: 11 }, 2),
        createCreatureWithFixedHp(commoner, 'blue', { x: 5, y: 10 }, 3),
      ];
      const state = runBattle(creatures, 20);
      const breathRounds = new Set(
        state.logs.filter(l => l.details?.includes('Fire Breath') && l.details?.includes('uses')).map(l => l.round)
      );
      breathCasts += breathRounds.size;
      for (const l of state.logs) {
        if (breathRounds.has(l.round!) && (l.action === 'Save' || l.action === 'Failed Save') && l.actor?.includes('Commoner 4')) {
          behindHit++;
        }
      }
    }
    expect(breathCasts).toBeGreaterThan(0);
    expect(behindHit).toBe(0);
  });
});

describe('line-shaped breath weapons', () => {
  it('Young Blue Dragon Lightning Breath has area field', () => {
    const dragon = md('Young Blue Dragon');
    const breath = dragon.actions.find(a => a.name === 'Lightning Breath');
    expect(breath).toBeDefined();
    expect(breath!.savingThrow?.area).toBe('60-foot line');
  });

  it('all line breath weapons have area fields', () => {
    const lineBreathers = [
      'Brass Dragon Wyrmling', 'Copper Dragon Wyrmling', 'Adult Blue Dragon',
      'Black Dragon Wyrmling', 'Bronze Dragon Wyrmling', 'Blue Dragon Wyrmling',
      'Young Brass Dragon', 'Young Black Dragon', 'Young Copper Dragon',
      'Young Bronze Dragon', 'Young Blue Dragon', 'Behir',
    ];
    for (const name of lineBreathers) {
      const m = md(name);
      const breath = m.actions.find(a => a.name.includes('Breath') && a.savingThrow?.damageOnFail);
      expect(breath, `${name} should have a damage breath`).toBeDefined();
      expect(breath!.savingThrow?.area, `${name} breath should have area`).toBeDefined();
      expect(breath!.savingThrow!.area!.toLowerCase()).toContain('line');
    }
  });
});

describe('post-movement AoE usage', () => {
  it('dragon at 70ft closes distance and breathes on turn 1', () => {
    const dragon = md('Young Red Dragon');
    const goblin = md('Goblin Warrior');
    let breathR1 = 0;

    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(dragon, 'red', { x: 2, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'blue', { x: 16, y: 9 }, 0),
        createCreatureWithFixedHp(goblin, 'blue', { x: 16, y: 10 }, 1),
        createCreatureWithFixedHp(goblin, 'blue', { x: 16, y: 11 }, 2),
        createCreatureWithFixedHp(goblin, 'blue', { x: 17, y: 10 }, 3),
        createCreatureWithFixedHp(goblin, 'blue', { x: 17, y: 9 }, 4),
        createCreatureWithFixedHp(goblin, 'blue', { x: 17, y: 11 }, 5),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.round === 1 && l.details?.includes('Fire Breath'))) breathR1++;
    }
    expect(breathR1).toBeGreaterThan(5);
  });

  it('hero caster can cast spells after moving closer', () => {
    const wizard = buildHero('Wizard', 5);
    const goblin = md('Goblin Warrior');
    let spellsCast = 0;

    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 15, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'red', { x: 16, y: 10 }, 1),
        createCreatureWithFixedHp(goblin, 'red', { x: 15, y: 11 }, 2),
        createCreatureWithFixedHp(wizard, 'blue', { x: 2, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      if (state.logs.some(l => l.round === 1 && l.actor?.includes('Wizard') &&
        (l.action === 'Fireball' || l.action === 'Scorching Ray' || l.action === 'Fire Bolt' ||
         l.action === 'Lightning Bolt' || l.action === 'Burning Hands' || l.action === 'Magic Missile'))) {
        spellsCast++;
      }
    }
    expect(spellsCast).toBeGreaterThan(10);
  });
});

describe('AoE friendly fire', () => {
  it('AoE damage can hit allies in the blast zone (FF enabled)', () => {
    const wizard = buildHero('Wizard', 5);
    const fighter = buildHero('Fighter', 5);
    const goblin = md('Goblin Warrior');
    let allyInSaveLog = 0;

    for (let i = 0; i < 100; i++) {
      const f = createCreatureWithFixedHp(fighter, 'blue', { x: 10, y: 9 }, 0);
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 10 }, 1),
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 11 }, 2),
        createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 11 }, 3),
        f,
        createCreatureWithFixedHp(wizard, 'blue', { x: 2, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 20, { red: 'smart', blue: 'smart', blueNoFriendlyFire: false });
      // Check if fighter appears in any AoE save log
      const aoeRounds = new Set(state.logs.filter(l =>
        l.details?.includes('uses Fireball') || l.details?.includes('uses Burning Hands') ||
        l.details?.includes('uses Thunderwave') || l.details?.includes('uses Shatter')
      ).map(l => l.round));
      for (const l of state.logs) {
        if (aoeRounds.has(l.round!) && (l.action === 'Save' || l.action === 'Failed Save') && l.actor === f.displayName) {
          allyInSaveLog++;
          break;
        }
      }
    }
    expect(allyInSaveLog).toBeGreaterThan(0);
  });
});

describe('no-friendly-fire toggle', () => {
  it('with toggle ON, Wizard never hits adjacent ally with Fireball', () => {
    const wizard = buildHero('Wizard', 5);
    const fighter = buildHero('Fighter', 5);
    const goblin = md('Goblin Warrior');
    let allyHit = 0;
    for (let i = 0; i < 50; i++) {
      const f = createCreatureWithFixedHp(fighter, 'blue', { x: 10, y: 9 }, 0);
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 10 }, 1),
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 11 }, 2),
        createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 11 }, 3),
        f,
        createCreatureWithFixedHp(wizard, 'blue', { x: 2, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 20, { red: 'smart', blue: 'smart', blueNoFriendlyFire: true });
      for (const l of state.logs) {
        const aoeRounds = new Set(state.logs.filter(ll =>
          ll.details?.includes('uses Fireball') || ll.details?.includes('uses Burning Hands')
        ).map(ll => ll.round));
        if (aoeRounds.has(l.round!) && (l.action === 'Save' || l.action === 'Failed Save') && l.actor === f.displayName) {
          allyHit++;
          break;
        }
      }
    }
    expect(allyHit).toBe(0);
  });

  it('with FF explicitly enabled, Wizard can hit adjacent ally', () => {
    const wizard = buildHero('Wizard', 5);
    const fighter = buildHero('Fighter', 5);
    const goblin = md('Goblin Warrior');
    let allyHit = 0;
    for (let i = 0; i < 100; i++) {
      const f = createCreatureWithFixedHp(fighter, 'blue', { x: 10, y: 9 }, 0);
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 10 }, 1),
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 11 }, 2),
        createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 11 }, 3),
        f,
        createCreatureWithFixedHp(wizard, 'blue', { x: 2, y: 10 }, 1),
      ];
      const state = runBattle(creatures, 20, { red: 'smart', blue: 'smart', blueNoFriendlyFire: false });
      for (const l of state.logs) {
        const aoeRounds = new Set(state.logs.filter(ll =>
          ll.details?.includes('uses Fireball')
        ).map(ll => ll.round));
        if (aoeRounds.has(l.round!) && (l.action === 'Save' || l.action === 'Failed Save') && l.actor === f.displayName) {
          allyHit++;
          break;
        }
      }
    }
    expect(allyHit).toBeGreaterThan(0);
  });
});

describe('restrained/grappled creatures cannot move', () => {
  it('Web-restrained goblins have speed 0', () => {
    const wizard = buildHero('Wizard', 4);
    const goblin = md('Goblin Warrior');
    let restrainedMoves = 0;

    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 10 }, 1),
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 11 }, 2),
        createCreatureWithFixedHp(wizard, 'blue', { x: 3, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const ids = new Set<string>();
      for (const evt of state.events) {
        if (evt.kind === 'condition' && evt.applied && evt.condition === 'restrained') ids.add(evt.creatureId);
        if (evt.kind === 'condition' && !evt.applied && evt.condition === 'restrained') ids.delete(evt.creatureId);
        if (evt.kind === 'move' && ids.has(evt.creatureId)) restrainedMoves++;
      }
    }
    expect(restrainedMoves).toBe(0);
  });
});
