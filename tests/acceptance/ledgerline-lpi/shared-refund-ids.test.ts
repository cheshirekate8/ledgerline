// Criterion 6: credits and unit refunds share the order's refund ids, a used id is a
// no-op before any other check, and every effect happens exactly once.
import { openStore, payloadOf } from './harness';

describe('criterion 6: shared refund ids and exactly-once effects', () => {
  it('treats an id used by either kind as already done', async () => {
    const store = openStore();
    await store.stock('MUG', 3);
    await store.paidOrder('E', [['MUG', 3]]);

    await store.credit('E', 500, 'late delivery', 'x');
    await store.settle();
    expect(store.credits('E')).toHaveLength(1);

    // A unit refund reusing the credit's id records nothing.
    await store.refund('E', 'E-l1', 1, 'x', 'refund-with-credit-id');
    await store.settle();
    expect(store.events('OrderLineRefunded')).toEqual([]);
    expect(store.events('StockReturned')).toEqual([]);
    expect(store.app.readModels.orderSummary.get('E')!.refundedCents).toBe(500);

    // A credit reusing a unit refund's id records nothing.
    await store.refund('E', 'E-l1', 1, 'y');
    await store.settle();
    await store.credit('E', 200, 'goodwill', 'y');
    await store.settle();
    expect(store.credits('E')).toHaveLength(1);

    // A repeated credit id is a no-op even when its amount is above the balance (1500).
    await store.credit('E', 2000, 'late delivery', 'x', 'credit-x-again');
    await store.settle();
    expect(store.credits('E')).toHaveLength(1);

    const effects = () => ({
      credits: store.events('OrderCredited').length,
      refunds: store.paymentRefunds('E'),
      returns: store.events('StockReturned').length,
    });
    const before = effects();
    expect(before.refunds.map((refund) => [refund.refundId, refund.amountCents])).toEqual([
      ['x', 500],
      ['y', 1000],
    ]);

    store.app.republish();
    await store.settle();
    expect(effects()).toEqual(before);
    expect(store.paymentRefunds('E').reduce((total, refund) => total + refund.amountCents, 0)).toBe(1500);
  });

  it('generates a credit id when none is given and refunds the payment under it', async () => {
    const store = openStore();
    await store.stock('MUG', 1);
    await store.paidOrder('G', [['MUG', 1]]);

    await store.credit('G', 250, 'goodwill');
    await store.settle();

    const credited = store.events('OrderCredited');
    expect(credited).toHaveLength(1);
    const { creditId } = payloadOf<{ creditId: unknown }>(credited[0]!);
    expect(typeof creditId).toBe('string');
    expect((creditId as string).length).toBeGreaterThan(0);
    expect(store.paymentRefunds('G')).toEqual([{ refundId: creditId, amountCents: 250, reason: 'goodwill' }]);
  });
});
