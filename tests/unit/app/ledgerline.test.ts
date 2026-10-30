import { createLedgerline } from '../../../src/app/ledgerline';
import { ALL_EVENT_TYPES, createUpcasterRegistry, EVENT_VERSIONS } from '../../../src/app/ledgerline-commands';
import { createPricingCatalog } from '../../../src/pricing/pricing-catalog';
import { FixedClock } from '../../../src/shared/clock';
import { StoredEvent } from '../../../src/shared/events/domain-event';
import { InMemoryEventStore } from '../../../src/shared/events/in-memory-event-store';
import { SeededIdGenerator } from '../../../src/shared/ids';
import { JsonLogger, MemoryLogSink } from '../../../src/shared/logger';
import { TEST_CATALOG_CONFIG } from '../../support/catalog';

describe('createUpcasterRegistry', () => {
  it('declares every event type at its current version', () => {
    const registry = createUpcasterRegistry();
    expect(ALL_EVENT_TYPES).toHaveLength(22);
    for (const type of ALL_EVENT_TYPES) {
      expect(registry.currentVersion(type)).toBe(EVENT_VERSIONS[type] ?? 1);
    }
    expect(EVENT_VERSIONS).toEqual({ OrderLineRefunded: 2 });
  });

  it('upcasts a v1 OrderLineRefunded as not returning its units to stock', () => {
    const registry = createUpcasterRegistry();
    const stored = {
      type: 'OrderLineRefunded',
      version: 1,
      payload: { refundId: 'r-1', lineId: 'l-1', paymentId: 'p-1', refund: { quantity: 1, totalCents: 1_000 } },
    } as unknown as StoredEvent;

    const upcast = registry.upcast(stored);

    expect(upcast.version).toBe(2);
    expect(upcast.payload).toEqual({ ...(stored.payload as object), returnsToStock: false });
  });

  it('lets a future schema version and its upcaster be declared through the hook', () => {
    const registry = createUpcasterRegistry((upcasters) =>
      upcasters
        .declare('OrderShipped', 2)
        .register({ type: 'OrderShipped', fromVersion: 1, upcast: (payload) => ({ ...(payload as object), carrier: 'unknown' }) }),
    );
    expect(registry.currentVersion('OrderShipped')).toBe(2);
    expect(registry.currentVersion('OrderPlaced')).toBe(1);
  });
});

describe('createLedgerline', () => {
  const base = () => ({
    clock: new FixedClock('2026-06-01T09:00:00.000Z'),
    ids: new SeededIdGenerator(1),
    logger: new JsonLogger({ sink: new MemoryLogSink().write }),
  });

  it('accepts a ready-made pricing catalog as well as plain configuration', async () => {
    const app = createLedgerline({ ...base(), catalog: createPricingCatalog(TEST_CATALOG_CONFIG) });
    await app.execute({
      type: 'CreateOrder',
      idempotencyKey: 'k-1',
      payload: { orderId: 'o-1', customerId: 'c-1', shippingRegion: 'DE' },
    });
    await app.processMessages();
    expect(app.readModels.orderSummary.get('o-1')!.status).toBe('Draft');
  });

  it('builds its read models from an existing event store at start-up', async () => {
    const store = new InMemoryEventStore();
    const first = createLedgerline({ ...base(), catalog: TEST_CATALOG_CONFIG, persistence: { kind: 'custom', store } });
    await first.execute({
      type: 'RegisterInventoryItem',
      idempotencyKey: 'k-1',
      payload: { sku: 'MUG', name: 'Mug', initialQuantity: 3 },
    });
    first.close();

    const second = createLedgerline({ ...base(), catalog: TEST_CATALOG_CONFIG, persistence: { kind: 'custom', store } });
    expect(second.readModels.stockLevels.get('MUG')).toMatchObject({ onHand: 3, available: 3 });
    expect(second.queue.pendingCount).toBe(0);
  });

  it('stops forwarding events once closed', async () => {
    const app = createLedgerline({ ...base(), catalog: TEST_CATALOG_CONFIG });
    app.close();
    await app.execute({
      type: 'RegisterInventoryItem',
      idempotencyKey: 'k-1',
      payload: { sku: 'MUG', name: 'Mug' },
    });
    expect(app.queue.pendingCount).toBe(0);
  });
});
