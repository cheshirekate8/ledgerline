import { StoredEvent } from '../events/domain-event';
import { EventStore } from '../events/event-store';
import { UpcasterRegistry } from '../events/upcaster-registry';
import { LogFields } from '../logger';
import { InProcessQueue } from './in-process-queue';

/** Something that reacts to stored events: a projection or a process manager. */
export interface EventSubscriber {
  readonly name: string;
  /** Every event of these aggregate types is delivered, in stream order. */
  readonly aggregateTypes: readonly string[];
  handle(event: StoredEvent): Promise<void> | void;
}

export interface EventDelivery {
  readonly subscriber: string;
  readonly event: StoredEvent;
}

export class UnknownSubscriberError extends Error {
  constructor(readonly subscriber: string) {
    super(`No subscriber named ${subscriber} is registered`);
    this.name = 'UnknownSubscriberError';
  }
}

/**
 * Fans each appended event out to the queue once per interested subscriber.
 * Deliveries are grouped by subscriber and aggregate, so each subscriber sees
 * an aggregate's events one at a time and in order, while different
 * aggregates and subscribers proceed in parallel.
 */
export class EventDispatcher {
  private readonly subscribers = new Map<string, EventSubscriber>();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly store: EventStore,
    private readonly queue: InProcessQueue<EventDelivery>,
    private readonly upcasters: UpcasterRegistry,
  ) {}

  register(subscriber: EventSubscriber): this {
    if (this.subscribers.has(subscriber.name)) {
      throw new Error(`A subscriber named ${subscriber.name} is already registered`);
    }
    this.subscribers.set(subscriber.name, subscriber);
    return this;
  }

  start(): void {
    if (!this.unsubscribe) {
      this.unsubscribe = this.store.subscribe((events) => this.publish(events));
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  publish(events: readonly StoredEvent[]): void {
    for (const event of events) {
      for (const subscriber of this.subscribers.values()) {
        if (subscriber.aggregateTypes.includes(event.aggregateType)) {
          this.queue.enqueue(
            { subscriber: subscriber.name, event },
            { groupKey: `${subscriber.name}|${event.aggregateType}:${event.aggregateId}` },
          );
        }
      }
    }
  }

  /** The queue handler: hands one delivery to its subscriber. */
  readonly deliver = async (delivery: EventDelivery): Promise<void> => {
    const subscriber = this.subscribers.get(delivery.subscriber);
    if (!subscriber) {
      throw new UnknownSubscriberError(delivery.subscriber);
    }
    await subscriber.handle(this.upcasters.upcast(delivery.event));
  };

  static describe(delivery: EventDelivery): LogFields {
    const { event } = delivery;
    return {
      subscriber: delivery.subscriber,
      eventId: event.eventId,
      eventType: event.type,
      eventVersion: event.version,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      sequence: event.sequence,
    };
  }
}
