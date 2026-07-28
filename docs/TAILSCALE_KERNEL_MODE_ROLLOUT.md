# Tailscale sidecar kernel-mode rollout

Status doc + runbook. Started 2026-07-27.

## Why

The Valheim server disconnected every Tailscale player ~30-90s after character spawn,
~20 times in a row, while LAN players were unaffected.

Root cause: the `tailscale/tailscale` image defaults `TS_USERSPACE=true`, so every sidecar
ran `tailscaled --tun=userspace-networking`. In that mode tailnet packets are reassembled
by a gVisor userspace TCP/IP stack and re-injected into the app over loopback instead of
being kernel-routed. Measured on a live session it dropped **~11% of inbound UDP even at
~0ms LAN latency** — fatal to Valheim, which fires `ZRpc timeout detected` after 30s
without a valid RPC.

Nobody chose that mode. Every compose file already grants `/dev/net/tun`, `net_admin` and
`sys_module` — everything kernel mode needs. The variable was simply never set. Userspace
is the image's default because it requires zero privileges (Kubernetes without privileged
pods, Fargate, rootless Docker). It is a portability default, not a performance one.

**Why it hid for years:** TCP retransmits paper over ~11% loss. Only a UDP protocol with a
hard 30s timeout made it visible. The other ~44 sidecars are degraded, not broken.

Proven on valheim (module commit `f556535`): 0 `ZRpc timeout` events and a 17+ minute
continuous session, versus a previous best of 164 seconds.

### How it was diagnosed (so this isn't re-litigated)
The decisive test was having a **known-good client connect over Tailscale from the same
LAN**: same PC, same mods, ~0ms latency — stable on the direct published port, dead in 39s
via Tailscale. That isolated the variable in one shot.

Two earlier theories were wrong and are recorded so they aren't retried:
- A synthetic UDP probe through the identical Tailscale path measured **100% clean at
  4 MB/s**. It hit a test listener on a spare port, not the app's real socket. Do not trust
  a synthetic path test over the real service socket.
- DERP fallback was suspected and disproven — the path stayed direct for 3 minutes of
  2-second polling.

## Established facts (verified — do not re-derive)

- **46 container dirs** contain `tailscale/tailscale`; **47 sidecar services** (`recon`
  defines two: `ts` and `ts-lazylibrarian`).
- **45 in `.modules/do-it-self-containers/`**, 1 (`quicken`) in `.modules/do-it-self-personal/`.
- **Every** sidecar already has `/dev/net/tun` + `net_admin`. **Zero exceptions** — no
  capability changes needed anywhere.
- `/dev/net/tun` under `volumes:` rather than `devices:` **works** — verified the container
  opens it (read returns EBUSY / "File descriptor in bad state" = accessible, not blocked).
- Correct single restart: `scripts/all-containers.sh --stop --start --container <name>`.
  Plain `--start` can silently no-op due to dependency gating.
- Batch restart: `--stop --start --container-list <file>` (one dir name per line).
- Copying `.modules/<repo>/<c>/compose.yaml` -> `<c>/compose.yaml` matches the module->root
  sync direction in `docs/MODULES.md`. Avoids `module.sh update` (30+ min full-stack sweep).
- Restarting bumps the sidecar image (e.g. 1.98.8 -> 1.98.9). Expected; valheim did the same.
- Tailscale node identity is preserved across the switch (state lives in `TS_STATE_HOST_DIR`);
  valheim kept `100.100.68.24`.

### IP-trust risk: LOW (checked, not assumed)
Kernel mode changes client source IP from `127.0.0.1` to the real `100.x`. Audited:
- Only compose-level match is `HOMEPAGE_ALLOWED_HOSTS` — a *hostname* allowlist, unaffected.
- Nextcloud `trusted_domains` are hostnames (Host header), unaffected. `trusted_proxies` is
  `255.255.255.255` (sentinel matching nothing) -> already uses the real socket IP.
- Forgejo `REVERSE_PROXY_TRUSTED_PROXIES = *` -> insensitive either way.

Net effect is mostly **improvement**: per-IP rate limiting / brute-force protection stops
being shared across all tailnet users, and logs gain real identities. One watch item: an app
that silently trusted `127.0.0.1` may now require auth — a security improvement, but visible.

## The per-container procedure

1. Edit `.modules/<repo>/<container>/compose.yaml` — add to the `ts:` service's
   `environment:` block, immediately after the `TS_HOSTNAME` line:
   ```yaml
         - TS_USERSPACE=false
   ```
2. Commit to the module repo (direct to `main` per repo convention) and push.
3. Sync the render: `cp .modules/<repo>/<c>/compose.yaml <c>/compose.yaml`
4. Restart: `scripts/all-containers.sh --stop --start --container <c>`

