import { inventoryCommandHandlers } from '../inventory/inventory-command-handlers';
import { createInventoryRepository } from '../inventory/inventory-repository';
import { StockLevelsProjection } from '../inventory/stock-levels-projection';
import { CustomerHistoryProjection } from '../orders/customer-history-projection';
import { orderCommandHandlers } from '../orders/order-command-handlers';
import { createOrderRepository } from '../orders/order-repository';
import { OrderSummaryProjection } from '../orders/order-summary-projection';
import { createPayableOrderLookup } from '../orders/payable-order-lookup';
import { FulfillmentProcess } from '../orders/process/fulfillment-process';
import { PaymentProcess } from '../orders/process/payment-process';
import { ReservationExpiryService } from '../orders/reservation-expiry-service';
import { DailyRevenueProjection } from '../payments/daily-revenue-projection';
import { paymentCommandHandlers } from '../payments/payment-command-handlers';
import { createPaymentRepository } from '../payments/payment-repository';
import { PriceList } from '../pricing/price-list';
import { createPricingCatalog, PricingCatalog, PricingCatalogConfig } from '../pricing/pricing-catalog';
import { RepositoryDependencies } from '../shared/aggregates/aggregate-repository';
import { Clock, SystemClock } from '../shared/clock';
import { CommandResult } from '../shared/commands/command';
import { CommandBus } from '../shared/commands/command-bus';
import { hydrateIdempotencyStore, InMemoryIdempotencyStore } from '../shared/commands/idempotency-store';
import { EventStore } from '../shared/events/event-store';
import { InMemoryEventStore } from '../shared/events/in-memory-event-store';
import { JsonFileEventStore } from '../shared/events/json-file-event-store';
import { RandomIdGenerator } from '../shared/ids';
import { JsonLogger } from '../shared/logger';
import { DeadLetterQueue } from '../shared/messaging/dead-letter-queue';
import { EventDelivery, EventDispatcher, EventSubscriber } from '../shared/messaging/event-dispatcher';
import { InProcessQueue } from '../shared/messaging/in-process-queue';
import { retryPolicy } from '../shared/messaging/retry-policy';
import { DrainReport, WorkerPool } from '../shared/messaging/worker-pool';
import { ProjectionHost } from '../shared/projections/projection';
import { snapshotPolicy } from '../shared/snapshots/snapshot-policy';
import { InMemorySnapshotStore } from '../shared/snapshots/snapshot-store';
import { createUpcasterRegistry, LedgerlineCommand } from './ledgerline-commands';
import { DEFAULT_WORKERS, LedgerlineOptions, PersistenceOptions } from './ledgerline-options';

export interface ReadModels {
  readonly orderSummary: OrderSummaryProjection;
  readonly stockLevels: StockLevelsProjection;
  readonly dailyRevenue: DailyRevenueProjection;
  readonly customerHistory: CustomerHistoryProjection;
}

/**
 * The assembled service. Commands are applied synchronously to the event
 * store; projections and process managers catch up when messages are
 * processed by the worker pool.
 */
export interface Ledgerline {
  execute(command: LedgerlineCommand): Promise<CommandResult>;
  /** Processes every message that is deliverable now and returns what happened. */
  processMessages(): Promise<DrainReport>;
  /** Expires placed orders whose reservation window has passed. */
  expireReservations(): Promise<string[]>;
  /** Discards every read model and rebuilds it from the event store. */
  rebuildReadModels(): void;
  /** Subscribes an extra consumer to the event stream, alongside the built-in ones. */
  subscribe(subscriber: EventSubscriber): void;
  /**
   * Delivers stored events after `afterPosition` to every subscriber again.
   * Safe for the built-in read models and processes, which ignore events they
   * have already handled; extra subscribers must be idempotent too.
   */
  republish(afterPosition?: number): number;
  /** Puts a dead-lettered message back on the queue. */
  redrive(messageId: string): boolean;
  /** Stops forwarding new events to the queue. */
  close(): void;
  readonly readModels: ReadModels;
  readonly store: EventStore;
  readonly queue: InProcessQueue<EventDelivery>;
  readonly deadLetters: DeadLetterQueue<EventDelivery>;
  readonly clock: Clock;
}

