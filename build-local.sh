#!/usr/bin/env bash
# Build a self-contained single-file HTML for local testing.
# Output: eve-wormhole-roller.html (gitignored)
set -euo pipefail
cd "$(dirname "$0")"
python3 .github/scripts/build-offline.py "$@"
