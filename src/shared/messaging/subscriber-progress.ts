import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A dead letter as it survives a restart: enough to rebuild its queue message. */
export interface DeadLetterProgress {
  readonly subscriber: string;
  readonly eventId: string;
  readonly messageId: string;
  readonly error: string;
  readonly deliveryCount: number;
  readonly enqueuedAt: number;
  readonly deadLetteredAt: number;
}

/**
 * What each named subscriber has finished handling and what it dead-lettered.
 * Together with the event log this is the whole queue (DESIGN §6.2): every
 * delivery is just "an event this subscriber has not finished".
 */
export interface SubscriberProgress {
  /**
   * The log position a subscriber resumes after for one aggregate type. A pair
   * never seen before is recorded as starting at `logLength`, so a name never
   * registered against this store only receives events appended from now on.
   */
  baseline(subscriber: string, aggregateType: string, logLength: number): number;
  hasFinished(subscriber: string, eventId: string): boolean;
  isDeadLettered(subscriber: string, eventId: string): boolean;
  recordFinished(subscriber: string, eventId: string): void;
  recordDeadLettered(entry: DeadLetterProgress): void;
  /** Every event whose latest outcome for its subscriber was the dead-letter queue. */
  deadLetters(): readonly DeadLetterProgress[];
}

/** Progress for a store with nothing to resume from: in-memory and custom stores. */
export const noSubscriberProgress: SubscriberProgress = {
  baseline: (_subscriber, _aggregateType, logLength) => logLength,
  hasFinished: () => false,
  isDeadLettered: () => false,
  recordFinished: () => undefined,
  recordDeadLettered: () => undefined,
  deadLetters: () => [],
};

/** An infrastructure fault: the progress stored beside an event log cannot be read. */
export class ProgressCorruptionError extends Error {
  constructor(
    readonly filePath: string,
    readonly lineNumber: number,
    reason: string,
  ) {
    super(`${filePath}:${lineNumber}: ${reason}`);
    this.name = 'ProgressCorruptionError';
  }
}

/** Where one event log's progress lives: beside it, named after it. */
export function progressPathFor(logPath: string): string {
  return `${logPath}.progress.ndjson`;
}

/** The part of an event log that progress is checked against. */
export interface LogIndex {
  readonly eventIds: ReadonlySet<string>;
  readonly length: number;
}

export interface FileSubscriberProgressOptions {
  /** Call fsync after each record, as the event log does. Defaults to true. */
  durable?: boolean;
}

type Outcome = 'finished' | DeadLetterProgress;

/**
 * Progress persisted as newline-delimited JSON beside its event log, one
 * record per line and only ever appended to. On open every line is validated
 * against the log, so progress that cannot be read stops start-up rather than
 * being taken as "nothing handled" or "everything handled".
 */
export class FileSubscriberProgress implements SubscriberProgress {
  private readonly durable: boolean;
  private readonly baselines = new Map<string, number>();
  private readonly outcomes = new Map<string, Outcome>();

  constructor(
    readonly filePath: string,
    log: LogIndex,
    options: FileSubscriberProgressOptions = {},
  ) {
    this.durable = options.durable ?? true;
    if (existsSync(filePath)) {
      this.load(log);
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  baseline(subscriber: string, aggregateType: string, logLength: number): number {
    const key = pairKey(subscriber, aggregateType);
    const known = this.baselines.get(key);
    if (known !== undefined) {
      return known;
    }
    this.baselines.set(key, logLength);
    this.append({ kind: 'registered', subscriber, aggregateType, position: logLength });
    return logLength;
  }

  hasFinished(subscriber: string, eventId: string): boolean {
    return this.outcomes.get(pairKey(subscriber, eventId)) === 'finished';
  }

  isDeadLettered(subscriber: string, eventId: string): boolean {
    const outcome = this.outcomes.get(pairKey(subscriber, eventId));
    return outcome !== undefined && outcome !== 'finished';
  }

  recordFinished(subscriber: string, eventId: string): void {
    const key = pairKey(subscriber, eventId);
    if (this.outcomes.get(key) === 'finished') {
      return;
    }
    this.outcomes.set(key, 'finished');
    this.append({ kind: 'finished', subscriber, eventId });
  }

  recordDeadLettered(entry: DeadLetterProgress): void {
    this.outcomes.set(pairKey(entry.subscriber, entry.eventId), entry);
    this.append({ kind: 'dead', ...entry });
  }

  deadLetters(): readonly DeadLetterProgress[] {
    const letters: DeadLetterProgress[] = [];
    for (const outcome of this.outcomes.values()) {
      if (outcome !== 'finished') {
        letters.push(outcome);
      }
    }
    return letters;
  }

  private append(record: object): void {
    const fd = openSync(this.filePath, 'a');
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
      if (this.durable) {
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
    }
  }

  private load(log: LogIndex): void {
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.length === 0) {
        return;
      }
      this.apply(this.parse(line, index + 1), index + 1, log);
    });
  }

  private parse(line: string, lineNumber: number): Record<string, unknown> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ProgressCorruptionError(this.filePath, lineNumber, 'line is not valid JSON');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ProgressCorruptionError(this.filePath, lineNumber, 'line is not a record');
    }
    return value as Record<string, unknown>;
  }

  private apply(record: Record<string, unknown>, lineNumber: number, log: LogIndex): void {
    const fail = (reason: string): never => {
      throw new ProgressCorruptionError(this.filePath, lineNumber, reason);
    };
    const text = (field: string): string => {
      const value = record[field];
      return typeof value === 'string' ? value : fail(`missing or invalid ${field}`);
    };
    const name = (field: string): string => {
      const value = text(field);
      return value.length > 0 ? value : fail(`missing or invalid ${field}`);
    };
    const whole = (field: string): number => {
      const value = record[field];
      return Number.isInteger(value) ? (value as number) : fail(`missing or invalid ${field}`);
    };
    const stored = (field: string): string => {
      const eventId = name(field);
      return log.eventIds.has(eventId) ? eventId : fail(`event ${eventId} is not in the log`);
    };

    switch (record['kind']) {
      case 'registered': {
        const position = whole('position');
        if (position < 0 || position > log.length) {
          fail(`position ${position} is outside the log`);
        }
        this.baselines.set(pairKey(name('subscriber'), name('aggregateType')), position);
        return;
      }
      case 'finished':
        this.outcomes.set(pairKey(name('subscriber'), stored('eventId')), 'finished');
        return;
      case 'dead': {
        const entry: DeadLetterProgress = {
          subscriber: name('subscriber'),
          eventId: stored('eventId'),
          messageId: name('messageId'),
          error: text('error'),
          deliveryCount: whole('deliveryCount'),
          enqueuedAt: whole('enqueuedAt'),
          deadLetteredAt: whole('deadLetteredAt'),
        };
        this.outcomes.set(pairKey(entry.subscriber, entry.eventId), entry);
        return;
      }
      default:
        fail(`unknown record kind ${JSON.stringify(record['kind'])}`);
    }
  }
}

/** Names and ids are opaque text, so they are joined by a character neither can hold. */
function pairKey(subscriber: string, suffix: string): string {
  return `${subscriber}\u0000${suffix}`;
}
