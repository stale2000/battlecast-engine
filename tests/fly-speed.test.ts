import { describe, it, expect } from 'vitest';
import { monsters } from '../src/data/monsters';
import { runBattle } from '../src/engine/ai';
import { createCreatureWithFixedHp } from '../src/engine/combat';

function md(name: string) {
  const m = monsters.find(x => x.name === name);
  if (!m) throw new Error(`Monster not found: ${name}`);
  return m;
}

describe('Flying creature movement uses fly speed', () => {
  it('Beholder (walk 5, fly 40 hover) can move', () => {
    const beholder = md('Beholder');
    expect(beholder.speed.walk).toBe(5);
    expect(beholder.speed.fly).toBe(40);
    const veteran = md('Veteran');
    let beholderMoved = false;
    // Place veteran past the Beholder's 120ft ray range so it has to close
    // in. Otherwise the ranged-preferring AI correctly stands still and
    // shoots, and this test would never see a fly-speed move.
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(beholder, 'red', { x: 2, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 38, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 40);
      if (state.events.some(e => e.kind === 'move' && e.creatureId === creatures[0].id)) {
        beholderMoved = true;
        break;
      }
    }
    expect(beholderMoved).toBe(true);
  });

  it('Dragon (walk 40, fly 80) moves more than 8 cells', () => {
    const dragon = md('Adult Red Dragon');
    expect(dragon.speed.walk).toBe(40);
    expect(dragon.speed.fly).toBe(80);
    const veteran = md('Veteran');
    let maxMove = 0;
    for (let i = 0; i < 10; i++) {
      const creatures = [
        createCreatureWithFixedHp(dragon, 'red', { x: 2, y: 10 }, 0),
        createCreatureWithFixedHp(veteran, 'blue', { x: 18, y: 10 }, 0),
      ];
      const state = runBattle(creatures, 20);
      for (const e of state.events) {
        if (e.kind === 'move' && e.creatureId === creatures[0].id) {
          const dist = Math.max(
            Math.abs((e as any).to.x - (e as any).from.x),
            Math.abs((e as any).to.y - (e as any).from.y)
          );
          if (dist > maxMove) maxMove = dist;
        }
      }
    }
    // Fly 80 = 16 cells, walk 40 = 8 cells. Should move > 8.
    expect(maxMove).toBeGreaterThan(8);
  });

  it('creature with fly speed starts with correct movementRemaining', () => {
    const eagle = md('Eagle');
    expect(eagle.speed.walk).toBe(10);
    expect(eagle.speed.fly).toBe(60);
    const c = createCreatureWithFixedHp(eagle, 'red', { x: 5, y: 5 }, 0);
    expect(c.movementRemaining).toBe(60);
  });

  it('creature without fly speed uses walk speed', () => {
    const veteran = md('Veteran');
    expect(veteran.speed.fly).toBeUndefined();
    const c = createCreatureWithFixedHp(veteran, 'red', { x: 5, y: 5 }, 0);
    expect(c.movementRemaining).toBe(veteran.speed.walk);
  });
});
