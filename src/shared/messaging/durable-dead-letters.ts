import { StoredEvent } from '../events/domain-event';
import { DeadLetterQueue } from './dead-letter-queue';
import { deliveryGroupKey, EventDelivery } from './event-dispatcher';
import { DeadLetter } from './message';
import { DeadLetterProgress, SubscriberProgress } from './subscriber-progress';

/**
 * A dead-letter queue whose entries survive a restart. Each entry is recorded
 * in the subscriber's progress as it arrives and listed again from the moment
 * the store is reopened, keeping its message id so a redrive by an id noted
 * before the restart still names it (DESIGN §6.2).
 */
export class DurableDeadLetterQueue extends DeadLetterQueue<EventDelivery> {
  constructor(private readonly progress: SubscriberProgress) {
    super();
  }

  override add(entry: DeadLetter<EventDelivery>): void {
    super.add(entry);
    const { message } = entry;
    this.progress.recordDeadLettered({
      subscriber: message.body.subscriber,
      eventId: message.body.event.eventId,
      messageId: message.id,
      error: entry.error,
      deliveryCount: message.deliveryCount,
      enqueuedAt: message.enqueuedAt,
      deadLetteredAt: entry.deadLetteredAt,
    });
  }

  /** Lists what was dead-lettered before the restart, without recording it again. */
  restore(events: readonly StoredEvent[]): void {
    const byId = new Map(events.map((event) => [event.eventId, event]));
    for (const record of this.progress.deadLetters()) {
      const event = byId.get(record.eventId);
      if (event) {
        super.add(toDeadLetter(record, event));
      }
    }
  }
}

function toDeadLetter(record: DeadLetterProgress, event: StoredEvent): DeadLetter<EventDelivery> {
  const body: EventDelivery = { subscriber: record.subscriber, event };
  return {
    message: Object.freeze({
      id: record.messageId,
      groupKey: deliveryGroupKey(record.subscriber, event),
      body,
      deliveryCount: record.deliveryCount,
      enqueuedAt: record.enqueuedAt,
      availableAt: record.deadLetteredAt,
      lastError: record.error,
    }),
    error: record.error,
    deadLetteredAt: record.deadLetteredAt,
  };
}
