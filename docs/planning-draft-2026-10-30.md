# Planning draft — 2026-10-30 (third session)

One task from the third planning session. This file is superseded by the Beads issue at
freeze; the issue is the canonical spec from then on. (Earlier sessions' drafts, for
`ledgerline-kml` and `ledgerline-lpi`, are in git history.)

## Task: Resume unfinished work after a restart

**Label:** hard · **Priority (proposed):** 1 · **Depends on:** nothing ·
**design-ref:** DESIGN.md §6.2 (with §6.1, §2.2, §2.4) ·
**Issue:** `ledgerline-gc4` · **Frozen tests:** `tests/acceptance/ledgerline-gc4/`

### Description

With a file-backed event store, the service remembers each subscriber's progress: which
events it has finished handling and which ended in the dead-letter queue. After a
restart, every event a subscriber had not finished is delivered to it again, without
anyone calling `republish()`, and events it had finished are not delivered again. Dead
letters survive the restart as dead letters and can still be redriven. This covers the
built-in fulfillment and payment processes and any named subscriber added with
`subscribe()`.

### Constraints

- Applies when `persistence` is `{ kind: 'json-file' }`. Progress is stored in the same
  directory as the event log, so copying or removing that directory takes it along; its
  file name and format are the implementer's choice. The `durable` option governs
  whether progress writes are fsynced, as it does for events. In-memory and custom event
  stores behave exactly as today.
- A subscriber's progress is recorded only after its handler succeeds for an event, so
  delivery stays at-least-once (§2.4): a delivery in flight or waiting on a retry when the
  process stopped is delivered again after the restart.
- When a named subscriber is registered (the built-in ones inside `createLedgerline`,
  others through `subscribe()`), every event it had not finished, other than its dead
  letters, is queued for it at once, in stream order, ahead of anything appended later.
  It is not delayed until the first `processMessages()` (§6.1).
- A subscriber is known from the moment it is first registered against the store: from
  then on its unfinished events are tracked, even if it stops before finishing its
  first one. A name never registered against this store starts at the end of the log,
  as a new subscriber does today: it receives only events appended after it was
  registered. Opening a log written before this change therefore delivers nothing.
- A delivery's progress is written before `processMessages()` resolves, whatever
  `durable` is; `durable` only decides whether it is fsynced.
- Dead letters survive a restart: from the moment the store is opened,
  `deadLetters.list()` shows each one with its subscriber, event and error;
  `redrive(id)` puts it back on the queue; and it is never retried automatically. A dead
  letter that is redriven and then succeeds counts as finished, so it is not delivered
  again after a later restart. Redriving a dead letter whose subscriber is not
  registered behaves as it does today.
- A dead letter keeps its message id across restarts, so an id noted before a restart
  still redrives it afterwards. An event's latest outcome for a subscriber wins: if it
  is dead-lettered, it is listed; if it later succeeds (by redrive or a republished
  copy), it is finished and no longer listed.
- A known subscriber re-registered with an aggregate type it did not have before starts
  that type at the end of the log, as a new subscriber would.
- The backlog's order across different streams, and across subscribers, is the
  implementer's choice, provided each stream stays in order and the result is
  deterministic (§2.2). So is whether progress is written per delivery or once per
  drain: either keeps delivery at-least-once.
- The four read-model projections rebuild from the log on start, so whether they also
  resume is the implementer's choice; nothing here depends on it.
- Progress belongs to one event log file: two logs in one directory keep separate
  progress. Progress is the only thing besides that log's own file written to its
  directory. One instance per log at a time is assumed, as for the event log.
- Unfinished deliveries resume with a fresh retry budget; attempt counts are not
  persisted.
- `republish()` is unchanged and still sends every stored event to every subscriber.
- Progress that cannot be read is an error at start-up, never treated as "nothing
  handled" or "everything handled". A partial trailing record is unreadable too, as it
  is for the event log, and so is progress that refers to events the log does not
  contain. All of a log's progress is read when the store is opened, so
  `createLedgerline` throws, with a plain `Error` subclass (an infrastructure fault, not
  a `DomainError`) that names the file.
- Determinism (§2.2) holds: with an injected clock and ids, the same commands still give
  a byte-identical event log and log output.
- The worker pool's one-line-per-outcome log format is unchanged.
- README's "Delivery guarantees" section describes restart recovery and the role
  `republish()` still has; its statement that queued work is not persisted becomes wrong
  and must change. Reviewed, not frozen.
- The usual project rules in `CLAUDE.md`: injected clock and ids, no new dependencies,
  no file over 400 lines.

### Done means

