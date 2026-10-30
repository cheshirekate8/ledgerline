import { INVENTORY_EVENT_TYPES } from '../../../src/inventory/inventory-events';
import { InventoryItem } from '../../../src/inventory/inventory-item';
import { createInventoryRepository } from '../../../src/inventory/inventory-repository';
import { StockLevelsProjection } from '../../../src/inventory/stock-levels-projection';
import { ProjectionHost } from '../../../src/shared/projections/projection';
import { testDependencies } from '../../support/dependencies';

const EXPIRES = '2026-06-01T09:15:00.000Z';

function setup() {
  const infrastructure = testDependencies(INVENTORY_EVENT_TYPES);
  const repository = createInventoryRepository(infrastructure.dependencies);
  const host = new ProjectionHost(new StockLevelsProjection(), infrastructure.upcasters);
  const change = (sku: string, act: (item: InventoryItem) => void) => {
    const item = repository.load(sku) ?? new InventoryItem(sku);
    act(item);
    repository.save(item);
  };
  return { ...infrastructure, host, change };
}

describe('StockLevelsProjection', () => {
  it('tracks on hand, reserved and available stock per SKU', () => {
    const { store, host, change } = setup();
    change('MUG', (item) => {
      item.register('Mug');
      item.receive(10);
    });
    change('CUP', (item) => {
      item.register('Cup');
      item.receive(3);
    });
    change('MUG', (item) => item.reserve('o-1', 4, EXPIRES));
    change('MUG', (item) => item.reserve('o-2', 2, EXPIRES));
    change('MUG', (item) => item.confirm('o-1'));
    change('MUG', (item) => item.release('o-2', 'reservation-expired'));
    change('MUG', (item) => item.returnFromRefund('o-1', 'r-1', 1));
    change('CUP', (item) => item.reserve('o-3', 5, EXPIRES));
    change('CUP', (item) => item.reserve('o-4', 1, EXPIRES));

    host.rebuild(store);
    expect(host.projection.all()).toEqual([
      { sku: 'CUP', name: 'Cup', onHand: 3, reserved: 1, available: 2 },
      { sku: 'MUG', name: 'Mug', onHand: 7, reserved: 0, available: 7 },
    ]);
    expect(host.projection.get('NONE')).toBeUndefined();
  });

  it('agrees with the aggregate after every change', () => {
    const { store, host, change, dependencies } = setup();
    const repository = createInventoryRepository(dependencies);
    const steps: Array<(item: InventoryItem) => void> = [
      (item) => item.register('Mug'),
      (item) => item.receive(7),
      (item) => item.reserve('o-1', 3, EXPIRES),
      (item) => item.reserve('o-2', 9, EXPIRES),
      (item) => item.confirm('o-1'),
      (item) => item.receive(2),
      (item) => item.returnFromRefund('o-1', 'r-1', 2),
    ];
    for (const step of steps) {
      change('MUG', step);
      host.rebuild(store);
      const item = repository.load('MUG')!;
      expect(host.projection.get('MUG')).toMatchObject({
        onHand: item.onHand,
        reserved: item.reserved,
        available: item.available,
      });
    }
  });

  it('starts empty after a reset', () => {
    const { store, host, change } = setup();
    change('MUG', (item) => item.register('Mug'));
    host.rebuild(store);
    host.projection.reset();
    expect(host.projection.all()).toEqual([]);
  });
});
