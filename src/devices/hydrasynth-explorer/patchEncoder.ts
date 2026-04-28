/**
 * Hydrasynth patch byte-map encoder/decoder.
 *
 * The Hydrasynth's whole-patch SysEx dump is a 2790-byte buffer split
 * across 22 chunks (21 × 128-byte chunks + a final 102-byte chunk),
 * sent as a sequence of `wrapSysex([0x16, 0x00, CHUNK, 0x16, …data…])`
 * messages. Every patch parameter sits at a fixed byte offset
 * documented in
 * `docs/devices/hydrasynth-explorer/references/SysexPatchFormat.txt`
 * (edisyn, Sean Luke).
 *
 * This module owns three concerns:
 *
 *   1. **Byte-level encoding** — read/write a parameter at its
 *      documented offset using one of four encodings: `u16le` (low/high
 *      byte pair, unsigned 0..65535), `s16le` (signed 16-bit
 *      little-endian, used by params that store negative values across
 *      both bytes), `u8` (single unsigned byte at the LSB position with
 *      the MSB position left as-is), and `s8` (single signed byte with
 *      sign-extension into the MSB position — `0xFF` for negative).
 *
 *   2. **Curated NRPN-name → offset map** — `PATCH_OFFSETS`. Hand-picked
 *      ~30 high-impact first-page params (oscillators, mixer, filter,
 *      amp, env1, FX dry/wet) so the encoder can take a sparse
 *      `Map<canonicalName, value>` and apply it on top of a base
 *      buffer. Future sessions extend this table; the format spec
 *      enumerates ~1000 params and we don't need them all on day one.
 *
 *   3. **Wire-chunking** — `splitIntoChunks(buf)` slices the 2790-byte
 *      buffer into the 22 chunks the device expects, framed with the
 *      `[0x16, 0x00, CHUNK, 0x16]` chunk-dump header. Each chunk is
 *      then `wrapSysex`'d at the call site to produce final F0…F7
 *      messages.
 *
 * Two invariants this module relies on the spec to hold:
 *
 *   - The patch buffer is exactly 2790 bytes (21 × 128 + 102). Asserted
 *     in `splitIntoChunks` / `concatChunks`.
 *   - The first 8 bytes are device metadata (Save-to-RAM marker, bank,
 *     patch number, version, etc.) — included in chunk 0 but not part
 *     of the audible patch. They're documented as fixed at known
 *     values: byte 1 = 0x00, byte 4 = version (0xC8 for 2.0.0). The
 *     encoder doesn't enforce these — callers preparing a fresh patch
 *     buffer set them up front.
 *
 * Goldens for this module live in `scripts/hydrasynth/verify-sysex-patch.ts`.
 */
import { HYDRASYNTH_NRPNS, type HydrasynthNrpn } from './nrpn.js';
import { INIT_PATCH_BUFFER } from './initPatchBuffer.js';

/** The full Hydrasynth patch buffer is 2790 bytes (21×128 + 102). */
export const PATCH_BUFFER_SIZE = 2790;

/** Standard chunk size for chunks 0..20 (21 chunks). */
export const PATCH_CHUNK_SIZE = 128;

/** Final chunk (chunk 21) is shorter — 102 bytes. */
export const PATCH_LAST_CHUNK_SIZE = 102;

/** Number of chunks per patch dump (21 full + 1 short = 22). */
export const PATCH_CHUNK_COUNT = 22;

/** Patch-buffer offsets for the eight-byte metadata header. */
export const PATCH_META = {
  /** byte 0: 0x06 = "Save to RAM" marker per spec. */
  saveMarker: 0,
  /** byte 1: always 0x00. */
  reserved1: 1,
  /** byte 2: bank number (A=0..H=7 on hardware; spec table allows 0..N). */
  bank: 2,
  /** byte 3: patch number within bank (0..127). */
  patchNumber: 3,
  /** byte 4: firmware version byte. 0xC8 = 2.0.0, 0xDC = 2.2.0. */
  version: 4,
  /** byte 6: also patch number per spec (purpose unclear). */
  patchNumberAlt: 6,
} as const;

