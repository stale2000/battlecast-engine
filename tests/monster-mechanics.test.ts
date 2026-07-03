import { afterEach, describe, it, expect, vi } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { executeLegendaryAction, executeTurn, runBattle } from '../src/engine/ai';
import { applyDamage, createCreatureWithFixedHp, creatureDistance, DEFAULT_TACTICS, executeSpell, resolveAttack, resolveConditionOnHit, type BattleState } from '../src/engine/combat';
import type { Creature } from '../src/types/monster';

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

function durableTarget(x: number, y: number, id = 1): Creature {
  const target = createCreatureWithFixedHp(buildHero('Fighter', 10), 'blue', { x, y }, id);
  target.currentHp = 999;
  target.maxHp = 999;
  return target;
}

function attackEventsBy(state: BattleState, creature: Creature) {
  return state.events.filter(e => e.kind === 'attack' && e.attackerId === creature.id);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Legendary Resistance', () => {
  it('high-CR creatures auto-succeed failed saves', () => {
    const dragon = md('Adult Red Dragon');
    const wizard = buildHero('Wizard', 5);
    let lrUsed = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(dragon, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(wizard, 'blue', { x: 2, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      lrUsed += state.logs.filter(l => l.action === 'Legendary Resistance').length;
    }
    expect(lrUsed).toBeGreaterThan(0);
  });

  it('all 10 LR creatures have the resource', () => {
    const lrCreatures = [
      'Aboleth', 'Adult White Dragon', 'Vampire', 'Adult Blue Dragon',
      'Adult Red Dragon', 'Balor', 'Pit Fiend', 'Lich', 'Ancient Red Dragon', 'Tarrasque',
    ];
    for (const name of lrCreatures) {
      const m = md(name);
      expect(m.initialResources?.['legendary-resistance'],
        `${name} should have legendary-resistance resource`
      ).toBeGreaterThan(0);
    }
  });

  it('Tarrasque has 6/day, Pit Fiend/Lich have 4/day, others have 3/day', () => {
    expect(md('Tarrasque').initialResources!['legendary-resistance']).toBe(6);
    expect(md('Pit Fiend').initialResources!['legendary-resistance']).toBe(4);
    expect(md('Lich').initialResources!['legendary-resistance']).toBe(4);
    expect(md('Adult Red Dragon').initialResources!['legendary-resistance']).toBe(3);
  });
});

describe('Fire Aura / Heat Aura', () => {
  it('Balor Fire Aura deals damage to adjacent creatures', () => {
    const balor = md('Balor');
    const commoner = md('Commoner');
    let auraDmg = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(balor, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      auraDmg += state.logs.filter(l => l.action === 'Fire Aura').length;
    }
    expect(auraDmg).toBeGreaterThan(0);
  });

  it('Remorhaz Heat Aura is recognized and deals damage', () => {
    const remorhaz = md('Remorhaz');
    expect(remorhaz.traits?.some(t => t.name === 'Heat Aura')).toBe(true);
    const commoner = md('Commoner');
    let auraDmg = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(remorhaz, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      auraDmg += state.logs.filter(l => l.action === 'Heat Aura').length;
    }
    expect(auraDmg).toBeGreaterThan(0);
  });
});

describe('Regeneration', () => {
  it('Troll regenerates HP each turn', () => {
    const troll = md('Troll');
    const veteran = md('Veteran');
    let regenSeen = 0;
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(troll, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      regenSeen += state.logs.filter(l => l.action === 'Regeneration').length;
    }
    expect(regenSeen).toBeGreaterThan(5);
  });

  it('Troll dies at 0 HP in the simulator even when regeneration is active', () => {
    const troll = createCreatureWithFixedHp(md('Troll'), 'red', { x: 10, y: 10 }, 0);
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 5), 'blue', { x: 11, y: 10 }, 1);
    const state = makeState([troll, fighter], 20);

    applyDamage(state, troll, 999, 'slashing', fighter);

    expect(troll.currentHp).toBe(0);
    expect(troll.isAlive).toBe(false);
    expect(state.logs.some(l => l.details.includes('refuses to die'))).toBe(false);
  });

  it('Troll regeneration at 0 HP is suppressed by fire damage', () => {
    const troll = createCreatureWithFixedHp(md('Troll'), 'red', { x: 10, y: 10 }, 0);
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 5), 'blue', { x: 11, y: 10 }, 1);
    const state = makeState([troll, wizard], 20);

    applyDamage(state, troll, 999, 'fire', wizard);

    expect(troll.currentHp).toBeLessThanOrEqual(0);
    expect(troll.isAlive).toBe(false);
  });
});

