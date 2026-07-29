# Sonarr: shows that silently never download

## The symptom

A monitored series just never grabs. No error, no warning, nothing in Activity.
Sonarr searches on schedule, finds plenty of releases, rejects every single one,
and reports nothing anywhere in the UI.

Star Trek: Voyager sat at **0 of 173 episodes** this way. An interactive search
returned 497 releases — 423 of them from usenet — and Sonarr rejected all 497.
The top reason was `DVD is not wanted in profile`, repeated 313 times.

Nothing was broken. Prowlarr, SABnzbd, and the indexers were all fine.

## The cause

Voyager was on the **WEB-2160p** profile, which allows only `WEBDL-2160p` and
`WEBRip-2160p`. Voyager was shot on 35mm but edited and finished on
standard-definition NTSC video, and unlike TNG it was never remastered — the
film elements were never rescanned. **A 4K Voyager cannot exist.** The profile
was asking for something physically unavailable, forever.

This is not fixable with custom format scores. There is no overlap to score.

## Why there isn't a stock TRaSH profile for this

TRaSH publishes no SD profile. Every English Sonarr profile they ship is
WEB-era:

| Stock TRaSH profile | Allows |
| --- | --- |
| WEB-1080p | WEB 1080p only |
| WEB-2160p | WEB 2160p only |
| WEB-2160p (Combined) | WEB 2160p + WEB 1080p |
| [Anime] Remux-1080p | Bluray/WEB 1080p → 720p → 480p → DVD → SDTV |

The anime profile is the only one that reaches DVD, and it is unusable for live
action: it sets `min_format_score: 100`, so a DVD release scoring 0 is rejected
outright, and it drags in the anime tier scoring.

So `Best Available (SD-1080p)` is defined locally in
`recon/config-defaults/recyclarr-configs/sonarr.yml`. It is the **one**
deliberate deviation from "just use TRaSH profiles" — taken because TRaSH has
nothing to inherit from, not because bespoke tuning was wanted.

`WEB-2160p (Combined)` was considered as a stock alternative and rejected: it
still only accepts WEB-quality releases (it would have gotten Voyager to 1/173),
and its 1080p-plus-4K range with a 4K cutoff means every new episode grabs 1080p
on air night and re-downloads in 4K later. That churn is the thing we're
avoiding.

## When: finding stuck shows

```bash
./scripts/sonarr-stuck-series.js
```

Free, no indexer traffic. Flags any monitored series with missing episodes whose
profile floor is above what could have existed when it aired (no 4K TV masters
before ~2013, no HD before ~1998).

To confirm a suspect for real:

```bash
./scripts/sonarr-stuck-series.js --verify 39
```

This runs an actual indexer search and reports found-vs-accepted. `releases > 0`
and `accepted == 0` is the definitive signature. **One series at a time on
purpose** — sweeping every series would hammer every indexer in Prowlarr and
risk a ban.

## How: fixing one

Sonarr picks a quality profile once, when the series is added, and never
revisits it. There is no rule engine — Jellyseerr can only set a default per
server plus a separate anime default, and Recyclarr syncs profile *contents*,
not per-series assignment. So this is a manual step, by design.

In Sonarr: **Series → (show) → Edit → Quality Profile → `Best Available
(SD-1080p)`**. Or bulk: **Series → Mass Editor**.

There is only ever one profile to pick. It covers both failure cases — DVD-era
shows and shows with HD but no 4K.

## What the profile does

Allows `SDTV` → `Bluray-1080p`, cutoff at `WEB 1080p`.

Capped at 1080p deliberately. A show needing this profile has no 4K by
definition, and the cap makes Dolby Vision Profile 5 — a 2160p format, and the
thing that broke local decoding — structurally impossible here.

`Upscaled` is scored **-10000**, and it is load-bearing. Every 720p/1080p
"release" of a DVD-era show is an AI upscale of the SD master. Without the
floor, Voyager grabs DVD and then immediately "upgrades" to one of the 40
HDTV-720p upscales the indexers carry — churn *and* worse picture. `x265` and
`10bit` are left at 0, unlike on WEB-2160p, because both are fine and common for
DVD-era encodes.

**Known gap:** the `Upscaled` CF is title-based and imperfect. It caught 105 of
Voyager's upscales but misses the `iNTERNAL MULTi 1080p WEB x264-N3TFL1X`
releases, which are upscales that don't say so.

The delay profile does **not** save you here. It looks like it should —
`torrentDelay` is 1440 minutes and `bypassIfHighestQuality` doesn't fire because
`Bluray-1080p` outranks `WEB 1080p` in the profile — but **Sonarr bypasses delay
profiles entirely for user-invoked searches**. Kicking a series search from the
UI or API is user-invoked, so the delay is skipped and the torrent upscale
competes on quality rank alone, where 1080p beats 480p.

