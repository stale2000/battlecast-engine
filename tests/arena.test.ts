import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Encounter } from '../src/api/encounter.js';
import { getActiveCreature, getLegalActions, applyLegalAction, startArena } from '../src/api/arena.js';
import { reachableMovementDestinations } from '../src/engine/ai-movement.js';
import { applyDamage, hasDisadvantage, resolveAttack } from '../src/engine/combat.js';
import { rollSaveWithBuffs } from '../src/engine/combat-buffs.js';
import { rollAttack } from '../src/engine/dice.js';
import { withRng } from '../src/engine/rng.js';
import { ARENA_ROUND_CAP, kaggleStep } from '../src/arena.js';
import { HERO_CLASS_NAMES } from '../src/data/heroes.js';

const party = { characters: [{ slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }] };
const init = () => ({ version: 1 as const, mode: 'init' as const, seed: 7, mapId: 'open-arena', roundCap: ARENA_ROUND_CAP, redParty: party, blueParty: party });

describe('Kaggle arena bridge', () => {
  it('is deterministic and validates the fixed four-member party', () => {
    expect(JSON.stringify(kaggleStep(init()))).toBe(JSON.stringify(kaggleStep(init())));
    expect(() => kaggleStep({ ...init(), roundCap: ARENA_ROUND_CAP - 1 })).toThrow(/roundCap/);
    expect(() => kaggleStep({ ...init(), redParty: { characters: [{ slot: 1 }] } })).toThrow(/exactly four/);
    expect(() => kaggleStep({ ...init(), blueParty: { characters: [{ slot: 1 }, { slot: 1 }, { slot: 3 }, { slot: 4 }] } })).toThrow(/once/);
  });

  it('rejects malformed requests without mutating supplied state', () => {
    const initial = kaggleStep(init());
    const before = JSON.stringify(initial.state);
    const team = initial.statuses.red === 'ACTIVE' ? 'red' : 'blue';
    expect(() => kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: { id: 'move_to', x: 0.5, y: 0 } })).toThrow(/integer/);
    expect(JSON.stringify(initial.state)).toBe(before);
  });

  it('accepts every current legal action and rejects stale or wrong-team actions without mutation', () => {
    const initial = kaggleStep(init());
    const team = initial.statuses.red === 'ACTIVE' ? 'red' : 'blue';
    const inactiveTeam = team === 'red' ? 'blue' : 'red';
    const actions = initial.observations[team].legalActions;
    const active = initial.observations[team].activeCreatureIds[0];
    expect(kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: actions.find(action => action.type !== 'move_to')! }).state).toBeTruthy();
    for (const action of actions) {
      const encounter = Encounter.fromJSON(initial.state);
      if (action.type === 'move_to') {
        const activeCreature = getActiveCreature(encounter)!;
        const destination = reachableMovementDestinations(activeCreature, encounter.state!)[0]!;
        applyLegalAction(encounter, { ...action, destination: { x: destination.x, y: destination.y } });
      } else {
        applyLegalAction(encounter, action);
      }
    }
    const before = JSON.stringify(initial.state);
    expect(() => kaggleStep({ version: 1, mode: 'step', state: initial.state, team: inactiveTeam, action: 'end_turn' })).toThrow(/does not own/);
    expect(JSON.stringify(initial.state)).toBe(before);
    expect(() => kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: 'stale' })).toThrow(/Illegal or stale/);
    if (actions.some(action => action.type === 'move_to')) {
      expect(() => kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: { id: 'move_to', x: -1, y: -1 } })).toThrow(/move destination/);
      expect(JSON.stringify(initial.state)).toBe(before);
    }
    expect(active).toBeTruthy();
  });

  it('rejects a restored arena state with a changed round cap', () => {
    const initial = kaggleStep(init());
    const team = initial.statuses.red === 'ACTIVE' ? 'red' : 'blue';
    const tampered = structuredClone(initial.state);
    tampered.arenaRoundCap = 1;
    expect(() => kaggleStep({ version: 1, mode: 'step', state: tampered, team, action: 'end_turn' })).toThrow(/roundCap/);
  });

  it('makes Dodge impose disadvantage and consumes Steady Aim after one attack', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Rogue', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    const state = encounter.state!;
    const rogue = state.creatures.find(creature => creature.team === 'red')!;
    const target = state.creatures.find(creature => creature.team === 'blue')!;
    const attack = rogue.monsterData.actions.find(action => action.attackBonus !== undefined)!;
    target.turnFlags.dodge = true;
    expect(hasDisadvantage(rogue, target, attack)).toBe(true);
    delete target.turnFlags.dodge;
    rogue.turnFlags.steadyAim = true;
    encounter.runWithRng(() => resolveAttack(state, rogue, target, attack));
    expect(rogue.turnFlags.steadyAimConsumed).toBe(true);
  });

  it('keeps opponent build details out of team observations and validates custom point-buy heroes', () => {
    const customParty = {
      characters: Array.from({ length: 4 }, () => ({
        heroClass: 'Fighter',
        abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
      })),
    };
    const result = kaggleStep({ ...init(), redParty: customParty, blueParty: customParty });
    expect(result.observations.red.publicCombatState.creatures.filter(c => c.team === 'blue').every(c => !('build' in c) && !('hp' in c) && 'creatureType' in c && 'visibleEquipment' in c)).toBe(true);
    expect(result.observations.red.publicCombatState.creatures.filter(c => c.team === 'red').every(c => 'build' in c && 'preparedSpells' in c.build && 'equipment' in c.build)).toBe(true);
    expect(() => kaggleStep({ ...init(), redParty: { characters: [{ heroClass: 'Fighter', abilities: { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 } }] } })).toThrow(/exactly four/);
  });

  it('applies SRD 5.2.1 background increases and static species traits', () => {
    const dwarfSoldier = {
      heroClass: 'Fighter', species: 'Dwarf', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
      abilityIncreases: { str: 2, con: 1 },
    };
    const originParty = { characters: Array.from({ length: 4 }, () => dwarfSoldier) };
    const result = kaggleStep({ ...init(), redParty: originParty, blueParty: originParty });
    const red = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
    expect(red.monsterData.abilities).toMatchObject({ str: 17, con: 14 });
    expect(red.monsterData.heroSpecies).toBe('Dwarf');
    expect(red.monsterData.heroBackground).toBe('Soldier');
    expect(red.monsterData.originFeat).toBe('Savage Attacker');
    expect(red.monsterData.resistances).toContain('poison');
    expect(red.monsterData.hp).toBeGreaterThan(0);
    expect(result.observations.red.publicCombatState.creatures.filter(creature => creature.team === 'red').every(creature => 'build' in creature && creature.build.species === 'Dwarf')).toBe(true);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...dwarfSoldier, abilityIncreases: { int: 2, con: 1 } })) }, blueParty: originParty })).toThrow(/listed abilities/);
  });

  it('accepts the SRD Small-or-Medium choice only for Human and Tiefling', () => {
    const human = {
      heroClass: 'Fighter', species: 'Human', background: 'Soldier', size: 'Small',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => human) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.size).toBe('Small');
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...human, species: 'Dwarf' })) }, blueParty: party })).toThrow(/size is selectable/);
  });

  it('requires a Tiefling legacy and applies its automatic resistance', () => {
    const tiefling = {
      heroClass: 'Fighter', species: 'Tiefling', tieflingLegacy: 'Infernal', background: 'Soldier', size: 'Small',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => tiefling) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.resistances).toContain('fire');
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...tiefling, tieflingLegacy: undefined })) }, blueParty: party })).toThrow(/tieflingLegacy/);
  });

  it('requires an Elf lineage and applies Wood Elf speed', () => {
    const elf = {
      heroClass: 'Fighter', species: 'Elf', elfLineage: 'Wood Elf', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => elf) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.speed.walk).toBe(35);
  });

  it('applies Gnomish Cunning automatically to mental saves', () => {
    const encounter = new Encounter({ seed: 1 });
    const [gnome] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Gnome' }, team: 'red' });
    encounter.addCreature({ monster: 'Ogre', team: 'blue' });
    encounter.start();
    const creature = encounter.state!.creatures.find(candidate => candidate.id === gnome.id)!;
    encounter.runWithRng(() => expect(rollSaveWithBuffs(creature, 0, false, 10, 'wis').rolls).toHaveLength(2));
  });

  it('requires and preserves Gnome and Goliath SRD ancestry choices', () => {
    const build = (species: 'Gnome' | 'Goliath', choice: string) => ({ heroClass: 'Fighter', species, background: 'Soldier', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 }, ...(species === 'Gnome' ? { gnomeLineage: choice } : { goliathAncestry: choice }) });
    for (const [species, choice] of [['Gnome', 'Forest Gnome'], ['Goliath', 'Cloud']] as const) {
      const party = { characters: Array.from({ length: 4 }, () => build(species, choice)) };
      const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
      expect(result.observations.red.publicCombatState.creatures.find(creature => creature.team === 'red')!.build.speciesChoice).toBe(choice);
    }
  });

  it('resolves Goliath Large Form through the legal-action catalogue', () => {
    const encounter = new Encounter({ seed: 1 });
    const [goliath] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Goliath', additionalResources: { 'goliath-large-form': 1 } }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [goliath.id];
    startArena(encounter);
    const active = getActiveCreature(encounter)!;
    const before = active.movementRemaining;
    applyLegalAction(encounter, getLegalActions(encounter, active.id).find(action => action.type === 'species_large_form')!);
    expect(active.temporarySize).toBe('Large');
    expect(active.movementRemaining).toBe(before + 10);
    expect(active.resources['goliath-large-form']).toBe(0);
  });

  it('rerolls Halfling natural ones in the shared d20 primitive', () => {
    const values = [0, 0.5, 0.9];
    const rng = { next: () => values.shift()! };
    expect(withRng(rng, () => rollAttack(0, false, false, true).naturalRoll)).toBe(19);
  });

  it('constructs a Dragonborn Breath Weapon with its chosen ancestry', () => {
    const dragonborn = {
      heroClass: 'Fighter', species: 'Dragonborn', background: 'Soldier', dragonAncestry: 'fire',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const dragonParty = { characters: Array.from({ length: 4 }, () => dragonborn) };
    const result = kaggleStep({ ...init(), redParty: dragonParty, blueParty: dragonParty });
    const dragon = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
    const breath = dragon.monsterData.actions.find(action => action.name === 'Breath Weapon')!;
    expect(breath.damageType).toBe('fire');
    expect(breath.resourceCost).toEqual({ key: 'dragonborn-breath', amount: 1 });
    expect(dragon.resources['dragonborn-breath']).toBe(3);
  });

  it('offers Dragonborn Breath Weapon as either shape and as an attack replacement', () => {
    const encounter = new Encounter({ seed: 1 });
    const [dragon] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: {
      species: 'Dragonborn', additionalActions: [{
        name: 'Breath Weapon', type: 'special', description: 'test breath', replacesAttack: true,
        resourceCost: { key: 'dragonborn-breath', amount: 1 },
        savingThrow: { ability: 'dex', dc: 13, damageOnFail: '2d10', damageOnSuccess: 'half', area: '15-foot cone or 30-foot line' },
      }], additionalResources: { 'dragonborn-breath': 3 },
    }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [dragon.id];
    startArena(encounter);
    const active = getActiveCreature(encounter)!;
    const breath = getLegalActions(encounter, active.id).filter(action => action.type === 'spell' && action.actionName === 'Breath Weapon');
    expect(breath.map(action => action.areaShape).sort()).toEqual(['15-foot cone', '30-foot line']);
    applyLegalAction(encounter, getLegalActions(encounter, active.id).find(action => action.type === 'attack')!);
    expect(getLegalActions(encounter, active.id).some(action => action.type === 'spell' && action.actionName === 'Breath Weapon')).toBe(true);
  });

  it('resolves Dragonborn Draconic Flight through the legal-action catalogue', () => {
    const encounter = new Encounter({ seed: 1 });
    const [dragon] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Dragonborn', additionalResources: { 'dragonborn-flight': 1 } }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [dragon.id];
    startArena(encounter);
    const active = getActiveCreature(encounter)!;
    applyLegalAction(encounter, getLegalActions(encounter, active.id).find(action => action.type === 'species_flight')!);
    expect(active.temporaryFlightSpeed).toBe(active.monsterData.speed.walk);
    expect(active.resources['dragonborn-flight']).toBe(0);
  });

  it('resolves Orc Adrenaline Rush through the legal-action catalogue', () => {
    const encounter = new Encounter({ seed: 1 });
    const [orc] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Orc', additionalResources: { 'orc-adrenaline-rush': 3 } }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [orc.id];
    startArena(encounter);
    const active = getActiveCreature(encounter)!;
    const before = active.movementRemaining;
    applyLegalAction(encounter, getLegalActions(encounter, active.id).find(action => action.type === 'species_dash')!);
    expect(active.movementRemaining).toBeGreaterThan(before);
    expect(active.temporaryHp).toBe(3);
    expect(active.resources['orc-adrenaline-rush']).toBe(2);
  });

  it('applies Orc Relentless Endurance automatically without a reaction choice', () => {
    const encounter = new Encounter({ seed: 1 });
    const [orc] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Orc' }, team: 'red' });
    const [attacker] = encounter.addCreature({ monster: 'Ogre', team: 'blue' });
    encounter.start();
    const target = encounter.state!.creatures.find(creature => creature.id === orc.id)!;
    encounter.runWithRng(() => applyDamage(encounter.state!, target, target.currentHp + 1, 'slashing', encounter.state!.creatures.find(creature => creature.id === attacker.id)!, true));
    expect(target.currentHp).toBe(1);
    expect(target.turnFlags.orcRelentlessEndurance).toBe(true);
  });

  it('resolves background origin feats through canonical initiative and damage paths', () => {
    const alert = new Encounter({ seed: 2 });
    const [alertHero] = alert.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { originFeat: 'Alert' }, team: 'red' });
    alert.addCreature({ monster: 'Ogre', team: 'blue' });
    alert.start();
    const alertCreature = alert.state!.creatures.find(creature => creature.id === alertHero.id)!;
    expect(alertCreature.initiative).toBeGreaterThanOrEqual(alertCreature.monsterData.proficiencyBonus + 1 + 1);

    const savage = new Encounter({ seed: 3 });
    savage.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { originFeat: 'Savage Attacker' }, team: 'red', position: { x: 0, y: 0 } });
    savage.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    savage.start();
    const attacker = savage.state!.creatures.find(creature => creature.team === 'red')!;
    const defender = savage.state!.creatures.find(creature => creature.team === 'blue')!;
    expect(attacker.monsterData.originFeat).toBe('Savage Attacker');
    const attack = attacker.monsterData.actions.find(action => action.attackBonus !== undefined)!;
    attack.attackBonus = 100;
    savage.runWithRng(() => resolveAttack(savage.state!, attacker, defender, attack));
    if (!attacker.turnFlags.savageAttackerUsed) savage.runWithRng(() => resolveAttack(savage.state!, attacker, defender, attack));
    expect(attacker.turnFlags.savageAttackerUsed).toBe(true);
  });

  it('accepts only engine-listed spell selections for custom casters', () => {
    const wizard = {
      heroClass: 'Wizard', abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      spells: ['Magic Missile', 'Burning Hands', 'Thunderwave', 'Sleep', 'Scorching Ray', 'Web', 'Fireball', 'Lightning Bolt'],
    };
    const casterParty = { characters: Array.from({ length: 4 }, () => wizard) };
    expect(kaggleStep({ ...init(), redParty: casterParty, blueParty: casterParty }).state).toBeTruthy();
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...wizard, spells: ['Wish'] })) }, blueParty: casterParty })).toThrow(/spells/);
  });

  it('builds Magic Initiate background spells with an authoritative free cast', () => {
    const acolyte = {
      heroClass: 'Fighter', species: 'Human', background: 'Acolyte', size: 'Medium',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { wis: 2, cha: 1 },
      originCantrips: ['Sacred Flame', 'Toll the Dead'], originSpell: 'Guiding Bolt', originCastingAbility: 'wis',
    };
    const party = { characters: Array.from({ length: 4 }, () => acolyte) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    const hero = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
    expect(hero.monsterData.actions.map(action => action.name)).toEqual(expect.arrayContaining(['Sacred Flame', 'Toll the Dead', 'Guiding Bolt']));
    expect(hero.resources['magic-initiate']).toBe(1);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...acolyte, originCantrips: ['Sacred Flame'] })) }, blueParty: party })).toThrow(/originCantrips/);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...acolyte, background: 'Soldier', abilityIncreases: { str: 2, con: 1 } })) }, blueParty: party })).toThrow(/Magic Initiate/);
  });

  it('accepts only exact reachable move destinations and runs opportunity attacks', () => {
    const encounter = new Encounter({ seed: 1 });
    const [mover] = encounter.addCreature({ monster: 'Goblin Warrior', team: 'red', position: { x: 0, y: 0 } });
    const [guard] = encounter.addCreature({ monster: 'Goblin Warrior', team: 'blue', position: { x: 1, y: 0 } });
    encounter.addCreature({ monster: 'Goblin Warrior', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [mover.id];
    startArena(encounter);
    const action = getLegalActions(encounter, mover.id).find(candidate => candidate.type === 'move_to');
    expect(action).toBeTruthy();
    const destination = reachableMovementDestinations(getActiveCreature(encounter)!, encounter.state!).find(cell => cell.x === 0 && cell.y === 2)!;
    expect(destination).toBeTruthy();
    applyLegalAction(encounter, { ...action!, destination: { x: destination.x, y: destination.y } });
    expect(encounter.state!.creatures.find(creature => creature.id === guard.id)!.reactionUsed).toBe(true);
  });

  it('offers and resolves supported resource actions without trusting client parameters', () => {
    const encounter = new Encounter({ seed: 1 });
    const [fighter] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [fighter.id];
    const active = encounter.state!.creatures.find(creature => creature.id === fighter.id)!;
    active.currentHp -= 10;
    startArena(encounter);
    const action = getLegalActions(encounter, fighter.id).find(candidate => candidate.type === 'spell' && candidate.actionName === 'Second Wind');
    expect(action).toBeTruthy();
    const before = active.currentHp;
    const uses = active.resources['second-wind'];
    applyLegalAction(encounter, action!);
    expect(active.currentHp).toBeGreaterThan(before);
    expect(active.resources['second-wind']).toBe(uses - 1);
  });

  it('keeps a multiattack creature active until every attack roll is spent', () => {
    const encounter = new Encounter({ seed: 1 });
    const [fighter] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [fighter.id];
    startArena(encounter);
    const first = getLegalActions(encounter, fighter.id).find(action => action.type === 'attack')!;
    applyLegalAction(encounter, first);
    expect(getLegalActions(encounter, fighter.id).some(action => action.type === 'attack')).toBe(true);
    applyLegalAction(encounter, getLegalActions(encounter, fighter.id).find(action => action.type === 'attack')!);
    expect(getLegalActions(encounter, fighter.id).some(action => action.type === 'attack')).toBe(false);
    const surge = getLegalActions(encounter, fighter.id).find(action => action.type === 'action_surge');
    expect(surge).toBeTruthy();
    applyLegalAction(encounter, surge!);
    expect(getLegalActions(encounter, fighter.id).some(action => action.type === 'attack')).toBe(true);
  });

  it('keeps canonical AoE and dart target sets engine-owned', () => {
    const initial = kaggleStep(init());
    const team = initial.statuses.red === 'ACTIVE' ? 'red' : 'blue';
    const darts = initial.observations[team].legalActions.find(action => action.type === 'spell' && action.actionName === 'Magic Missile');
    const area = initial.observations[team].legalActions.find(action => action.type === 'spell' && action.actionName === 'Fireball');
    expect(darts?.targetIds).toHaveLength(3);
    expect(area?.targetIds?.length).toBeGreaterThan(0);
    expect(kaggleStep({ version: 1, mode: 'step', state: initial.state, team, action: darts! }).state).toBeTruthy();
  });

  it('applies every exposed action across a complete party turn cycle', () => {
    let result = kaggleStep(init());
    for (let turn = 0; turn < 8; turn++) {
      const team = result.statuses.red === 'ACTIVE' ? 'red' : 'blue';
      for (const action of result.observations[team].legalActions) {
        if (action.type === 'move_to') {
          const encounter = Encounter.fromJSON(result.state);
          const destination = reachableMovementDestinations(getActiveCreature(encounter)!, encounter.state!)[0]!;
          expect(() => kaggleStep({ version: 1, mode: 'step', state: result.state, team, action: { id: action.id, x: destination.x, y: destination.y } })).not.toThrow();
        } else {
          expect(() => kaggleStep({ version: 1, mode: 'step', state: result.state, team, action })).not.toThrow();
        }
      }
      result = kaggleStep({ version: 1, mode: 'step', state: result.state, team, action: 'end_turn' });
    }
  });

  it('offers only valid Wild Shape forms and applies the selected form', () => {
    const encounter = new Encounter({ seed: 1 });
    const [druid] = encounter.addCreature({ heroClass: 'Druid', heroLevel: 5, heroOverrides: { subclass: 'Circle of the Moon' }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 5, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [druid.id];
    startArena(encounter);
    const action = getLegalActions(encounter, druid.id).find(candidate => candidate.type === 'wild_shape');
    expect(action).toBeTruthy();
    applyLegalAction(encounter, action!);
    expect(encounter.state!.creatures.find(creature => creature.id === druid.id)!.wildShape?.beastName).toBe(action!.beastName);
  });

  it('resolves Monk Flurry of Blows as two server-selected strikes', () => {
    const encounter = new Encounter({ seed: 1 });
    const [monk] = encounter.addCreature({ heroClass: 'Monk', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [monk.id];
    startArena(encounter);
    applyLegalAction(encounter, getLegalActions(encounter, monk.id).find(action => action.type === 'attack')!);
    applyLegalAction(encounter, getLegalActions(encounter, monk.id).find(action => action.type === 'attack')!);
    const flurry = getLegalActions(encounter, monk.id).find(action => action.type === 'monk_strike' && action.flurry);
    expect(flurry).toBeTruthy();
    applyLegalAction(encounter, flurry!);
    expect(getLegalActions(encounter, monk.id).some(action => action.type === 'monk_strike' && action.flurry)).toBe(true);
  });

  it('resolves every exposed action for every supported level-5 class', () => {
    for (const heroClass of HERO_CLASS_NAMES) {
      const encounter = new Encounter({ seed: 1 });
      const [hero] = encounter.addCreature({ heroClass, heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
      encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
      encounter.start();
      encounter.state!.initiativeOrder = [hero.id];
      startArena(encounter);
      const snapshot = encounter.toJSON();
      for (const action of getLegalActions(encounter, hero.id)) {
        const copy = Encounter.fromJSON(snapshot);
        if (action.type === 'move_to') {
          const destination = reachableMovementDestinations(getActiveCreature(copy)!, copy.state!)[0]!;
          expect(() => applyLegalAction(copy, { ...action, destination: { x: destination.x, y: destination.y } })).not.toThrow();
        } else {
          expect(() => applyLegalAction(copy, action)).not.toThrow();
        }
      }
    }
  });

  it('ends at the configured round cap and keeps CLI protocol output on stdout', () => {
    const playToCap = () => {
      let result = kaggleStep(init());
      while (result.statuses.red !== 'DONE') {
        const team = result.statuses.red === 'ACTIVE' ? 'red' : 'blue';
        result = kaggleStep({ version: 1, mode: 'step', state: result.state, team, action: 'end_turn' });
      }
      return result;
    };
    const result = playToCap();
    expect(playToCap()).toEqual(result);
    expect(result.rewards.red).toBeGreaterThanOrEqual(-1);
    const cli = spawnSync(process.execPath, ['dist/mcp/cli.js', 'arena', 'kaggle-step'], { input: JSON.stringify(init()), encoding: 'utf8' });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout).state).toBeTruthy();
    expect(cli.stderr).toBe('');
    const malformed = spawnSync(process.execPath, ['dist/mcp/cli.js', 'arena', 'kaggle-step'], { input: '{', encoding: 'utf8' });
    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toBe('');
    expect(malformed.stderr).toMatch(/^INVALID_REQUEST:/);
    const validParty = spawnSync(process.execPath, ['dist/mcp/cli.js', 'arena', 'validate-party'], {
      input: JSON.stringify({ team: 'red', party }), encoding: 'utf8',
    });
    expect(validParty.status).toBe(0);
    expect(validParty.stdout).toBe('{"valid":true}\n');
  });
});
