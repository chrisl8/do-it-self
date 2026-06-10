# Dolby Vision Profile 5 acquisition fix — handoff to Neuromancer

**Audience:** an agent working on the **Neuromancer** server (runs Sonarr/Radarr + Jellyfin, has a GTX 1060).
**Author context:** written from the **deepthought** server (the second Jellyfin server, Intel HD Graphics 530 iGPU), which is where the problem actually surfaces.
**Goal:** stop acquiring media that forces painful video transcoding, by preferring **HDR10** releases and avoiding **Dolby Vision Profile 5** at download time.

---

## ✅ IMPLEMENTED on Neuromancer — 2026-06-10

The **primary fix (Option 1)** is done. The *arr stack on Neuromancer is the `recon` Docker Compose project (`~/containers/recon`).

- **Recyclarr** installed as `recon-recyclarr` (image `ghcr.io/recyclarr/recyclarr`, `@daily` cron auto-sync). Config at `/mnt/ssd-4tb/container-mounts/recon/recyclarr/` (`configs/*.yml` + `secrets.yml`).
- **Full TRaSH Guides quality profiles** adopted (not just the DV fix — a full consolidation):
  - Radarr → **UHD Bluray + WEB** (all movies).
  - Sonarr → **WEB-2160p** (standard TV) + **[Anime] Remux-1080p** (anime). One Sonarr instance manages both (Recyclarr forbids two instances on one URL).
- **DV Profile 5 fix:** the TRaSH **"DV (w/o HDR fallback)"** custom format is scored **−10000** in both 4K profiles. With min-format-score 0 this means a P5 release scores net-negative and is **rejected outright** — Sonarr/Radarr fall back to an HDR10 or 1080p release automatically (stronger than the "deprioritize" this doc originally asked for).
- **Anime language fix:** "Anime Dual Audio" **+100** (prefer English dub, sub-only still allowed) — the right tool instead of a blanket non-English penalty. Standard TV/movies get "Language: Not English" **−50**.
- **Usenet made hard-primary:** delay profiles set `preferredProtocol=usenet`, `torrentDelay=1440` (wait 24h for usenet before falling back to torrent).
- **Existing library audit:** only **7** true DV-P5 files existed (Doctor Who 2023 S02E05/06, Spider-Noir S01E02/03/05/07, Shrinking S03E08) — the other ~115 DV files on disk are Profile 7/8 with an HDR10 base and play fine. The 7 were re-searched; they re-grab as HDR10/1080p where a non-P5 release exists. Any title existing *only* as 4K-P5 remains the **Option 2 re-encode** edge case (deferred, on-demand).

**Net:** new grabs avoid P5; both Jellyfin servers and all clients direct-play. Verified live — download queue showed 0 DV/P5 grabs after cutover.

---

## TL;DR / what to implement

1. **Primary fix (do this):** configure Sonarr & Radarr custom formats (via TRaSH Guides + Recyclarr) to **prefer HDR10 / HDR10+** and **strongly negative-score Dolby Vision *without* an HDR10 fallback** (i.e. Profile 5), with a graceful fallback to a 1080p (or HDR10) release when only DV P5 4K exists.
2. **Secondary / edge case only:** for titles that *only* exist as 4K DV P5 and that you really want in 4K, re-encode them to HDR10 on Neuromancer using the 1060. This is lossy and ongoing — not the default pipeline.
3. **Existing library:** audit for DV P5 files (ffprobe one-liner in the appendix) and either re-grab a better release or re-encode the few that matter.

Net effect: files direct-play on every client, and neither Jellyfin server has to transcode them.

---

## Environment / topology

Two Jellyfin servers, each serving its own media locations:

| Server | Role | CPU / GPU | Transcoding ability for 4K HEVC 10-bit (HDR/DV) |
|---|---|---|---|
| **Neuromancer** | Acquisition (Sonarr/Radarr/Prowlarr/qBittorrent) **+** Jellyfin | has **GTX 1060** (Pascal) | **Good** — NVDEC hardware-decodes 4K HEVC 10-bit; NVENC + CUDA tonemap handle it |
| **deepthought** | Jellyfin only (separate library location) | i5-6500 / **Intel HD Graphics 530** (Skylake, 2016) | **Bad** — the iGPU exposes only `VAProfileHEVCMain` (8-bit). **No `HEVCMain10` profile → cannot hardware-decode 10-bit HEVC at all.** 4K 10-bit decode falls back to CPU. |

