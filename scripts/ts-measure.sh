#!/bin/bash
# Measure a Tailscale sidecar's throughput AND its tailscaled CPU cost for the
# same transfer. Run once before flipping TS_USERSPACE=false and once after.
#
# Throughput alone understates the kernel-mode win (sequential TCP hides the
# netstack cost); the CPU-seconds-per-GiB column is the number that moves.
#
# usage: ts-measure.sh <ts-container> <url> [runs]
set -euo pipefail

CT="$1"
URL="$2"
RUNS="${3:-10}"

# Several sidecars run at once, so resolve tailscaled by cgroup membership
# rather than pgrep name matching.
CID="$(docker inspect -f '{{.Id}}' "$CT")"
TS_PID=""
for p in $(pgrep tailscaled); do
  if grep -qs "$CID" "/proc/$p/cgroup"; then
    TS_PID="$p"
    break
  fi
done
if [ -z "$TS_PID" ]; then
  echo "could not find tailscaled for $CT" >&2
  exit 1
fi

cpu_jiffies() { awk '{print $14+$15}' "/proc/$1/stat"; }

CLK="$(getconf CLK_TCK)"
BEFORE="$(cpu_jiffies "$TS_PID")"

TOTAL_BYTES=0
SPEEDS="$(mktemp)"
for _ in $(seq 1 "$RUNS"); do
  out="$(curl -sS -o /dev/null -w '%{size_download} %{speed_download}' \
    -H 'Accept-Encoding: identity' "$URL")"
  sz="${out%% *}"
  sp="${out##* }"
  TOTAL_BYTES=$((TOTAL_BYTES + sz))
  echo "$sp" >> "$SPEEDS"
done

AFTER="$(cpu_jiffies "$TS_PID")"

awk -v before="$BEFORE" -v after="$AFTER" -v clk="$CLK" \
    -v bytes="$TOTAL_BYTES" -v pid="$TS_PID" '
  { s += $1; if ($1 > m) m = $1 }
  END {
    cpu = (after - before) / clk
    gib = bytes / 1073741824
    printf "tailscaled host pid : %s\n", pid
    printf "transferred         : %.2f GiB over %d runs\n", gib, NR
    printf "throughput          : avg %.1f MB/s   peak %.1f MB/s\n", s/NR/1048576, m/1048576
    printf "sidecar CPU         : %.2f s  ->  %.2f CPU-s per GiB\n", cpu, (gib > 0 ? cpu/gib : 0)
  }' "$SPEEDS"

rm -f "$SPEEDS"
