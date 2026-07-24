import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai';
import { addBuff, createCreatureWithFixedHp, executeSpell, initBattle } from '../src/engine/combat';
import { trySpellcast } from '../src/engine/ai-spellcasting';
import { executeTurn } from '../src/engine/ai-turn';
import { haste } from '../src/data/spells';

function md(name: string) { return monsters.find(x => x.name === name)!; }

describe('Barbarian bonus action: Rage + attack on same turn', () => {
  it('uses Rage AND Greataxe on round 1', () => {
    const barb = buildHero('Barbarian', 5);
    const goblin = md('Goblin Warrior');
    let rageAndAttackR1 = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(barb, 'blue', { x: 8, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const r1 = state.logs.filter(l => l.round === 1 && l.actor?.includes('Barbarian'));
      const hasRage = r1.some(l => l.action === 'Rage');
      const hasAttack = r1.some(l => l.action === 'Greataxe');
      if (hasRage && hasAttack) rageAndAttackR1++;
    }
    expect(rageAndAttackR1).toBeGreaterThan(15);
  });
});

describe('Warlock bonus action: Hex + Eldritch Blast on same turn', () => {
  it('casts Hex AND attacks on round 1', () => {
    const warlock = buildHero('Warlock', 3);
    const goblin = md('Goblin Warrior');
    let hexAndAttackR1 = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(warlock, 'blue', { x: 7, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const r1 = state.logs.filter(l => l.round === 1 && l.actor?.includes('Warlock'));
      const hasHex = r1.some(l => l.action === 'Hex');
      const hasAttack = r1.some(l => l.action === 'Eldritch Blast' || l.action === 'Hold Person' || l.action === 'Hypnotic Pattern');
      if (hasHex && hasAttack) hexAndAttackR1++;
    }
    expect(hexAndAttackR1).toBeGreaterThan(10);
  });

  it('moves Hex to a new target after the cursed target drops without spending a slot', () => {
    const warlockData = buildHero('Warlock', 1);
    const goblin = md('Goblin Warrior');
    const first = createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0);
    const second = createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 10 }, 1);
    const warlock = createCreatureWithFixedHp(warlockData, 'blue', { x: 7, y: 10 }, 0);
    warlock.monsterData = {
      ...warlock.monsterData,
      actions: warlock.monsterData.actions.filter(a => a.name === 'Hex'),
    };
    warlock.resources['slot-1'] = 0;
    warlock.concentratingOn = 'hex';
    first.isAlive = false;
    first.currentHp = 0;
    addBuff(first, {
      name: 'Hex', key: 'hex', casterId: warlock.id,
      appliedRound: 1, endRound: 30,
      requiresConcentration: true,
      damageRider: '1d6 necrotic',
    });
    const state = initBattle([first, second, warlock], 20);
    state.round = 2;
    const slotsBefore = warlock.resources['slot-1'];

    trySpellcast(state, warlock);

    expect(first.activeBuffs.some(b => b.key === 'hex' && b.casterId === warlock.id)).toBe(false);
    expect(second.activeBuffs.some(b => b.key === 'hex' && b.casterId === warlock.id)).toBe(true);
    expect(warlock.resources['slot-1']).toBe(slotsBefore);
    expect(state.logs.some(l => l.action === 'Hex' && l.details.includes('moves Hex'))).toBe(true);
  });
});

describe('Ranger bonus action: Hunter\'s Mark + Longbow on same turn', () => {
  it('casts Hunter\'s Mark AND shoots on round 1', () => {
    const ranger = buildHero('Ranger', 5);
    const goblin = md('Goblin Warrior');
    let markAndShootR1 = 0;
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 15, y: 10 }, 0),
        createCreatureWithFixedHp(ranger, 'blue', { x: 5, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const r1 = state.logs.filter(l => l.round === 1 && l.actor?.includes('Ranger'));
      const hasMark = r1.some(l => l.action === "Hunter's Mark");
      const hasShot = r1.some(l => l.action === 'Longbow');
      if (hasMark && hasShot) markAndShootR1++;
    }
    expect(markAndShootR1).toBeGreaterThan(15);
  });
});

