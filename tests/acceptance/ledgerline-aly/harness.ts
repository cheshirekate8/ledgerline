// Shared setup for this task's acceptance tests. It lives inside the frozen directory, so
// it is frozen with them: a task cannot change what judges it by editing this file.
// It imports only from src/. The clock starts years before the real date, so a window
// measured on wall-clock time cannot pass for one measured on the injected clock.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedgerline, Ledgerline } from '../../../src/app/ledgerline';
import { FixedClock } from '../../../src/shared/clock';
import { CommandResult } from '../../../src/shared/commands/command';
import { DomainError } from '../../../src/shared/errors';
import { JsonLogger, MemoryLogSink } from '../../../src/shared/logger';
import { SeededIdGenerator } from '../../../src/shared/ids';

export const T0 = Date.parse('2020-01-01T00:00:00.000Z');
export const HOUR = 3_600_000;
export const W = 24 * HOUR;

/** A fresh temporary directory, removed by the returned function. */
export function tempDirectory(): { directory: string; remove: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'ledgerline-window-'));
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

export interface OpenOptions {
  seed?: number;
  clock?: FixedClock;
  /** Directory holding a JSON-file log; omitted for an in-memory store. */
  directory?: string;
  /** Extra options passed to createLedgerline as given, e.g. `{ idempotencyWindowMs: 60_000 }`. */
  extra?: object;
}

export interface Store {
  app: Ledgerline;
  clock: FixedClock;
  sink: MemoryLogSink;
  run(type: string, payload: object, idempotencyKey: string): Promise<CommandResult>;
  /** Drains the queue through retry backoff; a dead letter fails the test. */
  settle(): Promise<void>;
  /** The service's `idempotencyKeyCount()`. */
  keyCount(): number;
  stock(sku: string, quantity: number): Promise<void>;
  /** Creates, places and pays for an order under payment `pay-<orderId>`; lines get ids `<orderId>-l<n>`. */
  paidOrder(orderId: string, lines: Array<[string, number]>): Promise<void>;
  /** Everything a republish must not change. */
  state(): object;
}

export function openStore(options: OpenOptions = {}): Store {
  const clock = options.clock ?? new FixedClock(T0);
  const sink = new MemoryLogSink();
  const base = {
    catalog: { prices: { MUG: 1_000, CUP: 500 }, taxRates: { 'US-OR': 0 } },
    clock,
    ids: new SeededIdGenerator(options.seed ?? 11),
    logger: new JsonLogger({ sink: sink.write, clock }),
    retry: { maxAttempts: 3, backoff: { kind: 'fixed' as const, delayMs: 100 } },
    ...(options.directory
      ? { persistence: { kind: 'json-file' as const, path: join(options.directory, 'events.ndjson'), durable: false } }
      : {}),
  };
  const app = createLedgerline({ ...base, ...(options.extra ?? {}) });
  const run = (type: string, payload: object, idempotencyKey: string) =>
    app.execute({ type, payload, idempotencyKey } as never);

  const settle = async () => {
    for (let round = 0; round < 500; round += 1) {
      await app.processMessages();
      const next = app.queue.nextAvailableAt();
      if (next === undefined) {
        const dead = app.deadLetters.list();
        if (dead.length > 0 || app.queue.inFlightCount > 0) {
          throw new Error(
            `deliveries failed: ${dead.map((letter) => `${letter.message.body.event.type}: ${letter.error}`).join('; ')}`,
          );
        }
        return;
      }
      if (next > clock.now()) {
        clock.set(next);
      }
    }
    throw new Error('queue did not settle');
  };

  return {
    app,
    clock,
    sink,
    run,
    settle,
    keyCount: () => (app as unknown as { idempotencyKeyCount(): number }).idempotencyKeyCount(),
    stock: async (sku, quantity) => {
      await run('RegisterInventoryItem', { sku, name: sku.toLowerCase(), initialQuantity: quantity }, `stock-${sku}`);
    },
    paidOrder: async (orderId, lines) => {
      await run('CreateOrder', { orderId, customerId: `customer-${orderId}`, shippingRegion: 'US-OR' }, `${orderId}-create`);
      for (const [index, [sku, quantity]] of lines.entries()) {
        await run('AddOrderLine', { orderId, sku, quantity, lineId: `${orderId}-l${index + 1}` }, `${orderId}-line-${index + 1}`);
      }
      await run('PlaceOrder', { orderId }, `${orderId}-place`);
      await settle();
      const total = app.readModels.orderSummary.get(orderId)!.totalCents;
      await run('CapturePayment', { paymentId: `pay-${orderId}`, orderId, amountCents: total, method: 'card' }, `${orderId}-pay`);
      await settle();
      if (app.readModels.orderSummary.get(orderId)!.status !== 'Paid') {
        throw new Error(`setup failed: order ${orderId} is not Paid`);
      }
    },
    state: () => ({
      events: app.store.readAll(),
      summaries: app.readModels.orderSummary.all(),
      stock: app.readModels.stockLevels.all(),
      refunds: app.store
        .readAll()
        .filter((event) => event.type === 'PaymentRefunded')
        .map((event) => ({ payment: event.aggregateId, ...(event.payload as object) })),
    }),
  };
}

