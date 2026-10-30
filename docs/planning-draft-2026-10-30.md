# Planning draft — 2026-10-30

One task from the first planning session. This file is superseded by the Beads issue at
freeze; the issue is the canonical spec from then on.

## Task: Return refunded units of unshipped orders to stock

**Label:** medium · **Priority (proposed):** 1 · **Depends on:** nothing ·
**design-ref:** DESIGN.md §5.3 (with §3.2, §2.3, §2.4) ·
**Issue:** `ledgerline-kml` · **Frozen tests:** `tests/acceptance/ledgerline-kml/`

### Description

When units of an order line are refunded while the order is **Paid** (its stock has been
confirmed out of inventory but nothing has shipped), those units go back into the SKU's
on-hand stock and become available to sell again. Refunds on **Shipped** or **Delivered**
orders do not change stock. The order records the decision in the refund event, and
inventory records each return as its own event.

### Constraints

- The order makes the decision at refund time and records it in the event:
  `OrderLineRefunded` is written at **version 2** with a boolean `returnsToStock` added to
  the existing payload (`refundId`, `lineId`, `paymentId`, `refund` keep their meaning).
  The fulfillment process acts on that field and never on the order's current status
  (DESIGN.md §3.2).
- Version 1 `OrderLineRefunded` events stay readable: register an upcaster that adds
  `returnsToStock: false`. No stored event is rewritten (§2.3).
- Inventory records each return as a new event type **`StockReturned`** (version 1) on the
  SKU's `inventory-item` stream, with payload `{ orderId, refundId, quantity }`. Never
  record a return as `StockReceived`.
- Each refund returns its units exactly once, under redelivery, repeated commands and
  restart-then-republish. Two different orders may use the same `refundId`; a return is
  identified by the order and the refund together (§2.4).
- Every other event type stays at its current version.
- An inventory snapshot written before this change must not be misread: if the shape of
  the inventory aggregate's state changes, bump the inventory repository's
  `snapshotSchemaVersion` so old snapshots are ignored.
- Do not change refund amounts, the payment refund flow or pricing.
- Existing unit tests that assert `OrderLineRefunded` is at version 1, or that count the
  event types, are expected to need updating; they are not frozen.
- The usual project rules in `CLAUDE.md`: integer cents, injected clock and ids, no new
  dependencies, no file over 400 lines.

### Done means

"Settled" below means `processMessages()` has drained the queue with nothing ending in
the dead-letter queue. Every test fails if a delivery dead-letters, so an unchanged
result can never come from a handler that threw.

1. Refunding a **Paid** order stores `OrderLineRefunded` at version 2 with
   `returnsToStock: true`; refunding a **Shipped** or a **Delivered** order stores
   version 2 with `returnsToStock: false`. The other payload fields keep their values.
2. Receive 3 MUG, sell and confirm all 3, refund 2: once settled, the stock-levels read
   model shows on-hand 2 and available 2, and MUG's stream holds exactly one
   `StockReturned` `{ orderId, refundId, quantity: 2 }` and no new `StockReceived`. The
   inventory aggregate agrees: a later order for 2 MUG gets its stock reserved, and a
   following order for 1 more is cancelled as out-of-stock. Fully refunding a Paid
   two-line order moves it to Refunded and returns every line's units, one
   `StockReturned` per refund.
3. With the order Paid and its stock confirmed, `RefundOrderLine` and `ShipOrder` run back
   to back with no message processing between them: once settled, the refunded unit is
   back in stock. A refund made after that, on the Shipped order, returns nothing and
   records `returnsToStock: false`.
4. After a return has happened (one `StockReturned`, stock raised), republishing every
   event, repeating the refund command under the same or a new idempotency key, and
   restarting from the JSON file store then republishing all leave stock and the
   `StockReturned` count unchanged. Two Paid orders **for the same SKU** refunded with the
   same `refundId` and different quantities produce two `StockReturned` events, and
   on-hand rises by the sum.
