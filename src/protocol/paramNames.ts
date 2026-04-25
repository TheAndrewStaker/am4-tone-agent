/**
 * Hand-maintained name table for cache-derived parameters.
 *
 * Pipeline (P1-010): `scripts/gen-params-from-cache.ts` walks every
 * CONFIRMED cache block, looks up each record's `id` in this table,
 * and emits a `KNOWN_PARAMS`-shape entry if a name is present.
 * Records without a name here are NOT emitted — they stay dormant
 * until a human assigns them a UI label (Session B of P1-010).
 *
 * Why a manual table instead of just emitting `param_{id}` placeholders:
 * MCP tool callers (Claude) need real human names to reason about
 * parameters. `amp.gain=6` is useful; `amp.param_11=6` is not. The
 * cache only stores ids + ranges, not labels.
 *
 * Sources for labels (in priority order):
 *   1. Wire captures that pin a name to a `(pidLow, pidHigh)` pair
 *      (highest confidence — see SYSEX-MAP §6a for the decode rule).
 *   2. `docs/manuals/Fractal-Audio-Blocks-Guide.txt` param descriptions.
 *   3. AM4-Edit UI labels observed via AM4-Edit screenshots.
 *
 * Entry shape (two forms):
 *   `'name'` — plain string. Generator infers unit from cache `c`
 *     (display-scale) via the default mapping (c=10 → knob_0_10,
 *     c=100 → percent, c=1000 → ms, c=1 → db, enum → enum).
 *   `{ name: 'label', unit: 'hz' }` — object form with an explicit
 *     unit override. Required when cache signature is ambiguous
 *     (e.g. c=1 could be dB / Hz / seconds / raw-count — the cache
 *     doesn't distinguish). Optional `displayMin` / `displayMax`
 *     overrides round the cache's internal min/max to a cleaner UI
 *     range where needed (e.g. reverb.predelay cache max=0.25s →
 *     displayMax=250 ms instead of the floating-point 250.0000…).
 *
 * Seed (2026-04-19, Session 25): every name already registered in
 * `KNOWN_PARAMS`. Session 26 (2026-04-20) added tone-stack + Mix
 * Page + Drive tone/level/mix + reverb predelay + LFO rates +
 * reverb time via the object-form overrides.
 *
 * OUT-OF-BAND PARAMS (not in the cache; hand-registered in
 * `KNOWN_PARAMS` directly, not through this pipeline):
 *   - `amp.level` / other-block `level` — pidHigh=0x0000, no cache
 *     record at id=0.
 *   - `{amp,drive,reverb,delay}.channel` — pidHigh=0x07D2, no cache
 *     record (Session 08 decoded this directly from wire captures).
 *
 * These remain in `params.ts` regardless of what this file says.
 */
import type { Unit } from './params.js';

export type ParamNameEntry =
  | string
  | { readonly name: string; readonly unit?: Unit; readonly displayMin?: number; readonly displayMax?: number };

// Universal per-block output Balance at cache id=2 — signature
// (a=-1, b=1, c=100) across every confirmed block. Blocks Guide §347
// documents Balance as a standard block-level parameter that pans
// the block's output between left and right. Requires the
// `bipolar_percent` unit (display -100..+100, internal -1..+1,
// scale 100) which generator default for c=100 would misclassify
// as plain `percent` (0..100).
const BALANCE: ParamNameEntry = {
  name: 'balance',
  unit: 'bipolar_percent',
  displayMin: -100,
  displayMax: 100,
};

