# Planning draft — 2026-10-30 (second session)

One task from the second planning session. This file is superseded by the Beads issue at
freeze; the issue is the canonical spec from then on. (The first session's draft, for
`ledgerline-kml`, is in git history.)

## Task: Credit an order by amount

**Label:** hard · **Priority (proposed):** 1 · **Depends on:** nothing ·
**design-ref:** DESIGN.md §5.4 (with §5.2, §5.3, §2.3, §2.4, §3.2) ·
**Issue:** `ledgerline-lpi` · **Frozen tests:** `tests/acceptance/ledgerline-lpi/`

### Description

A store owner can give a customer money back on a paid order without refunding any
units, such as "$5 off for the late delivery". The credit goes back to the customer's
payment and shows in the order's and the customer's refunded totals. Credits and unit
refunds draw on one balance, so the money returned on an order never exceeds what was
paid: a credit larger than the balance is refused, and a unit refund made after a
credit pays back only what the balance has left. The credit comes off the last refunds.

### Constraints

- A new command **`CreditOrder`** with payload `{ orderId, amountCents, reason }` and an
  optional `creditId`, generated when absent like `RefundOrderLine`'s `refundId`.
  `amountCents` must be a positive integer and `reason` non-empty after trimming;
  anything else throws `ValidationError` (`VALIDATION_FAILED`).
- `CreditOrder` checks in the same order as a unit refund: an id the order has already
  used is a no-op before anything else; then the status; then the input; then the
  balance.
- A credit is allowed while the order is Paid, Shipped or Delivered, the same statuses
  as a unit refund, and is refused in any other status with the error a unit refund
  gets there (`OrderNotRefundableError`). It never changes the order's status and never
  touches stock.
- The balance is paid minus everything returned so far (credits plus `paidBackCents`).
  The order computes it from its own events; `CreditOrder` never consults the payment,
  whose totals lag behind unsettled refunds and include compensation refunds (§4.3).
- A credit larger than the balance throws a
  new `DomainError` subclass, **`CreditExceedsRefundableError`**, with code
  **`CREDIT_EXCEEDS_REFUNDABLE`**. Nothing is recorded.
- A credit is recorded as a new order event **`OrderCredited`** (version 1) with payload
  `{ creditId, paymentId, amountCents, reason }`, with `reason` stored trimmed.
- **`OrderLineRefunded` moves to version 3**, adding **`paidBackCents`**: the money this
  refund actually returns, which is the prorated `refund.totalCents` or the remaining
  balance, whichever is smaller. The prorated `refund` breakdown, `returnsToStock` and
  every other field keep their meaning. Stored v1 and v2 events are upcast with
  `paidBackCents` equal to `refund.totalCents`; no stored event is rewritten (§2.3).
- Every other event type stays at its current version.
- A unit refund that pays back less than its prorated amount still refunds its units,
  still restocks under §5.3, and still moves the order to Refunded when it covers the
  last unit.
- Credits and unit refunds share the order's refund ids: a `CreditOrder` or
  `RefundOrderLine` whose id the order has already used, by either kind, is a no-op.
- The payments process refunds a credit's `amountCents`, and a unit refund's
  `paidBackCents`, on the order's payment. A unit refund with `paidBackCents` of 0 sends
  no payment refund. A credit's payment refund uses the `creditId` as its refund id,
  as a unit refund uses its `refundId`, and the credit's `reason` as its reason.
- `OrderRefunded`'s `totalRefundedCents` means the money returned on the order, credits
  plus `paidBackCents`, which on a fully refunded order equals the amount paid.
- The order summary's and customer history's `refundedCents` count the money actually
  returned: credits plus `paidBackCents`. Daily revenue already follows the payment.
  Neither read model gains a separate credit figure in this task; `OrderCredited` being
  its own event keeps that possible later.
- If the shape of the order's state changes, bump the order repository's
  `snapshotSchemaVersion` so order snapshots written before this change are ignored
  rather than misread (§6.3), as `ledgerline-kml` did for inventory.
- `src/orders/order.ts` is 296 lines and no file may exceed 400. Moving refund and credit
  arithmetic into a new module under `src/orders/` or `src/pricing/` is expected if
  needed.
- Existing unit tests that assert `OrderLineRefunded` is at version 2, or that count the
  order event types, are expected to need updating; they are not frozen.
