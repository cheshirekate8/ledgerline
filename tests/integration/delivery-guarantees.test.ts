import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderSummaryProjection } from '../../src/orders/order-summary-projection';
import { createUpcasterRegistry } from '../../src/app/ledgerline-commands';
import { FixedClock } from '../../src/shared/clock';
import { StoredEvent } from '../../src/shared/events/domain-event';
import { ProjectionHost } from '../../src/shared/projections/projection';
import { runStoreScenario } from '../support/scenario';
import { createTestApp, placeOrder, readModelState, stockItems } from '../support/test-app';

class LateOrderSummary extends OrderSummaryProjection {
  override readonly name = 'late-order-summary';
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('at-least-once delivery', () => {
  it('changes nothing when every event is delivered to every subscriber a second time', async () => {
    const testApp = createTestApp();
    await runStoreScenario(testApp);
    const state = readModelState(testApp.app);
    const events = testApp.app.store.readAll().length;

    expect(testApp.app.republish()).toBe(events);
    const report = await testApp.settle();

    expect(report.handled).toBeGreaterThan(events);
    expect(report).toMatchObject({ retried: 0, deadLettered: 0 });
    expect(testApp.app.store.readAll()).toHaveLength(events);
    expect(readModelState(testApp.app)).toEqual(state);
  });

  it('changes nothing when a command is delivered twice under the same key', async () => {
    const testApp = createTestApp();
    await stockItems(testApp, { MUG: 10 });
    const receive = { type: 'ReceiveStock', payload: { sku: 'MUG', quantity: 5 } } as const;
    const first = await testApp.run(receive, 'delivery-123');
    const second = await testApp.run(receive, 'delivery-123');
    await testApp.settle();
    expect(second).toEqual({ ...first, duplicate: true });
    expect(testApp.app.readModels.stockLevels.get('MUG')!.onHand).toBe(15);
  });

  it('retries a failing subscriber with backoff, logging each retry, without disturbing the others', async () => {
    const testApp = createTestApp();
    let failures = 2;
    const seen: string[] = [];
    testApp.app.subscribe({
      name: 'flaky-audit',
      aggregateTypes: ['order'],
      handle: (event: StoredEvent) => {
        if (event.type === 'OrderPlaced' && failures > 0) {
          failures -= 1;
          throw new Error('audit sink unavailable');
        }
        seen.push(event.type);
      },
    });
    await stockItems(testApp, { MUG: 10 });
    await placeOrder(testApp, 'o-1', [['MUG', 1]]);
    const report = await testApp.settle();

    expect(report.retried).toBe(2);
    expect(report.deadLettered).toBe(0);
    expect(seen).toEqual(['OrderCreated', 'OrderLineAdded', 'OrderPlaced', 'OrderStockReserved']);
    const retries = testApp.logs.entries().filter((entry) => entry['msg'] === 'message.retry_scheduled');
    expect(retries.map((entry) => [entry['attempt'], entry['delayMs'], entry['subscriber']])).toEqual([
      [1, 100, 'flaky-audit'],
      [2, 200, 'flaky-audit'],
    ]);
    expect(testApp.app.readModels.orderSummary.get('o-1')!.stockReserved).toBe(true);
  });

  it('dead-letters a delivery that keeps failing, and redrives it once fixed', async () => {
    const testApp = createTestApp();
    let broken = true;
    const seen: string[] = [];
    testApp.app.subscribe({
      name: 'mailer',
      aggregateTypes: ['order'],
      handle: (event: StoredEvent) => {
        if (event.type === 'OrderPlaced' && broken) {
          throw new Error('template missing');
        }
        seen.push(event.type);
      },
    });
    await stockItems(testApp, { MUG: 10 });
    await placeOrder(testApp, 'o-1', [['MUG', 1]]);
    const report = await testApp.settle();

    expect(report.deadLettered).toBe(1);
    const [deadLetter] = testApp.app.deadLetters.list();
    expect(deadLetter).toMatchObject({ error: 'template missing', message: { deliveryCount: 3 } });
    expect(testApp.logs.entries().filter((entry) => entry['msg'] === 'message.dead_lettered')).toEqual([
      expect.objectContaining({ level: 'error', subscriber: 'mailer', eventType: 'OrderPlaced', attempt: 3 }),
    ]);
    // A dead letter no longer holds back its group; sequence-checking consumers catch the gap.
    expect(seen).toEqual(['OrderCreated', 'OrderLineAdded', 'OrderStockReserved']);

    broken = false;
    expect(testApp.app.redrive(deadLetter!.message.id)).toBe(true);
    await testApp.settle();
    expect(seen).toEqual(['OrderCreated', 'OrderLineAdded', 'OrderStockReserved', 'OrderPlaced']);
    expect(testApp.app.deadLetters.size).toBe(0);
  });

  it('holds back later events of an aggregate while an earlier one is being retried', async () => {
    const testApp = createTestApp();
    let failures = 1;
    const seen: string[] = [];
    testApp.app.subscribe({
      name: 'ordered',
      aggregateTypes: ['order'],
      handle: (event: StoredEvent) => {
        if (event.type === 'OrderLineAdded' && failures > 0) {
          failures -= 1;
          throw new Error('transient');
        }
        seen.push(`${event.aggregateId}#${event.sequence}`);
      },
    });
    await stockItems(testApp, { MUG: 10 });
    await placeOrder(testApp, 'o-1', [['MUG', 1]]);
    await testApp.settle();
    expect(seen).toEqual(['o-1#1', 'o-1#2', 'o-1#3', 'o-1#4']);
  });
});

describe('resuming after a restart', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ledgerline-resume-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** A subscriber over a JSON-file log in `directory`, with a `seed` of its own. */
  const open = (seed: number, clock?: FixedClock) => {
    const path = join(directory, 'events.ndjson');
    const testApp = createTestApp({
      seed,
      persistence: { kind: 'json-file', path, durable: false },
      ...(clock === undefined ? {} : { clock }),
    });
    const seen: string[] = [];
    let broken = false;
    testApp.app.subscribe({
      name: 'mailer',
      aggregateTypes: ['order'],
      handle: (event: StoredEvent) => {
        if (broken) {
          throw new Error('template missing');
        }
        seen.push(`${event.aggregateId}#${event.sequence}`);
      },
    });
    return { ...testApp, seen, break: (value: boolean) => void (broken = value) };
  };

  it('gives a named subscriber exactly what it had not finished, in stream order', async () => {
    const before = open(42);
    await stockItems(before, { MUG: 10 });
    await placeOrder(before, 'o-1', [['MUG', 1]]);
    await before.settle();
    expect(before.seen).toEqual(['o-1#1', 'o-1#2', 'o-1#3', 'o-1#4']);
    await before.run({ type: 'CancelOrder', payload: { orderId: 'o-1', reason: 'customer-request' } }, 'cancel-1');

    const after = open(99, before.clock);
    await after.settle();
    expect(after.seen).toEqual(['o-1#5']);
  });

  it('keeps a dead letter dead, with its id, until it is redriven', async () => {
    const before = open(42);
    before.break(true);
    await stockItems(before, { MUG: 10 });
    await before.run({ type: 'CreateOrder', payload: { orderId: 'o-1', customerId: 'alice', shippingRegion: 'US-CA' } });
    await before.settle();
    const messageId = before.app.deadLetters.list()[0]!.message.id;
    expect(before.app.deadLetters.size).toBe(1);

    const after = open(99, before.clock);
    const [restored] = after.app.deadLetters.list();
    expect(restored!.message.id).toBe(messageId);
    expect(restored).toMatchObject({ error: 'template missing', message: { body: { subscriber: 'mailer' } } });

    // A dead letter waits for a redrive; it is never retried on its own.
    await after.settle();
    expect(after.seen).toEqual([]);
    expect(after.app.redrive(messageId)).toBe(true);
    await after.settle();
    expect(after.seen).toEqual(['o-1#1']);

    // Having succeeded, it counts as finished and is not delivered again.
    const later = open(123, after.clock);
    await later.settle();
    expect(later.app.deadLetters.list()).toEqual([]);
    expect(later.seen).toEqual([]);
  });
});

