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
| immich | containers | **DONE** 2026-07-27 (`a45ee22`) — A/B'd: 58.3 -> 61.6 MB/s |
| nextcloud | containers | **DONE** 2026-07-27 (`7cee2ca`) — A/B'd: no change, see below |
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

**immich was A/B'd properly** (4.85 MB asset, 10 runs each, same tailnet path):

| | avg | peak |
|---|---|---|
| before (userspace) | 58.3 MB/s | 67.6 MB/s |
| after (kernel) | 61.6 MB/s | 70.3 MB/s |

**+5.7% — real but modest, and it undercuts the stated Tier 2 rationale.** Sequential TCP
over a host-loopback tailnet path is not where userspace mode hurts. TCP retransmits hide the
loss (that's exactly why this went unnoticed for years, per "Why it hid for years" above), and
on this path the ceiling is TLS + WireGuard crypto CPU, not the netstack. So a big Tier 2
throughput win should **not** be expected, and its absence is not evidence the switch failed —
the verify block is the authority on that.

The two claims that do hold are unchanged: the ~11% inbound UDP loss (Tier 1, already proven
on valheim) and the aggregate CPU/RSS reduction (`37 userspace sidecars = 26.9% CPU + 1.13 GiB`
vs `2.6% / 0.12 GiB` for the host's kernel-mode daemon).

**nextcloud was then measured with CPU included** — and this is the result that matters.
Same container, same 17.6 MB asset, 10 runs, identical byte count, same tailscaled 1.98.9,
CPU sampled from `/proc/<pid>/stat` (utime+stime) of the sidecar's own tailscaled:

| | throughput | sidecar CPU per GiB |
|---|---|---|
| before (userspace) | 111.4 MB/s | 21.46 CPU-s |
| after (kernel) | 111.1 MB/s | 21.65 CPU-s |

**No benefit. Not a small benefit — none.** Script: `scripts/ts-measure.sh`.

## STOP — the Tier 2/3 rationale does not survive measurement

Three Tier 2 containers are converted and measured. The throughput/CPU case for converting
the rest is not supported:

- jellyfin: 59 MB/s (no baseline captured)
- immich: 58.3 -> 61.6 MB/s (+5.7%)
- nextcloud: 111.4 -> 111.1 MB/s, 21.46 -> 21.65 CPU-s/GiB (**no change**)

**Why the original justification was wrong.** The headline number above —
`37 userspace sidecars = 26.9% CPU + 1.13 GiB RSS` vs `2.6% / 0.12 GiB` for the host daemon —
compares **37 processes against 1 process**. 37 x ~0.55% = 26.9% and 37 x ~31 MB = 1.13 GiB;
the arithmetic just recovers the per-process baseline cost of *being a Tailscale node at all*
(control plane, netmap, DERP), which every sidecar pays in either mode. It never isolated
userspace-vs-kernel, so it cannot support a kernel-mode rollout. Measured directly, the host's
own kernel-mode daemon is the **largest** tailscaled on the box at 145.8 MB RSS.

**Why there's no win here specifically.** These containers run app and `ts` as peers on a
shared bridge and publish via `TS_SERVE_CONFIG`. tailscaled terminates TLS and proxies HTTP
itself, in userspace, *regardless of TUN mode*. Kernel mode changes how packets reach that
proxy, not the proxy. It arguably adds a hop: out to `tailscale0` and back into tailscaled's
own listener, rather than staying inside the netstack.

And the UDP-loss fix — the one proven, dramatic win — **does not apply to this class at all**.
A `TS_SERVE_CONFIG` HTTPS reverse proxy carries no UDP to the app. Tier 1 earned its fix
because those are raw UDP game servers; Tier 3 is entirely stateless web apps.

**What was checked and did NOT hold up** (recorded so it isn't re-raised): kernel sidecars
looked like they used +15-140 MB RSS. They don't. Go retains transfer buffers and releases
them lazily — nextcloud-ts read 187 MB right after its transfers and fell to 68 MB within
two idle minutes. There is no RSS regression. The version confound was also ruled out
(`code-ts`/`paperless-ts`/`homepage-ts` run 1.98.9 in userspace).

### Honest limits of this measurement
Single-stream, host -> its own tailnet IP over the docker bridge. It does **not** cover many
concurrent connections, or real remote clients over WAN/DERP where loss and RTT are higher.
The CPU figure is sampled at the sidecar so it is attributable regardless of client, but a
high-concurrency or lossy-path win remains unmeasured rather than disproven.

### Recommendation
The three converted Tier 2 containers are fine — kernel mode is not harmful, node identity
survived, and fleet uniformity has some operational value. **Leave them.** But do not convert
the remaining ~42 on a throughput/CPU argument that measurement does not support. Convert a
Tier 2/3 container only if it has a specific reason (raw UDP, `network_mode: service:ts`, or
a measured problem), not as a sweep.

### Tier 3 — everything else (stateless web apps, lowest risk)
actual-budget, actual-budget-api, borgitory, changedetection, code, collabora, dawarich,
eurooffice, freshrss, homarr, homepage, kanboard, karakeep, nextcloud-whiteboard, obsidian,
obsidian-babel-livesync, onlyoffice, paste, searxng, secure-browser, seerr, stirling-pdf,
the-lounge, trilium, uptime, wallabag, your-spotify, quicken *(personal repo)*

### Tier 4 — last, glance at config first
forgejo, vaultwarden, netdata, portainer, recon *(two sidecars — do both, incl. `ts-lazylibrarian`)*

## If you flip everything at once without restarting

Considered: edit `TS_USERSPACE=false` into all remaining sidecars and let each pick it up
whenever it next restarts (reboot, DIUN image update, `module.sh update`). Prerequisites are
genuinely fine — **re-verified independently: zero sidecars lack `/dev/net/tun` or
`net_admin`** — and 6/6 conversions so far came up clean first try. The risk is not spread
evenly across the fleet, though. It is concentrated in two containers.

**`recon` — do NOT include it in any bulk flip.** Its sidecar is not like the others:
`network_mode: "service:gluetun"`, no `TS_SERVE_CONFIG`. tailscaled runs *inside the VPN
container's netns*, shared with all 8+ `*arr` apps. That netns already has
`tun0 = 100.64.2.159/32`, and gluetun's killswitch carries
`FIREWALL_OUTBOUND_SUBNETS=100.64.0.0/10`. Tailscale's own address space **is**
`100.64.0.0/10`. Kernel mode would create a second TUN there and install routes and policy
rules for the very range gluetun's VPN and firewall already occupy. Userspace mode needs no
interface and no routing changes, which is plausibly *why* this works today. This is the
container that once wedged whole-stack startup; a collision here takes the whole `*arr` stack
and the VPN killswitch with it.

**`obsidian` — moderate.** Uses `network_mode: service:ts`, so it is in the set where the app
genuinely sees `100.x` instead of `127.0.0.1`. Worth a look at its auth config first.
(`pure-ftpd`, `factorio`, `rustdesk` also use `service:ts` but are **not installed** — no risk.)

The remaining ~36 are the `TS_SERVE_CONFIG`-on-a-shared-bridge class: prerequisites met, no
source-IP change, same shape as the six already converted. Low risk individually.

**The deferred part is the worst property, though.** The change lands unattended — most likely
during the boot cron path or a `module.sh update` sweep — on ~36 containers *simultaneously*,
with nobody watching. Failures would be correlated and would need bisecting across 36 changed
containers instead of one. That is an acceptable trade for a large benefit. It is a poor trade
for a benefit measured at zero for exactly this class of container.

**Verdict:** if uniformity is the goal, it is defensible — but exclude `recon` unconditionally,
check `obsidian` first, and prefer landing it during a watched `--stop --start` sweep rather
than blind at boot. Otherwise the cleanest answer is to leave the fleet alone.

---

# Follow-on: network throughput audit

Separate work item. Findings should eventually graduate to `docs/NETWORK_TUNING.md`.

## Read this before starting: what the box is actually required to do

**Design target: 2-5 people doing one or two things at a time.** Not 10 concurrent users, not
everything at once. Heavy scheduled jobs (the 23:00 borg run) are deliberately placed in
windows when nobody is using the box — if that ever stopped being true, the fix is to move the
schedule, not to tune the network stack.

Everything below is an optimization list with **no current problem to point at**. Measured
2026-07-27 with two real Valheim players connected: CPU pressure `some avg10=1.99`, memory
pressure `0.00`, load 1.82 at 11 days uptime, NIC counters clean (0 errors / 0 drops /
0 missed over 11 days). Valheim held a 1h24m continuous session with zero `timeout detected`
events and a steady `Connections 2`.

So: **do not start this audit on general principle.** Start it when there is a specific
complaint — a stutter, a slow sync, a transfer that takes longer than it should — and let that
complaint pick the candidate. The ranked list below is a menu for when something hurts, not a
backlog to burn down. This document has already had its top-ranked item measure to zero
(see the STOP section above); treat the rest with the same suspicion until a symptom points
at one.

**No network tuning of any kind has ever been applied to this host.** Every buffer, offload
and congestion setting is stock Ubuntu, with one exception (`fq_codel`, set deliberately for
bufferbloat in 2024). The NIC is **2.5GbE** (RTL8125B / `r8169`, linked at 2500Mb/s full),
not 1Gb, so defaults are further from optimal than usual. NIC counters are clean:
**0 errors, 0 drops, 0 missed** over 11 days.

### Governing rule
Change **one** thing, measure, keep or revert. A confident theory survived two rounds of
reasoning tonight and was only settled by a controlled A/B. Nothing below is adopted without
a before/after number.

This rule has already paid out once, against this document's own top-ranked item: the
kernel-mode rollout was ranked #1 on "highest confidence, already proven" and measured to
zero effect for Tier 2. Rank order here is a hypothesis, not evidence. Capture the baseline
**before** touching anything — jellyfin was converted before anyone thought to measure it,
and that number is now unrecoverable.

### Step 0 — build the measuring rig first (blocking)
- Install `iperf3` on `neuromancer` and `wintermute` (`192.168.0.2` / `100.67.223.82`).
  `wintermute` is the right target: reachable **both** LAN-direct and over Tailscale, so each
  change can be measured on both paths and attributed correctly.
- Baseline table: TCP + UDP, LAN-direct vs Tailscale, with `mpstat`/`pidstat` CPU per run.
  Without the CPU column, offload changes look like no-ops.

### Ranked candidates

1. ~~**Finish the kernel-mode rollout — highest confidence, already proven.**~~
   **WITHDRAWN 2026-07-27 — the supporting measurement was invalid.** It compared 37 sidecar
   processes against 1 host daemon, so it only recovered per-process baseline node overhead,
   which both TUN modes pay. Direct A/B on nextcloud: `111.4 -> 111.1 MB/s` and
   `21.46 -> 21.65 CPU-s/GiB` — no change. See the STOP section above. The rollout still stands
   for Tier 1 (raw UDP), which is separately proven; it is not a throughput lever.

   **Replaced by candidate 0 below, which is where that CPU actually goes.**

0. **Where is 2.2 cores per 111 MB/s going? — the biggest unexplained cost found so far.**
   The nextcloud A/B measured the sidecar's *own* tailscaled at **21.65 CPU-seconds per GiB**.
   At 111 MB/s that transfer takes ~9.7s wall, so tailscaled alone burned **~2.2 CPU cores'
   worth** to serve one stream — and it did so *identically in both TUN modes*, which is
   precisely why kernel mode changed nothing. The cost is not the netstack. It is WireGuard
   crypto plus TLS termination plus the HTTP proxy hop, all inside tailscaled.

   That is the real ceiling and nothing in the current list addresses it. Measure with
   `scripts/ts-measure.sh` before/after any change here. Sub-questions:
   - How much is WireGuard vs TLS? Compare a `tailscale serve` HTTPS path against plain HTTP
     over the tailnet to the same app.
   - Does the sidecar benefit from more cores, or is it single-flow-bound? Check thread-level
     CPU during a transfer.
   - Is this figure normal for tailscaled, or is this host's crypto path slow? Compare against
     the host daemon serving an equivalent transfer.

0b. **Is the 46-sidecar architecture itself the bottleneck? — worth asking, currently unasked.**
   Every service runs its own tailnet node: its own WireGuard endpoint, its own DERP
   connection, its own netmap/control-plane traffic, its own TLS termination, its own LetsEncrypt
   certs, plus a `docker-proxy` hop for any published port. Candidate 0 shows the per-stream
   cost of one such node is ~2.2 cores; this asks whether having ~46 of them is the wrong shape
   for a single 31 GiB host that is already memory-oversubscribed and swapping.

   Alternatives to cost out — **not** a recommendation, an audit question:
   - One tailnet node fronted by the **Caddy instance this repo already runs**, reverse-proxying
     to services over the docker network. 46 nodes -> 1.
   - Tailscale `serve` on the *host* daemon rather than per-container sidecars.
   - Keep sidecars only where per-service tailnet identity is actually load-bearing.

   Real costs of consolidating, which is why the sidecar design exists and why this needs
   costing rather than assuming: per-service ACL tags and MagicDNS names, per-service isolation,
   blast radius of one shared proxy, cert consolidation, and the LE rate limit already known to
   bite when many sidecars start at once. Also note the aggregate baseline is not nothing —
   ~36 idle sidecars at ~27-38 MB RSS each is ~1.1 GiB of RSS spent on being nodes, on a host
   with a livelock history.

   **This host already has one data point, and it points the same way.** The Euro-Office
   perf fix (2026-06-13) found Nextcloud <-> doc-server traffic was routing out through the
   Tailscale sidecars and TLS even though both containers sit on the same host. Putting them
   on a shared docker bridge (`office-shared`) and using plain-HTTP internal URLs took it from
   **~50-150ms per request to ~15-30ms** — a 3-5x latency win purely from *not traversing the
   sidecar path*. That is prior evidence, on this box, that the sidecar hop is expensive and
   that bypassing it where it isn't needed pays. Start the audit by looking for other
   same-host service-to-service pairs still going out through the tailnet the long way.

   Deliverable: a measured comparison of one service via sidecar vs the same service via Caddy
   on a shared node — CPU-s/GiB and RSS — before anyone proposes changing the architecture.

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
