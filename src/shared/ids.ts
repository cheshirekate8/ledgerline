import { randomUUID } from 'node:crypto';

/** Produces unique identifiers. Injected everywhere an id is minted. */
export interface IdGenerator {
  next(): string;
}

export class RandomIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

/**
 * Deterministic UUID-shaped identifiers derived from a 32-bit seed using the
 * mulberry32 generator. Two generators with the same seed produce the same
 * sequence, which keeps event streams reproducible across test runs.
 */
export class SeededIdGenerator implements IdGenerator {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new RangeError(`Seed must be an integer, got ${seed}`);
    }
    this.state = seed >>> 0;
  }

  next(): string {
    const hex = [this.nextWord(), this.nextWord(), this.nextWord(), this.nextWord()]
      .map((word) => word.toString(16).padStart(8, '0'))
      .join('');
    const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `4${hex.slice(13, 16)}`,
      `${variant}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join('-');
  }

  private nextWord(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
}
