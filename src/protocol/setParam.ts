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
import { packFloat32LE } from './packValue.js';
import { KNOWN_PARAMS, encode, type ParamKey } from './params.js';

export const AM4_MODEL_ID = 0x15;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const FUNC_PARAM_RW = 0x01;

const ACTION_WRITE = 0x0001;

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
