import { describe, it, expect } from 'vitest';
import { Creature, MonsterAction, MonsterData } from '../src/types/monster';
import {
  deriveProfile,
  distanceToFootprint,
  generateCandidates,
  scoreCandidate,
  chooseSmartDestination,
} from '../src/engine/ai-movement-evaluator';
import { initBattle } from '../src/engine/combat';

const sword: MonsterAction = {
  name: 'Sword', type: 'melee', attackBonus: 4, damage: '1d8+2',
  damageType: 'slashing', reach: 5, description: 'Melee.',
};
const shortbow: MonsterAction = {
  name: 'Shortbow', type: 'ranged', attackBonus: 4, damage: '1d6+2',
  damageType: 'piercing', range: { normal: 80, long: 320 },
  description: 'Ranged.',
};
const heal: MonsterAction = {
  name: 'Cure Wounds', type: 'special',
  heal: { dice: '2d8' },
  description: 'Heal.',
};

function makeCreature(opts: {
  id: string; pos: { x: number; y: number };
  actions?: MonsterAction[]; ac?: number; size?: string;
  isHero?: boolean; heroClass?: string;
  traits?: { name: string; description: string }[];
}): Creature {
  const { id, pos, actions = [], ac = 12, size = 'Medium', isHero, heroClass, traits } = opts;
  const monsterData: MonsterData = {
    name: id, size, type: 'beast', alignment: 'neutral',
    ac, hp: 30, hpFormula: '5d8',
    speed: { walk: 30 },
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    senses: '', languages: '', cr: '1', xp: 200, proficiencyBonus: 2,
    actions, isHero, heroClass, traits,
  };
  return {
    id, name: id, displayName: id, monsterData,
    team: 'red', currentHp: 30, maxHp: 30, position: pos,
    initiative: 10, conditions: [], conditionTimers: [],
    isAlive: true, hasActed: false, hasMovedThisTurn: false,
    movementRemaining: 30, recharges: {}, resources: {},
    activeBuffs: [], turnFlags: {},
    stats: { damageDealt: 0, damageTaken: 0, attacksMade: 0, attacksHit: 0, killCount: 0, roundsSurvived: 0, actionUsage: {} },
  };
}

describe('deriveProfile - archetype detection', () => {
  it('detects pure melee', () => {
    const c = makeCreature({ id: 'g', pos: { x: 0, y: 0 }, actions: [sword] });
    expect(deriveProfile(c).archetype).toBe('melee');
  });

  it('detects ranged-only', () => {
    const c = makeCreature({ id: 'a', pos: { x: 0, y: 0 }, actions: [shortbow] });
    expect(deriveProfile(c).archetype).toBe('ranged');
  });

  it('mixed (melee + ranged) collapses via shouldPreferRanged', () => {
    // sword (1d8+2, +4) hit-adjusted EV > shortbow (1d6+2, +4) EV.
    // Melee dominates → 'melee' (ac=12, below tank threshold).
    const c = makeCreature({ id: 'h', pos: { x: 0, y: 0 }, actions: [sword, shortbow] });
    expect(deriveProfile(c).archetype).toBe('melee');
  });

  it('mixed creature with ranged-favoring EV is classified as ranged', () => {
    const weakSword: MonsterAction = { ...sword, damage: '1d4', attackBonus: 2 };
    const strongBow: MonsterAction = { ...shortbow, damage: '1d10+3', attackBonus: 6 };
    const c = makeCreature({ id: 'h', pos: { x: 0, y: 0 }, actions: [weakSword, strongBow] });
    expect(deriveProfile(c).archetype).toBe('ranged');
  });

  it('detects healer (has heal action)', () => {
    const c = makeCreature({ id: 'c', pos: { x: 0, y: 0 }, actions: [sword, heal] });
    expect(deriveProfile(c).archetype).toBe('healer');
  });

  it('detects caster (Wizard hero)', () => {
    const c = makeCreature({
      id: 'w', pos: { x: 0, y: 0 }, actions: [sword],
      isHero: true, heroClass: 'Wizard',
    });
    expect(deriveProfile(c).archetype).toBe('caster');
  });

  it('detects tank (high AC, melee-only)', () => {
    const c = makeCreature({ id: 't', pos: { x: 0, y: 0 }, actions: [sword], ac: 18 });
    expect(deriveProfile(c).archetype).toBe('tank');
  });

  it('exposes bestRangedNormal for kite-zone math (PR B)', () => {
    const c = makeCreature({ id: 'a', pos: { x: 0, y: 0 }, actions: [sword, shortbow] });
    expect(deriveProfile(c).bestRangedNormal).toBe(80);
  });

  it('zero bestRangedNormal for melee-only', () => {
    const c = makeCreature({ id: 'g', pos: { x: 0, y: 0 }, actions: [sword] });
    expect(deriveProfile(c).bestRangedNormal).toBe(0);
  });
});

