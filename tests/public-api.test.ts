import { describe, expect, it } from 'vitest';
import { executeRound, executeTurn } from '../src/index';

describe('public package API', () => {
  it('exports round and single-turn combat executors', () => {
    expect(typeof executeRound).toBe('function');
    expect(typeof executeTurn).toBe('function');
  });
});
