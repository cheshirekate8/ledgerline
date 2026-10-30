# DESIGN.md — ledgerline

The decisions behind ledgerline and why they were made. `README.md` says *how* the
service behaves; this file says *why it behaves that way* and what was rejected. It is
amended only through the change log at the bottom: when reality and this document
disagree, amend the document and record why, never silently drift.

Every pipeline task cites the section of this file it implements (`design-ref`). A task
that cites nothing is scope creep.

## 1. Purpose and scope

An order and inventory service for a small online store that can be trusted with money
and stock without a database: every state change is an event in an append-only log, and
every read model can be rebuilt from that log. It runs offline, in one process, with no
runtime dependencies.

Out of scope, deliberately: multi-currency, a real payment provider, multiple processes
writing one event store, and a network API. Each would change the guarantees in §2.

## 2. Invariants

These hold for every change. A task that needs one broken is a design change, not an
implementation detail.

### 2.1 Money is integer cents

No floating-point value ever touches an amount. Rates are integer basis points, and
every operation that divides money names its rounding mode. *Why:* rounding drift in a
ledger is invisible until a refund or a daily total is a cent off, and then it cannot
be traced.

### 2.2 Determinism

Time and identifiers are injected. Given a fixed clock and a seeded id generator, the
same commands produce a byte-identical event log and log output. *Why:* it makes every
scenario test exact, and it makes a production incident replayable.

### 2.3 Events are facts

The event store is append-only and stored events are never rewritten. An event's
payload shape is fixed for its `version`; a new shape is a new version, and older
stored events are upcast on read. *Why:* the log is the only source of truth, so a
change that rewrites it destroys the evidence of what happened.

### 2.4 Exactly-once effects over at-least-once delivery

Delivery is at-least-once, so every command is idempotent on its key and every reaction
to an event derives its command keys from that event. *Why:* this is the only way to get
exactly-once *effects* without distributed transactions.

## 3. Architecture

Commands are applied synchronously: load the aggregate by replaying its stream, decide,
append with an optimistic concurrency check. Read models and process managers react
asynchronously, through an in-process queue that delivers each aggregate's events to
each subscriber in order.

### 3.1 Process managers, not cross-aggregate transactions

An order, its stock and its payment are separate aggregates. They are coordinated by
two process managers — fulfillment (orders ↔ inventory) and payments (orders ↔
payments) — rather than by one handler writing several streams. *Rejected:* a single
handler that reserves stock and places the order together; with no transactions, a
failure halfway leaves stock reserved for an order that does not exist.

### 3.2 A process manager acts on what the event recorded

A process manager handles an event some time after it happened, and by then the
aggregate may have moved on. Any decision that depends on the aggregate's state *at the
time of the event* is therefore made by the aggregate and recorded in the event itself;
the process manager never reconstructs it from current state.

## 4. Orders

### 4.1 Lifecycle

Draft → Placed → Paid → Shipped → Delivered, with Cancelled reachable before payment
and Refunded after it. Invalid transitions throw typed errors. Expiry is a cancellation
with reason `reservation-expired`, not a separate state, so the set of states stays the
one a store owner already thinks in.

### 4.2 Payable only once stock is held

An order accepts payment only after every SKU on it is reserved. *Rejected:* letting
payment race the reservation; a paid order that then turns out to be out of stock needs
a refund the customer never asked for.

### 4.3 Payments the order cannot accept are refunded

A payment captured for an order that has since expired, or that another payment already
paid, is refunded in full by the payments process manager. Money is never kept for an
order that will not be fulfilled.

## 5. Pricing and refunds

### 5.1 Order of operations

Per-line percentage discounts (half to even), then a fixed coupon on the discounted
subtotal (capped at zero), then regional tax on what remains (half up, once per order).
Coupon and tax are allocated back to lines by largest remainder so that line totals sum
exactly to the order total.

### 5.2 Refunds are per unit

A refund names a line and a quantity of units. Each line is split into units whose
discount, coupon and tax shares are non-negative and sum exactly to the line, so partial
refunds prorate correctly and can never exceed what was paid. Money given back by
amount rather than by unit is a credit (§5.4), which carries its own rule for how it
interacts with later unit refunds.

### 5.3 Refunded units that never shipped go back into stock

When units are refunded while the order is **Paid** — the stock has been confirmed out
of inventory but the goods have not left — those units return to the SKU's stock and are
available to sell again. Refunds on **Shipped** or **Delivered** orders do not restock:
the goods are with the carrier or the customer, and if they come back they are received
with `ReceiveStock` when they physically arrive.