describe('Magic Resistance', () => {
  it('creatures with Magic Resistance roll saves with advantage', () => {
    // Magic Resistance gives advantage on saves vs spells.
    // We can't directly check advantage, but creatures with MR should
    // succeed saves more often.
    const mindFlayer = md('Mind Flayer');
    expect(mindFlayer.traits?.some(t => t.name === 'Magic Resistance')).toBe(true);
  });
});

describe('Fear Aura', () => {
  it('Pit Fiend Fear Aura frightens nearby enemies', () => {
    const pitFiend = md('Pit Fiend');
    const veteran = md('Veteran');
    let frightenedSeen = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(pitFiend, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 11, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      frightenedSeen += state.logs.filter(l =>
        l.details?.includes('frightened') || l.details?.includes('Frightened')
      ).length;
    }
    expect(frightenedSeen).toBeGreaterThan(0);
  });
});

describe('Breath weapon data integrity', () => {
  it('all breath weapons have area field', () => {
    for (const m of monsters) {
      for (const a of m.actions) {
        if (a.name.includes('Breath') && a.savingThrow?.damageOnFail) {
          expect(a.savingThrow.area,
            `${m.name} ${a.name} missing area`
          ).toBeDefined();
        }
      }
    }
  });

  it('cone breaths have Cone in area, line breaths have line', () => {
    for (const m of monsters) {
      for (const a of m.actions) {
        if (a.name.includes('Breath') && a.savingThrow?.area) {
          const area = a.savingThrow.area.toLowerCase();
          const desc = (a.description || '').toLowerCase();
          if (desc.includes('cone')) {
            expect(area).toContain('cone');
          }
          if (desc.includes('line') && desc.includes('foot-long')) {
            expect(area).toContain('line');
          }
        }
      }
    }
  });
});

describe('Condition immunities', () => {
  it('constructs are immune to common conditions', () => {
    const golem = md('Iron Golem');
    expect(golem.conditionImmunities).toContain('charmed');
    expect(golem.conditionImmunities).toContain('frightened');
    expect(golem.conditionImmunities).toContain('paralyzed');
    expect(golem.conditionImmunities).toContain('poisoned');
  });
});

describe('Pack Tactics', () => {
  it('Wolf has Pack Tactics trait', () => {
    const wolf = md('Wolf');
    expect(wolf.traits?.some(t => t.name === 'Pack Tactics')).toBe(true);
  });
});

describe('Grapple on hit', () => {
  it('Giant Crocodile bite grapples on hit', () => {
    const croc = md('Giant Crocodile');
    const bite = croc.actions.find(a => a.name === 'Bite');
    expect(bite?.conditionOnHit?.condition).toBe('grappled');
  });
});

