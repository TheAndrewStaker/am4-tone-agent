#!/usr/bin/env node
/**
 * Hydrasynth Explorer — MCP server (stdio).
 *
 * Side-branch exploratory work — see CLAUDE.md and
 * `memory/feedback_am4_depth_gates_wave_expansion.md`. This server
 * is meant to run alongside the AM4 server in Claude Desktop, not
 * replace it.
 *
 * M1 tool surface (output-only — the MIDI input listener for
 * bidirectional Macro triggers is M5):
 *
 *   - hydra_set_param      write any of the 117 charted CC params by id
 *   - hydra_set_macro      shorthand for Macros 1-8 (CCs 16-23)
 *   - hydra_switch_patch   bank-select MSB/LSB + Program Change
 *   - hydra_play_note      Note On + (after duration) Note Off
 *   - hydra_list_params    describe the param catalog Claude can call
 *
 * MIDI is opened lazily on the first tool call so the server can
 * register with Claude Desktop even if the Hydrasynth is unplugged.
 *
 * Run standalone for a sanity check:
 *   npx tsx src/devices/hydrasynth-explorer/server.ts
 *
 * Claude Desktop wiring — add to %APPDATA%\Claude\claude_desktop_config.json:
 *
 *   "hydrasynth": {
 *     "command": "npx",
 *     "args": ["tsx", "C:\\\\dev\\\\am4-tone-agent\\\\src\\\\devices\\\\hydrasynth-explorer\\\\server.ts"],
 *     "env": {}
 *   }
 *
 * Important: CCs 0/1/7/11/32/64/123 (the "system" category in
 * params.ts) work whether the device's Param TX/RX is set to CC,
 * NRPN, or Off. The other 110 CCs require Param TX/RX = CC on the
 * device's MIDI page 10 — otherwise the device receives the bytes
 * but doesn't act on them.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import {
  HYDRASYNTH_PARAMS,
  HYDRASYNTH_PARAMS_BY_CC,
  HYDRASYNTH_PARAMS_BY_ID,
} from './params.js';
import { HYDRASYNTH_NRPNS, findHydraNrpn, type HydrasynthNrpn } from './nrpn.js';
import { HYDRASYNTH_ENUMS, resolveHydraEnum } from './enums.js';
import {
  connectHydrasynth,
  listHydrasynthOutputs,
  type HydrasynthConnection,
} from './midi.js';

// -- MIDI lazy-init -------------------------------------------------------

let midi: HydrasynthConnection | undefined;
let midiError: Error | undefined;

function ensureMidi(): HydrasynthConnection {
  if (midi) return midi;
  if (midiError) throw midiError;
  try {
    midi = connectHydrasynth();
    return midi;
  } catch (err) {
    midiError = err instanceof Error ? err : new Error(String(err));
    throw midiError;
  }
}

// -- MIDI-byte helpers ----------------------------------------------------

const DEFAULT_CHANNEL = 1;

function ccBytes(channel: number, cc: number, value: number): number[] {
  const status = 0xB0 | ((channel - 1) & 0x0F);
  return [status, cc & 0x7F, value & 0x7F];
}

/**
 * Send the 4-CC NRPN write sequence the Hydrasynth listens for.
 * Order is mandatory: address-MSB → address-LSB → data-MSB → data-LSB.
 *
 * Two value-encoding modes:
 *   1. Plain 14-bit (most NRPN params): user value 0..16383 splits into
 *      data-MSB = (value >> 7) and data-LSB = value & 0x7F. Used for
 *      cent fine-tunes, wavescan position, mod-matrix amounts, etc.
 *   2. Multi-slot (osc1/2/3, mutator1..4, ringmod1/2 etc.): the slot
 *      index lives in the data-MSB byte, the value lives in data-LSB.
 *      Without this, every osc2/osc3 write secretly hits osc1 because
 *      the family shares one NRPN address. The slot index is baked
 *      into the registry's `dataMsb` field at gen time.
 *
 * Each CC must be sent as its own `sendMessage()` call — node-midi's
 * `sendMessage` expects a single MIDI message per invocation. Bundling
 * all 12 bytes into one call made the device receive the first 3 bytes
 * as a CC and ignore the rest as a runt message — only the NRPN
 * address-MSB landed.
 */
