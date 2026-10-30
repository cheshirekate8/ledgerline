# Planning draft — 2026-10-30 (fourth session)

One task from the fourth planning session. This file is superseded by the Beads issue at
freeze; the issue is the canonical spec from then on. (Earlier sessions' drafts, for
`ledgerline-kml`, `ledgerline-lpi` and `ledgerline-gc4`, are in git history.)

## Task: Remember idempotency keys for a window

**Label:** hard · **Priority (proposed):** 1 · **Depends on:** nothing ·
**design-ref:** DESIGN.md §6.4 (with §2.4, §4.3, §6.2) ·
**Issue:** `ledgerline-aly` · **Frozen tests:** `tests/acceptance/ledgerline-aly/`

### Description

Idempotency keys stop living forever. A key is remembered for a window after its command
ran, 24 hours by default; within the window a repeated key behaves exactly as today, and
after it the key is forgotten, both in memory and when the store is rebuilt at start-up,
so a command sent under it runs as a new command. Because `republish()` can still re-send
any stored event of any age, every reaction the service sends itself must be harmless to
repeat on the strength of the aggregates' own state, without relying on a remembered key.

### Constraints

- A new option `idempotencyWindowMs` on `LedgerlineOptions`: a positive safe integer
  number of milliseconds, or `Number.POSITIVE_INFINITY` for forever. It defaults to
  `86_400_000` (24 hours). Any other value (zero, negative, fractional, `NaN`,
  `-Infinity`, an unsafe integer, a non-number) makes `createLedgerline` throw a
  `RangeError`.
  An option present but `undefined` counts as omitted, as for the other options.
- A key is remembered while the injected clock's time is before the moment its command
  ran plus the window, and forgotten from then on. The moment a command ran is the
  clock's time when its result is recorded, which is the `occurredAt` of the events it
  produced; for a key rebuilt at start-up it is read from those events.
- Forgotten means removed, not just ignored: keys past their window are dropped from
  memory no later than the next `execute()` call that gets as far as checking its key,
  whatever that command's outcome, and are not rebuilt at start-up. A new read-only
  method `idempotencyKeyCount()` on `Ledgerline` returns how many keys are held, so the
  bound can be observed; between a key's expiry and that next command it may still be
  counted. It counts the records the store actually keeps, never a figure filtered
  against the clock when read. Right after start-up it is the number of keys rebuilt.
  As today, a command that produced no events is remembered in memory but not rebuilt
  at start-up (reviewed, not frozen).
- A key reused after its window belongs to its latest use, in memory and when rebuilt at
  start-up: a repeat of the latest command is a duplicate returning only that
  execution's event ids, and a different command under it conflicts. At start-up a
  key's latest use is the stored events carrying it with the latest `occurredAt` (one
  command's events share one `occurredAt`), whatever window was in force when the
  earlier uses ran. (Today's rebuild merges every use of a key under its first command,
  which would raise a false conflict after a restart.)
- Within the window, everything about keys behaves as today: a repeat returns the
  original result with `duplicate: true` without running the handler, a different
  command under a used key throws `IdempotencyConflictError`, and concurrent deliveries
  of one key share one execution. After the window, a command under that key, the same
  command or a different one, simply runs.
- Every command the service sends itself (the fulfillment and payment processes, and the
  reservation-expiry service) is a no-op when its effect has already happened, judged by
  the aggregate's own state when the command is handled, so it is equally a no-op when a
  client sends the same command directly; `republish()` of any stored event, of any age,
  therefore changes nothing once the earlier work is done. In particular, `MarkOrderPaid` for
  the payment an order already accepted is a no-op in every later status (Shipped,
  Delivered, Refunded), so a re-sent `PaymentCaptured` never triggers the §4.3
  compensation refund. `MarkOrderPaid` naming any other payment is still refused, so a
  second payment for an already-paid order is still compensated. "Changes nothing" means
  state and stored events; a repeated warning in the log is not a change.