/** Patch-buffer offsets for the four "magic bytes" (1766–1769). */
export const PATCH_MAGIC_BYTES = {
  /** Spec line 73: leaving these zero causes most subsequent writes to fail. */
  offsets: [1766, 1767, 1768, 1769],
  /** Default values per spec — ASCII "ETCD". */
  defaults: [69, 84, 67, 68],
} as const;

/**
 * Patch name occupies bytes 9..24 (16 chars max). Byte 8 is `Category`,
 * which the spec notes uses byte 9's "MSB position" — but for our
 * purposes we treat the name region as 16 contiguous bytes.
 */
export const PATCH_NAME = {
  startByte: 9,
  /** Hydrasynth front panel allows 16 chars max. */
  maxLength: 16,
} as const;

/**
 * Encoding kinds for parameters laid out in the patch buffer.
 *
 * - `u16le`: unsigned 16-bit little-endian. Byte N = LSB, byte N+1 = MSB.
 *   Used by all 14-bit wire-value params (filter cutoff, env timings,
 *   mixer volumes, bipolar centered values, etc.).
 *
 * - `s16le`: signed 16-bit little-endian (two's complement). Used by
 *   the few params that store full negative ranges across both bytes.
 *
 * - `u8`: single unsigned byte at offset N. Byte N+1 is left untouched
 *   on encode (typically 0). Used by enum / mode / boolean params.
 *
 * - `s8`: single signed byte at offset N with sign-extension into byte
 *   N+1 (`0xFF` for negative, `0x00` for non-negative). Used by 1-byte
 *   2's complement values like `osc1semi` (-36..+36) where the spec
 *   says "if such a parameter represents a negative value, then it is
 *   sign-extended into the second byte".
 */
export type PatchOffsetEncoding = 'u16le' | 's16le' | 'u8' | 's8';

/** A single curated mapping: canonical NRPN name → patch byte offset. */
export interface PatchOffsetSpec {
  /** Canonical NRPN name (must match `HYDRASYNTH_NRPNS[i].name`). */
  readonly name: string;
  /** Byte offset of the LSB position in the patch buffer (0..2789). */
  readonly byte: number;
  /** How the value is laid out in the buffer at that offset. */
  readonly enc: PatchOffsetEncoding;
  /** Spec-table label for cross-reference. Optional, debugging aid. */
  readonly label?: string;
}

/**
 * Curated subset of canonical NRPN names → patch byte offsets.
 *
 * **NOT exhaustive.** The spec enumerates ~1000 params; this table
 * covers ~30 first-page params critical to BK-036 milestone 2:
 *
 *   - The two BK-037 bipolar-bug regressions (filter1env1amount,
 *     filter1keytrack).
 *   - Osc1/2/3 first-page (mode, type, semi, cent, keytrack).
 *   - Mixer first-page (osc1/2/3 vol + pan).
 *   - Filter1/2 first-page (type, cutoff, resonance, env1 amount,
 *     LFO1 amount, vel-env, keytrack).
 *   - Amplifier (level, vel-env, LFO2 amount).
 *   - Env1 (attack, decay, sustain, release, delay, hold).
 *   - FX (pre/post type + dry/wet, delay/reverb dry/wet).
 *
 * Future sessions extend this; the encoder/decoder logic is generic
 * over the table so adding entries is a one-line change per param.
 *
 * **BPM-sync collapse note** (per spec line 61–68): the Hydrasynth
 * has separate sync-on / sync-off NRPN addresses for env timings,
 * delay time, LFO rates, and a few others. The patch buffer collapses
 * to a single slot, with semantics determined by the corresponding
 * `*bpmsync` byte. We map the **sync-off** variants (the more common
 * default state); callers writing sync-on values should set
 * `env1bpmsync`/`delaybpmsync` accordingly. Decoders see only the
 * collapsed value and don't know which semantic was active without
 * also reading the bpm-sync byte.
 */