- README's refund rules, command table and event-versions section describe credits,
  including that an order credited its whole balance stays in its status (Paid, Shipped
  or Delivered) until its units are refunded.
- The earlier task's frozen tests in `tests/acceptance/ledgerline-kml/` were updated at
  this freeze to expect `OrderLineRefunded` at version 3; they are part of this freeze
  and, like every acceptance test, must not be edited.
- The usual project rules in `CLAUDE.md`: integer cents, injected clock and ids, no new
  dependencies, no file over 400 lines.

### Done means

Prices are MUG 1000 and CUP 500 cents with no tax. "Settled" means the queue has drained
with nothing in the dead-letter queue; every test fails if a delivery dead-letters.
"Payment refunds" means the stored `PaymentRefunded` events for that order's payment.

1. **A credit returns money and changes nothing else.** On a paid order of MUG×3 (3000),
   crediting 500 with reason "late delivery" and id `c-1` stores one `OrderCredited` v1
   `{ creditId: 'c-1', paymentId, amountCents: 500, reason: 'late delivery' }`. Once
   settled: one payment refund of 500 with refund id `c-1` and reason "late delivery";
   the order is still Paid; MUG stock is unchanged
   and no `StockReturned` exists; the order summary and the customer history show
   `refundedCents` 500, the customer's lifetime spend is 2500, and daily revenue shows
   500 refunded in one refund. The same holds after rebuilding the read models. Every
   stored event other than `OrderLineRefunded` is at version 1.
2. **A credit comes off the last refunds, across the whole order.** On a paid order of
   MUG×2 and CUP×2 (3000), settling after each step: credit 700 (`c-1`), refund one MUG
   (`r-1`), refund both CUPs (`r-2`), refund the other MUG (`r-3`). The three
   `OrderLineRefunded` are version 3 with prorated `refund.totalCents` 1000, 1000, 1000
   and `paidBackCents` 1000, 1000, 300. The payment refunds, by refund id, are `c-1` 700,
   `r-1` 1000, `r-2` 1000, `r-3` 300. The order ends Refunded, `OrderRefunded` records
   `totalRefundedCents` 3000 (not 3700, which double-counts the credit), the summary
   shows 3000 refunded, and lifetime spend is 0. Every stored event other than
   `OrderLineRefunded`, including `OrderRefunded`, is at version 1.
3. **A refund with no balance left moves units and status but no money.** On a paid order
   of MUG×3 (3000), credit 3000: the order stays Paid. Refunding all 3 units then stores
   a v3 refund with `refund.totalCents` 3000, `paidBackCents` 0 and `returnsToStock`
   true; one `StockReturned` of 3 puts MUG back to on-hand 3 and available 3; the order
   moves to Refunded; the payment has exactly one refund (the credit's 3000); the summary
   shows 3000 refunded. A further credit of 1 is refused with `ORDER_NOT_REFUNDABLE`,
   while resending the original credit with its id is a no-op that throws nothing. Every
   stored event other than `OrderLineRefunded` is at version 1.
4. **A credit larger than the balance is refused, and unit refunds count against it.** On
   a paid order of MUG×3 (3000) with one unit refunded (1000 paid back): a credit of 2001
   throws a `DomainError` with code `CREDIT_EXCEEDS_REFUNDABLE` and records nothing (no
   `OrderCredited`, no new payment refund); a credit of 2000 then succeeds and the order
   stays Paid; a further credit of 1 is refused with `CREDIT_EXCEEDS_REFUNDABLE`.
5. **Credits follow the refund statuses and validate their input.** A credit of 100
   succeeds on a Paid, a Shipped and a Delivered order, leaving each status unchanged and
   refunding 100 on each payment. A credit is refused with `ORDER_NOT_REFUNDABLE` on a
   placed-but-unpaid, a cancelled and a Refunded order. An amount of 0, -5 or 1.5, and a
   reason that is empty or only spaces, are refused with `VALIDATION_FAILED`. Checks run
   in order: an amount of 0 on a cancelled order is refused with `ORDER_NOT_REFUNDABLE`,
   and an amount of 3000.5 on a 3000 order with `VALIDATION_FAILED`. Every refusal is a
   `DomainError` carrying that exact code. No refused credit stores an `OrderCredited`.
6. **Credits and unit refunds share refund ids, and every effect happens once.** On a
   paid order of MUG×3: credit `x` for 500; a unit refund with refund id `x` (under a
   different idempotency key) records nothing, returns no stock and leaves 500 refunded;
   a unit refund `y` followed by a credit with id `y` records no credit; a second credit
   `x` for 2000, more than the balance, is a no-op that throws nothing. Republishing
   every event and settling adds no payment refund, `OrderCredited` or `StockReturned`;
   the payment's refunds total 1500. A credit sent without an id is stored with a
   generated non-empty `creditId`, and refunded once under that same refund id.
7. **Stored v1 and v2 refunds read as fully paid back, and nothing stored is rewritten.**
   For a copy of an event log written before `ledgerline-kml` (fixture `v1-history.ndjson`:
   order `legacy`, MUG×3 paid 3000, one unit refunded as v1) and one written before this
   task (fixture `v2-history.ndjson`: the same, refunded as v2 while Paid, so one unit was
   restocked): a subscriber receives the old refund as version 3 with `paidBackCents`
   1000 (and, for v1, `returnsToStock` false); the stored record keeps its version and
   has no `paidBackCents`; the file's original bytes stay an unchanged prefix; the
   summary shows 1000 refunded. On each, a credit of 2001 is refused and a credit of 2000
   is accepted; refunding the remaining 2 units then stores a v3 refund with
   `paidBackCents` 0, adds no payment refund, and moves the order to Refunded. The
   payment's refunds total 3000, and MUG ends at on-hand 4 on the v1 log (its old refund
   never restocked) and 5 on the v2 log.
