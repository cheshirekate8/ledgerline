import { StoredEvent } from '../events/domain-event';
import { EventStore } from '../events/event-store';
import { UpcasterRegistry } from '../events/upcaster-registry';
import { LogFields } from '../logger';
import { InProcessQueue } from './in-process-queue';
import { noSubscriberProgress, SubscriberProgress } from './subscriber-progress';

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

export interface RegisterOptions {
  /**
   * Track the subscriber's progress and queue what it had not finished when
   * it is registered. Off for read models, which rebuild from the log
   * instead. Does nothing for a store that keeps no progress.
   */
  readonly resume?: boolean;
}

/** Deliveries sharing this key are handled one at a time, in order (DESIGN §6.1). */
export function deliveryGroupKey(subscriber: string, event: StoredEvent): string {
  return `${subscriber}|${event.aggregateType}:${event.aggregateId}`;
}

/**
 * Fans each appended event out to the queue once per interested subscriber.
 * Deliveries are grouped by subscriber and aggregate, so each subscriber sees
 * an aggregate's events one at a time and in order, while different
 * aggregates and subscribers proceed in parallel.
 */
export class EventDispatcher {
  private readonly subscribers = new Map<string, EventSubscriber>();
  private readonly resuming = new Set<string>();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly store: EventStore,
    private readonly queue: InProcessQueue<EventDelivery>,
    private readonly upcasters: UpcasterRegistry,
    private readonly progress: SubscriberProgress = noSubscriberProgress,
  ) {}

  register(subscriber: EventSubscriber, options: RegisterOptions = {}): this {
    if (this.subscribers.has(subscriber.name)) {
      throw new Error(`A subscriber named ${subscriber.name} is already registered`);
    }
    this.subscribers.set(subscriber.name, subscriber);
    if (options.resume ?? true) {
      this.resuming.add(subscriber.name);
      this.queueBacklog(subscriber);
    }
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
          this.enqueue(subscriber.name, event);
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
    if (this.resuming.has(delivery.subscriber)) {
      this.progress.recordFinished(delivery.subscriber, delivery.event.eventId);
    }
  };

  /**
   * Queues every event the subscriber had not finished when it last stopped,
   * in stream order and ahead of anything appended from now on. Its dead
   * letters are left out: they wait for a redrive, not for a retry.
   */
  private queueBacklog(subscriber: EventSubscriber): void {
    const log = this.store.readAll();
    const baselines = new Map<string, number>();
    for (const aggregateType of subscriber.aggregateTypes) {
      baselines.set(aggregateType, this.progress.baseline(subscriber.name, aggregateType, log.length));
    }
    for (const event of log) {
      const baseline = baselines.get(event.aggregateType);
      if (baseline === undefined || event.position <= baseline) {
        continue;
      }
      if (this.progress.hasFinished(subscriber.name, event.eventId)) {
        continue;
      }
      if (this.progress.isDeadLettered(subscriber.name, event.eventId)) {
        continue;
      }
      this.enqueue(subscriber.name, event);
    }
  }

  private enqueue(subscriber: string, event: StoredEvent): void {
    this.queue.enqueue({ subscriber, event }, { groupKey: deliveryGroupKey(subscriber, event) });
  }

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
