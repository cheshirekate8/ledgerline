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

export type InventoryCommand =
  | RegisterInventoryItem
  | ReceiveStock
  | ReserveStock
  | ReleaseStock
  | ConfirmStockReservation;
