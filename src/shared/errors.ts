/**
 * Base class for every error that represents a broken business rule rather
 * than an infrastructure fault. Each subclass carries a stable code that
 * callers can branch on without matching message text.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
}

/** Raised when an append is based on a stale view of the stream. */
export class ConcurrencyError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT';

  constructor(
    readonly streamId: string,
    readonly expectedSequence: number,
    readonly actualSequence: number,
  ) {
    super(`Stream ${streamId} is at sequence ${actualSequence}, expected ${expectedSequence}`);
    this.name = 'ConcurrencyError';
  }
}

/** Raised when an aggregate's events arrive with a gap in their sequence. */
export class OutOfOrderEventError extends Error {
  readonly code = 'OUT_OF_ORDER_EVENT';

  constructor(
    readonly aggregateId: string,
    readonly expectedSequence: number,
    readonly actualSequence: number,
  ) {
    super(`Event for ${aggregateId} has sequence ${actualSequence}, expected ${expectedSequence}`);
    this.name = 'OutOfOrderEventError';
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
