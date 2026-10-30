import { DeadLetterQueue } from '../../../../src/shared/messaging/dead-letter-queue';
import { DeadLetter } from '../../../../src/shared/messaging/message';

const entry = (id: string): DeadLetter<string> => ({
  message: { id, groupKey: 'g', body: `body-${id}`, deliveryCount: 3, enqueuedAt: 0, availableAt: 0 },
  error: 'boom',
  deadLetteredAt: 10,
});

describe('DeadLetterQueue', () => {
  it('keeps dead letters by message id, in arrival order', () => {
    const queue = new DeadLetterQueue<string>();
    queue.add(entry('a'));
    queue.add(entry('b'));
    expect(queue.size).toBe(2);
    expect(queue.get('b')!.message.body).toBe('body-b');
    expect(queue.list().map((letter) => letter.message.id)).toEqual(['a', 'b']);
  });

  it('removes and returns an entry', () => {
    const queue = new DeadLetterQueue<string>();
    queue.add(entry('a'));
    expect(queue.remove('a')!.error).toBe('boom');
    expect(queue.remove('a')).toBeUndefined();
    expect(queue.size).toBe(0);
  });
});