Every test runs the whole service over a JSON-file event log in a temporary directory,
with a fixed clock (the logger uses it too, writing to a memory sink), seeded ids, MUG
at 1000 and CUP at 500 cents, no tax, and 3 delivery attempts with a fixed 100 ms
backoff. A **restart** is a new instance over the same directory, without calling
`close()` first, as after a crash; each instance over a directory gets its own id seed
and command keys that no earlier instance used. A **recorder** is a subscriber added
with `subscribe()` that records what it receives. "Handled lines" are the worker pool's
`message.handled` log lines.

1. **Built-in processes finish queued work after a restart, without `republish()`.**
   Order A is placed and processed; order B is placed but not processed; restart. Once
   the new instance has processed its messages, B's stock is reserved (MUG reserved 3
   of 5), every handled line for the fulfillment process names B and none names A, and
   each of B's unfinished events is handled once. Likewise a payment captured for B but
   not processed before a restart leaves B Paid afterwards.
2. **A recorder resumes exactly where it stopped, and its progress moves with the
   directory.** A recorder registered over an empty log sees orders A and B processed;
   more events for A and a new order C are left unprocessed; the directory is copied
   elsewhere and opened. After the recorder is registered again and messages are
   processed, it has received exactly the unprocessed events, each once, with each
   order's sequence numbers continuing from where that order stopped.
3. **The unfinished backlog is queued at registration, ahead of later events.** Order
   A's first events are left unprocessed for a recorder; restart; the recorder is
   registered, a further command on A runs before any processing, then messages are
   processed. Everything the recorder receives is exactly A's whole stream, sequence 1
   to the last, in order, each once, and nothing is dead-lettered.
4. **A delivery waiting on a retry when the process stopped is delivered again, with a
   fresh retry budget.** A recorder fails twice on A's `OrderPlaced` (two retries
   scheduled); restart before the third attempt; it fails once more, then succeeds. The
   new instance logs a retry at attempt 1, never dead-letters it, and the recorder
   receives `OrderPlaced` and then A's later events, in order.
5. **Dead letters survive a restart, are never retried on their own, and a redriven
   success stays finished.** A recorder that always fails dead-letters A's `OrderPlaced`
   with error "sink down"; restart. The dead-letter list shows it with the same
   subscriber, event and error; processing and moving the clock past several backoffs
   delivers nothing for it. Once the recorder is fixed, redriving it by the id the new
   instance lists delivers it once and empties the list; after another restart the list
   is still empty and the event is not delivered again.
6. [guard] **A subscriber never registered before starts at the end of the log.** A
   recorder with a new name, registered over a non-empty log, receives only events
   appended after it was registered. A copy of an event log written by today's code
   (fixture `pre-change-history.ndjson`: MUG stocked with 5, order A placed and
   processed, order B placed but not processed), opened alone in a directory, handles
   nothing for the built-in processes on the first processing (no handled lines for
   either), and B stays unreserved (MUG reserved 1) until `republish()` is called and
   processed.
7. **Unreadable progress stops start-up.** After work has been processed, the directory
   holds at least one file besides the event log. When every such file is overwritten
   with `\u0000not a record` (not empty, no trailing newline), creating the service over
   the directory throws. When instead every such file loses the end of its last record
   (its trailing newline and the 5 bytes before it removed), creating the service
   throws too.
8. [guard] **`republish()`, other stores and determinism are unchanged.** After a restart
   that resumed work, `republish()` returns the number of stored events and the recorder
   receives every order event at least once. A `JsonFileEventStore` passed as a
   `custom` store leaves nothing in its directory but its own file. Criterion 1's
   scenario, restart included, run twice in fresh directories gives a byte-identical
   event log and identical log lines, timestamps included.

### Test map

| Criterion | Test file |
|---|---|
| 1 | `built-in-processes-resume.test.ts` |
| 2 | `named-subscriber-resumes.test.ts` |
| 3 | `backlog-queued-at-registration.test.ts` |
| 4 | `retry-in-progress-resumes.test.ts` |
| 5 | `dead-letters-survive-restart.test.ts` |
| 6 (guard) | `unknown-subscriber-starts-at-end.test.ts` (fixture `pre-change-history.ndjson`) |
| 7 | `unreadable-progress-fails-start.test.ts` |
| 8 (guard) | `republish-and-other-stores-unchanged.test.ts` |

`harness.ts` is shared setup inside the frozen directory; it is not a test.

### Evidence gathered before approval

- **Red at the fork point:** against today's code 8 of 13 tests fail, each for the
  intended reason (nothing resumes, dead letters are gone, no progress exists). None
  fails in setup. The 5 passing tests are exactly the two labelled guards, criteria 6
  and 8. The freeze gate reports RED with the control green, and counts 2 guards.
- **Can go green:** a throwaway implementation in a temporary worktree (since removed)
  passes all 13, typechecks, and passes every existing test (366) and both earlier
  acceptance suites (`ledgerline-kml` and `ledgerline-lpi`, 14 each). The task agent
  does not see it and builds its own.
