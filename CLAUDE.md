# ledgerline

An event-sourced order and inventory service for a small online store: strict
TypeScript on Node 20, no database, no network, no runtime dependencies. State is an
append-only event log, in memory or in a newline-delimited JSON file.

## Where the truth lives
- **Intent and rules:** `README.md` — architecture, every business rule, and the
  delivery guarantees. Code that disagrees with it is a bug or a README amendment, never
  a silent third option.
- **Decisions and why:** `DESIGN.md` — invariants, rejected alternatives, and the section
  each task implements (its `design-ref`). Amended only through its change log.
- **Work:** tasks are Beads issues (prefix `ledgerline-`). Inside a pipeline run, your
  task is `/workspace/.run/issue.md`, and the frozen tests in
  `tests/acceptance/<issue-id>/` are the proof of done. If the issue and the README
  disagree, the issue and its frozen tests win; raise the disagreement as a concern (see
  the container section).
- **Ideas not yet decided:** `docs/IDEAS.md`. Never implement straight from it.

## Layout
`src/<domain>/` for `orders`, `inventory`, `payments` and `pricing`; infrastructure in
`src/shared/`; the composition root in `src/app/ledgerline.ts`. Unit tests in
`tests/unit/` mirror `src/`; `tests/integration/` drives the whole service through the
queue; `tests/support/` holds test helpers.

## Rules the code depends on
- **Money is integer cents.** Produce amounts only through `cents()` /
  `nonNegativeCents()`; never divide or multiply money with floating point — use
  `applyBasisPoints`, `scaleRounded` or `allocateProportionally`, each of which names its
  rounding. Percentages are integer basis points.
- **Time and ids are injected.** Never call `Date.now()`, `new Date()` without an
  argument, `Math.random()` or `randomUUID()` outside `SystemClock` and
  `RandomIdGenerator`. The determinism test asserts byte-identical event logs and log
  output across runs; any new hidden source of time or randomness breaks it.
- **Events are append-only and versioned.** Never change the payload shape of an event
  type at its current version. A new shape is a new version: declare it and register an
  upcaster (`configureUpcasters`). Stored events are never rewritten.
- **Aggregate state changes only in `evolve`.** Decision methods validate, then `raise`;
  replay must rebuild exactly the same state. State stays plain JSON-serializable data so
  snapshots work.
- **Every command is idempotent on its key**, and every command a process manager sends
  derives its key from the event that caused it (`${event.eventId}:...`). Anything that
  reacts to events must be safe to run twice.
- **Domains talk through commands and events.** A domain imports `src/shared/` and other
  domains' command and event types, not their aggregates. Payments asks orders whether an
  order can be paid only through `PayableOrderLookup`.
- **Broken business rules throw a `DomainError` subclass** with a stable `code`;
  infrastructure faults throw plain `Error`s. Process managers rely on that split to
  decide between compensating and retrying.
- **Log through `Logger`**, never `console`. The worker pool's one-line-per-outcome log
  format is part of the contract the integration tests check.
- No source file over 400 lines. No TODOs and no commented-out code.

## Commands
```bash
npm test                  # every unit and integration test (skips tests/acceptance/)
npm run typecheck         # tsc --noEmit over src and tests
npm run build             # compile src to dist
sh tools/run-acceptance.sh tests/acceptance/<issue-id>/   # one task's frozen tests
```
Run `npm run typecheck` and `npm test` before declaring any task done.

Adding a dependency is a planning decision, not a task decision: it must be added to
`package.json`, `pipeline.config.json` `dependencies` and the `Dockerfile` at the same
exact version, and the pipeline image rebuilt. The service deliberately has no runtime
dependencies.

### Working inside the pipeline container (read this when you are the coding agent in a run)
- This is a locked-down Docker container: the network reaches Anthropic endpoints only.
  No package installs, no web lookups — everything you need is in this repo, the issue
  file, or the memory file.
- Your task is `/workspace/.run/issue.md`; project memory is `/workspace/.run/memory.md`.
  Both are read-only exports — use them, don't edit them.
- NEVER touch `tests/acceptance/` or any path in `pipeline.config.json`'s `frozenPaths`.
  The verifier diffs them against the fork point; any change — even whitespace — ends
  the task as "tampered".
- The frozen verifier decides pass/fail, not you. Run tests while you work, but the
  authoritative check runs after you exit.
- You cannot push (no credentials, no git-host network). Commit locally at every
  meaningful boundary; the host pushes your branch after the container exits.
- Insights worth keeping across tasks go in the status file's memory notes as the run
  scaffolding instructs — never in ad-hoc memory files.
- If you conclude the frozen spec or its tests are themselves wrong, say so with
  `node /pipeline/status.js concern "<what is wrong and why>"` (§3.7). That is a
  first-class result, not a failure — but it is evidence only: it cannot change your
  outcome, so keep doing the best work the spec allows rather than contorting correct
  code to satisfy a gate you believe is broken.
