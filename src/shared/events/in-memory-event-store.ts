import { ConcurrencyError } from '../errors';
import { deepFreeze } from '../stable-json';
import { NewEvent, StoredEvent, streamKey } from './domain-event';
import { DuplicateEventIdError, EventListener, EventStore, InvalidEventError } from './event-store';

/** Keeps every event in process memory. The base for the file-backed store. */
export class InMemoryEventStore implements EventStore {
  private readonly log: StoredEvent[] = [];
  private readonly streams = new Map<string, StoredEvent[]>();
  private readonly idsByType = new Map<string, string[]>();
  private readonly eventIds = new Set<string>();
  private readonly listeners = new Set<EventListener>();

  append(
    aggregateType: string,
    aggregateId: string,
    expectedSequence: number,
    events: readonly NewEvent[],
  ): readonly StoredEvent[] {
    const key = streamKey(aggregateType, aggregateId);
    const actual = this.currentSequence(aggregateType, aggregateId);
    if (actual !== expectedSequence) {
      throw new ConcurrencyError(key, expectedSequence, actual);
    }
    if (events.length === 0) {
      return [];
    }
    const batchIds = new Set<string>();
    const records = events.map((event, index) => {
      validateNewEvent(event);
      if (this.eventIds.has(event.eventId) || batchIds.has(event.eventId)) {
        throw new DuplicateEventIdError(event.eventId);
      }
      batchIds.add(event.eventId);
      return deepFreeze({
        ...event,
        aggregateType,
        aggregateId,
        sequence: actual + index + 1,
        position: this.log.length + index + 1,
      } as StoredEvent);
    });

    this.persist(records);
    this.commit(records);
    for (const listener of this.listeners) {
      listener(records);
    }
    return records;
  }

  readStream(aggregateType: string, aggregateId: string, afterSequence = 0): readonly StoredEvent[] {
    const stream = this.streams.get(streamKey(aggregateType, aggregateId)) ?? [];
    return stream.slice(Math.max(0, afterSequence));
  }

  readAll(afterPosition = 0): readonly StoredEvent[] {
    return this.log.slice(Math.max(0, afterPosition));
  }

  currentSequence(aggregateType: string, aggregateId: string): number {
    return this.streams.get(streamKey(aggregateType, aggregateId))?.length ?? 0;
  }

  listAggregateIds(aggregateType: string): readonly string[] {
    return [...(this.idsByType.get(aggregateType) ?? [])];
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Durably records a batch before it becomes visible. A no-op in memory. */
  protected persist(_records: readonly StoredEvent[]): void {
    return undefined;
  }

  /** Makes already-durable records visible, without notifying listeners. */
  protected commit(records: readonly StoredEvent[]): void {
    for (const record of records) {
      const key = streamKey(record.aggregateType, record.aggregateId);
      let stream = this.streams.get(key);
      if (!stream) {
        stream = [];
        this.streams.set(key, stream);
        const ids = this.idsByType.get(record.aggregateType) ?? [];
        ids.push(record.aggregateId);
        this.idsByType.set(record.aggregateType, ids);
      }
      stream.push(record);
      this.log.push(record);
      this.eventIds.add(record.eventId);
    }
  }
}

function validateNewEvent(event: NewEvent): void {
  if (typeof event.type !== 'string' || event.type.length === 0) {
    throw new InvalidEventError('type must be a non-empty string');
  }
  if (!Number.isInteger(event.version) || event.version < 1) {
    throw new InvalidEventError(`${event.type} version must be a positive integer`);
  }
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    throw new InvalidEventError(`${event.type} eventId must be a non-empty string`);
  }
  if (typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new InvalidEventError(`${event.type} occurredAt must be an ISO-8601 timestamp`);
  }
}