- A business-rule failure is still not recorded, so it can be retried under the same key
  (unchanged).
- Determinism (§2.2) holds: with an injected clock and ids, the same commands still give
  a byte-identical event log and log output.
- README's "Delivery guarantees" section states the window, its default, how to change
  it, and what a retry after it does (the list in DESIGN.md §6.4). Reviewed, not frozen.
- The existing integration test "restores read models and idempotency after a restart"
  (`tests/integration/replay-and-persistence.test.ts`) re-sends a `ShipOrder` key from
  before its scenario moves the clock 24 hours on, so it is expected to need updating
  (for example a forever window in that test); it is not frozen.
- The usual project rules in `CLAUDE.md`: injected clock and ids, no new dependencies,
  no file over 400 lines.

### Done means

Every test runs the whole service with a fixed clock starting at 2020-01-01T00:00:00Z
(years before the real date, so wall-clock time cannot pass for it), seeded ids, MUG at
1000 and CUP at 500 cents and no tax. `W` is 24 hours. Where a restart is needed, the log
is a JSON file in a temporary directory, and a restart is a new instance over it with
its own id seed. Exact key counts are asserted only in scenarios with no process-manager
traffic.

1. **The default window runs on the injected clock and ends exactly at `W`.** With the
   option omitted, a `ReceiveStock` of 3 under key K at T0: at T0+W−1 re-sending K is a duplicate with the original event
   ids and changes nothing, and a different payload under K is refused with
   `IDEMPOTENCY_CONFLICT`; at exactly T0+W re-sending K runs as new (`duplicate: false`,
   one new `StockReceived`, on-hand up 3), and a second key used at T0 takes a different
   command at T0+W and runs.
2. **The option is honoured and validated.** With a 60 000 ms window a key is a duplicate
   at +59 999 ms and runs as new at +60 000. With `Number.POSITIVE_INFINITY` a key is
   still a duplicate ten years later, including after a restart. `0`, `-1`, `1.5`, `NaN`,
   `-Infinity`, `2^53` and the string `"86400000"` make `createLedgerline` throw a
   `RangeError`; `1`, `Infinity` and an omitted option (24 hours) are accepted.
3. **Expired keys are removed, not just ignored, after any command that reaches its key
   check.** Five keys at T0 (the stock registration and four receipts) give a count of 5;
   three more at T0+12h give 8; after one more command (c1) at T0+24h the count is
   exactly 4; at T0+36h a command refused by a business rule (`ReceiveStock` on an
   unknown SKU) leaves exactly 1, c1.
4. **Start-up rebuilds only live keys, measured from when their commands ran, and a
   reused key belongs to its latest use.** Keys a1–a3 used at T0 and b1–b2 at T0+12h:
   restarted at T0+23h the count is 5 and a2 is a duplicate; at T0+24h, after one
   command under a new key c1, the count is 3 (b1, b2, c1), and a2 then runs as new.
   Restarted again at T0+30h the count is 4 (b1, b2, c1, a2), a2 is a duplicate
   returning only its T0+24h event ids, and a different command under a2 conflicts. A
   key used at T0 is rebuilt by a restart at T0+W−1 but not by one at exactly T0+W,
   after which re-sending it runs as new. A key reused after its window with a different command is, after
   a restart, a duplicate for the new command and a conflict for the old one.
5. **`MarkOrderPaid` for the payment the order accepted does nothing.** Sent under a fresh
   key to a Shipped, a Delivered and a fully Refunded order, it resolves with
   `duplicate: false` and no events, the log is unchanged, and once settled there is no
   new payment refund and no dead letter. [guard] Naming a different payment, it is
   still refused with `INVALID_ORDER_TRANSITION` in Paid, Shipped, Delivered and
   Refunded.