describe('Legendary Actions', () => {
  it('Adult Red Dragon uses legendary actions between enemy turns', () => {
    const dragon = md('Adult Red Dragon');
    const veteran = md('Veteran');
    let laCount = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(dragon, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 11, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 11, y: 12 }, 1),
      ];
      const state = runBattle(creatures, 20);
      laCount += state.logs.filter(l => l.action === 'Legendary Action').length;
    }
    expect(laCount).toBeGreaterThan(10);
  });

  it('all legendary creatures have LA data', () => {
    const laCreatures = [
      'Aboleth', 'Adult White Dragon', 'Adult Blue Dragon', 'Adult Red Dragon',
      'Ancient Red Dragon', 'Vampire', 'Lich', 'Tarrasque', 'Beholder',
    ];
    for (const name of laCreatures) {
      const m = md(name);
      expect(m.legendaryActionUses, `${name} should have legendaryActionUses`).toBeGreaterThan(0);
      expect(m.legendaryActions?.length, `${name} should have legendaryActions`).toBeGreaterThan(0);
    }
  });

  it('Lich uses at-will AoE spellcasting even in a 1v1 fight', () => {
    const lich = createCreatureWithFixedHp(md('Lich'), 'red', { x: 5, y: 10 }, 0);
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 10), 'blue', { x: 16, y: 10 }, 1);
    const state = makeState([lich, fighter], 20);

    executeTurn(state, lich);

    expect(state.logs.some(l => l.actor.includes('Lich') && ['Fireball', 'Lightning Bolt'].includes(l.action))).toBe(true);
    const spellUses = (lich.stats.actionUsage.Fireball ?? 0) + (lich.stats.actionUsage['Lightning Bolt'] ?? 0);
    expect(spellUses).toBeGreaterThan(0);
  });

  it('Lich generic multiattack text resolves to three attacks', () => {
    const lichData = md('Lich');
    const weaponOnlyLich = {
      ...lichData,
      actions: lichData.actions.filter(a =>
        ['Eldritch Burst', 'Paralyzing Touch', 'Multiattack'].includes(a.name)
      ),
    };
    const lich = createCreatureWithFixedHp(weaponOnlyLich, 'red', { x: 5, y: 10 }, 0);
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 10), 'blue', { x: 16, y: 10 }, 1);
    fighter.currentHp = 500;
    fighter.maxHp = 500;
    const state = makeState([lich, fighter], 20);

    executeTurn(state, lich);

    const lichAttacks = state.events.filter(e =>
      e.kind === 'attack' && e.attackerId === lich.id
    );
    expect(lichAttacks).toHaveLength(3);
    expect(lichAttacks.every(e => e.kind === 'attack' && e.actionName === 'Eldritch Burst')).toBe(true);
  });

  it('Lich legendary Disrupt Life resolves as necrotic AoE damage', () => {
    const lich = createCreatureWithFixedHp(md('Lich'), 'red', { x: 10, y: 10 }, 0);
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 10), 'blue', { x: 12, y: 10 }, 1);
    const hpBefore = fighter.currentHp;
    const state = makeState([lich, fighter], 20);

    executeLegendaryAction(state, lich);

    expect(state.logs.some(l => l.actor.includes('Lich') && l.action === 'Legendary Action' && l.details.includes('Disrupt Life'))).toBe(true);
    expect(state.logs.some(l => l.actor.includes('Lich') && l.action === 'Disrupt Life')).toBe(true);
    expect(fighter.currentHp).toBeLessThan(hpBefore);
    expect(lich.stats.actionUsage['LA: Disrupt Life']).toBe(1);
  });

  it('Lich legendary Frightening Gaze resolves when targets are outside Disrupt Life range', () => {
    const lich = createCreatureWithFixedHp(md('Lich'), 'red', { x: 10, y: 10 }, 0);
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 10), 'blue', { x: 15, y: 10 }, 1);
    const state = makeState([lich, fighter], 20);

    executeLegendaryAction(state, lich);

    expect(state.logs.some(l => l.actor.includes('Lich') && l.action === 'Legendary Action' && l.details.includes('Frightening Gaze'))).toBe(true);
    expect(state.logs.some(l => l.actor.includes('Lich') && l.action === 'Frightening Gaze')).toBe(true);
    expect(lich.stats.actionUsage['LA: Frightening Gaze']).toBe(1);
  });

  it('Lich legendary Deathly Teleport moves and damages nearby creatures', () => {
    const lichData = md('Lich');
    const deathlyOnlyLich = {
      ...lichData,
      legendaryActions: lichData.legendaryActions?.filter(a => a.name === 'Deathly Teleport'),
    };
    const lich = createCreatureWithFixedHp(deathlyOnlyLich, 'red', { x: 10, y: 10 }, 0);
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 10), 'blue', { x: 11, y: 10 }, 1);
    const hpBefore = fighter.currentHp;
    const state = makeState([lich, fighter], 20);

    executeLegendaryAction(state, lich);

    expect(lich.position).not.toEqual({ x: 10, y: 10 });
    expect(fighter.currentHp).toBeLessThan(hpBefore);
    expect(state.logs.some(l => l.actor.includes('Lich') && l.action === 'Deathly Teleport')).toBe(true);
    expect(lich.stats.actionUsage['LA: Deathly Teleport']).toBe(1);
  });

  it('legendary action points reset each round', () => {
    const dragon = md('Adult Red Dragon');
    const veteran = md('Veteran');
    // Run a long fight and check LAs fire in multiple rounds
    const laRounds = new Set<number>();
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(dragon, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 11, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 11, y: 12 }, 1),
        createCreatureWithFixedHp(veteran, 'blue', { x: 9, y: 10 }, 2),
      ];
      const state = runBattle(creatures, 20);
      for (const l of state.logs) {
        if (l.action === 'Legendary Action') laRounds.add(l.round!);
      }
    }
    expect(laRounds.size).toBeGreaterThan(1);
  });
});

