import { AggregateRepository, RepositoryDependencies } from '../shared/aggregates/aggregate-repository';
import { INVENTORY_AGGREGATE, InventoryEvent } from './inventory-events';
import { InventoryItem, InventoryState } from './inventory-item';

export type InventoryRepository = AggregateRepository<InventoryState, InventoryEvent, InventoryItem>;

export function createInventoryRepository(dependencies: RepositoryDependencies): InventoryRepository {
  return new AggregateRepository<InventoryState, InventoryEvent, InventoryItem>({
    ...dependencies,
    aggregateType: INVENTORY_AGGREGATE,
    create: (sku) => new InventoryItem(sku),
  });
}
