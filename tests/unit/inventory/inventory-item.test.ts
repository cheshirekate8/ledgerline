import { InventoryItemAlreadyRegisteredError, ReservationNotFoundError } from '../../../src/inventory/inventory-errors';
import { InventoryItem } from '../../../src/inventory/inventory-item';
import { ValidationError } from '../../../src/shared/errors';

const EXPIRES = '2026-06-01T09:15:00.000Z';

function stockedItem(onHand = 10): InventoryItem {
  const item = new InventoryItem('MUG');
  item.register('Enamel mug');
  item.receive(onHand);
  return item;
}

const eventTypes = (item: InventoryItem) => item.peekPendingEvents().map((event) => event.type);

describe('InventoryItem', () => {
  it('registers once and tracks received stock', () => {
    const item = stockedItem(10);
    item.receive(5);
    expect(item.isRegistered).toBe(true);
    expect(item.name).toBe('Enamel mug');
    expect(item.onHand).toBe(15);
    expect(item.available).toBe(15);
    expect(() => item.register('Again')).toThrow(InventoryItemAlreadyRegisteredError);
  });

  it('refuses non-positive or fractional quantities and empty names', () => {
    const item = stockedItem();
    expect(() => item.receive(0)).toThrow(ValidationError);
    expect(() => item.receive(1.5)).toThrow(ValidationError);
    expect(() => item.reserve('o-1', -1, EXPIRES)).toThrow(ValidationError);
    expect(() => new InventoryItem('X').register('  ')).toThrow(ValidationError);
  });

  it('reserves stock so it is no longer available, without removing it from hand', () => {
    const item = stockedItem(10);
    item.reserve('o-1', 4, EXPIRES);
    expect(item.onHand).toBe(10);
    expect(item.reserved).toBe(4);
    expect(item.available).toBe(6);
    expect(item.reservationFor('o-1')).toEqual({ quantity: 4, expiresAt: EXPIRES });
  });

  it('records a rejection instead of overselling', () => {
    const item = stockedItem(3);
    item.reserve('o-1', 2, EXPIRES);
    item.reserve('o-2', 2, EXPIRES);
    expect(item.available).toBe(1);
    expect(item.outcomeFor('o-2')).toBe('rejected');
    expect(item.peekPendingEvents().at(-1)).toEqual({
      type: 'StockReservationRejected',
      version: 1,
      payload: { orderId: 'o-2', requested: 2, available: 1 },
    });
  });

  it('treats a repeated reservation for the same order as a no-op', () => {
    const item = stockedItem(10);
    item.reserve('o-1', 4, EXPIRES);
    item.reserve('o-1', 4, EXPIRES);
    expect(item.reserved).toBe(4);
    expect(eventTypes(item).filter((type) => type === 'StockReserved')).toHaveLength(1);
  });

  it('releases a reservation back to available stock, once', () => {
    const item = stockedItem(10);
    item.reserve('o-1', 4, EXPIRES);
    item.release('o-1', 'reservation-expired');
    item.release('o-1', 'reservation-expired');
    expect(item.available).toBe(10);
    expect(item.outcomeFor('o-1')).toBe('released');
    expect(eventTypes(item).filter((type) => type === 'StockReservationReleased')).toHaveLength(1);
  });

  it('does not reserve again for an order whose reservation was already released', () => {
    const item = stockedItem(10);
    item.reserve('o-1', 4, EXPIRES);
    item.release('o-1', 'order-cancelled');
    item.reserve('o-1', 4, EXPIRES);
    expect(item.reserved).toBe(0);
  });

  it('ignores releasing an order that holds no reservation', () => {
    const item = stockedItem(10);
    item.release('nobody', 'order-cancelled');
    expect(eventTypes(item)).toEqual(['InventoryItemRegistered', 'StockReceived']);
  });

  it('confirms a reservation by taking the units out of stock, once', () => {
    const item = stockedItem(10);
    item.reserve('o-1', 4, EXPIRES);
    item.confirm('o-1');
    item.confirm('o-1');
    expect(item.onHand).toBe(6);
    expect(item.reserved).toBe(0);
    expect(item.available).toBe(6);
    expect(item.outcomeFor('o-1')).toBe('confirmed');
  });

  it('returns refunded units to stock, once per order and refund', () => {
    const item = stockedItem(3);
    item.reserve('o-1', 3, EXPIRES);
    item.confirm('o-1');

    item.returnFromRefund('o-1', 'r-1', 2);
    item.returnFromRefund('o-1', 'r-1', 2);

    expect(item.onHand).toBe(2);
    expect(item.available).toBe(2);
    expect(item.returnedFor('o-1', 'r-1')).toBe(2);
    expect(item.peekPendingEvents().filter((event) => event.type === 'StockReturned')).toEqual([
      { type: 'StockReturned', version: 1, payload: { orderId: 'o-1', refundId: 'r-1', quantity: 2 } },
    ]);
  });

  it('tells two orders that share a refund id apart', () => {
    const item = stockedItem(5);
    item.returnFromRefund('o-1', 'r-1', 1);
    item.returnFromRefund('o-2', 'r-1', 2);
    expect(item.onHand).toBe(8);
    expect(item.returnedFor('o-1', 'r-1')).toBe(1);
    expect(item.returnedFor('o-2', 'r-1')).toBe(2);
    expect(item.returnedFor('o-3', 'r-1')).toBe(0);
  });

  it('refuses to return a non-positive number of units', () => {
    const item = stockedItem(5);
    expect(() => item.returnFromRefund('o-1', 'r-1', 0)).toThrow(ValidationError);
    expect(() => item.returnFromRefund('o-1', 'r-1', 1.5)).toThrow(ValidationError);
  });

  it('refuses to confirm a reservation that does not exist', () => {
    const item = stockedItem(10);
    expect(() => item.confirm('o-9')).toThrow(ReservationNotFoundError);
    item.reserve('o-1', 1, EXPIRES);
    item.release('o-1', 'order-cancelled');
    expect(() => item.confirm('o-1')).toThrow(ReservationNotFoundError);
  });
});
