import { Clock, SystemClock, toIsoString } from './clock';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Receives one serialized JSON line per log entry. */
export type LogSink = (line: string) => void;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  sink?: LogSink;
  clock?: Clock;
  level?: LogLevel;
  fields?: LogFields;
}

/** Writes structured log entries as single-line JSON objects. */
export class JsonLogger implements Logger {
  private readonly sink: LogSink;
  private readonly clock: Clock;
  private readonly level: LogLevel;
  private readonly fields: LogFields;

  constructor(options: JsonLoggerOptions = {}) {
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.clock = options.clock ?? new SystemClock();
    this.level = options.level ?? 'info';
    this.fields = options.fields ?? {};
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  child(fields: LogFields): Logger {
    return new JsonLogger({
      sink: this.sink,
      clock: this.clock,
      level: this.level,
      fields: { ...this.fields, ...fields },
    });
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }
    const entry = { ts: toIsoString(this.clock.now()), level, msg: message, ...this.fields, ...fields };
    this.sink(JSON.stringify(entry, serializeSpecialValues));
  }
}

/** A sink that keeps every line in memory, for inspection in tests. */
export class MemoryLogSink {
  readonly lines: string[] = [];

  readonly write: LogSink = (line) => {
    this.lines.push(line);
  };

  entries(): LogFields[] {
    return this.lines.map((line) => JSON.parse(line) as LogFields);
  }

  messages(): string[] {
    return this.entries().map((entry) => String(entry['msg']));
  }
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function serializeSpecialValues(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}