export const PATCH_OFFSETS: readonly PatchOffsetSpec[] = [
  // -------- Voice / global (bytes 30–60) --------
  { name: 'voicepolyphony',     byte:  30, enc: 'u8',    label: 'Polyphony' },
  { name: 'voicedensity',       byte:  32, enc: 'u8',    label: 'Density' },
  { name: 'voicedetune',        byte:  34, enc: 'u8',    label: 'Detune' },
  { name: 'voiceanalogfeel',    byte:  36, enc: 'u8',    label: 'Analog Feel' },
  { name: 'voicestereomode',    byte:  40, enc: 'u8',    label: 'Stereo Mode' },
  { name: 'voicestereowidth',   byte:  42, enc: 'u8',    label: 'Stereo Width' },
  { name: 'voicepitchbend',     byte:  44, enc: 'u8',    label: 'Pitch Bend Range' },
  { name: 'voiceglide',         byte:  52, enc: 'u8',    label: 'Glide' },
  { name: 'voiceglidetime',     byte:  54, enc: 'u8',    label: 'Glide Time' },
  { name: 'voiceglidecurve',    byte:  56, enc: 'u8',    label: 'Glide Curve' },
  { name: 'voiceglidelegto',    byte:  58, enc: 'u8',    label: 'Legato' },

  // -------- Oscillator 1 (bytes 80–106) --------
  { name: 'osc1mode',           byte:  80, enc: 'u8',    label: 'Osc 1 Mode' },
  { name: 'osc1type',           byte:  82, enc: 'u8',    label: 'Osc 1 Wave' },
  { name: 'osc1semi',           byte:  84, enc: 's8',    label: 'Osc1 Semitones' },
  { name: 'osc1cent',           byte:  86, enc: 's16le', label: 'Osc1 Cents (-50..+50, 14-bit ring)' },
  { name: 'osc1keytrack',       byte:  88, enc: 's8',    label: 'Osc1 Keytrack' },
  { name: 'osc1wavscan',        byte:  90, enc: 'u16le', label: 'Osc 1 Wavescan' },

  // -------- Oscillator 2 (bytes 108–...) --------
  { name: 'osc2mode',           byte: 108, enc: 'u8',    label: 'Osc 2 Mode' },
  { name: 'osc2type',           byte: 110, enc: 'u8',    label: 'Osc 2 Wave' },

  // -------- Oscillator 3 (bytes 136–...) --------
  { name: 'osc3type',           byte: 136, enc: 'u8',    label: 'Osc 3 Wave' },

  // -------- Ring mod / noise (bytes 264–272) --------
  { name: 'ringmodsource1',     byte: 264, enc: 'u8',    label: 'Ring Mod Source 1' },
  { name: 'ringmodsource2',     byte: 266, enc: 'u8',    label: 'Ring Mod Source 2' },
  { name: 'ringmoddepth',       byte: 268, enc: 'u16le', label: 'Ring Mod Depth' },
  { name: 'noisetype',          byte: 272, enc: 'u8',    label: 'Noise Type' },

  // -------- Mixer (bytes 274–306) --------
  { name: 'mixerosc1vol',       byte: 274, enc: 'u16le', label: 'Mixer Osc 1 Volume' },
  { name: 'mixerosc2vol',       byte: 276, enc: 'u16le', label: 'Mixer Osc 2 Volume' },
  { name: 'mixerosc3vol',       byte: 278, enc: 'u16le', label: 'Mixer Osc 3 Volume' },
  { name: 'mixerringmodvol',    byte: 280, enc: 'u16le', label: 'Mixer Ringmod Volume' },
  { name: 'mixernoisevol',      byte: 282, enc: 'u16le', label: 'Mixer Noise Volume' },
  { name: 'mixerosc1pan',       byte: 286, enc: 'u16le', label: 'Mixer Osc 1 Pan (bipolar)' },
  { name: 'mixerosc2pan',       byte: 288, enc: 'u16le', label: 'Mixer Osc 2 Pan (bipolar)' },
  { name: 'mixerosc3pan',       byte: 290, enc: 'u16le', label: 'Mixer Osc 3 Pan (bipolar)' },
  { name: 'mixerosc1filterratio', byte: 292, enc: 'u16le', label: 'Mixer Osc 1 Filter Ratio' },
  { name: 'mixerosc2filterratio', byte: 294, enc: 'u16le', label: 'Mixer Osc 2 Filter Ratio' },
  { name: 'mixerosc3filterratio', byte: 296, enc: 'u16le', label: 'Mixer Osc 3 Filter Ratio' },
  { name: 'mixerringmodpan',    byte: 298, enc: 'u16le', label: 'Mixer Ringmod Pan' },
  { name: 'mixernoisepan',      byte: 300, enc: 'u16le', label: 'Mixer Noise Pan' },
  { name: 'mixerfilterrouting', byte: 302, enc: 'u8',    label: 'Filter Routing' },
  { name: 'mixerringmodfilterratio', byte: 304, enc: 'u16le', label: 'Mixer Ringmod Filter Ratio' },
  { name: 'mixernoisefilterratio',   byte: 306, enc: 'u16le', label: 'Mixer Noise Filter Ratio' },

  // -------- Filter 1 (bytes 308–330) --------
  { name: 'filter1type',        byte: 308, enc: 'u8',    label: 'Filter 1 Type' },
  { name: 'filter1cutoff',      byte: 310, enc: 'u16le', label: 'Filter 1 Cutoff' },
  { name: 'filter1resonance',   byte: 312, enc: 'u16le', label: 'Filter 1 Resonance' },
  { name: 'filter1special',     byte: 314, enc: 'u16le', label: 'Filter 1 Formant Control' },
  { name: 'filter1env1amount',  byte: 316, enc: 'u16le', label: 'Filter 1 Env 1 Amount (bipolar)' },
  { name: 'filter1lfo1amount',  byte: 318, enc: 'u16le', label: 'Filter 1 LFO 1 Amount (bipolar)' },
  { name: 'filter1velenv',      byte: 320, enc: 'u16le', label: 'Filter 1 Vel Env' },
  { name: 'filter1keytrack',    byte: 322, enc: 'u16le', label: 'Filter 1 Keytrack (bipolar)' },
  { name: 'filter1drive',       byte: 326, enc: 'u16le', label: 'Filter 1 Drive' },
  { name: 'filter1positionofdrive', byte: 328, enc: 'u8', label: 'Filter 1 Drive Position' },
  { name: 'filter1vowelorder',  byte: 330, enc: 'u8',    label: 'Filter 1 Vowel Order' },

  // -------- Filter 2 (bytes 332–344, plus type at 472) --------
  { name: 'filter2morph',       byte: 332, enc: 'u16le', label: 'Filter 2 Morph' },
  { name: 'filter2cutoff',      byte: 334, enc: 'u16le', label: 'Filter 2 Cutoff' },
  { name: 'filter2resonance',   byte: 336, enc: 'u16le', label: 'Filter 2 Resonance' },
  { name: 'filter2env1amount',  byte: 338, enc: 'u16le', label: 'Filter 2 Env 1 Amount (bipolar)' },
  { name: 'filter2lfo1amount',  byte: 340, enc: 'u16le', label: 'Filter 2 LFO 1 Amount (bipolar)' },
  { name: 'filter2velenv',      byte: 342, enc: 'u16le', label: 'Filter 2 Vel Env' },
  { name: 'filter2keytrack',    byte: 344, enc: 'u16le', label: 'Filter 2 Keytrack (bipolar)' },
  { name: 'filter2type',        byte: 472, enc: 'u8',    label: 'Filter 2 Type' },

  // -------- Amplifier (bytes 346–351) --------
  { name: 'amplfo2amount',      byte: 346, enc: 'u16le', label: 'Amplifier LFO 2 Amount (bipolar)' },
  { name: 'ampvelenv',          byte: 348, enc: 'u16le', label: 'Amplifier Vel Env' },
  { name: 'amplevel',           byte: 350, enc: 'u16le', label: 'Amplifier Level' },

  // -------- Pre-FX (bytes 352–367) --------
  { name: 'prefxtype',          byte: 352, enc: 'u8',    label: 'Pre-FX Type' },
  { name: 'prefxwet',           byte: 366, enc: 'u16le', label: 'Pre-FX Dry/Wet' },

  // -------- Delay (bytes 368–383) --------
  { name: 'delaytype',          byte: 368, enc: 'u8',    label: 'Delay Type' },
  { name: 'delaybpmsync',       byte: 370, enc: 'u8',    label: 'Delay BPM Sync' },
  // Spec collapses sync-on/sync-off into one slot. Map the sync-off
  // variant; callers using sync-on must set delaybpmsync = 1.
  { name: 'delaytimesyncoff',   byte: 372, enc: 'u16le', label: 'Delay Time (collapsed slot)' },
  { name: 'delayfeedback',      byte: 374, enc: 'u16le', label: 'Delay Feedback' },
  { name: 'delayfeedtone',      byte: 376, enc: 'u16le', label: 'Delay Feed Tone (bipolar)' },
  { name: 'delaywettone',       byte: 378, enc: 'u16le', label: 'Delay Wet Tone (bipolar)' },
  { name: 'delaywet',           byte: 382, enc: 'u16le', label: 'Delay Dry/Wet' },

  // -------- Reverb (bytes 384–399) --------
  { name: 'reverbtype',         byte: 384, enc: 'u8',    label: 'Reverb Type' },
  { name: 'reverbtime',         byte: 388, enc: 'u16le', label: 'Reverb Time' },
  { name: 'reverbtone',         byte: 390, enc: 'u16le', label: 'Reverb Tone (bipolar)' },
  { name: 'reverbhidamp',       byte: 392, enc: 'u16le', label: 'Reverb High Damp' },
  { name: 'reverblodamp',       byte: 394, enc: 'u16le', label: 'Reverb Low Damp' },
  { name: 'reverbpredelay',     byte: 396, enc: 'u16le', label: 'Reverb Predelay' },
  { name: 'reverbwet',          byte: 398, enc: 'u16le', label: 'Reverb Dry/Wet' },

  // -------- Post-FX (bytes 400–415) --------
  { name: 'postfxtype',         byte: 400, enc: 'u8',    label: 'Post-FX Type' },
  { name: 'postfxwet',          byte: 414, enc: 'u16le', label: 'Post-FX Dry/Wet' },

  // -------- Env 1 (bytes 478–504) --------
  { name: 'env1attacksyncoff',  byte: 478, enc: 'u16le', label: 'Env 1 Attack (collapsed slot)' },
  { name: 'env1decaysyncoff',   byte: 480, enc: 'u16le', label: 'Env 1 Decay (collapsed slot)' },
  { name: 'env1sustain',        byte: 482, enc: 'u16le', label: 'Env 1 Sustain' },
  { name: 'env1releasesyncoff', byte: 484, enc: 'u16le', label: 'Env 1 Release (collapsed slot)' },
  { name: 'env1bpmsync',        byte: 486, enc: 'u8',    label: 'Env 1 BPM Sync' },
  { name: 'env1delaysyncoff',   byte: 488, enc: 'u16le', label: 'Env 1 Delay (collapsed slot)' },
  { name: 'env1holdsyncoff',    byte: 490, enc: 'u16le', label: 'Env 1 Hold (collapsed slot)' },
  { name: 'env1atkcurve',       byte: 492, enc: 's8',    label: 'Env 1 Attack Curve' },
  { name: 'env1deccurve',       byte: 494, enc: 's8',    label: 'Env 1 Decay Curve' },
  { name: 'env1relcurve',       byte: 496, enc: 's8',    label: 'Env 1 Release Curve' },
  { name: 'env1legato',         byte: 498, enc: 'u8',    label: 'Env 1 Legato' },
  { name: 'env1reset',          byte: 500, enc: 'u8',    label: 'Env 1 Reset' },
  { name: 'env1freerun',        byte: 502, enc: 'u8',    label: 'Env 1 Free Run' },
  { name: 'env1loop',           byte: 504, enc: 'u8',    label: 'Env 1 Loop Curve' },
];

