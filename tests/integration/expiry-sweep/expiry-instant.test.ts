// Expiry includes the exact instant of an order's recorded expiry.
import { openStore, TTL } from './harness';

describe('expiry includes the exact instant', () => {
  it('expires nothing one millisecond early and both orders exactly on time', async () => {
    const store = openStore();
    await store.stock('MUG', 5);
    await store.settle();
    await store.place('reserved');
    await store.settle();
    await store.place('unprocessed');
    expect(store.app.readModels.orderSummary.get('reserved')!.stockReserved).toBe(true);

    store.clock.advance(TTL - 1);
    const before = store.app.store.readAll().length;
    expect(await store.app.expireReservations()).toEqual([]);
    expect(store.app.store.readAll()).toHaveLength(before);

    store.clock.advance(1);
    expect(await store.app.expireReservations()).toEqual(['reserved', 'unprocessed']);
  });
});
