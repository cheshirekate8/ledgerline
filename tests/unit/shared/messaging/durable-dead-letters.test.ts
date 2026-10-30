import { StoredEvent } from '../../../../src/shared/events/domain-event';
import { DurableDeadLetterQueue } from '../../../../src/shared/messaging/durable-dead-letters';
import { EventDelivery } from '../../../../src/shared/messaging/event-dispatcher';
import { DeadLetter } from '../../../../src/shared/messaging/message';
import { DeadLetterProgress, SubscriberProgress } from '../../../../src/shared/messaging/subscriber-progress';

const EVENT = {
  eventId: 'evt-1',
  type: 'OrderPlaced',
  version: 1,
  aggregateType: 'order',
  aggregateId: 'A',
  sequence: 3,
  position: 3,
  occurredAt: '2026-01-01T00:00:00.000Z',
  payload: {},
  metadata: {},
} as StoredEvent;

/** Progress that only remembers what it is told, so the queue can be exercised alone. */
function progressSpy(initial: DeadLetterProgress[] = []): SubscriberProgress & { recorded: DeadLetterProgress[] } {
  const recorded: DeadLetterProgress[] = [];
  return {
    recorded,
    baseline: (_subscriber, _aggregateType, logLength) => logLength,
    hasFinished: () => false,
    isDeadLettered: () => false,
    recordFinished: () => undefined,
    recordDeadLettered: (entry) => void recorded.push(entry),
    deadLetters: () => initial,
  };
}

function entry(): DeadLetter<EventDelivery> {
  const body: EventDelivery = { subscriber: 'audit', event: EVENT };
  return {
    message: { id: 'msg-7', groupKey: 'audit|order:A', body, deliveryCount: 3, enqueuedAt: 100, availableAt: 150 },
    error: 'sink down',
    deadLetteredAt: 200,
  };
}

describe('DurableDeadLetterQueue', () => {
  it('records each new entry in the subscriber progress', () => {
    const progress = progressSpy();
    new DurableDeadLetterQueue(progress).add(entry());
    expect(progress.recorded).toEqual([
      {
        subscriber: 'audit',
        eventId: 'evt-1',
        messageId: 'msg-7',
        error: 'sink down',
        deliveryCount: 3,
        enqueuedAt: 100,
        deadLetteredAt: 200,
      },
    ]);
  });

  it('lists an entry recorded before a restart, keeping its message id', () => {
    const queue = new DurableDeadLetterQueue(progressSpy([recordedEntry()]));
    queue.restore([EVENT]);
    const [restored] = queue.list();
    expect(restored!.message.id).toBe('msg-7');
    expect(restored!.message.groupKey).toBe('audit|order:A');
    expect(restored!.message.body).toEqual({ subscriber: 'audit', event: EVENT });
    expect(restored!.error).toBe('sink down');
    expect(restored!.deadLetteredAt).toBe(200);
    expect(queue.get('msg-7')).toBe(restored);
  });

  it('does not record what it restored a second time', () => {
    const progress = progressSpy([recordedEntry()]);
    new DurableDeadLetterQueue(progress).restore([EVENT]);
    expect(progress.recorded).toEqual([]);
  });
});

function recordedEntry(): DeadLetterProgress {
  return {
    subscriber: 'audit',
    eventId: 'evt-1',
    messageId: 'msg-7',
    error: 'sink down',
    deliveryCount: 3,
    enqueuedAt: 100,
    deadLetteredAt: 200,
  };
}
