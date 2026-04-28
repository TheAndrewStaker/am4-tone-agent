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
import { HYDRASYNTH_NRPNS, type HydrasynthNrpn } from './nrpn.js';
import { HYDRASYNTH_ENUMS, resolveHydraEnum } from './enums.js';

/** Lowercase, drop non-alphanumerics — for relaxed matching. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface NrpnSearchHit {
  readonly entry: HydrasynthNrpn;
  /** Ranking score; higher is better. Used internally and not surfaced. */
  readonly score: number;
  /** Which field matched — informs response formatting. */
  readonly matchSource: 'name' | 'alias' | 'notes';
}

/**
 * Split a string at digit→letter and letter→digit boundaries into
 * alternating word / number segments. Used by `looseMatchSegments` to
 * bridge user queries that have the right segments but wrong inter-
 * segment glue: "mod1depth" → ["mod", "1", "depth"] should still
 * structurally match "modmatrix1depth" even though no literal substring
 * of "mod1depth" appears in "modmatrix1depth".
 */
function tokenizeAlphaNum(s: string): string[] {
  return s.match(/\d+|[a-z]+/g) ?? [];
}

/**
 * Returns true when `name` contains every segment of `query` IN ORDER,
 * letting other characters appear between them. Used as a fallback when
 * exact prefix / contains search returns nothing — bridges "mod1depth"
 * → "modmatrix1depth", "ringmod1" → "ringmodsource1", etc.
 */
function looseMatchSegments(query: string, name: string): boolean {
  const segs = tokenizeAlphaNum(query);
  if (segs.length < 2) return false;
  let pos = 0;
  for (const seg of segs) {
    const idx = name.indexOf(seg, pos);
    if (idx < 0) return false;
    pos = idx + seg.length;
  }
  return true;
}

/**
 * Boundary-aware prefix score. When `q` is a prefix of `name`, prefer
 * the case where the next char in `name` is a NON-digit (so "modmatrix1"
 * matches "modmatrix1depth" cleanly but ranks lower for
 * "modmatrix15modsource" because position 10 is '5' — a longer number).
 * Returns the prefix-match base score with a bonus for tighter matches
 * (shorter unmatched-suffix length).
 */
function prefixScore(q: string, name: string, baseStrong: number, baseWeak: number): number {
  if (!name.startsWith(q)) return 0;
  const next = name.charAt(q.length);
  const tightnessBonus = Math.max(0, 8 - (name.length - q.length));
  // No "next" char → exact match (handled separately above) or empty;
  // a non-digit next char is a clean boundary; a digit means q sits in
  // the middle of a longer number, weaker structural match.
  const isBoundary = next === '' || !/\d/.test(next);
  return (isBoundary ? baseStrong : baseWeak) + tightnessBonus;
}

/**
 * Fuzzy-search the NRPN registry by query string. Returns ranked matches
 * across canonical name, aliases, and notes (case- and punctuation-
 * insensitive). Scoring tiers (highest first):
 *
 *   100 — exact name match
 *   95  — exact alias match
 *   90  — name prefix at boundary (modmatrix1 → modmatrix1depth)
 *   85  — alias prefix at boundary
 *   80  — name prefix at digit-mid (modmatrix1 → modmatrix15modsource)
 *   70  — name contains query
 *   65  — alias contains query
 *   50  — loose-segment match (mod1depth → modmatrix1depth)
 *   30  — notes contain query
 *
 * Plus a small tightness bonus (0–8) inside prefix tiers so the closest
 * match by length surfaces first. Used by:
 *   - error paths in `hydra_set_engine_param` / `_params` to suggest
 *     close-by names when a write is rejected;
 *   - the `hydra_param_catalog` tool to answer query-driven discovery.
 */
export function findMatchingNrpns(query: string, limit = 60): NrpnSearchHit[] {
  const q = normalize(query);
  if (!q) return [];
  const hits: NrpnSearchHit[] = [];

  for (const e of HYDRASYNTH_NRPNS) {
    const nameNorm = normalize(e.name);
    let bestScore = 0;
    let source: NrpnSearchHit['matchSource'] = 'name';

    if (nameNorm === q) bestScore = Math.max(bestScore, 100);
    else {
      const ps = prefixScore(q, nameNorm, 90, 80);
      if (ps > bestScore) bestScore = ps;
      if (bestScore < 70 && nameNorm.includes(q)) bestScore = 70;
    }

    if (e.aliases) {
      for (const a of e.aliases) {
        const aNorm = normalize(a);
        if (aNorm === q && bestScore < 95) { bestScore = 95; source = 'alias'; }
        else {
          const ps = prefixScore(q, aNorm, 85, 75);
          if (ps > bestScore) { bestScore = ps; source = 'alias'; }
          if (bestScore < 65 && aNorm.includes(q)) { bestScore = 65; source = 'alias'; }
        }
      }
    }

    // Loose-segment fallback: bridges queries like "mod1depth" →
    // "modmatrix1depth" where the segments are right but the user used
    // a more compact name than the canonical edisyn label. Only kicks
    // in if no stronger match was found, since otherwise it's noise.
    if (bestScore < 50 && looseMatchSegments(q, nameNorm)) {
      bestScore = 50;
      source = 'name';
    }

    // Notes match — lowest priority. Helps when Claude searches by concept
    // ("vowel", "ribbon", "phaser") and the param's notes mention the term
    // even if the canonical name doesn't.
    if (bestScore < 30 && normalize(e.notes).includes(q)) {
      bestScore = 30;
      source = 'notes';
    }

    if (bestScore > 0) hits.push({ entry: e, score: bestScore, matchSource: source });
  }

  hits.sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length);
  return hits.slice(0, limit);
}

/**
 * Format a search hit as a one-line summary suitable for tool responses.
 * Includes canonical name, alias hint, slot index, enum-table linkage, and
 * a truncated note. Single line per hit so a list of 30 stays readable.
 */
export function formatNrpnHit(hit: NrpnSearchHit): string {
  const e = hit.entry;
  const aliasPart = e.aliases && e.aliases.length > 0 ? ` (alias: ${e.aliases[0]})` : '';
  const slotPart = e.dataMsb !== undefined ? ` [slot ${e.dataMsb}]` : '';
  const enumPart = e.enumTable !== undefined ? ` [enum: ${e.enumTable}]` : '';
  const notesShort = e.notes.split('\n')[0]?.slice(0, 60) ?? '';
  const notesPart = notesShort ? ` — ${notesShort}${notesShort.length === 60 ? '…' : ''}` : '';
  return `  ${e.name}${aliasPart}${slotPart}${enumPart}${notesPart}`;
}

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
  if (isFourteenBit && input >= 0 && input <= 128) {
    // Hydrasynth's display goes 0..128, not 0..127. Most engine knobs
    // show `display = wire / 64` (with wireMax=8192 ⇒ display max 128.0).
    // We scale `value × wireMax / 128` so integer inputs land on integer
    // displays — value=55 → wire=3520 → display=55.0 exact, not 55.4.
    // Trade-off: value=127 hits 127.0 display rather than max; pass 128
    // (or any value ≥ 128) to reach the actual max wire value.
    const wire = Math.min(Math.round((input * entry.wireMax!) / 128), entry.wireMax!);
    return { wire, scaled: true };
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
