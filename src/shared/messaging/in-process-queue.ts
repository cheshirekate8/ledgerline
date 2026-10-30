import { Clock } from '../clock';
import { IdGenerator } from '../ids';
import { DeadLetterQueue } from './dead-letter-queue';
import { FailureOutcome, Lease, QueueMessage } from './message';
import { backoffDelay, DEFAULT_RETRY_POLICY, RetryPolicy } from './retry-policy';

interface MessageRecord<T> {
  /** Enqueue order; fixes delivery order even when timestamps tie. */
  order: number;
  id: string;
  groupKey: string;
  body: T;
  deliveryCount: number;
  enqueuedAt: number;
  availableAt: number;
  lastError?: string;
}

interface ActiveLease<T> {
  record: MessageRecord<T>;
  expiresAt: number;
}

export interface InProcessQueueOptions<T> {
  clock: Clock;
  ids: IdGenerator;
  retry?: RetryPolicy;
  deadLetters?: DeadLetterQueue<T>;
  /** How long a lease lasts before the message is handed to another consumer. */
  visibilityTimeoutMs?: number;
}

export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

/**
 * An in-memory queue with at-least-once delivery. A message stays in the
 * queue until its lease is acknowledged; a failed or expired lease puts it
 * back with a backoff delay, and a message that keeps failing is moved to
 * the dead-letter queue. Messages in the same group are delivered strictly
 * one at a time in the order they were enqueued, so a retry never lets a
 * later message overtake an earlier one.
 */
export class InProcessQueue<T> {
  readonly deadLetters: DeadLetterQueue<T>;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly retry: RetryPolicy;
  private readonly visibilityTimeoutMs: number;
  private readonly pending: MessageRecord<T>[] = [];
  private readonly leases = new Map<string, ActiveLease<T>>();
  private readonly busyGroups = new Set<string>();
  private enqueueCounter = 0;

  constructor(options: InProcessQueueOptions<T>) {
    this.clock = options.clock;
    this.ids = options.ids;
    this.retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.deadLetters = options.deadLetters ?? new DeadLetterQueue<T>();
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
  }

  enqueue(body: T, options: { groupKey?: string } = {}): QueueMessage<T> {
    const id = this.ids.next();
    const now = this.clock.now();
    const record: MessageRecord<T> = {
      order: this.nextOrder(),
      id,
      groupKey: options.groupKey ?? id,
      body,
      deliveryCount: 0,
      enqueuedAt: now,
      availableAt: now,
    };
    this.pending.push(record);
    return toMessage(record);
  }

  /** Hands out the oldest deliverable message, or undefined if none is ready. */
  lease(): Lease<T> | undefined {
    this.reclaimExpiredLeases();
    const record = this.findDeliverable();
    if (!record) {
      return undefined;
    }
    this.pending.splice(this.pending.indexOf(record), 1);
    record.deliveryCount += 1;
    const leaseId = this.ids.next();
    const expiresAt = this.clock.now() + this.visibilityTimeoutMs;
    this.leases.set(leaseId, { record, expiresAt });
    this.busyGroups.add(record.groupKey);
    return { leaseId, message: toMessage(record), expiresAt };
  }

  /** Settles a lease successfully. Returns false if the lease had already expired. */
  ack(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return false;
    }
    this.release(leaseId, lease);
    return true;
  }

  /** Settles a lease as failed, scheduling a retry or dead-lettering the message. */
  fail(leaseId: string, error: string): FailureOutcome {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return { kind: 'stale-lease' };
    }
    this.release(leaseId, lease);
    return this.requeueOrDeadLetter(lease.record, error);
  }

  /** Moves a dead-lettered message back into the queue with a fresh retry budget. */
  redrive(messageId: string): boolean {
    const entry = this.deadLetters.remove(messageId);
    if (!entry) {
      return false;
    }
    const { id, groupKey, body, enqueuedAt, lastError } = entry.message;
    this.pending.push({
      order: this.nextOrder(),
      id,
      groupKey,
      body,
      enqueuedAt,
      deliveryCount: 0,
      availableAt: this.clock.now(),
      ...(lastError === undefined ? {} : { lastError }),
    });
    return true;
  }

  hasDeliverable(): boolean {
    this.reclaimExpiredLeases();
    return this.findDeliverable() !== undefined;
  }

  /** Earliest time any waiting message becomes deliverable. */
  nextAvailableAt(): number | undefined {
    if (this.pending.length === 0) {
      return undefined;
    }
    return Math.min(...this.pending.map((record) => record.availableAt));
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get inFlightCount(): number {
    return this.leases.size;
  }

  private findDeliverable(): MessageRecord<T> | undefined {
    const now = this.clock.now();
    const seenGroups = new Set<string>();
    for (const record of this.pending) {
      if (seenGroups.has(record.groupKey) || this.busyGroups.has(record.groupKey)) {
        continue;
      }
      seenGroups.add(record.groupKey);
      if (record.availableAt <= now) {
        return record;
      }
    }
    return undefined;
  }

  private reclaimExpiredLeases(): void {
    const now = this.clock.now();
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.release(leaseId, lease);
        this.requeueOrDeadLetter(lease.record, 'lease expired before the message was acknowledged');
      }
    }
  }

  private release(leaseId: string, lease: ActiveLease<T>): void {
    this.leases.delete(leaseId);
    this.busyGroups.delete(lease.record.groupKey);
  }

  private requeueOrDeadLetter(record: MessageRecord<T>, error: string): FailureOutcome {
    const now = this.clock.now();
    record.lastError = error;
    if (record.deliveryCount >= this.retry.maxAttempts) {
      this.deadLetters.add({ message: toMessage(record), error, deadLetteredAt: now });
      return { kind: 'dead-lettered', attempt: record.deliveryCount };
    }
    const delayMs = backoffDelay(this.retry.backoff, record.deliveryCount);
    record.availableAt = now + delayMs;
    this.insertInEnqueueOrder(record);
    return { kind: 'retry', attempt: record.deliveryCount, delayMs, availableAt: record.availableAt };
  }

  private nextOrder(): number {
    this.enqueueCounter += 1;
    return this.enqueueCounter;
  }

  /** Puts a retried message back in its original place, ahead of later messages from its group. */
  private insertInEnqueueOrder(record: MessageRecord<T>): void {
    const index = this.pending.findIndex((other) => other.order > record.order);
    if (index === -1) {
      this.pending.push(record);
    } else {
      this.pending.splice(index, 0, record);
    }
  }
}

function toMessage<T>(record: MessageRecord<T>): QueueMessage<T> {
  const { order: _order, ...message } = record;
  return Object.freeze(message);
}
