import { EventStore } from '../events/event-store';

export interface IdempotencyRecord {
  readonly key: string;
  readonly commandType: string;
  readonly fingerprint: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly eventIds: readonly string[];
}

/** Remembers which idempotency keys have been processed and what they produced. */
export interface IdempotencyStore {
  get(key: string): IdempotencyRecord | undefined;
  put(record: IdempotencyRecord): void;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  get(key: string): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  put(record: IdempotencyRecord): void {
    this.records.set(record.key, Object.freeze({ ...record, eventIds: [...record.eventIds] }));
  }

  get size(): number {
    return this.records.size;
  }
}

/**
 * Rebuilds idempotency records from the metadata of stored events. Because
 * the key travels inside the events it caused, a restart over a persistent
 * event store still recognises commands that were already applied.
 */
export function hydrateIdempotencyStore(events: EventStore, store: IdempotencyStore): number {
  const byKey = new Map<string, { commandType: string; fingerprint: string; aggregateId: string; version: number; eventIds: string[] }>();
  for (const event of events.readAll()) {
    const { idempotencyKey, commandType, commandFingerprint } = event.metadata;
    if (!idempotencyKey || !commandType || !commandFingerprint) {
      continue;
    }
    const entry = byKey.get(idempotencyKey);
    if (entry) {
      entry.version = event.sequence;
      entry.eventIds.push(event.eventId);
    } else {
      byKey.set(idempotencyKey, {
        commandType,
        fingerprint: commandFingerprint,
        aggregateId: event.aggregateId,
        version: event.sequence,
        eventIds: [event.eventId],
      });
    }
  }
  for (const [key, entry] of byKey) {
    store.put({ key, ...entry });
  }
  return byKey.size;
}
