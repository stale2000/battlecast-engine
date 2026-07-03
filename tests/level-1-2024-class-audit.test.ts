import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHero } from '../src/data/heroes';
import { monsters } from '../src/data/monsters';
import { addBuff, createCreatureWithFixedHp, executeSpell, initBattle, resolveAttack } from '../src/engine/combat';

function monster(name: string) {
  const found = monsters.find(m => m.name === name);
  if (!found) throw new Error(`Missing monster fixture: ${name}`);
  return found;
}

function fixedHitRolls() {
  vi.spyOn(Math, 'random').mockReturnValue(0.95);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('2024 level-1 hero chassis', () => {
  it('Paladin has level-1 spellcasting, Lay on Hands, Weapon Mastery, and no Defense style AC yet', () => {
    const paladin = buildHero('Paladin', 1);

    expect(paladin.ac).toBe(18);
    expect(paladin.initialResources?.['slot-1']).toBe(2);
    expect(paladin.initialResources?.['lay-on-hands']).toBe(5);
    expect(paladin.actions.some(a => a.name === 'Bless')).toBe(true);
    expect(paladin.actions.some(a => a.name === 'Cure Wounds')).toBe(true);
    expect(paladin.actions.some(a => a.name === 'Shield of Faith')).toBe(false);
    expect(paladin.actions.some(a => a.name === 'Lay on Hands')).toBe(true);
    expect(paladin.actions.find(a => a.name === 'Lay on Hands')?.isBonusAction).toBe(true);
    expect(paladin.actions.find(a => a.name === 'Longsword')?.weaponMastery).toBe('sap');
  });

  it('Ranger has level-1 spellcasting, free Favored Enemy marks, and Weapon Mastery', () => {
    const ranger = buildHero('Ranger', 1);

    expect(ranger.initialResources?.['slot-1']).toBe(2);
    expect(ranger.initialResources?.['favored-enemy']).toBe(2);
    expect(ranger.actions.some(a => a.name === "Hunter's Mark")).toBe(true);
    expect(ranger.actions.some(a => a.name === 'Cure Wounds')).toBe(true);
    expect(ranger.actions.some(a => a.name === 'Entangle')).toBe(true);
    expect(ranger.actions.find(a => a.name === "Hunter's Mark")?.buff?.damageRider).toBe('1d6 force');
    expect(ranger.actions.find(a => a.name === 'Longbow')?.weaponMastery).toBe('slow');
    expect(ranger.actions.find(a => a.name === 'Shortsword')?.weaponMastery).toBe('vex');
  });

  it('uses legal 2024 level-1 default spell counts and doubled healing dice', () => {
    expect(buildHero('Bard', 1).actions.filter(a => ['Dissonant Whispers', 'Healing Word', 'Cure Wounds', 'Bane'].includes(a.name))).toHaveLength(4);
    expect(buildHero('Cleric', 1).actions.filter(a => ['Bless', 'Cure Wounds', 'Healing Word', 'Guiding Bolt'].includes(a.name))).toHaveLength(4);
    expect(buildHero('Sorcerer', 1).actions.filter(a => ['Magic Missile', 'Burning Hands'].includes(a.name))).toHaveLength(2);
    expect(buildHero('Warlock', 1).actions.filter(a => ['Hex', 'Witch Bolt'].includes(a.name))).toHaveLength(2);
    expect(buildHero('Paladin', 1).actions.filter(a => ['Bless', 'Cure Wounds'].includes(a.name))).toHaveLength(2);
    expect(buildHero('Ranger', 1).actions.filter(a => ['Cure Wounds', 'Entangle'].includes(a.name))).toHaveLength(2);

    expect(buildHero('Cleric', 1).actions.find(a => a.name === 'Cure Wounds')?.heal?.dice).toBe('2d8');
    expect(buildHero('Cleric', 1).actions.find(a => a.name === 'Healing Word')?.heal?.dice).toBe('2d4');
  });

  it('models 2024 level-1 Sorcerer Innate Sorcery and Fighter Second Wind uses', () => {
    const sorcerer = buildHero('Sorcerer', 1);
    const innate = sorcerer.actions.find(a => a.name === 'Innate Sorcery');
    expect(sorcerer.initialResources?.['innate-sorcery']).toBe(2);
    expect(innate?.isBonusAction).toBe(true);
    expect(innate?.buff?.spellSaveDcBonus).toBe(1);
    expect(innate?.buff?.spellAttackAdvantage).toBe(true);

    expect(buildHero('Fighter', 1).initialResources?.['second-wind']).toBe(2);
  });

  it('does not give Warlock level-1 Eldritch Blast Agonizing Blast damage', () => {
    expect(buildHero('Warlock', 1).actions.find(a => a.name === 'Eldritch Blast')?.damage).toBe('1d10');
    expect(buildHero('Warlock', 2).actions.find(a => a.name === 'Eldritch Blast')?.damage).toBe('1d10+3');
  });

  it('models 2024 Witch Bolt as 2d12 plus a maintained bonus-action link', () => {
    const witchBolt = buildHero('Warlock', 1).actions.find(a => a.name === 'Witch Bolt');

    expect(witchBolt?.damage).toBe('2d12');
    expect(witchBolt?.buff?.bonusActionDamage).toBe('1d12');
    expect(witchBolt?.buff?.bonusActionDamageType).toBe('lightning');
  });

  it('keeps Sorcerer and Wizard at species-neutral unarmored AC without pre-cast Mage Armor', () => {
    expect(buildHero('Sorcerer', 1).ac).toBe(12);
    expect(buildHero('Wizard', 1).ac).toBe(12);
  });

  it('assigns legal standard-array-shaped starting abilities', () => {
    const fighter = buildHero('Fighter', 1);
    const values = Object.values(fighter.abilities).sort((a, b) => b - a);
    expect(values).toEqual([17, 14, 14, 12, 10, 8]);
  });
});

describe('2024 level-1 combat mechanics', () => {
  it('applies Sap, Vex, Slow, and Cleave weapon masteries in combat', () => {
    fixedHitRolls();

    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 1), 'blue', { x: 9, y: 10 }, 0);
    const ogre = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 10 }, 0);
    let state = initBattle([fighter, ogre], 20);
    state.initiativeOrder = [fighter.id, ogre.id];
    state.turnIndex = 0;
    resolveAttack(state, fighter, ogre, fighter.monsterData.actions.find(a => a.name === 'Longsword')!);
    expect(ogre.activeBuffs.some(b => b.attackDisadvantage)).toBe(true);

    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 1), 'blue', { x: 9, y: 10 }, 0);
    const ogre2 = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 10 }, 0);
    state = initBattle([rogue, ogre2], 20);
    state.initiativeOrder = [rogue.id, ogre2.id];
    state.turnIndex = 0;
    resolveAttack(state, rogue, ogre2, rogue.monsterData.actions.find(a => a.name === 'Rapier')!);
    expect(ogre2.activeBuffs.some(b => b.advantageForAttackerId === rogue.id)).toBe(true);

    const ranger = createCreatureWithFixedHp(buildHero('Ranger', 1), 'blue', { x: 5, y: 10 }, 0);
    const ogre3 = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 10 }, 0);
    state = initBattle([ranger, ogre3], 20);
    state.initiativeOrder = [ranger.id, ogre3.id];
    state.turnIndex = 0;
    resolveAttack(state, ranger, ogre3, ranger.monsterData.actions.find(a => a.name === 'Longbow')!);
    expect(ogre3.activeBuffs.some(b => b.speedPenalty === 10)).toBe(true);

    const barbarian = createCreatureWithFixedHp(buildHero('Barbarian', 1), 'blue', { x: 9, y: 10 }, 0);
    const ogre4 = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 10 }, 0);
    const ogre5 = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 11 }, 1);
    state = initBattle([barbarian, ogre4, ogre5], 20);
    state.initiativeOrder = [barbarian.id, ogre4.id, ogre5.id];
    state.turnIndex = 0;
    resolveAttack(state, barbarian, ogre4, barbarian.monsterData.actions.find(a => a.name === 'Greataxe')!);
    expect(state.logs.some(l => l.action === 'Cleave')).toBe(true);
    expect(ogre5.currentHp).toBeLessThan(ogre5.maxHp);
  });

  it('gates Rogue Sneak Attack by advantage or an adjacent ally', () => {
    fixedHitRolls();

    const soloRogue = createCreatureWithFixedHp(buildHero('Rogue', 1), 'blue', { x: 9, y: 10 }, 0);
    const ogre = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 10 }, 0);
    let state = initBattle([soloRogue, ogre], 20);
    state.initiativeOrder = [soloRogue.id, ogre.id];
    state.turnIndex = 0;
    resolveAttack(state, soloRogue, ogre, soloRogue.monsterData.actions.find(a => a.name === 'Rapier')!);
    expect(state.logs.some(l => l.details.startsWith('Plus'))).toBe(false);

    const helpedRogue = createCreatureWithFixedHp(buildHero('Rogue', 1), 'blue', { x: 9, y: 10 }, 0);
    const ally = createCreatureWithFixedHp(buildHero('Fighter', 1), 'blue', { x: 11, y: 10 }, 1);
    const ogre2 = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 10 }, 0);
    state = initBattle([helpedRogue, ally, ogre2], 20);
    state.initiativeOrder = [helpedRogue.id, ally.id, ogre2.id];
    state.turnIndex = 0;
    resolveAttack(state, helpedRogue, ogre2, helpedRogue.monsterData.actions.find(a => a.name === 'Rapier')!);
    expect(state.logs.some(l => l.details.startsWith('Plus'))).toBe(true);
  });

  it('adds Rage damage to the Barbarian Cleave target', () => {
    const barbarian = createCreatureWithFixedHp(buildHero('Barbarian', 1), 'blue', { x: 9, y: 10 }, 0);
    const ogre = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 10 }, 0);
    const cleaveTarget = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 11 }, 1);
    const state = initBattle([barbarian, ogre, cleaveTarget], 20);
    state.initiativeOrder = [barbarian.id, ogre.id, cleaveTarget.id];
    state.turnIndex = 0;
    addBuff(barbarian, {
      name: 'Rage',
      key: 'rage',
      casterId: barbarian.id,
      appliedRound: 1,
      endRound: 11,
      rageDamageBonus: 2,
      resistPhysical: true,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.7);

    resolveAttack(state, barbarian, ogre, barbarian.monsterData.actions.find(a => a.name === 'Greataxe')!);

    expect(cleaveTarget.maxHp - cleaveTarget.currentHp).toBe(11);
    expect(state.logs.some(l =>
      l.action === 'Cleave' &&
      l.details.includes('for 11 slashing damage')
    )).toBe(true);
  });

  it('adds Rage damage to Strength-based thrown weapon attacks', () => {
    const barbarian = createCreatureWithFixedHp(buildHero('Barbarian', 1), 'blue', { x: 5, y: 10 }, 0);
    const ogre = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 10, y: 10 }, 0);
    const state = initBattle([barbarian, ogre], 20);
    state.initiativeOrder = [barbarian.id, ogre.id];
    state.turnIndex = 0;
    addBuff(barbarian, {
      name: 'Rage',
      key: 'rage',
      casterId: barbarian.id,
      appliedRound: 1,
      endRound: 11,
      rageDamageBonus: 2,
      resistPhysical: true,
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.7);

    resolveAttack(state, barbarian, ogre, barbarian.monsterData.actions.find(a => a.name === 'Javelin')!);

    expect(ogre.maxHp - ogre.currentHp).toBe(10);
  });

  it('applies 2024 spell riders for Vicious Mockery, Guiding Bolt, Bless, and Bane', () => {
    const bard = createCreatureWithFixedHp(buildHero('Bard', 1), 'blue', { x: 8, y: 10 }, 0);
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 1), 'blue', { x: 8, y: 11 }, 1);
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 1), 'blue', { x: 8, y: 12 }, 2);
    const rogue = createCreatureWithFixedHp(buildHero('Rogue', 1), 'blue', { x: 8, y: 13 }, 3);
    const ogre = createCreatureWithFixedHp(monster('Ogre'), 'red', { x: 12, y: 10 }, 0);
    const goblin1 = createCreatureWithFixedHp(monster('Goblin Warrior'), 'red', { x: 12, y: 11 }, 1);
    const goblin2 = createCreatureWithFixedHp(monster('Goblin Warrior'), 'red', { x: 12, y: 12 }, 2);
    const state = initBattle([bard, cleric, fighter, rogue, ogre, goblin1, goblin2], 20);
    state.initiativeOrder = [bard.id, cleric.id, fighter.id, rogue.id, ogre.id, goblin1.id, goblin2.id];
    state.turnIndex = 0;

    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    executeSpell(state, bard, bard.monsterData.actions.find(a => a.name === 'Vicious Mockery')!, ogre);
    expect(ogre.activeBuffs.some(b => b.name === 'Vicious Mockery' && b.attackDisadvantage)).toBe(true);

    vi.restoreAllMocks();
    fixedHitRolls();
    state.turnIndex = 1;
    resolveAttack(state, cleric, ogre, cleric.monsterData.actions.find(a => a.name === 'Guiding Bolt')!);
    expect(ogre.activeBuffs.some(b => b.name === 'Guiding Bolt' && b.advantageForAllAttackers)).toBe(true);

    executeSpell(state, cleric, cleric.monsterData.actions.find(a => a.name === 'Bless')!, fighter);
    expect([bard, cleric, fighter, rogue].filter(c => c.activeBuffs.some(b => b.name === 'Bless'))).toHaveLength(3);

    vi.restoreAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    executeSpell(state, bard, bard.monsterData.actions.find(a => a.name === 'Bane')!, ogre);
    expect([ogre, goblin1, goblin2].filter(c => c.activeBuffs.some(b => b.name === 'Bane'))).toHaveLength(3);
  });
});
