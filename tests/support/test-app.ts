import { createLedgerline, Ledgerline } from '../../src/app/ledgerline';
import { LedgerlineCommand } from '../../src/app/ledgerline-commands';
import { LedgerlineOptions } from '../../src/app/ledgerline-options';
import { FixedClock } from '../../src/shared/clock';
import { SeededIdGenerator } from '../../src/shared/ids';
import { JsonLogger, MemoryLogSink } from '../../src/shared/logger';
import { DrainReport } from '../../src/shared/messaging/worker-pool';
import { TEST_CATALOG_CONFIG } from './catalog';
import { START_TIME } from './dependencies';

export interface TestApp {
  app: Ledgerline;
  clock: FixedClock;
  logs: MemoryLogSink;
  run(command: Omit<LedgerlineCommand, 'idempotencyKey'>, idempotencyKey?: string): ReturnType<Ledgerline['execute']>;
  settle(): Promise<DrainReport>;
}

/** A fully deterministic Ledgerline: fixed clock, seeded ids, captured logs. */
export function createTestApp(overrides: Partial<LedgerlineOptions> & { seed?: number } = {}): TestApp {
  const { seed = 42, ...options } = overrides;
  const clock = (options.clock as FixedClock | undefined) ?? new FixedClock(START_TIME);
  const logs = new MemoryLogSink();
  const app = createLedgerline({
    catalog: TEST_CATALOG_CONFIG,
    clock,
    ids: new SeededIdGenerator(seed),
    logger: new JsonLogger({ sink: logs.write, clock, level: 'debug' }),
    retry: { maxAttempts: 3, backoff: { kind: 'exponential', initialDelayMs: 100, multiplier: 2, maxDelayMs: 1_000 } },
    ...options,
  });
  let key = 0;
  return {
    app,
    clock,
    logs,
    run: (command, idempotencyKey) =>
      app.execute({ ...command, idempotencyKey: idempotencyKey ?? `cmd-${(key += 1)}` } as LedgerlineCommand),
    settle: () => settle(app, clock),
  };
}

/**
 * Processes messages until the queue is empty, moving the fixed clock
 * forward through any retry backoff that is in the way.
 */
export async function settle(app: Ledgerline, clock: FixedClock): Promise<DrainReport> {
  const total: DrainReport = { handled: 0, retried: 0, deadLettered: 0 };
  for (let round = 0; round < 1_000; round += 1) {
    const report = await app.processMessages();
    total.handled += report.handled;
    total.retried += report.retried;
    total.deadLettered += report.deadLettered;
    const next = app.queue.nextAvailableAt();
    if (next === undefined) {
      return total;
    }
    if (next > clock.now()) {
      clock.set(next);
    }
  }
  throw new Error('The queue did not settle');
}

/** Registers stock and walks one order through to placement. */
export async function placeOrder(
  { run }: TestApp,
  orderId: string,
  lines: Array<[string, number]>,
  extras: { customerId?: string; region?: string; discountCodes?: string[]; coupon?: string } = {},
): Promise<void> {
  await run({
    type: 'CreateOrder',
    payload: { orderId, customerId: extras.customerId ?? 'alice', shippingRegion: extras.region ?? 'US-CA' },
  });
  for (const [index, [sku, quantity]] of lines.entries()) {
    await run({ type: 'AddOrderLine', payload: { orderId, sku, quantity, lineId: `${orderId}-l${index + 1}` } });
  }
  for (const code of extras.discountCodes ?? []) {
    await run({ type: 'ApplyDiscountCode', payload: { orderId, code } });
  }
  if (extras.coupon) {
    await run({ type: 'ApplyCoupon', payload: { orderId, code: extras.coupon } });
  }
  await run({ type: 'PlaceOrder', payload: { orderId } });
}

export async function stockItems(testApp: TestApp, items: Record<string, number>): Promise<void> {
  for (const [sku, quantity] of Object.entries(items)) {
    await testApp.run({
      type: 'RegisterInventoryItem',
      payload: { sku, name: sku.toLowerCase(), initialQuantity: quantity },
    });
  }
}

export async function payOrder(testApp: TestApp, orderId: string, paymentId = `pay-${orderId}`): Promise<void> {
  const totalCents = testApp.app.readModels.orderSummary.get(orderId)!.totalCents;
  await testApp.run({
    type: 'CapturePayment',
    payload: { paymentId, orderId, amountCents: totalCents, method: 'card' },
  });
}

/** Everything the read models currently say, for whole-state comparisons. */
export function readModelState(app: Ledgerline) {
  const { orderSummary, stockLevels, dailyRevenue, customerHistory } = app.readModels;
  return {
    orders: orderSummary.all().sort((a, b) => a.orderId.localeCompare(b.orderId)),
    stock: stockLevels.all(),
    revenue: dailyRevenue.all(),
    customers: customerHistory.customerIds().map((id) => customerHistory.get(id)),
  };
}