/**
 * Resolve a user-supplied value (number or display name) for an NRPN
 * entry to the integer the device expects on the wire.
 *
 * Three resolution paths:
 *   1. String input → enum-table lookup (filter1type="Vowel" → 10).
 *      Applies any per-param sparse-encoding scale (FX types ×8).
 *   2. Numeric input on a 14-bit param with value ≤ 127 → auto-scale
 *      from 7-bit-style 0..127 onto the param's wireMax range. Lets
 *      callers stay in the familiar 0..127 mental model — sending
 *      "decay=127" puts a 14-bit register near max instead of at
 *      ~1.5% of max. Skipped when the param is a multi-slot register
 *      (dataMsb defined) since those use the LSB byte as a slot-
 *      relative 7-bit value with its own range.
 *   3. Numeric input above 127 OR small wireMax → pass through.
 *
 * Returns the value to feed into sendNrpn (which will further encode
 * data-MSB / data-LSB based on the entry's dataMsb).
 */
function resolveNrpnValue(entry: HydrasynthNrpn, input: number | string): { wire: number; scaled: boolean } {
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
  // Numeric input. Auto-scale 7-bit-style values onto the entry's
  // 14-bit register when relevant — only for non-slot, non-enum
  // params with a known wireMax > 127.
  const isFourteenBit =
    entry.wireMax !== undefined &&
    entry.wireMax > 127 &&
    entry.dataMsb === undefined &&
    entry.enumTable === undefined;
  if (isFourteenBit && input >= 0 && input <= 127) {
    const scaled = Math.round((input * entry.wireMax!) / 127);
    return { wire: scaled, scaled: true };
  }
  return { wire: input, scaled: false };
}

function sendNrpn(conn: HydrasynthConnection, channel: number, entry: HydrasynthNrpn, value: number): void {
  const dataMsb = entry.dataMsb !== undefined
    ? entry.dataMsb & 0x7F
    : (value >> 7) & 0x7F;
  const dataLsb = entry.dataMsb !== undefined
    ? value & 0x7F
    : value & 0x7F;
  conn.send(ccBytes(channel, 99, entry.msb));  // CC 99 — NRPN address MSB
  conn.send(ccBytes(channel, 98, entry.lsb));  // CC 98 — NRPN address LSB
  conn.send(ccBytes(channel, 6, dataMsb));     // CC  6 — Data Entry MSB
  conn.send(ccBytes(channel, 38, dataLsb));    // CC 38 — Data Entry LSB
}

function noteOnBytes(channel: number, note: number, velocity: number): number[] {
  const status = 0x90 | ((channel - 1) & 0x0F);
  return [status, note & 0x7F, velocity & 0x7F];
}

function noteOffBytes(channel: number, note: number): number[] {
  const status = 0x80 | ((channel - 1) & 0x0F);
  return [status, note & 0x7F, 0x00];
}

function programChangeBytes(channel: number, program: number): number[] {
  const status = 0xC0 | ((channel - 1) & 0x0F);
  return [status, program & 0x7F];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -- Note-name parser -----------------------------------------------------

const SEMITONE_BY_LETTER: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/**
 * Accept either a raw MIDI note number (60) or a scientific pitch
 * notation string ("C4", "F#3", "Bb-1"). Returns the 0..127 note.
 *
 * Octave numbering: middle C = C4 = 60 (the Yamaha convention used
 * by the Hydrasynth manual and most modern DAWs).
 */
function parseNote(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0 || input > 127) {
      throw new Error(`Note number out of range 0..127: ${input}`);
    }
    return Math.round(input);
  }
  const m = input.trim().match(/^([A-G])([#b]?)(-?\d+)$/i);
  if (!m) {
    throw new Error(
      `Cannot parse note "${input}". Expected a number 0..127 or a name like "C4", "F#3", "Bb-1".`,
    );
  }
  const semitone = SEMITONE_BY_LETTER[m[1]!.toUpperCase()]!;
  const accidental = m[2] === '#' ? 1 : m[2]?.toLowerCase() === 'b' ? -1 : 0;
  const octave = Number.parseInt(m[3]!, 10);
  const note = (octave + 1) * 12 + semitone + accidental;
  if (note < 0 || note > 127) {
    throw new Error(`Note "${input}" resolves to ${note}, outside MIDI range 0..127.`);
  }
  return note;
}

// -- Bank parser ----------------------------------------------------------

/** Accept "A".."H" (case-insensitive) or 0..7. Returns 0..7. */
function parseBank(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 7) {
      throw new Error(`Bank index out of range 0..7: ${input}`);
    }
    return input;
  }
  const letter = input.trim().toUpperCase();
  if (!/^[A-H]$/.test(letter)) {
    throw new Error(`Bank "${input}" must be a letter A..H or a number 0..7.`);
  }
  return letter.charCodeAt(0) - 'A'.charCodeAt(0);
}

