/** A message as seen by consumers of the queue. */
export interface QueueMessage<T> {
  readonly id: string;
  /** Messages sharing a group key are delivered one at a time, in enqueue order. */
  readonly groupKey: string;
  readonly body: T;
  /** Deliveries so far, including the current one while leased. */
  readonly deliveryCount: number;
  readonly enqueuedAt: number;
  readonly availableAt: number;
  readonly lastError?: string;
}

/** A message handed to one consumer, identified by a token that is used to settle it. */
export interface Lease<T> {
  readonly leaseId: string;
  readonly message: QueueMessage<T>;
  readonly expiresAt: number;
}

export type FailureOutcome =
  | { readonly kind: 'retry'; readonly attempt: number; readonly delayMs: number; readonly availableAt: number }
  | { readonly kind: 'dead-lettered'; readonly attempt: number }
  | { readonly kind: 'stale-lease' };

export interface DeadLetter<T> {
  readonly message: QueueMessage<T>;
  readonly error: string;
  readonly deadLetteredAt: number;
}
