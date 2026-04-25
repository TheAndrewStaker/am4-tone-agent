/**
 * AM4 parameter registry.
 *
 * Each entry maps a human key (`block.name`) to its wire-level address
 * (`pidLow` = block ID, `pidHigh` = parameter index within block) and
 * its display ↔ internal scale convention.
 *
 * Address is preset-independent (confirmed Session 06 — Amp pidLow
 * matches across A01 and A2). See docs/STATE.md for the decoded set.
 */

import type { ParamId } from './setParam.js';
import {
  AMP_TYPES_VALUES,
  DRIVE_TYPES_VALUES,
  REVERB_TYPES_VALUES,
  DELAY_TYPES_VALUES,
  CHORUS_TYPES_VALUES,
  FLANGER_TYPES_VALUES,
  PHASER_TYPES_VALUES,
  WAH_TYPES_VALUES,
  COMPRESSOR_TYPES_VALUES,
  GEQ_TYPES_VALUES,
  FILTER_TYPES_VALUES,
  TREMOLO_TYPES_VALUES,
  ENHANCER_TYPES_VALUES,
  GATE_TYPES_VALUES,
  VOLPAN_MODES_VALUES,
} from './cacheEnums.js';

/**
 * How a parameter's display value relates to the float stored on the
 * wire. The firmware always stores a float; the unit decides the scale.
 *
 *   knob_0_10        — UI 0–10, internal ÷10 (gain-style knobs)
 *   db               — UI dB, internal raw dB
 *   hz               — UI Hz (raw passthrough), for LFO rates + filter cutoffs
 *   seconds          — UI seconds (raw passthrough), for reverb time etc.
 *   percent          — UI 0–100%, internal ÷100
 *   bipolar_percent  — UI -100..+100%, internal -1..+1 (balance knobs —
 *                      per-block output balance, stereo pan)
 *   count            — UI integer count (voices, stages, taps, springs);
 *                      display = internal (scale 1)
 *   semitones        — UI integer semitones (pitch shift);
 *                      display = internal (scale 1)
 *   ratio            — UI compression ratio (e.g. 4 ⇒ 4:1); display =
 *                      internal (scale 1). Fractional values valid
 *                      (1.5:1 etc.) — semantic label so Claude reads
 *                      "ratio 4" as 4:1 not 4 dB.
 *   ms               — UI milliseconds, internal seconds (÷1000)
 *   enum             — UI dropdown name, internal int-as-float (per-param table)
 *
 * Note: `db`, `hz`, `seconds`, `count`, `semitones`, and `ratio` all
 * pass display=internal (scale 1). They're distinct unit tags so tool
 * descriptions can label values accurately — Claude interprets "set
 * rate to 3" as 3 Hz when it sees `unit: 'hz'`, not 3 dB, and "8
 * voices" as a count rather than 8 dB. Semantic labels matter for
 * LLM correctness, even when the wire math is identical.
 */
export type Unit =
  | 'knob_0_10'
  | 'db'
  | 'hz'
  | 'seconds'
  | 'percent'
  | 'bipolar_percent'
  | 'count'
  | 'semitones'
  | 'ratio'
  | 'ms'
  | 'enum';

export interface Param extends ParamId {
  block: string;
  name: string;
  unit: Unit;
  displayMin: number;
  displayMax: number;
  /** For `unit: 'enum'` only — internal int → display name. */
  enumValues?: Record<number, string>;
}

const DISPLAY_TO_INTERNAL: Record<Exclude<Unit, 'enum'>, number> = {
  knob_0_10: 10,
  db: 1,
  hz: 1,
  seconds: 1,
  percent: 100,
  bipolar_percent: 100,
  count: 1,
  semitones: 1,
  ratio: 1,
  ms: 1000,
};

/** Convert a UI/display value to the float the firmware expects. */
export function encode(param: Param, displayValue: number): number {
  if (param.unit === 'enum') return displayValue;
  return displayValue / DISPLAY_TO_INTERNAL[param.unit];
}

/** Convert a float read from the firmware back to a UI/display value. */
export function decode(param: Param, internalValue: number): number {
  if (param.unit === 'enum') return Math.round(internalValue);
  return internalValue * DISPLAY_TO_INTERNAL[param.unit];
}

/**
 * Resolve an enum param's display name (or numeric index) to the wire
 * integer. Accepts numbers directly, exact name matches, and a relaxed
 * case-insensitive match after collapsing whitespace and punctuation —
 * `"Marshall 1959SLP"`, `"1959slp normal"`, and `0` all resolve the
 * same entry.
 *
 * Returns `undefined` if no match is found or the param is not an enum.
 * Callers should treat that as an invalid user input.
 */