- *Rejected:* restocking on every refund. It would create stock for goods that were
  never returned.
- *Rejected:* deciding in the fulfillment process from the order's current status. By
  the time the process handles the refund the order may have shipped, so it would get
  the answer wrong (§3.2).
- **The order records the decision.** At refund time the order states, in the refund
  event, whether the refunded units return to stock. This changes the payload of
  `OrderLineRefunded`, so it moves to version 2 (§2.3). Version 1 events are upcast as
  *not* returning to stock, because before this rule existed no refund restocked; replay
  must not invent stock for history.
- **Inventory records the return as its own event**, naming the order and the refund,
  distinct from `StockReceived`, so restocked units can be told apart from new
  deliveries.
- **Exactly once (§2.4):** a redelivered refund event or a repeated command returns the
  units once.

### 5.4 Credits: money back without returning goods

A credit gives a customer money back on a paid order without refunding any units, for
example "$5 off for the late delivery". It names an amount and a reason, is allowed in
the same statuses as a unit refund (Paid, Shipped, Delivered), and changes neither the
order's status nor stock.

- **The money returned on an order never exceeds what was paid.** Credits and unit
  refunds draw on one balance: paid minus everything returned so far. A credit larger
  than that balance is refused with a typed error.
- **A credit comes off the last refunds.** A later unit refund still prorates as in
  §5.2, but pays back only what the balance has left, so a $100 order credited $5 and
  then refunded in full returns $95 for the goods and $100 in all. A refund whose
  balance is exhausted still refunds its units, still restocks under §5.3, and still
  moves the order to Refunded when it is the last unit, but returns no money. A fully
  refunded order has therefore returned exactly what was paid.
  - *Rejected:* refusing a unit refund that no longer fits. After a large credit some
    goods could then never be returned through the system.
  - *Rejected:* limiting a credit to the balance left after setting aside the value of
    every unrefunded unit. That leaves no room for a credit until goods come back,
    which defeats the purpose.
- **The refund event records the money actually returned.** `OrderLineRefunded` keeps
  its prorated breakdown, which says what the units were worth, and gains the amount
  paid back, which can now be smaller. That changes its payload, so it moves to
  version 3 (§2.3). Stored v1 and v2 refunds are upcast as having paid back their full
  prorated total, which is what happened before credits existed.
- **A credit is its own event**, naming the order's payment, the amount and the reason,
  so a read model can tell goodwill apart from returned goods.
- **Credits and unit refunds share the order's refund ids.** A command repeated with an
  id the order has already used, by either kind, is a no-op (§2.4).
- **Only money that moves reaches the payment.** The payments process refunds a
  credit's amount and a unit refund's amount paid back; a unit refund that pays back
  nothing sends no payment refund.

## 6. Messaging and persistence

### 6.1 Ordering per aggregate, concurrency across aggregates

The queue groups deliveries by subscriber and aggregate. A failing delivery holds back
later events of the same aggregate for that subscriber, and projections refuse to skip a
gap in a stream. *Rejected:* a single global order, which would serialise the whole
store behind one slow handler.

### 6.2 Work resumes after a restart

The queue itself stays in memory, but with a file-backed event store each subscriber's
**progress** is durable: which events it has finished handling, and which ended in the
dead-letter queue. Every queued delivery is just "an event this subscriber has not
finished", so progress plus the event log is the whole queue, and nothing else needs
persisting.

- **A subscriber resumes where it stopped.** When a named subscriber is registered over
  a store that has its progress, every event it had not finished is queued for it
  again, in stream order, before anything newer. Events it had finished are not
  delivered again. Delivery stays at-least-once (§2.4): progress is recorded only after
  a handler succeeds, so a delivery that was in flight when the process stopped is
  delivered again.
- **Queued at registration, not at the first drain.** If the backlog waited for the
  first `processMessages()`, a command executed in between could queue a stream's new
  events ahead of its unfinished old ones, breaking §6.1.
- **Dead letters survive a restart as dead letters.** They are listed and can be
  redriven by id as before, and they are not retried automatically: a dead letter means
  a person needs to look, and a restart must not quietly retry or hide it.
- **A subscriber is known from the moment it is first registered** against the store,
  and from then on its unfinished events are tracked, even if it crashes before
  finishing its first one. Only a name never registered against this store starts at the
  end of the log, which is what a new subscriber gets today. Opening a log written
  before this change therefore re-runs nothing.