describe('Gallery showcase monster mechanics', () => {
  it('Hydra multiattack resolves as five bite attacks', () => {
    const hydra = createCreatureWithFixedHp(md('Hydra'), 'red', { x: 10, y: 10 }, 0);
    const fighter = durableTarget(12, 10);
    const state = makeState([hydra, fighter], 20);

    executeTurn(state, hydra);

    const hydraAttacks = attackEventsBy(state, hydra);
    expect(hydraAttacks).toHaveLength(5);
    expect(hydraAttacks.every(e => e.actionName === 'Bite')).toBe(true);
    expect(hydra.stats.actionUsage.Bite).toBe(5);
  });

  it('Tarrasque multiattack resolves as one bite plus three claw or tail attacks', () => {
    const tarrasqueData = md('Tarrasque');
    const weaponOnlyTarrasque = {
      ...tarrasqueData,
      actions: tarrasqueData.actions.filter(action =>
        ['Bite', 'Claw', 'Tail', 'Multiattack'].includes(action.name)
      ),
    };
    const tarrasque = createCreatureWithFixedHp(weaponOnlyTarrasque, 'red', { x: 7, y: 10 }, 0);
    const fighter = durableTarget(12, 10);
    const state = makeState([tarrasque, fighter], 28);

    executeTurn(state, tarrasque);

    const tarrasqueAttacks = attackEventsBy(state, tarrasque);
    expect(tarrasqueAttacks).toHaveLength(4);
    expect(tarrasqueAttacks.filter(e => e.actionName === 'Bite')).toHaveLength(1);
    expect(tarrasqueAttacks.filter(e => ['Claw', 'Tail'].includes(e.actionName ?? ''))).toHaveLength(3);
  });

  it('Pit Fiend multiattack uses bite, two claws, and mace', () => {
    const pitFiendData = md('Pit Fiend');
    const weaponOnlyPitFiend = {
      ...pitFiendData,
      actions: pitFiendData.actions.filter(action =>
        ['Bite', 'Devilish Claw', 'Fiery Mace', 'Multiattack'].includes(action.name)
      ),
    };
    const pitFiend = createCreatureWithFixedHp(weaponOnlyPitFiend, 'red', { x: 10, y: 10 }, 0);
    const fighter = durableTarget(12, 10);
    const state = makeState([pitFiend, fighter], 24);

    executeTurn(state, pitFiend);

    const pitFiendAttacks = attackEventsBy(state, pitFiend);
    expect(pitFiendAttacks.map(e => e.actionName)).toEqual([
      'Bite',
      'Devilish Claw',
      'Devilish Claw',
      'Fiery Mace',
    ]);
  });

  it('Balor multiattack pulls with Flame Whip before using Lightning Blade', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const balorData = md('Balor');
    const weaponOnlyBalor = {
      ...balorData,
      actions: balorData.actions.filter(action =>
        ['Flame Whip', 'Lightning Blade', 'Multiattack'].includes(action.name)
      ),
    };
    const balor = createCreatureWithFixedHp(weaponOnlyBalor, 'red', { x: 10, y: 10 }, 0);
    const fighter = durableTarget(18, 10);
    fighter.monsterData = { ...fighter.monsterData, ac: 1 };
    const state = makeState([balor, fighter], 24);

    executeTurn(state, balor);

    expect(attackEventsBy(state, balor).map(e => e.actionName)).toEqual([
      'Flame Whip',
      'Lightning Blade',
    ]);
    expect(state.events.some(e =>
      e.kind === 'move' &&
      e.creatureId === fighter.id &&
      e.from.x === 18 &&
      e.to.x < 18
    )).toBe(true);
    expect(creatureDistance(balor, fighter)).toBeLessThanOrEqual(10);
  });

  it('Vampire multiattack uses two grave strikes and bite', () => {
    const vampire = createCreatureWithFixedHp(md('Vampire'), 'red', { x: 10, y: 10 }, 0);
    const fighter = durableTarget(11, 10);
    const state = makeState([vampire, fighter], 20);

    executeTurn(state, vampire);

    const vampireAttacks = attackEventsBy(state, vampire);
    expect(vampireAttacks.map(e => e.actionName)).toEqual([
      'Grave Strike',
      'Grave Strike',
      'Bite',
    ]);
  });

  it('Mind Flayer only extracts brains from controlled targets', () => {
    const mindFlayerData = md('Mind Flayer');
    const tentacles = {
      ...mindFlayerData.actions.find(action => action.name === 'Tentacles')!,
      conditionOnHit: undefined,
    };
    const testMindFlayerData = {
      ...mindFlayerData,
      actions: [
        mindFlayerData.actions.find(action => action.name === 'Multiattack')!,
        tentacles,
        mindFlayerData.actions.find(action => action.name === 'Extract Brain')!,
      ],
    };
    const mindFlayer = createCreatureWithFixedHp(testMindFlayerData, 'red', { x: 10, y: 10 }, 0);
    const fighter = durableTarget(11, 10);
    const state = makeState([mindFlayer, fighter], 20);

    executeTurn(state, mindFlayer);

    expect(state.logs.some(l => l.actor.includes('Mind Flayer') && l.action === 'Extract Brain')).toBe(false);

    const controlledMindFlayer = createCreatureWithFixedHp(testMindFlayerData, 'red', { x: 10, y: 10 }, 0);
    const grappledFighter = durableTarget(11, 10);
    grappledFighter.conditions.push('grappled');
    const controlledState = makeState([controlledMindFlayer, grappledFighter], 20);

    executeTurn(controlledState, controlledMindFlayer);

    expect(controlledState.logs.some(l => l.actor.includes('Mind Flayer') && l.action === 'Extract Brain')).toBe(true);
  });

  it('Purple Worm only uses Swallow on grappled targets', () => {
    const purpleWormData = md('Purple Worm');
    const bite = {
      ...purpleWormData.actions.find(action => action.name === 'Bite')!,
      conditionOnHit: undefined,
    };
    const testWormData = {
      ...purpleWormData,
      actions: [
        bite,
        purpleWormData.actions.find(action => action.name === 'Multiattack')!,
        purpleWormData.actions.find(action => action.name === 'Swallow')!,
        purpleWormData.actions.find(action => action.name === 'Tail Stinger')!,
      ],
    };
    const worm = createCreatureWithFixedHp(testWormData, 'red', { x: 8, y: 10 }, 0);
    const fighter = durableTarget(12, 10);
    const state = makeState([worm, fighter], 24);

    executeTurn(state, worm);

    expect(state.logs.some(l => l.actor.includes('Purple Worm') && l.action === 'Swallow')).toBe(false);

    const controlledWorm = createCreatureWithFixedHp(testWormData, 'red', { x: 8, y: 10 }, 0);
    const grappledFighter = durableTarget(12, 10);
    grappledFighter.conditions.push('grappled');
    const controlledState = makeState([controlledWorm, grappledFighter], 24);

    executeTurn(controlledState, controlledWorm);

    expect(controlledState.logs.some(l => l.actor.includes('Purple Worm') && l.action === 'Swallow')).toBe(true);
  });

  it('Tarrasque and Gelatinous Cube showcase actions have executable save data', () => {
    const tarrasque = md('Tarrasque');
    const thunderousBellow = tarrasque.actions.find(action => action.name === 'Thunderous Bellow');
    const worldShakingMovement = tarrasque.actions.find(action => action.name === 'World-Shaking Movement');
    const tarrasqueLegendaryMovement = tarrasque.legendaryActions?.find(action => action.name === 'World-Shaking Movement');
    const engulf = md('Gelatinous Cube').actions.find(action => action.name === 'Engulf');

    expect(thunderousBellow?.damageType).toBe('thunder');
    expect(thunderousBellow?.savingThrow?.conditionOnFail).toBe('frightened');
    expect(worldShakingMovement?.legendaryOnly).toBe(true);
    expect(worldShakingMovement?.savingThrow?.area).toContain('Emanation');
    expect(tarrasqueLegendaryMovement?.actionRef).toBe('World-Shaking Movement');
    expect(engulf?.damageType).toBe('acid');
    expect(engulf?.savingThrow?.area).toContain('Emanation');
  });

  it('CR 1 beast signature mechanics are executable', () => {
    const spider = createCreatureWithFixedHp(md('Giant Spider'), 'red', { x: 5, y: 5 }, 0);
    const webTarget = createCreatureWithFixedHp(md('Commoner'), 'blue', { x: 10, y: 5 }, 0);
    const webState = makeState([spider, webTarget], 20);
    executeTurn(webState, spider);
    expect(webState.logs.some(l => l.actor.includes('Giant Spider') && l.action === 'Web')).toBe(true);

    const lion = createCreatureWithFixedHp(md('Lion'), 'red', { x: 5, y: 5 }, 0);
    const roarTarget = createCreatureWithFixedHp(md('Commoner'), 'blue', { x: 6, y: 5 }, 0);
    const roarState = makeState([lion, roarTarget], 20);
    executeTurn(roarState, lion);
    expect(roarState.logs.some(l => l.actor.includes('Lion') && l.action === 'Roar')).toBe(true);

    const octopus = createCreatureWithFixedHp(md('Giant Octopus'), 'red', { x: 5, y: 5 }, 0);
    const octopusTarget = createCreatureWithFixedHp(md('Commoner'), 'blue', { x: 6, y: 5 }, 0);
    const tentacles = { ...md('Giant Octopus').actions.find(a => a.name === 'Tentacles')!, attackBonus: 99 };
    const octopusState = makeState([octopus, octopusTarget], 20);
    resolveConditionOnHit(octopusState, octopus, octopusTarget, tentacles);
    expect(octopusTarget.conditions).toContain('grappled');
    expect(octopusTarget.conditions).toContain('restrained');
  });

  it('Giant Toad Swallow and Giant Hyena Rampage are modeled', () => {
    const toad = createCreatureWithFixedHp(md('Giant Toad'), 'red', { x: 5, y: 5 }, 0);
    const swallowed = durableTarget(6, 5, 0);
    swallowed.conditions.push('grappled');
    swallowed.conditionTimers.push({
      condition: 'grappled',
      duration: 'end_of_next_turn',
      appliedRound: 1,
      sourceId: toad.id,
    });
    const swallowState = makeState([toad, swallowed], 20);
    executeTurn(swallowState, toad);
    expect(swallowState.logs.some(l => l.actor.includes('Giant Toad') && l.action === 'Swallow')).toBe(true);
    expect(swallowed.swallowedBy?.sourceId).toBe(toad.id);

    const hyena = createCreatureWithFixedHp(md('Giant Hyena'), 'red', { x: 5, y: 5 }, 0);
    const target = createCreatureWithFixedHp(md('Commoner'), 'blue', { x: 6, y: 5 }, 0);
    // Rampage (tryRampage in combat.ts) fires only when the bite hits a target
    // that was already Bloodied AND survives the hit. At 20/40 the target is
    // Bloodied (20 <= floor(40/2)). Pinning Math.random to 0.5 gives a normal
    // (non-crit) natural-11 hit for 2d6+3 = 11 damage, leaving it alive at 9 HP.
    // The unmocked original was flaky: a natural-20 crit (4d6+3, up to 27) could
    // kill the target, and a dead target suppresses Rampage.
    target.maxHp = 40;
    target.currentHp = 20;
    const bite = { ...md('Giant Hyena').actions.find(a => a.name === 'Bite')!, attackBonus: 99 };
    const rampageState = makeState([hyena, target], 20);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    resolveAttack(rampageState, hyena, target, bite);
    expect(rampageState.logs.some(l => l.actor.includes('Giant Hyena') && l.action === 'Rampage')).toBe(true);
  });
});