/** Build an O(1) name → spec lookup; used by encode/decode helpers. */
const PATCH_OFFSETS_BY_NAME: Map<string, PatchOffsetSpec> = (() => {
  const m = new Map<string, PatchOffsetSpec>();
  for (const spec of PATCH_OFFSETS) {
    if (m.has(spec.name)) {
      throw new Error(`PATCH_OFFSETS duplicate name: "${spec.name}"`);
    }
    m.set(spec.name, spec);
  }
  return m;
})();

/** Lookup a curated patch-buffer offset by canonical NRPN name. */
export function findPatchOffset(name: string): PatchOffsetSpec | undefined {
  return PATCH_OFFSETS_BY_NAME.get(name);
}

// ---------------------------------------------------------------------------
// Low-level byte read/write at a single offset.
// ---------------------------------------------------------------------------

/**
 * Encode `value` into `buf` at `spec.byte` per `spec.enc`.
 * Mutates `buf` in place. Returns nothing.
 *
 * Throws if `value` is out of range for the encoding (e.g. > 65535
 * for `u16le`, > 127 or < -128 for `s8`).
 */
export function writePatchValue(buf: Uint8Array, spec: PatchOffsetSpec, value: number): void {
  if (spec.byte < 0 || spec.byte + 1 >= buf.length) {
    throw new Error(`patch offset ${spec.byte} out of bounds for buffer of ${buf.length} bytes`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`patch value for "${spec.name}" must be an integer; got ${value}`);
  }
  switch (spec.enc) {
    case 'u16le': {
      if (value < 0 || value > 0xffff) {
        throw new Error(`u16le value for "${spec.name}" out of range 0..65535: ${value}`);
      }
      buf[spec.byte]     = value & 0xff;
      buf[spec.byte + 1] = (value >>> 8) & 0xff;
      return;
    }
    case 's16le': {
      if (value < -0x8000 || value > 0x7fff) {
        throw new Error(`s16le value for "${spec.name}" out of range -32768..32767: ${value}`);
      }
      const enc = value < 0 ? value + 0x10000 : value;
      buf[spec.byte]     = enc & 0xff;
      buf[spec.byte + 1] = (enc >>> 8) & 0xff;
      return;
    }
    case 'u8': {
      if (value < 0 || value > 0xff) {
        throw new Error(`u8 value for "${spec.name}" out of range 0..255: ${value}`);
      }
      buf[spec.byte] = value & 0xff;
      // Per spec: leave the MSB position untouched. We zero it for
      // determinism on a fresh buffer; for in-place overrides on a
      // device-captured buffer the existing high byte is preserved by
      // not touching it. We pick zeroing — patch-buffer high bytes for
      // u8 fields are documented as 0 in the spec table (no `MSB?`
      // annotations on these entries).
      buf[spec.byte + 1] = 0;
      return;
    }
    case 's8': {
      if (value < -0x80 || value > 0x7f) {
        throw new Error(`s8 value for "${spec.name}" out of range -128..127: ${value}`);
      }
      buf[spec.byte]     = value & 0xff;
      // Sign-extend: 0xFF for negative, 0x00 for non-negative.
      buf[spec.byte + 1] = value < 0 ? 0xff : 0x00;
      return;
    }
  }
}