describe('distanceToFootprint', () => {
  it('returns 0 when pos is on a footprint cell', () => {
    const t = makeCreature({ id: 't', pos: { x: 5, y: 5 } });
    expect(distanceToFootprint({ x: 5, y: 5 }, t)).toBe(0);
  });

  it('returns 5 when pos is adjacent (orthogonal)', () => {
    const t = makeCreature({ id: 't', pos: { x: 5, y: 5 } });
    expect(distanceToFootprint({ x: 4, y: 5 }, t)).toBe(5);
    expect(distanceToFootprint({ x: 6, y: 5 }, t)).toBe(5);
    expect(distanceToFootprint({ x: 5, y: 4 }, t)).toBe(5);
    expect(distanceToFootprint({ x: 5, y: 6 }, t)).toBe(5);
  });

  it('returns 5 for diagonal adjacency (chebyshev)', () => {
    const t = makeCreature({ id: 't', pos: { x: 5, y: 5 } });
    expect(distanceToFootprint({ x: 4, y: 4 }, t)).toBe(5);
    expect(distanceToFootprint({ x: 6, y: 6 }, t)).toBe(5);
  });

  it('handles Large (2x2) creature - any cell adjacent to footprint = 5ft', () => {
    const t = makeCreature({ id: 't', pos: { x: 5, y: 5 }, size: 'Large' });
    expect(distanceToFootprint({ x: 4, y: 5 }, t)).toBe(5);  // adj to (5,5)
    expect(distanceToFootprint({ x: 4, y: 6 }, t)).toBe(5);  // adj to (5,6)
    expect(distanceToFootprint({ x: 7, y: 5 }, t)).toBe(5);  // adj to (6,5)
    expect(distanceToFootprint({ x: 7, y: 6 }, t)).toBe(5);  // adj to (6,6)
    // Inside the footprint: 0
    expect(distanceToFootprint({ x: 5, y: 5 }, t)).toBe(0);
    expect(distanceToFootprint({ x: 6, y: 6 }, t)).toBe(0);
  });

  it('returns the correct distance when far away', () => {
    const t = makeCreature({ id: 't', pos: { x: 5, y: 5 } });
    expect(distanceToFootprint({ x: 0, y: 5 }, t)).toBe(25);  // 5 cells
    expect(distanceToFootprint({ x: 0, y: 0 }, t)).toBe(25);  // chebyshev 5
  });
});

