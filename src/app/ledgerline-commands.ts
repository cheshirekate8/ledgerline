import { InventoryCommand } from '../inventory/inventory-commands';
import { INVENTORY_EVENT_TYPES } from '../inventory/inventory-events';
import { OrderCommand } from '../orders/order-commands';
import { ORDER_EVENT_TYPES } from '../orders/order-events';
import { PaymentCommand } from '../payments/payment-commands';
import { PAYMENT_EVENT_TYPES } from '../payments/payment-events';
import { UpcasterRegistry } from '../shared/events/upcaster-registry';

/** Every command the service accepts. */
export type LedgerlineCommand = OrderCommand | InventoryCommand | PaymentCommand;

/** Every event type the service writes, all currently at schema version 1. */
export const ALL_EVENT_TYPES: readonly string[] = [
  ...ORDER_EVENT_TYPES,
  ...INVENTORY_EVENT_TYPES,
  ...PAYMENT_EVENT_TYPES,
];

export function createUpcasterRegistry(configure?: (registry: UpcasterRegistry) => void): UpcasterRegistry {
  const registry = new UpcasterRegistry();
  configure?.(registry);
  for (const type of ALL_EVENT_TYPES) {
    if (!registry.isDeclared(type)) {
      registry.declare(type);
    }
  }
  return registry;
}
