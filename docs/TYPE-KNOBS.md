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

## The wiki Basic-page heuristic (per-block visibility shortcut)

Before reaching for a hardware capture or screenshot, check the
**Fractal wiki rule** stated in `docs/wiki/Drive_block.md` line 232:

> *"The controls on the Basic page of the Drive correspond with
> the knobs on the modeled devices."*

That's the per-type visibility shortcut in plain English. It means:
**AM4-Edit's Basic-page knob set for a given type ≈ the original
modeled pedal/amp/effect's physical control set.** So if you know
a type's `basedOn.productName` (from `src/knowledge/{block}-
lineage.json`), you can usually derive its AM4-Edit Basic-page
knobs from the real-world device's knob layout.

Examples (validated against captures):

- **T808 OD** → `basedOn.productName: "TS-808 Tube Screamer"` →
  Tube Screamer is famously 3-knob (Drive, Tone, Level) → AM4-Edit
  Basic page exposes drive / tone / level. **Matches HW-019
  capture exactly.**
- **Blackglass 7K** → `basedOn.productName: "Darkglass Microtubes
  B7K bass preamp and drive"` → real device has Drive, Blend,
  Volume, Bass, Mid, Mid Freq, Treble, Low Cut → AM4-Edit Basic
  page exposes drive / tone / level / mix / low_cut / bass / mid /
  mid_freq / treble (+1 unidentified). **Closely matches HW-019
  capture.**
- **Klone Chiron** → `basedOn.productName: "Klon Centaur"` → Klon
  Centaur has 3 knobs (Gain, Treble, Output) → AM4-Edit Basic
  page exposes drive / tone / level, **labelled** "Drive" /
  "Treble" / "Output" to match the original. **Matches HW-014
  finding.**

When the heuristic and a hardware capture disagree, **trust the
capture**. The wiki rule is a strong prior, not a guarantee —
Fractal's modelers occasionally add or rename knobs versus the
original device (as in BB Pre AT vs the BB Preamp). Per-type rows
in this file always cite their evidence (`session-XX-*.pcapng` or
"Wiki: §Drive types" or "BG-derived").

The wiki has explicit "Controls:" prose for ~19 of 78 drive types,
and similar prose for many reverb / delay / compressor types. The
`src/knowledge/{block}-lineage.json` files capture the
`basedOn.productName` / `manufacturer` / `model` fields but not
yet the controls — extending the lineage extractor to do so is
queued as **HW-033** (Claude-side, no founder hardware).

## Cache-investigation findings (HW-030 step 1)

The simpler hypothesis — that the AM4-Edit metadata cache itself
encodes per-type visibility — was ruled out (Session 30 cont):
no per-type subset table after section 3, no unparsed tail with
visibility data (only 2 bytes remain after section 3 in a 129 KB
file), and `english.laxml` is just UI string translations. The
remaining candidates are:

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

Per-type entries pending. Universal first-page knobs (those
registered in `params.ts`) are listed below as the implicit
"always shown" set. HW-024's Phase-2 readback pass also
surfaced **hardware-page inventories** for several blocks
without registering each knob — those are listed under "HW-024
hardware-page inventory (knob name only — most not yet
registered in params.ts)" and queued as HW-032.

- **Amp** — universal: gain, bass, mid, treble, master, depth,
  presence, level, balance, type. Per-type extras pending — most
  amp types likely share the universal stack with model-specific
  UI labels (5153 50W has "Master/Depth/Presence" exposed; 1959SLP
  hides Master because Plexis don't have one — HW-014 finding).

- **Flanger** — universal: mix, type, rate, depth, feedback,
  tempo (post-HW-027), balance. **Analog Stereo HW-024 inventory**:
  Rate, Depth, Feedback, Mix, Tempo, **Manual**, **Mod Phase**,
  **Level**. Bolded = unmapped, queued as HW-032.

- **Chorus / Phaser / Tremolo** — universal: mix, type, rate,
  depth (Chorus only), feedback (Phaser only), tempo (post-HW-027),
  balance. Per-type extras pending HW-022 / HW-032.

- **Filter** — universal: mix, type, freq, balance. **Low-Pass
  HW-024 inventory** (page 1): Type, Frequency, **Q**, **Level**,
  **Order**, **Low Cut**, **High Cut**. (page 2): **Mode Enable**,
  **Mod Type**, **Frequency** (mod), **Mod Frequency**, **Mod Rate**,
  **Mod Tempo**. Bolded = unmapped, queued as HW-032.

- **Gate** — universal: type, balance. **Modern Gate HW-024
  inventory**: **Threshold**, **Attenuation**, **Attack**,
  **Release**, **Hold**, **Sidechain Source**, **Level**.
  All unmapped — gate's core functionality is currently uncovered.
  Queued as HW-032 (high priority).

- **Enhancer** — universal: mix, type, balance. **Classic HW-024
  inventory**: **Width**, **Phase Invert**, **Pan Left**,
  **Pan Right**, Balance, **Level**. **Note**: `enhancer.mix` is
  a *phantom* — wire-acks but no Mix knob exposed on any
  Enhancer page (HW-024 finding F1). `enhancer.balance` IS
  visible (HW-024 finding F2 — only block tested where balance
  shows on hardware).

- **Volpan** — universal: mode, balance. **Auto-Swell mode HW-024
  inventory**: **Threshold**, **Attack**, **Taper**, **Level**.
  Volume mode (mode index 0) likely has different knobs (e.g.
  Pan, Level only). Queued as HW-032.

- **Wah / GEQ** — universal: type, balance (+ mix on Wah). Per-
  type extras pending HW-023.

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