// -- Server ---------------------------------------------------------------

const server = new McpServer({
  name: 'hydrasynth-explorer-mcp',
  version: '0.1.0',
});

// hydra_set_param --------------------------------------------------------

server.registerTool('hydra_set_param', {
  description: [
    'Use this tool to set a SYSTEM CC on the user\'s ASM Hydrasynth Explorer — these are',
    'the always-on MIDI controls that work regardless of the device\'s Param TX/RX setting:',
    'Master Volume (system.master_volume), Modulation Wheel (system.modulation_wheel),',
    'Sustain Pedal (system.sustain_pedal), Expression Pedal (system.expression_pedal),',
    'Bank Select MSB/LSB (system.bank_select_msb / .bank_select_lsb), All Notes Off',
    '(system.all_notes_off). 7 parameters total.',
    '',
    'For ANY OTHER engine parameter (oscillators, filters, envelopes, mixer, FX, etc.)',
    'use hydra_set_engine_param (single) or hydra_set_engine_params (batch) — those use',
    'NRPN, which is the device\'s standard mode for engine control and covers 1175',
    'parameters including the wave/filter/FX type selectors that aren\'t on CCs at all.',
    '',
    'Do not produce a written spec instead of calling this tool unless the user explicitly',
    'asks for a dry run.',
    '',
    'Values are 0..127 (raw MIDI CC range). No wire-ack is expected.',
  ].join('\n'),
  inputSchema: {
    id: z.string().describe(
      'System parameter id — one of: system.master_volume, system.modulation_wheel, system.sustain_pedal, system.expression_pedal, system.bank_select_msb, system.bank_select_lsb, system.all_notes_off.',
    ),
    value: z.number().int().min(0).max(127).describe(
      'Raw MIDI CC value 0..127.',
    ),
  },
}, async ({ id, value }) => {
  const param = HYDRASYNTH_PARAMS_BY_ID.get(id);
  if (!param) {
    const suggestions = HYDRASYNTH_PARAMS
      .filter((p) => p.category === 'system')
      .map((p) => p.id);
    throw new Error(
      `Unknown parameter id "${id}". hydra_set_param only handles System CCs. Available ids: ${suggestions.join(', ')}. For engine parameters use hydra_set_engine_param.`,
    );
  }
  if (param.category !== 'system') {
    throw new Error(
      `"${id}" is an engine parameter, not a System CC. Use hydra_set_engine_param("${id.replace('.', '')}", value) instead — it sends NRPN, which is what the device listens on for engine control. (Call hydra_list_params with category="nrpn" for the NRPN parameter catalog.)`,
    );
  }
  const conn = ensureMidi();
  conn.send(ccBytes(DEFAULT_CHANNEL, param.cc, value));
  return {
    content: [{
      type: 'text',
      text: `Sent CC ${param.cc} = ${value} (${param.module} → ${param.parameter}). System CC — always responds.`,
    }],
  };
});

// hydra_set_macro --------------------------------------------------------

server.registerTool('hydra_set_macro', {
  description: [
    'Use this tool to set one of the user\'s Macro controls on the Hydrasynth Explorer.',
    'Macros 1-8 are patch-defined: each loaded patch wires its 8 Macros to whatever',
    'synthesis parameters the patch designer chose, via the mod matrix. So "Macro 1"',
    'might be filter sweep on one patch and reverb mix on another — there\'s no fixed',
    'mapping. Macros are an excellent first lever for tone tweaks because they\'re',
    'curated by the patch designer to be musically useful for that patch.',
    '',
    'Macros are CCs 16-23 internally. Like other engine CCs they require Param TX/RX = CC',
    'on the device.',
  ].join('\n'),
  inputSchema: {
    macro: z.number().int().min(1).max(8).describe('Macro number 1..8 (1-indexed, matching the device\'s display).'),
    value: z.number().int().min(0).max(127).describe('Macro value 0..127.'),
  },
}, async ({ macro, value }) => {
  const cc = 15 + macro; // Macro 1 = CC 16, Macro 8 = CC 23
  const conn = ensureMidi();
  conn.send(ccBytes(DEFAULT_CHANNEL, cc, value));
  return {
    content: [{
      type: 'text',
      text: `Sent Macro ${macro} = ${value} (CC ${cc}). The audible effect depends on the currently-loaded patch's mod matrix routing.`,
    }],
  };
});