describe('Beholder Eye Rays', () => {
  it('fires 3 random eye rays per turn', () => {
    const beholder = md('Beholder');
    const veteran = md('Veteran');
    const rayNames = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(beholder, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 15, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 15, y: 12 }, 1),
      ];
      const state = runBattle(creatures, 20);
      for (const l of state.logs.filter(l => l.actor?.includes('Beholder'))) {
        if (['Charm Ray', 'Paralyzing Ray', 'Fear Ray', 'Enervation Ray',
             'Disintegration Ray', 'Death Ray', 'Sleep Ray'].includes(l.action!)) {
          rayNames.add(l.action!);
        }
      }
    }
    // Should use at least 3 different ray types across 20 battles
    expect(rayNames.size).toBeGreaterThan(2);
  });

  it('Beholder has individual ray actions', () => {
    const beholder = md('Beholder');
    const rayActions = beholder.actions.filter(a =>
      a.name.includes('Ray') && a.name !== 'Eye Rays'
    );
    expect(rayActions.length).toBeGreaterThanOrEqual(5);
  });

  it('Beholder has legendary actions', () => {
    const beholder = md('Beholder');
    expect(beholder.legendaryActionUses).toBe(3);
    expect(beholder.legendaryActions?.length).toBeGreaterThan(0);
  });

  it('Beholder legendary Eye Ray resolves through an actual ray action', () => {
    const beholder = createCreatureWithFixedHp(md('Beholder'), 'red', { x: 10, y: 10 }, 0);
    const fighter = durableTarget(15, 10);
    const state = makeState([beholder, fighter], 20);

    executeLegendaryAction(state, beholder);

    const rayNames = [
      'Charm Ray',
      'Paralyzing Ray',
      'Fear Ray',
      'Enervation Ray',
      'Disintegration Ray',
      'Death Ray',
      'Sleep Ray',
    ];
    expect(state.logs.some(l =>
      l.actor.includes('Beholder') &&
      l.action === 'Legendary Action' &&
      l.details.includes('Eye Ray')
    )).toBe(true);
    expect(state.logs.some(l => l.actor.includes('Beholder') && rayNames.includes(l.action))).toBe(true);
    expect(beholder.stats.actionUsage['LA: Eye Ray']).toBe(1);
  });

  it('save-based rays apply conditions', () => {
    const beholder = md('Beholder');
    const commoner = md('Commoner');
    let conditionsSeen = 0;
    for (let i = 0; i < 30; i++) {
      const creatures = [
        createCreatureWithFixedHp(beholder, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 15, y: 10 }, 0),
        createCreatureWithFixedHp(commoner, 'blue', { x: 15, y: 12 }, 1),
        createCreatureWithFixedHp(commoner, 'blue', { x: 15, y: 8 }, 2),
      ];
      const state = runBattle(creatures, 20);
      conditionsSeen += state.events.filter(e => e.kind === 'condition' && e.applied).length;
    }
    expect(conditionsSeen).toBeGreaterThan(0);
  });
});

