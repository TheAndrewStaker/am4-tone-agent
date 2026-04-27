/**
 * Pure NRPN encoding helpers for the Hydrasynth Explorer.
 *
 * Extracted from `server.ts` so they can be exercised by golden tests
 * (`scripts/hydrasynth/verify-encoding.ts`) without instantiating a
 * MIDI connection. Three concerns live here:
 *
 *   1. **Value resolution** — reconcile user input (number 0..16383,
 *      number 0..127 expecting auto-scale, or enum name string) with
 *      the entry's metadata (multi-slot dataMsb, enum table, sparse-
 *      encoding scale, 14-bit wireMax). Returns the integer the
 *      device should see in the data field.
 *   2. **MIDI byte construction** — build the 4-CC NRPN sequence
 *      (CC 99 / 98 / 6 / 38) per MIDI standard, with the data-MSB
 *      either carrying a slot index (multi-slot params) or the
 *      high 7 bits of a 14-bit value.
 *   3. **Lookup / alias** — already in `nrpn.ts`'s `findHydraNrpn`,
 *      re-exported here for convenience.
 */
import type { HydrasynthNrpn } from './nrpn.js';
import { HYDRASYNTH_ENUMS, resolveHydraEnum } from './enums.js';

export interface ResolvedNrpnValue {
  /** Integer to send in the NRPN data field. */
  readonly wire: number;
  /** True when 7-bit auto-scaling kicked in. Surfaced in tool output for transparency. */
  readonly scaled: boolean;
}

/**
 * Resolve user input to a wire integer.
 *
 *   - String input → enum-table lookup, then apply `enumValueScale`
 *     for sparse-encoded params (FX types use ×8: Bypass=0, Chorus=8,
 *     …, Distortion=72).
 *   - Number ≤ 127 on a 14-bit non-slot non-enum param → auto-scale
 *     to the param's `wireMax` so callers can stay in 0..127 mental
 *     model. Skipped for multi-slot registers (those use the LSB byte
 *     as a 7-bit slot-relative value).
 *   - Otherwise pass through.
 */
export function resolveNrpnValue(entry: HydrasynthNrpn, input: number | string): ResolvedNrpnValue {
  if (typeof input === 'string') {
    if (!entry.enumTable) {
      throw new Error(
        `Parameter "${entry.name}" doesn't accept name strings — pass a numeric value (notes: ${entry.notes}).`,
      );
    }
    const idx = resolveHydraEnum(entry.enumTable, input);
    if (idx === undefined) {
      const table = HYDRASYNTH_ENUMS[entry.enumTable];
      const sample = table ? Object.values(table).slice(0, 6).join(', ') : '';
      throw new Error(
        `Couldn't resolve "${input}" in ${entry.enumTable}. ${sample ? `First few options: ${sample}…` : ''} Call hydra_list_enum_values("${entry.enumTable}") for the full list.`,
      );
    }
    return { wire: idx * (entry.enumValueScale ?? 1), scaled: false };
  }
  const isFourteenBit =
    entry.wireMax !== undefined &&
    entry.wireMax > 127 &&
    entry.dataMsb === undefined &&
    entry.enumTable === undefined;
  if (isFourteenBit && input >= 0 && input <= 127) {
    return { wire: Math.round((input * entry.wireMax!) / 127), scaled: true };
  }
  return { wire: input, scaled: false };
}

/**
 * Build the four 3-byte CC messages that comprise one NRPN write.
 * Order is mandatory per MIDI: address-MSB (CC 99) → address-LSB
 * (CC 98) → data-MSB (CC 6) → data-LSB (CC 38).
 *
 * Returns one array per MIDI message — callers iterate and pass each
 * to `sendMessage()` separately. Bundling all 12 bytes into one call
 * makes node-midi treat the rest as a runt message; only the first CC
 * lands. (See server.ts `sendNrpn` for the runtime.)
 *
 * Two encoding modes for the data:
 *   - Multi-slot (entry.dataMsb defined): data-MSB = slot index,
 *     data-LSB = the 7-bit slot-relative value.
 *   - Plain 14-bit: data-MSB = (value >> 7) & 0x7F, data-LSB = value & 0x7F.
 */
export function nrpnMessagesFor(entry: HydrasynthNrpn, channel: number, value: number): number[][] {
  const status = 0xb0 | ((channel - 1) & 0x0f);
  const dataMsb = entry.dataMsb !== undefined
    ? entry.dataMsb & 0x7f
    : (value >> 7) & 0x7f;
  const dataLsb = value & 0x7f;
  return [
    [status, 99, entry.msb & 0x7f],
    [status, 98, entry.lsb & 0x7f],
    [status, 6, dataMsb],
    [status, 38, dataLsb],
  ];
}
