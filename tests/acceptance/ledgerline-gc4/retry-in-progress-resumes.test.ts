// Criterion 4: a delivery that was waiting on a retry when the process stopped is delivered
// again after the restart, with a fresh retry budget (attempt counts are not persisted).
import { StoredEvent } from '../../../src/shared/events/domain-event';
import { openStore, recorder, tempDirectory, trail } from './harness';

const isPlacedA = (event: StoredEvent) => event.aggregateId === 'A' && event.type === 'OrderPlaced';

describe('criterion 4: a retry in progress resumes', () => {
  let temp: ReturnType<typeof tempDirectory>;

  beforeEach(() => {
    temp = tempDirectory();
  });

  afterEach(() => {
    temp.remove();
  });

  it('delivers the event again with a fresh budget and never dead-letters it', async () => {
    const first = openStore(temp.directory, { seed: 11 });
    first.app.subscribe(recorder('audit', (event) => (isPlacedA(event) ? 'sink busy' : undefined)));
    await first.stock('MUG', 5);
    await first.placeOrder('A', [['MUG', 1]]);
    await first.app.processMessages();
    first.clock.advance(100);
    await first.app.processMessages();
    const retries = first.outcomes('message.retry_scheduled', 'audit');
    expect(retries.map((entry) => entry['attempt'])).toEqual([1, 2]);
    const placedId = String(retries[0]!['eventId']);
    expect(first.outcomes('message.dead_lettered')).toEqual([]);

    let failuresLeft = 1;
    const audit = recorder('audit', (event) => {
      if (isPlacedA(event) && failuresLeft > 0) {
        failuresLeft -= 1;
        return 'sink busy';
      }
      return undefined;
    });
    const second = openStore(temp.directory, { seed: 22, clock: first.clock });
    second.app.subscribe(audit);
    await second.settle();

    const resumedRetries = second.outcomes('message.retry_scheduled', 'audit');
    expect(resumedRetries.map((entry) => [entry['eventId'], entry['attempt']])).toEqual([[placedId, 1]]);
    expect(second.outcomes('message.dead_lettered')).toEqual([]);
    expect(second.app.deadLetters.list()).toEqual([]);

    const received = trail(audit.received);
    expect(received[0]).toBe('A#3');
    expect(audit.received[0]!.eventId).toBe(placedId);
    expect(received).toEqual(trail(second.app.store.readAll().filter((event) => event.aggregateId === 'A' && event.sequence >= 3)));
  });
});
