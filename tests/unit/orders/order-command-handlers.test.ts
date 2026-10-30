import { orderCommandHandlers } from '../../../src/orders/order-command-handlers';
import { OrderCommand } from '../../../src/orders/order-commands';
import { OrderAlreadyExistsError, OrderNotFoundError } from '../../../src/orders/order-errors';
import { ORDER_EVENT_TYPES } from '../../../src/orders/order-events';
import { createOrderRepository } from '../../../src/orders/order-repository';
import { createPayableOrderLookup } from '../../../src/orders/payable-order-lookup';
import { UnknownCouponError, UnknownSkuError, UnknownTaxRegionError } from '../../../src/pricing/pricing-errors';
import { MINUTE_MS } from '../../../src/shared/clock';
import { CommandBus } from '../../../src/shared/commands/command-bus';
import { testCatalog } from '../../support/catalog';
import { testDependencies } from '../../support/dependencies';

function setup(reservationTtlMs?: number) {
  const infrastructure = testDependencies(ORDER_EVENT_TYPES);
  const repository = createOrderRepository(infrastructure.dependencies);
  const bus = new CommandBus<OrderCommand>().registerAll(
    orderCommandHandlers({
      repository,
      catalog: testCatalog(),
      clock: infrastructure.clock,
      ids: infrastructure.ids,
      ...(reservationTtlMs ? { reservationTtlMs } : {}),
    }),
  );
  let key = 0;
  const run = (command: Omit<OrderCommand, 'idempotencyKey'>, idempotencyKey = `k-${(key += 1)}`) =>
    bus.execute({ ...command, idempotencyKey } as OrderCommand);
  const draft = async () => {
    await run({ type: 'CreateOrder', payload: { orderId: 'o-1', customerId: 'c-1', shippingRegion: 'us-ca' } });
    await run({ type: 'AddOrderLine', payload: { orderId: 'o-1', sku: 'MUG', quantity: 3, lineId: 'a' } });
    await run({ type: 'AddOrderLine', payload: { orderId: 'o-1', sku: 'TEE', quantity: 1, lineId: 'b' } });
  };
  return { ...infrastructure, repository, run, draft };
}

describe('order command handlers', () => {
  it('creates an order in a supported region only, once', async () => {
    const { run, draft } = setup();
    await draft();
    await expect(
      run({ type: 'CreateOrder', payload: { orderId: 'o-1', customerId: 'c-1', shippingRegion: 'DE' } }),
    ).rejects.toBeInstanceOf(OrderAlreadyExistsError);
    await expect(
      run({ type: 'CreateOrder', payload: { orderId: 'o-2', customerId: 'c-1', shippingRegion: 'MARS' } }),
    ).rejects.toBeInstanceOf(UnknownTaxRegionError);
  });

  it('prices lines from the catalog and generates line ids when none are given', async () => {
    const { run, draft, repository } = setup();
    await draft();
    await run({ type: 'AddOrderLine', payload: { orderId: 'o-1', sku: 'STICKER', quantity: 2 } });
    const lines = repository.load('o-1')!.lines;
    expect(lines.map((line) => [line.sku, line.unitPriceCents])).toEqual([
      ['MUG', 1_999],
      ['TEE', 2_500],
      ['STICKER', 35],
    ]);
    expect(lines[2]!.lineId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      run({ type: 'AddOrderLine', payload: { orderId: 'o-1', sku: 'UNKNOWN', quantity: 1 } }),
    ).rejects.toBeInstanceOf(UnknownSkuError);
  });

  it('places with catalog discounts, coupon and the region tax rate, holding stock for 15 minutes', async () => {
    const { run, draft, repository } = setup();
    await draft();
    await run({ type: 'ApplyDiscountCode', payload: { orderId: 'o-1', code: 'ten' } });
    await run({ type: 'ApplyCoupon', payload: { orderId: 'o-1', code: 'five' } });
    await run({ type: 'PlaceOrder', payload: { orderId: 'o-1' } });
    const order = repository.load('o-1')!;
    expect(order.status).toBe('Placed');
    expect(order.totalCents).toBe(7_737);
    expect(order.pricing!.taxRateBasisPoints).toBe(825);
    expect(order.reservationExpiresAt).toBe('2026-06-01T09:15:00.000Z');
    await expect(run({ type: 'ApplyCoupon', payload: { orderId: 'o-1', code: 'missing' } })).rejects.toBeInstanceOf(
      UnknownCouponError,
    );
  });

  it('honours a configured reservation window', async () => {
    const { run, draft, repository } = setup(30 * MINUTE_MS);
    await draft();
    await run({ type: 'PlaceOrder', payload: { orderId: 'o-1' } });
    expect(repository.load('o-1')!.reservationExpiresAt).toBe('2026-06-01T09:30:00.000Z');
  });

  it('runs an order through payment, shipping, delivery and a refund', async () => {
    const { run, draft, repository } = setup();
    await draft();
    await run({ type: 'PlaceOrder', payload: { orderId: 'o-1' } });
    await run({ type: 'RecordOrderStockReserved', payload: { orderId: 'o-1' } });
    const total = repository.load('o-1')!.totalCents;
    await run({ type: 'MarkOrderPaid', payload: { orderId: 'o-1', paymentId: 'p-1', amountCents: total } });
    await run({ type: 'ShipOrder', payload: { orderId: 'o-1', trackingNumber: 'TRACK' } });
    await run({ type: 'DeliverOrder', payload: { orderId: 'o-1' } });
    await run({ type: 'RefundOrderLine', payload: { orderId: 'o-1', lineId: 'b', quantity: 1, refundId: 'r-1' } });
    const order = repository.load('o-1')!;
    expect(order.status).toBe('Delivered');
    expect(order.refundedQuantity('b')).toBe(1);
  });

  it('expires an unpaid order using the injected clock', async () => {
    const { run, draft, repository, clock } = setup();
    await draft();
    await run({ type: 'PlaceOrder', payload: { orderId: 'o-1' } });
    clock.advance(15 * MINUTE_MS);
    await run({ type: 'ExpireOrderReservation', payload: { orderId: 'o-1' } });
    expect(repository.load('o-1')!.status).toBe('Cancelled');
  });

  it('cancels on request', async () => {
    const { run, draft, repository } = setup();
    await draft();
    await run({ type: 'CancelOrder', payload: { orderId: 'o-1', reason: 'customer-request' } });
    expect(repository.load('o-1')!.status).toBe('Cancelled');
  });

  it('refuses commands for unknown orders', async () => {
    const { run } = setup();
    await expect(run({ type: 'PlaceOrder', payload: { orderId: 'ghost' } })).rejects.toBeInstanceOf(
      OrderNotFoundError,
    );
  });

  it('exposes payable orders to the payments domain', async () => {
    const { run, draft, repository, clock } = setup();
    const lookup = createPayableOrderLookup(repository, clock);
    await draft();
    await run({ type: 'PlaceOrder', payload: { orderId: 'o-1' } });
    await run({ type: 'RecordOrderStockReserved', payload: { orderId: 'o-1' } });
    expect(lookup.payableOrder('o-1')).toEqual({ orderId: 'o-1', customerId: 'c-1', totalCents: 9_198 });
    expect(() => lookup.payableOrder('ghost')).toThrow(OrderNotFoundError);
  });
});
