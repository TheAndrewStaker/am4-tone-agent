# Cache Block → Effect Role Map

Status of role-assignment for every sub-block in the parsed AM4-Edit
metadata cache. Mappings marked **CONFIRMED** are locked to a wire
`pidLow` by Session 15's pidHigh↔id proof plus at least one capture.
**TENTATIVE** assignments are inferred structurally (characteristic
enum names, record counts) and need an AM4-Edit capture to confirm.

Regenerate the structural signals driving this file with:

```
npx tsx scripts/parse-cache.ts
npx tsx scripts/map-cache-params.ts
```

## Section 2 (pre-divider)

Section 2 holds 7 blocks. Only block 5 (Amp) has a confirmed wire
`pidLow`; the others are mostly global/utility blocks that may not
have a wire pidLow at all (they configure Amp-adjacent behavior
rather than responding to per-slot SET_PARAM traffic).

| Block | Recs | Role | Evidence | Status |
|------:|-----:|------|----------|--------|
| 0 | 98  | Controllers / Modifier assigns | 9-slot knob-assign template at ids 1–9 (all 1.0/10.0/0.001/0.0); id=10 LFO waveform enum `SINE … ASTABLE`; tempo-sync modifier at id=15 | TENTATIVE |
| 1 | 34  | Expression / external pedal | id=10 × 13 `NONE, Pedal 1, Pedal 2, …, Pitch` — matches MIDI CC / expression pedal source list | TENTATIVE |
| 2 | 41  | **Compressor** (`pidLow=0x2E`) | id=19 × 19 `VCA Modern Compressor, Econo-Dyno-Comp, …, Citrus Juicer` | **CONFIRMED** (Session 18) |
| 3 | 22  | **Graphic EQ** (`pidLow=0x32`) | id=20 × 18 `10 Band Constant Q, 8 Band Constant Q, …, 7 Band Bass Pedal` | **CONFIRMED** (Session 18) |
| 4 | 36  | **Parametric EQ** (`pidLow=0x36`) | 4-band structure (freq/gain/Q floats at ids 10–24, band-shape enums at ids 25–29); no Type dropdown | **CONFIRMED** (Session 18) |
| 5 | 151 | **Amp** (`pidLow=0x3A`) | id=10 × 248 amp models (`1959SLP Normal … Deluxe 6G3`); id=41 × 138 cabs; id=44 × 69 mics | **CONFIRMED** (Session 15) |
| 6 | 77  | Cab / Output routing | id=65 and id=66 each × 45 cab-model enums (likely L/R cab selectors); id=36 × 12 enhancer/saturation modes `TUBE, BIPOLAR, FET I, …, EXCITER` | TENTATIVE |

## Section 3 (post-divider)

Section 3 holds 17 sub-blocks. 4 are confirmed main effect blocks
(Reverb/Delay/Drive), and the rest are either secondary effect blocks
or scene/routing infrastructure.