export function resolveEnumValue(param: Param, input: number | string): number | undefined {
  if (param.unit !== 'enum' || !param.enumValues) return undefined;
  if (typeof input === 'number') {
    return param.enumValues[input] !== undefined ? input : undefined;
  }
  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  // Exact match first (fast path + most accurate).
  for (const [idx, name] of Object.entries(param.enumValues)) {
    if (name === trimmed) return Number(idx);
  }

  // Relaxed match: lowercase, collapse non-alphanumeric to single space.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = normalize(trimmed);
  for (const [idx, name] of Object.entries(param.enumValues)) {
    if (normalize(name) === target) return Number(idx);
  }

  // Substring fallback: pick the entry whose normalized name contains
  // the query (or vice-versa). Only accept unambiguous matches — if
  // more than one entry qualifies, bail rather than pick arbitrarily.
  const hits: number[] = [];
  for (const [idx, name] of Object.entries(param.enumValues)) {
    const n = normalize(name);
    if (n.includes(target) || target.includes(n)) hits.push(Number(idx));
  }
  return hits.length === 1 ? hits[0] : undefined;
}

export const KNOWN_PARAMS = {
  'amp.gain': {
    block: 'amp', name: 'gain',
    pidLow: 0x003a, pidHigh: 0x000b,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.bass': {
    block: 'amp', name: 'bass',
    pidLow: 0x003a, pidHigh: 0x000c,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // P1-010 Session B (2026-04-19) — AM4 tone stack completion. Cache
  // records at ids 13/14/15 have the identical signature to gain/bass
  // (knob_0_10, 0..1 range, display-scale 10). Named per AM4 Owner's
  // Manual line 1563 "Gain, Bass, Mid, Treble, Presence, Level" and
  // the Fractal Blocks Guide tone-stack order (§Tone Page, pp. 9–10).
  // HW-014 verified (Session 29 cont 7): mid / treble / presence / bass
  // all wrote and displayed correctly on hardware.
  'amp.mid': {
    block: 'amp', name: 'mid',
    pidLow: 0x003a, pidHigh: 0x000d,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'amp.treble': {
    block: 'amp', name: 'treble',
    pidLow: 0x003a, pidHigh: 0x000e,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // Session 29 (HW-015): `pidHigh=0x000f` was wrongly registered as
  // amp.presence in Session 26 based on cache signature alone. Two
  // wire captures on Marshall-family amps (unknown amp + Brit 800
  // #34) proved the register is Master. Real Presence is at
  // pidHigh=0x001e (below).
  'amp.master': {
    block: 'amp', name: 'master',
    pidLow: 0x003a, pidHigh: 0x000f,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // Session 29 (HW-015): full 0→10 sweep capture confirmed Depth at
  // pidHigh=0x001a. Knob_0_10 matches the cache signature.
  'amp.depth': {
    block: 'amp', name: 'depth',
    pidLow: 0x003a, pidHigh: 0x001a,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // Session 29 (HW-015): Presence at pidHigh=0x001e (not 0x000f — see
  // amp.master above). Wire-verified on the same Marshall amp.
  'amp.presence': {
    block: 'amp', name: 'presence',
    pidLow: 0x003a, pidHigh: 0x001e,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // Session 29 (HW-015): Out Boost Level on the Extras tab, dB knob
  // 0..4 dB with 0.05 dB steps.
  'amp.out_boost_level': {
    block: 'amp', name: 'out_boost_level',
    pidLow: 0x003a, pidHigh: 0x0008,
    unit: 'db', displayMin: 0, displayMax: 4,
  },
  // Session 29 (HW-015): Out Boost ON/OFF toggle on the Extras tab.
  // Registered directly in KNOWN_PARAMS (out-of-band from the cache
  // generator because per-block non-Type enum imports aren't
  // supported). Wire-verified via session-29-amp-out-boost-toggle:
  // value=1.0 → ON.
  'amp.out_boost': {
    block: 'amp', name: 'out_boost',
    pidLow: 0x003a, pidHigh: 0x0096,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  // Session 29 cont: Amp Advanced-panel enums registered from Blocks
  // Guide text (structural — wire indexing assumed from cache enum
  // order). Out-of-band from the cache generator for the same reason
  // amp.out_boost is: the generator emits only the block's Type enum,
  // not its other enum records. HW-014 couldn't verify these from
  // the hardware display alone (both labels are hidden by the AM4
  // hardware UI); AM4-Edit would show them. Structural-only until
  // an AM4-Edit-side verification pass.
  //
  // Tonestack Location (not Type — Type is a separate 69-value enum).
  // Blocks Guide: "POST places the stack between the preamp and
  // power amp. MID places it between the last two triode stages.
  // END places it after the power amp (physically impossible with
  // a real amp)." PRE-MID is the 5th option.
  'amp.tonestack_location': {
    block: 'amp', name: 'tonestack_location',
    pidLow: 0x003a, pidHigh: 0x0018,
    unit: 'enum', displayMin: 0, displayMax: 4,
    enumValues: { 0: 'PRE', 1: 'POST', 2: 'MID', 3: 'END', 4: 'PRE-MID' },
  },
  // Master Volume Location. Blocks Guide §Advanced (p. 853):
  // "Master Vol Location — Sets the location of the Master Volume
  // control. Most amps have the Master Volume before the phase
  // inverter ('Pre PI'). On some amps (like the 'Class-A' types)
  // the Master Volume comes after the phase inverter ('PI'). A
  // third option, 'pre-triode,' is the default for 'Hipower' amp
  // types."
  'amp.master_vol_location': {
    block: 'amp', name: 'master_vol_location',
    pidLow: 0x003a, pidHigh: 0x0038,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'PRE-PI', 1: 'POST-PI', 2: 'PRE-TRIODE' },
  },
  'amp.level': {
    block: 'amp', name: 'level',
    pidLow: 0x003a, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'amp.channel': {
    block: 'amp', name: 'channel',
    pidLow: 0x003a, pidHigh: 0x07d2,
    unit: 'enum', displayMin: 0, displayMax: 3,
    // Session 08: A→B→A and A→C→D→A captures confirmed all 4 indices.
    enumValues: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  },
  'amp.type': {
    block: 'amp', name: 'type',
    pidLow: 0x003a, pidHigh: 0x000a,
    // Session 16: enum dictionary imported from cacheEnums.ts (248 models).
    // Wire indexing verified via drive.type ground truth; amp.type index
    // 0 in cache is "1959SLP Normal". Untested against capture — flag as
    // such when hardening.
    unit: 'enum', displayMin: 0, displayMax: 247,
    enumValues: AMP_TYPES_VALUES,
  },
  'drive.drive': {
    block: 'drive', name: 'drive',
    pidLow: 0x0076, pidHigh: 0x000b,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // P1-010 Session B (2026-04-20) — AM4 Owner's Manual line 1330:
  // "Page Right and dial in Drive, Tone, and Level." Cache records
  // at 0x0C/0x0D/0x0E have canonical pedal-layout signatures.
  // HW-014 verified: address + value land correctly on Klone Chiron.
  // Note: AM4 hardware display labels these registers per drive
  // model (Klone Chiron shows `tone`→"Treble" and `level`→"Output",
  // matching the real Klon Centaur). The underlying register is
  // unchanged across drive types.
  'drive.tone': {
    block: 'drive', name: 'tone',
    pidLow: 0x0076, pidHigh: 0x000c,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.level': {
    block: 'drive', name: 'level',
    pidLow: 0x0076, pidHigh: 0x000d,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.mix': {
    block: 'drive', name: 'mix',
    pidLow: 0x0076, pidHigh: 0x000e,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // HW-019 (Session 30, 2026-04-25): Drive EQ-page knobs from
  // session-30-drive-basic-blackglass-7k. T808 OD only exposed
  // Drive/Tone/Level on its first page (session-30-drive-basic-t808-od
  // capture confirmed) — the EQ controls below are absent on simpler
  // pedal types and only surface on amp-emu drive types like
  // Blackglass 7K. Cache signatures pin the unit + range; sequence in
  // the cache (id 16/17 = Low/High Cut Hz, id 20/21/23 = Bass/Mid/
  // Treble knobs flanking id 22 = Mid Frequency) matches the AM4-Edit
  // EQ-1-page layout. Captured wiggle order on Blackglass differed
  // from the spec order; mapping is by cache-id sequence + signature
  // not capture order.
  'drive.low_cut': {
    block: 'drive', name: 'low_cut',
    pidLow: 0x0076, pidHigh: 0x0010,
    unit: 'hz', displayMin: 20, displayMax: 2000,
  },
  'drive.bass': {
    block: 'drive', name: 'bass',
    pidLow: 0x0076, pidHigh: 0x0014,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.mid': {
    block: 'drive', name: 'mid',
    pidLow: 0x0076, pidHigh: 0x0015,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.mid_freq': {
    block: 'drive', name: 'mid_freq',
    pidLow: 0x0076, pidHigh: 0x0016,
    unit: 'hz', displayMin: 200, displayMax: 2000,
  },
  'drive.treble': {
    block: 'drive', name: 'treble',
    pidLow: 0x0076, pidHigh: 0x0017,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.channel': {
    block: 'drive', name: 'channel',
    pidLow: 0x0076, pidHigh: 0x07d2,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  },
  'drive.type': {
    block: 'drive', name: 'type',
    pidLow: 0x0076, pidHigh: 0x000a,
    // Session 06 capture set drive type with wire-value 8; cache lists
    // index 8 as "T808 Mod" (Fractal's internal label for the TS808
    // variant AM4-Edit surfaces as "TS808"). Full 78-entry table from
    // cache lines up 1:1 with AM4-Edit's Drive Type dropdown order.
    unit: 'enum', displayMin: 0, displayMax: 77,
    enumValues: DRIVE_TYPES_VALUES,
  },
  'reverb.mix': {
    block: 'reverb', name: 'mix',
    pidLow: 0x0042, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'reverb.time': {
    // Blocks Guide §Reverb Basic Page: decay time, 0.1..100 seconds.
    // Uses 'seconds' unit (display = internal, scale 1).
    block: 'reverb', name: 'time',
    pidLow: 0x0042, pidHigh: 0x000b,
    unit: 'seconds', displayMin: 0.1, displayMax: 100,
  },
  'reverb.predelay': {
    // BK-033 fix (HW-025 #1, Session 30): true address is pidHigh=0x0013,
    // not 0x0010. AM4-Edit capture for Pre-Delay→85 ms wrote 0x0042/0x0013
    // with float32(0.085) — confirms the `ms` unit's ÷1000 scale is right.
    // The 0x0010 register was a cache-derived guess that was structurally
    // plausible (range matched) but wrote to nothing. See SYSEX-MAP §6j.
    block: 'reverb', name: 'predelay',
    pidLow: 0x0042, pidHigh: 0x0013,
    unit: 'ms', displayMin: 0, displayMax: 250,
  },
  // Session 29 (HW-015): reverb Size at pidHigh=0x000f. Wire-verified
  // on two captures ("Plate Size" on Plate reverb + "Size" on Room
  // reverb) — same register, type-dependent UI label. Percent scale.
  'reverb.size': {
    block: 'reverb', name: 'size',
    pidLow: 0x0042, pidHigh: 0x000f,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // Session 29 (HW-015): spring-reverb-specific params. Registers are
  // writable on any reverb type; AM4-Edit exposes the UI only when
  // a Spring reverb is active.
  'reverb.springs': {
    block: 'reverb', name: 'springs',
    pidLow: 0x0042, pidHigh: 0x001b,
    unit: 'count', displayMin: 2, displayMax: 6,
  },
  'reverb.spring_tone': {
    block: 'reverb', name: 'spring_tone',
    pidLow: 0x0042, pidHigh: 0x001c,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  // Session 29 follow-up: Shimmer Verb / Plex Verb pitch-shifter
  // voices. Blocks Guide §Shimmer Verb Parameters describes "Shift
  // 1–8" as detune amounts within ±24 semitones ("this is where
  // 'Shimmer' is born"). AM4's reverb exposes two such voices at
  // cache ids 56/57 — structural registration (cache signature
  // matches BG exactly: a=-24, b=24, c=1, step=1). HW-014 couldn't
  // verify on hardware display (both shifts hidden on the Plate
  // reverb type tested); awaits a Shimmer-type hardware spot-check
  // or AM4-Edit-side verification.
  // HW-018 (Session 30, 2026-04-25): 10 new universal/algorithmic-reverb
  // and Spring-specific knobs decoded from session-30-reverb-basic-hall
  // and session-30-reverb-spring captures. Cache metadata confirmed
  // pidLow/pidHigh/range for each; capture final values cross-checked
  // against the founder's AM4-Edit screenshot inventory. Hall + Spring
  // share the universal registers (high_cut / low_cut / input_gain /
  // ducking) while Hall-only adds algorithmic controls (density / quality
  // / stack_hold / stereo_spread) and Spring-only adds Spring-engine
  // controls (dwell / drip).
  'reverb.high_cut': {
    block: 'reverb', name: 'high_cut',
    pidLow: 0x0042, pidHigh: 0x000c,
    // Cache: a=200, b=20000, c=1 → raw Hz, 200..20000 Hz. Hall capture
    // wrote 7000 Hz directly (numeric input field, action=0x0001).
    unit: 'hz', displayMin: 200, displayMax: 20000,
  },
  'reverb.low_cut': {
    block: 'reverb', name: 'low_cut',
    pidLow: 0x0042, pidHigh: 0x0014,
    // Cache: a=20, b=2000, c=1 → raw Hz, 20..2000 Hz.
    unit: 'hz', displayMin: 20, displayMax: 2000,
  },
  'reverb.input_gain': {
    block: 'reverb', name: 'input_gain',
    pidLow: 0x0042, pidHigh: 0x0017,
    // Cache: a=0, b=1, c=100 → percent 0..100. Spring final 0.8217 →
    // 82.17% matches the AM4-Edit screenshot's "Input Gain 82.2 %".
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'reverb.density': {
    block: 'reverb', name: 'density',
    pidLow: 0x0042, pidHigh: 0x0018,
    // Cache: a=4, b=8, c=1, kind=float typecode=16 → integer count
    // 4..8. Hall-only (algorithmic Hall/Plate/Room knob).
    unit: 'count', displayMin: 4, displayMax: 8,
  },
  'reverb.dwell': {
    block: 'reverb', name: 'dwell',
    pidLow: 0x0042, pidHigh: 0x0024,
    // Cache: a=0.01, b=1, c=10 → knob_0_10 (display = wire × 10).
    // Spring final 0.4741 → 4.741 matches screenshot "Dwell 4.74".
    // Spring-engine specific (alongside spring_tone, drip).
    unit: 'knob_0_10', displayMin: 0.1, displayMax: 10,
  },
  'reverb.stereo_spread': {
    block: 'reverb', name: 'stereo_spread',
    pidLow: 0x0042, pidHigh: 0x0027,
    // Cache: a=-2, b=2, c=100 → bipolar_percent allowing -200..+200%.
    // AM4-Edit screenshot shows Hall Stereo Spread as a positive 0..100%
    // knob (display value 90.0 %). Cache exposes the wider firmware
    // range — leave displayMin/displayMax at the cache values; Claude
    // can clamp to the typical 0..100 range when describing the knob.
    unit: 'bipolar_percent', displayMin: -200, displayMax: 200,
  },
  'reverb.ducking': {
    block: 'reverb', name: 'ducking',
    pidLow: 0x0042, pidHigh: 0x0028,
    // Cache: a=0, b=80, c=1 → raw dB, 0..80 dB attenuation. Universal
    // (Hall + Spring both wrote here). Screenshot shows "Ducking 46.9 dB"
    // on both reverb types — typical mid-range attenuation.
    unit: 'db', displayMin: 0, displayMax: 80,
  },
  'reverb.quality': {
    block: 'reverb', name: 'quality',
    pidLow: 0x0042, pidHigh: 0x002f,
    // Cache: enum, values=["ECONOMY","NORMAL","HIGH","ULTRA-HIGH"].
    // Hall-only (algorithmic CPU-quality selector). Hand-authored enum
    // map; not yet exported via cacheEnums.ts since cacheEnums is
    // auto-generated from a different cache section. If a regen pass
    // adds REVERB_QUALITY_VALUES later, swap this inline map for the
    // import.
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'ECONOMY', 1: 'NORMAL', 2: 'HIGH', 3: 'ULTRA-HIGH' },
  },
  'reverb.stack_hold': {
    block: 'reverb', name: 'stack_hold',
    pidLow: 0x0042, pidHigh: 0x0030,
    // Cache: enum, values=["OFF","STACK","HOLD"]. Hall-only. Same
    // hand-authored caveat as reverb.quality.
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'OFF', 1: 'STACK', 2: 'HOLD' },
  },
  'reverb.drip': {
    block: 'reverb', name: 'drip',
    pidLow: 0x0042, pidHigh: 0x0034,
    // Cache: a=0, b=1, c=100 → percent 0..100. Spring final 0.9183 →
    // 91.83% matches screenshot "Drip 91.8 %". Spring-engine specific.
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'reverb.shift_1': {
    block: 'reverb', name: 'shift_1',
    pidLow: 0x0042, pidHigh: 0x0038,
    unit: 'semitones', displayMin: -24, displayMax: 24,
  },
  'reverb.shift_2': {
    block: 'reverb', name: 'shift_2',
    pidLow: 0x0042, pidHigh: 0x0039,
    unit: 'semitones', displayMin: -24, displayMax: 24,
  },
  'reverb.channel': {
    block: 'reverb', name: 'channel',
    pidLow: 0x0042, pidHigh: 0x07d2,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  },
  'reverb.type': {
    block: 'reverb', name: 'type',
    pidLow: 0x0042, pidHigh: 0x000a,
    // Session 16: enum dictionary imported from cacheEnums.ts (79 models).
    // Untested against capture.
    unit: 'enum', displayMin: 0, displayMax: 78,
    enumValues: REVERB_TYPES_VALUES,
  },
  'delay.time': {
    block: 'delay', name: 'time',
    pidLow: 0x0046, pidHigh: 0x000c,
    // Session 16: cache says `b=8` seconds → UI max 8000 ms (was 5000).
    unit: 'ms', displayMin: 0, displayMax: 8000,
  },
  'delay.mix': {
    // Blocks Guide: delay has Mix at pidHigh 0x01. "Note that the
    // delay block uses a different Mix Law compared to other blocks" —
    // semantics differ but the param is at the standard location.
    block: 'delay', name: 'mix',
    pidLow: 0x0046, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // Session 29 (HW-015): Feedback knobs on per-block delay/flanger/phaser.
  // All bipolar — negative feedback inverts the phase of the repeats/
  // sweep, a standard Fractal implementation detail.
  'delay.feedback': {
    block: 'delay', name: 'feedback',
    pidLow: 0x0046, pidHigh: 0x000e,
    unit: 'bipolar_percent', displayMin: -100, displayMax: 100,
  },
  // HW-020 (Session 30, 2026-04-25): Delay first-page registers from
  // session-30-delay-basic-digital-mono. `level` follows the universal
  // pidHigh=0x0000 "Level" pattern shared with amp.level (no cache
  // record at id=0; out-of-band hand-author). `stack_hold` and
  // `ducking` mirror the same registers found on Reverb (HW-018).
  // `tempo` (pidHigh=0x0013) is captured but deferred — registering
  // it requires extracting the 79-entry tempo-division enum from cache
  // (queued as HW-027 follow-up).
  'delay.level': {
    block: 'delay', name: 'level',
    pidLow: 0x0046, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'delay.stack_hold': {
    block: 'delay', name: 'stack_hold',
    pidLow: 0x0046, pidHigh: 0x001f,
    // Cache id=31: enum [OFF|STACK|HOLD]. Hand-authored — generator
    // can't emit per-block non-Type enums (it would mis-import the
    // block's TYPES_VALUES instead of these three).
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: { 0: 'OFF', 1: 'STACK', 2: 'HOLD' },
  },
  'delay.ducking': {
    block: 'delay', name: 'ducking',
    pidLow: 0x0046, pidHigh: 0x002e,
    // Cache id=46: float a=0 b=80 c=1 → raw dB 0..80 attenuation.
    // Same signature as reverb.ducking (HW-018).
    unit: 'db', displayMin: 0, displayMax: 80,
  },
  'delay.channel': {
    block: 'delay', name: 'channel',
    pidLow: 0x0046, pidHigh: 0x07d2,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  },
  'delay.type': {
    block: 'delay', name: 'type',
    pidLow: 0x0046, pidHigh: 0x000a,
    // Session 16: enum dictionary imported from cacheEnums.ts (29 models).
    // Untested against capture.
    unit: 'enum', displayMin: 0, displayMax: 28,
    enumValues: DELAY_TYPES_VALUES,
  },
  // Session 18 — 6 additional block Type selectors, each pinned to wire
  // pidLow by a Tier-3 AM4-Edit capture of a Type-dropdown change. The
  // cache record id is the wire pidHigh (10 for the effect blocks, 19/20
  // for Comp/GEQ because their cache slot reserves ids 0..12 for band
  // levels / assign slots).
  // P1-010 Session B (2026-04-20) — universal Mix control per the
  // Blocks Guide §Common Mix/Level Parameters (p. 7). Every effect
  // block with a wet/dry concept exposes Mix at pidHigh 0x01 with the
  // same percent signature as the confirmed reverb.mix. Skipped for
  // Wah/GEQ/Gate/Volume-Pan (AM4 manual p. 34: "Effects with no mix,
  // such as Wah, GEQ, etc., will show 'NA'"). HW-014 partial: delay
  // / chorus / reverb mix verified correct; flanger.mix and
  // phaser.mix surfaced the BK-034 encoding bug (see entries below);
  // tremolo.mix / compressor.mix / filter.mix hidden on hardware
  // display (awaits AM4-Edit verification).
  // Modulation-block LFO rates + depths (Session 26 Unit-extension pass).
  // Rate uses the 'hz' unit (raw passthrough, c=1 in cache). Depth is a
  // standard percent knob. Blocks Guide §Chorus/Flanger/Phaser document
  // all three as Basic Page controls across these blocks.
  'chorus.mix': {
    block: 'chorus', name: 'mix',
    pidLow: 0x004e, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'chorus.type': {
    block: 'chorus', name: 'type',
    pidLow: 0x004e, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 19,
    enumValues: CHORUS_TYPES_VALUES,
  },
  'chorus.rate': {
    // BK-034 resolved (HW-025 #2, Session 30): NOT an encoding bug.
    // AM4-Edit wire for Rate→3.4 Hz wrote pidLow=0x004e/pidHigh=0x000c
    // with float32(3.4) — byte-identical to our `unit: 'hz'` builder.
    // HW-014's hardware-display readback (3.4→0.5 Hz) is an AM4
    // hardware-screen rendering quirk for chorus rate, not a wire-
    // layer bug. Verify chorus rate via AM4-Edit, not the AM4 hardware
    // display, until the screen-side rendering is characterised.
    block: 'chorus', name: 'rate',
    pidLow: 0x004e, pidHigh: 0x000c,
    unit: 'hz', displayMin: 0.1, displayMax: 10,
  },
  'chorus.depth': {
    block: 'chorus', name: 'depth',
    pidLow: 0x004e, pidHigh: 0x000e,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'flanger.mix': {
    // BK-034 resolved (HW-025 #3, Session 30): NOT an encoding bug.
    // AM4-Edit wire for Mix→54% wrote pidLow=0x0052/pidHigh=0x0001
    // with float32(0.54) — byte-identical to our `unit: 'percent'`
    // builder. HW-014's hardware-display readback (54%→50%) is a
    // hardware-screen rendering quirk; verify via AM4-Edit.
    block: 'flanger', name: 'mix',
    pidLow: 0x0052, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'flanger.type': {
    block: 'flanger', name: 'type',
    pidLow: 0x0052, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 31,
    enumValues: FLANGER_TYPES_VALUES,
  },
  'flanger.rate': {
    block: 'flanger', name: 'rate',
    pidLow: 0x0052, pidHigh: 0x000b,
    unit: 'hz', displayMin: 0.05, displayMax: 10,
  },
  'flanger.depth': {
    block: 'flanger', name: 'depth',
    pidLow: 0x0052, pidHigh: 0x000d,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'flanger.feedback': {
    // BK-034 resolved (HW-025 #4, Session 30): NOT an encoding bug.
    // AM4-Edit wire for Feedback→-61% wrote pidLow=0x0052/pidHigh=0x000e
    // with float32(-0.61) — byte-identical to our `unit: 'bipolar_percent'`
    // builder. HW-014's hardware-display readbacks (-61%→0; +99%→+90)
    // are hardware-screen rendering quirks; verify via AM4-Edit.
    block: 'flanger', name: 'feedback',
    pidLow: 0x0052, pidHigh: 0x000e,
    // Cache caps internal range at ±0.995 — display scale 100 ⇒ ±99%.
    unit: 'bipolar_percent', displayMin: -99, displayMax: 99,
  },
  'phaser.mix': {
    // BK-034 resolved (HW-025 #5, Session 30): NOT an encoding bug.
    // AM4-Edit wire for Mix→88% wrote pidLow=0x005a/pidHigh=0x0001
    // with float32(0.88) — byte-identical to our `unit: 'percent'`
    // builder. HW-014's hardware-display readback (88%→53%) is a
    // hardware-screen rendering quirk; verify via AM4-Edit.
    block: 'phaser', name: 'mix',
    pidLow: 0x005a, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'phaser.type': {
    block: 'phaser', name: 'type',
    pidLow: 0x005a, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 16,
    enumValues: PHASER_TYPES_VALUES,
  },
  'phaser.rate': {
    block: 'phaser', name: 'rate',
    pidLow: 0x005a, pidHigh: 0x000c,
    unit: 'hz', displayMin: 0.1, displayMax: 10,
  },
  'phaser.feedback': {
    block: 'phaser', name: 'feedback',
    pidLow: 0x005a, pidHigh: 0x0010,
    // Cache signature is unusual — internal ±0.9, display-scale 111.1.
    // We use standard bipolar_percent (scale 100) with clamped bounds
    // so input stays inside the internal range; AM4-Edit's displayed
    // percentage may read slightly higher than the value set (an input
    // of "50" sets internal 0.5 which AM4-Edit shows as ~55.5%). The
    // natural-language UX impact is negligible.
    unit: 'bipolar_percent', displayMin: -90, displayMax: 90,
  },
  'wah.type': {
    block: 'wah', name: 'type',
    pidLow: 0x005e, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 8,
    enumValues: WAH_TYPES_VALUES,
  },
  'compressor.mix': {
    block: 'compressor', name: 'mix',
    pidLow: 0x002e, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  // HW-021 (Session 30, 2026-04-25): Compressor first-page registers
  // from session-30-comp-basic-jfet-studio. Cache ids 10..15 are the
  // canonical comp-config knobs (Threshold, Ratio, Attack, Release,
  // Knee Type enum, Auto Makeup OFF/ON). `level` follows the universal
  // pidHigh=0x0000 "Level" pattern (out-of-band hand-author).
  // Two more registers wiggled in the capture remain unidentified
  // (pidHigh=0x0017 cache id=23 float; pidHigh=0x0029 cache id=41
  // knob_0_10 with value 1.2 exceeding cache cap b=1) — queued as
  // HW-028 follow-up. The Optical/JFET-specific Light Type knob
  // wasn't reached in this capture.
  'compressor.level': {
    block: 'compressor', name: 'level',
    pidLow: 0x002e, pidHigh: 0x0000,
    unit: 'db', displayMin: -80, displayMax: 20,
  },
  'compressor.threshold': {
    block: 'compressor', name: 'threshold',
    pidLow: 0x002e, pidHigh: 0x000a,
    // Cache id=10: float a=-60 b=20 c=1 → dB -60..+20 (capture wrote
    // -30 dB).
    unit: 'db', displayMin: -60, displayMax: 20,
  },
  'compressor.ratio': {
    block: 'compressor', name: 'ratio',
    pidLow: 0x002e, pidHigh: 0x000b,
    // Cache id=11: float a=1 b=20 c=1 step=0.01 → 1.0..20.0 ratio
    // (e.g. 4.0 ⇒ 4:1). Uses the `ratio` unit semantically; math is
    // identical to db/hz/seconds (display = internal, scale 1) but
    // the label tells Claude "4 means 4:1, not 4 dB".
    unit: 'ratio', displayMin: 1, displayMax: 20,
  },
  'compressor.attack': {
    block: 'compressor', name: 'attack',
    pidLow: 0x002e, pidHigh: 0x000c,
    // Cache id=12: float a=0.0001 b=0.1 c=1000 → 0.1..100 ms.
    unit: 'ms', displayMin: 0.1, displayMax: 100,
  },
  'compressor.release': {
    block: 'compressor', name: 'release',
    pidLow: 0x002e, pidHigh: 0x000d,
    // Cache id=13: float a=0.002 b=2 c=1000 → 2..2000 ms.
    unit: 'ms', displayMin: 2, displayMax: 2000,
  },
  'compressor.auto_makeup': {
    block: 'compressor', name: 'auto_makeup',
    pidLow: 0x002e, pidHigh: 0x000f,
    // Cache id=15: enum [OFF|ON]. Hand-authored — see delay.stack_hold
    // for why per-block non-Type enums skip the generator.
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: { 0: 'OFF', 1: 'ON' },
  },
  'compressor.type': {
    block: 'compressor', name: 'type',
    pidLow: 0x002e, pidHigh: 0x0013,
    unit: 'enum', displayMin: 0, displayMax: 18,
    enumValues: COMPRESSOR_TYPES_VALUES,
  },
  'geq.type': {
    block: 'geq', name: 'type',
    pidLow: 0x0032, pidHigh: 0x0014,
    unit: 'enum', displayMin: 0, displayMax: 17,
    enumValues: GEQ_TYPES_VALUES,
  },
  // Session 18 (continued) — 5 more Type/Mode selectors from block-placement
  // captures. PEQ (pidLow=0x36) and Rotary (pidLow=0x56) are also confirmed
  // block addresses but have no Type enum — their params will be added when
  // we start supporting specific knob names.
  'filter.mix': {
    block: 'filter', name: 'mix',
    pidLow: 0x0072, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'filter.type': {
    block: 'filter', name: 'type',
    pidLow: 0x0072, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 17,
    enumValues: FILTER_TYPES_VALUES,
  },
  'filter.freq': {
    // Blocks Guide §Filter: Frequency is the filter cutoff. 20..20000 Hz,
    // c=1 raw (uses 'hz' unit).
    block: 'filter', name: 'freq',
    pidLow: 0x0072, pidHigh: 0x000b,
    unit: 'hz', displayMin: 20, displayMax: 20000,
  },
  'tremolo.mix': {
    block: 'tremolo', name: 'mix',
    pidLow: 0x006a, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'tremolo.type': {
    block: 'tremolo', name: 'type',
    pidLow: 0x006a, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 6,
    enumValues: TREMOLO_TYPES_VALUES,
  },
  'tremolo.rate': {
    block: 'tremolo', name: 'rate',
    pidLow: 0x006a, pidHigh: 0x000c,
    unit: 'hz', displayMin: 0.2, displayMax: 20,
  },
  'tremolo.depth': {
    block: 'tremolo', name: 'depth',
    pidLow: 0x006a, pidHigh: 0x000d,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'enhancer.mix': {
    block: 'enhancer', name: 'mix',
    pidLow: 0x007a, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'enhancer.type': {
    // AM4-Edit labels this "Mode", but keep `type` for consistency across blocks.
    block: 'enhancer', name: 'type',
    pidLow: 0x007a, pidHigh: 0x000e,
    unit: 'enum', displayMin: 0, displayMax: 2,
    enumValues: ENHANCER_TYPES_VALUES,
  },
  'gate.type': {
    block: 'gate', name: 'type',
    pidLow: 0x0092, pidHigh: 0x0013,
    unit: 'enum', displayMin: 0, displayMax: 3,
    enumValues: GATE_TYPES_VALUES,
  },
  'volpan.mode': {
    // Block is "Volume/Pan"; this is the Volume-vs-Auto-Swell selector.
    block: 'volpan', name: 'mode',
    pidLow: 0x0066, pidHigh: 0x000f,
    unit: 'enum', displayMin: 0, displayMax: 1,
    enumValues: VOLPAN_MODES_VALUES,
  },

  // Universal per-block output Balance (Session 28 cont — P1-010
  // second unit-extension pass, introduced `bipolar_percent`).
  // Blocks Guide line 347: "Every block outputs both left and right
  // signals. As you adjust to the left or right, the opposite channel
  // [is reduced]." Confirmed as a universal block-level parameter at
  // lines 899 (Amp), 1233 (Chorus), 1430 (Flanger), 1733 (Delay),
  // 1883 (Phaser). Cache signature is identical across all 15
  // confirmed blocks: id=2, a=-1, b=1, c=100 (display = internal ×
  // 100, so -100..+100%). HW-014 verified on `geq.balance` = -67
  // (the only Balance param AM4's hardware display exposes); other
  // block Balances wrote and wire-acked but are hidden from the
  // hardware screen. AM4-Edit verification owed for the 14 hidden
  // ones; structural evidence across all 15 blocks is extremely
  // strong.
  'amp.balance':       { block: 'amp',        name: 'balance', pidLow: 0x003a, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'compressor.balance':{ block: 'compressor', name: 'balance', pidLow: 0x002e, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'geq.balance':       { block: 'geq',        name: 'balance', pidLow: 0x0032, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'reverb.balance':    { block: 'reverb',     name: 'balance', pidLow: 0x0042, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'delay.balance':     { block: 'delay',      name: 'balance', pidLow: 0x0046, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'chorus.balance':    { block: 'chorus',     name: 'balance', pidLow: 0x004e, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'flanger.balance':   { block: 'flanger',    name: 'balance', pidLow: 0x0052, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'phaser.balance':    { block: 'phaser',     name: 'balance', pidLow: 0x005a, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'wah.balance':       { block: 'wah',        name: 'balance', pidLow: 0x005e, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'tremolo.balance':   { block: 'tremolo',    name: 'balance', pidLow: 0x006a, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'filter.balance':    { block: 'filter',     name: 'balance', pidLow: 0x0072, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'drive.balance':     { block: 'drive',      name: 'balance', pidLow: 0x0076, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'enhancer.balance':  { block: 'enhancer',   name: 'balance', pidLow: 0x007a, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'gate.balance':      { block: 'gate',       name: 'balance', pidLow: 0x0092, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
  'volpan.balance':    { block: 'volpan',     name: 'balance', pidLow: 0x0066, pidHigh: 0x0002, unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
} as const satisfies Record<string, Param>;

export type ParamKey = keyof typeof KNOWN_PARAMS;
