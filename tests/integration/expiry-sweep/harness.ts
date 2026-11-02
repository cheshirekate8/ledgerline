// Shared setup for these tests. It imports only from src/. The event store is a public custom store that counts what a
// sweep asks it to read; counting is switched on only while expireReservations() runs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedgerline, Ledgerline } from '../../../src/app/ledgerline';
import { FixedClock } from '../../../src/shared/clock';
import { NewEvent, StoredEvent } from '../../../src/shared/events/domain-event';
import { EventListener, EventStore } from '../../../src/shared/events/event-store';
import { InMemoryEventStore } from '../../../src/shared/events/in-memory-event-store';
import { JsonFileEventStore } from '../../../src/shared/events/json-file-event-store';
import { SeededIdGenerator } from '../../../src/shared/ids';
import { JsonLogger, MemoryLogSink } from '../../../src/shared/logger';

export const T0 = Date.parse('2026-06-01T09:00:00.000Z');
export const MINUTE = 60_000;
export const TTL = 15 * MINUTE;

/** What one sweep asked the store to read. */
export interface SweepReads {
  listAggregateIds: number;
  readAllEvents: number;
  /** `aggregateType:aggregateId` → number of readStream calls. */
  streams: Map<string, number>;
  /** Events appended between the previous sweep (or opening) and this one. */
  appendedSince: number;
}

/** An event store that counts what a sweep asks of the store it wraps. */
export class CountingStore implements EventStore {
  counting = false;
  reads: SweepReads = { listAggregateIds: 0, readAllEvents: 0, streams: new Map(), appendedSince: 0 };
  private appendedSinceMark = 0;

  constructor(private readonly inner: EventStore) {}

  append(aggregateType: string, aggregateId: string, expectedSequence: number, events: readonly NewEvent[]): readonly StoredEvent[] {
    const stored = this.inner.append(aggregateType, aggregateId, expectedSequence, events);
    this.appendedSinceMark += stored.length;
    return stored;
  }

  readStream(aggregateType: string, aggregateId: string, afterSequence?: number): readonly StoredEvent[] {
    if (this.counting) {
      const key = `${aggregateType}:${aggregateId}`;
      this.reads.streams.set(key, (this.reads.streams.get(key) ?? 0) + 1);
    }
    return this.inner.readStream(aggregateType, aggregateId, afterSequence);
  }

  readAll(afterPosition?: number): readonly StoredEvent[] {
    const events = this.inner.readAll(afterPosition);
    if (this.counting) {
      this.reads.readAllEvents += events.length;
    }
    return events;
  }

  currentSequence(aggregateType: string, aggregateId: string): number {
    return this.inner.currentSequence(aggregateType, aggregateId);
  }

  listAggregateIds(aggregateType: string): readonly string[] {
    if (this.counting) {
      this.reads.listAggregateIds += 1;
    }
    return this.inner.listAggregateIds(aggregateType);
  }

  subscribe(listener: EventListener): () => void {
    return this.inner.subscribe(listener);
  }

  /**
   * Starts counting for one sweep. The next sweep's allowance counts from here, so it
   * includes whatever this sweep appends (a tailing reader will see those events).
   */
  begin(): void {
    this.reads = { listAggregateIds: 0, readAllEvents: 0, streams: new Map(), appendedSince: this.appendedSinceMark };
    this.appendedSinceMark = 0;
    this.counting = true;
  }

  end(): SweepReads {
    this.counting = false;
    return this.reads;
  }

  /** The store was opened by a service: earlier appends are history, not new work. */
  markOpened(): void {
    this.appendedSinceMark = 0;
  }
}

/** A counting store over a fresh in-memory store. */
export function countingMemoryStore(): CountingStore {
  return new CountingStore(new InMemoryEventStore());
}

/** A counting store over a JSON-file log. */
export function countingFileStore(path: string): CountingStore {
  return new CountingStore(new JsonFileEventStore(path, { durable: false }));
}

export function tempDirectory(): { directory: string; remove: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'ledgerline-sweep-'));
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

export interface OpenOptions {
  store?: CountingStore;
  /**
   * Open a JSON-file log through `persistence: { kind: 'json-file' }` instead, so the
   * service builds its own store. Nothing is counted then; use it for results, not reads.
   */
  jsonFilePath?: string;
  clock?: FixedClock;
  seed?: number;
  reservationTtlMs?: number;
  snapshots?: { enabled: boolean; interval: number };
}

export interface Store {
  app: Ledgerline;
  store: CountingStore;
  clock: FixedClock;
  sink: MemoryLogSink;
  run(type: string, payload: object, idempotencyKey: string): ReturnType<Ledgerline['execute']>;
  settle(): Promise<void>;
  /** Runs one sweep, returning its result and what it read. */
  sweep(): Promise<{ expired: string[]; reads: SweepReads; placedAtStart: string[] }>;
  stock(sku: string, quantity: number): Promise<void>;
  /** Creates and places an order with one MUG line; does not process messages. */
  place(orderId: string, quantity?: number, sku?: string): Promise<void>;
  /** Creates, places and pays for an order, processing messages. */
  paid(orderId: string, quantity?: number): Promise<void>;
}