- **Unfinished deliveries resume with a fresh retry budget.** Attempt counts are not
  persisted; a delivery that keeps failing dead-letters again after `maxAttempts`.
- `republish()` is unchanged and still sends every stored event to every subscriber.
- *Rejected:* republishing every stored event on start. It would work (§2.4), but its
  cost grows with history, and it depends on the idempotency store remembering every
  key forever, which blocks ever bounding that store.
- *Rejected:* persisting the queue's messages themselves. They are derived from the
  event log, so storing them duplicates the log and lets the two disagree.
- An in-memory or custom event store has nothing to resume from, so nothing changes for
  them.

### 6.3 Snapshots are a cache

Off by default, versioned by state schema, and never required for correctness: an
aggregate loaded from a snapshot is identical to one replayed from scratch.

### 6.4 Idempotency keys are remembered for a window

A command's idempotency key is remembered for a configurable window after the command
ran, **24 hours by default**, measured on the injected clock; the window can be set to
forever. Within the window a repeated key behaves exactly as before (§2.4). After it, the
key is forgotten: removed from memory, not rebuilt at start-up, and a command sent under
it runs as a new command.

- **The window is a promise to callers, not to the service's own reactions.** Clients
  retry within seconds or minutes; 24 hours matches common payment-API practice. A
  caller that retries later gets the command run as new: a refund or credit without an
  explicit id refunds twice, `ReceiveStock` adds stock twice, a line without an explicit
  id is added twice, and commands whose effect can only happen once (`CreateOrder`,
  `PlaceOrder`, `CapturePayment`) fail with their business error instead of returning
  `duplicate`. That is the stated cost.
- **A key reused after its window belongs to its latest use**, including when keys are
  rebuilt at start-up; its earlier use is past the window by definition.
- **The service's own reactions must not depend on remembered keys.** Since §6.2,
  recovery no longer re-sends finished work, but `republish()` still re-sends every
  stored event, of any age. Every command a process manager sends must therefore be a
  no-op when its effect has already happened, judged by the aggregate's own state rather
  than by the key. A re-sent `PaymentCaptured` for an order that has since shipped must
  not be mistaken for "the order cannot accept this payment" and refunded (§4.3).
- *Rejected:* keeping the last N keys. Memory is predictable, but how long a key
  survives then depends on traffic, so a caller cannot know its safe retry window.
- *Rejected:* forever by default with an opt-in window. It leaves the store unbounded for
  anyone who does not configure it, which is the problem this section exists to fix.

## 7. Change log

Rows are chronological, oldest first; append new rows at the bottom. A row is identified
by the slug in its `Ref` column: a pipeline task's issue id, or a short kebab-case name
for a planning session. Cite a row as change-log row followed by its slug in backticks.

| Date | Ref | Change | Why |
|---|---|---|---|
| 2026-10-30 | `initial-design` | Recorded the decisions made while building the service: §1–§4, §5.1–§5.2 and §6 | The README described behaviour but not the reasons or the rejected alternatives, and pipeline tasks need a design section to cite |
| 2026-10-30 | `restock-unshipped-refunds` | Added §3.2 (process managers act on what the event recorded) and §5.3 (refunded units of a paid, unshipped order return to stock; `OrderLineRefunded` moves to v2) | First planning session. Refunded but unshipped stock was stranded until someone ran `ReceiveStock` by hand |
| 2026-10-30 | `refund-by-amount` | Added §5.4 (credits by amount; money returned never exceeds what was paid; a credit comes off the last refunds; `OrderLineRefunded` moves to v3) and reworded §5.2, which had rejected refunds by amount for want of this rule | Second planning session. Goodwill credits had no home because refunds were per unit only |
| 2026-10-30 | `resume-after-restart` | Replaced §6.2 (the queue is in memory; recovery by `republish()`) with durable per-subscriber progress over a file-backed store: unfinished work resumes on registration, dead letters survive as dead letters, unknown subscribers start at the end of the log | Third planning session. Queued work was lost on restart until someone remembered `republish()`, and republish-everything recovery blocks bounding the idempotency store |
| 2026-10-30 | `bounded-idempotency` | Added §6.4 (idempotency keys are remembered for a configurable window, 24 hours by default; process managers' commands must be no-ops by aggregate state, not by key) | Fourth planning session. The store held every key forever and rebuilt them all at start-up; §6.2 made bounding it safe for recovery, and `republish()` showed which reactions still leaned on keys |
