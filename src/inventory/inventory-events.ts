import { EventData } from '../shared/events/domain-event';

export const INVENTORY_AGGREGATE = 'inventory-item';

/** Why a reservation gave its stock back. */
export type ReleaseReason = 'order-cancelled' | 'reservation-expired';

export type InventoryItemRegistered = EventData<'InventoryItemRegistered', { sku: string; name: string }>;
export type StockReceived = EventData<'StockReceived', { quantity: number }>;
export type StockReserved = EventData<'StockReserved', { orderId: string; quantity: number; expiresAt: string }>;
export type StockReservationRejected = EventData<
  'StockReservationRejected',
  { orderId: string; requested: number; available: number }
>;
export type StockReservationReleased = EventData<
  'StockReservationReleased',
  { orderId: string; quantity: number; reason: ReleaseReason }
>;
export type StockReservationConfirmed = EventData<'StockReservationConfirmed', { orderId: string; quantity: number }>;

export type InventoryEvent =
  | InventoryItemRegistered
  | StockReceived
  | StockReserved
  | StockReservationRejected
  | StockReservationReleased
  | StockReservationConfirmed;

export const INVENTORY_EVENT_TYPES: readonly InventoryEvent['type'][] = [
  'InventoryItemRegistered',
  'StockReceived',
  'StockReserved',
  'StockReservationRejected',
  'StockReservationReleased',
  'StockReservationConfirmed',
];
