// Criterion 4: each refund returns its units exactly once, however often the work is
// delivered, and returns are told apart by order and refund together.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './harness';

describe('criterion 4: each return happens exactly once', () => {
  it('ignores a redelivery of every event', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('A', [['MUG', 3]]);
    await store.refund('A', 'A-l1', 2, 'r-1');
    await store.settle();
    expect(store.events('StockReturned')).toHaveLength(1);

    store.app.republish();
    await store.settle();

    expect(store.events('StockReturned')).toHaveLength(1);
    expect(store.level('MUG')).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('ignores the refund command repeated under the same or a new idempotency key', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('A', [['MUG', 3]]);
    await store.refund('A', 'A-l1', 2, 'r-1', 'refund-key');
    await store.settle();
    expect(store.events('StockReturned')).toHaveLength(1);
    const eventCount = store.app.store.readAll().length;

    const repeated = await store.run(
      'RefundOrderLine',
      { orderId: 'A', lineId: 'A-l1', quantity: 2, refundId: 'r-1' },
      'refund-key',
    );
    expect(repeated.duplicate).toBe(true);
    await store.refund('A', 'A-l1', 2, 'r-1', 'another-key');
    await store.settle();

    expect(store.app.store.readAll()).toHaveLength(eventCount);
    expect(store.level('MUG')).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('does not return the units again after a restart from the JSON file store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledgerline-restock-'));
    try {
      const path = join(directory, 'events.ndjson');
      const before = openStore({ persistence: { kind: 'json-file', path, durable: false } });
      await before.stock('MUG', 3);
      await before.paidOrder('A', [['MUG', 3]]);
      await before.refund('A', 'A-l1', 2, 'r-1');
      await before.settle();
      expect(before.events('StockReturned')).toHaveLength(1);
      before.app.close();

      const after = openStore({ persistence: { kind: 'json-file', path, durable: false }, clock: before.clock, seed: 99 });
      after.app.republish();
      await after.settle();

      expect(after.events('StockReturned')).toHaveLength(1);
      expect(after.level('MUG')).toEqual({ onHand: 2, reserved: 0, available: 2 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns units for two orders on the same SKU that happen to use the same refund id', async () => {
    const store = openStore();
    await store.stock('MUG', 5);
    await store.paidOrder('A', [['MUG', 2]]);
    await store.paidOrder('B', [['MUG', 3]]);
    expect(store.level('MUG').onHand).toBe(0);

    await store.refund('A', 'A-l1', 1, 'r-1');
    await store.refund('B', 'B-l1', 2, 'r-1');
    await store.settle();

    const returned = store.events('StockReturned');
    expect(returned.every((event) => event.aggregateId === 'MUG')).toBe(true);
    expect(returned.map((event) => event.payload).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toEqual([
      { orderId: 'A', refundId: 'r-1', quantity: 1 },
      { orderId: 'B', refundId: 'r-1', quantity: 2 },
    ]);
    expect(store.level('MUG')).toEqual({ onHand: 3, reserved: 0, available: 3 });
  });
});
