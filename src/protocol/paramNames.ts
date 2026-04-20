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

export const PARAM_NAMES: Readonly<Record<string, Readonly<Record<number, ParamNameEntry>>>> = {
  amp: {
    10: 'type',
    11: 'gain',
    12: 'bass',
    // Session B additions (2026-04-19). Cache record signatures at ids
    // 13/14/15 are identical to gain/bass (0..1 range, display-scale 10,
    // step 0.001). The AM4 Owner's Manual line 1563 lists the Amp
    // block's front-panel controls as "Gain, Bass, Mid, Treble,
    // Presence, Level" — Fractal's canonical tone-stack order places
    // Mid/Treble/Presence in exactly that sequence after Bass (Blocks
    // Guide §Tone Page, pp. 9–10). Awaits P1-010 Session D hardware
    // spot-check per the P1-010 plan; structural evidence alone is
    // strong (identical cache layout to confirmed neighbors + manual-
    // documented AM4-specific labels).
    13: 'mid',
    14: 'treble',
    15: 'presence',
  },
  drive: {
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
  },
  reverb: {
    1: 'mix',
    10: 'type',
    // Blocks Guide §Reverb Basic Page: "Time — Sets the decay time."
    // Cache 0x0B is 0.1..100 seconds, c=1 (raw passthrough). Needs the
    // 'seconds' unit override — generator default for c=1 is 'db'.
    // displayMin rounded to 0.1 (cache stores 0.10000000149…).
    11: { name: 'time', unit: 'seconds', displayMin: 0.1 },
    // Blocks Guide §Reverb Basic Page (p. 82): "Predelay — Adds extra
    // delay before the reverb starts." Cache 0x10 signature (0..0.25s
    // × 1000 → 0..250 ms) matches the canonical reverb predelay range.
    16: 'predelay',
  },
  delay: {
    // Mix follows the universal percent-at-0x01 pattern (Blocks Guide
    // §Common Mix/Level Parameters, p. 7). "delay block uses a
    // different Mix Law compared to other blocks" — same param, just
    // different internal curve; still the wet/dry knob.
    1: 'mix',
    10: 'type',
    12: 'time',
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
    10: 'type',
    12: { name: 'rate', unit: 'hz', displayMin: 0.1 },
    14: 'depth',
  },
  flanger: {
    1: 'mix',
    10: 'type',
    11: { name: 'rate', unit: 'hz', displayMin: 0.05 },
    13: 'depth',
  },
  phaser: {
    1: 'mix',
    10: 'type',
    12: { name: 'rate', unit: 'hz', displayMin: 0.1 },
  },
  wah: {
    10: 'type',
  },
  compressor: {
    1: 'mix',
    19: 'type',
  },
  geq: {
    20: 'type',
  },
  filter: {
    1: 'mix',
    10: 'type',
    // Blocks Guide §Filter: Frequency is the filter cutoff (20..20000 Hz
    // at cache-c=1 raw). Universal control for every filter type.
    11: { name: 'freq', unit: 'hz' },
  },
  tremolo: {
    1: 'mix',
    10: 'type',
    // Blocks Guide §Tremolo: Rate sets the modulation speed (0.2..20 Hz
    // at cache-c=1 raw). Depth is a percent knob.
    12: { name: 'rate', unit: 'hz', displayMin: 0.2 },
    13: 'depth',
  },
  enhancer: {
    1: 'mix',
    // AM4-Edit labels this "Mode" but we keep `type` for cross-block consistency.
    14: 'type',
  },
  gate: {
    19: 'type',
  },
  volpan: {
    // The Volume-vs-Auto-Swell selector. Registered as `volpan.mode` in
    // KNOWN_PARAMS for historical reasons — keep the name stable.
    15: 'mode',
  },
} as const;
