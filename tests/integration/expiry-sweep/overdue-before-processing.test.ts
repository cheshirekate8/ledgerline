// An order placed and already overdue is expired even if messages were never
// processed, so candidates cannot come from a read model that lags behind.
import { expectWithinReadBound, openStore, TTL } from './harness';

describe('overdue before any processing', () => {
  it('expires the order and, once processed, releases its stock', async () => {
    const store = openStore();
    await store.stock('MUG', 5);
    await store.settle();
    await store.place('A', 2);
    store.clock.advance(TTL);

    const before = store.app.store.readAll().length;
    const sweep = await store.sweep();
    expect(sweep.expired).toEqual(['A']);
    expectWithinReadBound(sweep);
    const appended = store.app.store.readAll().slice(before);
    expect(appended.map((event) => [event.aggregateId, event.type, event.payload])).toEqual([
      ['A', 'OrderCancelled', { reason: 'reservation-expired' }],
    ]);

    await store.settle();
    expect(store.app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 5, reserved: 0, available: 5 });
  });
});
