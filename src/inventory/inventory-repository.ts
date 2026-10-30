import { AggregateRepository, RepositoryDependencies } from '../shared/aggregates/aggregate-repository';
import { INVENTORY_AGGREGATE, InventoryEvent } from './inventory-events';
import { InventoryItem, InventoryState } from './inventory-item';

export type InventoryRepository = AggregateRepository<InventoryState, InventoryEvent, InventoryItem>;

/** 2 since `InventoryState` gained `returns`; v1 snapshots are ignored, not misread. */
export const INVENTORY_SNAPSHOT_SCHEMA_VERSION = 2;

export function createInventoryRepository(dependencies: RepositoryDependencies): InventoryRepository {
  return new AggregateRepository<InventoryState, InventoryEvent, InventoryItem>({
    ...dependencies,
    aggregateType: INVENTORY_AGGREGATE,
    snapshotSchemaVersion: INVENTORY_SNAPSHOT_SCHEMA_VERSION,
    create: (sku) => new InventoryItem(sku),
  });
}