**Client fleet (both servers serve these):**
- **Samsung 4K TVs** (Tizen Jellyfin app) — **Samsung TVs do not support Dolby Vision, ever** (they back HDR10+ instead). DV content must be tonemapped/transcoded server-side or it displays wrong.
- **Roku** — HDR10 fine; DV may direct-play on DV-capable models.
- **Newer Windows PCs** (Jellyfin Media Player = mpv) — HDR10 fine; **cannot render DV Profile 5** (mpv has no DV support, and P5 has no fallback layer).

**Why the format that makes everyone happy is HDR10:** it direct-plays on Samsung, Roku, and Windows. DV P5 direct-plays on essentially none of them.

---

## The problem in detail

### What Dolby Vision Profile 5 is, and why it forces transcoding

Dolby Vision **Profile 5** is a **single-layer** DV format with **no HDR10 fallback**. The video is stored in a DV-native color representation (ICtCp / IPTPQc2); the DV RPU metadata is what makes it displayable. A client that isn't a true Dolby Vision sink can't interpret it — play it directly and you get the classic fluorescent **green/purple** picture.

Because of this, Jellyfin refuses to direct-play DV P5 to any non-DV client and instead **transcodes + tone-maps it to SDR/HDR10**. With your client fleet, "non-DV client" is almost everything (all Samsung TVs, all Windows/JMP).

> Contrast: Dolby Vision **Profile 7/8** (Blu-ray and "hybrid" releases) carry a real HDR10 base layer. Non-DV clients just play the HDR10 base, and the DV enhancement can even be losslessly stripped with `dovi_tool`. **Profile 5 has none of that.**

### Why this is fundamentally an *acquisition* problem

**WEB-DL Dolby Vision is almost always Profile 5.** Streaming services (Netflix, Disney+, Apple TV+, Amazon) encode their DV streams as single-layer P5. That is exactly why the files that triggered this are named `...WEBDL-2160p...` and probe as **DV Profile 5**. So the cleanest fix is upstream: **don't grab the P5 release in the first place** — grab the HDR10 (or 1080p) release of the same title.

### Evidence (measured on deepthought)

Test file: a real 4K HEVC 10-bit **Dolby Vision Profile 5** episode (`Spider-Noir S01E02`, WEBDL-2160p). Transcodes driven through Jellyfin on deepthought after enabling its iGPU (VAAPI + OpenCL tonemap):

| Transcode target | Speed vs realtime | Result |
|---|---|---|
| 4K → **1080p** | **~1.85×** | plays, modest headroom |
| 4K → **4K** | **~0.58×** | **below realtime → constant buffering** |

The bottleneck is the **CPU 10-bit HEVC decode** (deepthought's GPU can't do it). The 1080p case only passes because the *encode* is smaller; the 4K decode is the same either way, so 4K stays under realtime.

### Important framing for the Neuromancer agent

You may **not have seen this problem on Neuromancer**, because the 1060 hardware-decodes 10-bit HEVC and masks it. The pain is on **deepthought** and on **direct-play clients** (Samsung/Windows) regardless of which server they hit. Even on Neuromancer, transcoding DV P5 is wasted work — an HDR10 release would **direct-play with zero transcode** on both servers and all clients.

---

## Goal / target format

For every acquisition where a choice exists, the priority order should be:

1. **2160p HDR10 / HDR10+** (best — 4K, direct-plays everywhere)
2. **2160p DV *with* HDR10 fallback (P7/P8 hybrid)** (acceptable — has a usable base layer)
3. **1080p** (SDR or HDR10) (fine fallback — direct-plays, light load)
4. **2160p DV Profile 5** (avoid — only as an absolute last resort)

Do **not** simply ban DV outright, or you'll get nothing for titles that only exist as DV. The intent is **deprioritize P5 hard, prefer HDR10, fall back to 1080p** — not "reject all DV."

---

## Recommended solution — Option 1: Sonarr/Radarr custom formats (TRaSH Guides + Recyclarr)

