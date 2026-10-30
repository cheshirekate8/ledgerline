/**
 * Source of the current time. Every component that needs "now" receives a
 * Clock so that tests can run against a fixed, fully controlled timeline.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * A clock that only moves when told to. Used by tests and by any replay
 * scenario where wall-clock time must not leak into the result.
 */
export class FixedClock implements Clock {
  private current: number;

  constructor(start: number | string | Date) {
    this.current = toEpochMillis(start);
  }

  now(): number {
    return this.current;
  }

  set(time: number | string | Date): void {
    const next = toEpochMillis(time);
    if (next < this.current) {
      throw new RangeError(`A fixed clock can only move forward, got ${toIsoString(next)}`);
    }
    this.current = next;
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError(`A fixed clock can only move forward, got ${milliseconds}ms`);
    }
    this.current += milliseconds;
  }
}

export function toEpochMillis(time: number | string | Date): number {
  const millis = time instanceof Date ? time.getTime() : typeof time === 'string' ? Date.parse(time) : time;
  if (!Number.isFinite(millis)) {
    throw new RangeError(`Invalid time value: ${String(time)}`);
  }
  return millis;
}

export function toIsoString(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