/** Order ids whose stream says Placed: an OrderPlaced and no later payment or cancellation. */
export function placedOrders(store: EventStore): string[] {
  const placed: string[] = [];
  for (const event of store.readAll()) {
    if (event.aggregateType !== 'order') continue;
    if (event.type === 'OrderPlaced') placed.push(event.aggregateId);
    if (event.type === 'OrderPaid' || event.type === 'OrderCancelled') {
      const index = placed.indexOf(event.aggregateId);
      if (index >= 0) placed.splice(index, 1);
    }
  }
  return placed;
}

export function openStore(options: OpenOptions = {}): Store {
  const clock = options.clock ?? new FixedClock(T0);
  const sink = new MemoryLogSink();
  const store = options.store ?? countingMemoryStore();
  const app = createLedgerline({
    catalog: { prices: { MUG: 1_000, CUP: 500 }, taxRates: { 'US-OR': 0 } },
    clock,
    ids: new SeededIdGenerator(options.seed ?? 11),
    logger: new JsonLogger({ sink: sink.write, clock }),
    retry: { maxAttempts: 3, backoff: { kind: 'fixed', delayMs: 100 } },
    persistence: options.jsonFilePath
      ? { kind: 'json-file', path: options.jsonFilePath, durable: false }
      : { kind: 'custom', store },
    ...(options.reservationTtlMs === undefined ? {} : { reservationTtlMs: options.reservationTtlMs }),
    ...(options.snapshots === undefined ? {} : { snapshots: options.snapshots }),
  });
  store.markOpened();
  const run = (type: string, payload: object, idempotencyKey: string) =>
    app.execute({ type, payload, idempotencyKey } as never);

  const settle = async () => {
    for (let round = 0; round < 500; round += 1) {
      await app.processMessages();
      const next = app.queue.nextAvailableAt();
      if (next === undefined) {
        const dead = app.deadLetters.list();
        if (dead.length > 0 || app.queue.inFlightCount > 0) {
          throw new Error(`deliveries failed: ${dead.map((letter) => `${letter.message.body.event.type}: ${letter.error}`).join('; ')}`);
        }
        return;
      }
      if (next > clock.now()) clock.set(next);
    }
    throw new Error('queue did not settle');
  };

  const place = async (orderId: string, quantity = 1, sku = 'MUG') => {
    await run('CreateOrder', { orderId, customerId: `customer-${orderId}`, shippingRegion: 'US-OR' }, `${orderId}-create`);
    await run('AddOrderLine', { orderId, sku, quantity, lineId: `${orderId}-l1` }, `${orderId}-line`);
    await run('PlaceOrder', { orderId }, `${orderId}-place`);
  };

  return {
    app,
    store,
    clock,
    sink,
    run,
    settle,
    sweep: async () => {
      if (options.jsonFilePath) {
        throw new Error('a json-file store opened by the service cannot be counted; call expireReservations() directly');
      }
      const placedAtStart = placedOrders(store);
      store.begin();
      try {
        const expired = await app.expireReservations();
        return { expired, reads: store.end(), placedAtStart };
      } finally {
        store.counting = false;
      }
    },
    stock: async (sku, quantity) => {
      await run('RegisterInventoryItem', { sku, name: sku.toLowerCase(), initialQuantity: quantity }, `stock-${sku}`);
    },
    place,
    paid: async (orderId, quantity = 1) => {
      await place(orderId, quantity);
      await settle();
      const total = app.readModels.orderSummary.get(orderId)!.totalCents;
      await run('CapturePayment', { paymentId: `pay-${orderId}`, orderId, amountCents: total, method: 'card' }, `${orderId}-pay`);
      await settle();
    },
  };
}

/**
 * Fails unless one sweep stayed within the read bound: no listAggregateIds; readAll
 * returned no more events than were appended since the previous sweep or opening;
 * readStream only for orders Placed at the sweep's start, at most once each, at most
 * twice for an order the sweep expired.
 */
export function expectWithinReadBound(sweep: { expired: string[]; reads: SweepReads; placedAtStart: string[] }): void {
  const { reads, placedAtStart, expired } = sweep;
  const problems: string[] = [];
  if (reads.listAggregateIds > 0) problems.push(`listAggregateIds called ${reads.listAggregateIds} time(s)`);
  if (reads.readAllEvents > reads.appendedSince) {
    problems.push(`readAll returned ${reads.readAllEvents} events; only ${reads.appendedSince} were appended since the previous sweep`);
  }
  for (const [key, count] of reads.streams) {
    const [type, id] = key.split(':') as [string, string];
    if (type !== 'order') {
      problems.push(`read stream ${key}`);
    } else if (!placedAtStart.includes(id)) {
      problems.push(`read order ${id}, which was not Placed when the sweep started`);
    } else if (count > (expired.includes(id) ? 2 : 1)) {
      problems.push(`read order ${id} ${count} times`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`sweep exceeded the read bound: ${problems.join('; ')}`);
  }
}
