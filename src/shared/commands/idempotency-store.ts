import { Clock, SystemClock } from '../clock';
import { EventStore } from '../events/event-store';

export interface IdempotencyRecord {
  readonly key: string;
  readonly commandType: string;
  readonly fingerprint: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly eventIds: readonly string[];
  /** When the command ran: the `occurredAt` of its events, or the clock if it raised none. */
  readonly ranAt: number;
}

/**
 * Remembers which idempotency keys have been processed and what they produced.
 * A record only lives for the configured window after its command ran (§6.4),
 * so the store stays bounded however long the service runs.
 */
export interface IdempotencyStore {
  /** The record for `key`, or undefined if it was never stored or its window has passed. */
  get(key: string): IdempotencyRecord | undefined;
  put(record: IdempotencyRecord): void;
  /** Drops every record whose window has passed. Called before each key check. */
  forgetExpired(): void;
  /** How many records are held, including any expired ones not yet dropped. */
  readonly size: number;
}

/** How long a key is remembered after its command ran, unless configured otherwise. */
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 86_400_000;

/**
 * Checks a configured idempotency window: a positive safe integer number of
 * milliseconds, or `Number.POSITIVE_INFINITY` to remember keys forever. An
 * absent window means {@link DEFAULT_IDEMPOTENCY_WINDOW_MS}.
 */
export function idempotencyWindowMs(configured: unknown): number {
  if (configured === undefined) {
    return DEFAULT_IDEMPOTENCY_WINDOW_MS;
  }
  if (configured === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof configured !== 'number' || !Number.isSafeInteger(configured) || configured <= 0) {
    throw new RangeError(
      `idempotencyWindowMs must be a positive safe integer of milliseconds or Number.POSITIVE_INFINITY, got ${String(configured)}`,
    );
  }
  return configured;
}

export interface IdempotencyStoreOptions {
  /** Decides when a record's window has passed; the service's injected clock. */
  readonly clock?: Clock;
  /** Milliseconds a record is kept after its command ran; `Infinity` for forever. */
  readonly windowMs?: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly clock: Clock;
  private readonly windowMs: number;

  constructor(options: IdempotencyStoreOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.windowMs = options.windowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS;
  }

  get(key: string): IdempotencyRecord | undefined {
    const record = this.records.get(key);
    return record && isLive(record, this.clock.now(), this.windowMs) ? record : undefined;
  }

  put(record: IdempotencyRecord): void {
    this.records.set(record.key, Object.freeze({ ...record, eventIds: [...record.eventIds] }));
  }

  forgetExpired(): void {
    const now = this.clock.now();
    for (const [key, record] of this.records) {
      if (!isLive(record, now, this.windowMs)) {
        this.records.delete(key);
      }
    }
  }

  get size(): number {
    return this.records.size;
  }
}

function isLive(record: IdempotencyRecord, now: number, windowMs: number): boolean {
  return now < record.ranAt + windowMs;
}

interface RebuiltRecord {
  commandType: string;
  fingerprint: string;
  aggregateId: string;
  version: number;
  eventIds: string[];
  ranAt: number;
}

/**
 * Rebuilds idempotency records from the metadata of stored events. Because
 * the key travels inside the events it caused, a restart over a persistent
 * event store still recognises commands that were already applied.
 *
 * A key is rebuilt as its *latest* use: one command's events share one
 * `occurredAt`, so the events carrying the key with the latest `occurredAt`
 * are the command the key now belongs to. Earlier uses are past the window by
 * definition (§6.4), and merging them would raise a false conflict. Records
 * whose window has already passed are not kept.
 *
 * Returns how many records the store holds afterwards, which for the empty
 * store a start-up hands it is exactly how many keys were rebuilt.
 */
export function hydrateIdempotencyStore(events: EventStore, store: IdempotencyStore): number {
  const latest = new Map<string, RebuiltRecord>();
  for (const event of events.readAll()) {
    const { idempotencyKey, commandType, commandFingerprint } = event.metadata;
    if (!idempotencyKey || !commandType || !commandFingerprint) {
      continue;
    }
    const ranAt = Date.parse(event.occurredAt);
    const known = latest.get(idempotencyKey);
    if (known && known.ranAt === ranAt) {
      known.version = event.sequence;
      known.eventIds.push(event.eventId);
      continue;
    }
    if (known && known.ranAt > ranAt) {
      continue;
    }
    latest.set(idempotencyKey, {
      commandType,
      fingerprint: commandFingerprint,
      aggregateId: event.aggregateId,
      version: event.sequence,
      eventIds: [event.eventId],
      ranAt,
    });
  }
  for (const [key, record] of latest) {
    store.put({ key, ...record });
  }
  store.forgetExpired();
  return store.size;
}
