import { OutOfOrderEventError } from '../errors';
import { eventStreamKey, StoredEvent, streamKey } from './domain-event';

export type SequenceVerdict = 'next' | 'duplicate';

/**
 * Remembers the last sequence applied for each aggregate stream, so that a
 * consumer can ignore redelivered events and refuse to skip over missing
 * ones. A gap raises OutOfOrderEventError instead of being applied.
 */
export class SequenceTracker {
  private readonly lastApplied = new Map<string, number>();

  classify(event: Pick<StoredEvent, 'aggregateType' | 'aggregateId' | 'sequence'>): SequenceVerdict {
    const key = eventStreamKey(event);
    const last = this.lastApplied.get(key) ?? 0;
    if (event.sequence <= last) {
      return 'duplicate';
    }
    if (event.sequence !== last + 1) {
      throw new OutOfOrderEventError(key, last + 1, event.sequence);
    }
    return 'next';
  }

  record(event: Pick<StoredEvent, 'aggregateType' | 'aggregateId' | 'sequence'>): void {
    this.lastApplied.set(eventStreamKey(event), event.sequence);
  }

  lastSequence(aggregateType: string, aggregateId: string): number {
    return this.lastApplied.get(streamKey(aggregateType, aggregateId)) ?? 0;
  }

  reset(): void {
    this.lastApplied.clear();
  }
}