5. A copy of an event log written before this change (a Paid order with a stored v1
   `OrderLineRefunded`, fixture `v1-history.ndjson`) replays without creating stock:
   subscribers receive that event upcast to version 2 with `returnsToStock: false`; the
   stored record is still version 1, without the field, and equal to the fixture line;
   the file is byte-identical. A new refund on that order then returns only its own
   units, and the original bytes remain a prefix of the file.
6. With snapshots enabled and an inventory snapshot written before this change (fixture
   `v1-inventory-snapshot.json`) in the snapshot store, a new refund on the fixture's Paid
   order returns its unit exactly once, including after a restart and republish.
7. [guard] Every stored event other than `OrderLineRefunded` is at version 1.

### Test map

| Criterion | Test file |
|---|---|
| 1 | `refund-records-decision.test.ts`, first test |
| 2 | `paid-refund-returns-stock.test.ts` |
| 3 | `decision-recorded-at-refund.test.ts` |
| 4 | `returns-exactly-once.test.ts` |
| 5 | `v1-history-replay.test.ts` |
| 6 | `old-inventory-snapshot.test.ts` |
| 7 (guard) | `refund-records-decision.test.ts`, second test |

`harness.ts` is shared setup inside the frozen directory; it is not a test.

### Evidence gathered before approval

- **Red at the fork point:** against today's code, 13 of 14 tests fail, each for the
  intended reason (event still v1, no `StockReturned`, stock not raised). None fails in
  setup. The one passing test is the labelled guard, criterion 7.
- **Can go green:** a throwaway implementation in a temporary worktree (since removed)
  passes all 14. The task agent does not see it and builds its own.
- **Catches wrong implementations:** that implementation with one deliberate bug at a
  time: deciding from the order's status when the event is handled fails criteria 2, 3
  and 5; de-duplicating on `refundId` alone fails criterion 4; changing the inventory
  state shape without bumping the snapshot version fails criterion 6.
- **Fixtures** were written by the service as it is today, so they are real pre-change
  history rather than hand-made JSON.

### Review dispositions

Criteria drafter (fresh context, read the code) proposed the names `returnsToStock` and
`StockReturned` and five criteria; all were adopted.

| # | Source | Finding | Disposition |
|---|---|---|---|
| D1 | drafter | Optional check executing the inventory command directly | **Rejected**: it would freeze an internal command name, a "how" rather than a "what" |
| D2 | drafter | Snapshot shape risk if inventory state changes | **Accepted**: a constraint, and criterion 6 after T4 |
| D3 | drafter | "Every other event stays v1" | **Accepted**: labelled guard criterion 7 |
| D4 | drafter | Unit tests asserting v1 or counting event types will need updating | **Accepted**: named in Constraints as expected, non-frozen changes |
| D5 | drafter | A Paid order whose stock was never confirmed is not covered | **Rejected**: unreachable, since an order is payable only once its stock is reserved (DESIGN.md §4.2) |
| T1 | testability | "Unchanged" results pass vacuously if deliveries throw and stall | **Accepted**: the harness fails any test that leaves a dead letter; criterion 4 asserts the return happened before checking it is not repeated |
| T2 | testability | Criterion 5 contradicted itself about the file; the fixture must not be written to | **Accepted**: reworded; tests copy the fixture to a temp dir, check bytes before and prefix after, and compare the stored record to the fixture line |
| T3 | testability | Criterion 3 must pin the ordering or the rejected approach passes | **Accepted**: reworded to name the sequence; mutation M1 confirms the test catches the rejected approach |
| T4 | testability | The snapshot constraint had no criterion | **Accepted**: criterion 6 with a real pre-change snapshot; mutation M3 confirms it fails without the bump |
| T5 | testability | The same-refundId check must use one SKU and different quantities | **Accepted**: quantities 1 and 2 on MUG; mutation M2 confirms it catches a refundId-only key |
| T6 | testability | Criterion 2's targets and numbers were unpinned | **Accepted**: exact quantities, and both observation points (read model, and the aggregate through later reservations) |
