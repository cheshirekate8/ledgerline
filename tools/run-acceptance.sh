#!/bin/sh
# Acceptance-test runner, invoked by the pipeline verifier as
#   sh tools/run-acceptance.sh tests/acceptance/<issue-id>/
# Runs every *.test.ts file in that directory with jest, under the frozen
# configuration in tools/jest.acceptance.config.js.
#
# It names the files explicitly and refuses an empty or missing directory, because
# "no tests found" must never pass a task.
#
# jest comes from the project's node_modules on the host and from /node_modules
# (on PATH) inside a pipeline container. It is never run through npx, which goes to
# the registry when it cannot find a local binary.
#
# Frozen path: listed in pipeline.config.json frozenPaths. Never edited during a run.
set -u
DIR="${1:?usage: run-acceptance.sh <test-dir>}"
[ -d "$DIR" ] || { echo "FAIL: test dir not found: $DIR"; exit 1; }

set -- "${DIR%/}"/*.test.ts
[ -e "$1" ] || { echo "FAIL: no *.test.ts files in $DIR"; exit 1; }

if [ -x node_modules/.bin/jest ]; then
  JEST=node_modules/.bin/jest
else
  JEST=jest
fi
exec "$JEST" --config tools/jest.acceptance.config.js --ci --runTestsByPath "$@"