describe('generateCandidates', () => {
  it('always includes the current position', () => {
    const c = makeCreature({ id: 'a', pos: { x: 5, y: 5 } });
    const t = makeCreature({ id: 't', pos: { x: 10, y: 5 } });
    t.team = 'blue';
    const state = initBattle([c, t], 20);
    const candidates = generateCandidates(c, t, state);
    expect(candidates).toContainEqual({ x: 5, y: 5 });
  });

  it('includes adjacent cells around target footprint', () => {
    const c = makeCreature({ id: 'a', pos: { x: 5, y: 5 } });
    const t = makeCreature({ id: 't', pos: { x: 10, y: 5 } });
    t.team = 'blue';
    const state = initBattle([c, t], 20);
    const candidates = generateCandidates(c, t, state);
    // Shell at distance 1 from target should include all 8 neighbors.
    expect(candidates).toContainEqual({ x: 9, y: 5 });
    expect(candidates).toContainEqual({ x: 11, y: 5 });
    expect(candidates).toContainEqual({ x: 10, y: 4 });
    expect(candidates).toContainEqual({ x: 10, y: 6 });
  });

  it('does NOT include cells occupied by other creatures', () => {
    const c = makeCreature({ id: 'a', pos: { x: 5, y: 5 } });
    const t = makeCreature({ id: 't', pos: { x: 10, y: 5 } });
    t.team = 'blue';
    const state = initBattle([c, t], 20);
    const candidates = generateCandidates(c, t, state);
    // Target's cell is occupied.
    expect(candidates).not.toContainEqual({ x: 10, y: 5 });
  });

  it('does NOT include cells off the grid', () => {
    const c = makeCreature({ id: 'a', pos: { x: 1, y: 1 } });
    const t = makeCreature({ id: 't', pos: { x: 19, y: 19 } });
    t.team = 'blue';
    const state = initBattle([c, t], 20);
    const candidates = generateCandidates(c, t, state);
    for (const cand of candidates) {
      expect(cand.x).toBeGreaterThanOrEqual(0);
      expect(cand.x).toBeLessThanOrEqual(19);
      expect(cand.y).toBeGreaterThanOrEqual(0);
      expect(cand.y).toBeLessThanOrEqual(19);
    }
  });

  it('caps candidate count to keep MC perf in budget', () => {
    const c = makeCreature({ id: 'a', pos: { x: 10, y: 10 } });
    const t = makeCreature({ id: 't', pos: { x: 12, y: 10 } });
    t.team = 'blue';
    const state = initBattle([c, t], 20);
    const candidates = generateCandidates(c, t, state);
    // Sanity: shouldn't be hundreds of candidates on an open grid -
    // the bounded shell strategy keeps it tractable. PR A uses shells
    // at distance 1/3/5/7 which produces ~140 max on an open grid;
    // PR B may trim further once it actually scores them.
    expect(candidates.length).toBeLessThanOrEqual(150);
  });
});

describe('scoreCandidate (PR B: distance + dispersion + edge are active)', () => {
  it('cover / oaRisk / allyAffinity remain zero (wired in PR C/D)', () => {
    const c = makeCreature({ id: 'a', pos: { x: 5, y: 5 } });
    const t = makeCreature({ id: 't', pos: { x: 10, y: 5 } });
    t.team = 'blue';
    const state = initBattle([c, t], 20);
    const profile = deriveProfile(c);
    const result = scoreCandidate({ x: 6, y: 5 }, c, t, profile, state, [t], [], new Map());
    expect(result.components.cover).toBe(0);
    expect(result.components.oaRisk).toBe(0);
    expect(result.components.allyAffinity).toBe(0);
  });

  it('distance component prefers cells closer to a melee target', () => {
    const c = makeCreature({ id: 'a', pos: { x: 0, y: 5 } });
    const t = makeCreature({ id: 't', pos: { x: 10, y: 5 } });
    t.team = 'blue';
    const state = initBattle([c, t], 20);
    const profile = deriveProfile(c);
    const near = scoreCandidate({ x: 9, y: 5 }, c, t, profile, state, [t], [], new Map());
    const far = scoreCandidate({ x: 0, y: 5 }, c, t, profile, state, [t], [], new Map());
    expect(near.components.distance).toBeGreaterThan(far.components.distance);
  });

  it('total is the weighted sum of components', () => {
    const c = makeCreature({ id: 'a', pos: { x: 5, y: 5 } });
    const t = makeCreature({ id: 't', pos: { x: 10, y: 5 } });
    t.team = 'blue';
    const state = initBattle([c, t], 20);
    const profile = deriveProfile(c);
    const r = scoreCandidate({ x: 6, y: 5 }, c, t, profile, state, [t], [], new Map());
    const w = profile.weights;
    const expected =
      r.components.distance * w.distance +
      r.components.cover * w.cover +
      r.components.oaRisk * w.oaRisk +
      r.components.allyAffinity * w.allyAffinity +
      r.components.dispersion * w.dispersion +
      r.components.edge * w.edge;
    expect(r.total).toBeCloseTo(expected, 5);
  });

  it('edge component is negative on map borders, zero in the interior', () => {
    const c = makeCreature({ id: 'a', pos: { x: 5, y: 5 } });
    const t = makeCreature({ id: 't', pos: { x: 10, y: 5 } });
    t.team = 'blue';
    const state = initBattle([c, t], 20);
    const profile = deriveProfile(c);
    const onEdge = scoreCandidate({ x: 0, y: 5 }, c, t, profile, state, [t], [], new Map());
    const interior = scoreCandidate({ x: 6, y: 5 }, c, t, profile, state, [t], [], new Map());
    expect(onEdge.components.edge).toBeLessThan(0);
    expect(interior.components.edge).toBe(0);
  });
});