/** Awaits a command that must be refused; fails unless it is a DomainError with exactly `code`. */
export async function refusal(attempt: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await attempt;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`expected a refusal with code ${code}, but the command succeeded`);
  }
  if (!(caught instanceof DomainError) || caught.code !== code) {
    const described = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    throw new Error(`expected a DomainError with code ${code}, got ${described}`);
  }
}

const MINUTE = 60_000;

/**
 * Builds orders in every reachable final state, all within the first 20 minutes after T0:
 * delivered; shipped, credited and partly refunded; paid, partly refunded with restock and
 * credited; fully refunded while Paid; fully refunded after delivery; cancelled by the
 * customer; cancelled out of stock; expired after a payment was captured (compensated);
 * paid by one of two captured payments (the other compensated), then shipped and
 * delivered; and placed with stock reserved but never paid.
 */
export async function buildFinalStates(store: Store): Promise<void> {
  const { run, settle } = store;
  const ship = (orderId: string) => run('ShipOrder', { orderId, trackingNumber: `TRK-${orderId}` }, `${orderId}-ship`);
  const deliver = (orderId: string) => run('DeliverOrder', { orderId }, `${orderId}-deliver`);
  const refund = (orderId: string, line: number, quantity: number, id: string) =>
    run('RefundOrderLine', { orderId, lineId: `${orderId}-l${line}`, quantity, refundId: id }, `${orderId}-${id}`);
  const credit = (orderId: string, amountCents: number, id: string) =>
    run('CreditOrder', { orderId, amountCents, reason: 'goodwill', creditId: id }, `${orderId}-${id}`);
  const place = async (orderId: string, lines: Array<[string, number]>) => {
    await run('CreateOrder', { orderId, customerId: `customer-${orderId}`, shippingRegion: 'US-OR' }, `${orderId}-create`);
    for (const [index, [sku, quantity]] of lines.entries()) {
      await run('AddOrderLine', { orderId, sku, quantity, lineId: `${orderId}-l${index + 1}` }, `${orderId}-line-${index + 1}`);
    }
    await run('PlaceOrder', { orderId }, `${orderId}-place`);
    await settle();
  };
  const capture = (orderId: string, paymentId: string, amountCents: number) =>
    run('CapturePayment', { paymentId, orderId, amountCents, method: 'card' }, `${orderId}-${paymentId}`);

  await store.stock('MUG', 50);
  await store.stock('CUP', 1);

  await store.paidOrder('delivered', [['MUG', 1]]);
  await ship('delivered');
  await deliver('delivered');

  await store.paidOrder('shipped', [['MUG', 2]]);
  await ship('shipped');
  await credit('shipped', 300, 'c1');
  await refund('shipped', 1, 1, 'r1');

  await store.paidOrder('paid', [['MUG', 2]]);
  await refund('paid', 1, 1, 'r1');
  await credit('paid', 200, 'c1');

  await store.paidOrder('refunded-paid', [['MUG', 2]]);
  await refund('refunded-paid', 1, 2, 'r1');

  await store.paidOrder('refunded-delivered', [['MUG', 1]]);
  await ship('refunded-delivered');
  await deliver('refunded-delivered');
  await refund('refunded-delivered', 1, 1, 'r1');

  await place('cancelled', [['MUG', 1]]);
  await run('CancelOrder', { orderId: 'cancelled', reason: 'customer-request' }, 'cancelled-cancel');

  await place('out-of-stock', [['CUP', 5]]);

  await place('twice', [['MUG', 1]]);
  await capture('twice', 'pay-twice-1', 1_000);
  await capture('twice', 'pay-twice-2', 1_000);
  await settle();
  await ship('twice');
  await deliver('twice');

  await place('expired', [['MUG', 1]]);
  await capture('expired', 'pay-expired', 1_000);
  store.clock.advance(16 * MINUTE);
  await store.app.expireReservations();
  await settle();

  // Placed after the expiry sweep, so its own reservation is still running.
  await place('reserved', [['MUG', 1]]);

  const status = (orderId: string) => store.app.readModels.orderSummary.get(orderId)!.status;
  const expected: Record<string, string> = {
    delivered: 'Delivered',
    shipped: 'Shipped',
    paid: 'Paid',
    'refunded-paid': 'Refunded',
    'refunded-delivered': 'Refunded',
    cancelled: 'Cancelled',
    'out-of-stock': 'Cancelled',
    twice: 'Delivered',
    reserved: 'Placed',
    expired: 'Cancelled',
  };
  for (const [orderId, wanted] of Object.entries(expected)) {
    if (status(orderId) !== wanted) {
      throw new Error(`setup failed: order ${orderId} is ${status(orderId)}, expected ${wanted}`);
    }
  }
  const refunded = (paymentId: string) =>
    store.app.store.readAll().filter((event) => event.type === 'PaymentRefunded' && event.aggregateId === paymentId).length;
  if (refunded('pay-twice-2') !== 1 || refunded('pay-expired') !== 1 || refunded('pay-twice-1') !== 0) {
    throw new Error('setup failed: the compensated payments are not as expected');
  }
}

/** The on-hand quantity of a SKU, read from the stock-levels read model. */
export function onHand(store: Store, sku: string): number {
  return store.app.readModels.stockLevels.get(sku)!.onHand;
}
