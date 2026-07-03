// Injectable randomness for the engine.
//
// BattleCast calls Math.random() directly; this module is the one deliberate
// divergence in the extracted engine. Every former Math.random() call site now
// goes through engineRandom(), which reads a scoped RandomSource installed by
// withRng() and falls back to Math.random() when none is installed - so the
// engine behaves exactly like upstream BattleCast unless a caller opts into
// determinism.
//
// Engine calls are fully synchronous, so a simple install/restore scope is
// safe even with many encounters interleaving in one process. No
// node:async_hooks - the library stays runtime-agnostic (Node, browser, worker).

export type RandomSeed = string | number;

export interface RandomSource {
  next(): number;
}

const UINT32_RANGE = 0x100000000;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function normalizeSeed(seed: RandomSeed): number {
  if (typeof seed === 'number') {
    return seed >>> 0;
  }
  // FNV-1a over the string
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Deterministic mulberry32 PRNG with snapshot/restore for serialization. */
export class SeededRng implements RandomSource {
  private state: number;

  constructor(seed: RandomSeed) {
    this.state = normalizeSeed(seed);
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5) >>> 0;
    this.state = this.state >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  }

  snapshot(): number {
    return this.state >>> 0;
  }

  restore(snapshot: number): void {
    this.state = snapshot >>> 0;
  }
}

let currentRng: RandomSource | null = null;

/** The engine's single randomness primitive. Returns [0, 1). */
export function engineRandom(): number {
  return currentRng ? currentRng.next() : Math.random();
}

/**
 * Run `fn` with `rng` installed as the engine's random source, restoring the
 * previous source afterwards. All engine entry points are synchronous, so
 * this scoping is exact.
 */
export function withRng<T>(rng: RandomSource | null, fn: () => T): T {
  const previous = currentRng;
  currentRng = rng;
  try {
    return fn();
  } finally {
    currentRng = previous;
  }
}
