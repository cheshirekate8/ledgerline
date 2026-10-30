import { describeError } from '../errors';
import { LogFields, Logger, silentLogger } from '../logger';
import { InProcessQueue } from './in-process-queue';
import { QueueMessage } from './message';

export type MessageHandler<T> = (body: T, message: QueueMessage<T>) => Promise<void> | void;

export interface WorkerPoolOptions<T> {
  queue: InProcessQueue<T>;
  handler: MessageHandler<T>;
  /** Number of messages processed concurrently. */
  concurrency: number;
  logger?: Logger;
  /** Extra fields that identify a message body in log lines. */
  describe?: (body: T) => LogFields;
}

export interface DrainReport {
  handled: number;
  retried: number;
  deadLettered: number;
}

/**
 * Runs up to `concurrency` handlers at once against a queue. Each handled
 * message, scheduled retry and dead-lettered message produces exactly one
 * structured log line.
 */
export class WorkerPool<T> {
  private readonly queue: InProcessQueue<T>;
  private readonly handler: MessageHandler<T>;
  private readonly concurrency: number;
  private readonly logger: Logger;
  private readonly describe: (body: T) => LogFields;
  private running: Promise<DrainReport> | undefined;

  constructor(options: WorkerPoolOptions<T>) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError(`Worker concurrency must be a positive integer, got ${options.concurrency}`);
    }
    this.queue = options.queue;
    this.handler = options.handler;
    this.concurrency = options.concurrency;
    this.logger = options.logger ?? silentLogger;
    this.describe = options.describe ?? (() => ({}));
  }

  /**
   * Processes messages until none is deliverable right now. Messages waiting
   * out a retry delay are left for a later drain. Concurrent calls share one
   * run rather than exceeding the concurrency limit.
   */
  drain(): Promise<DrainReport> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async run(): Promise<DrainReport> {
    const report: DrainReport = { handled: 0, retried: 0, deadLettered: 0 };
    while (this.queue.hasDeliverable()) {
      const workers = Array.from({ length: this.concurrency }, (_, index) => this.work(index + 1, report));
      await Promise.all(workers);
    }
    return report;
  }

  private async work(workerId: number, report: DrainReport): Promise<void> {
    for (let lease = this.queue.lease(); lease; lease = this.queue.lease()) {
      const { message } = lease;
      const fields = {
        worker: workerId,
        messageId: message.id,
        attempt: message.deliveryCount,
        ...this.describe(message.body),
      };
      try {
        await this.handler(message.body, message);
      } catch (error) {
        const outcome = this.queue.fail(lease.leaseId, describeError(error));
        if (outcome.kind === 'retry') {
          report.retried += 1;
          this.logger.warn('message.retry_scheduled', { ...fields, delayMs: outcome.delayMs, error });
        } else if (outcome.kind === 'dead-lettered') {
          report.deadLettered += 1;
          this.logger.error('message.dead_lettered', { ...fields, error });
        }
        continue;
      }
      if (this.queue.ack(lease.leaseId)) {
        report.handled += 1;
        this.logger.info('message.handled', fields);
      }
    }
  }
}
