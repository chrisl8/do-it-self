#!/bin/bash
# System memory-pressure hardening for container hosts (Ubuntu/Debian, headless servers).
#
# Idempotent -- safe to run repeatedly, and standalone on an already-installed host
# (e.g. to retrofit deepthought without re-running the whole setup.sh).
#
# Why this exists: on 2026-06-12 neuromancer hard-froze when the nextcloud
# Elasticsearch JVM sized its heap to ~50% of host RAM (~15.6 GiB), free memory
# collapsed, and the kernel deadlocked in dirty-page writeback reclaim -- every
# storage-touching task wedged in D-state, the OOM killer never ran, and the box
# answered nothing on the network until a power cycle. Full post-mortem:
# dotfiles/docs/neuromancer-memory-livelock.md
#
# This installs the HOST-LEVEL backstops only. The first line of defense -- a
# mem_limit on the containers whose process auto-sizes to host RAM (Elasticsearch,
# Tika) -- lives in the module compose files and travels with the containers.
#
# NOT for desktops/workstations. On an interactive machine prefer systemd-oomd
# (PSI/cgroup-aware) and leave dirty-ratio/ARC to the distro's own tuning.
set -e

# ── Tunables ─────────────────────────────────────────────────────────────
EARLYOOM_TERM_PCT=8   # SIGTERM the biggest matching process below this % MemAvailable
EARLYOOM_KILL_PCT=4   # SIGKILL below this %
ARC_MAX_PCT=25        # ZFS ARC cap as % of RAM (ZFS hosts only; skipped if no ZFS)

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
step() { printf "\n${YELLOW}=== %s ===${NC}\n" "$1"; }
ok() { printf "${GREEN}  %s${NC}\n" "$1"; }

# ── 1. earlyoom: kill the biggest hog BEFORE the reclaim deadlock can form ──
step "earlyoom"
if ! command -v earlyoom >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq earlyoom
  ok "earlyoom installed"
else
  ok "earlyoom already installed"
fi
# -s 100 makes earlyoom MEMORY-driven. Its default fires only when memory AND swap
# are both low, but the livelock had 55 GiB swap free -- the default would never
# have triggered. avoid: core daemons. prefer: stateless compute hogs that balloon.
EARLYOOM_CONF=/etc/default/earlyoom
EARLYOOM_DESIRED="EARLYOOM_ARGS=\"-m ${EARLYOOM_TERM_PCT},${EARLYOOM_KILL_PCT} -s 100 -r 3600 --avoid '^(systemd|sshd|tailscaled|dockerd|containerd)\$' --prefer '^(java|soffice|chrome|node|python)\$'\""
if [ ! -f "$EARLYOOM_CONF" ] || ! grep -qF "$EARLYOOM_DESIRED" "$EARLYOOM_CONF" 2>/dev/null; then
  printf '# Managed by scripts/system-memory-hardening.sh\n%s\n' "$EARLYOOM_DESIRED" | sudo tee "$EARLYOOM_CONF" >/dev/null
  sudo systemctl enable --now earlyoom >/dev/null 2>&1 || true
  sudo systemctl restart earlyoom
  ok "earlyoom configured (term ${EARLYOOM_TERM_PCT}% / kill ${EARLYOOM_KILL_PCT}%, memory-driven) and restarted"
else
  sudo systemctl enable --now earlyoom >/dev/null 2>&1 || true
  ok "earlyoom config already current"
fi

# ── 2. Lower dirty-page thresholds so un-flushable dirty pages can't pile up ──
step "vm.dirty writeback thresholds"
SYSCTL_CONF=/etc/sysctl.d/99-vm-writeback.conf
read -r -d '' SYSCTL_BODY <<'EOF' || true
# Managed by scripts/system-memory-hardening.sh
# Smaller pool of un-flushable dirty pages -> writeback can't fall hopelessly
# behind under memory pressure (a contributor to the 2026-06-12 livelock).
# Affects page-cache filesystems (ext4 etc.); ZFS uses its own write throttle.
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10
EOF
if [ ! -f "$SYSCTL_CONF" ] || ! cmp -s <(printf '%s\n' "$SYSCTL_BODY") "$SYSCTL_CONF"; then
  printf '%s\n' "$SYSCTL_BODY" | sudo tee "$SYSCTL_CONF" >/dev/null
  sudo sysctl -p "$SYSCTL_CONF" >/dev/null
  ok "dirty ratios set (background 5% / hard 10%)"
else
  ok "dirty ratios already current"
fi

# ── 3. ZFS ARC cap (ZFS hosts only) ──────────────────────────────────────
# Uncapped ARC competes with containers for RAM and worsens earlyoom's blind
# spot (MemAvailable under-counts shrinkable ARC). Skipped automatically on
# non-ZFS hosts (e.g. deepthought).
step "ZFS ARC cap"
if [ -d /sys/module/zfs ]; then
  ARC_CONF=/etc/modprobe.d/zfs-arc-max.conf
  RUNTIME_ARC=$(cat /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || echo 0)
  # Respect an existing cap set by ANY means: a live runtime value, our managed
  # file, or any other modprobe.d entry (neuromancer deliberately runs 8 GiB).
  if [ "${RUNTIME_ARC:-0}" -gt 0 ] 2>/dev/null \
     || [ -f "$ARC_CONF" ] \
     || grep -rqs "zfs_arc_max" /etc/modprobe.d/ 2>/dev/null; then
    ok "ARC already capped ($(( ${RUNTIME_ARC:-0} / 1024 / 1024 / 1024 )) GiB live) -- left as-is"
  else
    MEM_BYTES=$(awk '/MemTotal/{print $2*1024}' /proc/meminfo)
    ARC_BYTES=$(( MEM_BYTES * ARC_MAX_PCT / 100 ))
    printf '# Managed by scripts/system-memory-hardening.sh -- ARC capped at %s%% of RAM\noptions zfs zfs_arc_max=%s\n' "$ARC_MAX_PCT" "$ARC_BYTES" | sudo tee "$ARC_CONF" >/dev/null
    # Apply live too (modprobe.d only takes effect at module load / reboot).
    echo "$ARC_BYTES" | sudo tee /sys/module/zfs/parameters/zfs_arc_max >/dev/null 2>&1 || true
    ok "ARC capped at ${ARC_MAX_PCT}% of RAM ($(( ARC_BYTES / 1024 / 1024 / 1024 )) GiB), persisted in ${ARC_CONF}"
  fi
else
  ok "no ZFS on this host -- ARC cap skipped"
fi

step "Memory hardening complete"
