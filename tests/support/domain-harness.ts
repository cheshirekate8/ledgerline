import { inventoryCommandHandlers } from '../../src/inventory/inventory-command-handlers';
import { InventoryCommand } from '../../src/inventory/inventory-commands';
import { INVENTORY_EVENT_TYPES } from '../../src/inventory/inventory-events';
import { createInventoryRepository } from '../../src/inventory/inventory-repository';
import { orderCommandHandlers } from '../../src/orders/order-command-handlers';
import { OrderCommand } from '../../src/orders/order-commands';
import { ORDER_EVENT_TYPES } from '../../src/orders/order-events';
import { createOrderRepository } from '../../src/orders/order-repository';
import { createPayableOrderLookup } from '../../src/orders/payable-order-lookup';
import { paymentCommandHandlers } from '../../src/payments/payment-command-handlers';
import { PaymentCommand } from '../../src/payments/payment-commands';
import { PAYMENT_EVENT_TYPES } from '../../src/payments/payment-events';
import { createPaymentRepository } from '../../src/payments/payment-repository';
import { CommandBus } from '../../src/shared/commands/command-bus';
import { testCatalog } from './catalog';
import { testDependencies } from './dependencies';

export type AnyCommand = OrderCommand | InventoryCommand | PaymentCommand;

/**
 * All three domains wired to one command bus, with no queue in between.
 * Process managers can be driven by handing them stored events directly.
 */
export function domainHarness() {
  const infrastructure = testDependencies([...ORDER_EVENT_TYPES, ...INVENTORY_EVENT_TYPES, ...PAYMENT_EVENT_TYPES]);
  const { dependencies, clock, ids } = infrastructure;
  const orders = createOrderRepository(dependencies);
  const inventory = createInventoryRepository(dependencies);
  const payments = createPaymentRepository(dependencies);
  const bus = new CommandBus<AnyCommand>()
    .registerAll(orderCommandHandlers({ repository: orders, catalog: testCatalog(), clock, ids }))
    .registerAll(inventoryCommandHandlers(inventory))
    .registerAll(paymentCommandHandlers(payments, createPayableOrderLookup(orders, clock)));

  let key = 0;
  const run = (command: Omit<AnyCommand, 'idempotencyKey'>) =>
    bus.execute({ ...command, idempotencyKey: `harness-${(key += 1)}` } as AnyCommand);

  const stock = async (sku: string, quantity: number) =>
    run({ type: 'RegisterInventoryItem', payload: { sku, name: sku.toLowerCase(), initialQuantity: quantity } });

  const placeOrder = async (orderId: string, lines: Array<[string, number]>, customerId = 'c-1') => {
    await run({ type: 'CreateOrder', payload: { orderId, customerId, shippingRegion: 'US-CA' } });
    for (const [index, [sku, quantity]] of lines.entries()) {
      await run({ type: 'AddOrderLine', payload: { orderId, sku, quantity, lineId: `${orderId}-l${index + 1}` } });
    }
    await run({ type: 'PlaceOrder', payload: { orderId } });
  };

  const lastEvent = (type: string) => {
    const event = infrastructure.store
      .readAll()
      .filter((candidate) => candidate.type === type)
      .at(-1);
    if (!event) {
      throw new Error(`No ${type} event has been stored`);
    }
    return event;
  };

  return { ...infrastructure, orders, inventory, payments, bus, run, stock, placeOrder, lastEvent };
}