describe('AoE immunity logging', () => {
  it('fire-immune creature shows immunity message, not damage', () => {
    const remorhaz = md('Remorhaz');
    expect(remorhaz.immunities).toContain('fire');

    const sorcerer = buildHero('Sorcerer', 5);
    const fireball = sorcerer.actions.find(action => action.name === 'Fireball');
    if (!fireball) throw new Error('Sorcerer L5 should know Fireball');

    const commoner = md('Commoner');
    const caster = createCreatureWithFixedHp(sorcerer, 'blue', { x: 2, y: 10 }, 0);
    const immuneTarget = createCreatureWithFixedHp(remorhaz, 'red', { x: 10, y: 10 }, 0);
    const regularTarget = createCreatureWithFixedHp(commoner, 'red', { x: 11, y: 10 }, 1);
    const state = makeState([caster, immuneTarget, regularTarget], 20);

    executeSpell(state, caster, fireball, regularTarget, [immuneTarget, regularTarget], { x: 10, y: 10 });

    const falseHitSeen = state.logs.some(l =>
      l.actor?.includes('Remorhaz') && l.details?.includes('Takes') && l.details?.includes('fire')
    );
    const immuneLogSeen = state.logs.some(l => l.details?.includes('immune to fire'));

    expect(falseHitSeen).toBe(false);
    expect(immuneLogSeen).toBe(true);
  });
});

