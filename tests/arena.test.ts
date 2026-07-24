import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Encounter } from '../src/api/encounter.js';
import { getActiveCreature, getLegalActions, applyLegalAction, startArena } from '../src/api/arena.js';
import { reachableMovementDestinations } from '../src/engine/ai-movement.js';
import { processTurnStart } from '../src/engine/ai-turn.js';
import { applyDamage, applyDamageRollPenalty, executeSpell, getEffectiveMoveSpeed, hasDisadvantage, processTargetTurnEndOngoingEffects, resolveAttack, rollAllInitiatives, runDeathSave } from '../src/engine/combat.js';
import { dropConcentratedBuffsFrom } from '../src/engine/combat-buffs.js';
import { canSee } from '../src/engine/ai-targeting.js';
import { rollSaveWithBuffs } from '../src/engine/combat-buffs.js';
import { rollAttack } from '../src/engine/dice.js';
import { withRng } from '../src/engine/rng.js';
import { ARENA_ROUND_CAP, kaggleStep } from '../src/arena.js';
import { buildHero, getAvailableSpells, HERO_CLASS_NAMES } from '../src/data/heroes.js';
import { ARENA_WEAPONS } from '../src/data/arena-origins.js';
import { barkskin, bladeWard, blindingSmite, fly, hellishRebuke, heroism, lesserRestoration, magicWeapon, mistyStep, moonbeam, resistance, shield, shiningSmite, spiritualWeapon, web, witchBolt } from '../src/data/spells.js';

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

  it('resolves restorative and flight spell actions through the authoritative arena path', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({
      heroClass: 'Cleric', heroLevel: 5, team: 'red', position: { x: 0, y: 0 },
      heroOverrides: {
        additionalActions: [lesserRestoration('wis', 3, 3), fly('wis', 3, 3)],
        additionalResources: { 'slot-2': 1, 'slot-3': 1 },
      },
    });
    encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 1, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    const cleric = encounter.state!.creatures.find(creature => creature.team === 'red' && creature.monsterData.heroClass === 'Cleric')!;
    encounter.state!.initiativeOrder = [cleric.id];
    startArena(encounter);
    const ally = encounter.state!.creatures.find(creature => creature.team === 'red' && creature.id !== cleric.id)!;
    ally.conditions.push('poisoned');
    const restoration = getLegalActions(encounter, cleric.id).find(action => action.type === 'spell' && action.actionName === 'Lesser Restoration')!;
    applyLegalAction(encounter, restoration);
    expect(ally.conditions).not.toContain('poisoned');

    cleric.hasActed = false;
    const flight = getLegalActions(encounter, cleric.id).find(action => action.type === 'spell' && action.actionName === 'Fly' && action.targetId === ally.id)!;
    applyLegalAction(encounter, flight);
    expect(ally.temporaryFlightSpeed).toBe(60);
  });

  it('automatically resolves Shield only when its +5 AC changes a noncritical hit to a miss', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [{ name: 'Test Strike', type: 'melee', description: 'test', attackBonus: 1, damage: '1d8', damageType: 'slashing', reach: 5 }] } });
    encounter.addCreature({ heroClass: 'Wizard', heroLevel: 5, team: 'blue', position: { x: 1, y: 0 }, heroOverrides: { acOverride: 10, additionalActions: [shield('int', 3, 3)], additionalResources: { 'slot-1': 1 } } });
    encounter.start();
    const attacker = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    const target = encounter.state!.creatures.find(creature => creature.team === 'blue')!;
    const hp = target.currentHp;
    withRng({ next: () => 0.5 }, () => resolveAttack(encounter.state!, attacker, target, attacker.monsterData.actions.find(action => action.name === 'Test Strike')!));
    expect(target.currentHp).toBe(hp);
    expect(target.resources['slot-1']).toBe(0);
    expect(target.stats.actionUsage.Shield).toBe(1);
  });

  it('resolves Hellish Rebuke as an authoritative reaction rather than a turn action', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [{ name: 'Test Strike', type: 'melee', description: 'test', attackBonus: 100, damage: '1d4', damageType: 'slashing', reach: 5 }] } });
    encounter.addCreature({ heroClass: 'Warlock', heroLevel: 5, team: 'blue', position: { x: 1, y: 0 }, heroOverrides: { additionalActions: [hellishRebuke('cha', 3, 3)], additionalResources: { 'slot-1': 1 } } });
    encounter.start();
    const attacker = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    const target = encounter.state!.creatures.find(creature => creature.team === 'blue')!;
    encounter.runWithRng(() => resolveAttack(encounter.state!, attacker, target, attacker.monsterData.actions.find(action => action.name === 'Test Strike')!));
    expect(target.stats.actionUsage['Hellish Rebuke']).toBe(1);
    expect(target.resources['slot-1']).toBe(0);
  });

  it('validates Misty Step destinations before consuming a slot or moving', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Wizard', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [mistyStep('int', 3, 3)], additionalResources: { 'slot-2': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    const wizard = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    encounter.state!.initiativeOrder = [wizard.id];
    startArena(encounter);
    const teleport = getLegalActions(encounter, wizard.id).find(action => action.type === 'spell_teleport')!;
    const before = JSON.stringify(encounter.toJSON());
    expect(() => applyLegalAction(encounter, { ...teleport, destination: { x: 7, y: 0 } })).toThrow(/Illegal or stale/);
    expect(JSON.stringify(encounter.toJSON())).toBe(before);
    applyLegalAction(encounter, { ...teleport, destination: { x: 4, y: 0 } });
    expect(wizard.position).toEqual({ x: 4, y: 0 });
    expect(wizard.resources['slot-2']).toBe(0);
  });

  it('does not offer or apply Barkskin to a heavy-armored target', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Druid', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [barkskin('wis', 3, 3)], additionalResources: { 'slot-2': 1 } } });
    encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 1, y: 0 }, heroOverrides: { wearingHeavyArmor: true } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    const druid = encounter.state!.creatures.find(creature => creature.monsterData.heroClass === 'Druid')!;
    encounter.state!.initiativeOrder = [druid.id];
    startArena(encounter);
    expect(getLegalActions(encounter, druid.id).some(action => action.actionName === 'Barkskin' && action.targetId !== druid.id)).toBe(false);
    expect(executeSpell(encounter.state!, druid, barkskin('wis', 3, 3), encounter.state!.creatures.find(creature => creature.monsterData.heroClass === 'Fighter')!)).toBe(false);
  });

  it('expires concentration auras with their spell duration', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Druid', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [moonbeam('wis', 3, 3)], additionalResources: { 'slot-2': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    const caster = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    const target = encounter.state!.creatures.find(creature => creature.team === 'blue')!;
    expect(executeSpell(encounter.state!, caster, moonbeam('wis', 3, 3), target, [target], target.position)).toBe(true);
    expect(caster.concentrationAura).toBeTruthy();
    encounter.state!.round += 10;
    processTurnStart(encounter.state!, caster);
    expect(caster.concentrationAura).toBeUndefined();
  });

  it('resolves defensive cantrip buffs through the legal-action path', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Wizard', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [bladeWard('int', 3, 3), resistance('int', 3, 3)] } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    const caster = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    encounter.state!.initiativeOrder = [caster.id];
    startArena(encounter);
    const action = getLegalActions(encounter, caster.id).find(candidate => candidate.actionName === 'Blade Ward')!;
    applyLegalAction(encounter, action);
    expect(caster.activeBuffs.some(buff => buff.key === 'blade-ward')).toBe(true);
  });

  it("offers Witch Bolt's later-turn damage as a validated target choice", () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Wizard', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [witchBolt('int', 3, 3)], additionalResources: { 'slot-1': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    const caster = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    const target = encounter.state!.creatures.find(creature => creature.team === 'blue')!;
    expect(executeSpell(encounter.state!, caster, witchBolt('int', 3, 3), target)).toBe(true);
    encounter.state!.round++;
    encounter.state!.initiativeOrder = [caster.id];
    startArena(encounter);
    const repeat = getLegalActions(encounter, caster.id).find(action => action.type === 'repeat_spell')!;
    const hp = target.currentHp;
    applyLegalAction(encounter, repeat);
    expect(target.currentHp).toBeLessThan(hp);
    expect(caster.bonusActionUsed).toBe(true);
  });

  it('applies Magic Weapon damage and magical-weapon flags through the shared attack state', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Paladin', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [magicWeapon('cha', 3, 3)], additionalResources: { 'slot-2': 1 } } });
    encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red', position: { x: 1, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 2, y: 0 } });
    encounter.start();
    const caster = encounter.state!.creatures.find(creature => creature.monsterData.heroClass === 'Paladin')!;
    const fighter = encounter.state!.creatures.find(creature => creature.monsterData.heroClass === 'Fighter')!;
    expect(executeSpell(encounter.state!, caster, magicWeapon('cha', 3, 3), fighter)).toBe(true);
    expect(fighter.activeBuffs.find(buff => buff.key === 'magic-weapon')).toMatchObject({ weaponDamageBonus: 1, weaponAttacksMagical: true });
  });

  it('applies Heroism each turn and prevents frightened while concentration lasts', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Paladin', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [heroism('cha', 3, 3)], additionalResources: { 'slot-1': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    const paladin = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    expect(executeSpell(encounter.state!, paladin, heroism('cha', 3, 3), paladin)).toBe(true);
    processTurnStart(encounter.state!, paladin);
    expect(paladin.temporaryHp).toBe(3);
    expect(paladin.activeBuffs.find(buff => buff.key === 'heroism')?.conditionImmunities).toContain('frightened');
  });

  it('consumes Shining and Blinding Smite after the next weapon hit', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Paladin', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [shiningSmite('cha', 3, 3), blindingSmite('cha', 3, 3)], additionalResources: { 'slot-2': 1, 'slot-3': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    const paladin = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    const target = encounter.state!.creatures.find(creature => creature.team === 'blue')!;
    const weapon = paladin.monsterData.actions.find(action => action.type === 'melee' && action.attackBonus !== undefined)!;
    expect(executeSpell(encounter.state!, paladin, shiningSmite('cha', 3, 3), target)).toBe(true);
    withRng({ next: () => 0.5 }, () => resolveAttack(encounter.state!, paladin, target, weapon));
    expect(target.activeBuffs.some(buff => buff.key === 'shining-smite')).toBe(false);
    expect(executeSpell(encounter.state!, paladin, blindingSmite('cha', 3, 3), paladin)).toBe(true);
    withRng({ next: () => 0.5 }, () => resolveAttack(encounter.state!, paladin, target, weapon));
    expect(paladin.activeBuffs.some(buff => buff.key === 'blinding-smite')).toBe(false);
  });

  it('retains Spiritual Weapon for validated bonus-action attacks on later turns', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Cleric', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [spiritualWeapon('wis', 3, 3)], additionalResources: { 'slot-2': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 5, y: 0 } });
    encounter.start();
    const cleric = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    const target = encounter.state!.creatures.find(creature => creature.team === 'blue')!;
    expect(executeSpell(encounter.state!, cleric, spiritualWeapon('wis', 3, 3), target)).toBe(true);
    expect(cleric.spiritualWeapon).toBeTruthy();
    encounter.state!.round++;
    encounter.state!.initiativeOrder = [cleric.id];
    startArena(encounter);
    const attack = getLegalActions(encounter, cleric.id).find(action => action.type === 'spiritual_weapon')!;
    const logs = encounter.state!.logs.filter(log => log.action === 'Spiritual Weapon').length;
    applyLegalAction(encounter, attack);
    expect(encounter.state!.logs.filter(log => log.action === 'Spiritual Weapon')).toHaveLength(logs + 1);
    expect(cleric.bonusActionUsed).toBe(true);
  });

  it('ends Web restraint when its concentration is dropped', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Wizard', heroLevel: 5, team: 'red', position: { x: 0, y: 0 }, heroOverrides: { additionalActions: [web('int', 3, 3)], additionalResources: { 'slot-2': 1 } } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    const caster = encounter.state!.creatures.find(creature => creature.team === 'red')!;
    const target = encounter.state!.creatures.find(creature => creature.team === 'blue')!;
    withRng({ next: () => 0 }, () => expect(executeSpell(encounter.state!, caster, web('int', 3, 3), target, [target], target.position)).toBe(true));
    expect(target.conditions).toContain('restrained');
    expect(target.activeBuffs.some(buff => buff.key === 'web')).toBe(true);
    dropConcentratedBuffsFrom(encounter.state!, caster.id);
    expect(target.conditions).not.toContain('restrained');
    expect(target.activeBuffs.some(buff => buff.key === 'web')).toBe(false);
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

  it('enforces Loading across player-selected extra attacks', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { weapons: [{ name: 'Light Crossbow', die: '1d8', damageType: 'piercing', type: 'ranged', range: { normal: 80, long: 320 }, loading: true }] }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 5, y: 0 } });
    encounter.start();
    const state = encounter.state!;
    const hero = state.creatures.find(creature => creature.team === 'red')!;
    state.initiativeOrder = [hero.id];
    startArena(encounter);
    const first = getLegalActions(encounter, hero.id).find(action => action.type === 'attack' && action.actionName === 'Light Crossbow')!;
    applyLegalAction(encounter, first);
    expect(getLegalActions(encounter, hero.id).some(action => action.type === 'attack' && action.actionName === 'Light Crossbow')).toBe(false);
  });

  it('applies Heavy and Lance disadvantage through the shared attack resolver', () => {
    const encounter = new Encounter({ seed: 1 });
    encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { sizeOverride: 'Small', weapons: [{ name: 'Heavy Crossbow', die: '1d10', damageType: 'piercing', type: 'ranged', range: { normal: 100, long: 400 }, heavy: true }] }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    const [attacker, target] = encounter.state!.creatures;
    expect(hasDisadvantage(attacker, target, attacker.monsterData.actions.find(action => action.name === 'Heavy Crossbow')!)).toBe(true);
    attacker.monsterData.actions = [{ name: 'Lance', type: 'melee', attackBonus: 6, damage: '1d10+3', damageType: 'piercing', reach: 10, closeRangeDisadvantage: true, description: 'test' }];
    expect(hasDisadvantage(attacker, target, attacker.monsterData.actions[0]!)).toBe(true);
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

  it('accepts only catalog weapons that the class is proficient with', () => {
    const fighter = { heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', weapons: ['Greatsword'], abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const party = { characters: Array.from({ length: 4 }, () => fighter) };
    expect(kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.some(creature => creature.monsterData.actions.some(action => action.name === 'Greatsword'))).toBe(true);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...fighter, heroClass: 'Wizard' })) }, blueParty: party })).toThrow(/not proficient/);
  });

  it('enforces category-based equipment training and finesse ability selection', () => {
    const dexFighter = { heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', weapons: ['Rapier'], abilities: { str: 8, dex: 15, con: 15, int: 13, wis: 12, cha: 8 }, abilityIncreases: { dex: 2, con: 1 } };
    const party = { characters: Array.from({ length: 4 }, () => dexFighter) };
    const rapier = kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.actions.find(action => action.name === 'Rapier')!;
    expect(rapier.attackBonus).toBe(6);
    const rogue = { ...dexFighter, heroClass: 'Rogue', weapons: ['Rapier'], armor: 'Leather' };
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => rogue) }, blueParty: party })).not.toThrow();
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...rogue, weapons: ['Longbow'] })) }, blueParty: party })).toThrow(/not proficient/);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...rogue, armor: 'Scale Mail' })) }, blueParty: party })).toThrow(/not proficient/);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...dexFighter, weapons: ['Greatsword'], shield: true })) }, blueParty: party })).toThrow(/two-handed/);
  });

  it('exposes both legal melee and thrown attacks for catalog thrown weapons', () => {
    const fighter = { heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', weapons: ['Javelin'], abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const party = { characters: Array.from({ length: 4 }, () => fighter) };
    const creature = kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(candidate => candidate.team === 'red')!;
    expect(creature.monsterData.actions.find(action => action.name === 'Javelin (Melee)')?.reach).toBe(5);
    expect(creature.monsterData.actions.find(action => action.name === 'Javelin (Thrown)')?.range).toEqual({ normal: 30, long: 120 });
  });

  it('exposes versatile two-handed damage only after a shield opt-out', () => {
    const base = { heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', weapons: ['Battleaxe'], abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const oneHanded = { characters: Array.from({ length: 4 }, () => base) };
    const twoHanded = { characters: Array.from({ length: 4 }, () => ({ ...base, shield: false })) };
    const actions = (party: typeof oneHanded) => kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.actions;
    expect(actions(oneHanded).some(action => action.name === 'Battleaxe (Two-Handed)')).toBe(false);
    expect(actions(twoHanded).find(action => action.name === 'Battleaxe (Two-Handed)')?.damage).toBe('1d10+3');
  });

  it('constructs every catalog weapon for a trained level-5 fighter', () => {
    const base = { heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    for (const weapon of Object.keys(ARENA_WEAPONS)) {
      const party = { characters: Array.from({ length: 4 }, () => ({ ...base, weapons: [weapon] })) };
      expect(() => kaggleStep({ ...init(), redParty: party, blueParty: party })).not.toThrow();
    }
  });

  it('applies catalog weapon mastery only for classes with Weapon Mastery', () => {
    const fighter = { heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', weapons: ['Greatsword'], abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const party = { characters: Array.from({ length: 4 }, () => fighter) };
    const fighterAction = kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.actions.find(action => action.name === 'Greatsword')!;
    expect(fighterAction.weaponMastery).toBe('graze');
  });

  it('applies catalog armor and rejects unavailable heavy armor', () => {
    const fighter = { heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', armor: 'Plate', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const party = { characters: Array.from({ length: 4 }, () => fighter) };
    expect(kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.ac).toBeGreaterThanOrEqual(18);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...fighter, heroClass: 'Wizard' })) }, blueParty: party })).toThrow(/not proficient/);
  });

  it('uses the engine Cleric Protector chassis for martial weapon and heavy armor validation', () => {
    const spellCount = buildHero('Cleric', 5).actions.filter(action => (action.spellLevel ?? 0) > 0).length;
    const cleric = { heroClass: 'Cleric', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', armor: 'Plate', weapons: ['Glaive'], abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 }, spells: getAvailableSpells('Cleric', 5).filter(spell => spell.spellLevel > 0).slice(0, spellCount).map(spell => spell.name) };
    const clericParty = { characters: Array.from({ length: 4 }, () => cleric) };
    expect(() => kaggleStep({ ...init(), redParty: clericParty, blueParty: clericParty })).not.toThrow();
  });

  it('supports the full catalog armor progression and applies heavy-armor speed penalties', () => {
    const dexRogue = { heroClass: 'Rogue', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', armor: 'Studded Leather', abilities: { str: 8, dex: 15, con: 15, int: 13, wis: 12, cha: 8 }, abilityIncreases: { dex: 2, con: 1 } };
    const rogueParty = { characters: Array.from({ length: 4 }, () => dexRogue) };
    expect(kaggleStep({ ...init(), redParty: rogueParty, blueParty: rogueParty }).state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.ac).toBe(15);
    const slowFighter = { ...dexRogue, heroClass: 'Fighter', armor: 'Plate' };
    const slowParty = { characters: Array.from({ length: 4 }, () => slowFighter) };
    expect(kaggleStep({ ...init(), redParty: slowParty, blueParty: slowParty }).state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.speed.walk).toBe(20);
  });

  it('applies a selected shield and permits an explicit shield opt-out', () => {
    const base = { heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', armor: 'Plate', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const withShield = { characters: Array.from({ length: 4 }, () => ({ ...base, shield: true })) };
    const withoutShield = { characters: Array.from({ length: 4 }, () => ({ ...base, shield: false })) };
    const ac = (party: typeof withShield) => kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.ac;
    expect(ac(withShield)).toBe(ac(withoutShield) + 2);
  });

  it('preserves two validated SRD language choices', () => {
    const hero = { heroClass: 'Fighter', species: 'Dwarf', background: 'Soldier', languages: ['Dwarvish', 'Giant'], abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const party = { characters: Array.from({ length: 4 }, () => hero) };
    const creature = kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(candidate => candidate.team === 'red')!;
    expect(creature.monsterData.languages).toBe('Common, Dwarvish, Giant');
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...hero, languages: ['Dwarvish', 'Dwarvish'] })) }, blueParty: party })).toThrow(/languages/);
  });

  it('preserves a validated SRD alignment', () => {
    const hero = { heroClass: 'Fighter', species: 'Dwarf', background: 'Soldier', alignment: 'Lawful Good', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const party = { characters: Array.from({ length: 4 }, () => hero) };
    expect(kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(candidate => candidate.team === 'red')!.monsterData.alignment).toBe('Lawful Good');
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...hero, alignment: 'Good' })) }, blueParty: party })).toThrow(/alignment/);
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
    expect(red.monsterData.senses).toContain('Darkvision 120 ft.');
    expect(red.monsterData.hp).toBeGreaterThan(0);
    expect(result.observations.red.publicCombatState.creatures.filter(creature => creature.team === 'red').every(creature => 'build' in creature && creature.build.species === 'Dwarf')).toBe(true);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...dwarfSoldier, abilityIncreases: { int: 2, con: 1 } })) }, blueParty: originParty })).toThrow(/listed abilities/);
  });

  it('treats species speed as the base before applying class movement features', () => {
    const base = { heroClass: 'Monk', background: 'Soldier', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const human = { ...base, species: 'Human', humanOriginFeat: 'Alert', humanSkill: 'Perception' };
    const woodElf = { ...base, species: 'Elf', elfLineage: 'Wood Elf', speciesCastingAbility: 'wis', elfKeenSense: 'Perception' };
    const speed = (character: typeof human | typeof woodElf) => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => character) }, blueParty: party }).state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.speed.walk;
    expect(speed(human)).toBe(40);
    expect(speed(woodElf)).toBe(45);
  });

  it('accepts the SRD Small-or-Medium choice only for Human and Tiefling', () => {
    const human = {
      heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Alert', humanSkill: 'Perception', size: 'Small',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => human) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.size).toBe('Small');
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...human, species: 'Dwarf', humanSkill: undefined })) }, blueParty: party })).toThrow(/size is selectable/);
  });

  it('rejects Origin Feats outside SRD 5.2', () => {
    const human = {
      heroClass: 'Fighter', species: 'Human', background: 'Criminal', humanSkill: 'Perception',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { dex: 2, con: 1 },
    };
    for (const humanOriginFeat of ['Crafter', 'Healer', 'Lucky', 'Musician', 'Tavern Brawler', 'Tough']) {
      expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...human, humanOriginFeat })) }, blueParty: party })).toThrow(/SRD Origin Feat/);
    }
  });

  it('requires a Tiefling legacy and applies its automatic resistance', () => {
    const tiefling = {
      heroClass: 'Fighter', species: 'Tiefling', tieflingLegacy: 'Infernal', speciesCastingAbility: 'cha', background: 'Soldier', size: 'Small',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => tiefling) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.resistances).toContain('fire');
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.actions.some(action => action.name === 'Fire Bolt')).toBe(true);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...tiefling, tieflingLegacy: undefined })) }, blueParty: party })).toThrow(/tieflingLegacy/);
  });

  it('adds Abyssal Hold Person as an authoritative lineage free cast', () => {
    const abyssal = {
      heroClass: 'Fighter', species: 'Tiefling', tieflingLegacy: 'Abyssal', speciesCastingAbility: 'cha', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => abyssal) };
    const creature = kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(candidate => candidate.team === 'red')!;
    expect(creature.monsterData.actions.some(action => action.name === 'Hold Person' && action.resourceCost?.key === 'abyssal-hold-person')).toBe(true);
    expect(creature.resources['abyssal-hold-person']).toBe(1);
  });

  it('adds Abyssal Ray of Sickness as an authoritative lineage free cast', () => {
    const abyssal = {
      heroClass: 'Fighter', species: 'Tiefling', tieflingLegacy: 'Abyssal', speciesCastingAbility: 'cha', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => abyssal) };
    const creature = kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(candidate => candidate.team === 'red')!;
    const rays = creature.monsterData.actions.filter(action => action.name === 'Ray of Sickness');
    const ray = rays.find(action => action.resourceCost?.key === 'abyssal-ray-of-sickness')!;
    expect(ray).toMatchObject({ spellLevel: 1, damage: '2d8', damageType: 'poison', conditionOnHit: { condition: 'poisoned', duration: 'end_of_next_turn' } });
    expect(rays.some(action => action.resourceCost === undefined)).toBe(true);
    expect(creature.resources['abyssal-ray-of-sickness']).toBe(1);

    const encounter = new Encounter({ seed: 1 });
    const [hero] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Tiefling', speciesChoice: 'Abyssal', speciesCastingAbility: 'cha', additionalResources: { 'abyssal-ray-of-sickness': 1 }, additionalActions: [ray] }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start(); encounter.state!.initiativeOrder = [hero.id]; startArena(encounter);
    const active = getActiveCreature(encounter)!;
    applyLegalAction(encounter, getLegalActions(encounter, active.id).find(action => action.type === 'spell' && action.actionName === 'Ray of Sickness')!);
    expect(active.resources['abyssal-ray-of-sickness']).toBe(0);
  });

  it('adds Chthonic False Life as a self-targeted lineage free cast', () => {
    const chthonic = {
      heroClass: 'Fighter', species: 'Tiefling', tieflingLegacy: 'Chthonic', speciesCastingAbility: 'cha', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => chthonic) };
    const creature = kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(candidate => candidate.team === 'red')!;
    expect(creature.monsterData.actions.some(action => action.name === 'False Life' && action.resourceCost?.key === 'chthonic-false-life')).toBe(true);
    expect(creature.resources['chthonic-false-life']).toBe(1);

    const encounter = new Encounter({ seed: 1 });
    const [hero] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Tiefling', speciesChoice: 'Chthonic', additionalResources: { 'chthonic-false-life': 1 }, additionalActions: [{ name: 'False Life', type: 'special', description: 'test', spellLevel: 1, temporaryHp: { dice: '2d4', addCastingMod: true }, resourceCost: { key: 'chthonic-false-life', amount: 1 }, targetScope: 'self' }] }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start(); encounter.state!.initiativeOrder = [hero.id]; startArena(encounter);
    const active = getActiveCreature(encounter)!;
    applyLegalAction(encounter, getLegalActions(encounter, active.id).find(action => action.type === 'spell' && action.actionName === 'False Life')!);
    expect(active.temporaryHp).toBeGreaterThan(0);
    expect(active.resources['chthonic-false-life']).toBe(0);
  });

  it('constructs Ray of Enfeeblement and resolves its save-ended combat debuff', () => {
    const chthonic = {
      heroClass: 'Fighter', species: 'Tiefling', tieflingLegacy: 'Chthonic', speciesCastingAbility: 'cha', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const result = kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => chthonic) }, blueParty: party });
    const caster = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
    expect(caster.monsterData.actions.some(action => action.name === 'Ray of Enfeeblement')).toBe(true);
    expect(caster.resources['chthonic-ray-of-enfeeblement']).toBe(1);

    const encounter = new Encounter({ seed: 1 });
    const [debuffed] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, team: 'red' });
    encounter.addCreature({ monster: 'Ogre', team: 'blue' });
    encounter.start();
    const target = encounter.state!.creatures.find(creature => creature.id === debuffed.id)!;
    target.activeBuffs.push({ name: 'Ray of Enfeeblement', key: 'test-ray', casterId: 'caster', appliedRound: 1, endRound: 11, strengthTestDisadvantage: true, damageRollPenalty: '1d8', saveEnds: { ability: 'con', dc: 100, at: 'targetTurnEnd' } });
    expect(hasDisadvantage(target, encounter.state!.creatures.find(creature => creature.team === 'blue')!, { name: 'Strength Attack', type: 'melee', description: '', attackBonus: 1, attackAbility: 'str' })).toBe(true);
    expect(encounter.runWithRng(() => applyDamageRollPenalty(target, 10))).toBeLessThan(10);
    encounter.runWithRng(() => processTargetTurnEndOngoingEffects(encounter.state!, target));
    expect(target.activeBuffs.some(buff => buff.key === 'test-ray')).toBe(true);
    target.activeBuffs.push({ name: 'Ray of Enfeeblement', key: 'test-ray-ends', casterId: 'caster', appliedRound: 1, endRound: 11, saveEnds: { ability: 'con', dc: 0, at: 'targetTurnEnd' } });
    encounter.runWithRng(() => processTargetTurnEndOngoingEffects(encounter.state!, target));
    expect(target.activeBuffs.some(buff => buff.key === 'test-ray-ends')).toBe(false);
  });

  it('automatically resolves Infernal Hellish Rebuke against a nearby damaging creature', () => {
    const encounter = new Encounter({ seed: 1 });
    const [tiefling] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Tiefling', speciesChoice: 'Infernal', speciesCastingAbility: 'cha', additionalResources: { 'infernal-hellish-rebuke': 1 } }, team: 'red', position: { x: 0, y: 0 } });
    const [attacker] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    const target = encounter.state!.creatures.find(creature => creature.id === tiefling.id)!;
    const source = encounter.state!.creatures.find(creature => creature.id === attacker.id)!;
    const hpBefore = source.currentHp;
    encounter.runWithRng(() => applyDamage(encounter.state!, target, 1, 'slashing', source, true));
    expect(source.currentHp).toBeLessThan(hpBefore);
    expect(target.resources['infernal-hellish-rebuke']).toBe(0);
    expect(target.reactionUsed).toBe(true);
  });

  it('requires an Elf lineage and applies Wood Elf speed', () => {
    const elf = {
      heroClass: 'Fighter', species: 'Elf', elfLineage: 'Wood Elf', speciesCastingAbility: 'wis', elfKeenSense: 'Perception', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => elf) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.speed.walk).toBe(35);
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.senses).toContain('Darkvision 60 ft.');
  });

  it('preserves Elf Keen Senses and Human Skillful selections', () => {
    const elf = { heroClass: 'Fighter', species: 'Elf', elfLineage: 'Wood Elf', speciesCastingAbility: 'wis', elfKeenSense: 'Survival', background: 'Soldier', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const human = { heroClass: 'Fighter', species: 'Human', humanOriginFeat: 'Alert', humanSkill: 'Perception', background: 'Soldier', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const result = kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => elf) }, blueParty: { characters: Array.from({ length: 4 }, () => human) } });
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.originSkills).toContain('Survival');
    expect(result.state.battleState!.creatures.find(creature => creature.team === 'blue')!.monsterData.originSkills).toContain('Perception');
  });

  it('resolves Wood Elf Longstrider through the shared speed buff path', () => {
    const encounter = new Encounter({ seed: 1 });
    const [elf] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Elf', speciesChoice: 'Wood Elf', speciesCastingAbility: 'wis', speedOverride: 35, additionalResources: { 'wood-elf-longstrider': 1 }, additionalActions: [{ name: 'Longstrider', type: 'special', spellLevel: 1, castingAbility: 'wis', resourceCost: { key: 'wood-elf-longstrider', amount: 1 }, targetScope: 'self', durationRounds: 600, buff: { name: 'Longstrider', key: 'wood-elf-longstrider', speedBonus: 10 } }] }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start(); encounter.state!.initiativeOrder = [elf.id]; startArena(encounter);
    const active = getActiveCreature(encounter)!;
    applyLegalAction(encounter, getLegalActions(encounter, active.id).find(action => action.type === 'spell' && action.actionName === 'Longstrider')!);
    expect(active.resources['wood-elf-longstrider']).toBe(0);
    expect(active.activeBuffs.some(buff => buff.key === 'wood-elf-longstrider' && buff.speedBonus === 10)).toBe(true);
    expect(active.movementRemaining).toBe(45);
  });

  it('resolves High Elf Misty Step through the validated teleport action', () => {
    const encounter = new Encounter({ seed: 1 });
    const [elf] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Elf', speciesChoice: 'High Elf', additionalResources: { 'high-elf-misty-step': 1 } }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start(); encounter.state!.initiativeOrder = [elf.id]; startArena(encounter);
    const active = getActiveCreature(encounter)!;
    const action = getLegalActions(encounter, active.id).find(candidate => candidate.id === 'species:high_elf_misty_step')!;
    applyLegalAction(encounter, { ...action, destination: { x: 6, y: 0 } });
    expect(active.position).toEqual({ x: 6, y: 0 });
    expect(active.resources['high-elf-misty-step']).toBe(0);
    expect(active.bonusActionUsed).toBe(true);
  });

  it('preserves every engine-supported High Elf cantrip replacement as a legal action', () => {
    const highElf = {
      heroClass: 'Fighter', species: 'Elf', elfLineage: 'High Elf', highElfCantrip: 'Fire Bolt', speciesCastingAbility: 'wis', elfKeenSense: 'Perception', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    for (const highElfCantrip of ['Chill Touch', 'Fire Bolt', 'Poison Spray', 'Ray of Frost']) {
      const result = kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...highElf, highElfCantrip })) }, blueParty: party });
      const elf = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
      expect(elf.monsterData.speciesCantrips).toEqual([highElfCantrip]);
      expect(elf.monsterData.actions.some(action => action.name === highElfCantrip)).toBe(true);
    }
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...highElf, highElfCantrip: 'Wish' })) }, blueParty: party })).toThrow(/highElfCantrip/);
  });

  it('applies High Elf Ray of Frost speed reduction through combat resolution', () => {
    const highElf = {
      heroClass: 'Fighter', species: 'Elf', elfLineage: 'High Elf', highElfCantrip: 'Ray of Frost', speciesCastingAbility: 'wis', elfKeenSense: 'Perception', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const result = kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => highElf) }, blueParty: party });
    const encounter = Encounter.fromJSON(result.state);
    const state = encounter.state!;
    const hero = state.creatures.find(creature => creature.team === 'red')!;
    const target = state.creatures.find(creature => creature.team === 'blue')!;
    const rayOfFrost = hero.monsterData.actions.find(action => action.name === 'Ray of Frost')!;
    expect(rayOfFrost.buffOnHit).toMatchObject({ speedPenalty: 10, expiresOnSourceTurnStart: true });
    rayOfFrost.attackBonus = 100;
    hero.position = { x: 1, y: 1 };
    target.position = { x: 6, y: 1 };
    const baseSpeed = getEffectiveMoveSpeed(target, state);
    encounter.runWithRng(() => resolveAttack(state, hero, target, rayOfFrost));
    expect(getEffectiveMoveSpeed(target, state)).toBe(baseSpeed - 10);
  });

  it('casts Wood Elf Pass without Trace through the shared concentration path', () => {
    const encounter = new Encounter({ seed: 1 });
    const passWithoutTrace = { name: 'Pass without Trace', type: 'special' as const, spellLevel: 2, castingAbility: 'wis' as const, resourceCost: { key: 'wood-elf-pass-without-trace', amount: 1 }, range: { normal: 30, long: 30 }, targetScope: 'all_allies_in_area' as const, durationRounds: 600, buff: { name: 'Pass without Trace', key: 'wood-elf-pass-without-trace', requiresConcentration: true, stealthBonus: 10 }, description: 'Stealth bonus.' };
    const [elf] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Elf', speciesChoice: 'Wood Elf', additionalResources: { 'wood-elf-pass-without-trace': 1 }, additionalActions: [passWithoutTrace] }, team: 'red', position: { x: 0, y: 0 } });
    const [ally] = encounter.addCreature({ heroClass: 'Rogue', heroLevel: 5, team: 'red', position: { x: 1, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start(); encounter.state!.initiativeOrder = [elf.id]; startArena(encounter);
    const active = getActiveCreature(encounter)!;
    applyLegalAction(encounter, getLegalActions(encounter, active.id).find(action => action.type === 'spell' && action.actionName === 'Pass without Trace')!);
    const state = encounter.state!;
    expect(state.creatures.find(creature => creature.id === elf.id)!.activeBuffs.some(buff => buff.stealthBonus === 10 && buff.requiresConcentration)).toBe(true);
    expect(state.creatures.find(creature => creature.id === ally.id)!.activeBuffs.some(buff => buff.stealthBonus === 10)).toBe(true);
  });

  it('requires an Elf casting ability and resolves Drow Faerie Fire through the shared spell path', () => {
    const drow = {
      heroClass: 'Fighter', species: 'Elf', elfLineage: 'Drow', speciesCastingAbility: 'cha', elfKeenSense: 'Perception', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => drow) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    const drowCreature = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
    expect(drowCreature.monsterData.heroSpeciesCastingAbility).toBe('cha');
    expect(drowCreature.monsterData.actions.some(action => action.name === 'Faerie Fire')).toBe(true);
    expect(drowCreature.monsterData.actions.some(action => action.name === 'Darkness')).toBe(true);
    expect(drowCreature.monsterData.actions.find(action => action.name === 'Darkness')!.darkness?.durationRounds).toBe(100);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...drow, speciesCastingAbility: undefined })) }, blueParty: party })).toThrow(/speciesCastingAbility/);
  });

  it('serializes magical Darkness, blocks sight, and removes it with concentration', () => {
    const encounter = new Encounter({ seed: 1, gridSize: 12 });
    const [caster] = encounter.addCreature({
      heroClass: 'Fighter', heroLevel: 5,
      heroOverrides: {
        species: 'Elf', speciesChoice: 'Drow', additionalResources: { 'drow-darkness': 1 },
        additionalActions: [{ name: 'Darkness', type: 'special', spellLevel: 2, range: { normal: 60, long: 60 }, targetScope: 'self', resourceCost: { key: 'drow-darkness', amount: 1 }, darkness: { radius: 15, durationRounds: 600, requiresConcentration: true }, description: 'Magical darkness.' }],
      },
      team: 'red', position: { x: 0, y: 0 },
    });
    const [target] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 4, y: 0 } });
    encounter.start(); encounter.state!.initiativeOrder = [caster.id]; startArena(encounter);
    const active = getActiveCreature(encounter)!;
    const action = getLegalActions(encounter, active.id).find(candidate => candidate.type === 'spell' && candidate.actionName === 'Darkness' && candidate.center?.x === 4 && candidate.center?.y === 0)!;
    applyLegalAction(encounter, action);
    const casterCreature = encounter.state!.creatures.find(creature => creature.id === caster.id)!;
    const targetCreature = encounter.state!.creatures.find(creature => creature.id === target.id)!;
    expect(encounter.state!.darknessZones).toEqual([{ sourceId: caster.id, x: 4, y: 0, radius: 15, endRound: 601, requiresConcentration: true }]);
    expect(canSee(encounter.state!, casterCreature, targetCreature)).toBe(false);
    expect(canSee(Encounter.fromJSON(encounter.toJSON()).state!, casterCreature, targetCreature)).toBe(false);
    dropConcentratedBuffsFrom(encounter.state!, caster.id);
    expect(canSee(encounter.state!, casterCreature, targetCreature)).toBe(true);
  });

  it('resolves Hide against passive Perception and clears it after voluntary movement', () => {
    const encounter = new Encounter({ seed: 1, gridSize: 12 });
    const [rogue] = encounter.addCreature({ heroClass: 'Rogue', heroLevel: 5, team: 'red', position: { x: 0, y: 0 } });
    const [target] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 4, y: 0 } });
    encounter.start();
    const state = encounter.state!;
    const rogueCreature = state.creatures.find(creature => creature.id === rogue.id)!;
    const targetCreature = state.creatures.find(creature => creature.id === target.id)!;
    rogueCreature.monsterData.skills = { ...(rogueCreature.monsterData.skills ?? {}), Stealth: 50 };
    state.darknessZones = [{ sourceId: target.id, x: 2, y: 0, radius: 5, endRound: 100, requiresConcentration: false }];
    state.initiativeOrder = [rogue.id]; startArena(encounter);
    applyLegalAction(encounter, getLegalActions(encounter, rogue.id).find(action => action.id === 'hide')!);
    state.darknessZones = [];
    expect(canSee(state, targetCreature, rogueCreature)).toBe(false);
    const move = getLegalActions(encounter, rogue.id).find(action => action.type === 'move_to')!;
    const destination = reachableMovementDestinations(rogueCreature, state)[0]!;
    applyLegalAction(encounter, { ...move, destination });
    expect(canSee(state, targetCreature, rogueCreature)).toBe(true);
  });

  it('allows a Halfling to Hide behind a larger creature', () => {
    const encounter = new Encounter({ seed: 1 });
    const [halfling] = encounter.addCreature({ heroClass: 'Rogue', heroLevel: 5, heroOverrides: { species: 'Halfling', sizeOverride: 'Small' }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'red', position: { x: 1, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 4, y: 0 } });
    encounter.start(); encounter.state!.initiativeOrder = [halfling.id]; startArena(encounter);
    expect(getLegalActions(encounter, halfling.id).some(action => action.id === 'hide')).toBe(true);
  });

  it('offers Goliath a Powerful Build grapple escape action', () => {
    const encounter = new Encounter({ seed: 1 });
    const [goliath] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Goliath' }, team: 'red', position: { x: 0, y: 0 } });
    const [source] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start(); encounter.state!.initiativeOrder = [goliath.id]; startArena(encounter);
    const active = getActiveCreature(encounter)!;
    active.conditions.push('grappled');
    active.conditionTimers.push({ condition: 'grappled', duration: 'permanent', appliedRound: 1, sourceId: source.id, saveDC: 1 });
    const escape = getLegalActions(encounter, active.id).find(action => action.type === 'escape_grapple' && action.ability === 'str')!;
    applyLegalAction(encounter, escape);
    expect(active.conditions).not.toContain('grappled');
    expect(active.hasActed).toBe(true);
  });

  it('applies Gnomish Cunning automatically to mental saves', () => {
    const encounter = new Encounter({ seed: 1 });
    const [gnome] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Gnome' }, team: 'red' });
    encounter.addCreature({ monster: 'Ogre', team: 'blue' });
    encounter.start();
    const creature = encounter.state!.creatures.find(candidate => candidate.id === gnome.id)!;
    encounter.runWithRng(() => expect(rollSaveWithBuffs(creature, 0, false, 10, 'wis').rolls).toHaveLength(2));
  });

  it('applies Dwarf, Elf, and Halfling condition-save advantages automatically', () => {
    const encounter = new Encounter({ seed: 1 });
    for (const species of ['Dwarf', 'Elf', 'Halfling']) encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species }, team: 'red' });
    encounter.addCreature({ monster: 'Ogre', team: 'blue' });
    encounter.start();
    const creatures = encounter.state!.creatures.filter(creature => creature.team === 'red');
    encounter.runWithRng(() => {
      expect(rollSaveWithBuffs(creatures[0]!, 0, false, 10, 'con', 'poisoned').rolls).toHaveLength(2);
      expect(rollSaveWithBuffs(creatures[1]!, 0, false, 10, 'wis', 'charmed').rolls).toHaveLength(2);
      expect(rollSaveWithBuffs(creatures[2]!, 0, false, 10, 'wis', 'frightened').rolls).toHaveLength(2);
    });
  });

  it('resolves Dwarf Stonecunning as timed Tremorsense against hidden grounded targets', () => {
    const encounter = new Encounter({ seed: 1 });
    const [dwarf] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Dwarf', additionalResources: { 'dwarf-stonecunning': 3 } }, team: 'red', position: { x: 0, y: 0 } });
    const [hidden] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 5, y: 0 } });
    encounter.start();
    const state = encounter.state!;
    const active = state.creatures.find(creature => creature.id === dwarf.id)!;
    const target = state.creatures.find(creature => creature.id === hidden.id)!;
    state.initiativeOrder = [active.id];
    startArena(encounter);
    target.activeBuffs.push({ name: 'Hidden', key: `hidden-from:${active.id}`, casterId: target.id, appliedRound: state.round, endRound: state.round + 100 });
    expect(getLegalActions(encounter, active.id).some(action => action.type === 'attack' && action.targetId === target.id)).toBe(false);
    applyLegalAction(encounter, getLegalActions(encounter, active.id).find(action => action.type === 'species_tremorsense')!);
    expect(active.resources['dwarf-stonecunning']).toBe(2);
    expect(active.activeBuffs.find(buff => buff.key === 'dwarf-stonecunning')).toMatchObject({ tremorsenseRange: 60, endRound: state.round + 100 });
    expect(getLegalActions(encounter, active.id).some(action => action.type === 'attack' && action.targetId === target.id)).toBe(true);
  });

  it('requires and preserves Gnome and Goliath SRD ancestry choices', () => {
    const build = (species: 'Gnome' | 'Goliath', choice: string) => ({ heroClass: 'Fighter', species, background: 'Soldier', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 }, ...(species === 'Gnome' ? { gnomeLineage: choice, speciesCastingAbility: 'int' } : { goliathAncestry: choice }) });
    for (const [species, choice] of [['Gnome', 'Forest Gnome'], ['Goliath', 'Cloud']] as const) {
      const party = { characters: Array.from({ length: 4 }, () => build(species, choice)) };
      const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
      expect(result.observations.red.publicCombatState.creatures.find(creature => creature.team === 'red')!.build.speciesChoice).toBe(choice);
    }
  });

  it('constructs every supported SRD species variant', () => {
    const base = { heroClass: 'Fighter', background: 'Soldier', abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    const variants = [
      { species: 'Dragonborn', dragonAncestry: 'acid' }, { species: 'Dragonborn', dragonAncestry: 'cold' }, { species: 'Dragonborn', dragonAncestry: 'fire' }, { species: 'Dragonborn', dragonAncestry: 'lightning' }, { species: 'Dragonborn', dragonAncestry: 'poison' },
      { species: 'Dwarf' }, { species: 'Halfling' }, { species: 'Human', humanSkill: 'Stealth', humanOriginFeat: 'Skilled', humanOriginSkills: ['Acrobatics', 'Arcana', 'Survival'] }, { species: 'Orc' },
      { species: 'Elf', elfLineage: 'Drow', speciesCastingAbility: 'wis', elfKeenSense: 'Perception' }, { species: 'Elf', elfLineage: 'High Elf', speciesCastingAbility: 'wis', elfKeenSense: 'Perception' }, { species: 'Elf', elfLineage: 'Wood Elf', speciesCastingAbility: 'wis', elfKeenSense: 'Perception' },
      { species: 'Gnome', gnomeLineage: 'Forest Gnome', speciesCastingAbility: 'wis' }, { species: 'Gnome', gnomeLineage: 'Rock Gnome', speciesCastingAbility: 'wis' },
      ...(['Cloud', 'Fire', 'Frost', 'Hill', 'Stone', 'Storm'] as const).map(goliathAncestry => ({ species: 'Goliath', goliathAncestry })),
      ...(['Abyssal', 'Chthonic', 'Infernal'] as const).map(tieflingLegacy => ({ species: 'Tiefling', tieflingLegacy, speciesCastingAbility: 'wis' })),
    ];
    for (const variant of variants) {
      const character = { ...base, ...variant };
      const result = kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => character) }, blueParty: party });
      const heroes = result.state.battleState!.creatures.filter(creature => creature.team === 'red');
      expect(heroes).toHaveLength(4);
      expect(heroes.every(hero => hero.resources['hit-die'] === 5)).toBe(true);
    }
  });

  it('accepts and preserves every SRD Human Origin Feat', () => {
    for (const feat of ['Alert', 'Magic Initiate (Cleric)', 'Magic Initiate (Druid)', 'Magic Initiate (Wizard)', 'Savage Attacker', 'Skilled']) {
      const background = feat === 'Alert' ? 'Soldier' : 'Criminal';
      const character = {
        heroClass: 'Fighter', species: 'Human', background, humanSkill: 'Stealth', humanOriginFeat: feat,
        abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: background === 'Soldier' ? { str: 2, con: 1 } : { dex: 2, con: 1 },
        ...(feat === 'Skilled' ? { humanOriginSkills: ['Acrobatics', 'Arcana', 'Survival'] } : {}),
        ...(feat === 'Magic Initiate (Cleric)' ? { humanOriginCantrips: ['Sacred Flame', 'Toll the Dead'], humanOriginSpell: 'Guiding Bolt', humanOriginCastingAbility: 'wis' } : {}),
        ...(feat === 'Magic Initiate (Druid)' ? { humanOriginCantrips: ['Poison Spray', 'Produce Flame'], humanOriginSpell: 'Entangle', humanOriginCastingAbility: 'wis' } : {}),
        ...(feat === 'Magic Initiate (Wizard)' ? { humanOriginCantrips: ['Fire Bolt', 'Ray of Frost'], humanOriginSpell: 'Magic Missile', humanOriginCastingAbility: 'int' } : {}),
      };
      const result = kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => character) }, blueParty: party });
      const hero = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
      expect(hero.monsterData.originFeats).toContain(feat);
      expect(hero.monsterData.skills?.Stealth).toBe(hero.monsterData.proficiencyBonus + Math.floor((hero.monsterData.abilities.dex - 10) / 2));
    }
  });

  it('allows Skilled to select any mix of three SRD skills and tools', () => {
    const character = {
      heroClass: 'Fighter', species: 'Human', background: 'Criminal', humanSkill: 'Stealth', humanOriginFeat: 'Skilled',
      humanOriginSkills: ['Arcana'], humanOriginTools: ['Alchemist’s Supplies', 'Musical Instrument'],
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { dex: 2, con: 1 },
    };
    const result = kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => character) }, blueParty: party });
    const hero = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
    expect(hero.monsterData.originSkills).toContain('Arcana');
    expect(hero.monsterData.originTools).toEqual(expect.arrayContaining(['Thieves’ Tools', 'Alchemist’s Supplies', 'Musical Instrument']));
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...character, humanOriginTools: ['Alchemist’s Supplies'] })) }, blueParty: party })).toThrow(/three distinct SRD skills or tools/);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...character, humanOriginSkills: { length: 1 } })) }, blueParty: party })).toThrow(/humanOriginSkills must be an array/);
  });

  it('accepts the SRD subclass for every arena class and rejects cross-class choices', () => {
    const subclasses = {
      Barbarian: 'Path of the Berserker', Bard: 'College of Lore', Cleric: 'Life Domain', Druid: 'Circle of the Moon', Fighter: 'Champion', Monk: 'Warrior of the Open Hand', Paladin: 'Oath of Devotion', Ranger: 'Hunter', Rogue: 'Thief', Sorcerer: 'Draconic Sorcery', Warlock: 'Fiend Patron', Wizard: 'Evoker',
    } as const;
    for (const [heroClass, subclass] of Object.entries(subclasses)) {
      const spellCount = buildHero(heroClass as typeof HERO_CLASS_NAMES[number], 5).actions.filter(action => (action.spellLevel ?? 0) > 0).length;
      const character = {
        heroClass, subclass, species: 'Human', background: 'Soldier', humanSkill: 'Stealth', humanOriginFeat: 'Skilled', humanOriginSkills: ['Acrobatics', 'Arcana', 'Survival'],
        abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
        ...(spellCount ? { spells: getAvailableSpells(heroClass as typeof HERO_CLASS_NAMES[number], 5).filter(spell => (spell.spellLevel ?? 0) > 0).slice(0, spellCount).map(spell => spell.name) } : {}),
      };
      const result = kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => character) }, blueParty: party });
      expect(result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData.heroSubclass).toBe(subclass);
    }
    const invalid = { heroClass: 'Fighter', subclass: 'Circle of the Moon', species: 'Human', background: 'Soldier', humanSkill: 'Stealth', humanOriginFeat: 'Skilled', humanOriginSkills: ['Acrobatics', 'Arcana', 'Survival'], abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 } };
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => invalid) }, blueParty: party })).toThrow(/not an SRD subclass/);
  });

  it('offers every default level-five spell in its class selection catalogue', () => {
    for (const heroClass of HERO_CLASS_NAMES) {
      const defaultSpells = buildHero(heroClass, 5).actions.filter(action => (action.spellLevel ?? 0) > 0).map(action => action.name);
      const available = new Set(getAvailableSpells(heroClass, 5).filter(action => action.spellLevel > 0).map(action => action.name));
      expect(defaultSpells.every(spell => available.has(spell))).toBe(true);
    }
  });

  it('requires and preserves the Gnome lineage spellcasting ability', () => {
    const gnome = {
      heroClass: 'Fighter', species: 'Gnome', gnomeLineage: 'Forest Gnome', speciesCastingAbility: 'wis', background: 'Soldier',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
    };
    const party = { characters: Array.from({ length: 4 }, () => gnome) };
    const creature = kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(candidate => candidate.team === 'red')!;
    expect(creature.monsterData.heroSpeciesCastingAbility).toBe('wis');
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...gnome, speciesCastingAbility: undefined })) }, blueParty: party })).toThrow(/speciesCastingAbility/);
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

  it("applies Stone's Endurance automatically before Goliath HP is reduced", () => {
    const encounter = new Encounter({ seed: 1 });
    const [goliath] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Goliath', speciesChoice: 'Stone', additionalResources: { 'goliath-giant-ancestry': 3 } }, team: 'red' });
    const [attacker] = encounter.addCreature({ monster: 'Ogre', team: 'blue' });
    encounter.start();
    const target = encounter.state!.creatures.find(creature => creature.id === goliath.id)!;
    const before = target.currentHp;
    encounter.runWithRng(() => applyDamage(encounter.state!, target, 20, 'slashing', encounter.state!.creatures.find(creature => creature.id === attacker.id)!, true));
    expect(target.currentHp).toBeGreaterThan(before - 20);
    expect(target.resources['goliath-giant-ancestry']).toBe(2);
    expect(target.reactionUsed).toBe(true);
  });

  it("applies Storm's Thunder automatically against the damaging creature", () => {
    const encounter = new Encounter({ seed: 1 });
    const [goliath] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Goliath', speciesChoice: 'Storm', additionalResources: { 'goliath-giant-ancestry': 3 } }, team: 'red', position: { x: 0, y: 0 } });
    const [attacker] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    const source = encounter.state!.creatures.find(creature => creature.id === attacker.id)!;
    const before = source.currentHp;
    encounter.runWithRng(() => applyDamage(encounter.state!, encounter.state!.creatures.find(creature => creature.id === goliath.id)!, 1, 'slashing', source, true));
    expect(source.currentHp).toBeLessThan(before);
    expect(encounter.state!.creatures.find(creature => creature.id === goliath.id)!.resources['goliath-giant-ancestry']).toBe(2);
  });

  it('offers and applies Goliath Giant Ancestry hit riders only after a damaging hit', () => {
    const encounter = new Encounter({ seed: 1 });
    const [goliath] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Goliath', speciesChoice: 'Hill', additionalResources: { 'goliath-giant-ancestry': 3 } }, team: 'red', position: { x: 0, y: 0 } });
    const [target] = encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [goliath.id];
    startArena(encounter);
    const active = getActiveCreature(encounter)!;
    const targetCreature = encounter.state!.creatures.find(creature => creature.id === target.id)!;
    const rider = getLegalActions(encounter, active.id).find(action => action.type === 'attack' && action.goliathFeature === 'hill')!;
    applyLegalAction(encounter, rider);
    expect(active.resources['goliath-giant-ancestry']).toBeLessThanOrEqual(3);
    if (active.resources['goliath-giant-ancestry'] === 2) expect(targetCreature.conditions).toContain('prone');
    else expect(targetCreature.conditions).not.toContain('prone');
  });

  it("records Fire's Burn as its own replay hit", () => {
    const encounter = new Encounter({ seed: 1 });
    const [goliath] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Goliath', speciesChoice: 'Fire', additionalResources: { 'goliath-giant-ancestry': 3 } }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 1, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [goliath.id];
    startArena(encounter);
    const active = getActiveCreature(encounter)!;
    const rider = getLegalActions(encounter, active.id).find(action => action.type === 'attack' && action.goliathFeature === 'fire')!;
    applyLegalAction(encounter, rider);
    if (active.resources['goliath-giant-ancestry'] === 2) expect(encounter.state!.events.some(event => event.kind === 'hit' && event.damageType === 'fire')).toBe(true);
  });

  it("resolves Cloud's Jaunt with only a legal server-validated destination", () => {
    const encounter = new Encounter({ seed: 1 });
    const [goliath] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Goliath', speciesChoice: 'Cloud', additionalResources: { 'goliath-giant-ancestry': 3 } }, team: 'red', position: { x: 0, y: 0 } });
    encounter.addCreature({ monster: 'Ogre', team: 'blue', position: { x: 10, y: 0 } });
    encounter.start();
    encounter.state!.initiativeOrder = [goliath.id];
    startArena(encounter);
    const active = getActiveCreature(encounter)!;
    const jaunt = getLegalActions(encounter, active.id).find(action => action.type === 'species_teleport')!;
    applyLegalAction(encounter, { ...jaunt, destination: { x: 5, y: 0 } });
    expect(active.position).toEqual({ x: 5, y: 0 });
    expect(active.resources['goliath-giant-ancestry']).toBe(2);
    expect(() => applyLegalAction(encounter, { ...jaunt, destination: { x: 19, y: 19 } })).toThrow(/stale|Cloud/);
  });

  it('rerolls Halfling natural ones in the shared d20 primitive', () => {
    const values = [0, 0.5, 0.9];
    const rng = { next: () => values.shift()! };
    expect(withRng(rng, () => rollAttack(0, false, false, true).naturalRoll)).toBe(19);
  });

  it('applies Halfling Luck to initiative rolls', () => {
    const encounter = new Encounter({ seed: 1 });
    const [added] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Halfling' }, team: 'red' });
    const halfling = encounter.creatures.find(creature => creature.id === added.id)!;
    const values = [0, 0.5];
    withRng({ next: () => values.shift()! }, () => rollAllInitiatives([halfling]));
    expect(halfling.initiative).toBe(13);
  });

  it('applies Halfling Luck to death saves', () => {
    const encounter = new Encounter({ seed: 1 });
    const [added] = encounter.addCreature({ heroClass: 'Fighter', heroLevel: 5, heroOverrides: { species: 'Halfling' }, team: 'red' });
    encounter.addCreature({ monster: 'Ogre', team: 'blue' });
    encounter.start();
    const halfling = encounter.state!.creatures.find(creature => creature.id === added.id)!;
    halfling.currentHp = 0;
    halfling.dying = true;
    halfling.deathSaves = { successes: 0, failures: 0 };
    const values = [0, 0.5];
    withRng({ next: () => values.shift()! }, () => runDeathSave(encounter.state!, halfling));
    expect(halfling.deathSaves).toMatchObject({ successes: 1, failures: 0 });
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
    expect(dragon.resources['hit-die']).toBe(5);
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
    encounter.state!.round += 100;
    encounter.runWithRng(() => processTurnStart(encounter.state!, active));
    expect(active.temporaryFlightSpeed).toBeUndefined();
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

  it('constructs every engine-supported level-5 spell selection', () => {
    for (const heroClass of HERO_CLASS_NAMES) {
      const expected = buildHero(heroClass, 5).actions.filter(action => (action.spellLevel ?? 0) > 0).length;
      if (!expected) continue;
      const available = getAvailableSpells(heroClass, 5).filter(spell => spell.spellLevel > 0).map(spell => spell.name);
      for (const selected of available) {
        const spells = [selected, ...available.filter(spell => spell !== selected)].slice(0, expected);
        const character = { heroClass, abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, spells };
        const party = { characters: Array.from({ length: 4 }, () => character) };
        expect(() => kaggleStep({ ...init(), redParty: party, blueParty: party })).not.toThrow();
      }
    }
  });

  it('builds Magic Initiate background spells with an authoritative free cast', () => {
    const acolyte = {
      heroClass: 'Fighter', species: 'Human', background: 'Acolyte', humanOriginFeat: 'Alert', humanSkill: 'Perception', size: 'Medium',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { wis: 2, cha: 1 },
      originCantrips: ['Sacred Flame', 'Toll the Dead'], originSpell: 'Guiding Bolt', originCastingAbility: 'wis',
    };
    const party = { characters: Array.from({ length: 4 }, () => acolyte) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    const hero = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
    expect(hero.monsterData.actions.map(action => action.name)).toEqual(expect.arrayContaining(['Sacred Flame', 'Toll the Dead', 'Guiding Bolt']));
    expect(hero.resources['magic-initiate:background']).toBe(1);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...acolyte, originCantrips: ['Sacred Flame'] })) }, blueParty: party })).toThrow(/originCantrips/);
    expect(() => kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => ({ ...acolyte, background: 'Soldier', abilityIncreases: { str: 2, con: 1 } })) }, blueParty: party })).toThrow(/Magic Initiate/);
  });

  it('builds Human Magic Initiate (Druid) with engine-resolved cantrips and a free spell', () => {
    const human = {
      heroClass: 'Fighter', species: 'Human', background: 'Soldier', humanOriginFeat: 'Magic Initiate (Druid)', humanSkill: 'Perception',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { str: 2, con: 1 },
      humanOriginCantrips: ['Poison Spray', 'Produce Flame'], humanOriginSpell: 'Entangle', humanOriginCastingAbility: 'wis',
    };
    const result = kaggleStep({ ...init(), redParty: { characters: Array.from({ length: 4 }, () => human) }, blueParty: party });
    const hero = result.state.battleState!.creatures.find(creature => creature.team === 'red')!;
    expect(hero.monsterData.actions.map(action => action.name)).toEqual(expect.arrayContaining(['Poison Spray', 'Produce Flame', 'Entangle']));
    expect(hero.resources['magic-initiate:human']).toBe(1);
  });

  it('also exposes Magic Initiate spells through the caster’s spell slots', () => {
    const wizard = {
      heroClass: 'Wizard', species: 'Human', background: 'Soldier', humanOriginFeat: 'Magic Initiate (Cleric)', humanSkill: 'Perception',
      abilities: { str: 8, dex: 14, con: 14, int: 15, wis: 12, cha: 8 }, abilityIncreases: { dex: 2, con: 1 },
      spells: getAvailableSpells('Wizard', 5).filter(spell => spell.spellLevel > 0).slice(0, 8).map(spell => spell.name),
      humanOriginCantrips: ['Sacred Flame', 'Toll the Dead'], humanOriginSpell: 'Guiding Bolt', humanOriginCastingAbility: 'wis',
    };
    const party = { characters: Array.from({ length: 4 }, () => wizard) };
    const hero = kaggleStep({ ...init(), redParty: party, blueParty: party }).state.battleState!.creatures.find(creature => creature.team === 'red')!;
    expect(hero.monsterData.actions.filter(action => action.name === 'Guiding Bolt')).toHaveLength(2);
    expect(hero.monsterData.actions.some(action => action.name === 'Guiding Bolt' && action.resourceCost === undefined)).toBe(true);
  });

  it('gives Humans a second implemented Origin Feat with independent Magic Initiate use', () => {
    const human = {
      heroClass: 'Fighter', species: 'Human', background: 'Acolyte', humanOriginFeat: 'Magic Initiate (Wizard)', humanSkill: 'Perception',
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, abilityIncreases: { wis: 2, cha: 1 },
      originCantrips: ['Sacred Flame', 'Toll the Dead'], originSpell: 'Guiding Bolt', originCastingAbility: 'wis',
      humanOriginCantrips: ['Fire Bolt', 'Ray of Frost'], humanOriginSpell: 'Magic Missile', humanOriginCastingAbility: 'int',
    };
    const party = { characters: Array.from({ length: 4 }, () => human) };
    const result = kaggleStep({ ...init(), redParty: party, blueParty: party });
    const build = result.state.battleState!.creatures.find(creature => creature.team === 'red')!.monsterData;
    expect(build.originFeats).toEqual(['Magic Initiate (Cleric)', 'Magic Initiate (Wizard)']);
    expect(build.initialResources).toMatchObject({ 'magic-initiate:background': 1, 'magic-initiate:human': 1 });
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
  }, 15_000);
});
