import { describe, expect, it } from 'vitest';
import { buildSpellAction, sleetStorm } from '../src/data/spells.js';

describe('Sleet Storm spell data', () => {
  it('uses the persistent-zone mechanics supported by the engine', () => {
    const action = sleetStorm('wis', 3, 3);
    expect(action).toMatchObject({
      name: 'Sleet Storm', spellLevel: 3, concentration: true,
      range: { normal: 150, long: 150 },
      savingThrow: { ability: 'dex', dc: 14, conditionOnFail: 'prone', conditionDuration: 'end_of_current_turn' },
      persistentZone: { radiusFt: 20, durationRounds: 10, triggers: ['entry', 'turnStart'], difficultTerrain: true, obscuresSight: true },
    });
  });

  it('is available through the shared spell factory registry', () => {
    expect(buildSpellAction('Sleet Storm', 'int', 4, 3)).toMatchObject({
      name: 'Sleet Storm', spellLevel: 3, savingThrow: { dc: 15 },
    });
  });

  it('keeps Stinking Cloud save DC tied to the caster', () => {
    expect(buildSpellAction('Stinking Cloud', 'cha', 4, 3)).toMatchObject({
      savingThrow: { ability: 'con', dc: 15, area: '20-foot sphere' },
    });
  });
});
