import { HOUR_MS, MINUTE_MS } from '../../src/shared/clock';
import { payOrder, placeOrder, stockItems, TestApp } from './test-app';

/**
 * A morning at the store: orders that complete, get refunded, run out of
 * stock, expire unpaid or are cancelled, across two days.
 */
export async function runStoreScenario(testApp: TestApp): Promise<void> {
  const { app, run, clock, settle } = testApp;
  await stockItems(testApp, { MUG: 20, TEE: 6, POSTER: 3, STICKER: 100 });

  await placeOrder(testApp, 'o-1', [['MUG', 3], ['TEE', 1]], { discountCodes: ['TEN'], coupon: 'FIVE' });
  await placeOrder(testApp, 'o-2', [['POSTER', 2], ['STICKER', 10]], { customerId: 'bob', region: 'DE' });
  await placeOrder(testApp, 'o-3', [['TEE', 5]], { customerId: 'carol', region: 'US-OR' });
  await placeOrder(testApp, 'o-4', [['MUG', 2]], { customerId: 'dave' });
  await settle();

  await payOrder(testApp, 'o-1');
  await payOrder(testApp, 'o-2');
  await settle();

  await run({ type: 'ShipOrder', payload: { orderId: 'o-1', trackingNumber: 'TRK-1' } });
  await run({ type: 'RefundOrderLine', payload: { orderId: 'o-2', lineId: 'o-2-l2', quantity: 4, refundId: 'r-1' } });
  await run({ type: 'CancelOrder', payload: { orderId: 'o-3', reason: 'customer-request' } });
  await settle();

  clock.advance(20 * MINUTE_MS);
  await app.expireReservations();
  await settle();

  clock.advance(24 * HOUR_MS);
  await run({ type: 'DeliverOrder', payload: { orderId: 'o-1' } });
  await run({ type: 'RefundOrderLine', payload: { orderId: 'o-1', lineId: 'o-1-l1', quantity: 1, refundId: 'r-2' } });
  await placeOrder(testApp, 'o-5', [['STICKER', 3], ['MUG', 1]], { coupon: 'HUNDRED' });
  await settle();
  await payOrder(testApp, 'o-5');
  await settle();
}
