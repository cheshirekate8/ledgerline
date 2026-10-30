import { EventMetadata, StoredEvent } from '../events/domain-event';

/**
 * A request to change state. The idempotency key identifies the intent: the
 * same key delivered twice changes state at most once.
 */
export interface Command<TType extends string = string, TPayload = unknown> {
  readonly type: TType;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface CommandContext {
  /** Metadata to attach to every event the handler saves. */
  readonly metadata: EventMetadata;
}

export interface HandlerOutcome {
  readonly aggregateId: string;
  readonly version: number;
  readonly events: readonly StoredEvent[];
}

export type CommandHandler<C extends Command> = (
  command: C,
  context: CommandContext,
) => HandlerOutcome | Promise<HandlerOutcome>;

export interface CommandResult {
  readonly aggregateId: string;
  readonly version: number;
  readonly eventIds: readonly string[];
  /** True when the idempotency key had already been processed and nothing was done. */
  readonly duplicate: boolean;
}
