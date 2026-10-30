import { createLedgerline } from '../../../src/app/ledgerline';
import { ALL_EVENT_TYPES, createUpcasterRegistry } from '../../../src/app/ledgerline-commands';
import { createPricingCatalog } from '../../../src/pricing/pricing-catalog';
import { FixedClock } from '../../../src/shared/clock';
import { InMemoryEventStore } from '../../../src/shared/events/in-memory-event-store';
import { SeededIdGenerator } from '../../../src/shared/ids';
import { JsonLogger, MemoryLogSink } from '../../../src/shared/logger';
import { TEST_CATALOG_CONFIG } from '../../support/catalog';

describe('createUpcasterRegistry', () => {
  it('declares every event type at version 1', () => {
    const registry = createUpcasterRegistry();
    expect(ALL_EVENT_TYPES).toHaveLength(21);
    for (const type of ALL_EVENT_TYPES) {
      expect(registry.currentVersion(type)).toBe(1);
    }
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
