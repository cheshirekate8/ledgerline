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
import { DeadLetterProgress, SubscriberProgress } from '../../../../src/shared/messaging/subscriber-progress';
import { newEvent } from '../../../support/counter';

function recorder(name: string, aggregateTypes: string[]): EventSubscriber & { seen: StoredEvent[] } {
  const seen: StoredEvent[] = [];
  return { name, aggregateTypes, seen, handle: (event) => void seen.push(event) };
}

/** Progress kept in memory, so the dispatcher's use of it can be inspected directly. */
class FakeProgress implements SubscriberProgress {
  readonly baselines = new Map<string, number>();
  readonly finished = new Set<string>();
  readonly dead = new Set<string>();

  baseline(subscriber: string, aggregateType: string, logLength: number): number {
    const key = `${subscriber} ${aggregateType}`;
    const known = this.baselines.get(key);
    if (known !== undefined) {
      return known;
    }
    this.baselines.set(key, logLength);
    return logLength;
  }

  hasFinished(subscriber: string, eventId: string): boolean {
    return this.finished.has(`${subscriber} ${eventId}`);
  }

  isDeadLettered(subscriber: string, eventId: string): boolean {
    return this.dead.has(`${subscriber} ${eventId}`);
  }

  recordFinished(subscriber: string, eventId: string): void {
    this.finished.add(`${subscriber} ${eventId}`);
  }

  recordDeadLettered(_entry: DeadLetterProgress): void {
    return undefined;
  }

  deadLetters(): readonly DeadLetterProgress[] {
    return [];
  }
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

  it('queues nothing at registration when the store keeps no progress', () => {
    const { store, queue, dispatcher } = setup();
    store.append('order', 'o-1', 0, [newEvent('Placed')]);
    dispatcher.register(recorder('view', ['order']));
    expect(queue.pendingCount).toBe(0);
  });

  describe('with durable subscriber progress', () => {
    const resumeSetup = () => {
      const store = new InMemoryEventStore();
      const queue = new InProcessQueue<EventDelivery>({ clock: new FixedClock(0), ids: new SeededIdGenerator(8) });
      const upcasters = new UpcasterRegistry().declareAll(['Placed', 'Moved']);
      const progress = new FakeProgress();
      return { store, queue, progress, dispatcher: new EventDispatcher(store, queue, upcasters, progress) };
    };
    const queued = (queue: InProcessQueue<EventDelivery>) => {
      const seen: string[] = [];
      for (let lease = queue.lease(); lease; lease = queue.lease()) {
        const { event } = lease.message.body;
        seen.push(`${event.aggregateId}#${event.sequence}`);
        queue.ack(lease.leaseId);
      }
      return seen;
    };

    it('queues every unfinished event at registration, in stream order', () => {
      const { store, queue, progress, dispatcher } = resumeSetup();
      progress.baselines.set('view order', 0);
      store.append('order', 'o-1', 0, [newEvent('Placed'), newEvent('Moved')]);
      store.append('order', 'o-2', 0, [newEvent('Placed')]);
      progress.finished.add(`view ${store.readAll()[0]!.eventId}`);

      dispatcher.register(recorder('view', ['order']));
      expect(queued(queue)).toEqual(['o-1#2', 'o-2#1']);
    });

    it('leaves dead letters out of the backlog and an unknown name at the end of the log', () => {
      const { store, queue, progress, dispatcher } = resumeSetup();
      progress.baselines.set('view order', 0);
      store.append('order', 'o-1', 0, [newEvent('Placed'), newEvent('Moved')]);
      progress.dead.add(`view ${store.readAll()[0]!.eventId}`);

      dispatcher.register(recorder('view', ['order']));
      dispatcher.register(recorder('newcomer', ['order']));
      expect(queued(queue)).toEqual(['o-1#2']);
      expect(progress.baselines.get('newcomer order')).toBe(2);
    });

    it('records progress only once a resuming handler has succeeded', async () => {
      const { store, queue, progress, dispatcher } = resumeSetup();
      const failing: EventSubscriber = {
        name: 'flaky',
        aggregateTypes: ['order'],
        handle: () => {
          throw new Error('sink down');
        },
      };
      dispatcher.register(recorder('view', ['order'])).register(failing).register(recorder('model', ['order']), {
        resume: false,
      });
      dispatcher.start();
      store.append('order', 'o-1', 0, [newEvent('Placed')]);
      const eventId = store.readAll()[0]!.eventId;

      await expect(dispatcher.deliver({ subscriber: 'flaky', event: store.readAll()[0]! })).rejects.toThrow('sink down');
      await dispatcher.deliver({ subscriber: 'view', event: store.readAll()[0]! });
      await dispatcher.deliver({ subscriber: 'model', event: store.readAll()[0]! });

      expect(progress.finished).toEqual(new Set([`view ${eventId}`]));
      expect(queue.pendingCount).toBeGreaterThan(0);
    });
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
