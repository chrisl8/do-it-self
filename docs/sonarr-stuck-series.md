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

Free, no indexer traffic. Flags monitored series with wanted episodes on a
4K-only profile that have never grabbed anything.

> **Superseded for routine use.** `scripts/media-stall-check.js` runs from cron
> and catches strictly more (Radarr and Seerr too, and every stall cause rather
> than just this one). This script is now the manual deep-dive, and its `--verify`
> is the definitive single-series check. Note that the year-based heuristic
> described in the original version of this section was **wrong** and has been
> removed — see "Round two" below for why.

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

## Radarr had no escape hatch at all — fixed 2026-07-29

Radarr had exactly one profile:

```
UHD Bluray + WEB  ->  WEBDL-2160p, WEBRip-2160p, Bluray-2160p
```

So every movie was 4K-or-nothing, and because it was the *only* profile there
was **nowhere to move a stuck movie to** — the Sonarr fix had no target on this
side.

Added a local `Best Available (SD-1080p)` for Radarr, mirroring the Sonarr
profile of the same name, in the **module** at
`.modules/do-it-self-containers/recon/config-defaults/recyclarr-configs/uhd-bluray-web.yml`
(module commit `70f4a39`). Bluray-1080p down to SDTV, cutoff WEB 1080p, same
`Upscaled` floor.

Both profiles have to share one instance block: Recyclarr rejects two config
instances with the same `base_url`. That is also why the file keeps its
now-misleading name — renaming it would leave the old copy in the deployed
`recyclarr-configs` directory, and two files declaring `radarr@localhost:7878`
is exactly that Split Instances error.

**Deliberately excluded**, all of which Radarr offers: `Remux-1080p` (102+
MB/min, so a 2h film is 12 GB+ — this is a fallback profile, not an archival
one), `DVD-R`/`BR-DISK`/`Raw-HD` (disc images and raw transport streams), and the
whole cam tier. A movie having no 4K release is not a reason to accept a
camcorder rip.

### The three stuck movies were not profile traps

Worth recording, because it is the opposite of the Sonarr result. All three were
moved to the new profile and re-searched. **None of them grabbed anything**:

| Movie | Releases | Reality |
| --- | --- | --- |
| The Quatermass Experiment (1967) | **0** | nothing exists at any quality |
| The Woodsman (2016) | **0** | nothing exists at any quality |
| The Quatermass Experiment (2005) | 5, all `Unknown` | unparseable |

The 2005 BBC live remake returns only bare titles like
`The Quatermass Experiment 2005` — no source, resolution or release group — so
Radarr cannot determine a quality and files them all as `Unknown`.

This produced a false verdict worth guarding against: **`Unknown is not wanted
in profile` reads exactly like a profile rejection but is not one.** Widening the
quality range cannot fix it, and allowing `Unknown` would mean accepting
literally any file. `media-stall-check.js` now excludes that specific rejection
from its profile-trap test so it reports these as `UNUSABLE`, not as something a
profile change would solve.

All three are parked in `media-stall-check.conf`. They stay on the new profile
rather than reverting, so if a release ever does appear they will grab it.

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

---

# The Quatermass serials, chased down (2026-07-29)

Three serials were alerting. The expectation going in was "they probably don't
exist either." That was right for one of three, and the profile was the blocker
in **none** of them. Worth recording because each failed for a different reason,
and only one of those reasons was fixable by anything we had built.

## Results

| Serial | Verdict |
| --- | --- |
| Quatermass II (1955) | **obtainable — now 6/6** |
| The Quatermass Experiment (1953) | 4 of 6 episodes exist nowhere on earth |
| Quatermass (1979) | nothing on the indexers at all |

The useful control was **Quatermass and the Pit (1958)**, sitting at 6/6 from a
BFI Blu-ray rip (`...Bluray-1080p.x264.DTS.-AOS`) grabbed the day the set was
added. A 1950s BBC Quatermass serial being complete proves these rips circulate,
so "old and obscure" was never a sufficient explanation for the others.

## Quatermass II — a naming problem, not an availability problem

Six releases existed, all on LimeTorrents, and Sonarr rejected every one:

