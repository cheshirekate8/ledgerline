// Shared setup for this task's acceptance tests. It lives inside the frozen directory, so
// it is frozen with them: a task cannot change what judges it by editing this file.
// It imports only from src/.
import { createLedgerline, Ledgerline } from '../../../src/app/ledgerline';
import { LedgerlineOptions } from '../../../src/app/ledgerline-options';
import { FixedClock } from '../../../src/shared/clock';
import { DomainError } from '../../../src/shared/errors';
import { StoredEvent } from '../../../src/shared/events/domain-event';
import { SeededIdGenerator } from '../../../src/shared/ids';
import { JsonLogger } from '../../../src/shared/logger';

export const START = '2026-06-01T09:00:00.000Z';

export interface Store {
  app: Ledgerline;
  clock: FixedClock;
  run(type: string, payload: object, idempotencyKey?: string): ReturnType<Ledgerline['execute']>;
  settle(): Promise<void>;
  stock(sku: string, quantity: number): Promise<void>;
  /** Creates, places and pays for an order; each line gets the id `<orderId>-l<n>`. */
  paidOrder(orderId: string, lines: Array<[string, number]>): Promise<void>;
  refund(orderId: string, lineId: string, quantity: number, refundId: string, idempotencyKey?: string): Promise<void>;
  /** Sends CreditOrder; `creditId` is left out of the payload when undefined. */
  credit(orderId: string, amountCents: number, reason: string, creditId?: string, idempotencyKey?: string): Promise<void>;
  events(type: string): StoredEvent[];
  /** The order's stored OrderCredited payloads, oldest first. */
  credits(orderId: string): Array<Record<string, unknown>>;
  /** The stored PaymentRefunded events on `pay-<orderId>`, oldest first. */
  paymentRefunds(orderId: string): Array<{ refundId: string; amountCents: number; reason: string }>;
  /** `<type>@v<version>` for every stored event other than OrderLineRefunded that is not at version 1. */
  versionsOtherThanOne(): string[];
  level(sku: string): { onHand: number; reserved: number; available: number };
}

/**
 * Awaits a command that must be refused and returns its error, failing unless it is a
 * DomainError with exactly `code`. A plain Error, a RangeError, or a DomainError with
 * another code is the wrong refusal.
 */
export async function refusal(attempt: Promise<unknown>, code: string): Promise<DomainError> {
  let caught: unknown;
  try {
    await attempt;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`expected a refusal with code ${code}, but the command succeeded`);
  }
  if (!(caught instanceof DomainError) || (caught as DomainError).code !== code) {
    const described = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    const actual = (caught as { code?: unknown }).code;
    throw new Error(`expected a DomainError with code ${code}, got ${described} (code ${String(actual)})`);
  }
  return caught as DomainError;
}

/** A deterministic store with a zero-tax region, so every amount is easy to reason about. */
export function openStore(options: Partial<LedgerlineOptions> & { seed?: number } = {}): Store {
  const { seed = 11, ...rest } = options;
  const clock = (rest.clock as FixedClock | undefined) ?? new FixedClock(START);
  const app = createLedgerline({
    catalog: { prices: { MUG: 1_000, CUP: 500 }, taxRates: { 'US-OR': 0 } },
    clock,
    ids: new SeededIdGenerator(seed),
    logger: new JsonLogger({ sink: () => undefined }),
    retry: { maxAttempts: 3, backoff: { kind: 'fixed', delayMs: 100 } },
    ...rest,
  });
  let counter = 0;
  const run = (type: string, payload: object, idempotencyKey?: string) =>
    app.execute({ type, payload, idempotencyKey: idempotencyKey ?? `cmd-${(counter += 1)}` } as never);

  // Drains the queue, moving the fixed clock through retry backoff. A delivery that ends in
  // the dead-letter queue fails the test: "nothing changed" must never be the result of a
  // handler that threw.
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

  const store: Store = {
    app,
    clock,
    run,
    settle,
    stock: async (sku, quantity) => {
      await run('RegisterInventoryItem', { sku, name: sku.toLowerCase(), initialQuantity: quantity });
    },
    paidOrder: async (orderId, lines) => {
      await run('CreateOrder', { orderId, customerId: `customer-${orderId}`, shippingRegion: 'US-OR' });
      for (const [index, [sku, quantity]] of lines.entries()) {
        await run('AddOrderLine', { orderId, sku, quantity, lineId: `${orderId}-l${index + 1}` });
      }
      await run('PlaceOrder', { orderId });
      await settle();
      const total = app.readModels.orderSummary.get(orderId)!.totalCents;
      await run('CapturePayment', { paymentId: `pay-${orderId}`, orderId, amountCents: total, method: 'card' });
      await settle();
      if (app.readModels.orderSummary.get(orderId)!.status !== 'Paid') {
        throw new Error(`setup failed: order ${orderId} is not Paid`);
      }
    },
    refund: async (orderId, lineId, quantity, refundId, idempotencyKey) => {
      await run('RefundOrderLine', { orderId, lineId, quantity, refundId }, idempotencyKey);
    },
    credit: async (orderId, amountCents, reason, creditId, idempotencyKey) => {
      const payload = creditId === undefined ? { orderId, amountCents, reason } : { orderId, amountCents, reason, creditId };
      await run('CreditOrder', payload, idempotencyKey);
    },
    events: (type) => app.store.readAll().filter((event) => event.type === type),
    credits: (orderId) =>
      app.store
        .readAll()
        .filter((event) => event.type === 'OrderCredited' && event.aggregateId === orderId)
        .map((event) => event.payload as Record<string, unknown>),
    paymentRefunds: (orderId) =>
      app.store
        .readAll()
        .filter((event) => event.type === 'PaymentRefunded' && event.aggregateId === `pay-${orderId}`)
        .map((event) => {
          const { refundId, amountCents, reason } = event.payload as { refundId: string; amountCents: number; reason: string };
          return { refundId, amountCents, reason };
        }),
    versionsOtherThanOne: () =>
      app.store
        .readAll()
        .filter((event) => event.type !== 'OrderLineRefunded' && event.version !== 1)
        .map((event) => `${event.type}@v${event.version}`),
    level: (sku) => {
      const level = app.readModels.stockLevels.get(sku)!;
      return { onHand: level.onHand, reserved: level.reserved, available: level.available };
    },
  };
  return store;
}

export function payloadOf<T = Record<string, unknown>>(event: StoredEvent): T {
  return event.payload as T;
}
