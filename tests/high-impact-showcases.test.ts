import { afterEach, describe, expect, it, vi } from 'vitest';
import { monsters } from '../src/data/monsters';
import { buildHero, type HeroClassName } from '../src/data/heroes';
import { runBattle } from '../src/engine/ai-loop';
import { createCreatureWithFixedHp, type TacticType, type TeamTactics } from '../src/engine/combat';
import type { Creature, MonsterData } from '../src/types/monster';

function md(name: string): MonsterData {
  const monster = monsters.find(m => m.name === name);
  if (!monster) throw new Error(`Monster not found: ${name}`);
  return monster;
}

function monster(name: string, team: 'red' | 'blue', x: number, y: number, index: number): Creature {
  return createCreatureWithFixedHp(md(name), team, { x, y }, index);
}

function hero(
  className: HeroClassName,
  level: number,
  team: 'red' | 'blue',
  x: number,
  y: number,
  index: number,
): Creature {
  return createCreatureWithFixedHp(buildHero(className, level), team, { x, y }, index);
}

function runShowcase(
  creatures: Creature[],
  roll: number,
  tactics: Partial<TeamTactics> = {},
) {
  vi.spyOn(Math, 'random').mockReturnValue(roll);
  return runBattle(creatures, 24, {
    red: 'aggressive' as TacticType,
    blue: 'aggressive' as TacticType,
    ...tactics,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('high-impact monster rule showcases', () => {
  it('Shadow showcase visibly kills the Troll by reducing Strength to 0', () => {
    const shadows: Creature[] = [
      [9, 9], [10, 9], [11, 9], [12, 9],
      [9, 10], [12, 10],
      [9, 11], [12, 11],
      [9, 12], [10, 12], [11, 12], [12, 12],
    ].map(([x, y], index) => monster('Shadow', 'red', x, y, index));
    const troll = monster('Troll', 'blue', 10, 10, 0);

    const state = runShowcase([...shadows, troll], 0.5);

    expect(state.logs.some(l => l.action === 'Strength Reduced to 0')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.label.startsWith('Strength -'))).toBe(true);
    expect(troll.isAlive).toBe(false);
  });

  it('Troll regeneration showcase visibly heals at the start of its turn', () => {
    const state = runShowcase([
      monster('Troll', 'red', 10, 10, 0),
      hero('Rogue', 10, 'blue', 8, 10, 0),
      hero('Fighter', 10, 'blue', 8, 11, 1),
    ], 0.5, { blue: 'smart' });

    expect(state.logs.some(l => l.action === 'Regeneration')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.label === 'Regeneration')).toBe(true);
    expect(state.events.some(e => e.kind === 'heal')).toBe(true);
  });

  it('Troll showcase proves regeneration does not prevent 0 HP death', () => {
    const troll = monster('Troll', 'red', 10, 10, 0);
    const state = runShowcase([
      troll,
      hero('Rogue', 10, 'blue', 8, 9, 0),
      hero('Fighter', 10, 'blue', 8, 10, 1),
      hero('Druid', 10, 'blue', 8, 11, 2),
      hero('Wizard', 10, 'blue', 8, 12, 3),
    ], 0.5, { blue: 'smart' });

    expect(state.logs.some(l => l.action === 'Regeneration')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.label === 'Regeneration')).toBe(true);
    expect(troll.isAlive).toBe(false);
    expect(state.winner).toBe('blue');
  });

  it('HP maximum reduction showcase emits visible Max HP reduction bubbles', () => {
    const target = hero('Wizard', 10, 'blue', 11, 10, 0);
    const state = runShowcase([
      monster('Wraith', 'red', 9, 10, 0),
      monster('Specter', 'red', 9, 11, 1),
      monster('Wight', 'red', 10, 9, 2),
      target,
    ], 0.5);

    expect(state.logs.some(l => l.action === 'Hit Point Maximum Reduced')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.label.startsWith('Max HP -'))).toBe(true);
  });

  it('ongoing poison and wound showcases visibly attach ticking effects', () => {
    const state = runShowcase([
      monster('Pit Fiend', 'red', 8, 10, 0),
      monster('Adult Red Dragon', 'blue', 11, 10, 0),
    ], 0.3);

    expect(state.logs.some(l => l.action === 'Ongoing Effect' && l.details.includes('Pit Fiend Poison'))).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.label === 'Pit Fiend Poison')).toBe(true);
    expect(state.logs.some(l => l.action === 'Pit Fiend Poison' && l.damage && l.damage > 0)).toBe(true);
  });

  it('container showcases visibly apply the containment label and condition', () => {
    const ogre = monster('Ogre', 'blue', 10, 10, 0);
    const state = runShowcase([
      monster('Gelatinous Cube', 'red', 8, 10, 0),
      ogre,
    ], 0.2);

    expect(state.events.some(e => e.kind === 'effect' && e.label === 'Engulf')).toBe(true);
    expect(state.events.some(e => e.kind === 'condition' && e.condition === 'restrained' && e.applied)).toBe(true);
    expect(state.logs.some(l => l.action === 'Engulf' && l.details.includes('contained'))).toBe(true);
  });

  it('Hydra showcase visibly loses heads and resolves regrowth state', () => {
    const state = runShowcase([
      monster('Hydra', 'red', 10, 10, 0),
      hero('Fighter', 10, 'blue', 8, 9, 0),
      hero('Paladin', 10, 'blue', 8, 11, 1),
      hero('Wizard', 10, 'blue', 8, 13, 2),
      hero('Ranger', 10, 'blue', 8, 15, 3),
    ], 0.5, { blue: 'smart' });

    expect(state.logs.some(l => l.action === 'Head Severed')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.label.startsWith('Head Lost'))).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && (e.label.startsWith('Heads +') || e.label === 'No Regrowth'))).toBe(true);
  });

  it('Balor showcase visibly fires Death Throes on death', () => {
    const state = runShowcase([
      monster('Balor', 'red', 10, 10, 0),
      monster('Planetar', 'blue', 9, 9, 0),
      monster('Planetar', 'blue', 9, 11, 1),
      monster('Adult Red Dragon', 'blue', 13, 10, 2),
    ], 0.5);

    expect(state.logs.some(l => l.action === 'Death Throes')).toBe(true);
    expect(state.events.some(e => e.kind === 'aoe')).toBe(true);
    expect(state.events.some(e => e.kind === 'hit' && e.damageType === 'fire')).toBe(true);
    expect(state.events.some(e => e.kind === 'hit' && e.damageType === 'force')).toBe(true);
  });

  it('Tarrasque showcase visibly negates and reflects targeted spells', () => {
    const state = runShowcase([
      monster('Tarrasque', 'red', 10, 10, 0),
      hero('Warlock', 5, 'blue', 17, 9, 0),
      hero('Warlock', 5, 'blue', 17, 10, 1),
      hero('Warlock', 5, 'blue', 17, 11, 2),
    ], 0.99, { blue: 'smart' });

    expect(state.logs.some(l => l.action === 'Reflective Carapace')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.label === 'Spell Reflected')).toBe(true);
    expect(state.events.some(e => e.kind === 'effect' && e.label === 'Reflected')).toBe(true);
  });
});
