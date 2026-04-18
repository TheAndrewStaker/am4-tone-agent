/**
 * AM4 0x01 SET_PARAM (write) and READ message builders.
 *
 * Message layout (after envelope F0 00 01 74 15 01):
 *   [hdr0_lo hdr0_hi] [hdr1_lo hdr1_hi] [hdr2_lo hdr2_hi]
 *   [hdr3_lo hdr3_hi] [hdr4_lo hdr4_hi]
 *   [packed_value_bytes...]
 *   [cs] F7
 *
 * Each header field is a 14-bit little-endian integer split into two 7-bit
 * septets. See docs/SYSEX-MAP.md §6a for field meanings.
 */

import { fractalChecksum } from './checksum.js';
import { packFloat32LE, packValue, packValueChunked } from './packValue.js';
import { KNOWN_PARAMS, encode, type ParamKey } from './params.js';

export const AM4_MODEL_ID = 0x15;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const FUNC_PARAM_RW = 0x01;

const ACTION_WRITE = 0x0001;
const ACTION_SAVE_TO_LOCATION = 0x001b;
const ACTION_RENAME = 0x000c;

const PRESET_NAME_BYTES = 32;
const RENAME_PID_LOW = 0x00ce;
const RENAME_PRESET_PID_HIGH = 0x000b;

const SCENE_SWITCH_PID_LOW = 0x00ce;
const SCENE_SWITCH_PID_HIGH = 0x000d;

const PRESET_SWITCH_PID_LOW = 0x00ce;
const PRESET_SWITCH_PID_HIGH = 0x000a;

const SCENE_RENAME_PID_LOW = 0x00ce;
const SCENE_RENAME_PID_HIGH_BASE = 0x0037;
const SCENE_NAME_BYTES = 32;

function encode14(n: number): [number, number] {
  if (n < 0 || n > 0x3fff) throw new Error(`14-bit value out of range: ${n}`);
  return [n & 0x7f, (n >> 7) & 0x7f];
}

/**
 * Identifies a parameter on the AM4. The two halves form a 28-bit ID;
 * AM4-Edit treats them as separate fields in the wire protocol, but we
 * model them as a unit because no use case mixes-and-matches.
 */
export interface ParamId {
  pidLow: number;  // hdr0 — 14-bit
  pidHigh: number; // hdr1 — 14-bit
}

/** Build a 0x01 WRITE message setting `param` to a 32-bit float `value`. */
export function buildSetFloatParam(param: ParamId, value: number): number[] {
  const valueBytes = Array.from(packFloat32LE(value));

  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(param.pidLow),
    ...encode14(param.pidHigh),
    ...encode14(ACTION_WRITE),
    ...encode14(0x0000),       // hdr3 reserved
    ...encode14(valueBytes.length - 1), // hdr4 = raw byte count (= 4 for float32)
    ...valueBytes,
  ];

  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

/**
 * High-level write: look up `key` in the parameter registry, convert
 * `displayValue` to its internal float via the param's unit scale, and
 * build the SET_PARAM message.
 *
 * Example: `buildSetParam('amp.gain', 7.5)` → internal float 0.75.
 */
export function buildSetParam(key: ParamKey, displayValue: number): number[] {
  const param = KNOWN_PARAMS[key];
  return buildSetFloatParam(param, encode(param, displayValue));
}

/**
 * Predicate for `receiveSysExMatching` that accepts the AM4's wire-level
 * acknowledgement of a WRITE we just sent — a 64-byte frame carrying the
 * same pidLow/pidHigh, action `0x0001`, and `hdr4 = 0x0028` (40-byte
 * param descriptor).
 *
 * This matches the shape of the ack but does NOT tell apply from absorb.
 * Session 19 hardware testing proved the AM4 emits this same 64-byte ack
 * for writes to absent blocks (write had no audible effect) as well as
 * for writes to placed blocks (write landed). The 40-byte payload likely
 * contains a discriminator we haven't decoded — future work.
 *
 * A separate 23-byte frame byte-identical to our outgoing write also
 * appears on the input port (USB-MIDI receipt-echo or driver loopback);
 * the `hdr4 = 0x0028` check here filters that receipt-echo out so the
 * predicate matches the genuine device-originated ack.
 */
