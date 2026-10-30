import { RoundingMode, scaleRounded } from './rounding';

/**
 * Money is always an integer number of cents. The brand prevents a plain
 * number (a quantity, a rate, a float) from being used as an amount without
 * passing through {@link cents}, which rejects anything but a safe integer.
 */
export type Cents = number & { readonly __brand: 'Cents' };

/** One hundred percent expressed in basis points. */
export const BASIS_POINTS_SCALE = 10_000;

export class InvalidMoneyError extends RangeError {
  constructor(value: unknown) {
    super(`Money must be a safe integer number of cents, got ${String(value)}`);
    this.name = 'InvalidMoneyError';
  }
}

export function cents(value: number): Cents {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new InvalidMoneyError(value);
  }
  return value as Cents;
}

export function nonNegativeCents(value: number): Cents {
  const amount = cents(value);
  if (amount < 0) {
    throw new InvalidMoneyError(value);
  }
  return amount;
}

export const ZERO_CENTS: Cents = cents(0);

export function addCents(...amounts: Cents[]): Cents {
  return sumCents(amounts);
}

export function sumCents(amounts: readonly Cents[]): Cents {
  return cents(amounts.reduce((total, amount) => total + amount, 0));
}

export function subtractCents(minuend: Cents, subtrahend: Cents): Cents {
  return cents(minuend - subtrahend);
}

export function multiplyCents(amount: Cents, factor: number): Cents {
  if (!Number.isSafeInteger(factor)) {
    throw new RangeError(`Money can only be multiplied by an integer, got ${factor}`);
  }
  return cents(amount * factor);
}

export function minCents(a: Cents, b: Cents): Cents {
  return a <= b ? a : b;
}

/** Applies a rate in basis points to an amount, rounding with `mode`. */
export function applyBasisPoints(amount: Cents, basisPoints: number, mode: RoundingMode): Cents {
  return cents(scaleRounded(amount, basisPoints, BASIS_POINTS_SCALE, mode));
}

export function assertBasisPoints(basisPoints: number, label: string): void {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > BASIS_POINTS_SCALE) {
    throw new RangeError(
      `${label} must be an integer between 0 and ${BASIS_POINTS_SCALE} basis points, got ${basisPoints}`,
    );
  }
}

export function formatCents(amount: Cents): string {
  const sign = amount < 0 ? '-' : '';
  const magnitude = Math.abs(amount);
  const whole = Math.floor(magnitude / 100);
  const fraction = String(magnitude % 100).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}