This is the primary fix. No transcoding, no quality loss, no 1060 cycles, fixes both servers and all clients.

### Approach

- Use **[TRaSH Guides](https://trash-guides.info/)** HDR/Dolby-Vision custom formats — they already distinguish "DV with HDR10 fallback" from plain "DV (no fallback)."
- Manage them with **[Recyclarr](https://recyclarr.dev/)** so the custom formats + scores stay in sync with TRaSH and survive Sonarr/Radarr updates. (Manual import of the TRaSH JSON in the Radarr/Sonarr UI also works, but Recyclarr is far easier to maintain.)

### Concrete steps

1. **Install/locate Recyclarr** on Neuromancer (Docker image `ghcr.io/recyclarr/recyclarr`, or the binary). Point it at the local Sonarr and Radarr URLs + API keys.
2. **Pull the current TRaSH custom-format IDs** — do **not** hardcode from memory; fetch live so the IDs are correct:
   - `recyclarr list custom-formats radarr`
   - `recyclarr list custom-formats sonarr`
   - or browse the TRaSH "HDR Formats" section.
3. **Import the HDR/DV custom formats** for both Radarr and Sonarr, and set scoring so that:
   - `HDR10` / `HDR10+` → **strong positive** score.
   - `Dolby Vision` *without* HDR10 fallback (the P5 case) → **strong negative** score (e.g. `-10000`) so it's only ever chosen when nothing else exists.
   - `Dolby Vision` *with* HDR10 fallback (P7/P8) → neutral or mild positive (acceptable).
   - Ensure a **1080p quality** tier remains allowed in the profile so a 1080p release can win when the only 2160p option is DV P5.
4. **Apply with** `recyclarr sync` and confirm the custom formats + scores appear in each Radarr/Sonarr **Quality Profile**.

### Recyclarr config skeleton (fill in current trash_ids)

```yaml
# /config/recyclarr.yml on Neuromancer — ILLUSTRATIVE STRUCTURE.
# Replace every <trash_id ...> with a current ID from `recyclarr list custom-formats`.
radarr:
  main:
    base_url: http://localhost:7878
    api_key: !env_var RADARR_API_KEY
    quality_profiles:
      - name: UHD Bluray + WEB        # or whatever your 2160p profile is called
    custom_formats:
      - trash_ids:
          - <HDR10 trash_id>
          - <HDR10Plus trash_id>
        assign_scores_to:
          - name: UHD Bluray + WEB
            score: 1000               # prefer HDR10
      - trash_ids:
          - <Dolby Vision (no fallback / P5) trash_id>
        assign_scores_to:
          - name: UHD Bluray + WEB
            score: -10000             # avoid DV P5 unless nothing else exists
sonarr:
  main:
    base_url: http://localhost:8989
    api_key: !env_var SONARR_API_KEY
    quality_profiles:
      - name: WEB-2160p               # adjust to your actual profile name(s)
    custom_formats:
      - trash_ids:
          - <HDR10 trash_id>
          - <HDR10Plus trash_id>
        assign_scores_to:
          - name: WEB-2160p
            score: 1000
      - trash_ids:
          - <Dolby Vision (no fallback / P5) trash_id>
        assign_scores_to:
          - name: WEB-2160p
            score: -10000
```

> **Caveat to keep in mind:** Sonarr/Radarr match on the **release title**, not by probing the file. This is heuristic — but release groups name DV consistently enough (`DV`, `DoVi`, `Dolby.Vision`, often with `HDR10` when a fallback exists) that it works well in practice. It won't be 100%, which is why the library audit below matters.

---

## Existing library cleanup

The profile change only affects **new** grabs. For what's already on disk:

1. **Audit** both libraries for DV Profile 5 (see appendix ffprobe one-liner). Produce a list.
2. For each P5 title, choose:
   - **Re-grab** a better release: in Radarr/Sonarr, trigger an interactive/automatic search; with the new scoring an HDR10 (or 1080p) release should now win and upgrade it. Verify the cutoff/upgrade-allowed settings permit the swap.
   - **Re-encode** (Option 2 below) only if no better release exists and you specifically want 4K.
   - **Leave as-is** if it's fine for now (e.g. content mostly watched on a DV-capable Roku, or you accept the slow transcode on deepthought).

---

## Option 2 — re-encode DV P5 → HDR10 on Neuromancer (edge case only)

Use this **only** for titles that exist *exclusively* as 4K DV P5 and that you want in 4K. It is lossy and is per-file ongoing work.

**Key reality:** you **cannot losslessly "strip" DV from a Profile 5 file** — its base layer is not HDR10. Converting P5 requires a real **tonemap re-encode**. (Lossless `dovi_tool` stripping only works on P7/P8, which have an HDR10 base — not your WEB-DL P5 files.)

The 1060 makes the heavy lifting fast:
- **Decode:** NVDEC hardware-decodes the 4K HEVC 10-bit stream.
- **Encode:** NVENC (`hevc_nvenc` for HDR10 out, or `h264_nvenc` for SDR/compat).
- **Tonemap / DV→HDR10:** the color conversion is the non-trivial part — use a proper tonemap path (e.g. `libplacebo`/CUDA tonemap, or `dovi_tool` to handle the RPU) and verify output is clean HDR10, not crushed/pink. Validate visually and with ffprobe before deleting the source.

Because this is lossy and maintenance-heavy, prefer re-grabbing a native HDR10 release whenever one exists.

---

## Implementation checklist (for the Neuromancer agent)

- [ ] Confirm Radarr & Sonarr versions and current Quality Profile names.
- [ ] Stand up / locate Recyclarr; wire in Radarr + Sonarr base URLs and API keys.
- [ ] Fetch current TRaSH `trash_ids` for HDR10, HDR10+, and DV-without-fallback (P5).
- [ ] Write `recyclarr.yml`: HDR10/HDR10+ strong-positive, DV-no-fallback (P5) strong-negative.
- [ ] Ensure each 2160p profile also permits a 1080p fallback tier.
- [ ] `recyclarr sync`; verify custom formats + scores landed in the profiles.
- [ ] Audit existing libraries for DV P5 (appendix); produce a remediation list.
- [ ] Re-grab better releases for P5 titles where available; re-encode (Option 2) only the stragglers.
- [ ] Verify a previously-problematic title now grabs HDR10 and **direct-plays** on a Samsung TV and a Windows JMP client (no transcode in the Jellyfin "Playback Info").

---

## Verification / appendix

### Detect Dolby Vision profile of a file (the core diagnostic)

```bash
# Prints the DV profile if present. Profile 5 = the problem; 7/8 have HDR10 fallback.
ffprobe -v error -select_streams v:0 \
  -show_entries stream_side_data=dv_profile \
  -of default=nk=1:nw=1 "FILE.mkv"

# One-liner: codec + profile + DV profile together
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,profile,width,height:stream_side_data=dv_profile \
  -of default=nw=1 "FILE.mkv"
```

### Audit a whole library for DV Profile 5

```bash
# Walk a media root and flag DV Profile 5 files.
find /path/to/media -type f \( -name '*.mkv' -o -name '*.mp4' \) -print0 |
while IFS= read -r -d '' f; do
  dv=$(ffprobe -v error -select_streams v:0 \
        -show_entries stream_side_data=dv_profile -of default=nk=1:nw=1 "$f" 2>/dev/null \
        | grep -E '^[0-9]+$' | head -1)
  [ "$dv" = "5" ] && echo "DV P5: $f"
done
```

### Confirm a fix worked

- File probes as `HDR10` (transfer `smpte2084`, no `dv_profile`, or `dv_profile=8` with HDR10 base).
- In Jellyfin → playback → **Playback Info** overlay shows **Direct Play** (not "Transcode") on a Samsung TV and on Windows JMP.

### Reference: why deepthought specifically can't cope

`vainfo` on deepthought's HD 530 lists `VAProfileHEVCMain` (8-bit decode/encode) but **no `VAProfileHEVCMain10`** — so any 10-bit HEVC (all HDR/DV) is CPU-decoded there. A 7th-gen-or-newer Intel iGPU, or an NVIDIA card like Neuromancer's 1060, would not have this limit; that's the longer-term hardware fix if deepthought ever needs to transcode 4K HDR itself.
