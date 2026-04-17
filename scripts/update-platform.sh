#!/bin/bash
set -e

# Safe platform update flow. Pulls the platform repo from its upstream branch
# (fast-forward only), re-runs setup hooks for installed containers, and
# validates env requirements. See scripts/update-platform.js for details.
#
# Usage:
#   scripts/update-platform.sh [--pre-backup] [--yes] [--remote <name>] [--branch <name>]
#
# Exit codes:
#   0  ok
#   1  generic error
#   2  precondition failed — no mutation
#   3  post-pull validation failed — system is at new HEAD
#   4  pre-backup failed — no mutation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/update-platform.js"

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required but not installed." >&2
  exit 1
fi

if [[ ! -f "${HELPER}" ]]; then
  echo "Error: ${HELPER} not found." >&2
  exit 1
fi

exec node "${HELPER}" "$@"
