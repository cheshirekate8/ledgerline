// Shared setup for this task's acceptance tests. It lives inside the frozen directory, so
// it is frozen with them: a task cannot change what judges it by editing this file.
// It imports only from src/. A "restart" is a new instance over the same directory,
// created without closing the old one, as after a crash; the old one is never used again.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedgerline, Ledgerline } from '../../../src/app/ledgerline';
import { LedgerlineOptions } from '../../../src/app/ledgerline-options';
import { FixedClock } from '../../../src/shared/clock';
import { StoredEvent } from '../../../src/shared/events/domain-event';
import { SeededIdGenerator } from '../../../src/shared/ids';
import { JsonLogger, LogFields, MemoryLogSink } from '../../../src/shared/logger';

export const START = '2026-06-01T09:00:00.000Z';
export const FULFILLMENT = 'order-fulfillment';
export const PAYMENTS = 'order-payments';

/** A fresh temporary directory, removed by the returned function. */
export function tempDirectory(): { directory: string; remove: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'ledgerline-resume-'));
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

export function logPath(directory: string): string {
  return join(directory, 'events.ndjson');
}

export interface Store {
  app: Ledgerline;
  clock: FixedClock;
  sink: MemoryLogSink;
  run(type: string, payload: object, idempotencyKey?: string): ReturnType<Ledgerline['execute']>;
  /**
   * Drains the queue, moving the clock through retry backoff. Unless `allowDeadLetters`
   * is set, a delivery that ends in the dead-letter queue fails the test.
   */
  settle(options?: { allowDeadLetters?: boolean }): Promise<void>;
  stock(sku: string, quantity: number): Promise<void>;
  /** Creates and places an order; each line gets the id `<orderId>-l<n>`. Does not process messages. */
  placeOrder(orderId: string, lines: Array<[string, number]>): Promise<void>;
  /** The worker pool's log entries with message `msg`, optionally for one subscriber. */
  outcomes(msg: string, subscriber?: string): LogFields[];
}

export interface OpenOptions {
  seed?: number;
  clock?: FixedClock;
  persistence?: LedgerlineOptions['persistence'];
}

/** A deterministic store over `<directory>/events.ndjson` with a zero-tax region. */
export function openStore(directory: string, options: OpenOptions = {}): Store {
  const clock = options.clock ?? new FixedClock(START);
  const sink = new MemoryLogSink();
  const app = createLedgerline({
    catalog: { prices: { MUG: 1_000, CUP: 500 }, taxRates: { 'US-OR': 0 } },
    clock,
    ids: new SeededIdGenerator(options.seed ?? 11),
    logger: new JsonLogger({ sink: sink.write, clock }),
    retry: { maxAttempts: 3, backoff: { kind: 'fixed', delayMs: 100 } },
    persistence: options.persistence ?? { kind: 'json-file', path: logPath(directory), durable: false },
  });
  let counter = 0;
  const run = (type: string, payload: object, idempotencyKey?: string) =>
    app.execute({ type, payload, idempotencyKey: idempotencyKey ?? `cmd-${options.seed ?? 11}-${(counter += 1)}` } as never);

  const settle = async ({ allowDeadLetters = false } = {}) => {
    for (let round = 0; round < 500; round += 1) {
      await app.processMessages();
      const next = app.queue.nextAvailableAt();
      if (next === undefined) {
        const dead = app.deadLetters.list();
        if ((!allowDeadLetters && dead.length > 0) || app.queue.inFlightCount > 0) {
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
    stock: async (sku, quantity) => {
      await run('RegisterInventoryItem', { sku, name: sku.toLowerCase(), initialQuantity: quantity }, `stock-${sku}`);
    },
    placeOrder: async (orderId, lines) => {
      await run('CreateOrder', { orderId, customerId: `customer-${orderId}`, shippingRegion: 'US-OR' }, `create-${orderId}`);
      for (const [index, [sku, quantity]] of lines.entries()) {
        await run('AddOrderLine', { orderId, sku, quantity, lineId: `${orderId}-l${index + 1}` }, `line-${orderId}-${index + 1}`);
      }
      await run('PlaceOrder', { orderId }, `place-${orderId}`);
    },
    outcomes: (msg, subscriber) =>
      sink.entries().filter((entry) => entry['msg'] === msg && (subscriber === undefined || entry['subscriber'] === subscriber)),
  };
}

/** A subscriber that records every order event it receives. `failWhen` decides whether to throw instead. */
export interface Recorder {
  readonly name: string;
  readonly aggregateTypes: readonly string[];
  readonly received: StoredEvent[];
  failWhen: (event: StoredEvent) => string | undefined;
  handle(event: StoredEvent): void;
}

export function recorder(name: string, failWhen: Recorder['failWhen'] = () => undefined): Recorder {
  const self: Recorder = {
    name,
    aggregateTypes: ['order'],
    received: [],
    failWhen,
    handle(event) {
      const failure = self.failWhen(event);
      if (failure !== undefined) {
        throw new Error(failure);
      }
      self.received.push(event);
    },
  };
  return self;
}

/** `aggregateId#sequence` for each event, in the order received. */
export function trail(events: readonly StoredEvent[]): string[] {
  return events.map((event) => `${event.aggregateId}#${event.sequence}`);
}

/** `aggregateId#sequence` for every stored order event, in log order. */
export function storedTrail(app: Ledgerline, filter: (event: StoredEvent) => boolean = () => true): string[] {
  return trail(app.store.readAll().filter((event) => event.aggregateType === 'order' && filter(event)));
}
