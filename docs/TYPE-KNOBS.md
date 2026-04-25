# Type → Exposed-Knobs Map

Per-type record of which first-page knobs AM4-Edit exposes on each block
type. Lazy-built — entries added as we capture them. Once enough types
are recorded, Claude can use this to (a) reject `set_param` calls
targeting hidden knobs with a useful error ("`drive.bass` isn't
exposed on TS808 OD — switch to a type that has an EQ page first") and
(b) pre-spec future HW-NNN captures so the surprise factor goes away.

## Why this file exists (HW-030 step 1 finding)

AM4-Edit's UI is **type-dependent**: every block stores the same
universal cache record table on disk (e.g. Drive's 49 records cover
every possible knob across all 78 drive types), but AM4-Edit only
*shows* the subset of knobs relevant to the active type's emulated
circuit. HW-019 / HW-020 / HW-021 (Session 30 cont) each surfaced
"spec said N knobs, capture showed M ≠ N".

**Cache investigation (Session 30 cont)** ruled out the simplest
hypotheses: there is no per-type subset table after section 3, no
unparsed tail with visibility data (only 2 bytes remain after
section 3 in a 129 KB file), and `english.laxml` is just UI string
translations. The remaining candidates are:

1. **Per-record `extra` field** — a partial signal, not a full map.
   `extra=1` correlates with "shown on every type" (drive's
   drive/tone/level/mix at ids 11–14 all have extra=1, and all
   were captured on both TS808 OD and Blackglass 7K). `extra=0`
   correlates with "type-dependent" (drive's bass/mid/mid_freq/
   treble at ids 20–23 all have extra=0, captured on Blackglass
   but not TS808). But the field also takes values 5 / 17 / etc.
   for some records, so it's not a clean binary visibility flag.
   Most likely an "associated controller / modulator" pointer
   per the parser comment ("sometimes echoes next id").
2. **AM4-Edit.exe compiled-in page templates** — the executable
   is 21.7 MB, likely contains per-type Qt page templates as
   resource data. Decoding this is a Ghidra-level investigation,
   not a 1-session task. Queued as **HW-031** (optional) if this
   lazy-built file turns out to be too tedious.

For now: **collect captures and screenshots opportunistically**
and grow this map per type. MVP doesn't need full coverage — a
few types per block is enough to demonstrate the pattern and
unblock natural-language tool-call hints.

## How to read this file

Each block has a default "universal" knob set (records with
`extra=1` in the cache) plus a per-type list of additional knobs.
Captured-from-hardware entries cite the pcapng filename. Entries
marked *(BG-derived, no capture)* are guesses from the Blocks
Guide that haven't been validated; treat with skepticism.

Knob names are `params.ts` keys (e.g. `drive.bass`).

---

## Drive (`pidLow=0x76`)

### Universal first-page knobs (all 78 types)

Cache `extra=1` records, hardware-confirmed on both TS808 OD and
Blackglass 7K:

- `drive.drive` (0x000b)
- `drive.tone` (0x000c)
- `drive.level` (0x000d)
- `drive.mix` (0x000e)

### Per-type additional knobs

| Type | First-page additions | Capture |
|------|---------------------|---------|
| TS808 OD | *(none)* — pure 3-knob Tube Screamer circuit | `samples/captured/session-30-drive-basic-t808-od.pcapng` |
| Blackglass 7K | `drive.low_cut`, `drive.bass`, `drive.mid`, `drive.mid_freq`, `drive.treble`, plus 1 unidentified knob at pidHigh=0x002d | `samples/captured/session-30-drive-basic-blackglass-7k.pcapng` |
| Klone Chiron | Same as universal but **labelled** "Treble" (for `drive.tone`) and "Output" (for `drive.level`) — model-specific UI labels matching the real Klon Centaur. Wire registers unchanged. | HW-014 hardware spot-check (Session 29 cont 7) |

### Open follow-ups

- Drive id=45 (pidHigh=0x002d) — knob_0_10 captured on Blackglass
  but no Blocks Guide name match. **HW-029** queued.
- 73 drive types still uncatalogued — opportunistic captures will
  fill in.

---

## Delay (`pidLow=0x46`)

### Universal first-page knobs (across captured types)

- `delay.mix` (0x0001)
- `delay.time` (0x000c)
- `delay.feedback` (0x000e)
- `delay.level` (0x0000) — out-of-band universal Level register

### Per-type additional knobs

| Type | First-page additions | Capture |
|------|---------------------|---------|
| Digital Mono | `delay.tempo` (deferred — needs enum extraction), `delay.stack_hold`, `delay.ducking` | `samples/captured/session-30-delay-basic-digital-mono.pcapng` |

### Open follow-ups

- 28 delay types still uncatalogued.
- HW-017 wanted a Multi-Tap or Mono Delay capture to disambiguate
  `delay.id64` (Taps vs Bit Reduction) at pidHigh=0x0040. Digital
  Mono didn't expose it, so HW-017 stays pending against a
  different type.

---

## Compressor (`pidLow=0x2e`)

### Universal first-page knobs (across captured types)

- `compressor.mix` (0x0001)
- `compressor.balance` (0x0002)
- `compressor.type` (0x0013)

### Per-type additional knobs

| Type | First-page additions | Capture |
|------|---------------------|---------|
| JFET Studio | `compressor.level`, `compressor.threshold`, `compressor.ratio`, `compressor.attack`, `compressor.release`, `compressor.auto_makeup`, plus 2 unidentified knobs at pidHigh=0x0017 and 0x0029 | `samples/captured/session-30-comp-basic-jfet-studio.pcapng` |

### Open follow-ups

- 18 compressor types still uncatalogued. Knee Type and Detector
  Type (cache ids 14/16) weren't reached in JFET Studio capture —
  may be exposed on different types (Studio FF / Vari-Mu / etc.).
- **HW-028** queued for the 0x0017 + 0x0029 disambiguation.

---

## Reverb (`pidLow=0x42`)

### Universal first-page knobs (across captured types)

- `reverb.mix` (0x0001)
- `reverb.time` (0x000b)
- `reverb.predelay` (0x0013) — BK-033 corrected from 0x0010
- `reverb.high_cut` (0x000c)
- `reverb.low_cut` (0x0014)
- `reverb.input_gain` (0x0017)
- `reverb.ducking` (0x0028)

### Per-type additional knobs

| Type | First-page additions | Capture |
|------|---------------------|---------|
| Hall (Medium) | `reverb.size` (0x000f), `reverb.density`, `reverb.stereo_spread`, `reverb.quality`, `reverb.stack_hold` | `samples/captured/session-30-reverb-basic-hall.pcapng` |
| Spring (Large) | `reverb.dwell`, `reverb.drip`, `reverb.springs`, `reverb.spring_tone` | `samples/captured/session-30-reverb-spring.pcapng` |
| Plate, Ambience, Room (HW-014 spot-check)| `reverb.size` shown across all algorithmic-reverb types under different UI labels ("Plate Size", "Size") — same wire register | HW-014 |

### Open follow-ups

- `pidHigh=0x0000` (likely `reverb.level`) — **HW-026** queued.
- 75 reverb types still uncatalogued.

---

## Other blocks

Not yet captured at the per-type level. Universal first-page
knobs (those registered in `params.ts`) are listed below as the
implicit "always shown" set; per-type additions to be filled in
when HW-022 (modulation) and HW-023 (secondary) captures land,
post-HW-030 step 2.

- **Amp** — universal: gain, bass, mid, treble, master, depth,
  presence, level, balance, type. Per-type extras pending — most
  amp types likely share the universal stack with model-specific
  UI labels (5153 50W has "Master/Depth/Presence" exposed; 1959SLP
  hides Master because Plexis don't have one — HW-014 finding).
- **Chorus / Flanger / Phaser / Tremolo** — universal: mix, type,
  rate, depth (Chorus/Flanger), feedback (Flanger/Phaser),
  balance. Per-type extras pending HW-022.
- **Wah / Filter / Gate / GEQ / Enhancer / Volume-Pan** —
  universal: type, mix (where applicable), balance. Per-type
  extras pending HW-023.

---

## How to grow this file

When a new HW-NNN capture lands and decodes a previously-unknown
type's first-page knob set, append a row to the relevant block's
"Per-type additional knobs" table with the type name, the new
params (or "*(none)*" if no additions over the universal set),
and the pcapng path.

When a partial visibility map can be inferred from a Blocks Guide
section (e.g. "Shimmer Verb Parameters" describing per-type
knobs), add it as a `*(BG-derived, no capture)*`-marked row so
it's testable but flagged as unverified.

When MVP coverage is "good enough" (any type a typical user
might pick has its knob list either captured or BG-derived),
this file becomes load-bearing for natural-language tool-call
hinting.