```
Unable to identify correct episode(s) using release name and scene mappings  x4
Unknown is not wanted in profile                                             x1
Not enough seeders: 0. Minimum seeders: 1                                    x1
Unable to parse release                                                      x1
```

The per-episode rips are named `Quatermass II  Episode 4  The Coming (1955)` and
`Quatermass II  1of6  The Bolts (1955)`. Sonarr cannot read "Episode 4" or
"1of6" as episode numbers — it mapped only the `1of6` one, and that failed on
zero seeders. The complete pack, `Quatermass II [1955  UK] BBC sci fi mini
series` (2.09 GB, 6 seeders), was unparseable outright.

**The fix — `release/push` with a corrected title.** This is the reusable
technique. Sonarr's interactive-search override does *not* work here:

```
POST /api/v3/release  ->  404
"Unable to parse episodes in the release, will need to be manually provided"
```

It validates against its own **cached parse** of the release, so supplying
`seriesId`/`episodeIds` in the body changes nothing. `release/push` is different
— it parses a title *you* provide, against whatever `downloadUrl` you point it
at:

```js
POST /api/v3/release/push
{
  title: "Quatermass II (1955) S01 SDTV x264-MANUAL",   // parseable by Sonarr
  downloadUrl: <the original release's downloadUrl>,     // the real file
  protocol: "Torrent", publishDate, indexerId, size
}
```

Result: `S1 fullSeason=true, quality=SDTV, approved=true`. Sonarr grabbed it,
mapped all six episodes, and imported cleanly at 6/6 — the internal filenames
(`Quatermass II [1955] Part 1 - The Bolts.mkv`) matched TVDB episode titles, so
no Manual Import was needed after all.

Two things to get right when doing this:
- **Name a quality the profile allows.** `SDTV` in the pushed title makes Sonarr
  parse it as SDTV, which `Best Available (SD-1080p)` accepts. Leaving it
  `Unknown` reproduces the original rejection.
- **The response says `series: (none)`** even on success. Ignore it — check
  history and the queue instead. It grabbed and mapped correctly regardless.

## The Quatermass Experiment (1953) — permanently incomplete

Two releases, both unparseable, and one of them names the problem:

```
The Quatermass Experiment (1953) Parts 1   2 only     0.41 GB, 0 seeders
Quatermass Experiment [1953  UK] BBC sci fi mini series   0.80 GB, 4 seeders
```

The BBC telerecorded only episodes 1 and 2 of the live 1953 broadcast before
abandoning the process. **Episodes 3–6 were never recorded and exist nowhere.**
No profile, indexer or technique reaches them.

Episodes 3–6 are now **unmonitored**, which drops Sonarr's wanted count for the
series from 6 to 2 and stops it being permanently, misleadingly incomplete. The
0.80 GB / 4-seeder torrent may hold the two survivors, but its contents are
unverified (it could be the 2005 live remake) — push it the same way if you want
them, and check Manual Import before accepting anything.

## Quatermass (1979) — genuinely absent

24 results, **not one of them this show**. Eighteen were rejected as
`Wrong series` — every hit was *Quatermass and the Pit* (1958) bleeding into the
query, including files already on disk (`Existing file on disk is of equal or
higher preference: Bluray-1080p v1`). The Thames/Euston serial returns nothing;
it would need a Network DVD/Blu-ray rip from somewhere else entirely.

## Alert fix this exposed: queue-awareness

The Quatermass II pack spent a while at 58 KB/s on a single seed with a 19-hour
ETA. During all of that the series had **zero files** and an `added` date months
old, so it matched the `NEVER` tier perfectly and would have paged the next
morning about a download that was working fine.

`media-stall-check.js` now skips anything with an active queue entry. A download
that *dies* is still caught, because the queue entry disappears and the series
falls back to having no files — so this suppresses false alarms without creating
a blind spot.

Effect on the report: **9 items down to 3**, and all three remaining are back
catalog that just needs `sonarr-kick-missing.js`, not anything stuck —
Fullmetal Alchemist: Brotherhood (14 wanted), Stargate Atlantis (53),
Doctor Who 1963 (38).

---

# Season 0 was inventing most of the backlog (2026-07-29)

## The question that exposed it

