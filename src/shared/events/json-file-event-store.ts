import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { deepFreeze } from '../stable-json';
import { StoredEvent, streamKey } from './domain-event';
import { InMemoryEventStore } from './in-memory-event-store';

export class EventStoreCorruptionError extends Error {
  constructor(
    readonly filePath: string,
    readonly lineNumber: number,
    reason: string,
  ) {
    super(`${filePath}:${lineNumber}: ${reason}`);
    this.name = 'EventStoreCorruptionError';
  }
}

export interface JsonFileEventStoreOptions {
  /** Call fsync after each append so a batch survives a power loss. Defaults to true. */
  durable?: boolean;
}

/**
 * An event store persisted as newline-delimited JSON, one event per line.
 * The file is only ever appended to. On open, every line is validated so a
 * damaged log is reported rather than silently truncated.
 */
export class JsonFileEventStore extends InMemoryEventStore {
  private readonly durable: boolean;

  constructor(
    readonly filePath: string,
    options: JsonFileEventStoreOptions = {},
  ) {
    super();
    this.durable = options.durable ?? true;
    if (existsSync(filePath)) {
      this.commit(this.load());
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  protected override persist(records: readonly StoredEvent[]): void {
    const content = records.map((record) => `${JSON.stringify(record)}\n`).join('');
    const fd = openSync(this.filePath, 'a');
    try {
      writeSync(fd, content);
      if (this.durable) {
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
    }
  }

  private load(): StoredEvent[] {
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    const records: StoredEvent[] = [];
    const sequences = new Map<string, number>();
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      if (line.trim().length === 0) {
        return;
      }
      const record = this.parse(line, lineNumber);
      if (record.position !== records.length + 1) {
        throw new EventStoreCorruptionError(
          this.filePath,
          lineNumber,
          `expected position ${records.length + 1}, found ${record.position}`,
        );
      }
      const key = streamKey(record.aggregateType, record.aggregateId);
      const expectedSequence = (sequences.get(key) ?? 0) + 1;
      if (record.sequence !== expectedSequence) {
        throw new EventStoreCorruptionError(
          this.filePath,
          lineNumber,
          `expected sequence ${expectedSequence} for ${key}, found ${record.sequence}`,
        );
      }
      sequences.set(key, record.sequence);
      records.push(deepFreeze(record));
    });
    return records;
  }

  private parse(line: string, lineNumber: number): StoredEvent {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new EventStoreCorruptionError(this.filePath, lineNumber, 'line is not valid JSON');
    }
    const missing = missingFields(value);
    if (missing.length > 0) {
      throw new EventStoreCorruptionError(this.filePath, lineNumber, `missing or invalid ${missing.join(', ')}`);
    }
    return value as StoredEvent;
  }
}

function missingFields(value: unknown): string[] {
  if (value === null || typeof value !== 'object') {
    return ['record'];
  }
  const record = value as Record<string, unknown>;
  const checks: Array<[string, boolean]> = [
    ['eventId', typeof record['eventId'] === 'string'],
    ['type', typeof record['type'] === 'string'],
    ['version', Number.isInteger(record['version'])],
    ['aggregateType', typeof record['aggregateType'] === 'string'],
    ['aggregateId', typeof record['aggregateId'] === 'string'],
    ['sequence', Number.isInteger(record['sequence'])],
    ['position', Number.isInteger(record['position'])],
    ['occurredAt', typeof record['occurredAt'] === 'string'],
    ['payload', 'payload' in record],
    ['metadata', typeof record['metadata'] === 'object' && record['metadata'] !== null],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}
