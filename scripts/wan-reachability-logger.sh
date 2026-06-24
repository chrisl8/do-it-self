#!/bin/bash
# Continuous WAN / Tailscale control-plane reachability logger (log-only).
#
# Why this exists: the every-15-min system-health-check.sh was paging on
# "Tailscale peers offline" events that turned out to be brief losses of THIS
# host's tailscaled map-poll -- the control-plane long-poll, journal warnable
# `not-in-map-poll`. When that drops, the host stops receiving peer updates and
# every peer's "last seen" clock freezes, so they all flip to "offline" at once
# (local container sidecars, offsite backup-pi, and wintermute simultaneously --
# proof it is the OBSERVER blipping, not the peers). They self-heal in well under
# a cycle. See ~/logs/tailscale-offline-trend.log and the streak-gating block in
# system-health-check.sh.
#
# During those events the LAN gateway and public DNS both stay UP, so neither
# system-network-watchdog.sh (LAN gateway) nor system-dns-watchdog.sh (name
# resolution) observes them -- and nothing recorded WHETHER the WAN itself
# blipped. This logger fills that gap: a continuous time-series of
#   gw   = LAN gateway reachability  (is the local link fine?)
#   wan  = raw internet reachability (1.1.1.1, no DNS)
#   ctrl = TCP connect to the Tailscale control plane (the path whose loss
#          freezes peer "last seen")
# so the next sustained event can be attributed to the right layer. It ONLY logs
# -- remediation stays with the two purpose-built watchdogs. Needs no privileges.
#
# Cron runs it once a minute; it self-samples a few times per run for sub-minute
# resolution. SAMPLES / SAMPLE_GAP are env-overridable (handy for testing).
set -e

LOG="/home/chrisl8/logs/wan-reachability.log"
LOCK="/home/chrisl8/.cache/wan-reachability.lock"
SAMPLES="${SAMPLES:-3}"                    # samples per invocation
SAMPLE_GAP="${SAMPLE_GAP:-20}"             # seconds between samples (3 x 20s ~= 1/min)
WAN_IP="1.1.1.1"                           # raw WAN reachability (no DNS)
CONTROL_HOST="controlplane.tailscale.com"  # path whose loss freezes peer "last seen"
MAX_LINES=20000                            # ~4-5 days at 3/min, then trim to half

mkdir -p "$(dirname "$LOG")" "$(dirname "$LOCK")"

# Never let two invocations overlap (a slow / timing-out sample can run long).
exec 9>"$LOCK"
flock -n 9 || exit 0

GW="$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')"
GW="${GW:-192.168.8.1}"

# Single-shot RTT in ms, or "DOWN" on loss. The ping pipeline ends in sed, which
# exits 0 even on no-match, so this is safe under `set -e`.
ping_ms() {
  local host="$1" out
  out="$(ping -c1 -W2 "$host" 2>/dev/null | sed -n 's/.*time=\([0-9.]*\).*/\1/p')"
  if [ -n "$out" ]; then printf '%sms' "$out"; else printf 'DOWN'; fi
}

# TCP connect time to the control plane (the TLS/HTTP exchange is intentionally
# discarded -- we only care whether the port that carries the map-poll is
# reachable and how fast). "FAIL" when the connect never completes.
control_ms() {
  local t
  if ! t="$(curl -s -o /dev/null --connect-timeout 3 -m 5 \
              -w '%{time_connect}' "https://${CONTROL_HOST}/" 2>/dev/null)"; then
    printf 'FAIL'; return
  fi
  if [ -z "$t" ] || [ "$t" = "0.000000" ]; then
    printf 'FAIL'
  else
    awk -v s="$t" 'BEGIN{printf "%.0fms", s*1000}'
  fi
}

i=0
while [ "$i" -lt "$SAMPLES" ]; do
  printf '%s | gw=%s wan=%s ctrl=%s\n' \
    "$(date '+%F %T %Z')" "$(ping_ms "$GW")" "$(ping_ms "$WAN_IP")" "$(control_ms)" >> "$LOG"
  i=$((i + 1))
  if [ "$i" -lt "$SAMPLES" ]; then sleep "$SAMPLE_GAP"; fi
done

# Bounded, self-trimming log.
if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LINES" ]; then
  tail -n $((MAX_LINES / 2)) "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi
