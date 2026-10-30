import { StoredEvent } from '../shared/events/domain-event';
import { Projection } from '../shared/projections/projection';
import { INVENTORY_AGGREGATE, InventoryEvent } from './inventory-events';

export interface StockLevel {
  readonly sku: string;
  readonly name: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
}

interface MutableLevel {
  sku: string;
  name: string;
  onHand: number;
  reservations: Map<string, number>;
}

/** Current stock per SKU: on hand, held by open reservations, and free to sell. */
export class StockLevelsProjection implements Projection {
  readonly name: string = 'stock-levels';
  readonly aggregateTypes = [INVENTORY_AGGREGATE];
  private levels = new Map<string, MutableLevel>();

  apply(stored: StoredEvent): void {
    const event = stored as StoredEvent<InventoryEvent>;
    const level = this.levelFor(stored.aggregateId);
    switch (event.type) {
      case 'InventoryItemRegistered':
        level.name = event.payload.name;
        break;
      case 'StockReceived':
        level.onHand += event.payload.quantity;
        break;
      case 'StockReserved':
        level.reservations.set(event.payload.orderId, event.payload.quantity);
        break;
      case 'StockReservationReleased':
        level.reservations.delete(event.payload.orderId);
        break;
      case 'StockReservationConfirmed':
        level.reservations.delete(event.payload.orderId);
        level.onHand -= event.payload.quantity;
        break;
      case 'StockReservationRejected':
        break;
    }
  }

  reset(): void {
    this.levels = new Map();
  }

  get(sku: string): StockLevel | undefined {
    const level = this.levels.get(sku);
    return level ? toStockLevel(level) : undefined;
  }

  all(): StockLevel[] {
    return [...this.levels.values()].map(toStockLevel).sort((a, b) => a.sku.localeCompare(b.sku));
  }

  private levelFor(sku: string): MutableLevel {
    let level = this.levels.get(sku);
    if (!level) {
      level = { sku, name: '', onHand: 0, reservations: new Map() };
      this.levels.set(sku, level);
    }
    return level;
  }
}

function toStockLevel(level: MutableLevel): StockLevel {
  const reserved = [...level.reservations.values()].reduce((total, quantity) => total + quantity, 0);
  return { sku: level.sku, name: level.name, onHand: level.onHand, reserved, available: level.onHand - reserved };
}