Observed on the Voyager backfill: of the first 44 grabs, 41 were usenet
`WEBDL-480p` (the correct AMZN source) and 3 were torrent `WEBDL-1080p`
upscales. So a DVD-era show backfilled this way ends up with a small minority of
episodes as oversized upscales — same detail, bigger file, inconsistent library.
Cosmetic, not harmful, but worth knowing.

If it becomes annoying, the fix is a custom format matching the offending
release group scored -10000 on this profile.

## Series moved to this profile (2026-07-14)

Fifteen in total. The first twelve predate 2005:

```
1953  The Quatermass Experiment      0/12
1955  Quatermass II                  0/6
1958  Quatermass and the Pit         6/8
1963  Doctor Who                    15/749
1972  M*A*S*H                      251/254
1978  Blake's 7                     52/85
1979  Quatermass                     0/4
1995  Star Trek: Voyager             0/173
1997  Stargate SG-1                218/223
1999  Farscape                      90/92
2002  Stargate Infinity              0/26
2004  Stargate Atlantis            100/155
```

Three more were caught by the scanner and would have been missed by eyeballing
for old shows — they have HD but no 4K:

```
2005  Doctor Who (2005)            202/322
2009  Stargate Universe             40/76
2012  The Bleak Old Shop of Stuff    4/8
```

Stargate Universe verified at **761 releases found, 0 accepted** — 318 of them
`Bluray-1080p`.

The ones already near-complete (M\*A\*S\*H at 251/254, SG-1 at 218/223) got their
files under an older profile and had been frozen since. Moving them lets the
stragglers finish.

## Note on cutoff-unmet churn

Shows with existing DVD files now sit below the `WEB 1080p` cutoff, so they'll
appear in **Wanted → Cutoff Unmet**. This does *not* cause a mass re-download:
Sonarr only takes upgrades from RSS (new postings), and old catalog releases
aren't in RSS. A manual season search *would* trigger upgrades, so don't run one
on M\*A\*S\*H unless you actually want it in 1080p.

---

# Round two (2026-07-29): the same trap, on shows that aren't old

## What happened

`sonarr-stuck-series.js` reported **"No suspects"** while two series sat at zero
episodes, both requested days earlier through Seerr:

| Series | Files | Profile | Interactive search |
| --- | --- | --- | --- |
| The Good Place (2016) | 0/59 | WEB-2160p | 585 releases, **0 usable** |
| Infinity Train (2019) | 0/55 | WEB-2160p | 346 releases, **0 usable** |

Identical failure to Voyager — `WEBDL-1080p is not wanted in profile` and
friends, nothing in history, no trace anywhere in the UI.

## Why the scanner missed them

Its central test was:

```js
if (floor >= 2160) return year >= 2013;   // 4K masters exist after ~2013
```

The statement is true and **irrelevant**. Whether 4K existed *in the world* in a
given year says nothing about whether *this show* has a 4K master. A 2016 NBC
sitcom and a 2019 Cartoon Network series both sail past a 2013 cutoff and
neither will ever have one. The year test only ever caught the pre-2013 cases,
which the July sweep had already cleaned up — so the scanner had quietly stopped
being able to find anything.

**The fix is to stop predicting availability and start observing behaviour.**
The question that needs no guesswork:

> Has this had a fair chance to grab something, and grabbed nothing?

A 2160 floor is now treated as suspect at *every* year, and a recent successful
grab is what clears a series. That is free, and it fires on the actual failure
instead of a proxy for it.

## Second bug found: "missing" was being counted wrong

The scanner counted `totalEpisodeCount - episodeFileCount`, which includes
specials and unaired episodes. That flagged healthy shows (The Mandalorian at
24/25, Shrinking at 33/34) and wildly overstated others — Doctor Who reads
15/749, but only **38** episodes are actually wanted; the rest are unmonitored
lost episodes no search will ever produce.

Both scripts now use `wanted/missing?monitored=true`, which is exactly "aired
AND monitored AND has no file". This also cleared three false positives:
Westworld (36/99), Andor (24/47) and The Night Manager (6/12) have **zero**
wanted episodes — their gaps are unmonitored seasons, not failures.

## Root cause of the recurrence

**Seerr's default Sonarr profile is `WEB-2160p`.** Every TV request from every
user is born 4K-or-nothing; shows with a real 4K master work, and everything
else dies silently. This is not bad luck repeating — it is the default behaving
exactly this way every time.

