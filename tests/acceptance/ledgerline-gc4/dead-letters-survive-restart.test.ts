// Criterion 5: dead letters survive a restart as dead letters. They are listed from the
// moment the store is opened, never retried on their own, and once redriven successfully
// they stay finished across a later restart.
import { StoredEvent } from '../../../src/shared/events/domain-event';
import { openStore, recorder, tempDirectory } from './harness';

const isPlacedA = (event: StoredEvent) => event.aggregateId === 'A' && event.type === 'OrderPlaced';

describe('criterion 5: dead letters survive a restart', () => {
  let temp: ReturnType<typeof tempDirectory>;

  beforeEach(() => {
    temp = tempDirectory();
  });

  afterEach(() => {
    temp.remove();
  });

  it('keeps them dead-lettered, redrives them by id, and does not deliver them again', async () => {
    const first = openStore(temp.directory, { seed: 11 });
    first.app.subscribe(recorder('audit', (event) => (isPlacedA(event) ? 'sink down' : undefined)));
    await first.stock('MUG', 5);
    await first.placeOrder('A', [['MUG', 1]]);
    await first.settle({ allowDeadLetters: true });
    const [dead] = first.app.deadLetters.list();
    expect(first.app.deadLetters.list()).toHaveLength(1);
    const placedId = dead!.message.body.event.eventId;
    expect(dead!.message.body.subscriber).toBe('audit');

    const second = openStore(temp.directory, { seed: 22, clock: first.clock });
    const listedAtOpen = second.app.deadLetters.list();
    expect(listedAtOpen.map((letter) => [letter.message.body.subscriber, letter.message.body.event.eventId, letter.error])).toEqual([
      ['audit', placedId, dead!.error],
    ]);
    // The id noted before the restart still names it.
    expect(listedAtOpen[0]!.message.id).toBe(dead!.message.id);

    let attempts = 0;
    const audit = recorder('audit', (event) => {
      if (isPlacedA(event)) {
        attempts += 1;
        return 'sink down';
      }
      return undefined;
    });
    second.app.subscribe(audit);
    await second.settle({ allowDeadLetters: true });
    for (let round = 0; round < 5; round += 1) {
      second.clock.advance(1_000);
      await second.app.processMessages();
    }
    expect(attempts).toBe(0);
    expect(second.sink.entries().filter((entry) => entry['eventId'] === placedId)).toEqual([]);
    expect(second.app.deadLetters.list()).toHaveLength(1);

    audit.failWhen = () => undefined;
    expect(second.app.redrive(dead!.message.id)).toBe(true);
    await second.settle();
    expect(audit.received.filter((event) => event.eventId === placedId)).toHaveLength(1);
    expect(second.app.deadLetters.list()).toEqual([]);

    const third = openStore(temp.directory, { seed: 33, clock: second.clock });
    expect(third.app.deadLetters.list()).toEqual([]);
    const later = recorder('audit');
    third.app.subscribe(later);
    await third.settle();
    expect(later.received.filter((event) => event.eventId === placedId)).toEqual([]);
  });
});
