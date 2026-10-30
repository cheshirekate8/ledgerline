export type BackoffStrategy =
  | { readonly kind: 'fixed'; readonly delayMs: number }
  | {
      readonly kind: 'exponential';
      readonly initialDelayMs: number;
      readonly multiplier: number;
      readonly maxDelayMs: number;
    };

export interface RetryPolicy {
  /** Total deliveries allowed, including the first, before dead-lettering. */
  readonly maxAttempts: number;
  readonly backoff: BackoffStrategy;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 5,
  backoff: Object.freeze({ kind: 'exponential', initialDelayMs: 100, multiplier: 2, maxDelayMs: 30_000 }),
});

export function retryPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...overrides };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${policy.maxAttempts}`);
  }
  validateBackoff(policy.backoff);
  return Object.freeze(policy);
}

/** Delay before the next delivery, given how many deliveries have failed so far. */
export function backoffDelay(strategy: BackoffStrategy, failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    throw new RangeError(`failedAttempts must be a positive integer, got ${failedAttempts}`);
  }
  if (strategy.kind === 'fixed') {
    return strategy.delayMs;
  }
  const delay = strategy.initialDelayMs * strategy.multiplier ** (failedAttempts - 1);
  return Math.min(Math.round(delay), strategy.maxDelayMs);
}

function validateBackoff(strategy: BackoffStrategy): void {
  const nonNegative = (value: number, name: string) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative number, got ${value}`);
    }
  };
  if (strategy.kind === 'fixed') {
    nonNegative(strategy.delayMs, 'delayMs');
    return;
  }
  nonNegative(strategy.initialDelayMs, 'initialDelayMs');
  nonNegative(strategy.maxDelayMs, 'maxDelayMs');
  if (!Number.isFinite(strategy.multiplier) || strategy.multiplier < 1) {
    throw new RangeError(`multiplier must be at least 1, got ${strategy.multiplier}`);
  }
}
