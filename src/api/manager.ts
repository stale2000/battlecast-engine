// In-memory registry of encounters for the MCP server. One server process
// can host many concurrent encounters, each with its own seeded RNG.

import { Encounter, EncounterError, type EncounterOptions } from './encounter.js';

export class EncounterManager {
  private encounters = new Map<string, Encounter>();
  private counter = 0;

  create(options: EncounterOptions = {}): { id: string; encounter: Encounter } {
    this.counter += 1;
    const id = `enc-${this.counter}`;
    const encounter = new Encounter(options);
    this.encounters.set(id, encounter);
    return { id, encounter };
  }

  /** Register an existing Encounter (e.g. one restored from a snapshot). */
  adopt(encounter: Encounter): string {
    this.counter += 1;
    const id = `enc-${this.counter}`;
    this.encounters.set(id, encounter);
    return id;
  }

  get(id: string): Encounter {
    const encounter = this.encounters.get(id);
    if (!encounter) {
      const known = [...this.encounters.keys()].join(', ') || '(none)';
      throw new EncounterError(`No encounter with id "${id}". Active encounters: ${known}`);
    }
    return encounter;
  }

  list(): { id: string; phase: string; creatures: number }[] {
    return [...this.encounters.entries()].map(([id, enc]) => ({
      id,
      phase: enc.phase,
      creatures: enc.creatures.length,
    }));
  }

  delete(id: string): void {
    if (!this.encounters.delete(id)) {
      throw new EncounterError(`No encounter with id "${id}".`);
    }
  }
}
