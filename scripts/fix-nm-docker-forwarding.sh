#!/bin/bash
# NetworkManager/docker interaction fix for Tailscale subnet-router "IP
# forwarding disabled" alerts (Ubuntu/Debian, headless Docker hosts).
#
# Idempotent -- safe to run repeatedly, and standalone on an already-installed
# host (e.g. to retrofit a host without re-running the whole setup.sh).
#
# Why this exists: on 2026-08-28 neuromancer kept sending Tailscale "Subnet
# ... has IP forwarding disabled" alerts whenever a docker compose stack
# restarted. Root cause: NetworkManager was auto-adopting every Docker-created
# bridge (`br-*`, `docker0`) as an "externally managed" device (only `veth*`
# were already unmanaged). NM re-evaluating a bridge going
# activated -> unmanaged -> ... -> activated transiently flipped the global
# net.ipv4.ip_forward sysctl to 0 before it settled back to 1; Tailscale
# (acting as subnet router) polls that sysctl and fires the alert the instant
# it catches the 0.
#
# This installs the HOST-LEVEL fix only:
#  1. Tell NetworkManager to leave docker's bridges/veths alone entirely --
#     Docker itself configures their IPs/routes, so NM watching them served
#     no purpose and only caused churn.
#  2. Persist net.ipv4.ip_forward=1 (and ipv6 forwarding, which Tailscale's
#     own subnet-router docs also call for) so it survives a reboot instead
#     of depending on tailscaled setting it at runtime.
set -e

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
step() { printf "\n${YELLOW}=== %s ===${NC}\n" "$1"; }
ok() { printf "${GREEN}  %s${NC}\n" "$1"; }

# ── 1. NetworkManager: never manage docker's bridges/veths ─────────────────
step "NetworkManager unmanaged-devices"
NM_CONF=/etc/NetworkManager/conf.d/unmanaged-docker.conf
read -r -d '' NM_BODY <<'EOF' || true
# Managed by scripts/fix-nm-docker-forwarding.sh
[keyfile]
unmanaged-devices=interface-name:docker*;interface-name:br-*;interface-name:veth*
EOF
if [ ! -f "$NM_CONF" ] || ! cmp -s <(printf '%s\n' "$NM_BODY") "$NM_CONF"; then
  printf '%s\n' "$NM_BODY" | sudo tee "$NM_CONF" >/dev/null
  sudo systemctl reload NetworkManager
  ok "docker*/br-*/veth* set unmanaged in NetworkManager, reloaded"
else
  ok "NetworkManager unmanaged-devices config already current"
fi

# ── 2. Persist IP forwarding across reboots ─────────────────────────────────
step "IP forwarding sysctl"
SYSCTL_CONF=/etc/sysctl.d/60-ip-forward.conf
read -r -d '' SYSCTL_BODY <<'EOF' || true
# Managed by scripts/fix-nm-docker-forwarding.sh
# Required for Tailscale subnet routing; persisted so it survives a reboot
# instead of relying on tailscaled to set it at runtime.
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
EOF
if [ ! -f "$SYSCTL_CONF" ] || ! cmp -s <(printf '%s\n' "$SYSCTL_BODY") "$SYSCTL_CONF"; then
  printf '%s\n' "$SYSCTL_BODY" | sudo tee "$SYSCTL_CONF" >/dev/null
  sudo sysctl -p "$SYSCTL_CONF" >/dev/null
  ok "IP forwarding (v4 + v6) persisted and applied"
else
  ok "IP forwarding sysctl config already current"
fi

step "NM/docker forwarding fix complete"
