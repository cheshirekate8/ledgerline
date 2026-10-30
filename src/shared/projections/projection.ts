import { StoredEvent } from '../events/domain-event';
import { EventStore } from '../events/event-store';
import { SequenceTracker } from '../events/sequence-tracker';
import { UpcasterRegistry } from '../events/upcaster-registry';
import { EventSubscriber } from '../messaging/event-dispatcher';

/**
 * A read model derived purely from events. `apply` must be deterministic and
 * depend only on the event and the projection's own state, so that a
 * rebuild from the store always yields the same result.
 */
export interface Projection {
  readonly name: string;
  readonly aggregateTypes: readonly string[];
  apply(event: StoredEvent): void;
  reset(): void;
}

/**
 * Wraps a projection with per-aggregate sequence checking: redelivered
 * events are ignored, and an event that arrives ahead of its predecessor is
 * refused with OutOfOrderEventError rather than applied.
 */
export class ProjectionHost<P extends Projection = Projection> implements EventSubscriber {
  private readonly tracker = new SequenceTracker();

  constructor(
    readonly projection: P,
    private readonly upcasters: UpcasterRegistry,
  ) {}

  get name(): string {
    return this.projection.name;
  }

  get aggregateTypes(): readonly string[] {
    return this.projection.aggregateTypes;
  }

  handle(event: StoredEvent): void {
    if (!this.aggregateTypes.includes(event.aggregateType)) {
      return;
    }
    if (this.tracker.classify(event) === 'duplicate') {
      return;
    }
    this.projection.apply(this.upcasters.upcast(event));
    this.tracker.record(event);
  }

  /** Discards the read model and replays every relevant event from the store. */
  rebuild(store: EventStore): void {
    this.projection.reset();
    this.tracker.reset();
    for (const event of store.readAll()) {
      this.handle(event);
    }
  }

  lastSequence(aggregateType: string, aggregateId: string): number {
    return this.tracker.lastSequence(aggregateType, aggregateId);
  }
}