describe('scoreCandidate - PR B kite-zone behaviour', () => {
  it('ranged creature scores cells in kite zone higher than cells inside enemy reach', () => {
    // Pure-ranged archer vs melee enemy with 30 ft walk + 5 ft reach.
    // moveBudget = 35 ft; dashReach = 65 ft.
    // Cell at distance 40 ft = kite zone (enemy must dash, no attack).
    // Cell at distance 25 ft = inside reach (enemy walks in and hits).
    const archer = makeCreature({
      id: 'archer', pos: { x: 5, y: 10 }, actions: [shortbow],
    });
    const goblin = makeCreature({
      id: 'goblin', pos: { x: 13, y: 10 }, actions: [sword],
    });
    goblin.team = 'blue';
    const state = initBattle([archer, goblin], 20);
    const profile = deriveProfile(archer);
    expect(profile.archetype).toBe('ranged');

    // Archer at (5,10), goblin at (13,10). Goblin moveBudget=35ft (7 cells),
    // dashReach=65ft (13 cells).
    // Candidate at (5,10) = 8 cells away from goblin (40 ft) -> kite zone.
    // Candidate at (10,10) = 3 cells away (15 ft) -> well inside reach.
    const kite = scoreCandidate({ x: 5, y: 10 }, archer, goblin, profile, state, [goblin], [], new Map());
    const inside = scoreCandidate({ x: 10, y: 10 }, archer, goblin, profile, state, [goblin], [], new Map());
    expect(kite.components.distance).toBeGreaterThan(inside.components.distance);
  });

  it('melee creature still prefers closing in (no kite-zone math for them)', () => {
    const knight = makeCreature({
      id: 'knight', pos: { x: 5, y: 10 }, actions: [sword],
    });
    const goblin = makeCreature({
      id: 'goblin', pos: { x: 13, y: 10 }, actions: [sword],
    });
    goblin.team = 'blue';
    const state = initBattle([knight, goblin], 20);
    const profile = deriveProfile(knight);

    const near = scoreCandidate({ x: 12, y: 10 }, knight, goblin, profile, state, [goblin], [], new Map());
    const far = scoreCandidate({ x: 5, y: 10 }, knight, goblin, profile, state, [goblin], [], new Map());
    expect(near.components.distance).toBeGreaterThan(far.components.distance);
  });
});

describe('scoreCandidate - PR B dispersion', () => {
  it('ranged ally clustering produces a dispersion penalty when outnumbering', () => {
    // 3 archers vs 1 melee goblin: ranged allies (3) outnumber melee enemies (1).
    // Dispersion should kick in.
    const a1 = makeCreature({ id: 'a1', pos: { x: 5, y: 10 }, actions: [shortbow] });
    const a2 = makeCreature({ id: 'a2', pos: { x: 6, y: 10 }, actions: [shortbow] });
    const a3 = makeCreature({ id: 'a3', pos: { x: 7, y: 10 }, actions: [shortbow] });
    const goblin = makeCreature({ id: 'g', pos: { x: 15, y: 10 }, actions: [sword] });
    goblin.team = 'blue';
    const state = initBattle([a1, a2, a3, goblin], 20);
    const profile = deriveProfile(a1);

    // Position right next to two ranged allies: heavy dispersion penalty.
    const clustered = scoreCandidate(
      { x: 5, y: 10 }, a1, goblin, profile, state, [goblin], [a2, a3], new Map(),
    );
    // Position far from both allies: zero dispersion penalty.
    const dispersed = scoreCandidate(
      { x: 5, y: 0 }, a1, goblin, profile, state, [goblin], [a2, a3], new Map(),
    );
    expect(clustered.components.dispersion).toBeLessThan(dispersed.components.dispersion);
    expect(dispersed.components.dispersion).toBe(0);
  });

  it('does NOT apply dispersion when ranged allies do not outnumber melee enemies', () => {
    // 2 archers vs 3 goblins: ranged ally count (2) <= melee enemy count (3).
    // Dispersion stays at 0 - clustering is fine for mutual support.
    const a1 = makeCreature({ id: 'a1', pos: { x: 5, y: 10 }, actions: [shortbow] });
    const a2 = makeCreature({ id: 'a2', pos: { x: 6, y: 10 }, actions: [shortbow] });
    const g1 = makeCreature({ id: 'g1', pos: { x: 15, y: 10 }, actions: [sword] });
    const g2 = makeCreature({ id: 'g2', pos: { x: 15, y: 11 }, actions: [sword] });
    const g3 = makeCreature({ id: 'g3', pos: { x: 15, y: 12 }, actions: [sword] });
    g1.team = 'blue'; g2.team = 'blue'; g3.team = 'blue';
    const state = initBattle([a1, a2, g1, g2, g3], 20);
    const profile = deriveProfile(a1);

    const result = scoreCandidate(
      { x: 5, y: 10 }, a1, g1, profile, state, [g1, g2, g3], [a2], new Map(),
    );
    expect(result.components.dispersion).toBe(0);
  });

  it('melee creatures never get a dispersion score', () => {
    const m1 = makeCreature({ id: 'm1', pos: { x: 5, y: 10 }, actions: [sword] });
    const m2 = makeCreature({ id: 'm2', pos: { x: 6, y: 10 }, actions: [sword] });
    const m3 = makeCreature({ id: 'm3', pos: { x: 7, y: 10 }, actions: [sword] });
    const g = makeCreature({ id: 'g', pos: { x: 15, y: 10 }, actions: [sword] });
    g.team = 'blue';
    const state = initBattle([m1, m2, m3, g], 20);
    const profile = deriveProfile(m1);

    const result = scoreCandidate(
      { x: 5, y: 10 }, m1, g, profile, state, [g], [m2, m3], new Map(),
    );
    expect(result.components.dispersion).toBe(0);
  });
});

