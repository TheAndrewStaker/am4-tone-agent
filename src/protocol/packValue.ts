/**
 * AM4 0x01 SET_PARAM value-field encoding.
 *
 * Reverse-engineered from `FUN_140156d10` (encoder) and `FUN_140156af0`
 * (decoder) in AM4-Edit.exe — see docs/SESSIONS.md session 05.
 *
 * Algorithm: sliding-window 8-to-7 bit-pack. N raw bytes become N+1 wire
 * septets. Each iteration k=1..N takes the top (8-k) bits of the input
 * byte for the current wire position (OR'd with the carry from the
 * previous iteration), and saves the bottom k bits as carry for the next.
 * All wire bytes have bit 7 = 0, satisfying the SysEx wire constraint.
 *
 * Verified round-trip on all 10 captured (param, value) samples — see
 * scripts/verify-pack.ts.
 */

export function packValue(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length + 1);
  let carry = 0;
  for (let i = 0; i < raw.length; i++) {
    const k = i + 1;
    const b = raw[i];
    out[i] = (((b >> k) & 0x7f) | carry) & 0x7f;
    carry = ((~(0x7f << k) & b) << (7 - k)) & 0x7f;
  }
  out[raw.length] = carry;
  return out;
}

export function unpackValue(wire: Uint8Array, rawLen: number): Uint8Array {
  const out = new Uint8Array(rawLen);
  for (let i = 0; i < wire.length; i++) {
    const k = i + 1;
    const b = wire[i] & 0x7f;
    if (i > 0 && i - 1 < rawLen) {
      out[i - 1] |= ((~(0x7f >> k) & b) >> (8 - k)) & 0xff;
    }
    if (i < rawLen) out[i] = (b << k) & 0xff;
  }
  return out;
}

/** Pack a 32-bit IEEE 754 float (little-endian) into 5 wire septets. */
export function packFloat32LE(value: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return packValue(new Uint8Array(buf));
}

/** Inverse of packFloat32LE — decode 5 wire septets back to a float. */
export function unpackFloat32LE(wire: Uint8Array): number {
  if (wire.length !== 5) {
    throw new Error(`unpackFloat32LE: expected 5 wire bytes, got ${wire.length}`);
  }
  const raw = unpackValue(wire, 4);
  return new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0, true);
}