6. **`republish()` after the window changes nothing, in every reachable final state.**
   A store holds orders that are: delivered; shipped, credited and partly refunded;
   paid, partly refunded with restock, and credited; fully refunded while Paid; fully
   refunded after delivery; cancelled by the customer; cancelled out of stock; expired
   after a payment was captured and compensated; paid by one of two captured payments
   (the other compensated), then shipped and delivered; and placed with stock reserved
   but never paid. At T0+25h, after a restart, the key count is 0; `republish()` and
   processing leave the stored log, every order summary, the stock levels and every
   payment's refunds exactly as they were, with nothing dead-lettered. The same holds on
   the original instance without a restart, after one unrelated command at T0+25h.
7. [guard] **Inside the window, keys behave as today.** Two concurrent deliveries of one
   key run once (one result `duplicate: false`, one `true`, one event stored). A
   command refused by a business rule (`ReceiveStock` on an unknown SKU) is not
   remembered: once the SKU exists, the same key and payload run.
8. [guard] **Determinism.** The scenarios of criteria 4 and 6, run twice with the same
   clock and seeds across expiries, a restart and `republish()`, give byte-identical
   event logs and identical log output.

### Test map

| Criterion | Test file |
|---|---|
| 1 | `window-on-injected-clock.test.ts` |
| 2 | `window-option.test.ts` |
| 3 | `expired-keys-removed.test.ts` |
| 4 | `startup-rebuild.test.ts` |
| 5 | `mark-paid-accepted-payment.test.ts` |
| 6 | `republish-after-window.test.ts` |
| 7 (guard) | `within-window-unchanged.test.ts` |
| 8 (guard) | `determinism.test.ts` |

`harness.ts` is shared setup inside the frozen directory; it is not a test.

### Evidence gathered before approval

- **Red at the fork point:** against today's code 10 of 15 tests fail, each for the
  intended reason (no window, no `idempotencyKeyCount()`, no validation, `MarkOrderPaid`
  refused on a shipped order, a reused key conflicting). The 5 passing are the guard
  half of criterion 5, criteria 7 and 8, and criterion 2's "forever" case, which holds
  today because keys are never forgotten. The freeze gate reports RED with the control
  green, and counts 3 guards.
- **Can go green:** a throwaway implementation in a temporary worktree (since removed)
  passes all 15, typechecks, and passes all three earlier acceptance suites. Against it
  exactly one existing test fails, the integration test named in Constraints, for the
  reason given there.