describe('chooseSmartDestination - PR B integration', () => {
  it('melee creature picks a destination that lands the pathfinder in melee range', () => {
    const knight = makeCreature({ id: 'k', pos: { x: 2, y: 10 }, actions: [sword] });
    const goblin = makeCreature({ id: 'g', pos: { x: 18, y: 10 }, actions: [sword] });
    goblin.team = 'blue';
    const state = initBattle([knight, goblin], 20);
    const dest = chooseSmartDestination(knight, goblin, state);
    // Pathfinder stops at chebyshev 1 from `dest`, so for the knight to land
    // in melee, dest must be at the goblin (or one cell past).
    expect(Math.abs(dest.x - goblin.position.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(dest.y - goblin.position.y)).toBeLessThanOrEqual(1);
  });

  it('pure-ranged archer kites - destination keeps it well outside melee enemy reach', () => {
    // 1 archer vs 1 melee goblin: not outnumbering, so dispersion is off.
    // Distance score's kite-zone math drives the decision: pick a cell in
    // the kite zone (distance > moveBudget = 35 ft for goblin).
    const archer = makeCreature({ id: 'a', pos: { x: 5, y: 10 }, actions: [shortbow] });
    const goblin = makeCreature({ id: 'g', pos: { x: 13, y: 10 }, actions: [sword] });
    goblin.team = 'blue';
    const state = initBattle([archer, goblin], 20);
    const dest = chooseSmartDestination(archer, goblin, state);
    // The archer should NOT pick a cell adjacent to the goblin (that'd be
    // the melee creature's destination). Distance from dest to goblin
    // should be > 5 ft.
    const dxd = Math.abs(dest.x - goblin.position.x);
    const dyd = Math.abs(dest.y - goblin.position.y);
    const cheb = Math.max(dxd, dyd);
    expect(cheb).toBeGreaterThan(1);
  });
});

const packTactics = {
  name: 'Pack Tactics',
  description: 'The creature has Advantage on an attack roll against a creature if at least one of its allies is within 5 feet of the creature.',
};
const nimbleEscape = {
  name: 'Nimble Escape',
  description: 'The creature takes the Disengage or Hide action as a Bonus Action on each of its turns.',
};

describe('scoreCandidate - Pack Tactics', () => {
  it('PT creature with no ally adjacent gets a big bonus for going adjacent itself', () => {
    const wolf = makeCreature({
      id: 'wolf', pos: { x: 5, y: 10 }, actions: [sword], traits: [packTactics],
    });
    const ally = makeCreature({
      id: 'ally', pos: { x: 4, y: 10 }, actions: [sword], traits: [packTactics],
    });
    const target = makeCreature({ id: 't', pos: { x: 12, y: 10 }, actions: [sword] });
    target.team = 'blue';
    const state = initBattle([wolf, ally, target], 20);
    const profile = deriveProfile(wolf);

    const adjacent = scoreCandidate({ x: 11, y: 10 }, wolf, target, profile, state, [target], [ally], new Map());
    const farFromTarget = scoreCandidate({ x: 5, y: 10 }, wolf, target, profile, state, [target], [ally], new Map());
    expect(adjacent.components.packTactics).toBeGreaterThan(farFromTarget.components.packTactics);
    expect(adjacent.components.packTactics).toBeGreaterThanOrEqual(40);
  });

  it('PT creature with an ally already adjacent gets no spatial bonus', () => {
    const wolf = makeCreature({
      id: 'wolf', pos: { x: 5, y: 10 }, actions: [sword], traits: [packTactics],
    });
    const allyAdj = makeCreature({
      id: 'allyAdj', pos: { x: 11, y: 10 }, actions: [sword], traits: [packTactics],
    });
    const target = makeCreature({ id: 't', pos: { x: 12, y: 10 }, actions: [sword] });
    target.team = 'blue';
    const state = initBattle([wolf, allyAdj, target], 20);
    const profile = deriveProfile(wolf);

    // allyAdj is 1 cell from target, within 5 ft. Wolf gets advantage from
    // any cell - PT bonus should be 0 everywhere.
    const adjacent = scoreCandidate({ x: 11, y: 9 }, wolf, target, profile, state, [target], [allyAdj], new Map());
    const far = scoreCandidate({ x: 5, y: 10 }, wolf, target, profile, state, [target], [allyAdj], new Map());
    expect(adjacent.components.packTactics).toBe(0);
    expect(far.components.packTactics).toBe(0);
  });

  it('non-PT creature gets zero packTactics regardless of position', () => {
    const goblin = makeCreature({ id: 'g', pos: { x: 5, y: 10 }, actions: [sword] });
    const target = makeCreature({ id: 't', pos: { x: 12, y: 10 }, actions: [sword] });
    target.team = 'blue';
    const state = initBattle([goblin, target], 20);
    const profile = deriveProfile(goblin);

    const result = scoreCandidate({ x: 11, y: 10 }, goblin, target, profile, state, [target], [], new Map());
    expect(result.components.packTactics).toBe(0);
  });
});

describe('scoreCandidate - OA risk', () => {
  it('penalizes leaving a melee enemy reach', () => {
    const archer = makeCreature({ id: 'a', pos: { x: 5, y: 10 }, actions: [shortbow] });
    const enemy = makeCreature({ id: 'e', pos: { x: 5, y: 11 }, actions: [sword] });
    enemy.team = 'blue';
    const state = initBattle([archer, enemy], 20);
    const profile = deriveProfile(archer);

    // Archer is at (5,10), enemy adjacent at (5,11). Moving to (5,5)
    // leaves enemy reach -> OA penalty.
    const fleeing = scoreCandidate({ x: 5, y: 5 }, archer, enemy, profile, state, [enemy], [], new Map());
    expect(fleeing.components.oaRisk).toBeLessThan(0);
  });

  it('zero OA risk when not currently in melee with anyone', () => {
    const archer = makeCreature({ id: 'a', pos: { x: 5, y: 10 }, actions: [shortbow] });
    const enemy = makeCreature({ id: 'e', pos: { x: 12, y: 10 }, actions: [sword] });
    enemy.team = 'blue';
    const state = initBattle([archer, enemy], 20);
    const profile = deriveProfile(archer);

    // Archer is 35 ft from enemy - not in melee. Moving anywhere is free.
    const result = scoreCandidate({ x: 4, y: 10 }, archer, enemy, profile, state, [enemy], [], new Map());
    expect(result.components.oaRisk).toBe(0);
  });

  it('zero OA risk for Nimble Escape creatures even when adjacent', () => {
    const goblin = makeCreature({
      id: 'g', pos: { x: 5, y: 10 }, actions: [shortbow], traits: [nimbleEscape],
    });
    const enemy = makeCreature({ id: 'e', pos: { x: 5, y: 11 }, actions: [sword] });
    enemy.team = 'blue';
    const state = initBattle([goblin, enemy], 20);
    const profile = deriveProfile(goblin);

    // Adjacent enemy, but Nimble Escape disengages for free. No OA cost.
    const fleeing = scoreCandidate({ x: 5, y: 5 }, goblin, enemy, profile, state, [enemy], [], new Map());
    expect(fleeing.components.oaRisk).toBe(0);
  });
});
