/**
 * The decision part of an event, as produced by an aggregate: what happened
 * (`type`), which schema the payload follows (`version`), and the payload.
 */
export interface EventData<TType extends string = string, TPayload = unknown> {
  readonly type: TType;
  readonly version: number;
  readonly payload: TPayload;
}

/** Context about the command that caused an event. */
export interface EventMetadata {
  readonly idempotencyKey?: string;
  readonly commandType?: string;
  readonly commandFingerprint?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

/** An event ready to be appended: identified and timestamped, not yet sequenced. */
export type NewEvent<E extends EventData = EventData> = E & {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly metadata: EventMetadata;
};

/**
 * An event as persisted. `sequence` is its 1-based position within its
 * aggregate's stream; `position` is its 1-based position across the store.
 */
export type StoredEvent<E extends EventData = EventData> = NewEvent<E> & {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly position: number;
};

export function streamKey(aggregateType: string, aggregateId: string): string {
  return `${aggregateType}:${aggregateId}`;
}

export function eventStreamKey(event: Pick<StoredEvent, 'aggregateType' | 'aggregateId'>): string {
  return streamKey(event.aggregateType, event.aggregateId);
}
