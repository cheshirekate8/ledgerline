import { Command } from '../shared/commands/command';
import { ReleaseReason } from './inventory-events';

export type RegisterInventoryItem = Command<
  'RegisterInventoryItem',
  { sku: string; name: string; initialQuantity?: number }
>;
export type ReceiveStock = Command<'ReceiveStock', { sku: string; quantity: number }>;
export type ReserveStock = Command<'ReserveStock', { sku: string; orderId: string; quantity: number; expiresAt: string }>;
export type ReleaseStock = Command<'ReleaseStock', { sku: string; orderId: string; reason: ReleaseReason }>;
export type ConfirmStockReservation = Command<'ConfirmStockReservation', { sku: string; orderId: string }>;
/** Puts refunded, never-shipped units back into stock; see `StockReturned`. */
export type ReturnStock = Command<'ReturnStock', { sku: string; orderId: string; refundId: string; quantity: number }>;

export type InventoryCommand =
  | RegisterInventoryItem
  | ReceiveStock
  | ReserveStock
  | ReleaseStock
  | ConfirmStockReservation
  | ReturnStock;
