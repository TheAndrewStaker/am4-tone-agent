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
  'drive.drive': {
    block: 'drive', name: 'drive',
    pidLow: 0x0076, pidHigh: 0x000b,
    unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  },
  'drive.type': {
    block: 'drive', name: 'type',
    pidLow: 0x0076, pidHigh: 0x000a,
    unit: 'enum', displayMin: 0, displayMax: 0,
    // Only TS808 confirmed (Session 06). Capture per type to fill out.
    enumValues: { 8: 'TS808' },
  },
  'reverb.mix': {
    block: 'reverb', name: 'mix',
    pidLow: 0x0042, pidHigh: 0x0001,
    unit: 'percent', displayMin: 0, displayMax: 100,
  },
  'delay.time': {
    block: 'delay', name: 'time',
    pidLow: 0x0046, pidHigh: 0x000c,
    unit: 'ms', displayMin: 0, displayMax: 5000,
  },
} as const satisfies Record<string, Param>;

export type ParamKey = keyof typeof KNOWN_PARAMS;
