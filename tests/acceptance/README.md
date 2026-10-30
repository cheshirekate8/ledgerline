# Frozen acceptance tests

Tests land here during planning (the pipeline's PLANNING.md step 6), one directory per
Beads issue (`tests/acceptance/<issue-id>/`), and are committed to `main` **before** the
run. The pipeline's verifier diffs this whole tree, plus every path in
`pipeline.config.json`'s `frozenPaths`, against the task branch's fork point. Any change
during a run, by anyone, even whitespace, is the "tampered" outcome.

- Each directory is run by `sh tools/run-acceptance.sh tests/acceptance/<issue-id>/`:
  every `*.test.ts` file, through jest with the frozen `tools/jest.acceptance.config.js`.
  Any failure fails the task.
- The project's own `npm test` skips this tree, because a frozen test is red on `main`
  until the task that implements it merges.
- Tests run in a sealed container with no network. They import from `src/` by relative
  path (`../../../src/app/ledgerline`) and use a `FixedClock` and a `SeededIdGenerator`;
  a test never reads the wall clock or `Math.random()`.
- Frozen tests inline what they need. They must not import helpers from `tests/support/`,
  which a task can edit; otherwise a task could change what judges it without touching
  this tree.
- `_control/` holds the freeze gate's control: one test that asserts nothing. Leave it.
- Old directories stay forever as the record of past promises.
