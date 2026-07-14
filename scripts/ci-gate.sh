#!/usr/bin/env bash
set -euo pipefail

# Run from repo root regardless of caller's cwd.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --- nvm-use-24 guard -------------------------------------------------------
nodeVersionString="$(node --version)"          # e.g. "v24.18.0"
nodeMajorVersion="${nodeVersionString#v}"
nodeMajorVersion="${nodeMajorVersion%%.*}"

if [[ "${nodeMajorVersion}" != "24" ]]; then
  echo "ci-gate: expected Node major version 24, got ${nodeVersionString} (run: . ~/.nvm/nvm.sh && nvm use 24)" >&2
  exit 1
fi

# --- typecheck ---------------------------------------------------------------
echo "ci-gate: typecheck"
npm run typecheck

# --- unit tests ----------------------------------------------------------------
echo "ci-gate: unit tests"
npm test

# --- ui build (step 3) -------------------------------------------------------
# vue-tsc typechecks the .vue SFCs root tsc -b can't see, then vite bundles to
# packages/ui/dist (served by the daemon via VIMES_STATIC_DIR). Build failure
# fails the gate.
echo "ci-gate: ui build"
npm run build -w @vimes/ui

# --- double-run determinism gate (step 4) -----------------------------------
# Run each scenario profile twice, byte-compare the two canonicalJson artifacts
# (event-log dump + projection serializations + counters). Typecheck above has
# already refreshed dist/, so the CLI runs against current code.
echo "ci-gate: scenario double-run byte-compare"
node packages/daemon/dist/cli.js scenarios --check

# --- grep gate: banned nondeterminism in packages/core/src -------------------
echo "ci-gate: grep gate (banned nondeterminism in packages/core/src)"
bannedNondeterminismMatches="$(grep -rnE 'Date\.now\(|Math\.random\(|crypto\.randomUUID\(' packages/core/src --include='*.ts' | grep -v '// determinism-exempt' || true)"

if [[ -n "${bannedNondeterminismMatches}" ]]; then
  echo "ci-gate: banned nondeterminism found in packages/core/src (Date.now/Math.random/crypto.randomUUID are forbidden; mark intentional exceptions with '// determinism-exempt'):" >&2
  echo "${bannedNondeterminismMatches}" >&2
  exit 1
fi

echo "ci-gate: all gates passed"
