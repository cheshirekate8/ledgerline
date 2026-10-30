import { ConcurrencyError, DomainError } from '../errors';
import { fingerprint } from '../stable-json';
import { Command, CommandHandler, CommandResult } from './command';
import { IdempotencyRecord, IdempotencyStore, InMemoryIdempotencyStore } from './idempotency-store';

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used for a different command`);
  }
}

export class UnknownCommandError extends Error {
  constructor(readonly commandType: string) {
    super(`No handler is registered for command ${commandType}`);
    this.name = 'UnknownCommandError';
  }
}

export interface CommandBusOptions {
  idempotency?: IdempotencyStore;
  /** How many times to reload and retry a command that lost an optimistic concurrency race. */
  maxConflictRetries?: number;
}

/**
 * Routes commands to their handlers and makes every handler idempotent.
 * A key that has already succeeded returns the original result without
 * running the handler; a concurrent execution of the same key waits for
 * and shares the first one's outcome. Only successful executions are
 * recorded, so a command rejected by a business rule may be retried later
 * under the same key.
 */
export class CommandBus<C extends Command = Command> {
  private readonly handlers = new Map<string, CommandHandler<C>>();
  private readonly idempotency: IdempotencyStore;
  private readonly maxConflictRetries: number;
  private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<CommandResult> }>();

  constructor(options: CommandBusOptions = {}) {
    this.idempotency = options.idempotency ?? new InMemoryIdempotencyStore();
    this.maxConflictRetries = options.maxConflictRetries ?? 3;
  }

  register<T extends C['type']>(type: T, handler: CommandHandler<Extract<C, { type: T }>>): this {
    if (this.handlers.has(type)) {
      throw new Error(`A handler for ${type} is already registered`);
    }
    this.handlers.set(type, handler as unknown as CommandHandler<C>);
    return this;
  }

  async execute(command: C): Promise<CommandResult> {
    if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.trim().length === 0) {
      throw new TypeError(`Command ${command.type} must carry a non-empty idempotency key`);
    }
    const handler = this.handlers.get(command.type);
    if (!handler) {
      throw new UnknownCommandError(command.type);
    }
    const commandFingerprint = fingerprint({ type: command.type, payload: command.payload });

    const running = this.inFlight.get(command.idempotencyKey);
    if (running) {
      assertSameCommand(command.idempotencyKey, running.fingerprint, commandFingerprint);
      const result = await running.result;
      return { ...result, duplicate: true };
    }

    const result = this.run(command, handler, commandFingerprint);
    this.inFlight.set(command.idempotencyKey, { fingerprint: commandFingerprint, result });
    try {
      return await result;
    } finally {
      this.inFlight.delete(command.idempotencyKey);
    }
  }

  private async run(command: C, handler: CommandHandler<C>, commandFingerprint: string): Promise<CommandResult> {
    for (let attempt = 0; ; attempt += 1) {
      const existing = this.idempotency.get(command.idempotencyKey);
      if (existing) {
        assertSameCommand(command.idempotencyKey, existing.fingerprint, commandFingerprint);
        return toResult(existing, true);
      }
      try {
        const outcome = await handler(command, {
          metadata: {
            idempotencyKey: command.idempotencyKey,
            commandType: command.type,
            commandFingerprint,
            ...(command.correlationId ? { correlationId: command.correlationId } : {}),
            ...(command.causationId ? { causationId: command.causationId } : {}),
          },
        });
        const record: IdempotencyRecord = {
          key: command.idempotencyKey,
          commandType: command.type,
          fingerprint: commandFingerprint,
          aggregateId: outcome.aggregateId,
          version: outcome.version,
          eventIds: outcome.events.map((event) => event.eventId),
        };
        this.idempotency.put(record);
        return toResult(record, false);
      } catch (error) {
        if (error instanceof ConcurrencyError && attempt < this.maxConflictRetries) {
          continue;
        }
        throw error;
      }
    }
  }
}

function assertSameCommand(key: string, recorded: string, incoming: string): void {
  if (recorded !== incoming) {
    throw new IdempotencyConflictError(key);
  }
}

function toResult(record: IdempotencyRecord, duplicate: boolean): CommandResult {
  return { aggregateId: record.aggregateId, version: record.version, eventIds: record.eventIds, duplicate };
}
