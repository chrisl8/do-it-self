#!/bin/bash
set -e

# Unified update entrypoint — runs platform update and/or module updates
# from one place so users don't have to remember both commands.
#
# Usage:
#   scripts/update.sh                  # --all (default): platform, then modules
#   scripts/update.sh --all            # platform first, then module.sh update
#   scripts/update.sh --platform       # platform only (pass-through)
#   scripts/update.sh --modules        # modules only (pass-through)
#   scripts/update.sh --pre-backup     # forwarded to update-platform.sh
#   scripts/update.sh --yes            # non-interactive, forwarded
#
# Exit code is the worst of the two sub-exit codes, preserving the
# structured platform codes (2 precondition, 3 validation, 4 backup)
# when platform was the source of the failure.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_PLATFORM_SH="${SCRIPT_DIR}/update-platform.sh"
MODULE_SH="${SCRIPT_DIR}/module.sh"

MODE="all"
PLATFORM_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --all) MODE="all"; shift ;;
    --platform) MODE="platform"; shift ;;
    --modules) MODE="modules"; shift ;;
    --pre-backup) PLATFORM_ARGS+=("--pre-backup"); shift ;;
    --yes|-y) PLATFORM_ARGS+=("--yes"); shift ;;
    --ignore-hooks) PLATFORM_ARGS+=("--ignore-hooks"); shift ;;
    --remote) PLATFORM_ARGS+=("--remote" "$2"); shift 2 ;;
    --branch) PLATFORM_ARGS+=("--branch" "$2"); shift 2 ;;
    --help|-h)
      sed -n '3,16p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

PLATFORM_EXIT=0
MODULES_EXIT=0

if [ "${MODE}" = "all" ] || [ "${MODE}" = "platform" ]; then
  echo "── Platform update ──"
  set +e
  "${UPDATE_PLATFORM_SH}" "${PLATFORM_ARGS[@]}"
  PLATFORM_EXIT=$?
  set -e
  if [ "${PLATFORM_EXIT}" -ne 0 ] && [ "${MODE}" = "all" ]; then
    echo ""
    echo "── Module update — skipped (platform update failed with exit ${PLATFORM_EXIT}) ──"
    exit "${PLATFORM_EXIT}"
  fi
fi

if [ "${MODE}" = "all" ] || [ "${MODE}" = "modules" ]; then
  echo ""
  echo "── Module update ──"
  set +e
  "${MODULE_SH}" update
  MODULES_EXIT=$?
  set -e
fi

# Exit with the worst of the two codes, preferring the platform code when
# non-zero (its codes are structured).
if [ "${PLATFORM_EXIT}" -ne 0 ]; then
  exit "${PLATFORM_EXIT}"
fi
exit "${MODULES_EXIT}"
