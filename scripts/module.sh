#!/bin/bash
set -e

# Module system CLI for the do-it-self container platform.
# Thin wrapper around scripts/module-helper.js.
# See docs/MODULES.md for the full design.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/module-helper.js"

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required but not installed." >&2
  exit 1
fi

if [[ ! -f "${HELPER}" ]]; then
  echo "Error: ${HELPER} not found." >&2
  exit 1
fi

SUBCOMMAND="${1:-help}"
shift || true

case "${SUBCOMMAND}" in
  add-source|remove-source|install|uninstall|update|list|regenerate-registry|dev-sync)
    node "${HELPER}" "${SUBCOMMAND}" "$@"
    ;;
  help|--help|-h)
    echo "Usage: module.sh <subcommand> [args...]"
    echo ""
    echo "Subcommands:"
    echo "  add-source <url> [--name <name>]  Clone a module repo into .modules/"
    echo "  remove-source <name>              Remove a module repo from .modules/"
    echo "  install <module> <container>      Install a container from a module"
    echo "  uninstall <container>             Uninstall a module-sourced container"
    echo "  update [<module>]                 Update module(s) and sync installed containers"
    echo "  list [--available|--installed|--all]  List containers"
    echo "  regenerate-registry               Rebuild container-registry.yaml from modules"
    echo "  dev-sync [<module>] [<container>]  Sync live edits back to module repo"
    echo ""
    echo "See docs/MODULES.md for the full design."
    exit 0
    ;;
  *)
    echo "Unknown subcommand: ${SUBCOMMAND}" >&2
    echo "Run 'module.sh help' for usage." >&2
    exit 1
    ;;
esac