- **Catches wrong implementations:** that implementation with one deliberate bug at a
  time; every one fails at least one test:

  | Mutation | Caught by |
  |---|---|
  | M1 keys never evicted | 1, 2, 3, 4, 6 |
  | M2 expired keys ignored on read but never removed | 3, 4, 6 |
  | M3 the window held one millisecond too long in memory | 1, 2, 3, 4 |
  | M4 every key rebuilt at start-up | 4, 6 |
  | M5 no key rebuilt at start-up | 2, 4 |
  | M6 start-up keeps a key at exactly its window end | 4 (the boundary restart only) |
  | M7 the window measured on wall-clock time | 1, 2, 3, 4 |
  | M8 a reused key rebuilt as its first use (today's merge) | 4 |
  | M9 `MarkOrderPaid` not made a no-op for the accepted payment | 5, 6, 8 |
  | M10 `MarkOrderPaid` a no-op for any payment once paid | 5 (guard half), 6, 8 |
  | M11 the window option not validated | 2 |
  | M12 a forever default | 1, 3, 4, 6 |
  | M13 keys pruned only when a command succeeds | 1, 2, 3, 4 |
  | M14 the service's own reaction keys exempt from expiry | 6 |

  A count filtered when read (T3) cannot be told from real removal by any test, so the
  Constraints define the count and review holds the implementation to it.

### Review dispositions

Criteria drafter (fresh context, read the code, traced every reaction against every later
state) wrote the eight criteria above; adopted with wording condensed.

| # | Source | Finding | Disposition |
|---|---|---|---|
| D1 | drafter | Only `MarkOrderPaid` is unsafe without its key, three ways: compensation refund for shipped goods; `REFUND_EXCEEDS_CAPTURED` dead letter on refunded or credited orders; a 0 refund on a zero-total shipped order | **Accepted**: one constraint covers all three; criteria 5 and 6 |
| D2 | drafter | An over-broad fix ("ever paid → no-op") would silently keep a second payment | **Accepted**: constraint keeps refusing other payments; guard half of criterion 5; paid-twice order in criterion 6 |
| D3 | drafter | Today's rebuild merges every use of a key under its first command | **Accepted**: a reused key belongs to its latest use (DESIGN §6.4, Constraints, criterion 4). Not put to the user: the earlier use is past its window by definition, so there is no other coherent answer |
| D4 | drafter | Re-sent compensation warnings on republish | **Accepted**: "changes nothing" means state and events, not logs; stated |
| D5 | drafter | The stated cost lists only double refunds | **Accepted**: DESIGN §6.4 and the README requirement list every effect |
| D6 | drafter | Event-less commands are not rebuilt at start-up (true today) | **Accepted**: stated; restart counts use event-producing commands only |
| D7 | drafter | "Next command" and the count before any command unclear | **Accepted**: whatever its outcome; after start-up the count is the keys rebuilt |
| D8 | drafter | No upper bound on the window | **Accepted**: safe integers only; `2^53` refused in criterion 2 |
| D9 | drafter | Exact counts must avoid process-manager keys; no test may touch the store's interface | **Accepted**: preamble states it |
| D10 | drafter | Settling moves the clock; criterion 6 needs its count of 0 to mean anything | **Accepted**: boundary steps do not settle; the count of 0 is asserted |
| S1 | scope | One task; hard fits; window and `markPaid` fix depend on each other | **Accepted**: no change |
| A1 | ambiguity | No rule for where a reused key's new use starts at rebuild | **Accepted**: the events with the latest `occurredAt`, whatever window applied before |
| A2 | ambiguity | Count between expiry and pruning undefined | **Accepted**: may still include it until the next command; tests read the count only after one |
| A3 | ambiguity | Where the no-op lives | **Accepted**: in handling the command, so a client sending it directly gets the same no-op (criterion 5 sends it directly) |
| A4 | ambiguity | "Reaction" vs "process manager"; expiry service unaddressed | **Accepted**: one term, expiry service named in scope |
| A5 | ambiguity | "The moment a command ran" undefined for in-memory keys | **Accepted**: clock time when the result is recorded, equal to its events' `occurredAt` |
| A6 | ambiguity | Explicit `undefined` | **Accepted**: counts as omitted |
| A7 | ambiguity | What counts as "the next command" for pruning | **Accepted**: an `execute()` call that reaches its key check |
| A8 | ambiguity | Criterion 4's "one command" readable two ways | **Accepted**: names the key c1 and lists the counted keys |
| T1 | testability | Exact counts depend on an unstated command sequence | **Accepted**: criteria 3 and 4 name every counted key; the tests pin the sequence |
| T2 | testability | The 24-hour default could go untested if the harness passes it explicitly | **Accepted**: criterion 1 runs with the option omitted |
| T3 | testability | A count filtered when read would pass while the store never shrinks | **Accepted**: Constraints define the count as records kept; not machine-checkable, so held in review |
| T4 | testability | Criterion 6's no-restart half would pass if process-manager keys were exempt | **Accepted**: already asserts a count of exactly 1 before republishing |
| T5 | testability | Pruning after a refused command is untested | **Accepted**: criterion 3's last step is a refused command |
| T6 | testability | The start-up boundary is untested | **Accepted**: restarts at T0+W−1 and exactly T0+W in criterion 4 |
| T7 | testability | "Event-less commands not rebuilt" has no criterion | **Accepted**: marked reviewed, not frozen; it is today's behaviour, unchanged |
| P1 | planner | Setup bug found at the red run: the expiry sweep also cancelled the order meant to stay reserved | **Fixed**: that order is placed after the sweep, and setup checks every order's final status |