"Do we need an automated kick mechanism?" — because back catalog structurally
never self-heals, so every missing episode needs a human to remember to search.
The answer turned out to be **no**, because most of the backlog was not real.

## 91 of 105 "wanted" episodes were DVD extras

Season 0 is where TVDB files extras and oddities. They were monitored, so Sonarr
counted them as wanted forever:

```
Stargate Atlantis    regular episodes: 100/100  <- COMPLETE
  the 53 "wanted":   Mission Directive: Sanctuary
                     Set Tour with Martin Wood and Peter DeLuise
                     Diary of Rainbow Sun Francks
                     A Look back on Season 1 with Martin Gero

Doctor Who (1963)    regular episodes: 14/694, 0 monitored+aired+missing
  the 38 "wanted":   Death Comes to Time (5 webcast parts)
                     Real Time (5 webcast parts)
                     The Five Doctors, the 1963 unaired Pilot
```

Stargate Atlantis is **finished**. It only looked stalled because its 155 total
folds in 55 featurettes. None of these were ever released as standalone files.

## Why that killed the case for a sweeper

From live Prowlarr data: **9 enabled indexers, so one episode search costs ~9
queries.**

| | |
| --- | --- |
| Full pass over the 105-item "backlog" | ~945 queries |
| …of which are DVD extras | **~820 wasted, every pass, forever** |
| Real backlog | 14 episodes, ~126 queries, one-off |
| Last 7 days | 10,947 queries → **155 grabs** |
| …grabs from NZBgeek | **151 of 155** |

The eight torrent indexers produced **4 grabs from ~9,500 queries** in a week.
A periodic sweeper would have spent its budget re-searching featurettes against
public trackers that rate-limit and a paid indexer with a daily API cap.

**Fix the accounting, not the automation.** Both scripts now exclude season 0
from the wanted count, and derive have/total from regular seasons only.

If automation is ever wanted, the shape is a budgeted trickle with **per-episode
exponential backoff** (1d → 3d → 1w → 2w → 1mo → quarterly floor), not a sweep:
searching is the only way to learn whether a gap is real, so bound how much
effort goes into finding out.

## The ended-vs-continuing trap

Blanket-unmonitoring season 0 is **wrong**, and nearly got done anyway. Season 0
is not only extras — for Doctor Who, TVDB files real broadcast specials there:

```
Doctor Who (2023)  CONTINUING  S0 = The Star Beast, Wild Blue Yonder, The Giggle
Doctor Who (2005)  ended       S0 with files:    The Christmas Invasion, The Runaway Bride
                               S0 without files: Children in Need: Born Again, Time Crash
```

Unmonitoring a **continuing** show's season 0 silently stops future Christmas
specials being grabbed. The safe line is `series.ended`:

- **ended** → unmonitor season 0. Nothing new will air, so there is no cost.
- **continuing** → leave it alone.

Applied to 4 ended series (280 episodes: SG-1 4, Atlantis 55, Doctor Who 2005
169, Doctor Who 1963 52). Files are untouched — 56 of those episodes have files
and keep them. The season-level `monitored` flag was cleared too, so a future
TVDB refresh cannot quietly re-add specials to the wanted list. Doctor Who (2023),
Grantchester and INVINCIBLE were deliberately skipped.

Report went from **9 items to 1**.

## The one real gap: Fullmetal Alchemist: Brotherhood

Kicked (14 episodes). **Found nothing** — 87 releases for S01E16 alone, zero
acceptable. This is a genuinely stuck series but a different flavour from the
4K trap, and it is an **open thread**:

```
 32 | Custom Formats Language: Not English have score 0 below Series profile minimum 100
 21 | Not enough seeders: 0. Minimum seeders: 1
 18 | Unknown Series
 14 | Unknown is not wanted in profile
  7 | Existing file on disk has a equal or higher Custom Format score: 975
```

`[Anime] Remux-1080p` sets `min_format_score: 100`, so anything scoring 0 is
rejected outright. Nothing is blocklisted (0 entries for this series), so that
is not it. The 87 releases are mostly `EP 16`-style fan naming that lands as
`Unknown Series`, plus dead 0-seeder torrents, plus season packs correctly
refused because the other 50 episodes already have Remux files scoring 975.

