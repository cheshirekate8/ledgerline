# IDEAS.md — the idea inbox

Somewhere to put *"that's probably a good idea"* the moment you have it, so it survives
without being thought about yet.

This is deliberately the cheapest document in the repo. An entry here makes **no** claim
that the idea is good, sized, wanted, or ever going to happen. It is not a design, not a
spec, not a backlog — and never a Beads issue: issues are commitments that show up in
`bd ready`, and the ready queue is what the pipeline drains unattended.

## The promotion path

```
IDEAS.md  ->  design decision (+ change-log row)  ->  spec + frozen tests  ->  Beads issue  ->  a run
  parked        decided, with a reason                 machine-checkable      committed
```

Nothing is ever implemented straight from this file. Planning sessions read it for
candidates (the pipeline's PLANNING.md, step 0); that is its only process obligation.

## How to write an entry

A title, a sentence or two on **why you'd want it** — not how you'd build it — and the
date. Optional, only when true: `Blocked on:` (a change-log row or issue id) and
`Related:` (a file or README section it would touch). One flat list; no taxonomy.

```markdown
- **Short imperative title** — why this would be worth having, in a sentence or two.
  2026-10-29
```

## What must not go in here

- Anything already decided — if the README or the code states it, it is a fact, not an idea.
- Work that is already a Beads issue.

---

## Inbox

- **Persist the message queue** — queued work is lost when the process stops, and today
  recovery depends on someone remembering to call `republish()` after a restart.
  2026-10-29. Related: README "Delivery guarantees".
- **Restock refunded units that never shipped** — refunding a Paid order returns the money
  but not the stock, so an item refunded before dispatch can never be sold again without
  a manual `ReceiveStock`. 2026-10-29.
- **Refund by amount as well as by units** — goodwill credits ("$5 off for the late
  delivery") have no home today, because refunds are per unit only. 2026-10-29.
- **Find expiry candidates without loading every order** — `expireReservations()` replays
  every order stream on each sweep, which is fine for a small store and grows with order
  history. 2026-10-29. Related: `src/orders/reservation-expiry-service.ts`.
- **Bound the idempotency store** — it holds every key forever in memory, and it is rebuilt
  from the whole event log at start-up. 2026-10-29.

## Promoted

| Date | Idea | Became |
|---|---|---|

## Dropped

| Date | Idea | Why |
|---|---|---|
