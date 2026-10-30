import { CommandContext, HandlerMap, HandlerOutcome } from '../shared/commands/command';
import { InventoryCommand } from './inventory-commands';
import { InventoryItemNotFoundError } from './inventory-errors';
import { InventoryItem } from './inventory-item';
import { InventoryRepository } from './inventory-repository';

export function inventoryCommandHandlers(repository: InventoryRepository): HandlerMap<InventoryCommand> {
  const loadRegistered = (sku: string): InventoryItem => {
    const item = repository.load(sku);
    if (!item || !item.isRegistered) {
      throw new InventoryItemNotFoundError(sku);
    }
    return item;
  };

  const save = (item: InventoryItem, context: CommandContext): HandlerOutcome => {
    const events = repository.save(item, context.metadata);
    return { aggregateId: item.sku, version: item.version, events };
  };

  return {
    RegisterInventoryItem: ({ payload }, context) => {
      const item = repository.load(payload.sku) ?? new InventoryItem(payload.sku);
      item.register(payload.name);
      if (payload.initialQuantity !== undefined && payload.initialQuantity > 0) {
        item.receive(payload.initialQuantity);
      }
      return save(item, context);
    },
    ReceiveStock: ({ payload }, context) => {
      const item = loadRegistered(payload.sku);
      item.receive(payload.quantity);
      return save(item, context);
    },
    ReserveStock: ({ payload }, context) => {
      const item = loadRegistered(payload.sku);
      item.reserve(payload.orderId, payload.quantity, payload.expiresAt);
      return save(item, context);
    },
    ReleaseStock: ({ payload }, context) => {
      const item = loadRegistered(payload.sku);
      item.release(payload.orderId, payload.reason);
      return save(item, context);
    },
    ConfirmStockReservation: ({ payload }, context) => {
      const item = loadRegistered(payload.sku);
      item.confirm(payload.orderId);
      return save(item, context);
    },
    ReturnStock: ({ payload }, context) => {
      const item = loadRegistered(payload.sku);
      item.returnFromRefund(payload.orderId, payload.refundId, payload.quantity);
      return save(item, context);
    },
  };
}
