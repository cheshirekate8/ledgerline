// Orders are expired, and returned, in the order they were created,
// not the order they were placed in; the seeded event log depends on it.
import { join } from 'node:path';
import { MINUTE, openStore, Store, tempDirectory, TTL } from './harness';

async function createXThenPlaceYFirst(store: Store): Promise<void> {
  await store.stock('MUG', 5);
  for (const orderId of ['X', 'Y']) {
    await store.run('CreateOrder', { orderId, customerId: `customer-${orderId}`, shippingRegion: 'US-OR' }, `${orderId}-create`);
    await store.run('AddOrderLine', { orderId, sku: 'MUG', quantity: 1, lineId: `${orderId}-l1` }, `${orderId}-line`);
  }
  await store.run('PlaceOrder', { orderId: 'Y' }, 'Y-place');
  store.clock.advance(MINUTE);
  await store.run('PlaceOrder', { orderId: 'X' }, 'X-place');
  store.clock.advance(TTL + MINUTE);
}

function expectXThenY(store: Store, expired: string[]): void {
  expect(expired).toEqual(['X', 'Y']);
  const cancelled = store.app.store.readAll().filter((event) => event.type === 'OrderCancelled');
  expect(cancelled.map((event) => event.aggregateId)).toEqual(['X', 'Y']);
  const logged = store.sink.entries().filter((entry) => entry['msg'] === 'order.reservation_expired');
  expect(logged.map((entry) => entry['orderId'])).toEqual(['X', 'Y']);
}

describe('orders expire in creation order', () => {
  it('expires X before Y although Y was placed first', async () => {
    const store = openStore();
    await createXThenPlaceYFirst(store);
    expectXThenY(store, await store.app.expireReservations());
  });

  it('keeps that order after a JSON-file restart', async () => {
    const temp = tempDirectory();
    try {
      const path = join(temp.directory, 'events.ndjson');
      const first = openStore({ jsonFilePath: path, seed: 11 });
      await createXThenPlaceYFirst(first);
      const second = openStore({ jsonFilePath: path, clock: first.clock, seed: 22 });
      expectXThenY(second, await second.app.expireReservations());
    } finally {
      temp.remove();
    }
  });
});
