#!/usr/bin/env bash
# Clear generated files (output/, work/, received/) and keep the folders.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p output work
find output work -type f ! -name .gitkeep -delete
rm -rf received