export const PARAM_NAMES: Readonly<Record<string, Readonly<Record<number, ParamNameEntry>>>> = {
  amp: {
    2: BALANCE,
    // Session 29 (HW-015): Out Boost Level — dB knob on the Extras tab,
    // cache (a=0, b=4, c=1, step=0.05). Wire-verified at pidHigh=0x08.
    8: { name: 'out_boost_level', unit: 'db', displayMin: 0, displayMax: 4 },
    10: 'type',
    11: 'gain',
    12: 'bass',
    // ids 13/14 (mid/treble) still structural — cache signature identical
    // to gain/bass (knob_0_10, 0..1 range, step 0.001). Named per the
    // AM4 Owner's Manual line 1563 tone-stack order "Gain, Bass, Mid,
    // Treble, Presence, Level". HW-014 spot-check still pending.
    13: 'mid',
    14: 'treble',
    // Session 29 (HW-015): id 15 (pidHigh=0x0f) was mis-inferred as
    // 'presence' in Session 26 from the cache signature alone. Two
    // wire captures (amp-master on an unknown Marshall-family amp +
    // amp-master-2 on "Brit 800 #34") prove this register is Master.
    // Real Presence was subsequently captured at id 30 (pidHigh=0x1e).
    15: 'master',
    // Session 29 (HW-015): Depth at pidHigh=0x1a, knob_0_10. Wire-
    // verified with a full 0→10 sweep capture.
    26: 'depth',
    // Session 29 (HW-015): Presence at pidHigh=0x1e, knob_0_10. Wire-
    // verified on the same amp as amp-master. Corrects the Session 26
    // structural guess at id 15.
    30: 'presence',
  },
  drive: {
    2: BALANCE,
    10: 'type',
    11: 'drive',
    // AM4 Owner's Manual line 1330: "Page Right and dial in Drive, Tone,
    // and Level." Cache records at 0x0C and 0x0D have the identical
    // knob_0_10 signature to drive.drive (0x0B); typical pedal-UI order
    // matches. `mix` at 0x0E follows the universal Mix Page pattern
    // (percent). All three await Session D hardware spot-check.
    12: 'tone',
    13: 'level',
    14: 'mix',
    // HW-019 (Session 30, 2026-04-25): EQ-page knobs decoded from
    // session-30-drive-basic-blackglass-7k. Cache ids 16/17 are the
    // Hz cuts (raw passthrough — c=1 default would mis-classify as dB),
    // ids 20/21/23 are the knob_0_10 Bass/Mid/Treble flanking id 22
    // (mid frequency in Hz). T808 OD doesn't expose these — the
    // session-30-drive-basic-t808-od capture only had drive/tone/level.
    16: { name: 'low_cut', unit: 'hz', displayMin: 20, displayMax: 2000 },
    20: 'bass',
    21: 'mid',
    22: { name: 'mid_freq', unit: 'hz', displayMin: 200, displayMax: 2000 },
    23: 'treble',
  },
  reverb: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    // Blocks Guide §Reverb Basic Page: "Time — Sets the decay time."
    // Cache 0x0B is 0.1..100 seconds, c=1 (raw passthrough). Needs the
    // 'seconds' unit override — generator default for c=1 is 'db'.
    // displayMin rounded to 0.1 (cache stores 0.10000000149…).
    11: { name: 'time', unit: 'seconds', displayMin: 0.1 },
    // Session 29 (HW-015): Size at pidHigh=0x0f, percent. Wire-verified
    // on two captures — "Plate Size" (on Plate reverb type) and "Size"
    // (on Room reverb type) both wrote to this register, confirming
    // it's a universal reverb-size knob whose UI label depends on the
    // active reverb type.
    15: 'size',
    // BK-033 (HW-025 #1, Session 30): the cache record at id=16 (0x10)
    // signature LOOKED like predelay (0..0.25s × 1000 = 0..250 ms) but
    // wire-testing proved it's a dead address — writes ack but the
    // firmware ignores them. The real predelay register is id=19 (0x13);
    // AM4-Edit captures wrote there for "Pre-Delay → 85 ms / 111.4 ms".
    // Skipping id=16 here so the generator doesn't emit the wrong cache
    // mapping; the corrected entry lives hand-authored in params.ts.
    // The cache record at 0x13 has no name slot here either — it's
    // not exposed via the auto-gen path; instead reverb.predelay is
    // a pure KNOWN_PARAMS hand-authored entry going forward.
    // Session 29 (HW-015): Spring-reverb-specific. Number of Springs
    // (integer count 2..6) at pidHigh=0x1b; cache c=1 structurally
    // ambiguous — needs 'count' override. Spring Tone (knob_0_10) at
    // pidHigh=0x1c; cache signature matches knob_0_10 default. Both
    // only visible in AM4-Edit when a Spring reverb type is active,
    // but the registers remain writable on any type — writes simply
    // no-op on non-spring reverbs.
    27: { name: 'springs', unit: 'count', displayMin: 2, displayMax: 6 },
    28: 'spring_tone',
    // Session 29 follow-up (2026-04-21): Shimmer Verb / Plex Verb
    // "Shift 1" and "Shift 2" pitch-shifter voices. Blocks Guide
    // §Shimmer Verb Parameters: "Shift 1–8 — Sets the amount of
    // detune within a range of ±24 semitones. This is where
    // 'Shimmer' is born." AM4's reverb has two such voices (ids
    // 56/57); the AxeFx/FM8-voice variant ships more. Cache signature
    // (a=-24, b=24, c=1, step=1) matches the BG documentation
    // exactly — needs the 'semitones' unit override since c=1 is
    // structurally ambiguous. Structural registration; HW-014-style
    // spot-check still required.
    56: { name: 'shift_1', unit: 'semitones', displayMin: -24, displayMax: 24 },
    57: { name: 'shift_2', unit: 'semitones', displayMin: -24, displayMax: 24 },
  },
  delay: {
    // Mix follows the universal percent-at-0x01 pattern (Blocks Guide
    // §Common Mix/Level Parameters, p. 7). "delay block uses a
    // different Mix Law compared to other blocks" — same param, just
    // different internal curve; still the wet/dry knob.
    1: 'mix',
    2: BALANCE,
    10: 'type',
    12: 'time',
    // Session 29 (HW-015): Feedback at pidHigh=0x0e. Cache (a=-1, b=1,
    // c=100) is bipolar — negative feedback inverts the phase of the
    // repeats, a standard Fractal delay feature.
    14: { name: 'feedback', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    // HW-020 (Session 30, 2026-04-25): Ducking attenuation amount,
    // session-30-delay-basic-digital-mono capture. Cache id=46 a=0
    // b=80 c=1 → raw dB 0..80. Same signature as reverb.ducking
    // (HW-018). delay.level (out-of-band, pidHigh=0x0000) and
    // delay.stack_hold (per-block non-Type enum, pidHigh=0x001f) are
    // hand-authored in params.ts directly.
    46: 'ducking',
  },
  // Universal `mix` at pidHigh 0x01 across every effect block that
  // exposes a Mix Page per the Blocks Guide (p. 7). Skipped for
  // Amp/Drive (different semantics), Wah/GEQ/Gate/VolPan (no wet/dry —
  // AM4 manual p.34 line 1423: "Effects with no mix, such as Wah,
  // GEQ, etc., will show 'NA'"). Cache signature matches percent
  // (0..1 × 100) structurally identical to the confirmed reverb.mix.
  // Modulation-block LFO controls. Blocks Guide §Chorus/Flanger/Phaser
  // document "Rate (Hz/BPM): Controls the speed of the modulation" —
  // all three blocks expose a rate knob with the same cache-c=1 raw-Hz
  // signature. Depth is a percent knob at a distinct pidHigh per block.
  chorus: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    12: { name: 'rate', unit: 'hz', displayMin: 0.1 },
    14: 'depth',
  },
  flanger: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    11: { name: 'rate', unit: 'hz', displayMin: 0.05 },
    13: 'depth',
    // Session 29 (HW-015): Feedback at pidHigh=0x0e. Cache (a=-0.995,
    // b=0.995, c=100) — bipolar_percent with the internal range
    // clamped slightly short of ±1.0 per Fractal's flanger
    // implementation.
    14: { name: 'feedback', unit: 'bipolar_percent', displayMin: -99, displayMax: 99 },
  },
  phaser: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    12: { name: 'rate', unit: 'hz', displayMin: 0.1 },
    // Session 29 (HW-015): Feedback at pidHigh=0x10. Cache (a=-0.9,
    // b=0.9, c=111.1) — bipolar, internal ±0.9 with an unusual
    // display-scale of 111.1 meaning internal -0.9 displays as
    // -99.99%. We use the standard bipolar_percent unit (scale 100)
    // with displayMin/Max clamped to ±90 so input stays within the
    // internal range; the displayed percentage in AM4-Edit may read
    // slightly higher than the value Claude used (e.g. "50" sets
    // internal 0.5, AM4-Edit displays ~55.5%) but the wire behavior
    // is correct. Natural-language UX impact is negligible.
    16: { name: 'feedback', unit: 'bipolar_percent', displayMin: -90, displayMax: 90 },
  },
  wah: {
    2: BALANCE,
    10: 'type',
  },
  compressor: {
    1: 'mix',
    2: BALANCE,
    // HW-021 (Session 30, 2026-04-25): Compressor first-page knobs from
    // session-30-comp-basic-jfet-studio. Cache ids 10..15 are the
    // canonical comp-config registers per Blocks Guide §Compressor:
    // Threshold (dB), Ratio (1..20:1, new `ratio` unit), Attack (ms),
    // Release (ms), Knee Type enum (id 14, not yet wiggled), Auto
    // Makeup OFF/ON (id 15, hand-authored in params.ts because per-
    // block non-Type enums skip the generator). compressor.level
    // (pidHigh=0x0000) is out-of-band hand-authored.
    10: { name: 'threshold', unit: 'db', displayMin: -60, displayMax: 20 },
    12: { name: 'attack', unit: 'ms', displayMin: 0.1, displayMax: 100 },
    13: { name: 'release', unit: 'ms', displayMin: 2, displayMax: 2000 },
    19: 'type',
    // Ratio uses the new `ratio` unit (display = internal, scale 1) so
    // Claude reads "ratio 4" as 4:1 not 4 dB. Cache c=1 default would
    // mis-classify as dB; full override required.
    11: { name: 'ratio', unit: 'ratio', displayMin: 1, displayMax: 20 },
  },
  geq: {
    2: BALANCE,
    20: 'type',
  },
  filter: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    // Blocks Guide §Filter: Frequency is the filter cutoff (20..20000 Hz
    // at cache-c=1 raw). Universal control for every filter type.
    11: { name: 'freq', unit: 'hz' },
  },
  tremolo: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    // Blocks Guide §Tremolo: Rate sets the modulation speed (0.2..20 Hz
    // at cache-c=1 raw). Depth is a percent knob.
    12: { name: 'rate', unit: 'hz', displayMin: 0.2 },
    13: 'depth',
  },
  enhancer: {
    1: 'mix',
    2: BALANCE,
    // AM4-Edit labels this "Mode" but we keep `type` for cross-block consistency.
    14: 'type',
  },
  gate: {
    2: BALANCE,
    19: 'type',
  },
  volpan: {
    2: BALANCE,
    // The Volume-vs-Auto-Swell selector. Registered as `volpan.mode` in
    // KNOWN_PARAMS for historical reasons — keep the name stable.
    15: 'mode',
  },
} as const;