/** Decode `value` from `buf` at `spec.byte` per `spec.enc`. */
export function readPatchValue(buf: Uint8Array, spec: PatchOffsetSpec): number {
  if (spec.byte < 0 || spec.byte + 1 >= buf.length) {
    throw new Error(`patch offset ${spec.byte} out of bounds for buffer of ${buf.length} bytes`);
  }
  const lo = buf[spec.byte];
  const hi = buf[spec.byte + 1];
  switch (spec.enc) {
    case 'u16le':
      return lo | (hi << 8);
    case 's16le': {
      const v = lo | (hi << 8);
      return v >= 0x8000 ? v - 0x10000 : v;
    }
    case 'u8':
      return lo;
    case 's8':
      return lo >= 0x80 ? lo - 0x100 : lo;
  }
}

// ---------------------------------------------------------------------------
// Patch-level encode / decode.
// ---------------------------------------------------------------------------

export interface EncodePatchOptions {
  /**
   * Base buffer to clone and apply overrides on top of. Must be exactly
   * `PATCH_BUFFER_SIZE` bytes. If omitted, starts from a zero-filled
   * buffer with the four magic bytes at 1766–1769 set to ETCD per spec
   * (an all-zeros buffer would silently fail to write on hardware).
   */
  readonly base?: Uint8Array;
}

