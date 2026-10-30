import { FixedClock } from '../../../../src/shared/clock';
import { SeededIdGenerator } from '../../../../src/shared/ids';
import { InProcessQueue } from '../../../../src/shared/messaging/in-process-queue';
import { retryPolicy } from '../../../../src/shared/messaging/retry-policy';

function setup(maxAttempts = 3) {
  const clock = new FixedClock(0);
  const queue = new InProcessQueue<string>({
    clock,
    ids: new SeededIdGenerator(3),
    retry: retryPolicy({
      maxAttempts,
      backoff: { kind: 'exponential', initialDelayMs: 100, multiplier: 2, maxDelayMs: 10_000 },
    }),
    visibilityTimeoutMs: 1_000,
  });
  return { clock, queue };
}

describe('InProcessQueue', () => {
  it('delivers messages in enqueue order and removes them on ack', () => {
    const { queue } = setup();
    queue.enqueue('a');
    queue.enqueue('b');
    const first = queue.lease()!;
    expect(first.message.body).toBe('a');
    expect(first.message.deliveryCount).toBe(1);
    expect(queue.ack(first.leaseId)).toBe(true);
    expect(queue.lease()!.message.body).toBe('b');
    expect(queue.lease()).toBeUndefined();
  });

  it('keeps an unacknowledged message until it is settled', () => {
    const { queue } = setup();
    queue.enqueue('a');
    queue.lease();
    expect(queue.inFlightCount).toBe(1);
    expect(queue.pendingCount).toBe(0);
  });

  it('delivers one message per group at a time, in order', () => {
    const { queue } = setup();
    queue.enqueue('g1-first', { groupKey: 'g1' });
    queue.enqueue('g1-second', { groupKey: 'g1' });
    queue.enqueue('g2-first', { groupKey: 'g2' });

    const a = queue.lease()!;
    const b = queue.lease()!;
    expect([a.message.body, b.message.body]).toEqual(['g1-first', 'g2-first']);
    expect(queue.lease()).toBeUndefined();
    queue.ack(a.leaseId);
    expect(queue.lease()!.message.body).toBe('g1-second');
  });

  it('retries a failed message after an exponential backoff', () => {
    const { clock, queue } = setup();
    queue.enqueue('a');
    const outcome = queue.fail(queue.lease()!.leaseId, 'boom');
    expect(outcome).toEqual({ kind: 'retry', attempt: 1, delayMs: 100, availableAt: 100 });
    expect(queue.lease()).toBeUndefined();
    expect(queue.nextAvailableAt()).toBe(100);

    clock.advance(100);
    const retry = queue.lease()!;
    expect(retry.message).toMatchObject({ body: 'a', deliveryCount: 2, lastError: 'boom' });
    expect(queue.fail(retry.leaseId, 'again')).toMatchObject({ kind: 'retry', delayMs: 200 });
  });

  it('does not let a later message overtake a retried one in the same group', () => {
    const { clock, queue } = setup();
    queue.enqueue('first', { groupKey: 'g' });
    queue.enqueue('second', { groupKey: 'g' });
    queue.fail(queue.lease()!.leaseId, 'boom');
    expect(queue.lease()).toBeUndefined();
    clock.advance(100);
    expect(queue.lease()!.message.body).toBe('first');
  });

  it('dead-letters a message once its attempts are exhausted', () => {
    const { clock, queue } = setup(2);
    queue.enqueue('a');
    queue.fail(queue.lease()!.leaseId, 'one');
    clock.advance(100);
    expect(queue.fail(queue.lease()!.leaseId, 'two')).toEqual({ kind: 'dead-lettered', attempt: 2 });
    expect(queue.pendingCount).toBe(0);
    expect(queue.deadLetters.list()).toEqual([
      expect.objectContaining({ error: 'two', deadLetteredAt: 100, message: expect.objectContaining({ body: 'a' }) }),
    ]);
  });

  it('redrives a dead letter with a fresh retry budget', () => {
    const { queue } = setup(1);
    const message = queue.enqueue('a');
    queue.fail(queue.lease()!.leaseId, 'boom');
    expect(queue.redrive(message.id)).toBe(true);
    expect(queue.redrive(message.id)).toBe(false);
    expect(queue.deadLetters.size).toBe(0);
    expect(queue.lease()!.message).toMatchObject({ id: message.id, deliveryCount: 1 });
  });

  it('redelivers a message whose lease expired, and ignores the late ack', () => {
    const { clock, queue } = setup();
    queue.enqueue('a');
    const original = queue.lease()!;
    clock.advance(1_000);
    expect(queue.hasDeliverable()).toBe(false);
    clock.advance(100);
    const redelivery = queue.lease()!;
    expect(redelivery.message).toMatchObject({ body: 'a', deliveryCount: 2 });
    expect(queue.ack(original.leaseId)).toBe(false);
    expect(queue.fail(original.leaseId, 'late')).toEqual({ kind: 'stale-lease' });
    expect(queue.ack(redelivery.leaseId)).toBe(true);
  });

  it('reports whether anything can be delivered right now', () => {
    const { queue } = setup();
    expect(queue.hasDeliverable()).toBe(false);
    expect(queue.nextAvailableAt()).toBeUndefined();
    queue.enqueue('a', { groupKey: 'g' });
    expect(queue.hasDeliverable()).toBe(true);
    queue.lease();
    queue.enqueue('b', { groupKey: 'g' });
    expect(queue.hasDeliverable()).toBe(false);
  });
});
