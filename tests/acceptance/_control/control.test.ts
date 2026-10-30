// The freeze gate's control. One trivially-passing test whose only job is to answer:
// CAN THE VERIFY COMMAND REPORT SUCCESS AT ALL RIGHT NOW?
//
// Before a spec is frozen its tests must be RED, but a suite that cannot load exits
// non-zero exactly like a genuine assertion failure. So the gate also runs the verify
// command against this directory, and only trusts a red when this is green.
//
// It must not test anything: anything it asserted could break for reasons unrelated to
// the harness, and a control that can fail for its own reasons is not a control.
it('control', () => {});