### Verify (all four)
```bash
docker ps --filter name=<c>                      # app + -ts sidecar healthy
docker exec <c>-ts ip -brief addr | grep tailscale0   # exists, has a 100.x/32
docker exec <c>-ts sh -c 'for p in $(pgrep tailscaled); do tr "\0" " " < /proc/$p/cmdline; echo; done'
                                                 # must NOT contain userspace-networking
docker exec <c>-ts tailscale status | head -3    # node present, same tailnet IP
```
Capture the same four **before** the restart — the tailnet IP is the one thing that must not
change, and you can't compare against a baseline you never took.

Use `pgrep tailscaled`, not `pgrep -f tailscaled`: the `-f` form also matches the `sh -c`
wrapper itself, so `cat /proc/$(...)/cmdline` gets multiple PIDs and fails with
`cat: read error: Is a directory`.

Then one app-specific functional check: load the service over its `*.${TS_DOMAIN}` name and
confirm normal operation.

**Expected benign log lines** in the sidecar after the switch (present on the proven
valheim/minecraft too — not regressions):
- `wgengine.NewUserspaceEngine(tun "tailscale0")` — this is the *wireguard-go* engine name.
  It is binding the real `tailscale0` TUN device. It does **not** mean userspace networking;
  the cmdline check above is the authority.
- `failed to enable src_valid_mark: ... read-only file system` — `/proc/sys` is read-only in
  the container. Benign for a leaf node (would only matter for a subnet router / exit node).

#### The "real 100.x client IP" signal only applies to some containers
Kernel mode changes the client source IP from `127.0.0.1` to the real `100.x` **only for
sidecars the app shares a netns with** (`network_mode: service:ts`). Most containers here
instead run the app and `ts` as peers on a shared bridge network and publish via
`TS_SERVE_CONFIG`. In that layout tailscaled terminates TLS and proxies onward, so the app
always sees the sidecar's bridge IP (e.g. `172.16.x.x`) in **both** modes. Don't treat the
absence of `100.x` in app logs as a failed switch — check which layout the compose uses first.

### Rollback
Remove the env line from module + root render, re-run `--stop --start --container <c>`.
No state is touched.

### Known bookkeeping drift
Manual copies do not update the module commit hash in `installed-modules.yaml`; a later
`module.sh update` reconciles it. Cosmetic, not functional.

## Checklist

Ordering is most-benefit-first. One container at a time; verify before moving on.

### Tier 1 — UDP / real-time (the actually-broken ones)
| Container | Repo | Status |
|---|---|---|
| valheim | containers | **DONE** 2026-07-27 (`f556535`) — verified 17+ min clean |
| minecraft | containers | **DONE** 2026-07-27 — Bedrock, UDP 19132/19133 |
| minecraft-java | containers | **DONE** 2026-07-27 — TCP 25565 + voice UDP 24454 |
| factorio | containers | not created — do if ever enabled |
| rustdesk | containers | not created — do if ever enabled |
| retroarch | containers | not created — do if ever enabled |
| mame | containers | not created — do if ever enabled |

### Tier 2 — high throughput (biggest CPU/throughput win; test a large transfer)
| Container | Repo | Status |
|---|---|---|
| jellyfin | containers | **DONE** 2026-07-27 (`7c53bd4`) — see note below |
| immich | containers | pending |
| nextcloud | containers | pending |
| filez | containers | pending |
| zipline | containers | pending |
| paperless | containers | pending |

**Tier 2 transfer test — what it can and cannot tell you.** Once a container is switched
there is no before/after available for it, so the transfer number is a *sanity check* that
the path is healthy, not an A/B. Method used on jellyfin: fetch a multi-MB static asset 10x
over the `*.${TS_DOMAIN}` name and 10x over the direct published port, with
`-H 'Accept-Encoding: identity'` so both move the same bytes.

jellyfin result: **59 MB/s tailnet vs 480 MB/s direct** (4.45 MB asset, 10 runs each).
The gap is expected and is *not* a kernel-mode problem — the tailnet run adds TLS
termination and a WireGuard encap/decap hop that the direct run skips. Both are far above
any real client's demand. Treat a tailnet figure in this range as pass; investigate only if
it lands in single-digit MB/s.

If a genuine A/B matters for a future container, capture the tailnet number *before* editing
the compose file.

### Tier 3 — everything else (stateless web apps, lowest risk)
actual-budget, actual-budget-api, borgitory, changedetection, code, collabora, dawarich,
eurooffice, freshrss, homarr, homepage, kanboard, karakeep, nextcloud-whiteboard, obsidian,
obsidian-babel-livesync, onlyoffice, paste, searxng, secure-browser, seerr, stirling-pdf,
the-lounge, trilium, uptime, wallabag, your-spotify, quicken *(personal repo)*

