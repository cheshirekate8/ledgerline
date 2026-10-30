import * as ledgerline from '../../src';
import { eventStreamKey, streamKey } from '../../src/shared/events/domain-event';

describe('package entry point', () => {
  it('exposes the service factory and the deterministic test doubles', () => {
    expect(typeof ledgerline.createLedgerline).toBe('function');
    expect(new ledgerline.SeededIdGenerator(1).next()).toBe(new ledgerline.SeededIdGenerator(1).next());
    expect(new ledgerline.FixedClock(5).now()).toBe(5);
  });

  it('exposes typed domain errors for callers to branch on', () => {
    const error = new ledgerline.InvalidOrderTransitionError('o-1', 'Draft', 'Shipped');
    expect(error).toBeInstanceOf(ledgerline.DomainError);
    expect(error.code).toBe('INVALID_ORDER_TRANSITION');
    expect(new ledgerline.RefundExceedsPaidError('o-1', 'l-1', 3, 2).code).toBe('REFUND_EXCEEDS_PAID');
    expect(new ledgerline.InventoryItemNotFoundError('MUG').code).toBe('INVENTORY_ITEM_NOT_FOUND');
    expect(new ledgerline.RefundExceedsCapturedError('p-1', ledgerline.cents(2), ledgerline.cents(1)).code).toBe(
      'REFUND_EXCEEDS_CAPTURED',
    );
  });

  it('exposes money helpers that refuse floats', () => {
    expect(ledgerline.formatCents(ledgerline.cents(1_234))).toBe('12.34');
    expect(() => ledgerline.cents(12.34)).toThrow(RangeError);
  });
});

describe('stream keys', () => {
  it('combine aggregate type and id', () => {
    expect(streamKey('order', 'o-1')).toBe('order:o-1');
    expect(eventStreamKey({ aggregateType: 'payment', aggregateId: 'p-9' })).toBe('payment:p-9');
  });
});