Not diagnosed further. The likely lever is that profile's minimum interacting
with the anime tier scores, which is a Recyclarr question, not a per-series one.

---

# Fullmetal Alchemist: Brotherhood — the third failure mode (2026-07-30)

Now 64/64. Neither the 4K trap nor a phantom backlog: **dead usenet posts plus an
anime numbering hazard**. Worth reading before touching any anime series.

## It was never the config

```
grabbed 107  ->  downloadFolderImported 50  ->  downloadFailed 57
reason: "Aborted, cannot be completed - https://sabnzbd.org/not-complete"
reason: "Manually marked as failed"   (Decluttarr's signature)
```

The FraMeSToR remux NZBs for 14 episodes were **incomplete on usenet**. Each grab
failed, Decluttarr blocklisted it and Sonarr fell to the next candidate, until
those episodes had exhausted their entire candidate pool. 35 blocklist entries,
33 of them from the day the series was added.

Proven rather than assumed: the blocklist was cleared and all 7 still-listed
remuxes re-grabbed at 02:32 — **every one failed again by 03:05**. The posts are
dead. For E25 and E64 no remux-grade release exists at all, under any mapping.

**Diagnostic gotcha:** `GET /api/v3/blocklist` paginates. Fetching `pageSize=100`
of 2775 entries and then filtering by series reports zero and sends you down the
wrong path. Use `?seriesIds=<id>`.

## The numbering hazard — real, not theoretical

TVDB interleaves the four OVAs into the absolute sequence at **abs 21, 39 and
56**, so absolute and standard numbering drift apart:

```
E20/abs20   E21/abs22   E38/abs40   E54/abs57   E64/abs67
```

With `seriesType: anime`, Sonarr reads a bare number in a release title as
**absolute**. Release groups number FMA:B 1–64 as *standard* episodes. So
anything numbered ≥21 lands 1–3 episodes off. Caught in the act:

```
"Fullmetal Alchemist Brotherhood - 57 - Eternal Leave"  ->  epIds=[2991] = S01E54
```

Episode 57 is "Eternal Leave"; Sonarr mapped it to E54, which is "Beyond the
Inferno". Had it completed, episode 57's video would be filed as E54 — and E54
would still be missing. No XEM scene mapping corrects this. Those downloads were
removed with `blocklist=true&skipRedownload=true`.

**Mitigation applied: `seriesType` anime → standard.** Bare-numbered releases now
fail to parse instead of silently mismapping, and `SxxExx` releases — everything
this series actually uses — keep working. Note this makes absolute-numbered
releases invisible to Sonarr entirely, which is why the Erai-raws pack below had
to be fetched via Prowlarr rather than through Sonarr.

## The fix: selective-file torrent + hand-mapped import

`[Erai-raws] ... 01 ~ 64 (V2) [1080p NF WEB-DL]` — 55.9 GB, 204 seeders — carries
all 64 episodes at better quality than the 720p BluRay encodes, which were the
only other correctly-named option and were rejected anyway by
`[Anime] Remux-1080p`'s `min_format_score: 100` (they score 0).

Downloading 55.9 GB for 14 episodes is wasteful, and letting Sonarr grab it would
have reintroduced the absolute-numbering bug. So:

1. Add to qBittorrent **directly**, category `manual-fma` (not `tv-sonarr`, so
   Sonarr never auto-imports it).
2. Set every file to priority 0, then re-enable only the 14 wanted indices —
   file `- NN` is standard episode NN, so index = NN − 1.
   **12.2 GB instead of 55.9 GB.**
3. `ManualImport` with `importMode: "Copy"`, mapping each file to an explicit
   `episodeIds` — the mapping is done by hand, so Sonarr's absolute logic never
   gets a vote.

qBittorrent API notes: it is at `localhost:8085` inside gluetun's netns (no auth
from there). On 5.x, `paused=true` on `/torrents/add` is **ignored** and
`/torrents/pause` is 404 — the endpoints are `/torrents/stop` and
`/torrents/start`. The add returns `pending_count: 1` while it fetches the
`.torrent` through Prowlarr, so poll for the hash rather than expecting it
immediately.

