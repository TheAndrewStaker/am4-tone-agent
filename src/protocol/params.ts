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
} from './cacheEnums.js';

/**
 * How a parameter's display value relates to the float stored on the
 * wire. The firmware always stores a float; the unit decides the scale.
 *
 *   knob_0_10 — UI 0–10, internal ÷10 (gain-style knobs)
 *   db        — UI dB, internal raw dB
 *   percent   — UI 0–100%, internal ÷100
 *   ms        — UI milliseconds, internal seconds (÷1000)
 *   enum      — UI dropdown name, internal int-as-float (per-param table)
 */
export type Unit = 'knob_0_10' | 'db' | 'percent' | 'ms' | 'enum';

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
  percent: 100,
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
  'delay.type': {
    block: 'delay', name: 'type',
    pidLow: 0x0046, pidHigh: 0x000a,
    // Session 16: enum dictionary imported from cacheEnums.ts (29 models).
    // Untested against capture.
    unit: 'enum', displayMin: 0, displayMax: 28,
    enumValues: DELAY_TYPES_VALUES,
  },
} as const satisfies Record<string, Param>;

export type ParamKey = keyof typeof KNOWN_PARAMS;