8. **An order snapshot written before this change is not misread.** With snapshots
   enabled, the v2 log, and the order's snapshot as the service wrote it before this
   change (fixture `v2-order-snapshot.json`: order `legacy` at sequence 6, Paid, 1000
   returned) in the snapshot store: a credit of 2001 is refused with
   `CREDIT_EXCEEDS_REFUNDABLE`, a credit of 2000 is accepted, and refunding the remaining
   2 units stores `paidBackCents` 0 and moves the order to Refunded. The payment's
   refunds total 3000, and the same holds after a restart and republish.

No criterion passes against today's code, so none is labelled a guard. The version check in
criterion 1 and the status refusals in criterion 5 re-check existing rules, but each sits
in a test whose other assertions are new.

### Test map

| Criterion | Test file |
|---|---|
| 1 | `credit-returns-money.test.ts` |
| 2 | `credit-comes-off-last-refunds.test.ts` |
| 3 | `exhausted-balance-refund.test.ts` |
| 4 | `credit-exceeds-refundable.test.ts` |
| 5 | `credit-statuses-and-validation.test.ts` |
| 6 | `shared-refund-ids.test.ts` |
| 7 | `stored-history-replay.test.ts` (fixtures `v1-history.ndjson`, `v2-history.ndjson`) |
| 8 | `old-order-snapshot.test.ts` (fixtures `v2-history.ndjson`, `v2-order-snapshot.json`) |

`harness.ts` is shared setup inside the frozen directory; it is not a test.

### Evidence gathered before approval

- **Red at the fork point:** against today's code all 14 tests fail, each for the
  intended reason (`CreditOrder` has no handler, or a stored refund still reads as v2).
  None fails in setup. The freeze gate reports RED with the control green, and 0 guards.
- **Can go green:** a throwaway implementation in a temporary worktree (since removed)
  passes all 14, typechecks, and passes the updated `ledgerline-kml` suite (14/14). The
  task agent does not see it and builds its own. Against it, the only unit tests that
  fail are the three named in Constraints (v2 assertions and the event-type list).
- **Catches wrong implementations:** that implementation with one deliberate bug at a
  time; every one fails at least one test:

  | Mutation | Caught by |
  |---|---|
  | M1 no cap: refunds always pay back their prorated total | 2, 3, 7, 8 |
  | M2 credit balance ignores unit refunds | 4, 7, 8 |
  | M3 status checked before a used id | 3 |
  | M4 balance checked before a used id | 3, 5, 6 |
  | M5 new state field, order snapshot schema not bumped | 8 |
  | M5 control: same field with the bump | passes all 14, so 8 tests the bump, not the field |
  | M6 read models count prorated totals | 2, 3 |
  | M7 a refund paying back nothing still sends a 0 payment refund | 3, 7 |
  | M8 stored v2 refunds upcast as paying back nothing | 7 |
  | M9 `OrderRefunded` also bumped to v2 | 2, 3 |
  | M10 a credit's payment refund not keyed by the credit id | 1, 2, 3, 4, 5, 6, 7 |
  | M11 a credit's reason not passed to the payment | 1, 3, 5, 6 |