## Result

```
64/64 regular episodes, 0 title mismatches
48 x Bluray-1080p Remux (FraMeSToR)  +  2 x Bluray-1080p  +  14 x WEBDL-1080p
```

The 14 sit below the profile cutoff, so they will show under Cutoff Unmet and
upgrade themselves to remux if those posts ever reappear. That is the desired
behaviour, not a defect.

**Library integrity was verified at every step** by checking that each file's
name contains the episode title Sonarr assigned it — 50/50 before, 64/64 after.
Given a numbering bug that misfiles content while looking perfectly healthy, that
check is worth more than the quality audit.

---

# Star Trek: Voyager — the alert's blind spot (2026-07-30)

Voyager sat at 125/172 with all 47 remaining episodes unobtainable, and the
alert said nothing. Same underlying cause as FMA:B — dead usenet posts — but it
exposed a real defect in the check.

## Why it was missing 47 episodes

**2014 blocklist entries, 73% of the entire instance's blocklist**, all created
on 15–16 July:

```
2026-07-15: 1744    2026-07-16: 270
distinct episodes with blocklisted releases: 167
of the 47 wanted episodes, 47 have blocklisted releases   <- every one
```

When Voyager was kicked on 14 July, Sonarr searched all 173 episodes, grabbed
~2000 releases and nearly all of them failed — DVD-era usenet posts are largely
incomplete. 125 imported; the other 47 exhausted **every candidate they had**.

## Why no alarm — the defect

Two reasons. The mundane one: last grab was 13.73 days ago against a 14-day
threshold, so it was 6.5 hours from alerting.

The real one: **the staleness clock keyed off the last GRAB.** Grabbing is not
progress. A series in a grab → fail → blocklist loop churns constantly, so its
last-grab timestamp is permanently fresh and it looks healthy for exactly as
long as it keeps failing:

```
grabs: 2191     imports: 125     ratio 17.5 : 1
```

Voyager was drowning and reported as fine. Two changes:

- **Key the STALLED tier off `downloadFolderImported` (eventType 3)**, not
  `grabbed` (eventType 1).
- **Add a CHURNING tier** that fires *while it is still happening* — 20+ grabs
  with fewer than a fifth as many imports means downloads are failing, not
  missing. Waiting for the loop to go quiet for a fortnight is too late.

Both applied to Radarr as well.

## The fix: same selective-file pattern as FMA:B

`Star Trek Voyager (1995) Season 1-7 (480p DVD x265 HEVC 10bit AC3 5.1 Panda)`
— 87.3 GB, 72 seeders. Chosen over the better-seeded 117-seeder pack (33.4 GB,
~194 MB/ep, stereo) because the existing library medians 350 MB/episode, so
~507 MB/ep with 5.1 audio matches and slightly improves it.

**Explicitly rejected: the 36-seeder `1080p AI Upscale` pack.** Voyager was
finished on SD NTSC video and never remastered, so any "1080p" is an upscale of
the same master — bigger files, no more detail. That is exactly what the
`Upscaled -10000` custom format exists to prevent; do not hand-import around it.

47 wanted episodes mapped to 47 files = **25.6 GB instead of 87.3 GB**.

The pack names files `S01E03 - Parallax`, and combines two-parters as
`S01E01-E02 - Caretaker`. Three selected files (`Caretaker`, `Dark Frontier`,
`Endgame`) also cover an episode already on disk; importing them replaces a
single-part file with a matched pair from one source, which is an improvement
rather than a collision.

## qBittorrent gotcha, second variant

The FMA:B pack came through as a `.torrent` with metadata attached. This one
resolved to a **magnet**, so `/torrents/files` returns an empty list and the
size reads 0 until peers supply the metadata — which cannot happen while the
torrent is stopped. Sequence that works:

1. add with `stopped=true`
2. **start it** and poll `/torrents/files` until non-empty
3. immediately set every file to priority 0 (this freezes downloading without
   stopping the torrent)
4. set the wanted indices to priority 1, then start

Also: `filePrio` rejects an id list containing indices beyond the file count
with `409 File ID is not valid` — build the deselect list from the actual file
count, not a generous range.
