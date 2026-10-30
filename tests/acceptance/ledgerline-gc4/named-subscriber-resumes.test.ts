// Criterion 2: a subscriber added with subscribe() resumes exactly where it stopped, and its
// progress lives in the event log's directory, so a copy of the directory carries it.
import { cpSync } from 'node:fs';
import { openStore, recorder, storedTrail, tempDirectory, trail } from './harness';

describe('criterion 2: a named subscriber resumes where it stopped', () => {
  const temps: Array<ReturnType<typeof tempDirectory>> = [];
  const temp = () => {
    const created = tempDirectory();
    temps.push(created);
    return created.directory;
  };

  afterEach(() => {
    temps.splice(0).forEach((created) => created.remove());
  });

  it('receives exactly the events it had not finished, each once and in stream order', async () => {
    const original = temp();
    const first = openStore(original, { seed: 11 });
    const audit = recorder('audit');
    first.app.subscribe(audit);
    await first.stock('MUG', 5);
    await first.placeOrder('A', [['MUG', 1]]);
    await first.placeOrder('B', [['MUG', 1]]);
    await first.settle();
    const finished = first.app.store.readAll().length;
    expect(trail(audit.received)).toEqual(storedTrail(first.app));

    await first.run('CancelOrder', { orderId: 'A', reason: 'customer-request' }, 'cancel-A');
    await first.run('CreateOrder', { orderId: 'C', customerId: 'customer-C', shippingRegion: 'US-OR' }, 'create-C');
    await first.run('AddOrderLine', { orderId: 'C', sku: 'MUG', quantity: 1, lineId: 'C-l1' }, 'line-C-1');

    const copy = temp();
    cpSync(original, copy, { recursive: true });

    const second = openStore(copy, { seed: 22, clock: first.clock });
    const resumed = recorder('audit');
    second.app.subscribe(resumed);
    await second.settle();

    const expected = storedTrail(second.app, (event) => event.position > finished);
    expect(expected).toEqual(['A#5', 'C#1', 'C#2']);
    const received = trail(resumed.received);
    // Every unfinished event, each once; events appended during this run come after them.
    expect(received.slice(0, expected.length)).toEqual(expected);
    expect(new Set(received).size).toBe(received.length);
    expect(received.filter((entry) => !storedTrail(second.app).includes(entry))).toEqual([]);
    expect(received.filter((entry) => storedTrail(first.app, (event) => event.position <= finished).includes(entry))).toEqual([]);
  });
});
