import { FulfillmentProcess } from '../../../src/orders/process/fulfillment-process';
import { ReservationExpiryService } from '../../../src/orders/reservation-expiry-service';
import { MINUTE_MS } from '../../../src/shared/clock';
import { JsonLogger, MemoryLogSink } from '../../../src/shared/logger';
import { domainHarness } from '../../support/domain-harness';

async function setup() {
  const harness = domainHarness();
  const sink = new MemoryLogSink();
  const service = new ReservationExpiryService({
    store: harness.store,
    orders: harness.orders,
    commands: harness.bus,
    clock: harness.clock,
    logger: new JsonLogger({ sink: sink.write, clock: harness.clock }),
  });
  const fulfillment = new FulfillmentProcess({
    commands: harness.bus,
    orders: harness.orders,
    inventory: harness.inventory,
  });
  await harness.stock('MUG', 10);
  return { ...harness, service, sink, fulfillment };
}

describe('ReservationExpiryService', () => {
  it('expires only placed orders whose window has passed', async () => {
    const { service, placeOrder, clock, orders, run, fulfillment, lastEvent } = await setup();
    await placeOrder('early', [['MUG', 1]]);
    clock.advance(5 * MINUTE_MS);
    await placeOrder('late', [['MUG', 1]]);
    await placeOrder('paid', [['MUG', 1]]);
    await fulfillment.handle(lastEvent('OrderPlaced'));
    const total = orders.load('paid')!.totalCents;
    await run({ type: 'MarkOrderPaid', payload: { orderId: 'paid', paymentId: 'p-1', amountCents: total } });
    await run({ type: 'CreateOrder', payload: { orderId: 'draft', customerId: 'c-1', shippingRegion: 'DE' } });

    clock.advance(10 * MINUTE_MS - 1);
    expect(await service.expireDue()).toEqual([]);
    clock.advance(1);
    expect(await service.expireDue()).toEqual(['early']);
    clock.advance(5 * MINUTE_MS);
    expect(await service.expireDue()).toEqual(['late']);

    expect(['early', 'late', 'paid', 'draft'].map((id) => orders.load(id)!.status)).toEqual([
      'Cancelled',
      'Cancelled',
      'Paid',
      'Draft',
    ]);
  });

  it('is safe to run repeatedly', async () => {
    const { service, placeOrder, clock } = await setup();
    await placeOrder('o-1', [['MUG', 1]]);
    clock.advance(15 * MINUTE_MS);
    expect(await service.expireDue()).toEqual(['o-1']);
    expect(await service.expireDue()).toEqual([]);
  });

  it('logs each expiry', async () => {
    const { service, placeOrder, clock, sink } = await setup();
    await placeOrder('o-1', [['MUG', 1]]);
    clock.advance(20 * MINUTE_MS);
    await service.expireDue();
    expect(sink.entries()).toEqual([
      expect.objectContaining({
        msg: 'order.reservation_expired',
        orderId: 'o-1',
        expiresAt: '2026-06-01T09:15:00.000Z',
      }),
    ]);
  });
});
