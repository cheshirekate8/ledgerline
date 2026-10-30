import { FixedClock } from '../../../../src/shared/clock';
import { SeededIdGenerator } from '../../../../src/shared/ids';
import { JsonLogger, MemoryLogSink } from '../../../../src/shared/logger';
import { InProcessQueue } from '../../../../src/shared/messaging/in-process-queue';
import { retryPolicy } from '../../../../src/shared/messaging/retry-policy';
import { MessageHandler, WorkerPool } from '../../../../src/shared/messaging/worker-pool';

function setup(handler: MessageHandler<string>, concurrency = 2, maxAttempts = 3) {
  const clock = new FixedClock(0);
  const sink = new MemoryLogSink();
  const queue = new InProcessQueue<string>({
    clock,
    ids: new SeededIdGenerator(5),
    retry: retryPolicy({ maxAttempts, backoff: { kind: 'fixed', delayMs: 50 } }),
  });
  const pool = new WorkerPool<string>({
    queue,
    handler,
    concurrency,
    logger: new JsonLogger({ sink: sink.write, clock }),
    describe: (body) => ({ body }),
  });
  return { clock, sink, queue, pool };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('WorkerPool', () => {
  it('processes every deliverable message and logs one line per message', async () => {
    const seen: string[] = [];
    const { queue, pool, sink } = setup((body) => {
      seen.push(body);
    });
    ['a', 'b', 'c'].forEach((body) => queue.enqueue(body));

    expect(await pool.drain()).toEqual({ handled: 3, retried: 0, deadLettered: 0 });
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect(sink.messages()).toEqual(['message.handled', 'message.handled', 'message.handled']);
    expect(sink.entries()[0]).toMatchObject({ level: 'info', attempt: 1, messageId: expect.any(String) });
  });

  it('never runs more handlers at once than its concurrency', async () => {
    let active = 0;
    let peak = 0;
    const { queue, pool } = setup(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    }, 3);
    for (let i = 0; i < 10; i += 1) {
      queue.enqueue(`m${i}`);
    }
    await pool.drain();
    expect(peak).toBe(3);
  });

  it('processes messages of one group sequentially even with spare workers', async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const { queue, pool } = setup(async (body) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      order.push(body);
      active -= 1;
    }, 4);
    ['1', '2', '3'].forEach((body) => queue.enqueue(body, { groupKey: 'same' }));
    await pool.drain();
    expect(order).toEqual(['1', '2', '3']);
    expect(peak).toBe(1);
  });

  it('picks up messages enqueued by handlers during the drain', async () => {
    const { queue, pool } = setup((body) => {
      if (body === 'parent') {
        queue.enqueue('child');
      }
    });
    queue.enqueue('parent');
    expect((await pool.drain()).handled).toBe(2);
  });

  it('schedules retries with backoff and logs them', async () => {
    let calls = 0;
    const { clock, queue, pool, sink } = setup(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error('transient');
      }
    });
    queue.enqueue('a');
    expect(await pool.drain()).toEqual({ handled: 0, retried: 1, deadLettered: 0 });
    expect(sink.entries()[0]).toMatchObject({
      msg: 'message.retry_scheduled',
      level: 'warn',
      attempt: 1,
      delayMs: 50,
      error: { message: 'transient' },
    });

    clock.advance(50);
    expect(await pool.drain()).toEqual({ handled: 1, retried: 0, deadLettered: 0 });
    expect(sink.entries()[1]).toMatchObject({ msg: 'message.handled', attempt: 2 });
  });

  it('dead-letters a message that keeps failing and logs it', async () => {
    const { clock, queue, pool, sink } = setup(() => {
      throw new Error('permanent');
    }, 1, 2);
    queue.enqueue('a');
    await pool.drain();
    clock.advance(50);
    expect(await pool.drain()).toEqual({ handled: 0, retried: 0, deadLettered: 1 });
    expect(sink.messages()).toEqual(['message.retry_scheduled', 'message.dead_lettered']);
    expect(sink.entries()[1]).toMatchObject({ level: 'error', attempt: 2, body: 'a' });
    expect(queue.deadLetters.size).toBe(1);
  });

  it('shares one run between concurrent drain calls', async () => {
    const { queue, pool } = setup(async () => {
      await tick();
    });
    queue.enqueue('a');
    const [first, second] = await Promise.all([pool.drain(), pool.drain()]);
    expect(first).toBe(second);
    expect(first.handled).toBe(1);
  });

  it('does not count a completion whose lease was reclaimed by another consumer', async () => {
    const clock = new FixedClock(0);
    const sink = new MemoryLogSink();
    const queue = new InProcessQueue<string>({ clock, ids: new SeededIdGenerator(5), visibilityTimeoutMs: 1_000 });
    const pool = new WorkerPool<string>({
      queue,
      concurrency: 1,
      logger: new JsonLogger({ sink: sink.write, clock }),
      handler: async (_body, message) => {
        if (message.deliveryCount === 1) {
          clock.advance(1_000);
          expect(queue.hasDeliverable()).toBe(false);
          clock.advance(100);
          const redelivery = queue.lease()!;
          expect(redelivery.message.deliveryCount).toBe(2);
          queue.ack(redelivery.leaseId);
        }
      },
    });
    queue.enqueue('slow');
    expect(await pool.drain()).toEqual({ handled: 0, retried: 0, deadLettered: 0 });
    expect(sink.lines).toEqual([]);
    expect(queue.pendingCount + queue.inFlightCount).toBe(0);
  });

  it('requires a positive concurrency', () => {
    expect(() => setup(() => undefined, 0)).toThrow(RangeError);
  });
});
