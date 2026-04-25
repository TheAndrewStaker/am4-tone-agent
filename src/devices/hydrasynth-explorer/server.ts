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
    'Use this tool to set any synthesis parameter on the user\'s ASM Hydrasynth Explorer.',
    'Do not produce a written spec instead of calling this tool unless the user explicitly',
    'asks for a dry run (e.g. "without touching the hardware", "what would the values look like").',
    '',
    'The Hydrasynth\'s 117 charted parameters are addressed by canonical id —',
    'e.g. "filter1.cutoff", "env1.attack", "reverb.dry_wet", "system.master_volume".',
    'Call hydra_list_params first if unsure which ids exist.',
    '',
    'Values are 0..127 (raw MIDI CC range). For most parameters this maps linearly to',
    'the on-device 0..128 display range (the manual states many engine params display',
    '0.0..128.0). The mapping is parameter-specific — consult the Hydrasynth Explorer',
    'Owner\'s Manual for exact per-param scaling once it matters.',
    '',
    'IMPORTANT — DEVICE MODE PRECONDITION: parameters in the "engine" category',
    '(everything except System Bank/Mod/Volume/Expression/Sustain/All-Notes-Off) only',
    'respond when the device\'s "Param TX/RX" setting is set to "CC" on MIDI: Page 10',
    '(System Setup). If a write produces no audible change, the most likely cause is',
    'Param TX/RX set to NRPN or Off. The system-category params always respond.',
    '',
    'No wire-ack is expected — consumer MIDI synths don\'t echo CCs. Confirmation is',
    'audible / observable on the device only.',
  ].join('\n'),
  inputSchema: {
    id: z.string().describe(
      'Canonical parameter id, e.g. "filter1.cutoff", "env1.attack", "reverb.dry_wet". Call hydra_list_params for the full catalog.',
    ),
    value: z.number().int().min(0).max(127).describe(
      'Raw MIDI CC value 0..127. The on-device display range is parameter-specific (most engine params show 0.0..128.0).',
    ),
  },
}, async ({ id, value }) => {
  const param = HYDRASYNTH_PARAMS_BY_ID.get(id);
  if (!param) {
    const suggestions = HYDRASYNTH_PARAMS
      .map((p) => p.id)
      .filter((pid) => pid.includes(id) || id.includes(pid.split('.')[0] ?? ''))
      .slice(0, 8);
    throw new Error(
      `Unknown parameter id "${id}". ${suggestions.length > 0 ? `Closest matches: ${suggestions.join(', ')}.` : 'Call hydra_list_params for the full catalog.'}`,
    );
  }
  const conn = ensureMidi();
  conn.send(ccBytes(DEFAULT_CHANNEL, param.cc, value));
  const categoryNote = param.category === 'engine'
    ? ' Reminder: requires Param TX/RX = CC on the device.'
    : ' (System CC — always responds, regardless of Param TX/RX setting.)';
  return {
    content: [{
      type: 'text',
      text: `Sent CC ${param.cc} = ${value} (${param.module} → ${param.parameter}).${categoryNote}`,
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