export function isWriteEcho(write: number[], response: number[]): boolean {
  // Header runs bytes 0..15 (envelope + func + 5 × 14-bit fields).
  if (response.length < 16) return false;
  // Envelope + function byte (bytes 0..5 of the write) must match exactly.
  for (let i = 0; i < 6; i++) if (response[i] !== write[i]) return false;
  // pidLow (bytes 6..7) and pidHigh (bytes 8..9) septets must match.
  for (let i = 6; i < 10; i++) if (response[i] !== write[i]) return false;
  // Action must be WRITE (0x0001) — 0x0026 is AM4-Edit's status poll.
  if (response[10] !== 0x01 || response[11] !== 0x00) return false;
  // hdr4 must be 0x0028 (40-byte param descriptor payload). A 0x0004 here
  // is our own write reflected back (loopback/receipt-echo), not an apply.
  if (response[14] !== 0x28 || response[15] !== 0x00) return false;
  return true;
}

/**
 * Block-placement register: pidLow that addresses the "which block occupies
 * slot N" state. The AM4 exposes 4 slots (positions 1..4 in the signal
 * chain) at pidHigh = 0x000F, 0x0010, 0x0011, 0x0012 respectively. Writing
 * a block's own pidLow as the float32 value places that block in the slot;
 * writing 0 clears the slot to "none" (empty). pidHigh = 0x0013 is NOT a
 * valid slot — the AM4 emits a structurally different ack and may produce
 * side effects on unrelated slots (observed Session 19 hardware test).
 *
 * Decoded Session 19 from Session 18 captures — see SYSEX-MAP.md §6c.
 */
export const BLOCK_SLOT_PID_LOW = 0x00ce;
export const BLOCK_SLOT_PID_HIGH_BASE = 0x000f;

/**
 * Build a WRITE that places `blockTypeValue` into slot `position` (1..4).
 * `blockTypeValue` is the target block's own pidLow (see `blockTypes.ts`);
 * pass 0 to clear the slot.
 *
 * Hardware-mapped Session 19: sending pidHigh 0x10/0x11/0x12 landed on
 * device slots 2/3/4, and pidHigh 0x13 produced an invalid-ack with
 * side effects on an unrelated slot — hence the base 0x000F so that
 * position 1..4 map to pidHigh 0x0F..0x12. Position 1 (pidHigh 0x000F)
 * isn't exercised by any capture on disk, but fits the linear pattern;
 * expected to land on device slot 1, pending independent hardware
 * confirmation after the base-address fix.
 */
export function buildSetBlockType(
  position: 1 | 2 | 3 | 4,
  blockTypeValue: number,
): number[] {
  if (position < 1 || position > 4 || !Number.isInteger(position)) {
    throw new Error(`Block position must be an integer 1..4, got ${position}`);
  }
  return buildSetFloatParam(
    {
      pidLow: BLOCK_SLOT_PID_LOW,
      pidHigh: BLOCK_SLOT_PID_HIGH_BASE + (position - 1),
    },
    blockTypeValue,
  );
}

/**
 * Build a SAVE-TO-LOCATION command that persists the AM4's current working
 * buffer to preset location `locationIndex` (0..103, A01..Z04). The command
 * uses the PARAM_RW function (0x01) with a fresh action byte — 0x001B —
 * which appears only in save captures. pidLow/pidHigh are both 0x0000
 * (not a block/param address; the "target" is the location itself,
 * carried in the payload).
 *
 * Payload = 4-byte uint32 LE location index (Z04 = 103 = 0x67 →
 * `67 00 00 00` raw, `33 40 00 00 00` after the 8-to-7 septet pack).
 *
 * Decoded Session 19 from `session-18-save-preset-z04.pcapng`. Byte-exact
 * golden lives in `verify-msg`.
 *
 * WRITE SAFETY: overwrites the target location. Only Z04 is designated
 * scratch during RE — callers are responsible for gating this.
 */
