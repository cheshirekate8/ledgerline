# ledgerline

An event-sourced order and inventory service for a small online store, written in
strict TypeScript for Node 20. It has no database, no external services and no
network calls: state lives in an append-only event log, kept in memory or in a
newline-delimited JSON file, and everything runs offline.

```bash
npm install
npm test
```

## Contents

- [Architecture](#architecture)
- [Running and testing](#running-and-testing)
- [Using the service](#using-the-service)
- [Business rules](#business-rules)
- [Delivery guarantees](#delivery-guarantees)
- [Persistence, snapshots and event versions](#persistence-snapshots-and-event-versions)
- [Determinism](#determinism)
- [Logging](#logging)

## Architecture

```
            commands                           events
  caller ─────────────▶ CommandBus ─▶ handler ─▶ aggregate ─▶ EventStore (append-only)
                         (idempotent)                              │
                                                                   │ on append
                                                                   ▼
                                                           EventDispatcher
                                                                   │ one delivery per subscriber
                                                                   ▼
                                                  InProcessQueue (at-least-once, grouped)
                                                                   │
                                                                   ▼
                                                       WorkerPool (N concurrent)
                                                     ┌─────────────┴──────────────┐
                                                     ▼                            ▼
                                     projections (read models)        process managers
                                     OrderSummary, StockLevels,       fulfillment, payments
                                     DailyRevenue, CustomerHistory    (send further commands)
```

A command is applied synchronously: the handler loads the aggregate by replaying
its stream, the aggregate decides, and the new events are appended with an
optimistic concurrency check. Everything downstream — read models and the
process managers that coordinate orders, stock and payments — catches up when
queued messages are processed.

### Source layout

| Directory | What lives there |
|---|---|
| `src/shared/` | Clock, id generator, integer money and rounding, allocation, errors, JSON logger |
| `src/shared/events/` | Event shapes, the event store (memory and JSON file), upcaster registry, sequence tracking |
| `src/shared/aggregates/`, `src/shared/snapshots/` | Aggregate base class, repository, snapshot policy and store |
| `src/shared/messaging/` | Queue, retry policy, dead-letter queue, worker pool, event dispatcher, durable subscriber progress |
| `src/shared/commands/`, `src/shared/projections/` | Idempotent command bus, projection host |
| `src/pricing/` | Price list, discount codes, coupons, tax table, order pricing, refund proration |
| `src/orders/` | Order aggregate and lifecycle, commands, OrderSummary and CustomerHistory, process managers, reservation expiry |
| `src/inventory/` | InventoryItem aggregate (stock and reservations), commands, StockLevels |
| `src/payments/` | Payment aggregate (capture and refunds), commands, DailyRevenue |
| `src/app/` | `createLedgerline`, the composition root |

Domains depend on `shared` and on each other's command types only. Payments
asks orders whether an order can be paid through a small port
(`PayableOrderLookup`) rather than reading order internals.

## Running and testing

| Command | What it does |
|---|---|
| `npm test` | Every unit and integration test |
| `npm run test:unit` | Unit tests only (`tests/unit`, mirroring `src`) |
| `npm run test:integration` | End-to-end tests that drive the service through the queue and replay event streams |
| `npm run typecheck` | `tsc --noEmit` over sources and tests |
| `npm run build` | Compiles `src` to `dist` with declarations |

Tests never touch the network. The few that exercise the JSON file store write to
a temporary directory and remove it afterwards. Every test runs on a `FixedClock`
and a `SeededIdGenerator`, so results do not depend on when or where they run.

## Using the service

```ts
import { createLedgerline, FixedClock, SeededIdGenerator } from 'ledgerline';

const app = createLedgerline({
  catalog: {
    prices: { MUG: 1_999, TEE: 2_500 },            // unit prices, in cents
    taxRates: { 'US-CA': 825, DE: 1_900 },          // basis points: 825 = 8.25%
    discountCodes: [{ code: 'TEN', percentOffBasisPoints: 1_000 }],
    coupons: [{ code: 'FIVE', amountCents: 500 }],
  },
  persistence: { kind: 'json-file', path: './data/events.ndjson' }, // default: in memory
  workers: 4,
  retry: { maxAttempts: 5 },
  snapshots: { enabled: true, interval: 50 },        // default: disabled
  clock: new FixedClock('2026-06-01T09:00:00Z'),     // default: system clock
  ids: new SeededIdGenerator(42),                    // default: random UUIDs
});

await app.execute({
  type: 'RegisterInventoryItem',
  idempotencyKey: 'stock-mug',
  payload: { sku: 'MUG', name: 'Enamel mug', initialQuantity: 10 },
});
await app.execute({
  type: 'CreateOrder',
  idempotencyKey: 'create-o-1',
  payload: { orderId: 'o-1', customerId: 'alice', shippingRegion: 'US-CA' },
});
await app.execute({ type: 'AddOrderLine', idempotencyKey: 'line-1', payload: { orderId: 'o-1', sku: 'MUG', quantity: 3 } });
await app.execute({ type: 'PlaceOrder', idempotencyKey: 'place-o-1', payload: { orderId: 'o-1' } });

await app.processMessages();          // reserves stock; the order becomes payable
app.readModels.orderSummary.get('o-1');
```

`processMessages()` handles everything that is deliverable now and returns
counts of handled, retried and dead-lettered messages. Call it after commands,
or on an interval. `expireReservations()` should also run periodically; it
cancels unpaid orders whose reservation window has passed.

| Command | Payload |
|---|---|
| `CreateOrder` | `orderId`, `customerId`, `shippingRegion` |
| `AddOrderLine` / `RemoveOrderLine` | `orderId`, `sku`, `quantity` (optional `lineId`) / `orderId`, `lineId` |
| `ApplyDiscountCode` / `ApplyCoupon` | `orderId`, `code` |
| `PlaceOrder` | `orderId` |
| `CapturePayment` | `paymentId`, `orderId`, `amountCents` (must equal the order total), `method` |
| `ShipOrder` / `DeliverOrder` | `orderId`, `trackingNumber` / `orderId` |
| `CancelOrder` | `orderId`, `reason` (`customer-request` or `out-of-stock`) |
| `RefundOrderLine` | `orderId`, `lineId`, `quantity` (optional `refundId`) |
| `CreditOrder` | `orderId`, `amountCents`, `reason` (optional `creditId`) |
| `RegisterInventoryItem` / `ReceiveStock` | `sku`, `name`, optional `initialQuantity` / `sku`, `quantity` |

The process managers send the rest themselves: `ReserveStock`, `ReleaseStock`,
`ConfirmStockReservation`, `ReturnStock`, `RecordOrderStockReserved`,
`MarkOrderPaid`, `ExpireOrderReservation` and `RefundPayment`.

Broken rules are reported as typed errors that extend `DomainError`, each with a
stable `code`: `InvalidOrderTransitionError`, `RefundExceedsPaidError`,
`CreditExceedsRefundableError`, `ReservationExpiredError`,
`OrderAwaitingStockError`, `UnknownTaxRegionError` and so on.

## Business rules

These rules are enforced in code, and each one has tests.

### Money

All amounts are integer cents. The `Cents` type can only be produced by
`cents()`, which rejects anything that is not a safe integer, so a float cannot
reach a price, a total or a refund. Percentages are integer basis points, and
every multiplication or division of money runs on `bigint` with an explicit
rounding mode (`src/shared/rounding.ts`).

### Order total

`priceOrder` (`src/pricing/order-pricing.ts`) applies these steps in order:

1. Each line's gross amount is unit price × quantity.
2. Percentage discount codes are applied **per line**, each **rounded half to
   even**. Several codes compound, in the order they were applied.
3. The fixed-amount coupon comes off the discounted **order subtotal**. It is
   capped at that subtotal, so the subtotal never goes below zero. An order takes
   one coupon.
4. Tax is charged at the **shipping region's** rate on what remains, **rounded
   half up** once, on the order as a whole.

Worked example (US-CA, 8.25%): 3 × 19.99 and 1 × 25.00, code `TEN` (10%), coupon
`FIVE` (5.00).

| Step | Line A | Line B | Order |
|---|---|---|---|
| Gross | 59.97 | 25.00 | 84.97 |
| 10% discount, half-even per line | −6.00 | −2.50 | 76.47 |
| Coupon | | | −5.00 → 71.47 |
| Tax 8.25% on 71.47 = 5.896…, half up | | | +5.90 |
| **Total** | | | **77.37** |

The coupon and the tax are then allocated back to the lines by the largest
remainder method (A gets 3.53 of the coupon and 4.16 of the tax, B gets 1.47 and
1.74). Line totals therefore always sum exactly to the order total, and every
line knows exactly what was paid for it.

### Stock reservations

- Placing an order reserves stock for every SKU on it. The reservation expires
  **15 minutes** after placement (configurable with `reservationTtlMs`).
- An order can only be paid once all its stock is reserved
  (`OrderAwaitingStockError` otherwise). If any SKU is short, the order is
  cancelled as `out-of-stock` and whatever was reserved is released.
- An unpaid order whose window has passed is cancelled as `reservation-expired`
  by `expireReservations()`, and its reserved stock goes back to available.
  Payment is refused from the moment the window closes, even if the sweep has
  not run yet.
- Paying confirms the reservations, and the units leave stock.
- If a payment is captured just before the window closes but the order expires
  before the payment is applied, the payment is refunded in full automatically.
  The same happens to a second payment for an order that is already paid.

### Refunds

- Refunds are per line and per unit (`RefundOrderLine` with a `quantity`), and
  are allowed once an order is Paid, Shipped or Delivered.
- A refund carries that line's discount, coupon share and tax share **prorated
  to the refunded units**. Each line is split into units whose components are all
  non-negative and sum exactly to the line (`src/pricing/refund-pricing.ts`).
  Refunding a line one unit at a time therefore returns the same total as
  refunding it all at once.
- A refund can never exceed what was paid for the line: asking for more units
  than remain throws `RefundExceedsPaidError`. The payment independently refuses
  to refund more than was captured.
- Refunding the last paid unit of an order moves it to **Refunded**.
- **Units refunded while the order is Paid go back into stock** and are
  available to sell again: the stock has left inventory but the goods have not
  left the store. Refunds on a **Shipped** or **Delivered** order change no
  stock — the goods are with the carrier or the customer, and are received with
  `ReceiveStock` if they physically come back.
  The order decides this at refund time and records it as `returnsToStock` on
  the `OrderLineRefunded` event, so a refund that is processed after the order
  has shipped still returns its units. Inventory records each return as its own
  `StockReturned` event naming the order and the refund, never as
  `StockReceived`, so restocked units can be told apart from new deliveries.

### Credits: money back without returning goods

- A **credit** gives money back on an order without refunding any units, for
  example "5.00 off for the late delivery": `CreditOrder` with an `amountCents`
  and a `reason`. It is allowed in the same statuses as a unit refund (Paid,
  Shipped, Delivered) and refused elsewhere with `OrderNotRefundableError`. The
  amount must be a positive whole number of cents and the reason non-empty once
  trimmed; anything else is a `ValidationError`.
- A credit **changes neither the order's status nor stock**. An order that has
  been credited its whole balance stays Paid, Shipped or Delivered until its
  units are refunded.
- **The money returned on an order never exceeds what was paid.** Credits and
  unit refunds draw on one balance — paid minus everything returned so far, which
  the order works out from its own events. A credit larger than that balance
  throws `CreditExceedsRefundableError` and records nothing.
- **A credit comes off the last refunds.** A later unit refund still prorates as
  above, but pays back only what the balance has left. The `OrderLineRefunded`
  event keeps the prorated `refund` breakdown, which says what the units were
  worth, and carries `paidBackCents`, the money actually returned. A refund whose
  balance is exhausted still refunds its units, still restocks them and still
  moves the order to Refunded when it covers the last unit, but returns no money,
  so a fully refunded order has returned exactly what was paid.
- Only money that moves reaches the payment: the payment is refunded a credit's
  `amountCents` under the `creditId` and with the credit's reason, and a unit
  refund's `paidBackCents` under its `refundId`. A refund that pays back nothing
  sends no payment refund at all.
- **Credits and unit refunds share the order's refund ids.** A `CreditOrder` or
  `RefundOrderLine` carrying an id the order has already used, by either kind, is
  a no-op before any other check.
- The order summary's and the customer history's `refundedCents` count the money
  actually returned: credits plus `paidBackCents`. Daily revenue follows the
  payment, so it already counts both.

### Order states

The happy path is Draft → Placed → Paid → Shipped → Delivered. An order can be
cancelled until it is paid, and refunded once it has been.

| From | Allowed next states |
|---|---|
| Draft | Placed, Cancelled |
| Placed | Paid, Cancelled |
| Paid | Shipped, Refunded |
| Shipped | Delivered, Refunded |
| Delivered | Refunded |
| Cancelled, Refunded | none (terminal) |

Any other transition throws `InvalidOrderTransitionError` with `from` and `to`.
Lines, discount codes and the coupon can only change while the order is a Draft
(`OrderNotEditableError`).

## Delivery guarantees

**Idempotent commands.** Every command carries an `idempotencyKey`. A key that
has already succeeded returns the original result (`duplicate: true`) without
running the handler. Two concurrent deliveries of one key share a single
execution, and reusing a key for a different payload throws
`IdempotencyConflictError`. Keys are stored in the metadata of the events they
caused, so they are recognised again after a restart. A command that fails a
business rule is not recorded, so it can be retried under the same key later.

**At-least-once messaging.** A queued message is removed only when its handler
succeeds. A failure is retried after a backoff (fixed, or exponential with a
cap). After `maxAttempts` deliveries the message moves to the dead-letter queue,
where `app.deadLetters.list()` shows it and `app.redrive(id)` puts it back. A
handler that holds a message longer than the visibility timeout loses its lease,
and the message is delivered again.

**Ordering.** Each subscriber receives each aggregate's events one at a time and
in order, while different aggregates are processed concurrently by up to
`workers` handlers. A message waiting out a retry holds back the later events of
its aggregate for that subscriber.

**Duplicates and gaps.** Every event has a per-aggregate `sequence`. Projections
skip an event they have already applied and refuse one that skips ahead, with
`OutOfOrderEventError`. A gap is retried and then dead-lettered rather than
silently applied. Process managers derive the idempotency key of every command
they send from the event that caused it. Delivering any event any number of
times therefore changes state at most once.

**Restart recovery.** The queue itself is in memory, but over a file-backed
store (`persistence: { kind: 'json-file' }`) each named subscriber's **progress**
is not: which events it has finished handling, and which ended in the
dead-letter queue. Progress is written beside the event log, in the same
directory, so copying or removing that directory takes it along, and `durable`
decides whether those writes are fsynced just as it does for events.

That is enough to rebuild the queue, because every queued delivery is just "an
event this subscriber has not finished":

- When a named subscriber is registered — the built-in fulfillment and payment
  processes inside `createLedgerline`, anything else through `app.subscribe()` —
  everything it had not finished is queued for it at once, in stream order and
  ahead of events appended later. No call to `republish()` is needed.
- Progress is recorded only after a handler succeeds, so delivery stays
  at-least-once: a delivery in flight or waiting out a retry when the process
  stopped is delivered again, with a fresh retry budget. Attempt counts are not
  persisted.
- Dead letters survive as dead letters. They are listed from the moment the
  store is opened, keep their message ids, and are never retried on their own;
  `app.redrive(id)` still puts one back, and a redriven delivery that succeeds
  counts as finished.
- A subscriber is known from the moment it is first registered against a store.
  A name never registered against it starts at the end of the log and receives
  only events appended afterwards, so opening a log written before progress
  existed re-runs nothing.
- Read models resume nothing: they are rebuilt from the full log at start-up.
  In-memory and custom event stores have nothing to resume from and behave as
  they always have.
- Progress that cannot be read — damaged, truncated part-way through its last
  record, or naming events the log does not hold — makes `createLedgerline`
  throw an error naming the file, rather than being read as "nothing handled" or
  "everything handled".

`app.republish()` is unchanged: it sends every stored event to every subscriber
again. Built-in subscribers ignore what they have already handled, so
republishing at any time is safe.

## Persistence, snapshots and event versions

- **Event store.** Append-only, with no update or delete operations. The
  in-memory store is the default. The JSON file store writes one event per line,
  fsyncs each batch (unless `durable: false`), and on open validates every line
  and the continuity of every stream, reporting the line number of any damage.
  It never truncates. Beside it, `<log>.progress.ndjson` records each named
  subscriber's progress for that one log, so two logs in one directory keep
  separate progress; see [Delivery guarantees](#delivery-guarantees).
- **Read models** are rebuilt from the full event log at start-up, and on
  demand with `app.rebuildReadModels()`.
- **Snapshots** are off by default. When enabled, an aggregate's state is saved
  each time its stream crosses a multiple of `interval`, and loading resumes
  from the latest snapshot. Snapshots are a cache: a snapshot taken with an older
  state schema version is ignored, and an aggregate loaded from a snapshot is
  identical to one replayed from scratch.
- **Event versions.** Every event has a `type` and a `version`. Every schema is
  at v1 except `OrderLineRefunded`, which is at **v3**: it moved to v2 when it
  gained `returnsToStock` and to v3 when it gained `paidBackCents`. A stored v1
  refund is upcast with `returnsToStock: false`, because no refund restocked
  before that rule existed, and a stored v1 or v2 refund is upcast with
  `paidBackCents` equal to its prorated `refund.totalCents`, because every refund
  paid back its full total before credits existed. The `UpcasterRegistry`
  lifts an older stored event to the current version one step at a time as it is
  read, and refuses an unknown type, a version newer than it understands, or a
  gap in the upcaster chain. A further schema change declares the new version and
  registers its upcaster through `configureUpcasters`; stored events are never
  rewritten.

## Determinism

The clock and the id generator are injected everywhere. With a `FixedClock` and a
`SeededIdGenerator`, two runs of the same commands produce byte-identical event
logs and log output. The test suite asserts this, and also asserts that one
worker and eight workers reach the same read models.

## Logging

`JsonLogger` writes one JSON object per line, with `ts`, `level` and `msg`
followed by structured fields, to stdout or any injected sink. The worker pool
logs exactly one line per message outcome:

| `msg` | Level | When |
|---|---|---|
| `message.handled` | info | A subscriber handled an event |
| `message.retry_scheduled` | warn | A handler failed and a retry was scheduled (`delayMs`, `error`) |
| `message.dead_lettered` | error | A handler failed for the last time |

Each line names the subscriber, event id, type, version, aggregate, sequence and
delivery attempt. The service also logs `order.reservation_expired` and
`payment.compensated`.

## License

MIT. See [LICENSE](LICENSE).
