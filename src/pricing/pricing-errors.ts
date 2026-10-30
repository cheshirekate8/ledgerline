import { DomainError } from '../shared/errors';

export class UnknownSkuError extends DomainError {
  readonly code = 'UNKNOWN_SKU';

  constructor(readonly sku: string) {
    super(`SKU ${sku} is not in the price list`);
  }
}

export class UnknownDiscountCodeError extends DomainError {
  readonly code = 'UNKNOWN_DISCOUNT_CODE';

  constructor(readonly discountCode: string) {
    super(`Discount code ${discountCode} does not exist`);
  }
}

export class UnknownCouponError extends DomainError {
  readonly code = 'UNKNOWN_COUPON';

  constructor(readonly couponCode: string) {
    super(`Coupon ${couponCode} does not exist`);
  }
}

export class UnknownTaxRegionError extends DomainError {
  readonly code = 'UNKNOWN_TAX_REGION';

  constructor(readonly region: string) {
    super(`No tax rate is configured for shipping region ${region}`);
  }
}
