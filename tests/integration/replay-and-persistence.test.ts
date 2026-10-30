import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomerHistoryProjection } from '../../src/orders/customer-history-projection';
import { OrderSummaryProjection } from '../../src/orders/order-summary-projection';
import { DailyRevenueProjection } from '../../src/payments/daily-revenue-projection';
import { StockLevelsProjection } from '../../src/inventory/stock-levels-projection';
import { createUpcasterRegistry } from '../../src/app/ledgerline-commands';
import { InMemorySnapshotStore } from '../../src/shared/snapshots/snapshot-store';
import { ProgressCorruptionError } from '../../src/shared/messaging/subscriber-progress';
import { ProjectionHost } from '../../src/shared/projections/projection';
import { runStoreScenario } from '../support/scenario';
import { createTestApp, placeOrder, readModelState, stockItems } from '../support/test-app';

describe('replaying event streams', () => {
  it('produces the expected read models for the store scenario', async () => {
    const testApp = createTestApp();
    await runStoreScenario(testApp);
    const { orders, stock, revenue, customers } = readModelState(testApp.app);

    expect(orders.map((order) => [order.orderId, order.status, order.totalCents, order.refundedCents])).toEqual([
      ['o-1', 'Delivered', 7_737, 1_821],
      ['o-2', 'Paid', 2_808, 168],
      ['o-3', 'Cancelled', 12_500, 0],
      ['o-4', 'Cancelled', 4_328, 0],
      ['o-5', 'Paid', 0, 0],
    ]);
    expect(orders.find((order) => order.orderId === 'o-4')!.cancellationReason).toBe('reservation-expired');
    expect(stock).toEqual([
      { sku: 'MUG', name: 'mug', onHand: 16, reserved: 0, available: 16 },
      { sku: 'POSTER', name: 'poster', onHand: 1, reserved: 0, available: 1 },
      // 100 − 10 (o-2) − 3 (o-5) + 4 returned by o-2's refund, which was made while Paid.
      { sku: 'STICKER', name: 'sticker', onHand: 91, reserved: 0, available: 91 },
      { sku: 'TEE', name: 'tee', onHand: 5, reserved: 0, available: 5 },
    ]);
    expect(revenue).toEqual([
      { day: '2026-06-01', capturedCents: 10_545, refundedCents: 168, netCents: 10_377, paymentCount: 2, refundCount: 1 },
      { day: '2026-06-02', capturedCents: 0, refundedCents: 1_821, netCents: -1_821, paymentCount: 1, refundCount: 1 },
    ]);
    expect(customers.map((customer) => [customer!.customerId, customer!.orderCount, customer!.lifetimeSpendCents])).toEqual([
      ['alice', 2, 5_916],
      ['bob', 1, 2_640],
      ['carol', 1, 0],
      ['dave', 1, 0],
    ]);
  });

  it('rebuilds every read model from the event store to the state reached live', async () => {
    const testApp = createTestApp();
    await runStoreScenario(testApp);
    const live = readModelState(testApp.app);
    testApp.app.rebuildReadModels();
    expect(readModelState(testApp.app)).toEqual(live);
  });

  it('rebuilds the same read models in fresh projections replaying the raw stream', async () => {
    const testApp = createTestApp();
    await runStoreScenario(testApp);
    const upcasters = createUpcasterRegistry();
    const fresh = {
      orderSummary: new OrderSummaryProjection(),
      stockLevels: new StockLevelsProjection(),
      dailyRevenue: new DailyRevenueProjection(),
      customerHistory: new CustomerHistoryProjection(),
    };
    for (const projection of Object.values(fresh)) {
      new ProjectionHost(projection, upcasters).rebuild(testApp.app.store);
    }
    expect(readModelState({ readModels: fresh } as never)).toEqual(readModelState(testApp.app));
  });

  it('is deterministic: the same inputs produce a byte-identical event log', async () => {
    const first = createTestApp({ seed: 7 });
    const second = createTestApp({ seed: 7 });
    await runStoreScenario(first);
    await runStoreScenario(second);
    expect(JSON.stringify(second.app.store.readAll())).toBe(JSON.stringify(first.app.store.readAll()));
    expect(second.logs.lines).toEqual(first.logs.lines);
  });

  it('reaches the same state with one worker or many', async () => {
    const single = createTestApp({ workers: 1 });
    const pooled = createTestApp({ workers: 8 });
    await runStoreScenario(single);
    await runStoreScenario(pooled);
    expect(readModelState(pooled.app)).toEqual(readModelState(single.app));
  });

  it('reaches the same state with snapshots enabled, and takes them', async () => {
    const snapshotStore = new InMemorySnapshotStore();
    const plain = createTestApp();
    const snapshotted = createTestApp({ snapshots: { enabled: true, interval: 3 }, snapshotStore });
    await runStoreScenario(plain);
    await runStoreScenario(snapshotted);
    expect(readModelState(snapshotted.app)).toEqual(readModelState(plain.app));
    expect(snapshotStore.size).toBeGreaterThan(0);
    expect(snapshotStore.load('order', 'o-1')!.sequence % 3).toBe(0);
  });
});

