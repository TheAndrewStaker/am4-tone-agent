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
 * Predicate for `receiveSysExMatching` that accepts the device's echo of a
 * WRITE we just sent. After a successful write to a *placed* block the AM4
 * emits a SysEx carrying the same pidLow/pidHigh and the `0x0001` action
 * byte pair (typically a 64-byte frame with a 40-byte param descriptor,
 * but we only need the header to match).
 *
 * Writes to a block that isn't placed in the active preset are silently
 * absorbed — no echo arrives, so `receiveSysExMatching` times out and the
 * caller can surface a clear "block not placed" error instead of pretending
 * the write took.
 */
export function isWriteEcho(write: number[], response: number[]): boolean {
  // Minimum viable echo envelope: F0 00 01 74 15 01 + pidLow septets +
  // pidHigh septets + action septets = 12 bytes before any payload/cs/F7.
  if (response.length < 14) return false;
  // Envelope + function byte (bytes 0..5 of the write) must match exactly.
  for (let i = 0; i < 6; i++) if (response[i] !== write[i]) return false;
  // pidLow (bytes 6..7) and pidHigh (bytes 8..9) septets must match.
  for (let i = 6; i < 10; i++) if (response[i] !== write[i]) return false;
  // Action must be WRITE (0x0001) — the 64-byte echo and the 23-byte "short
  // echo" both use this action. 0x0026 is AM4-Edit's status poll, not an echo.
  if (response[10] !== 0x01 || response[11] !== 0x00) return false;
  return true;
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
