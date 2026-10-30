import { AggregateRoot } from '../shared/aggregates/aggregate-root';
import { ValidationError } from '../shared/errors';
import { InventoryItemAlreadyRegisteredError, ReservationNotFoundError } from './inventory-errors';
import { INVENTORY_AGGREGATE, InventoryEvent, ReleaseReason } from './inventory-events';

export interface Reservation {
  readonly quantity: number;
  readonly expiresAt: string;
}

/** How a reservation for an order ended. */
export type ReservationOutcome = 'rejected' | 'released' | 'confirmed';

export interface InventoryState {
  readonly registered: boolean;
  readonly name: string;
  /** Units physically in stock, including reserved ones. */
  readonly onHand: number;
  readonly reservations: Readonly<Record<string, Reservation>>;
  readonly closedReservations: Readonly<Record<string, ReservationOutcome>>;
}

const INITIAL_STATE: InventoryState = {
  registered: false,
  name: '',
  onHand: 0,
  reservations: {},
  closedReservations: {},
};

/**
 * Stock for one SKU. Units are reserved for an order when it is placed,
 * then either confirmed (they leave stock) when the order is paid, or
 * released back to stock when the order is cancelled or its reservation
 * expires. Every operation on a given order's reservation is idempotent.
 */
export class InventoryItem extends AggregateRoot<InventoryState, InventoryEvent> {
  readonly aggregateType = INVENTORY_AGGREGATE;

  constructor(sku: string) {
    super(sku, INITIAL_STATE);
  }

  get sku(): string {
    return this.id;
  }

  get name(): string {
    return this.state.name;
  }

  get isRegistered(): boolean {
    return this.state.registered;
  }

  get onHand(): number {
    return this.state.onHand;
  }

  get reserved(): number {
    return Object.values(this.state.reservations).reduce((total, reservation) => total + reservation.quantity, 0);
  }

  get available(): number {
    return this.onHand - this.reserved;
  }

  reservationFor(orderId: string): Reservation | undefined {
    return this.state.reservations[orderId];
  }

  outcomeFor(orderId: string): ReservationOutcome | undefined {
    return this.state.closedReservations[orderId];
  }

  register(name: string): void {
    if (this.state.registered) {
      throw new InventoryItemAlreadyRegisteredError(this.sku);
    }
    if (name.trim().length === 0) {
      throw new ValidationError('Inventory items need a name');
    }
    this.raise({ type: 'InventoryItemRegistered', version: 1, payload: { sku: this.sku, name: name.trim() } });
  }

  receive(quantity: number): void {
    assertPositiveQuantity(quantity);
    this.raise({ type: 'StockReceived', version: 1, payload: { quantity } });
  }

  /** Reserves stock for an order, or records a rejection if there is not enough. */
  reserve(orderId: string, quantity: number, expiresAt: string): void {
    assertPositiveQuantity(quantity);
    if (this.state.reservations[orderId] || this.state.closedReservations[orderId]) {
      return;
    }
    const available = this.available;
    if (quantity > available) {
      this.raise({
        type: 'StockReservationRejected',
        version: 1,
        payload: { orderId, requested: quantity, available },
      });
      return;
    }
    this.raise({ type: 'StockReserved', version: 1, payload: { orderId, quantity, expiresAt } });
  }

  /** Returns an order's reserved units to available stock. A no-op if nothing is reserved. */
  release(orderId: string, reason: ReleaseReason): void {
    const reservation = this.state.reservations[orderId];
    if (!reservation) {
      return;
    }
    this.raise({
      type: 'StockReservationReleased',
      version: 1,
      payload: { orderId, quantity: reservation.quantity, reason },
    });
  }

  /** Takes an order's reserved units out of stock once the order is paid. */
  confirm(orderId: string): void {
    if (this.state.closedReservations[orderId] === 'confirmed') {
      return;
    }
    const reservation = this.state.reservations[orderId];
    if (!reservation) {
      throw new ReservationNotFoundError(this.sku, orderId);
    }
    this.raise({ type: 'StockReservationConfirmed', version: 1, payload: { orderId, quantity: reservation.quantity } });
  }

  protected evolve(state: InventoryState, event: InventoryEvent): InventoryState {
    switch (event.type) {
      case 'InventoryItemRegistered':
        return { ...state, registered: true, name: event.payload.name };
      case 'StockReceived':
        return { ...state, onHand: state.onHand + event.payload.quantity };
      case 'StockReserved':
        return {
          ...state,
          reservations: {
            ...state.reservations,
            [event.payload.orderId]: { quantity: event.payload.quantity, expiresAt: event.payload.expiresAt },
          },
        };
      case 'StockReservationRejected':
        return close(state, event.payload.orderId, 'rejected');
      case 'StockReservationReleased':
        return close(state, event.payload.orderId, 'released');
      case 'StockReservationConfirmed':
        return { ...close(state, event.payload.orderId, 'confirmed'), onHand: state.onHand - event.payload.quantity };
    }
  }
}

function close(state: InventoryState, orderId: string, outcome: ReservationOutcome): InventoryState {
  const { [orderId]: _closed, ...reservations } = state.reservations;
  return { ...state, reservations, closedReservations: { ...state.closedReservations, [orderId]: outcome } };
}

function assertPositiveQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ValidationError(`Stock quantities must be positive integers, got ${quantity}`);
  }
}