describe('Healing Word is bonus action', () => {
  it('Cleric can Healing Word + attack on same turn', () => {
    const cleric = buildHero('Cleric', 5);
    const goblin = md('Goblin Warrior');
    let healAndActSameTurn = 0;
    for (let i = 0; i < 80; i++) {
      const c = createCreatureWithFixedHp(cleric, 'blue', { x: 8, y: 10 }, 0);
      c.currentHp = 10; // Low HP triggers healing
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 10 }, 1),
        createCreatureWithFixedHp(goblin, 'red', { x: 12, y: 10 }, 2),
        c,
      ];
      const state = runBattle(creatures, 20);
      // Check if any round has both Healing Word and another action
      for (let r = 1; r <= state.round; r++) {
        const logs = state.logs.filter(l => l.round === r && l.actor?.includes('Cleric'));
        const hasHW = logs.some(l => l.action === 'Healing Word');
        const hasOther = logs.some(l =>
          l.action === 'Spirit Guardians' || l.action === 'Guiding Bolt' ||
          l.action === 'Warhammer' || l.action === 'Sacred Flame'
        );
        if (hasHW && hasOther) { healAndActSameTurn++; break; }
      }
    }
    expect(healAndActSameTurn).toBeGreaterThan(0);
  });
});

describe('Spiritual Weapon bonus action', () => {
  it('uses an existing Spiritual Weapon before its main-action spell choice', () => {
    const cleric = createCreatureWithFixedHp(buildHero('Cleric', 5), 'blue', { x: 8, y: 10 }, 0);
    const goblin = createCreatureWithFixedHp(md('Goblin Warrior'), 'red', { x: 10, y: 10 }, 0);
    cleric.spiritualWeapon = {
      position: { x: 9, y: 10 }, endRound: 10, moveFt: 20,
      attackBonus: 6, damage: '1d8+3', damageType: 'force',
    };
    const state = initBattle([goblin, cleric], 20);

    trySpellcast(state, cleric);

    expect(cleric.bonusActionUsed).toBe(true);
    expect(state.logs.some(log => log.action === 'Spiritual Weapon')).toBe(true);
  });
});

describe('Haste restricted extra action', () => {
  it('adds one weapon attack after the AI uses its normal multiattack', () => {
    const fighter = createCreatureWithFixedHp(buildHero('Fighter', 5), 'blue', { x: 8, y: 10 }, 0);
    const wizard = createCreatureWithFixedHp(buildHero('Wizard', 5), 'blue', { x: 7, y: 10 }, 0);
    const goblin = createCreatureWithFixedHp(md('Goblin Warrior'), 'red', { x: 9, y: 10 }, 0);
    goblin.maxHp = 200;
    goblin.currentHp = 200;
    fighter.resources['action-surge'] = 0;
    const state = initBattle([goblin, fighter, wizard], 20);
    expect(executeSpell(state, wizard, haste('int', 3, 3), fighter)).toBe(true);

    executeTurn(state, fighter);

    expect(fighter.stats.attacksMade).toBe(3);
  });
});

describe('bonus action does not fire twice', () => {
  it('Rage is cast at most once per battle', () => {
    const barb = buildHero('Barbarian', 5);
    const goblin = md('Goblin Warrior');
    for (let i = 0; i < 20; i++) {
      const creatures = [
        createCreatureWithFixedHp(goblin, 'red', { x: 10, y: 10 }, 0),
        createCreatureWithFixedHp(goblin, 'red', { x: 11, y: 10 }, 1),
        createCreatureWithFixedHp(barb, 'blue', { x: 8, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      const rageCasts = state.logs.filter(l => l.action === 'Rage').length;
      expect(rageCasts).toBeLessThanOrEqual(1);
    }
  });
});
