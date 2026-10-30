// Criterion 1: the built-in fulfillment and payment processes finish work that was queued
// when the process stopped, without republish(), and never redo work they had finished.
import { StoredEvent } from '../../../src/shared/events/domain-event';
import { FULFILLMENT, openStore, PAYMENTS, Store, tempDirectory } from './harness';

/** Each handled line's event, looked up in the store by id. */
function handledEvents(store: Store, subscriber: string): StoredEvent[] {
  const byId = new Map(store.app.store.readAll().map((event) => [event.eventId, event]));
  return store.outcomes('message.handled', subscriber).map((entry) => byId.get(String(entry['eventId']))!);
}

describe('criterion 1: built-in processes resume after a restart', () => {
  let temp: ReturnType<typeof tempDirectory>;

  beforeEach(() => {
    temp = tempDirectory();
  });

  afterEach(() => {
    temp.remove();
  });

  it('reserves stock for an order placed but not processed before the restart', async () => {
    const first = openStore(temp.directory, { seed: 11 });
    await first.stock('MUG', 5);
    await first.placeOrder('A', [['MUG', 1]]);
    await first.settle();
    const finished = first.app.store.readAll().length;
    await first.placeOrder('B', [['MUG', 2]]);
    const written = first.app.store.readAll().length;
    expect(first.app.queue.pendingCount).toBeGreaterThan(0);

    const second = openStore(temp.directory, { seed: 22, clock: first.clock });
    await second.settle();

    expect(second.app.readModels.orderSummary.get('B')!.stockReserved).toBe(true);
    expect(second.app.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 5, reserved: 3, available: 2 });

    const handled = handledEvents(second, FULFILLMENT);
    expect(handled.length).toBeGreaterThan(0);
    // Nothing finished before the restart is handled again.
    expect(handled.filter((event) => event.position <= finished)).toEqual([]);
    expect(handled.filter((event) => event.aggregateId === 'A')).toEqual([]);
    // Every order event left unfinished is handled exactly once.
    const unfinished = second.app.store
      .readAll()
      .filter((event) => event.aggregateType === 'order' && event.position > finished && event.position <= written);
    expect(unfinished.length).toBeGreaterThan(0);
    for (const event of unfinished) {
      expect(handled.filter((other) => other.eventId === event.eventId)).toHaveLength(1);
    }
  });

  it('marks an order paid when its payment was captured but not processed before the restart', async () => {
    const first = openStore(temp.directory, { seed: 11 });
    await first.stock('MUG', 5);
    await first.placeOrder('B', [['MUG', 2]]);
    await first.settle();
    const finished = first.app.store.readAll().length;
    await first.run('CapturePayment', { paymentId: 'pay-B', orderId: 'B', amountCents: 2000, method: 'card' }, 'pay-B');
    expect(first.app.readModels.orderSummary.get('B')!.status).toBe('Placed');

    const second = openStore(temp.directory, { seed: 22, clock: first.clock });
    await second.settle();

    expect(second.app.readModels.orderSummary.get('B')!.status).toBe('Paid');
    const handled = handledEvents(second, PAYMENTS);
    expect(handled.filter((event) => event.position <= finished)).toEqual([]);
    expect(handled.filter((event) => event.type === 'PaymentCaptured')).toHaveLength(1);
  });
});