export function buildSaveToLocation(locationIndex: number): number[] {
  if (!Number.isInteger(locationIndex) || locationIndex < 0 || locationIndex > 103) {
    throw new Error(`Preset location index must be integer 0..103, got ${locationIndex}.`);
  }
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setUint32(0, locationIndex, true);
  const packed = Array.from(packValue(raw));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(0x0000),                   // pidLow = 0 (no block/param — save is a global action)
    ...encode14(0x0000),                   // pidHigh = 0
    ...encode14(ACTION_SAVE_TO_LOCATION),  // action = 0x001B
    ...encode14(0x0000),                   // hdr3
    ...encode14(raw.length),               // hdr4 = 4 (raw byte count, pre-pack)
    ...packed,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Build a RENAME-PRESET command that sets the name of the preset stored
 * at preset location `locationIndex`. Shares the block-slot register
 * (pidLow=0x00CE) but with pidHigh=0x000B and a new action byte
 * (0x000C).
 *
 * Payload is 36 raw bytes:
 *   [0..3]   uint32 LE preset location index (same encoding as
 *            save-to-location)
 *   [4..35]  32-byte ASCII name, space-padded. Names longer than 32
 *            chars throw; shorter names are space-padded to 32.
 *
 * Decoded Session 19 from `session-20-rename-preset.pcapng` — see
 * SYSEX-MAP §6e. Byte-exact golden in `verify-msg`.
 *
 * WRITE SAFETY: like save-to-location, this writes to a specific preset
 * location and can clobber user presets. Callers should gate to Z04
 * during RE.
 */
export function buildSetPresetName(locationIndex: number, name: string): number[] {
  if (!Number.isInteger(locationIndex) || locationIndex < 0 || locationIndex > 103) {
    throw new Error(`Preset location index must be integer 0..103, got ${locationIndex}.`);
  }
  if (name.length > PRESET_NAME_BYTES) {
    throw new Error(`Preset name must be ≤ ${PRESET_NAME_BYTES} ASCII chars, got ${name.length}: "${name}".`);
  }
  // ASCII-only guard — the AM4 displays a limited character set; being
  // strict here surfaces problems early instead of writing unrenderable
  // codepoints to the device.
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`Preset name contains non-ASCII-printable char 0x${c.toString(16)} at position ${i}: "${name}".`);
    }
  }
  const raw = new Uint8Array(4 + PRESET_NAME_BYTES);
  new DataView(raw.buffer).setUint32(0, locationIndex, true);
  // AM4 names are space-padded (0x20), not null-padded. Confirmed by
  // decoding session-20-rename-preset (raw bytes 4+N..35 were all 0x20
  // after the "boston" prefix).
  for (let i = 0; i < PRESET_NAME_BYTES; i++) {
    raw[4 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
  }
  // 36-byte payloads need chunked (7-at-a-time) packing — see packValue.ts
  // comment. Single-chunk packing only works up to 7 raw bytes.
  const packed = Array.from(packValueChunked(raw));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(RENAME_PID_LOW),
    ...encode14(RENAME_PRESET_PID_HIGH),
    ...encode14(ACTION_RENAME),
    ...encode14(0x0000),                // hdr3
    ...encode14(raw.length),            // hdr4 = 36 (raw byte count, pre-pack)
    ...packed,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Build a SWITCH-SCENE command that sets the AM4's active scene to
 * `sceneIndex` (0..3, corresponding to scenes 1..4 in the UI). Same
 * preset-level register family as block placement and preset rename
 * (pidLow=0x00CE), with pidHigh=0x000D and a standard WRITE action.
 * Payload = 4-byte uint32 LE scene index — NOT a float32, to match
 * the integer semantics of save-to-slot.
 *
 * Decoded Session 21 from `session-21-switch-scene-1-3-4.pcapng`
 * (combined with `session-18-switch-scene.pcapng`). All four scene
 * indices confirmed: 0→scene 1, 1→scene 2, 2→scene 3, 3→scene 4.
 * pidHigh stays fixed at 0x000D; only the u32 value changes. Byte-
 * exact goldens for all four scenes live in `verify-msg`.
 */
export function buildSwitchScene(sceneIndex: number): number[] {
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 3) {
    throw new Error(`Scene index must be integer 0..3, got ${sceneIndex}.`);
  }
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setUint32(0, sceneIndex, true);
  const packed = Array.from(packValue(raw));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(SCENE_SWITCH_PID_LOW),
    ...encode14(SCENE_SWITCH_PID_HIGH),
    ...encode14(ACTION_WRITE),
    ...encode14(0x0000),
    ...encode14(raw.length),
    ...packed,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Build a SWITCH-PRESET command that loads preset location
 * `locationIndex` (0..103, A01..Z04) into the AM4's working buffer.
 * Same register family as the other preset-level commands
 * (pidLow=0x00CE) with pidHigh=0x000A and a standard WRITE action.
 *
 * Value encoding: **float32** (IEEE 754 LE) representing the location
 * index — e.g. index 1 → float 1.0 → raw bytes `00 00 80 3f`. This is
 * DIFFERENT from scene-switch (u32 LE) and save-to-slot (u32 LE); both
 * encodings coexist in the same register. Decoded Session 21 from
 * `session-22-switch-preset-via-ui.pcapng`, which captured the user
 * clicking A01 → A02 → A01 in AM4-Edit. Two unique writes: float 1.0
 * (A02) and float 0.0 (A01). Byte-exact goldens in `verify-msg`.
 *
 * UX note: this is "load this preset into the working buffer", not
 * "save to this location." Calling this on an unsaved working buffer
 * discards edits — upstream MCP tool should confirm before issuing.
 */
export function buildSwitchPreset(locationIndex: number): number[] {
  if (!Number.isInteger(locationIndex) || locationIndex < 0 || locationIndex > 103) {
    throw new Error(`Preset location index must be integer 0..103, got ${locationIndex}.`);
  }
  return buildSetFloatParam(
    { pidLow: PRESET_SWITCH_PID_LOW, pidHigh: PRESET_SWITCH_PID_HIGH },
    locationIndex,
  );
}

/**
 * Build a RENAME-SCENE command that sets the name of scene `sceneIndex`
 * (0..3) in the current working buffer. Same envelope / action / payload
 * structure as `buildSetPresetName`, with two differences:
 *   - pidHigh varies per scene: `0x0037 + sceneIndex` (scenes 1..4 →
 *     0x0037 / 0x0038 / 0x0039 / 0x003A).
 *   - The 4-byte slot-index field at the head of the payload is zeroed
 *     — scene names are scoped to the working buffer, not a preset
 *     location.
 *
 * Decoded Session 21 from `session-20-rename-scene.pcapng` (scene 1)
 * plus `session-22-rename-scene-{2,3,4}.pcapng` (scenes 2/3/4).
 * Byte-exact goldens in `verify-msg` for scenes 2/3/4 with names
 * "clean" / "chorus" / "lead"; scene 1 was the initial Session 19g
 * capture confirming pidHigh=0x0037.
 *
 * Scope caveat: writes to the working buffer only. To persist scene
 * names to a preset location, callers must still issue a
 * `buildSaveToLocation` afterward.
 */
export function buildSetSceneName(sceneIndex: number, name: string): number[] {
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 3) {
    throw new Error(`Scene index must be integer 0..3, got ${sceneIndex}.`);
  }
  if (name.length > SCENE_NAME_BYTES) {
    throw new Error(`Scene name must be ≤ ${SCENE_NAME_BYTES} ASCII chars, got ${name.length}: "${name}".`);
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`Scene name contains non-ASCII-printable char 0x${c.toString(16)} at position ${i}: "${name}".`);
    }
  }
  const raw = new Uint8Array(4 + SCENE_NAME_BYTES);
  // Bytes 0..3 stay zero (working-buffer scope, no slot index).
  for (let i = 0; i < SCENE_NAME_BYTES; i++) {
    raw[4 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
  }
  const packed = Array.from(packValueChunked(raw));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(SCENE_RENAME_PID_LOW),
    ...encode14(SCENE_RENAME_PID_HIGH_BASE + sceneIndex),
    ...encode14(ACTION_RENAME),
    ...encode14(0x0000),
    ...encode14(raw.length),
    ...packed,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Build a 0x01 READ request for `param`. `readType` selects the response
 * shape — see docs/SYSEX-MAP.md §6a (use 0x0E for short parameter reads).
 */
export function buildReadParam(param: ParamId, readType = 0x0e): number[] {
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(param.pidLow),
    ...encode14(param.pidHigh),
    ...encode14(readType),
    ...encode14(0x0000),
    ...encode14(0x0000), // hdr4 = 0 (no payload on a read)
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}
