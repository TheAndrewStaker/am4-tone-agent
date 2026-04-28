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
 *   - hydra_list_enum_values discover enum-table contents (wave/filter/FX names)
 *   - hydra_param_catalog  fallback search across the full 1175-entry NRPN catalog
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
  HYDRASYNTH_PARAMS_BY_ID,
} from './params.js';
import { findHydraNrpn, type HydrasynthNrpn } from './nrpn.js';
import { HYDRASYNTH_ENUMS } from './enums.js';
import {
  resolveNrpnValue,
  nrpnMessagesFor,
  findMatchingNrpns,
  formatNrpnHit,
} from './encoding.js';
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
 * Send a Hydrasynth NRPN write — 4 sequential CC messages.
 *
 * Each CC must be its own `sendMessage()` call. node-midi expects one
 * MIDI message per invocation; bundling 12 bytes into one call makes
 * the device only see the first CC (the NRPN address MSB).
 *
 * Encoding logic (multi-slot dataMsb, 14-bit value split) lives in
 * `encoding.ts` so it can be golden-tested without a MIDI handle.
 */
function sendNrpn(conn: HydrasynthConnection, channel: number, entry: HydrasynthNrpn, value: number): void {
  for (const msg of nrpnMessagesFor(entry, channel, value)) {
    conn.send(msg);
  }
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

// -- Param-name cheat sheet ----------------------------------------------

/**
 * Inline cheat sheet of common engine parameter names — shared by both
 * `hydra_set_engine_param` and `hydra_set_engine_params` descriptions.
 *
 * The catalog is large (1175 entries) but most patch-design work uses
 * the same ~50 parameters. Listing them in the tool description means
 * Claude doesn't need to call `hydra_param_catalog` to discover names —
 * which was burning multiple round-trips per patch build.
 *
 * Naming patterns to deduce the rest:
 *   - Slot families (osc1/2/3, env1/2/3/4/5, lfo1/2/3/4/5, filter1/2,
 *     mutator1/2/3/4, mod1..32) follow {family}{slot}{field} convention:
 *     osc1type, env3decaysyncoff, lfo2gain, etc.
 *   - Time-domain envelope+lfo params have *syncoff* (free-running ms)
 *     and *syncon* (BPM-synced) variants — use *syncoff* by default.
 *   - CC-style dot names ("env1.attack", "mixer.osc1_vol", "filter1.res")
 *     are accepted as aliases everywhere alongside the canonical NRPN
 *     names — pick whichever feels natural.
 */
const ENGINE_PARAM_CHEAT_SHEET = `
Common parameter names (both styles work — pick whichever):

OSCILLATORS  — osc1/osc2/osc3 (slot-disambiguated):
  osc1type / osc2type / osc3type           wave selector — accepts names: "Sine", "Triangle", "Saw", "Square", "Pulse 1".."Pulse 6", "Horizon 1..8", and ~200 more (call hydra_list_enum_values("OSC_WAVES"))
  osc1semi / osc2semi / osc3semi           coarse pitch (-36..+36 semitones)
  osc1cent / osc2cent / osc3cent           fine tune (-50..+50 cents)
  osc1mode / osc2mode / osc3mode           "Single" or "WaveScan"
  osc1wavscan / osc2wavscan                wavescan position
  osc1keytrack / osc2keytrack / osc3keytrack

MIXER  (canonical or dot-style):
  mixerosc1vol / mixer.osc1_vol            OSC 1 volume
  mixerosc2vol / mixer.osc2_vol            OSC 2 volume
  mixerosc3vol / mixer.osc3_vol            OSC 3 volume
  mixerosc1pan / mixer.osc1_pan            OSC 1 pan (etc. for osc2/osc3)
  mixernoisevol / mixer.noise_vol          noise volume
  mixerringmodvol / mixer.ring_mod_vol     ring-mod volume

FILTER 1  (use names for type — "LP Ladder 12", "LP Ladder 24", "Vowel", "BP 3-Ler", etc., 16 options):
  filter1type
  filter1cutoff / filter1.cutoff
  filter1resonance / filter1.res
  filter1drive / filter1.drive
  filter1keytrack / filter1.keytrack
  filter1env1amt, filter1lfo1amt, filter1velenv

FILTER 2  (only "LP-BP-HP" or "LP-Notch-HP" types):
  filter2type
  filter2cutoff, filter2resonance, filter2drive, filter2keytrack

ENVELOPES  — env1 (Amp), env2/3/4/5 (assignable). Default to syncoff variants for free-running times:
  env1.attack  / env1attacksyncoff
  env1.decay   / env1decaysyncoff
  env1.sustain / env1sustain
  env1.release / env1releasesyncoff
  env1holdsyncoff, env1delaysyncoff
  Same shape for env2..env5.

LFOS  (5 of them):
  lfo1ratesyncoff, lfo1wave, lfo1gain, lfo1phase, lfo1delay
  Same shape for lfo2..lfo5.

PRE-FX / POST-FX  (use names for type — "Bypass", "Chorus", "Flanger", "Rotary", "Phaser", "Lo-Fi", "Tremolo", "EQ", "Compressor", "Distortion"):
  prefxtype, postfxtype
  prefxparam1, prefxparam2, prefxmix
  postfxparam1, postfxparam2, postfxmix

DELAY / REVERB  (between Pre-FX and Post-FX):
  delaytype, delaytimesyncoff, delayfeedback, delaymix
  reverbtype, reverbtime, reverbtone, reverbmix

VOICE / GLOBAL:
  voiceglidetime, voicelegato, voicemono, voicepolyphony
  vibratoamount, vibratorate, vibratobpmsync

MUTATORS (4):
  mutator1mode (use names: "FM-Linear", "WavStack", "Osc Sync", "PW-Orig", "PW-Sqeez", "PW-ASM", "Harmonic", "PhazDiff")
  mutator1ratio, mutator1depth, mutator1drywet
  Same shape for mutator2..mutator4.

MOD MATRIX  (32 slots — note edisyn names use "modmatrix" prefix):
  modmatrix1modsource    — source (LFO, ENV, velocity, aftertouch, …)
  modmatrix1modtarget    — destination (osc pitch, filter cutoff, …); set to 0 to disable a slot
  modmatrix1depth        — modulation amount
  ... modmatrix32modsource / modmatrix32modtarget / modmatrix32depth

MACROS:
  macro1value..macro8value (also patch-defined CCs 16-23)

VALUE NOTES:
  - Numbers 0..128 auto-scale onto each param's wireMax (most engine knobs are 14-bit, wireMax=8192). value=64 → display 64.0 exact, value=128 → max.
  - Numbers 129..16383 pass through as raw 14-bit wire values.
  - For type-selector params (osc*type, filter*type, prefxtype, postfxtype, mutator*mode), pass the display name string — auto-resolved.
`.trim();

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
      `"${id}" is an engine parameter, not a System CC. Use hydra_set_engine_param("${id}", value) instead — it sends NRPN, accepts the same name, and the device listens on NRPN for engine control. CC-style and canonical NRPN names both resolve.`,
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
    'Set ONE synthesis-engine parameter on the user\'s Hydrasynth Explorer. For',
    'multi-parameter patch builds use hydra_set_engine_params (batch) instead — one',
    'tool call beats N, and the server paces the writes correctly.',
    '',
    '**DON\'T pre-discover names. Just call this.** This tool already knows every',
    'engine parameter (1175 of them). The cheat-sheet below covers ~95% of patch-',
    'building work. Skip hydra_param_catalog for normal patch building — both the',
    'CC-style names it returns ("mixer.osc1_vol", "env1.attack") AND the canonical',
    'NRPN names ("mixerosc1vol", "env1attacksyncoff") work directly here. Only call',
    'hydra_param_catalog if a write here genuinely fails on a name you can\'t guess from',
    'the patterns below.',
    '',
    'Do not produce a written spec instead of calling this tool unless the user',
    'explicitly asks for a dry run.',
    '',
    ENGINE_PARAM_CHEAT_SHEET,
    '',
    'IMPORTANT — DEVICE PRECONDITION: writes only respond when Param TX/RX is set to',
    'NRPN on System Setup → MIDI page 10. If writes seem inert, check that first.',
    '',
    'No wire-ack — consumer MIDI synths don\'t echo NRPN. Confirmation is audible /',
    'observable on the device only.',
  ].join('\n'),
  inputSchema: {
    name: z.string().describe(
      'Canonical NRPN parameter name (e.g. "filter1type", "osc1semi", "prefxtype", "env1attacksyncoff") OR CC-style alias (e.g. "filter1.cutoff", "mixer.osc1_vol", "env1.attack"). Both resolve.',
    ),
    value: z.union([z.number(), z.string()]).describe(
      'Numeric value (0..16383) OR — for enum-typed params — the display name as a string. Examples: filter1type=10 or filter1type="Vowel"; prefxtype=40 or prefxtype="Lo-Fi"; osc1type=0 or osc1type="Sine". Most non-enum params use only 0..127 (the low 7 bits); osc cents / wavescan / mod-matrix amount use the full 14-bit range. The tool response includes the parameter\'s notes for per-param ranges and signedness.',
    ),
  },
}, async ({ name, value }) => {
  const entry = findHydraNrpn(name);
  if (!entry) {
    const hits = findMatchingNrpns(name, 8);
    const lines = hits.length > 0
      ? `\nClosest matches:\n${hits.map(formatNrpnHit).join('\n')}`
      : ' Call hydra_param_catalog with a related query for fallback discovery.';
    throw new Error(`Unknown NRPN parameter "${name}".${lines}`);
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
    '**Preferred tool for any multi-parameter Hydrasynth patch change** (whole-patch',
    'builds, recipe-style requests, multi-section tweaks). One tool call beats N',
    'serial hydra_set_engine_param calls — much faster, and the server paces NRPN',
    'writes (≥2 ms between sequences) so the device doesn\'t drop messages.',
    '',
    '**DON\'T pre-discover names. Just send the batch.** This tool already knows all',
    '1175 engine parameters. The cheat-sheet below covers ~95% of patch building.',
    'Skip hydra_param_catalog for normal use — both CC-style names ("mixer.osc1_vol",',
    '"env1.attack") and canonical NRPN names ("mixerosc1vol", "env1attacksyncoff")',
    'work here directly. Only fall back to hydra_param_catalog if a name genuinely',
    'fails AND you can\'t guess it from the patterns below.',
    '',
    'Do not produce a written spec instead of calling this tool unless the user',
    'explicitly asks for a dry run.',
    '',
    ENGINE_PARAM_CHEAT_SHEET,
    '',
    'EXAMPLE — Tom Petty Breakdown organ patch in one batch:',
    '  hydra_set_engine_params({ params: [',
    '    { name: "osc1type", value: "Sine" },',
    '    { name: "osc2type", value: "Sine" },',
    '    { name: "filter1type", value: "LP Ladder 12" },',
    '    { name: "prefxtype", value: "Lo-Fi" },',
    '    { name: "postfxtype", value: "Rotary" },',
    '    { name: "osc2semi", value: 12 },',
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
    'ORDERING — per edisyn, put type-changing writes first (modes, types, LFO',
    'waveforms, BPM-sync flags, wavescan waves) followed by continuous-value writes',
    '(cutoffs, envelopes, mixer, macros). The device needs time to reconfigure',
    'routing before downstream values land. The tool does NOT reorder for you.',
    '',
    'IMPORTANT — DEVICE PRECONDITION: Param TX/RX must be NRPN on System Setup →',
    'MIDI page 10. With Param TX/RX = CC, the entire batch is silently ignored.',
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
      const hits = findMatchingNrpns(name, 4);
      const closest = hits.length > 0
        ? ` (closest: ${hits.map((h) => h.entry.name).join(', ')})`
        : '';
      errors.push(`[${i}] "${name}" — unknown${closest}`);
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

// hydra_param_catalog ----------------------------------------------------

server.registerTool('hydra_param_catalog', {
  description: [
    '**Fallback discovery for the full 1175-entry NRPN parameter catalog.**',
    '',
    'Do not call this routinely. The cheat-sheets in hydra_set_engine_param /',
    'hydra_set_engine_params already cover ~95% of patch building, and those tools\'',
    'error responses suggest closest matches when a name doesn\'t resolve. Reach for',
    'this tool ONLY when:',
    '  - the user asks for an exotic param (mod-matrix routing, ribbon controller,',
    '    advanced wavescan slot, BPM-sync edge cases) AND',
    '  - the cheat-sheet doesn\'t list it AND',
    '  - the engine-param error suggestions weren\'t enough.',
    '',
    'Search semantics (`query`):',
    '  - Substring + relaxed match across canonical name, CC-style aliases, and',
    '    notes. Case-insensitive, punctuation-insensitive.',
    '  - Examples:',
    '      query: "vibrato"  → voicevibratoamount, voicevibratoratesyncoff, …',
    '      query: "ringmod"  → ringmoddepth, ringmodsource1/2, mixerringmodvol, …',
    '      query: "vowel"    → params with Vowel-related notes',
    '      query: "mod1"     → mod1source / mod1depth / mod1destination',
    '      query: "filter1.res"  → exact alias hit (filter1resonance)',
    '',
    'Each result line shows: canonical name, CC-style alias (if any), slot index for',
    'multi-slot params, enum-table linkage for type-typed params, and a truncated',
    'note. Bounded to 30 results by default.',
    '',
    'Without a query, returns a one-line meta-help pointer back to the cheat-sheets',
    'in the engine-param tool descriptions.',
  ].join('\n'),
  inputSchema: {
    query: z.string().optional().describe('Substring / fuzzy query against parameter names, aliases, and notes. Omit for meta-help.'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results to return. Default 30.'),
  },
}, async ({ query, limit }) => {
  if (!query) {
    return {
      content: [{
        type: 'text',
        text: [
          '1175 NRPN parameters total, organized into ~15 families.',
          '',
          'For routine patch building, use the cheat-sheets embedded in:',
          '  - hydra_set_engine_param  (single-write description)',
          '  - hydra_set_engine_params (batch description)',
          '',
          'Both tools accept canonical NRPN names (e.g. "filter1cutoff") AND',
          'CC-catalog dot-style names (e.g. "filter1.cutoff"). Both forms resolve.',
          '',
          'Pass a `query` to this tool to substring-search the full catalog when a',
          'parameter isn\'t in the cheat-sheets — e.g. query: "ribbon", query: "mod1",',
          'query: "wavescan". Results are ranked by relevance (name > alias > notes).',
        ].join('\n'),
      }],
    };
  }
  const hits = findMatchingNrpns(query, limit ?? 30);
  if (hits.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No parameters match "${query}". Try a broader term (e.g. "filter" instead of "filtercutoffenv"). For type/wave/FX names, see hydra_list_enum_values instead.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text: `${hits.length} match(es) for "${query}" (canonical name [alias] [slot] [enum] — notes):\n${hits.map(formatNrpnHit).join('\n')}`,
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