/**
 * Apply a sparse map of canonical NRPN-name → value overrides on top
 * of a base patch buffer. Returns a fresh `Uint8Array` of length
 * `PATCH_BUFFER_SIZE`; the input buffer is not mutated.
 *
 * Unknown parameter names throw — callers should pre-validate with
 * `findPatchOffset()` if they want to filter silently. This catches
 * typos and unmapped params loudly so they don't paint themselves
 * silent on hardware.
 */
export function encodePatch(
  overrides: Map<string, number> | ReadonlyMap<string, number>,
  options: EncodePatchOptions = {},
): Uint8Array {
  const base = options.base ?? defaultPatchBuffer();
  if (base.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`base patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${base.length}`);
  }
  const buf = new Uint8Array(base); // clone
  for (const [name, value] of overrides) {
    const spec = PATCH_OFFSETS_BY_NAME.get(name);
    if (!spec) {
      throw new Error(`encodePatch: no patch-buffer offset mapped for "${name}" (extend PATCH_OFFSETS in patchEncoder.ts)`);
    }
    writePatchValue(buf, spec, value);
  }
  return buf;
}

/**
 * Extract the curated subset of params from a patch buffer. Returns a
 * `Map<canonicalName, value>` containing every entry in `PATCH_OFFSETS`.
 *
 * Useful for: round-trip tests, reading a slot via `hydra_request_patch`,
 * comparing two patches.
 */