- **Fixtures** were written by the service as it is today: `v2-history.ndjson` (13
  events, byte-identical across two generations) and `v2-order-snapshot.json` (taken from
  the same run with snapshots on, whose event log was byte-identical to the fixture).
  `v1-history.ndjson` is the `ledgerline-kml` fixture, copied.

### Review dispositions

Criteria drafter (fresh context, read the code) wrote the seven criteria above; adopted
with wording condensed.

| # | Source | Finding | Disposition |
|---|---|---|---|
| D1 | drafter | `ledgerline-kml`'s frozen tests assert `OrderLineRefunded` v2 and would go red | **Accepted**: the two assertions move to v3 in this freeze commit (planning-time, before the fork point); named in Constraints |
| D2 | drafter | `OrderRefunded.totalRefundedCents` undefined once credits exist | **Accepted**: defined as money returned; asserted in criterion 2 |
| D3 | drafter | A credit's payment refund id unspecified | **Accepted**: the `creditId`, in Constraints; not asserted, since ids are shared and cannot collide |
| D4 | drafter | Error for bad amount or reason unnamed; whitespace reason | **Accepted**: `ValidationError`, reason trimmed; criterion 5 |
| D5 | drafter | Order of checks implied, not stated | **Accepted**: id, status, input, balance, in Constraints; criterion 3 depends on it |
| D6 | drafter | A fully credited order staying Paid may look like a bug | **Accepted**: README must say so (Constraints) |
| D7 | drafter | README requirement not machine-checkable | **Accepted**: left to review, not frozen |
| S1 | scope | One task, correctly labelled hard; do not split | **Accepted**: no change |
| S2 | scope | Order snapshot schema unaddressed (§6.3) | **Accepted**: constraint, and criterion 8 with a real pre-change order snapshot |
| S3 | scope | `order.ts` near the 400-line limit; extraction not said to be allowed | **Accepted**: constraint says extraction is expected if needed |
| S4 | scope | §5.4's reason for a separate event is not used by any read model | **Accepted**: stated as deliberate; no credit field in this task |
| S5 | scope | Constraints carry two unasserted items (payment refund id, README) | **Accepted**: id left unasserted (ids are shared, so cannot collide); README left to review |
| A1 | ambiguity | Order snapshot schema (same as S2) | **Accepted**: see S2 |
| A2 | ambiguity | Balance source unclear: order or payment | **Accepted**: the order computes it from its own events, in Constraints |
| A3 | ambiguity | Whether read models gain a credit field (same as S4) | **Accepted**: see S4 |
| A4 | ambiguity | Stored `reason` trimmed or not | **Accepted**: stored trimmed, like `ship()` |
| A5 | ambiguity | Credit's payment refund reason unpinned | **Accepted**: the credit's reason; asserted in criterion 1 |
| T1 | testability | Nothing pins `OrderRefunded` (or `StockReturned`) at v1; only criterion 1 sweeps versions and it never fully refunds | **Accepted**: criteria 2 and 3 also sweep versions over logs that contain both |
| T2 | testability | Stated check order mostly unexercised | **Accepted**: id-before-status (criterion 3 resend), id-before-balance (criterion 6 repeat for 2000), status-before-input and input-before-balance (criterion 5) |
| T3 | testability | `totalRefundedCents` 3000 passes against today's code | **Accepted**: the definitions agree on every observable `OrderRefunded`; kept and labelled as the double-counting check it is |
| T4 | testability | creditId-as-payment-refund-id unasserted | **Accepted**: asserted in criteria 1 and 6; D3 superseded |
| T5 | testability | Loose `toThrow()` would accept `InvalidMoneyError` | **Accepted**: every refusal asserts `instanceof DomainError` and the exact `code` |
| T6 | testability | Delivery order in criterion 2 is an implementation detail | **Accepted**: settle after each step and assert refund id → amount |