describe('the JSON file event store', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ledgerline-app-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('restores read models and idempotency after a restart', async () => {
    const path = join(directory, 'events.ndjson');
    const before = createTestApp({ persistence: { kind: 'json-file', path, durable: false } });
    await runStoreScenario(before);
    const state = readModelState(before.app);
    before.app.close();
    const eventCount = readFileSync(path, 'utf8').trimEnd().split('\n').length;
    expect(eventCount).toBe(before.app.store.readAll().length);

    const after = createTestApp({ persistence: { kind: 'json-file', path }, clock: before.clock, seed: 99 });
    expect(readModelState(after.app)).toEqual(state);

    after.app.republish();
    await after.settle();
    expect(after.app.store.readAll()).toHaveLength(eventCount);
    expect(readModelState(after.app)).toEqual(state);

    const shipKey = before.app.store
      .readAll()
      .find((event) => event.type === 'OrderShipped')!.metadata.idempotencyKey!;
    const ship = { type: 'ShipOrder', payload: { orderId: 'o-1', trackingNumber: 'TRK-1' } } as const;
    expect((await after.run(ship, shipKey)).duplicate).toBe(true);
  });

  it('finishes work that was queued but not processed when the service stopped', async () => {
    const path = join(directory, 'events.ndjson');
    const before = createTestApp({ persistence: { kind: 'json-file', path, durable: false } });
    await stockItems(before, { MUG: 5 });
    await placeOrder(before, 'o-1', [['MUG', 2]]);
    expect(before.app.queue.pendingCount).toBeGreaterThan(0);
    before.app.close();

    // The backlog is queued when the built-in processes register, not by republish().
    const after = createTestApp({ persistence: { kind: 'json-file', path }, clock: before.clock, seed: 99 });
    expect(after.app.readModels.orderSummary.get('o-1')).toMatchObject({ status: 'Placed', stockReserved: false });
    expect(after.app.queue.pendingCount).toBeGreaterThan(0);
    await after.settle();
    expect(after.app.readModels.orderSummary.get('o-1')!.stockReserved).toBe(true);
    expect(after.app.readModels.stockLevels.get('MUG')!.reserved).toBe(2);
  });

  it('does not hand a subscriber work it had already finished', async () => {
    const path = join(directory, 'events.ndjson');
    const before = createTestApp({ persistence: { kind: 'json-file', path, durable: false } });
    await stockItems(before, { MUG: 5 });
    await placeOrder(before, 'o-1', [['MUG', 2]]);
    await before.settle();
    const handledBefore = before.app.store.readAll().length;
    await placeOrder(before, 'o-2', [['MUG', 1]]);
    before.app.close();

    const after = createTestApp({ persistence: { kind: 'json-file', path }, clock: before.clock, seed: 99 });
    await after.settle();
    const handled = after.logs
      .entries()
      .filter((entry) => entry['msg'] === 'message.handled' && entry['subscriber'] === 'order-fulfillment')
      .map((entry) => String(entry['aggregateId']));
    expect(handled).not.toContain('o-1');
    expect(handled).toContain('o-2');
    expect(after.app.store.readAll().length).toBeGreaterThan(handledBefore);
    expect(after.app.readModels.stockLevels.get('MUG')!.reserved).toBe(3);
  });

  it('keeps progress beside the log, and keeps none for an in-memory store', async () => {
    const path = join(directory, 'events.ndjson');
    const onDisk = createTestApp({ persistence: { kind: 'json-file', path, durable: false } });
    await stockItems(onDisk, { MUG: 5 });
    await onDisk.settle();
    expect(readdirSync(directory).sort()).toEqual(['events.ndjson', 'events.ndjson.progress.ndjson']);

    const inMemory = createTestApp();
    await stockItems(inMemory, { MUG: 5 });
    await inMemory.settle();
    expect(readdirSync(directory).sort()).toEqual(['events.ndjson', 'events.ndjson.progress.ndjson']);
  });

  it('refuses to start when the progress beside the log cannot be read', async () => {
    const path = join(directory, 'events.ndjson');
    const before = createTestApp({ persistence: { kind: 'json-file', path, durable: false } });
    await stockItems(before, { MUG: 5 });
    await before.settle();

    writeFileSync(`${path}.progress.ndjson`, 'not a progress record\n');
    expect(() => createTestApp({ persistence: { kind: 'json-file', path }, seed: 99 })).toThrow(
      ProgressCorruptionError,
    );
  });
});