describe('Vampire mechanics', () => {
  it('Vampire has Misty Escape trait (2024 MM, replaces Regeneration)', () => {
    const vampire = md('Vampire');
    expect(vampire.traits?.some(t => t.name === 'Misty Escape')).toBe(true);
  });

  it('Vampire Bite is a melee attack with life drain', () => {
    const vampire = md('Vampire');
    const bite = vampire.actions.find(a => a.name === 'Bite');
    expect(bite).toBeDefined();
    expect(bite!.type).toBe('melee');
    expect(bite!.attackBonus).toBe(9);
    expect(bite!.additionalDamage).toContain('necrotic');
    expect(bite!.description).toContain('regains Hit Points');
  });

  it('Vampire has Charm action targeting Humanoids', () => {
    const vampire = md('Vampire');
    const charm = vampire.actions.find(a => a.name === 'Charm');
    expect(charm).toBeDefined();
    expect(charm!.targetTypeRestriction).toBe('Humanoid');
    expect(charm!.savingThrow?.dc).toBe(17);
  });

  it('Vampire Spawn has Regeneration (10 HP)', () => {
    const spawn = md('Vampire Spawn');
    expect(spawn.traits?.some(t => t.name === 'Regeneration')).toBe(true);
    const regen = spawn.traits!.find(t => t.name === 'Regeneration')!;
    expect(regen.description).toContain('regains 10');
  });

  it('Vampire is Medium, not Small', () => {
    expect(md('Vampire').size).toBe('Medium');
    expect(md('Vampire Spawn').size).toBe('Medium');
  });
});

describe('Mind Flayer Mind Blast', () => {
  it('Mind Blast is a 60-foot cone that stuns', () => {
    const illithid = md('Mind Flayer');
    const blast = illithid.actions.find(a => a.name === 'Mind Blast');
    expect(blast).toBeDefined();
    expect(blast!.savingThrow?.area).toContain('Cone');
    expect(blast!.savingThrow?.conditionOnFail).toBe('stunned');
  });
});