// hydra_switch_patch -----------------------------------------------------

server.registerTool('hydra_switch_patch', {
  description: [
    'Use this tool to switch the Hydrasynth Explorer to a specific stored patch.',
    'The Explorer holds 8 banks (A-H) × 128 patches each = 1024 total slots.',
    'Bank Select MSB is fixed at 0 on the Explorer; LSB picks the bank.',
    '',
    'IMPORTANT — DEVICE PRECONDITION: this only works if "Pgm Chg RX" is set to On',
    'on MIDI: Page 11 of System Setup (it is by default). If patch switching has',
    'no effect, that\'s the first thing to check.',
    '',
    'The tool sends Bank Select MSB (0) → Bank Select LSB (bank) → Program Change',
    'in that order, which is what the manual specifies (page 83). Program Change',
    'alone will only switch within the current bank.',
  ].join('\n'),
  inputSchema: {
    bank: z.union([z.string(), z.number()]).describe('Bank A..H (letter, case-insensitive) or 0..7.'),
    program: z.number().int().min(0).max(127).describe('Patch number within the bank (0..127). Note: device displays patches 1..128, so subtract 1.'),
  },
}, async ({ bank, program }) => {
  const bankIdx = parseBank(bank);
  const conn = ensureMidi();
  // Order matters per manual p. 83: MSB, then LSB, then PC.
  conn.send(ccBytes(DEFAULT_CHANNEL, 0, 0));        // Bank MSB = 0 (Explorer always)
  conn.send(ccBytes(DEFAULT_CHANNEL, 32, bankIdx)); // Bank LSB = 0..7
  conn.send(programChangeBytes(DEFAULT_CHANNEL, program));
  const bankLetter = String.fromCharCode('A'.charCodeAt(0) + bankIdx);
  return {
    content: [{
      type: 'text',
      text: `Switched to bank ${bankLetter} (LSB=${bankIdx}), program ${program} (display: ${program + 1}). Sent Bank MSB=0, Bank LSB=${bankIdx}, PC=${program}.`,
    }],
  };
});

// hydra_play_note --------------------------------------------------------

server.registerTool('hydra_play_note', {
  description: [
    'Use this tool to audition the current Hydrasynth patch by playing a note for a',
    'specified duration. Useful after editing parameters to hear the result without',
    'asking the user to play a key. Sends Note On, waits, sends Note Off.',
    '',
    'Notes can be specified as MIDI numbers (0..127, where 60 = middle C) or as',
    'scientific pitch names ("C4", "F#3", "Bb5"). C4 = 60 in the Yamaha convention',
    'used by the Hydrasynth manual.',
  ].join('\n'),
  inputSchema: {
    note: z.union([z.string(), z.number()]).describe('Note as MIDI number (0..127) or pitch name ("C4", "F#3", "Bb-1"). Middle C = C4 = 60.'),
    velocity: z.number().int().min(1).max(127).default(96).describe('Note velocity 1..127. Default 96 (mezzo-forte).'),
    duration_ms: z.number().int().min(50).max(5000).default(800).describe('How long to hold the note before releasing, in milliseconds. Capped at 5000 ms to prevent runaway.'),
  },
}, async ({ note, velocity, duration_ms }) => {
  const noteNum = parseNote(note);
  const conn = ensureMidi();
  conn.send(noteOnBytes(DEFAULT_CHANNEL, noteNum, velocity));
  await sleep(duration_ms);
  conn.send(noteOffBytes(DEFAULT_CHANNEL, noteNum));
  return {
    content: [{
      type: 'text',
      text: `Played note ${noteNum} at velocity ${velocity} for ${duration_ms} ms. Note Off sent.`,
    }],
  };
});

// hydra_set_engine_param -------------------------------------------------

