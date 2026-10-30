// Criterion 5: an event log written before this change replays without inventing stock.
// v1-history.ndjson was written by the service as it was before this task: MUG stocked
// with 5, order "legacy" paid for 3, then 1 unit refunded as a version 1 OrderLineRefunded
// while the order was Paid. Before this rule existed no refund restocked, so on-hand is 2.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock } from '../../../src/shared/clock';
import { StoredEvent } from '../../../src/shared/events/domain-event';
import { openStore, payloadOf } from './harness';

describe('criterion 5: replaying v1 refund history', () => {
  let directory: string;
  let path: string;
  let original: Buffer;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ledgerline-v1-'));
    path = join(directory, 'events.ndjson');
    copyFileSync(join(__dirname, 'v1-history.ndjson'), path);
    original = readFileSync(path);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const open = () =>
    openStore({
      persistence: { kind: 'json-file', path, durable: false },
      clock: new FixedClock('2026-06-01T10:00:00.000Z'),
      seed: 77,
    });

  it('upcasts the stored v1 refund for subscribers without creating stock or rewriting it', async () => {
    const store = open();
    const delivered: StoredEvent[] = [];
    store.app.subscribe({
      name: 'recorder',
      aggregateTypes: ['order'],
      handle: (event) => {
        delivered.push(event);
      },
    });
    store.app.republish();
    await store.settle();

    const upcast = delivered.filter((event) => event.type === 'OrderLineRefunded');
    expect(upcast).toHaveLength(1);
    expect(upcast[0]!.version).toBe(2);
    expect(payloadOf(upcast[0]!)).toMatchObject({ refundId: 'r-legacy-1', returnsToStock: false });

    expect(store.events('StockReturned')).toEqual([]);
    expect(store.level('MUG')).toEqual({ onHand: 2, reserved: 0, available: 2 });

    const stored = store.events('OrderLineRefunded');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.version).toBe(1);
    expect(Object.keys(payloadOf(stored[0]!))).not.toContain('returnsToStock');
    const fixtureLine = original
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as StoredEvent)
      .find((event) => event.type === 'OrderLineRefunded');
    expect(stored[0]).toEqual(fixtureLine);
    expect(readFileSync(path).equals(original)).toBe(true);
  });

  it('returns only the units of a new refund on that still-Paid order', async () => {
    const store = open();
    expect(store.app.readModels.orderSummary.get('legacy')!.status).toBe('Paid');

    await store.refund('legacy', 'legacy-l1', 1, 'r-new');
    await store.settle();

    const returned = store.events('StockReturned');
    expect(returned).toHaveLength(1);
    expect(payloadOf(returned[0]!)).toEqual({ orderId: 'legacy', refundId: 'r-new', quantity: 1 });
    expect(store.level('MUG')).toEqual({ onHand: 3, reserved: 0, available: 3 });
    expect(readFileSync(path).subarray(0, original.length).equals(original)).toBe(true);
  });
});
