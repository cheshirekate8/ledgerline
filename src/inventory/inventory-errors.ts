import { DomainError } from '../shared/errors';

export class InventoryItemNotFoundError extends DomainError {
  readonly code = 'INVENTORY_ITEM_NOT_FOUND';

  constructor(readonly sku: string) {
    super(`No inventory item is registered for SKU ${sku}`);
  }
}

export class InventoryItemAlreadyRegisteredError extends DomainError {
  readonly code = 'INVENTORY_ITEM_ALREADY_REGISTERED';

  constructor(readonly sku: string) {
    super(`An inventory item is already registered for SKU ${sku}`);
  }
}

export class ReservationNotFoundError extends DomainError {
  readonly code = 'RESERVATION_NOT_FOUND';

  constructor(
    readonly sku: string,
    readonly orderId: string,
  ) {
    super(`SKU ${sku} holds no open reservation for order ${orderId}`);
  }
}