### Tier 4 — last, glance at config first
forgejo, vaultwarden, netdata, portainer, recon *(two sidecars — do both, incl. `ts-lazylibrarian`)*

---

# Follow-on: network throughput audit

Separate work item. Findings should eventually graduate to `docs/NETWORK_TUNING.md`.

**No network tuning of any kind has ever been applied to this host.** Every buffer, offload
and congestion setting is stock Ubuntu, with one exception (`fq_codel`, set deliberately for
bufferbloat in 2024). The NIC is **2.5GbE** (RTL8125B / `r8169`, linked at 2500Mb/s full),
not 1Gb, so defaults are further from optimal than usual. NIC counters are clean:
**0 errors, 0 drops, 0 missed** over 11 days.

### Governing rule
Change **one** thing, measure, keep or revert. A confident theory survived two rounds of
reasoning tonight and was only settled by a controlled A/B. Nothing below is adopted without
a before/after number.

### Step 0 — build the measuring rig first (blocking)
- Install `iperf3` on `neuromancer` and `wintermute` (`192.168.0.2` / `100.67.223.82`).
  `wintermute` is the right target: reachable **both** LAN-direct and over Tailscale, so each
  change can be measured on both paths and attributed correctly.
- Baseline table: TCP + UDP, LAN-direct vs Tailscale, with `mpstat`/`pidstat` CPU per run.
  Without the CPU column, offload changes look like no-ops.

### Ranked candidates

1. **Finish the kernel-mode rollout above — highest confidence, already proven.**
   Measured: `37 userspace sidecars = 26.9% CPU (lifetime avg) + 1.13 GiB RSS` vs the host's
   single kernel-mode daemon at `2.6% / 0.12 GiB`. With CPU pressure `some avg10=13.49%` and
   9.4 GiB swapped, software-path networking is CPU-bound — CPU contention *is* the ceiling.

2. **`rx-udp-gro-forwarding on` — Tailscale's own recommendation, currently off.**
   `enp4s0`: `rx-udp-gro-forwarding: off`, `rx-gro-list: off`. Tailscale recommends `on`/`off`
   for hosts forwarding tailnet traffic — this host does (`ip_forward=1`, ~46 sidecars).
   `rx-gro-list` already matches but incidentally (driver default). Nothing sets these
   anywhere: no systemd unit, no networkd-dispatcher hook, no rc.local, no cron.
   Low risk, instantly reversible. **Does not survive reboot** — the persistence hook is the
   real work item.

3. **Investigate `scatter-gather` / TSO being off — the anomaly.**
   `scatter-gather: off`, `tcp-segmentation-offload: off`, so `generic-segmentation-offload:
   off [requested on]` — GSO wants to be on and is blocked because it depends on SG. Atypical
   for RTL8125B; nothing on the host disabled it, so likely an `r8169` default for this chip
   revision (possibly errata). SG off means every skb must be linear -> extra copies -> more
   CPU per packet. Try `ethtool -K enp4s0 sg on tso on`, measure, **revert immediately** if no
   gain or any instability. Real chance the driver disabled this for a reason.

4. **Socket buffer maxima — stock and low.** `net.core.rmem_max`/`wmem_max` = **212992
   (208 KiB)**. Raise toward 16 MiB via a new `/etc/sysctl.d/` drop-in. Honest scope: helps
   **high-BDP** paths (WAN / remote tailnet peers), not LAN. Low risk.

5. **BBR congestion control — currently `cubic`.** Helps most on lossy/higher-latency paths,
   i.e. the remote-player case. Pairs with existing `fq_codel`. Confirm `tcp_bbr` module first.

6. **`net.core.netdev_max_backlog = 1000`** — stock, low for 2.5GbE. Cheap; bundle with #4.

7. **Docker `userland-proxy` (enabled) — deprioritised.** Adds a `docker-proxy` userspace hop
   per published port. Real but modest, and only affects containers using `ports:`. Disabling
   requires a daemon restart = **every container restarts**. High disruption, low payoff.

8. **Jumbo frames — recommend skipping.** NIC advertises 9194 bytes; MTU is 1500. Only pays
   off on a same-subnet path where every switch agrees, and `tailscale0` is 1280 regardless,
   so tailnet traffic gains nothing.

### Stability item (not throughput — don't conflate)
`journalctl -k` shows an unexplained **~35s link-down/up on `enp4s0` at Jul 26 18:42**
(2.5Gbps renegotiated after). Correlate with `system-network-watchdog.sh` logs.

### Coverage gaps (need root)
- `/etc/netplan/*.yaml` unreadable as `chrisl8` — may contain interface config that conflicts
  with any offload/MTU change.
- `dmesg` restricted (`kernel.dmesg_restrict=1`); used `journalctl -k` instead.
