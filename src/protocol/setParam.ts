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

export const KNOWN_PARAMS = {
  AMP_GAIN_PRESET_A01: { pidLow: 0x003a, pidHigh: 0x000b } as ParamId,
} as const;

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