- **Catches wrong implementations:** that implementation with one deliberate bug at a
  time; every one fails at least one test:

  | Mutation | Caught by |
  |---|---|
  | M1 progress kept but no backlog queued | 1, 2, 3, 4 |
  | M2 everything re-sent on registration (ignores finished work) | 1, 2, 4, 5 |
  | M3 progress recorded before the handler succeeds | 4 |
  | M4 backlog queued lazily at the first `processMessages()` | 3 |
  | M5 dead letters lost on restart | 5 |
  | M6 dead letters retried automatically on restart | 5 |
  | M7 a never-registered subscriber treated as having handled nothing | 6 |
  | M8 unreadable progress lines skipped | 7 (both cases) |
  | M9 a torn last record tolerated, whole-file garbage still refused | 7 (torn case) |
  | M10 a redriven dead letter that succeeds is not recorded | 5 |
  | M11 progress only for the built-in subscribers | 2, 3, 4, 5 |
  | M12 progress decided by store type rather than persistence kind | 8 |
  | M13 a restored dead letter gets a new id | 5 |

  The two guards are therefore not decoration: M7 and M12 are caught only by them.
- **Fixture** `pre-change-history.ndjson` was written by the service as it is today
  (10 events, byte-identical across two generations).

### Review dispositions

Criteria drafter (fresh context, read the code) wrote the eight criteria above; adopted
with wording condensed.

| # | Source | Finding | Disposition |
|---|---|---|---|
| D1 | drafter | "No progress → start at end" drops the backlog of a subscriber that crashes before its first success | **Accepted**: a subscriber is known from first registration; DESIGN §6.2 amended; Constraints |
| D2 | drafter | When progress is written is unstated | **Accepted**: before `processMessages()` resolves; `durable` only governs fsync |
| D3 | drafter | When persisted dead letters are listed, and redrive of an unregistered subscriber | **Accepted**: listed from open; unregistered redrive behaves as today |
| D4 | drafter | Read-model hosts unaddressed | **Accepted**: implementer's choice, stated; criteria filter by subscriber |
| D5 | drafter | Torn trailing progress record | **Accepted**: unreadable, as for the event log |
| D6 | drafter | Criterion 6 deletes every non-log file, valid only if progress is all that is there | **Accepted**: Constraints say progress is the only other thing written there |
| D7 | drafter | README requirement not machine-checkable | **Accepted**: reviewed, not frozen |
| D8 | drafter | Two live instances on one directory unspecified | **Accepted**: one instance per directory assumed |
| D9 | drafter | Stream-order queuing is a needed "what"; per-event progress must not be frozen | **Accepted**: no change; criteria 2 and 5 exercise holes a single watermark cannot represent |
| D10 | drafter | A backlog consumes generated ids, so a restarted run differs from an unrestarted one | **Accepted**: criterion 8 compares two identical restarted runs |
| S1 | scope | One task of the right size; hard fits | **Accepted**: no change |
| A1 | ambiguity | A known name re-registered with a new aggregate type | **Accepted**: that type starts at the end of the log |
| A2 | ambiguity | What a restored dead letter carries; whether its id is stable | **Accepted**: id stable across restarts; asserted in criterion 5 |
| A3 | ambiguity | An event both finished and dead-lettered | **Accepted**: latest outcome wins |
| A4 | ambiguity | Progress written per delivery or per drain | **Accepted**: implementer's choice, stated; both keep at-least-once |
| A5 | ambiguity | Backlog order across streams and subscribers | **Accepted**: implementer's choice if per-stream order and determinism hold |
| A6 | ambiguity | Two logs in one directory; progress that disagrees with the log | **Accepted**: progress belongs to one log file; disagreement is unreadable |
| A7 | ambiguity | Where unreadable progress surfaces; error type | **Accepted**: all read at open, so `createLedgerline` throws a plain `Error` subclass naming the file |
| T1 | testability | Restarts need their own seed and command keys | **Accepted**: stated in the preamble; the harness does it |
| T2 | testability | Criterion 3 passes a backlog queued too late | **Accepted**: asserts the recorder's whole list equals A's whole stream |
| T3 | testability | Log timestamps use the system clock unless the logger is given the fixed one | **Accepted**: preamble pins it; criterion 8 compares timestamps too |
| T4 | testability | "Custom store writes nothing" is vacuous for an in-memory store | **Accepted**: uses a `JsonFileEventStore` passed as `custom` |
| T5 | testability | The torn-trailing-record constraint has no criterion | **Accepted**: second case in criterion 7 |
| T6 | testability | Garbage bytes unpinned; an empty file must not count | **Accepted**: literal non-empty content pinned |
| T7 | testability | Criterion 6's old log must be a checked-in fixture, not produced by deleting files | **Accepted**: fixture `pre-change-history.ndjson`, written by today's code |
