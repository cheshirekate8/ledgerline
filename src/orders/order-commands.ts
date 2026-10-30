import { Command } from '../shared/commands/command';

export type CreateOrder = Command<'CreateOrder', { orderId: string; customerId: string; shippingRegion: string }>;
export type AddOrderLine = Command<'AddOrderLine', { orderId: string; sku: string; quantity: number; lineId?: string }>;
export type RemoveOrderLine = Command<'RemoveOrderLine', { orderId: string; lineId: string }>;
export type ApplyDiscountCode = Command<'ApplyDiscountCode', { orderId: string; code: string }>;
export type ApplyCoupon = Command<'ApplyCoupon', { orderId: string; code: string }>;
export type PlaceOrder = Command<'PlaceOrder', { orderId: string }>;
export type RecordOrderStockReserved = Command<'RecordOrderStockReserved', { orderId: string }>;
export type MarkOrderPaid = Command<'MarkOrderPaid', { orderId: string; paymentId: string; amountCents: number }>;
export type ShipOrder = Command<'ShipOrder', { orderId: string; trackingNumber: string }>;
export type DeliverOrder = Command<'DeliverOrder', { orderId: string }>;
export type CancelOrder = Command<'CancelOrder', { orderId: string; reason: 'customer-request' | 'out-of-stock' }>;
export type ExpireOrderReservation = Command<'ExpireOrderReservation', { orderId: string }>;
export type RefundOrderLine = Command<
  'RefundOrderLine',
  { orderId: string; lineId: string; quantity: number; refundId?: string }
>;

export type OrderCommand =
  | CreateOrder
  | AddOrderLine
  | RemoveOrderLine
  | ApplyDiscountCode
  | ApplyCoupon
  | PlaceOrder
  | RecordOrderStockReserved
  | MarkOrderPaid
  | ShipOrder
  | DeliverOrder
  | CancelOrder
  | ExpireOrderReservation
  | RefundOrderLine;
