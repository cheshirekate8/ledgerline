import { NewEvent, StoredEvent } from './domain-event';

export type EventListener = (events: readonly StoredEvent[]) => void;

/**
 * An append-only log of events grouped into per-aggregate streams. There is
 * deliberately no way to update or delete an event.
 */
export interface EventStore {
  /**
   * Appends `events` to a stream. `expectedSequence` is the sequence the
   * caller last saw for the stream (0 for a new stream); if the stream has
   * moved on, nothing is written and a ConcurrencyError is thrown.
   */
  append(
    aggregateType: string,
    aggregateId: string,
    expectedSequence: number,
    events: readonly NewEvent[],
  ): readonly StoredEvent[];

  /** Events of one stream with a sequence greater than `afterSequence`. */
  readStream(aggregateType: string, aggregateId: string, afterSequence?: number): readonly StoredEvent[];

  /** Every event with a global position greater than `afterPosition`, in order. */
  readAll(afterPosition?: number): readonly StoredEvent[];

  currentSequence(aggregateType: string, aggregateId: string): number;

  listAggregateIds(aggregateType: string): readonly string[];

  /** Called synchronously after every successful append. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void;
}

export class DuplicateEventIdError extends Error {
  constructor(readonly eventId: string) {
    super(`An event with id ${eventId} has already been stored`);
    this.name = 'DuplicateEventIdError';
  }
}

export class InvalidEventError extends Error {
  constructor(reason: string) {
    super(`Invalid event: ${reason}`);
    this.name = 'InvalidEventError';
  }
}