export function decodePatch(buf: Uint8Array): Map<string, number> {
  if (buf.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${buf.length}`);
  }
  const out = new Map<string, number>();
  for (const spec of PATCH_OFFSETS) {
    out.set(spec.name, readPatchValue(buf, spec));
  }
  return out;
}

/**
 * Return a fresh clone of `INIT_PATCH_BUFFER` — the audible factory
 * INIT patch extracted from ASM Hydrasynth Manager's bundled
 * `Single INIT Bank.hydra` and baked into source via
 * `scripts/hydrasynth/bake-init-patch.ts`.
 *
 * Use as the base buffer for `encodePatch()` when the caller doesn't
 * supply their own — overrides land on top of an audible-by-construction
 * default instead of an all-zeros buffer (which would have bipolar
 * params at their negative extreme = filter slammed shut + silence).
 */
export function defaultPatchBuffer(): Uint8Array {
  return new Uint8Array(INIT_PATCH_BUFFER);
}

// ---------------------------------------------------------------------------
// Patch-name helpers.
// ---------------------------------------------------------------------------

/**
 * Write a patch name into the buffer at bytes 9..24. ASCII only; longer
 * names are truncated to 16 chars; shorter names are zero-padded.
 *
 * Note: byte 8 ("Category") is left untouched — the spec calls out that
 * byte 9 is "Patch Name Start" but that byte 8 uses the same MSB
 * position. Callers writing patch metadata should set Category first.
 */
export function writePatchName(buf: Uint8Array, name: string): void {
  if (buf.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${buf.length}`);
  }
  for (let i = 0; i < PATCH_NAME.maxLength; i++) {
    const c = i < name.length ? name.charCodeAt(i) : 0;
    if (c > 0x7f) {
      throw new Error(`patch name char ${i} ("${name[i]}") is non-ASCII (0x${c.toString(16)})`);
    }
    buf[PATCH_NAME.startByte + i] = c;
  }
}