server.registerTool('hydra_set_engine_param', {
  description: [
    'Use this tool to set ANY synthesis-engine parameter on the user\'s Hydrasynth',
    'Explorer via NRPN — 1175 named parameters covering oscillators, mixer, both',
    'filters, every envelope and LFO, mod matrix, mutators, and Pre-FX/Post-FX type',
    '(things the manual\'s 117 CCs don\'t reach). The NRPN map is reverse-engineered',
    'against device by eclab/edisyn (Apache-2.0).',
    '',
    'Do not produce a written spec instead of calling this tool unless the user',
    'explicitly asks for a dry run. **For multi-parameter patch builds, use',
    'hydra_set_engine_params (batch) — one tool call instead of N.**',
    '',
    'NAME RESOLUTION — the tool accepts EITHER naming convention:',
    '  - CC-catalog style (dot-separated): "mixer.osc1_vol", "filter1.cutoff",',
    '    "filter1.res", "env1.attack", "env1.sustain". This matches what',
    '    hydra_list_params returns.',
    '  - edisyn canonical style (concatenated): "mixerosc1vol", "filter1cutoff",',
    '    "filter1resonance", "env1attacksyncoff", "env1sustain".',
    '  - Both forms resolve to the same NRPN entry; pick whichever feels natural.',
    '',
    'VALUE — accepts a number 0..16383 OR an enum name string:',
    '  1. Numbers 0..127 are the easiest mental model. The tool AUTO-SCALES them to',
    '     the param\'s native range (most engine knobs are 14-bit, 0..8192). So',
    '     value=127 hits maximum on a 14-bit param, value=64 hits the middle, etc.',
    '     Pass 128..16383 to bypass auto-scale and write a raw 14-bit value.',
    '  2. Enum-typed params (osc1type, osc2type, osc3type, filter1type, filter2type,',
    '     prefxtype, postfxtype, mutator1mode..4mode, mutator{N}sourcefmlin /',
    '     sourceoscsync, env1trigsrc1..3, etc.) accept a display name string —',
    '     filter1type="Vowel", prefxtype="Lo-Fi", osc1type="Sine". Sparse encodings',
    '     (Pre-FX/Post-FX use index×8) are handled automatically.',
    '',
    'EXAMPLES (Tom Petty Breakdown organ recipe):',
    '  hydra_set_engine_param("osc1type", "Sine")',
    '  hydra_set_engine_param("osc2type", "Sine")',
    '  hydra_set_engine_param("osc2semi", 12)              // +1 octave',
    '  hydra_set_engine_param("mixer.osc1_vol", 100)       // auto-scaled, hits ~6300/8192',
    '  hydra_set_engine_param("mixer.osc2_vol", 55)        // auto-scaled',
    '  hydra_set_engine_param("filter1type", "LP Ladder 12")',
    '  hydra_set_engine_param("filter1.cutoff", 60)        // auto-scaled to wire 3870 = display ~60',
    '  hydra_set_engine_param("env1.attack", 0)            // instant attack',
    '  hydra_set_engine_param("env1.decay", 127)           // ~max decay',
    '  hydra_set_engine_param("env1.sustain", 127)         // ~max sustain',
    '  hydra_set_engine_param("env1.release", 65)          // medium release',
    '  hydra_set_engine_param("prefxtype", "Lo-Fi")',
    '  hydra_set_engine_param("postfxtype", "Rotary")',
    '',
    'Multi-slot disambiguation (osc1/2/3, mutator1..4) is handled automatically —',
    'osc2semi targets oscillator 2 even though osc1semi/osc2semi/osc3semi share an',
    'NRPN address. No need to compute the slot byte yourself.',
    '',
    'IMPORTANT — DEVICE PRECONDITION: NRPN writes only respond when the device\'s',
    'Param TX/RX setting is NRPN (System Setup → MIDI page 10). With Param TX/RX = CC,',
    'the device receives the bytes but ignores them. If writes seem inert, that\'s',
    'the first thing to check.',
    '',
    'No wire-ack is expected — consumer MIDI synths don\'t echo NRPN. Confirmation',
    'is audible / observable on the device only.',
  ].join('\n'),
  inputSchema: {
    name: z.string().describe(
      'Canonical NRPN parameter name (e.g. "filter1type", "osc1semi", "prefxtype", "env1attacksyncoff"). Call hydra_list_params with category="nrpn" for the full catalog.',
    ),
    value: z.union([z.number(), z.string()]).describe(
      'Numeric value (0..16383) OR — for enum-typed params — the display name as a string. Examples: filter1type=10 or filter1type="Vowel"; prefxtype=40 or prefxtype="Lo-Fi"; osc1type=0 or osc1type="Sine". Most non-enum params use only 0..127 (the low 7 bits); osc cents / wavescan / mod-matrix amount use the full 14-bit range. The tool response includes the parameter\'s notes for per-param ranges and signedness.',
    ),
  },
}, async ({ name, value }) => {
  const entry = findHydraNrpn(name);
  if (!entry) {
    const suggestions = HYDRASYNTH_NRPNS
      .map((e) => e.name)
      .filter((n) => n.includes(name) || name.includes(n.slice(0, 3)))
      .slice(0, 8);
    throw new Error(
      `Unknown NRPN parameter "${name}". ${suggestions.length > 0 ? `Closest matches: ${suggestions.join(', ')}.` : 'Call hydra_list_params with category="nrpn" for the full catalog.'}`,
    );
  }
  const { wire: resolvedValue, scaled } = resolveNrpnValue(entry, value);
  const conn = ensureMidi();
  sendNrpn(conn, DEFAULT_CHANNEL, entry, resolvedValue);
  const ccLine = entry.cc !== undefined
    ? ` (also on CC ${entry.cc} for 7-bit access.)`
    : '';
  let inputDisplay: string;
  if (typeof value === 'string') {
    inputDisplay = `"${value}" (resolved to ${resolvedValue})`;
  } else if (scaled) {
    inputDisplay = `${value} → wire ${resolvedValue} (auto-scaled 0..127 → 0..${entry.wireMax})`;
  } else {
    inputDisplay = `${resolvedValue}`;
  }
  const noteLine = entry.notes ? `\nRange/encoding: ${entry.notes}` : '';
  return {
    content: [{
      type: 'text',
      text: `Sent NRPN MSB=0x${entry.msb.toString(16).padStart(2, '0')} LSB=0x${entry.lsb.toString(16).padStart(2, '0')} value=${inputDisplay} (${name}).${ccLine} Reminder: requires Param TX/RX = NRPN on the device.${noteLine}`,
    }],
  };
});