describe('out-of-order detection', () => {
  it('refuses to apply an event whose predecessors it never saw, until rebuilt', async () => {
    const testApp = createTestApp();
    await stockItems(testApp, { MUG: 10 });
    await placeOrder(testApp, 'o-1', [['MUG', 1]]);
    await testApp.settle();

    const lateHost = new ProjectionHost(new LateOrderSummary(), createUpcasterRegistry());
    testApp.app.subscribe(lateHost);
    await testApp.run({ type: 'CancelOrder', payload: { orderId: 'o-1', reason: 'customer-request' } });
    await testApp.settle();

    const [deadLetter] = testApp.app.deadLetters.list();
    expect(deadLetter!.error).toBe('Event for order:o-1 has sequence 5, expected 1');
    expect(lateHost.projection.get('o-1')).toBeUndefined();

    lateHost.rebuild(testApp.app.store);
    testApp.app.redrive(deadLetter!.message.id);
    await testApp.settle();
    expect(lateHost.projection.get('o-1')).toEqual(testApp.app.readModels.orderSummary.get('o-1'));
  });
});

describe('worker pool concurrency', () => {
  it('processes independent aggregates concurrently up to the configured limit', async () => {
    const testApp = createTestApp({ workers: 3 });
    let active = 0;
    let peak = 0;
    testApp.app.subscribe({
      name: 'slow-observer',
      aggregateTypes: ['order'],
      handle: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        active -= 1;
      },
    });
    await stockItems(testApp, { MUG: 50 });
    for (let i = 1; i <= 6; i += 1) {
      await placeOrder(testApp, `o-${i}`, [['MUG', 1]], { customerId: `c-${i}` });
    }
    await testApp.settle();
    expect(peak).toBe(3);
    expect(testApp.app.readModels.orderSummary.withStatus('Placed')).toHaveLength(6);
    expect(testApp.app.readModels.stockLevels.get('MUG')!.reserved).toBe(6);
  });
});
