import { CustomerHistoryProjection } from '../../../src/orders/customer-history-projection';
import { OrderSummaryProjection } from '../../../src/orders/order-summary-projection';
import { MINUTE_MS } from '../../../src/shared/clock';
import { ProjectionHost } from '../../../src/shared/projections/projection';
import { domainHarness } from '../../support/domain-harness';

async function scenario() {
  const harness = domainHarness();
  const { run, placeOrder, clock, orders } = harness;
  const pay = async (orderId: string) => {
    await run({ type: 'RecordOrderStockReserved', payload: { orderId } });
    const amountCents = orders.load(orderId)!.totalCents;
    await run({ type: 'MarkOrderPaid', payload: { orderId, paymentId: `pay-${orderId}`, amountCents } });
  };

  await run({ type: 'CreateOrder', payload: { orderId: 'o-1', customerId: 'alice', shippingRegion: 'US-CA' } });
  await run({ type: 'AddOrderLine', payload: { orderId: 'o-1', sku: 'MUG', quantity: 3, lineId: 'a' } });
  await run({ type: 'AddOrderLine', payload: { orderId: 'o-1', sku: 'TEE', quantity: 1, lineId: 'b' } });
  await run({ type: 'AddOrderLine', payload: { orderId: 'o-1', sku: 'STICKER', quantity: 4, lineId: 'c' } });
  await run({ type: 'RemoveOrderLine', payload: { orderId: 'o-1', lineId: 'c' } });
  await run({ type: 'ApplyDiscountCode', payload: { orderId: 'o-1', code: 'TEN' } });
  await run({ type: 'ApplyCoupon', payload: { orderId: 'o-1', code: 'FIVE' } });
  await run({ type: 'PlaceOrder', payload: { orderId: 'o-1' } });
  clock.advance(MINUTE_MS);
  await pay('o-1');
  clock.advance(MINUTE_MS);
  await run({ type: 'ShipOrder', payload: { orderId: 'o-1', trackingNumber: 'TRK-1' } });
  await run({ type: 'RefundOrderLine', payload: { orderId: 'o-1', lineId: 'a', quantity: 1, refundId: 'r-1' } });

  await placeOrder('o-2', [['TEE', 2]], 'alice');
  await run({ type: 'CancelOrder', payload: { orderId: 'o-2', reason: 'customer-request' } });

  await placeOrder('o-3', [['POSTER', 1]], 'bob');
  await pay('o-3');
  await run({ type: 'RefundOrderLine', payload: { orderId: 'o-3', lineId: 'o-3-l1', quantity: 1, refundId: 'r-2' } });

  await run({ type: 'CreateOrder', payload: { orderId: 'o-4', customerId: 'carol', shippingRegion: 'DE' } });
  return harness;
}

describe('OrderSummaryProjection', () => {
  it('summarizes each order from its events', async () => {
    const { store, upcasters } = await scenario();
    const host = new ProjectionHost(new OrderSummaryProjection(), upcasters);
    host.rebuild(store);

    expect(host.projection.get('o-1')).toEqual({
      orderId: 'o-1',
      customerId: 'alice',
      shippingRegion: 'US-CA',
      status: 'Shipped',
      lineCount: 2,
      itemCount: 4,
      subtotalCents: 8_497,
      discountCents: 850,
      couponCents: 500,
      taxCents: 590,
      totalCents: 7_737,
      refundedCents: 1_821,
      stockReserved: true,
      reservationExpiresAt: '2026-06-01T09:15:00.000Z',
      paymentId: 'pay-o-1',
      trackingNumber: 'TRK-1',
      cancellationReason: null,
      createdAt: '2026-06-01T09:00:00.000Z',
      placedAt: '2026-06-01T09:00:00.000Z',
      paidAt: '2026-06-01T09:01:00.000Z',
      shippedAt: '2026-06-01T09:02:00.000Z',
      deliveredAt: null,
      closedAt: null,
    });
    expect(host.projection.get('o-2')).toMatchObject({ status: 'Cancelled', cancellationReason: 'customer-request' });
    expect(host.projection.get('o-3')).toMatchObject({ status: 'Refunded', refundedCents: 1_088 });
    expect(host.projection.get('o-4')).toMatchObject({ status: 'Draft', totalCents: 0, lineCount: 0 });
    expect(host.projection.withStatus('Draft').map((summary) => summary.orderId)).toEqual(['o-4']);
    expect(host.projection.all()).toHaveLength(4);
  });

  it('counts a credit and only what a unit refund paid back as refunded', async () => {
    const { store, upcasters, run, orders } = await scenario();
    // o-1 was credited after a 1_821 refund, so the last refund pays back less.
    await run({ type: 'CreditOrder', payload: { orderId: 'o-1', amountCents: 5_000, reason: 'late', creditId: 'c-1' } });
    await run({ type: 'RefundOrderLine', payload: { orderId: 'o-1', lineId: 'a', quantity: 2, refundId: 'r-3' } });
    await run({ type: 'RefundOrderLine', payload: { orderId: 'o-1', lineId: 'b', quantity: 1, refundId: 'r-4' } });
    expect(orders.load('o-1')!.status).toBe('Refunded');

    const host = new ProjectionHost(new OrderSummaryProjection(), upcasters);
    host.rebuild(store);
    expect(host.projection.get('o-1')).toMatchObject({ status: 'Refunded', refundedCents: 7_737 });

    const history = new ProjectionHost(new CustomerHistoryProjection(), upcasters);
    history.rebuild(store);
    expect(history.projection.get('alice')).toMatchObject({ lifetimeSpendCents: 0 });
  });

  it('returns copies that callers cannot use to change the read model', async () => {
    const { store, upcasters } = await scenario();
    const host = new ProjectionHost(new OrderSummaryProjection(), upcasters);
    host.rebuild(store);
    const copy = host.projection.get('o-1') as { status: string };
    copy.status = 'Delivered';
    expect(host.projection.get('o-1')!.status).toBe('Shipped');
  });
});

describe('CustomerHistoryProjection', () => {
  it('lists each customer’s placed orders and lifetime spend', async () => {
    const { store, upcasters } = await scenario();
    const host = new ProjectionHost(new CustomerHistoryProjection(), upcasters);
    host.rebuild(store);

    expect(host.projection.customerIds()).toEqual(['alice', 'bob']);
    expect(host.projection.get('alice')).toEqual({
      customerId: 'alice',
      orderCount: 2,
      lifetimeSpendCents: 7_737 - 1_821,
      orders: [
        {
          orderId: 'o-1',
          status: 'Shipped',
          placedAt: '2026-06-01T09:00:00.000Z',
          totalCents: 7_737,
          paidCents: 7_737,
          refundedCents: 1_821,
        },
        {
          orderId: 'o-2',
          status: 'Cancelled',
          placedAt: '2026-06-01T09:02:00.000Z',
          totalCents: 5_413,
          paidCents: 0,
          refundedCents: 0,
        },
      ],
    });
    expect(host.projection.get('bob')).toMatchObject({ orderCount: 1, lifetimeSpendCents: 0 });
    expect(host.projection.get('carol')).toBeUndefined();
  });

  it('is empty after a reset', async () => {
    const { store, upcasters } = await scenario();
    const host = new ProjectionHost(new CustomerHistoryProjection(), upcasters);
    host.rebuild(store);
    host.projection.reset();
    expect(host.projection.customerIds()).toEqual([]);
  });
});
