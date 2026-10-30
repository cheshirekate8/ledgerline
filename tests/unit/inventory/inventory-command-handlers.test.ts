import { inventoryCommandHandlers } from '../../../src/inventory/inventory-command-handlers';
import { InventoryCommand } from '../../../src/inventory/inventory-commands';
import { InventoryItemNotFoundError } from '../../../src/inventory/inventory-errors';
import { INVENTORY_EVENT_TYPES } from '../../../src/inventory/inventory-events';
import { createInventoryRepository } from '../../../src/inventory/inventory-repository';
import { CommandBus } from '../../../src/shared/commands/command-bus';
import { testDependencies } from '../../support/dependencies';

function setup() {
  const infrastructure = testDependencies(INVENTORY_EVENT_TYPES);
  const repository = createInventoryRepository(infrastructure.dependencies);
  const bus = new CommandBus<InventoryCommand>().registerAll(inventoryCommandHandlers(repository));
  let key = 0;
  const run = (command: Omit<InventoryCommand, 'idempotencyKey'>, idempotencyKey = `k-${(key += 1)}`) =>
    bus.execute({ ...command, idempotencyKey } as InventoryCommand);
  return { ...infrastructure, repository, bus, run };
}

describe('inventory command handlers', () => {
  it('registers an item with its initial stock', async () => {
    const { run, repository, store } = setup();
    const result = await run({ type: 'RegisterInventoryItem', payload: { sku: 'MUG', name: 'Mug', initialQuantity: 5 } });
    expect(result).toMatchObject({ aggregateId: 'MUG', version: 2, duplicate: false });
    expect(store.readStream('inventory-item', 'MUG').map((e) => e.type)).toEqual([
      'InventoryItemRegistered',
      'StockReceived',
    ]);
    expect(repository.load('MUG')!.available).toBe(5);
  });

  it('registers an item without stock', async () => {
    const { run, repository } = setup();
    await run({ type: 'RegisterInventoryItem', payload: { sku: 'MUG', name: 'Mug' } });
    expect(repository.load('MUG')!.onHand).toBe(0);
  });

  it('runs the reservation lifecycle', async () => {
    const { run, repository } = setup();
    await run({ type: 'RegisterInventoryItem', payload: { sku: 'MUG', name: 'Mug', initialQuantity: 5 } });
    await run({ type: 'ReceiveStock', payload: { sku: 'MUG', quantity: 5 } });
    const expiresAt = '2026-06-01T09:15:00.000Z';
    await run({ type: 'ReserveStock', payload: { sku: 'MUG', orderId: 'o-1', quantity: 3, expiresAt } });
    await run({ type: 'ReserveStock', payload: { sku: 'MUG', orderId: 'o-2', quantity: 2, expiresAt } });
    await run({ type: 'ConfirmStockReservation', payload: { sku: 'MUG', orderId: 'o-1' } });
    await run({ type: 'ReleaseStock', payload: { sku: 'MUG', orderId: 'o-2', reason: 'order-cancelled' } });

    const item = repository.load('MUG')!;
    expect({ onHand: item.onHand, reserved: item.reserved, available: item.available }).toEqual({
      onHand: 7,
      reserved: 0,
      available: 7,
    });
  });

  it('applies a redelivered reservation command once', async () => {
    const { run, repository } = setup();
    await run({ type: 'RegisterInventoryItem', payload: { sku: 'MUG', name: 'Mug', initialQuantity: 5 } });
    const reserve = {
      type: 'ReserveStock',
      payload: { sku: 'MUG', orderId: 'o-1', quantity: 2, expiresAt: '2026-06-01T09:15:00.000Z' },
    } as const;
    await run(reserve, 'reserve-o-1');
    const again = await run(reserve, 'reserve-o-1');
    expect(again.duplicate).toBe(true);
    expect(repository.load('MUG')!.reserved).toBe(2);
  });

  it('refuses commands for unregistered SKUs', async () => {
    const { run } = setup();
    await expect(run({ type: 'ReceiveStock', payload: { sku: 'GHOST', quantity: 1 } })).rejects.toBeInstanceOf(
      InventoryItemNotFoundError,
    );
  });

  it('returns the unchanged version when a command has nothing to do', async () => {
    const { run } = setup();
    await run({ type: 'RegisterInventoryItem', payload: { sku: 'MUG', name: 'Mug', initialQuantity: 5 } });
    const result = await run({
      type: 'ReleaseStock',
      payload: { sku: 'MUG', orderId: 'none', reason: 'order-cancelled' },
    });
    expect(result).toMatchObject({ version: 2, eventIds: [] });
  });
});
