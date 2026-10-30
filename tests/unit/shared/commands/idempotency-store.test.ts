import { CommandBus } from '../../../../src/shared/commands/command-bus';
import {
  hydrateIdempotencyStore,
  InMemoryIdempotencyStore,
} from '../../../../src/shared/commands/idempotency-store';
import { InMemoryEventStore } from '../../../../src/shared/events/in-memory-event-store';
import { newEvent } from '../../../support/counter';

describe('InMemoryIdempotencyStore', () => {
  it('stores and returns records by key', () => {
    const store = new InMemoryIdempotencyStore();
    const record = { key: 'k', commandType: 'X', fingerprint: 'f', aggregateId: 'a', version: 2, eventIds: ['e'] };
    store.put(record);
    expect(store.get('k')).toEqual(record);
    expect(store.get('other')).toBeUndefined();
    expect(Object.isFrozen(store.get('k'))).toBe(true);
  });
});

describe('hydrateIdempotencyStore', () => {
  it('rebuilds one record per idempotency key from event metadata', () => {
    const events = new InMemoryEventStore();
    const metadata = { idempotencyKey: 'k-1', commandType: 'Place', commandFingerprint: 'fp-1' };
    events.append('order', 'o-1', 0, [newEvent('A', {}, { metadata }), newEvent('B', {}, { metadata })]);
    events.append('order', 'o-2', 0, [newEvent('C', {}, { metadata: {} })]);

    const store = new InMemoryIdempotencyStore();
    expect(hydrateIdempotencyStore(events, store)).toBe(1);
    expect(store.get('k-1')).toEqual({
      key: 'k-1',
      commandType: 'Place',
      fingerprint: 'fp-1',
      aggregateId: 'o-1',
      version: 2,
      eventIds: events.readStream('order', 'o-1').map((e) => e.eventId),
    });
  });

  it('lets a command bus recognise work done before a restart', async () => {
    const events = new InMemoryEventStore();
    const bus = new CommandBus();
    const handler = jest.fn(async (_command: unknown, context: { metadata: object }) => {
      const stored = events.append('order', 'o-1', events.currentSequence('order', 'o-1'), [
        newEvent('Placed', {}, { metadata: context.metadata }),
      ]);
      return { aggregateId: 'o-1', version: stored[0]!.sequence, events: stored };
    });
    bus.register('Place', handler);
    await bus.execute({ type: 'Place', idempotencyKey: 'k-1', payload: {} });

    const restartedStore = new InMemoryIdempotencyStore();
    hydrateIdempotencyStore(events, restartedStore);
    const restarted = new CommandBus({ idempotency: restartedStore });
    restarted.register('Place', handler);
    const result = await restarted.execute({ type: 'Place', idempotencyKey: 'k-1', payload: {} });

    expect(result.duplicate).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
