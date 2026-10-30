import { InventoryCommand } from '../inventory/inventory-commands';
import { INVENTORY_EVENT_TYPES } from '../inventory/inventory-events';
import { OrderCommand } from '../orders/order-commands';
import { ORDER_EVENT_TYPES, ORDER_EVENT_VERSIONS, ORDER_UPCASTERS } from '../orders/order-events';
import { PaymentCommand } from '../payments/payment-commands';
import { PAYMENT_EVENT_TYPES } from '../payments/payment-events';
import { Upcaster, UpcasterRegistry } from '../shared/events/upcaster-registry';

/** Every command the service accepts. */
export type LedgerlineCommand = OrderCommand | InventoryCommand | PaymentCommand;

/** Every event type the service writes. */
export const ALL_EVENT_TYPES: readonly string[] = [
  ...ORDER_EVENT_TYPES,
  ...INVENTORY_EVENT_TYPES,
  ...PAYMENT_EVENT_TYPES,
];

/** Event types past version 1; everything not listed is still at v1. */
export const EVENT_VERSIONS: Readonly<Record<string, number>> = Object.freeze({ ...ORDER_EVENT_VERSIONS });

/** The upcasters that bring every older stored shape up to those versions. */
export const ALL_UPCASTERS: readonly Upcaster[] = [...ORDER_UPCASTERS];

export function createUpcasterRegistry(configure?: (registry: UpcasterRegistry) => void): UpcasterRegistry {
  const registry = new UpcasterRegistry();
  configure?.(registry);
  for (const type of ALL_EVENT_TYPES) {
    if (!registry.isDeclared(type)) {
      registry.declare(type, EVENT_VERSIONS[type] ?? 1);
    }
  }
  for (const upcaster of ALL_UPCASTERS) {
    registry.register(upcaster);
  }
  return registry;
}
