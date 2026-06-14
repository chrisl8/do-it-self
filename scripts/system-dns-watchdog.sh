#!/bin/bash
# DNS resolver watchdog for the Tailscale + systemd-resolved DNS stack.
#
# Why this exists: on 2026-06-13 a routine router/modem power-cycle left this
# host unable to resolve ANY public name for ~4 hours -- even after the internet
# came back on its own. Raw IP connectivity was fine the whole time; only name
# resolution was dead, which made it look like "the box is offline."
#
# Root cause: `accept-dns` is on, so Tailscale manages DNS and (with no global
# nameservers set in the tailnet) forwards public queries to the system upstream.
# When the upstream blipped during the modem cycle, Tailscale's resolver lost
# that upstream -- "dns: resolver: forward: no upstream resolvers set, returning
# SERVFAIL" -- and never re-synced once the link recovered. Restarting
# systemd-resolved forces Tailscale to re-sync its DNS config and recover
# ("dns: systemd-resolved restarted, syncing DNS config"). That manual restart
# was the fix; this script automates it. Full post-mortem:
# ~/dotfiles/docs/neuromancer-dns-outage.md
#
# It detects the SPECIFIC wedge -- raw internet UP but name resolution DOWN --
# and restarts systemd-resolved to force the re-sync. It deliberately does
# NOTHING when raw IP is also unreachable (a real internet outage), so it can't
# thrash while the modem is genuinely down.
#
# Runs as the normal user from cron; only the resolved restart is elevated, via
# a narrow NOPASSWD sudoers rule for exactly that one command (provisioned by
# setup.sh -> /etc/sudoers.d/containers-resolved).
set -e

PROBE_IP="1.1.1.1"                            # raw-connectivity probe (no DNS)
PROBE_NAMES=("cloudflare.com" "google.com")   # name-resolution probes
RESTART_CMD=(/usr/bin/systemctl restart systemd-resolved)  # exact match for the NOPASSWD sudoers rule
TAG="dns-watchdog"

# True if at least one probe name resolves via the normal nsswitch path (getent
# hosts is the exact path every other program on the box uses -- the one that
# breaks). Two names so a single dead domain can't trigger a needless restart.
dns_ok() {
  local name
  for name in "${PROBE_NAMES[@]}"; do
    if getent hosts "$name" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

# Raw internet down -> this is not a DNS wedge, nothing a resolved restart can
# fix. Stay out of the way (and don't thrash while the modem is power-cycling).
if ! ping -c1 -W3 "$PROBE_IP" >/dev/null 2>&1; then
  exit 0
fi

# DNS healthy -> done (the overwhelmingly common path; cheap, exits fast).
if dns_ok; then
  exit 0
fi

# A single failed lookup could be a fluke. Re-check after a short pause before
# taking the (cheap but not free) step of bouncing the resolver.
sleep 5
if dns_ok; then
  exit 0
fi

logger -t "$TAG" "Public DNS resolution down while ${PROBE_IP} is reachable; restarting systemd-resolved to force a Tailscale/resolved re-sync"
if ! sudo "${RESTART_CMD[@]}"; then
  logger -t "$TAG" "FAILED to restart systemd-resolved (sudo/NOPASSWD misconfigured?) -- manual intervention needed"
  exit 1
fi
sleep 3

if dns_ok; then
  logger -t "$TAG" "DNS resolution restored after systemd-resolved restart"
else
  logger -t "$TAG" "DNS resolution STILL failing after systemd-resolved restart -- manual investigation needed"
fi