/** Read a patch name back out of a buffer; trailing zeros are trimmed. */
export function readPatchName(buf: Uint8Array): string {
  if (buf.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${buf.length}`);
  }
  let s = '';
  for (let i = 0; i < PATCH_NAME.maxLength; i++) {
    const c = buf[PATCH_NAME.startByte + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Wire-chunking — slice a 2790-byte patch into 22 device chunks.
// ---------------------------------------------------------------------------

/**
 * A single chunk-dump info payload, ready to be `wrapSysex`'d:
 *   `[0x16, 0x00, CHUNK_INDEX, 0x16, …data…]`
 *
 * Chunks 0..20 carry 128 data bytes; chunk 21 carries 102.
 */
export interface PatchChunk {
  readonly index: number;
  readonly info: Uint8Array;
}

/**
 * Slice a `PATCH_BUFFER_SIZE`-byte patch buffer into the 22 chunks
 * the device expects. Each returned chunk's `info` already includes
 * the 4-byte chunk-dump header `[0x16, 0x00, CHUNK, 0x16]`; pass it
 * straight to `wrapSysex(chunk.info)` to produce the wire bytes.
 */
export function splitIntoChunks(buf: Uint8Array): PatchChunk[] {
  if (buf.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${buf.length}`);
  }
  const chunks: PatchChunk[] = [];
  for (let i = 0; i < PATCH_CHUNK_COUNT; i++) {
    const isLast = i === PATCH_CHUNK_COUNT - 1;
    const size = isLast ? PATCH_LAST_CHUNK_SIZE : PATCH_CHUNK_SIZE;
    const start = i * PATCH_CHUNK_SIZE;
    const data = buf.subarray(start, start + size);
    const info = new Uint8Array(4 + size);
    info[0] = 0x16;
    info[1] = 0x00;
    info[2] = i;
    info[3] = 0x16;
    info.set(data, 4);
    chunks.push({ index: i, info });
  }
  return chunks;
}

/**
 * Concatenate 22 chunk-dump info payloads back into a single
 * `PATCH_BUFFER_SIZE`-byte patch buffer. Inverse of `splitIntoChunks`.
 *
 * Each `chunks[i].info` must start with `[0x16, 0x00, i, 0x16]` and
 * carry the appropriate data length (128 for chunks 0..20, 102 for
 * chunk 21).
 */
export function concatChunks(chunks: ReadonlyArray<PatchChunk>): Uint8Array {
  if (chunks.length !== PATCH_CHUNK_COUNT) {
    throw new Error(`expected ${PATCH_CHUNK_COUNT} chunks, got ${chunks.length}`);
  }
  const out = new Uint8Array(PATCH_BUFFER_SIZE);
  for (let i = 0; i < PATCH_CHUNK_COUNT; i++) {
    const c = chunks[i];
    if (c.index !== i) {
      throw new Error(`chunk ${i} has wrong index ${c.index}`);
    }
    const isLast = i === PATCH_CHUNK_COUNT - 1;
    const expectedSize = isLast ? PATCH_LAST_CHUNK_SIZE : PATCH_CHUNK_SIZE;
    if (c.info.length !== 4 + expectedSize) {
      throw new Error(`chunk ${i} info length ${c.info.length} != expected ${4 + expectedSize}`);
    }
    if (c.info[0] !== 0x16 || c.info[1] !== 0x00 || c.info[2] !== i || c.info[3] !== 0x16) {
      throw new Error(`chunk ${i} has bad header bytes`);
    }
    out.set(c.info.subarray(4), i * PATCH_CHUNK_SIZE);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cross-reference helpers (used by goldens; useful diagnostics surface).
// ---------------------------------------------------------------------------

/**
 * Names in `PATCH_OFFSETS` that are not present in the canonical
 * `HYDRASYNTH_NRPNS` registry. Returns an empty array if the table
 * is consistent. Run from a golden to catch typos at test time.
 */
export function unmappedPatchOffsets(): string[] {
  const known = new Set<string>();
  for (const e of HYDRASYNTH_NRPNS as readonly HydrasynthNrpn[]) {
    known.add(e.name);
  }
  const orphaned: string[] = [];
  for (const spec of PATCH_OFFSETS) {
    if (!known.has(spec.name)) orphaned.push(spec.name);
  }
  return orphaned;
}
