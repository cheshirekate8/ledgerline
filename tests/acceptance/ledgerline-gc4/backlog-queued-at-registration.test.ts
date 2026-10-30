// Criterion 3: a subscriber's unfinished backlog is queued when it is registered, so an
// event appended before the first processMessages() cannot overtake it.
import { openStore, recorder, storedTrail, tempDirectory, trail } from './harness';

describe('criterion 3: the backlog is queued at registration', () => {
  let temp: ReturnType<typeof tempDirectory>;

  beforeEach(() => {
    temp = tempDirectory();
  });

  afterEach(() => {
    temp.remove();
  });

  it('delivers old unfinished events before an event appended after the restart', async () => {
    const first = openStore(temp.directory, { seed: 11 });
    first.app.subscribe(recorder('audit'));
    await first.stock('MUG', 5);
    await first.settle();
    await first.run('CreateOrder', { orderId: 'A', customerId: 'customer-A', shippingRegion: 'US-OR' }, 'create-A');
    await first.run('AddOrderLine', { orderId: 'A', sku: 'MUG', quantity: 1, lineId: 'A-l1' }, 'line-A-1');

    const second = openStore(temp.directory, { seed: 22, clock: first.clock });
    const audit = recorder('audit');
    second.app.subscribe(audit);
    await second.run('PlaceOrder', { orderId: 'A' }, 'place-A');
    await second.settle();

    const received = trail(audit.received);
    expect(received.slice(0, 3)).toEqual(['A#1', 'A#2', 'A#3']);
    expect(received).toEqual(storedTrail(second.app));
    expect(second.outcomes('message.dead_lettered')).toEqual([]);
  });
});