| Sub-block | Recs | Role | Evidence | Status |
|----------:|-----:|------|----------|--------|
| 0  | 72  | **Reverb** (`pidLow=0x42`) | id=10 × 79 `Room, Small … Spring, Vibrato-King Custom` | **CONFIRMED** (Session 15) |
| 1  | 89  | **Delay** (`pidLow=0x46`) | id=10 × 29 `Digital Mono … Surround Delay` | **CONFIRMED** (Session 15) |
| 2  | 31  | **Chorus** (`pidLow=0x4E`) | id=10 × 20 `Digital Mono … Vibrato 2`; id=18 LFO waveforms | **CONFIRMED** (Session 18) |
| 3  | 35  | **Flanger** (`pidLow=0x52`) | id=10 × 32 `Digital Mono … Manual Cancel Flanger`; id=18 LFO waveforms | **CONFIRMED** (Session 18) |
| 4  | 23  | **Rotary** (`pidLow=0x56`) | L/R routing enum, tempo-sync modifier, id=10–13 float knobs (rate/depth); no Type dropdown | **CONFIRMED** (Session 18) |
| 5  | 37  | **Phaser** (`pidLow=0x5A`) | id=10 × 17 `Digital Mono, Digital Stereo, Script 45, Script 90, …, Modern Vibe` | **CONFIRMED** (Session 18) |
| 6  | 29  | **Wah** (`pidLow=0x5E`) | id=10 × 9 `FAS Wah, Clyde, Cry Babe, VX846, …, Paragon` | **CONFIRMED** (Session 18) |
| 7  | 24  | **Tremolo / Panner** (`pidLow=0x6A`) | id=10 × 7 `VCA Trem, Panner, Bias Trem, Harmonic Trem, …, Neon Trem` | **CONFIRMED** (Session 18) |
| 8  | 40  | **Filter** (`pidLow=0x72`) | id=10 × 18 `Null, Low-Pass, Band-Pass, High-Pass, …, Touch-Wah` | **CONFIRMED** (Session 18) |
| 9  | 49  | **Drive** (`pidLow=0x76`) | id=10 × 78 `Rat Distortion … Swedish Metal`; id=8 = `T808 Mod` matches Session 06 wire capture | **CONFIRMED** (Session 15) |
| 10 | 17  | **Enhancer / Stereo** (`pidLow=0x7A`) | id=14 × 3 `Modern, Classic, Stereoizer`; routing enums | **CONFIRMED** (Session 18) |
| 11 | 22  | **Gate / Expander** (`pidLow=0x92`) | id=19 × 4 `Classic Expander, Classic Gate, Modern Gate, Modern Expander` | **CONFIRMED** (Session 18) |
| 12 | 20  | **Volume / Pan** (`pidLow=0x66`) | id=11 × 7 pedal tapers `LINEAR…S-TAPER`; id=15 × 2 Mode `Volume/Auto-Swell` | **CONFIRMED** (Session 18) |
| 13 | 17  | Input Impedance | id=14 × 13 `AUTO, 1M, 1M+CAP, 230K, …, 22K+CAP` — matches AM4's guitar input impedance switching | TENTATIVE |
| 14 | 37  | Looper / FX Loop | Only `Thru/Mute` + `OFF/ON` enums; all other params are floats | TENTATIVE |
| 15 | 116 | Scene routing / Signal chain | Multiple `Series/Parallel` routing enums (ids 20–22) and 6× `A/B/C/D` channel assignments (ids 23–28) — slots × scenes × channels matches AM4's 4 slots × 4 scenes layout | TENTATIVE |
| 16 | 37  | Scene snapshot values | No enums; 9 knob-0-10 floats per scene × 4 scenes = 36 records ≈ total — likely the per-scene modifier/assign knob values | TENTATIVE |

## Capture TODO to promote TENTATIVE → CONFIRMED

Remaining tentative blocks (lower priority; none block v0.2):

1. **Filter/Tremolo/Pitch/Looper** (S3 sub-blocks 4/7/8/14) — capture
   a Type dropdown change (or the distinctive block action for blocks
   without a Type selector).
2. **Scene routing** (S3 sub-block 15) — switch scenes in AM4-Edit
   and diff captures to confirm scene-parameter addressing. The
   session-18-switch-scene capture is a starting point.
3. **Enhancer/Gate/Volume-Pan/Input-Z** (S3 sub-blocks 10/11/12/13) —
   less common but round out the block catalog.
4. **Controllers / Pedal / Utility / Cab-routing** (S2 blocks 0/1/4/6) —
   likely global/routing blocks; may not have a per-slot `pidLow`.

Session 18 confirmed 10 blocks (Amp/Drive/Reverb/Delay from
earlier + Chorus/Flanger/Phaser/Wah/Compressor/GEQ). Each required
one Type-dropdown capture, with the resulting wire `pidLow` matching
the cache sub-block's position in the enumerated dropdown.

Once a new block is confirmed, add the `pidLow` to
`CACHE_BLOCK_MAP` in `scripts/map-cache-params.ts` and extend
`KNOWN_PARAMS` in `src/protocol/params.ts` with the block's Type
enum (via `gen-cache-enums.ts`).
