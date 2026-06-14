#!/bin/bash
# LAN watchdog: recover enp4s0 when the default gateway goes unreachable.
#
# Why this exists: on 2026-06-14 a router reboot reset the router's DHCP lease
# table and it handed neuromancer's address (then 192.168.8.20) to a TP-Link
# RE655 range extender (MAC 8C:86:DD:58:CE:1B), creating an IP-address conflict
# that left this box unreachable for ~24 minutes. NetworkManager DETECTED the
# conflict ("conflict detected for IP address 192.168.8.20") but, still holding a
# valid DHCP lease on a link that never lost carrier, never re-negotiated. The
# only fix was physically unplugging and replugging the cable, which forced a
# clean re-DHCP / address-conflict-detection round. (Same MAC had quietly done
# this several times before -- it was the elusive "neuromancer randomly drops off
# the network" gremlin.)
#
# neuromancer has since moved to a STATIC IP off the DHCP range, which removes
# that specific conflict at the source. This watchdog is the general safety net
# for the broader failure mode -- "router rebooted / link blipped and NM was left
# wedged with an unreachable gateway" -- by performing the software equivalent of
# the cable replug: `nmcli device reconnect enp4s0`. So recovery no longer needs
# a human standing at the box.
#
# It deliberately does the MINIMUM: it only acts when the LAN gateway is
# unreachable, double-checks for flukes, and backs off so it can't thrash while
# the router is genuinely down (the reconnect can't help then -- the gateway
# probe will simply pass on its own once the router returns).
#
# Runs as the normal user from cron; only the reconnect is elevated, via a narrow
# NOPASSWD sudoers rule for exactly that one command
# (/etc/sudoers.d/containers-netwatch, provisioned by setup.sh).
set -e

IFACE="enp4s0"
# Derive the LAN gateway from the live default route; fall back to the known
# value in case the wedge has already torn the route out.
GW="$(ip -4 route show default dev "$IFACE" 2>/dev/null | awk '{print $3; exit}')"
GW="${GW:-192.168.8.1}"
RECONNECT_CMD=(/usr/bin/nmcli device reconnect "$IFACE")  # exact match for the NOPASSWD sudoers rule
STAMP="/home/chrisl8/.cache/network-watchdog-last-reconnect"
BACKOFF=900   # at most one reconnect per 15 min, so a real router outage can't make us thrash
TAG="network-watchdog"

# Gateway reachable at the ARP/IP level. This is the exact thing that breaks in
# both the conflict wedge (our ARP binding poisoned) and a post-reboot NM wedge.
gw_ok() { ping -c1 -W3 "$GW" >/dev/null 2>&1; }

# Healthy -> the overwhelmingly common path. Cheap, exits fast.
gw_ok && exit 0

# A single dropped ping could be a fluke. Re-check after a short pause before
# taking the (cheap but not free) step of bouncing the interface.
sleep 5
gw_ok && exit 0

# Back off: if we reconnected recently, leave it alone. During a genuine router
# outage the reconnect can't restore anything, so one attempt per BACKOFF window
# is plenty -- gw_ok will pass on its own once the router is back.
now="$(date +%s)"
if [[ -f "$STAMP" ]]; then
  last="$(cat "$STAMP" 2>/dev/null || echo 0)"
  if (( now - last < BACKOFF )); then
    logger -t "$TAG" "Gateway ${GW} unreachable but reconnected $(( now - last ))s ago (< ${BACKOFF}s backoff); leaving ${IFACE} alone"
    exit 0
  fi
fi

logger -t "$TAG" "Gateway ${GW} unreachable via ${IFACE}; running 'nmcli device reconnect ${IFACE}' (software cable-replug) to force a clean re-negotiation"
mkdir -p "$(dirname "$STAMP")"
echo "$now" > "$STAMP"
if ! sudo "${RECONNECT_CMD[@]}"; then
  logger -t "$TAG" "FAILED to reconnect ${IFACE} (sudo/NOPASSWD misconfigured?) -- manual intervention may be needed"
  exit 1
fi

# Give re-DHCP/ACD (or static re-apply) plus gateway ARP a few seconds to settle.
sleep 8
if gw_ok; then
  logger -t "$TAG" "Gateway ${GW} reachable again after reconnecting ${IFACE}"
else
  logger -t "$TAG" "Gateway ${GW} STILL unreachable after reconnecting ${IFACE} (router likely genuinely down) -- will retry after backoff"
fi
