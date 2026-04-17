/**
 * AM4 preset slot addressing.
 *
 * The AM4 has 104 preset slots named `A01`..`Z04` (26 banks × 4 sub-slots).
 * On the wire they're represented as a 0-based index 0..103:
 *   A01 = 0, A02 = 1, ..., A04 = 3, B01 = 4, ..., Z04 = 103.
 *
 * Users and the MCP surface always speak the letter form; the wire only
 * sees the index.
 */

const BANK_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SLOTS_PER_BANK = 4;
export const TOTAL_SLOTS = BANK_LETTERS.length * SLOTS_PER_BANK;

/** Parse "A01".."Z04" → 0..103 wire index. Throws on bad input. */
export function parseSlotName(slot: string): number {
  const m = /^([A-Za-z])0?(\d)$/.exec(slot.trim());
  if (!m) {
    throw new Error(
      `Slot name must look like "A01".."Z04" (bank A..Z + sub-slot 01..04), got "${slot}".`,
    );
  }
  const bank = m[1].toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
  const sub = parseInt(m[2], 10);
  if (sub < 1 || sub > SLOTS_PER_BANK) {
    throw new Error(`Slot sub-index must be 1..${SLOTS_PER_BANK}, got ${sub} in "${slot}".`);
  }
  return bank * SLOTS_PER_BANK + (sub - 1);
}

/** Inverse: 0..103 → "A01".."Z04". */
export function formatSlotName(slotIndex: number): string {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= TOTAL_SLOTS) {
    throw new Error(`Slot index must be integer 0..${TOTAL_SLOTS - 1}, got ${slotIndex}.`);
  }
  const bank = Math.floor(slotIndex / SLOTS_PER_BANK);
  const sub = (slotIndex % SLOTS_PER_BANK) + 1;
  return `${BANK_LETTERS[bank]}${sub.toString().padStart(2, '0')}`;
}