// hydra_set_engine_params (batch) ----------------------------------------

server.registerTool('hydra_set_engine_params', {
  description: [
    'Use this tool to set MANY Hydrasynth Explorer synthesis parameters in ONE call.',
    '**This is the preferred tool for any multi-knob change** (whole-patch builds,',
    'multi-section tweaks, recipe-style requests). One tool call instead of N',
    'individual hydra_set_engine_param calls — Claude Desktop traverses much faster,',
    'and the server paces NRPN writes (≥2 ms between sequences per edisyn) so the',
    'device doesn\'t drop messages.',
    '',
    'Do not produce a written spec instead of calling this tool unless the user',
    'explicitly asks for a dry run.',
    '',
    'Each entry in `params` is a {name, value} pair with the SAME semantics as',
    'hydra_set_engine_param:',
    '  - `name` accepts CC-catalog style ("mixer.osc1_vol", "filter1.cutoff",',
    '    "env1.attack") OR edisyn canonical style ("mixerosc1vol", "filter1cutoff",',
    '    "env1attacksyncoff"). Both resolve to the same NRPN.',
    '  - `value` accepts numbers 0..127 (auto-scaled to 14-bit native range — hits',
    '    full-scale on most engine params at 127) or 128..16383 (raw wire) or enum',
    '    name strings for type-typed params (filter1type="Vowel", prefxtype="Lo-Fi",',
    '    osc1type="Sine").',
    '  - Multi-slot params (osc2semi, mutator3mode, etc.) auto-disambiguate by name.',
    '',
    'EXAMPLE — Tom Petty Breakdown organ patch in one call:',
    '  hydra_set_engine_params({ params: [',
    '    { name: "osc1type", value: "Sine" },',
    '    { name: "osc2type", value: "Sine" },',
    '    { name: "osc1semi", value: 0 },',
    '    { name: "osc2semi", value: 12 },',
    '    { name: "filter1type", value: "LP Ladder 12" },',
    '    { name: "prefxtype", value: "Lo-Fi" },',
    '    { name: "postfxtype", value: "Rotary" },',
    '    { name: "mixer.osc1_vol", value: 100 },',
    '    { name: "mixer.osc2_vol", value: 55 },',
    '    { name: "filter1.cutoff", value: 60 },',
    '    { name: "filter1.res", value: 15 },',
    '    { name: "env1.attack", value: 0 },',
    '    { name: "env1.decay", value: 127 },',
    '    { name: "env1.sustain", value: 127 },',
    '    { name: "env1.release", value: 65 },',
    '  ]})',
    '',
    'ORDERING — per edisyn, structure the list so type-changing writes go first',
    '(modes, types, LFO waveforms, BPM-sync flags, wavescan waves) followed by',
    'continuous-value writes (cutoffs, envelopes, mixer, macros). The device needs',
    'time to reconfigure routing before downstream values land. The tool does not',
    'reorder for you.',
    '',
    'IMPORTANT — DEVICE PRECONDITION: Param TX/RX must be NRPN on System Setup →',
    'MIDI page 10. With Param TX/RX = CC, every write in the batch is silently',
    'ignored. If results look like nothing happened, check that setting first.',
  ].join('\n'),
  inputSchema: {
    params: z.array(z.object({
      name: z.string().describe('Canonical NRPN parameter name (e.g. "filter1type", "osc2semi", "env1attacksyncoff").'),
      value: z.union([z.number(), z.string()]).describe('Numeric value (0..16383) OR enum display name (e.g. "Vowel", "Lo-Fi", "Sine"). Most non-enum params use only 0..127.'),
    }))
      .min(1)
      .max(200)
      .describe('Ordered list of NRPN writes to send. The server sends each as a 4-CC sequence with ~3 ms between sequences for pacing.'),
  },
}, async ({ params }) => {
  const conn = ensureMidi();
  const errors: string[] = [];
  const sent: { name: string; raw: number | string; resolved: number; resolvedDataMsb?: number; scaled: boolean; wireMax?: number }[] = [];
  for (let i = 0; i < params.length; i++) {
    const { name, value } = params[i]!;
    const entry = findHydraNrpn(name);
    if (!entry) {
      const suggestions = HYDRASYNTH_NRPNS
        .map((e) => e.name)
        .filter((n) => n.includes(name) || name.includes(n.slice(0, 3)))
        .slice(0, 4);
      errors.push(`[${i}] "${name}" — unknown${suggestions.length > 0 ? ` (closest: ${suggestions.join(', ')})` : ''}`);
      continue;
    }
    let resolved: number;
    let scaled = false;
    try {
      const r = resolveNrpnValue(entry, value);
      resolved = r.wire;
      scaled = r.scaled;
    } catch (err) {
      errors.push(`[${i}] "${name}" — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    sendNrpn(conn, DEFAULT_CHANNEL, entry, resolved);
    sent.push({ name, raw: value, resolved, resolvedDataMsb: entry.dataMsb, scaled, wireMax: entry.wireMax });
    // Pace ≥2 ms between NRPN sequences (edisyn note); 3 ms gives margin.
    if (i < params.length - 1) await sleep(3);
  }
  const lines = sent.map((s) => {
    const slotNote = s.resolvedDataMsb !== undefined ? ` [slot ${s.resolvedDataMsb}]` : '';
    let valueNote: string;
    if (typeof s.raw === 'string') {
      valueNote = `"${s.raw}" (${s.resolved})`;
    } else if (s.scaled) {
      valueNote = `${s.raw} → ${s.resolved} (scaled to wireMax ${s.wireMax})`;
    } else {
      valueNote = `${s.resolved}`;
    }
    return `  ${s.name} = ${valueNote}${slotNote}`;
  });
  const errorBlock = errors.length > 0
    ? `\n\nErrors (${errors.length}):\n${errors.map((e) => `  ${e}`).join('\n')}`
    : '';
  return {
    content: [{
      type: 'text',
      text: `Sent ${sent.length} NRPN write(s) with ~3 ms pacing:\n${lines.join('\n')}${errorBlock}\n\nReminder: requires Param TX/RX = NRPN on the device.`,
    }],
  };
});

// hydra_list_enum_values --------------------------------------------------

server.registerTool('hydra_list_enum_values', {
  description: [
    'Use this tool to inspect the named lookup tables backing the Hydrasynth\'s',
    'enum-typed parameters — wave names (OSC_WAVES, 219 entries), filter types',
    '(FILTER_1_TYPES = 16, FILTER_2_TYPES = 2), FX types (FX_TYPES = 10), mutant',
    'modes, ARP modes, vibrato rates, and ~40 more. 49 tables / 2716 entries total.',
    '',
    'When you call hydra_set_engine_param or hydra_set_engine_params for an',
    'enum-typed parameter (filter1type, osc1type, prefxtype, postfxtype,',
    'mutator1mode, etc.), the value field accepts the display name as a string',
    '— e.g. filter1type="Vowel" instead of filter1type=10. This tool helps',
    'you discover which display names a given table contains.',
    '',
    'Without an argument, returns the list of table names + entry counts.',
    'With a name, returns the index→name mapping for that table.',
  ].join('\n'),
  inputSchema: {
    name: z.string().optional().describe('Optional enum-table name (e.g. "FILTER_1_TYPES", "OSC_WAVES", "FX_TYPES"). Case-sensitive. Omit to list all tables.'),
  },
}, async ({ name }) => {
  if (!name) {
    const summary = Object.entries(HYDRASYNTH_ENUMS)
      .map(([n, t]) => `  ${n.padEnd(28)} ${Object.keys(t).length} entries`)
      .join('\n');
    return {
      content: [{
        type: 'text',
        text: `${Object.keys(HYDRASYNTH_ENUMS).length} enum tables:\n${summary}`,
      }],
    };
  }
  const table = HYDRASYNTH_ENUMS[name];
  if (!table) {
    const closest = Object.keys(HYDRASYNTH_ENUMS)
      .filter((n) => n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(n.toLowerCase().slice(0, 4)))
      .slice(0, 6);
    throw new Error(
      `Unknown enum table "${name}". ${closest.length > 0 ? `Closest matches: ${closest.join(', ')}.` : 'Call hydra_list_enum_values without an argument to see all tables.'}`,
    );
  }
  const rows = Object.entries(table).map(([idx, val]) => `  ${String(idx).padStart(3)}  ${val}`).join('\n');
  return {
    content: [{
      type: 'text',
      text: `${name} (${Object.keys(table).length} entries):\n${rows}`,
    }],
  };
});

// hydra_list_params ------------------------------------------------------

server.registerTool('hydra_list_params', {
  description: [
    'Use this tool to enumerate the Hydrasynth Explorer\'s parameter catalog before',
    'calling hydra_set_param. Returns id / module / parameter / CC / category for each',
    'of the 117 charted parameters. Filter by module (e.g. "Filter 1", "ENV 1") to',
    'narrow the response.',
  ].join('\n'),
  inputSchema: {
    module: z.string().optional().describe('Optional module filter, e.g. "Filter 1", "Macros", "ENV 1", "ARP", "System". Case-insensitive substring match.'),
  },
}, async ({ module }) => {
  const filtered = module
    ? HYDRASYNTH_PARAMS.filter((p) => p.module.toLowerCase().includes(module.toLowerCase()))
    : HYDRASYNTH_PARAMS;
  if (filtered.length === 0) {
    throw new Error(`No parameters match module filter "${module}". Try one of: ${[...new Set(HYDRASYNTH_PARAMS.map((p) => p.module))].join(', ')}.`);
  }
  const lines = filtered.map((p) => {
    const tag = p.category === 'system' ? '[sys]' : '[eng]';
    return `  ${tag} ${p.id.padEnd(28)} CC ${String(p.cc).padStart(3)}  — ${p.module} / ${p.parameter}`;
  });
  const header = module
    ? `${filtered.length} parameter(s) in module matching "${module}":`
    : `${filtered.length} parameters total. [sys] = always-on, [eng] = needs Param TX/RX = CC on device.`;
  return {
    content: [{
      type: 'text',
      text: `${header}\n${lines.join('\n')}`,
    }],
  };
});

// -- Start ---------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Hydrasynth Explorer MCP server running on stdio.');
  try {
    const outputs = listHydrasynthOutputs();
    const hydra = outputs.find((p) => p.looksLikeHydrasynth);
    const verdict = hydra
      ? `Hydrasynth detected at output [${hydra.index}]: "${hydra.name}"`
      : outputs.length === 0
        ? 'no MIDI outputs visible'
        : `Hydrasynth not visible among ${outputs.length} output(s): ${outputs.map((p) => p.name).join(', ')}`;
    console.error(`Startup port scan: ${verdict}.`);
  } catch (err) {
    console.error(`Startup port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err) => {
  console.error('Fatal Hydrasynth server error:', err);
  process.exit(1);
});