export function createLedgerline(options: LedgerlineOptions): Ledgerline {
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new RandomIdGenerator();
  const logger = options.logger ?? new JsonLogger({ clock });
  const store = createEventStore(options.persistence ?? { kind: 'memory' });
  const upcasters = createUpcasterRegistry(options.configureUpcasters);
  const catalog = toCatalog(options.catalog);

  const dependencies: RepositoryDependencies = {
    store,
    upcasters,
    ids,
    clock,
    snapshots: options.snapshotStore ?? new InMemorySnapshotStore(),
    snapshotPolicy: snapshotPolicy(options.snapshots),
  };
  const orders = createOrderRepository(dependencies);
  const inventory = createInventoryRepository(dependencies);
  const payments = createPaymentRepository(dependencies);

  const idempotency = new InMemoryIdempotencyStore();
  hydrateIdempotencyStore(store, idempotency);
  const bus = new CommandBus<LedgerlineCommand>({ idempotency })
    .registerAll(
      orderCommandHandlers({
        repository: orders,
        catalog,
        clock,
        ids,
        ...(options.reservationTtlMs === undefined ? {} : { reservationTtlMs: options.reservationTtlMs }),
      }),
    )
    .registerAll(inventoryCommandHandlers(inventory))
    .registerAll(paymentCommandHandlers(payments, createPayableOrderLookup(orders, clock)));

  const deadLetters = new DeadLetterQueue<EventDelivery>();
  const queue = new InProcessQueue<EventDelivery>({
    clock,
    ids,
    deadLetters,
    retry: retryPolicy(options.retry),
    ...(options.visibilityTimeoutMs === undefined ? {} : { visibilityTimeoutMs: options.visibilityTimeoutMs }),
  });
  const dispatcher = new EventDispatcher(store, queue, upcasters);
  const pool = new WorkerPool<EventDelivery>({
    queue,
    handler: dispatcher.deliver,
    concurrency: options.workers ?? DEFAULT_WORKERS,
    logger: logger.child({ component: 'worker-pool' }),
    describe: EventDispatcher.describe,
  });

  const readModels: ReadModels = {
    orderSummary: new OrderSummaryProjection(),
    stockLevels: new StockLevelsProjection(),
    dailyRevenue: new DailyRevenueProjection(),
    customerHistory: new CustomerHistoryProjection(),
  };
  const hosts = Object.values(readModels).map((projection) => new ProjectionHost(projection, upcasters));
  for (const host of hosts) {
    host.rebuild(store);
    dispatcher.register(host);
  }
  dispatcher.register(new FulfillmentProcess({ commands: bus, orders, inventory }));
  dispatcher.register(new PaymentProcess(bus, logger.child({ component: 'payment-process' })));
  dispatcher.start();

  const expiry = new ReservationExpiryService({
    store,
    orders,
    commands: bus,
    clock,
    logger: logger.child({ component: 'reservation-expiry' }),
  });

  return {
    execute: (command) => bus.execute(command),
    processMessages: () => pool.drain(),
    expireReservations: () => expiry.expireDue(),
    rebuildReadModels: () => hosts.forEach((host) => host.rebuild(store)),
    subscribe: (subscriber) => {
      dispatcher.register(subscriber);
    },
    republish: (afterPosition = 0) => {
      const events = store.readAll(afterPosition);
      dispatcher.publish(events);
      return events.length;
    },
    redrive: (messageId) => queue.redrive(messageId),
    close: () => dispatcher.stop(),
    readModels,
    store,
    queue,
    deadLetters,
    clock,
  };
}

function createEventStore(persistence: PersistenceOptions): EventStore {
  switch (persistence.kind) {
    case 'memory':
      return new InMemoryEventStore();
    case 'json-file':
      return new JsonFileEventStore(
        persistence.path,
        persistence.durable === undefined ? {} : { durable: persistence.durable },
      );
    case 'custom':
      return persistence.store;
  }
}

function toCatalog(catalog: PricingCatalogConfig | PricingCatalog): PricingCatalog {
  return catalog.prices instanceof PriceList
    ? (catalog as PricingCatalog)
    : createPricingCatalog(catalog as PricingCatalogConfig);
}
