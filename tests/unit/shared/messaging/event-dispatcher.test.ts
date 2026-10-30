import { FixedClock } from '../../../../src/shared/clock';
import { StoredEvent } from '../../../../src/shared/events/domain-event';
import { InMemoryEventStore } from '../../../../src/shared/events/in-memory-event-store';
import { UpcasterRegistry } from '../../../../src/shared/events/upcaster-registry';
import { SeededIdGenerator } from '../../../../src/shared/ids';
import {
  EventDelivery,
  EventDispatcher,
  EventSubscriber,
  UnknownSubscriberError,
} from '../../../../src/shared/messaging/event-dispatcher';
import { InProcessQueue } from '../../../../src/shared/messaging/in-process-queue';
import { newEvent } from '../../../support/counter';

function recorder(name: string, aggregateTypes: string[]): EventSubscriber & { seen: StoredEvent[] } {
  const seen: StoredEvent[] = [];
  return { name, aggregateTypes, seen, handle: (event) => void seen.push(event) };
}

function setup() {
  const store = new InMemoryEventStore();
  const queue = new InProcessQueue<EventDelivery>({ clock: new FixedClock(0), ids: new SeededIdGenerator(8) });
  const upcasters = new UpcasterRegistry().declareAll(['Placed', 'Moved']);
  const dispatcher = new EventDispatcher(store, queue, upcasters);
  return { store, queue, upcasters, dispatcher };
}

async function deliverAll(queue: InProcessQueue<EventDelivery>, dispatcher: EventDispatcher) {
  for (let lease = queue.lease(); lease; lease = queue.lease()) {
    await dispatcher.deliver(lease.message.body);
    queue.ack(lease.leaseId);
  }
}

describe('EventDispatcher', () => {
  it('enqueues one delivery per interested subscriber for each appended event', async () => {
    const { store, queue, dispatcher } = setup();
    const orders = recorder('orders-view', ['order']);
    const everything = recorder('audit', ['order', 'stock']);
    const stockOnly = recorder('stock-view', ['stock']);
    dispatcher.register(orders).register(everything).register(stockOnly);
    dispatcher.start();

    store.append('order', 'o-1', 0, [newEvent('Placed')]);
    store.append('stock', 's-1', 0, [newEvent('Moved')]);
    expect(queue.pendingCount).toBe(4);

    await deliverAll(queue, dispatcher);
    expect(orders.seen.map((e) => e.type)).toEqual(['Placed']);
    expect(everything.seen.map((e) => e.type)).toEqual(['Placed', 'Moved']);
    expect(stockOnly.seen.map((e) => e.type)).toEqual(['Moved']);
  });

  it('groups deliveries by subscriber and aggregate so each stream stays ordered', () => {
    const { store, queue, dispatcher } = setup();
    dispatcher.register(recorder('view', ['order']));
    dispatcher.start();
    store.append('order', 'o-1', 0, [newEvent('Placed'), newEvent('Moved')]);
    store.append('order', 'o-2', 0, [newEvent('Placed')]);

    const first = queue.lease()!;
    const second = queue.lease()!;
    expect([first.message.body.event.aggregateId, second.message.body.event.aggregateId]).toEqual(['o-1', 'o-2']);
    expect(first.message.groupKey).toBe('view|order:o-1');
    expect(queue.lease()).toBeUndefined();
  });

  it('stops forwarding events once stopped', () => {
    const { store, queue, dispatcher } = setup();
    dispatcher.register(recorder('view', ['order']));
    dispatcher.start();
    dispatcher.start();
    dispatcher.stop();
    store.append('order', 'o-1', 0, [newEvent('Placed')]);
    expect(queue.pendingCount).toBe(0);
  });

  it('upcasts events before handing them to subscribers', async () => {
    const store = new InMemoryEventStore();
    const queue = new InProcessQueue<EventDelivery>({ clock: new FixedClock(0), ids: new SeededIdGenerator(8) });
    const upcasters = new UpcasterRegistry()
      .declare('Placed', 2)
      .register({ type: 'Placed', fromVersion: 1, upcast: () => ({ upgraded: true }) });
    const dispatcher = new EventDispatcher(store, queue, upcasters);
    const view = recorder('view', ['order']);
    dispatcher.register(view);
    dispatcher.start();
    store.append('order', 'o-1', 0, [newEvent('Placed')]);

    await deliverAll(queue, dispatcher);
    expect(view.seen[0]).toMatchObject({ version: 2, payload: { upgraded: true } });
  });

  it('rejects duplicate subscriber names and unknown deliveries', async () => {
    const { dispatcher } = setup();
    dispatcher.register(recorder('view', ['order']));
    expect(() => dispatcher.register(recorder('view', ['order']))).toThrow(/already registered/);
    await expect(
      dispatcher.deliver({ subscriber: 'ghost', event: {} as StoredEvent }),
    ).rejects.toBeInstanceOf(UnknownSubscriberError);
  });

  it('describes deliveries for logging', () => {
    const { store, queue, dispatcher } = setup();
    dispatcher.register(recorder('view', ['order']));
    dispatcher.start();
    store.append('order', 'o-1', 0, [newEvent('Placed')]);
    expect(EventDispatcher.describe(queue.lease()!.message.body)).toMatchObject({
      subscriber: 'view',
      eventType: 'Placed',
      eventVersion: 1,
      aggregateType: 'order',
      aggregateId: 'o-1',
      sequence: 1,
    });
  });
});