Deliberately left as-is (2026-07-29). The alternatives each cost more than they
save: a combined SD→2160p profile re-downloads every episode of an airing show
(1080p on air night, 4K later), and defaulting to `Best Available (SD-1080p)`
just inverts the problem so 4K shows silently cap at 1080p. Repointing a series
takes seconds once you know, so **the alert is the fix**, not a profile change.

## Radarr has no escape hatch at all

Radarr has exactly one profile:

```
UHD Bluray + WEB  ->  WEBDL-2160p, WEBRip-2160p, Bluray-2160p
```

So every movie is 4K-or-nothing and **there is nowhere to move a stuck movie
to**. The usual fix simply does not exist on the Radarr side. Three movies are
sitting in this state, two of them 69-day-old requests:

```
1967  The Quatermass Experiment    (Hammer film, no 4K release)
2005  The Quatermass Experiment    (BBC live TV remake, no 4K will ever exist)
2016  The Woodsman                 (small indie, no 4K)
```

Fixing this needs a sub-4K Radarr profile added to the Recyclarr config in the
**module** (`.modules/do-it-self-containers/recon/config-defaults/recyclarr-configs/radarr.yml`),
mirroring what `Best Available (SD-1080p)` does for Sonarr. Not done yet.
`media-stall-check.js` prints a standing note while this remains true.

## The alert: `scripts/media-stall-check.js`

Runs from cron every 4 hours. **Silent (exit 0, no output) unless something
needs a decision** — cron mails any output, so silence when clean is what keeps
it from becoming noise.

```
0 */4 * * * /home/chrisl8/.local/share/fnm/aliases/default/bin/node \
              /home/chrisl8/containers/scripts/media-stall-check.js
```

node is called by absolute path on purpose: fnm's PATH entry is a per-shell
directory under `/run` that does not exist for cron. The
`aliases/default` symlink is stable across node upgrades.

**What it flags**

| Tier | Condition | Meaning |
| --- | --- | --- |
| NEVER | 0 files, added > 12h ago | never grabbed anything — the profile-trap signature |
| STALLED | has files, wanted episodes, no grab in 14 days | back catalog nobody kicked, or retention failures |

Twelve hours is the grace period for the automatic on-add search to run. Past
that, zero files means zero excuses — which is how The Good Place would have
been caught the same day instead of whenever someone complained.

**Requester attribution.** It joins against Seerr so the report leads with who
is waiting and for how long. Seerr is not host-reachable on `:5055` (internal
docker net) but its Tailscale sidecar serves the same API over HTTPS at
`https://seerr.jamnapari-goblin.ts.net/api/v1`. Seerr keys on tvdb/tmdb ids
while the *arrs key on their own ids, so the join needs a bridging lookup.

**Confirmation costs indexer queries.** Up to `STALL_MAX_CONFIRM` (default 2)
suspects per run get one real search, cached 7 days, so the email can say
*which* problem it is:

| Verdict | Meaning | Action |
| --- | --- | --- |
| `PROFILE_TRAP` | releases exist, blocked on profile grounds | repoint + `sonarr-kick-missing.js` |
| `UNUSABLE` | releases exist, rejected for other reasons | manual look / manual import |
| `NO_RELEASES` | nothing exists | indexer coverage or lost media; unfixable here |
| `CAN_GRAB` | releases are acceptable | download/import problem, check SAB |

That `PROFILE_TRAP` vs `UNUSABLE` split matters. Without it the script told us
the 1953 Quatermass was a profile trap and to set it to the profile **it was
already on** — its 2 releases are rejected as `Unable to parse release`, which no
profile change can fix.

**Silencing things.** Some decisions are "nothing can be done". Park those in
`scripts/media-stall-check.conf` (gitignored) by key (`tv:31`, `movie:22`) or
title substring. Prefer keys — "Quatermass" matches five separate items. Excluded
titles still show as a count in the report footer, so the list stays visible.

Tunable via env: `STALL_GRACE_HOURS`, `STALL_STALE_DAYS`, `STALL_RENAG_DAYS`,
`STALL_MAX_CONFIRM`, `STALL_MOUNT`.

## Division of labour between the three scripts

- **`media-stall-check.js`** — the automated one. Sonarr + Radarr + Seerr, all
  stall causes, runs unattended from cron.
- **`sonarr-stuck-series.js`** — manual, Sonarr-only, focused on the 4K trap.
  `--verify <id>` is the definitive single-series check.
- **`sonarr-kick-missing.js`** — the remedy. Searches only episodes with no
  file, so it cannot trigger cutoff-unmet upgrades.

## Resolution (2026-07-29)

Both series repointed to `Best Available (SD-1080p)` and kicked (50 and 40
episode searches). Both began grabbing immediately — The Good Place on
`1080p BluRay`, Infinity Train on `1080p AMZN WEB-DL`.
