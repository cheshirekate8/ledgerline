import { DeadLetter } from './message';

/** Holds messages that exhausted their retries, for inspection and redrive. */
export class DeadLetterQueue<T> {
  private readonly entries = new Map<string, DeadLetter<T>>();

  add(entry: DeadLetter<T>): void {
    this.entries.set(entry.message.id, entry);
  }

  get(messageId: string): DeadLetter<T> | undefined {
    return this.entries.get(messageId);
  }

  remove(messageId: string): DeadLetter<T> | undefined {
    const entry = this.entries.get(messageId);
    this.entries.delete(messageId);
    return entry;
  }

  list(): readonly DeadLetter<T>[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}
