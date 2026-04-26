#!/usr/bin/env node
/**
 * MCP MIDI Tools — MCP server (stdio).
 *
 * Exposes Claude Desktop tools that talk to a local Fractal AM4 over
 * USB/MIDI plus generic-MIDI primitives that work against any USB MIDI
 * device. MVP tools:
 *
 *   - set_param          write one parameter (numeric or enum-by-name),
 *                        verified by waiting for the device's write echo
 *   - set_params         batch-apply many writes, each echo-verified
 *   - list_params        describe the parameter catalog Claude can use
 *   - list_enum_values   list valid dropdown entries for an enum param
 *
 * The MIDI connection is opened lazily on the first tool call so the
 * server can still register with Claude Desktop even if the AM4 is
 * unplugged; we surface the error at tool-execution time instead.
 *
 * Run standalone for a quick sanity check:
 *   npx tsx src/server/index.ts   (server will wait on stdio)
 *
 * Claude Desktop wiring — add to `%APPDATA%\Claude\claude_desktop_config.json`:
 *
 *   "mcp-midi-tools": {
 *     "command": "npx",
 *     "args": ["tsx", "C:\\\\dev\\\\mcp-midi-tools\\\\src\\\\server\\\\index.ts"],
 *     "env": {}
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import {
  KNOWN_PARAMS,
  resolveEnumValue,
  type Param,
  type ParamKey,
} from '../protocol/params.js';
import {
  buildSaveToLocation,
  buildSetBlockBypass,
  buildSetBlockType,
  buildSetParam,
  buildSetPresetName,
  buildSetSceneName,
  buildSwitchPreset,
  buildSwitchScene,
  isCommandAck,
  isWriteEcho,
} from '../protocol/setParam.js';
import {
  BLOCK_NAMES_BY_VALUE,
  BLOCK_TYPE_VALUES,
  resolveBlockType,
  type BlockTypeName,
} from '../protocol/blockTypes.js';
import { formatLocationCode, parseLocationCode } from '../protocol/locations.js';
import {
  connect,
  connectAM4,
  listMidiPorts,
  type MidiConnection,
  toHex,
} from '../protocol/midi.js';
import {
  buildControlChange,
  buildNoteOff,
  buildNoteOn,
  buildNRPN,
  buildProgramChange,
  validateSysEx,
} from '../protocol/generic/midiMessages.js';

/**
 * Max time we wait for the device to echo a WRITE after we send it. The
 * AM4 typically responds in well under 50 ms when the target block is
 * placed; if 300 ms passes we treat it as silent-absorb (block not in
 * the active preset) and surface a clear error instead of pretending
 * the write succeeded.
 */
const WRITE_ECHO_TIMEOUT_MS = 300;

/**
 * Scratch preset location for reverse-engineering writes. Per CLAUDE.md
 * the save-to-location command is hard-gated to this location until we
 * have factory-preset safety classification (backlog P1-008) — writing
 * to any other location would clobber user presets or factory content.
 */
const SCRATCH_LOCATION = 'Z04';

// -- MIDI lazy-init + self-healing reconnect -------------------------------
//
// The connection layer is keyed by `label` so the server can hold open
// handles to multiple MIDI ports concurrently (BK-030 prerequisite for
// generic-MIDI primitives). Today only the AM4 label is used — every
// AM4-tool call hits `ensureConnection()` with the default label and
// behaves exactly like the previous single-handle implementation. When
// the send_cc / send_note / send_program_change / send_nrpn / send_sysex
// tools land in BK-030 Session B, they'll pass their own `label` so each
// device gets an independent stale-handle counter and reconnect path.

const AM4_LABEL = 'am4';

interface RegistryEntry {
  conn: MidiConnection;
  consecutiveTimeouts: number;
}

const connections = new Map<string, RegistryEntry>();
const connectionErrors = new Map<string, Error>();

/**
 * How many ack-less writes we tolerate before assuming the MIDI handle is
 * stale and forcing a reconnect on the next use. Two is chosen so a single
 * "block not placed" silent-absorb doesn't trigger a reconnect (that's a
 * legitimate no-ack and should keep the handle), but two in a row across
 * any tool calls looks like the handle is actually dead.
 */
const STALE_HANDLE_TIMEOUT_THRESHOLD = 2;

/**
 * Call after a write/ack pair completes. Resets the stale-handle counter on
 * success; increments it on timeout. Counter is per-port — patterns like
 * "apply_preset 3 AM4 writes all time out" count as 3 consecutive against
 * the AM4 entry only, and don't drag down a separate Hydrasynth handle.
 */
function recordAckOutcome(acked: boolean, label: string = AM4_LABEL): void {
  const entry = connections.get(label);
  if (!entry) return;
  if (acked) entry.consecutiveTimeouts = 0;
  else entry.consecutiveTimeouts++;
}

function closeMidiSafely(conn: MidiConnection | undefined): void {
  if (!conn) return;
  try {
    conn.close();
  } catch {
    // Closing a stale handle can throw; ignore — we're discarding it anyway.
  }
}

/**
 * Open or return a cached connection for `label`. The default label is
 * the AM4; future device packages will pass their own label.
 *
 * For non-AM4 labels, `label` itself is used as the port-name needle —
 * callers wanting a different needle can plumb a separate connect call.
 */
function ensureConnection(
  label: string = AM4_LABEL,
  forceReconnect = false,
): MidiConnection {
  const cached = connections.get(label);
  const stale = (cached?.consecutiveTimeouts ?? 0) >= STALE_HANDLE_TIMEOUT_THRESHOLD;
  if (forceReconnect || stale) {
    if (cached) closeMidiSafely(cached.conn);
    connections.delete(label);
    connectionErrors.delete(label);
  }
  const existing = connections.get(label);
  if (existing) return existing.conn;
  const cachedErr = connectionErrors.get(label);
  if (cachedErr) throw cachedErr;
  try {
    const conn = label === AM4_LABEL
      ? connectAM4()
      : connect({ needles: [label] });
    connections.set(label, { conn, consecutiveTimeouts: 0 });
    return conn;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    connectionErrors.set(label, e);
    throw e;
  }
}

/**
 * Back-compat shim — every AM4-only call site continues to call this.
 * Forwards to `ensureConnection()` with the default AM4 label.
 */
function ensureMidi(forceReconnect = false): MidiConnection {
  return ensureConnection(AM4_LABEL, forceReconnect);
}

process.on('exit', () => {
  for (const entry of connections.values()) closeMidiSafely(entry.conn);
  connections.clear();
});

// -- Channel awareness (P1-012) ---------------------------------------------
//
// Channels (A/B/C/D) are the data container for block param values; scenes
// are selectors that choose which channel each block uses. Two scenes
// pointing at the same channel will both reflect any write to that channel,
// confirmed on hardware HW-009 (2026-04-19). See SYSEX-MAP.md §6a and
// docs/HARDWARE-TASKS.md HW-009 for the full explanation.
//
// Shape 1 (transparent reporting) and Shape 2 (explicit `channel` param)
// are implemented here. Shape 3 (scene-first tool) depends on BK-023
// decoding the scene-switch ack payload — not in this change.
//
// The cache below holds whatever channel the server LAST EXPLICITLY SET
// for each channel-bearing block. It is not authoritative — a hardware
// footswitch, hardware knob, or AM4-Edit interaction can move the block
// to a different channel without our knowledge. The cache is invalidated
// on `switch_preset` / `switch_scene` / `reconnect_midi` to avoid
// reporting stale data across those boundaries.

const CHANNEL_BLOCKS = new Set(['amp', 'drive', 'reverb', 'delay']);
const lastKnownChannel: Partial<Record<string, number>> = {};

function invalidateChannelCache(): void {
  for (const key of Object.keys(lastKnownChannel)) delete lastKnownChannel[key];
}

function channelLetter(index: number): 'A' | 'B' | 'C' | 'D' {
  return (['A', 'B', 'C', 'D'] as const)[index];
}

/**
 * Parse a user-supplied channel argument ("A"/"B"/"C"/"D" or 0..3) into
 * the 0..3 internal index. Case-insensitive on letters.
 */
function resolveChannel(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 3) {
      throw new Error(`channel must be 0..3 or A/B/C/D, got ${input}`);
    }
    return input;
  }
  const letter = input.trim().toUpperCase();
  const idx = ['A', 'B', 'C', 'D'].indexOf(letter);
  if (idx < 0) throw new Error(`channel must be A/B/C/D (or 0..3), got "${input}"`);
  return idx;
}

/**
 * Render the channel-context status line appended to every param-write
 * response. Returns empty string for blocks that don't have channels
 * (chorus, flanger, phaser, etc. — the secondary effect blocks).
 *
 * `justSwitched` is true when the caller explicitly used the `channel`
 * param on this call and the switch acked; the message is more assertive
 * in that case because we know the write went to a known channel.
 */
function channelStatusLine(block: string, justSwitched: boolean): string {
  if (!CHANNEL_BLOCKS.has(block)) return '';
  const idx = lastKnownChannel[block];
  if (idx === undefined) {
    return (
      ` (Wrote to whatever channel ${block} is on — server hasn't tracked a ` +
      `channel switch this session. Pass \`channel\` to target a specific ` +
      `A/B/C/D, or note that channels are shared across scenes that point ` +
      `at the same one.)`
    );
  }
  if (justSwitched) {
    return ` (Wrote to channel ${channelLetter(idx)}.)`;
  }
  return (
    ` (Wrote to channel ${channelLetter(idx)} — last channel the server ` +
    `explicitly switched this block to. If the user has moved it via ` +
    `footswitch / hardware / AM4-Edit, the real channel may differ.)`
  );
}

/**
 * Issue a channel-switch write and wait for the echo. Updates
 * `lastKnownChannel[block]` on success. Used by set_param / set_params /
 * apply_preset when the caller passes an explicit `channel`.
 *
 * Throws on validation errors (unknown block without a channel register,
 * out-of-range index). Returns `{ switched: boolean }` — switched=false
 * means the cache already showed the requested channel, so no wire write
 * was issued.
 */
async function switchBlockChannel(
  conn: MidiConnection,
  block: string,
  channel: string | number,
): Promise<{ switched: boolean }> {
  if (!CHANNEL_BLOCKS.has(block)) {
    throw new Error(
      `Block "${block}" doesn't expose a channel register (only amp / drive / reverb / delay have channels on AM4). Drop the \`channel\` argument.`,
    );
  }
  const targetIndex = resolveChannel(channel);
  if (lastKnownChannel[block] === targetIndex) {
    return { switched: false };
  }
  const key = `${block}.channel` as ParamKey;
  const bytes = buildSetParam(key, targetIndex);
  const echoPromise = conn.receiveSysExMatching(
    (resp) => isWriteEcho(bytes, resp),
    WRITE_ECHO_TIMEOUT_MS,
  );
  conn.send(bytes);
  try {
    await echoPromise;
    recordAckOutcome(true);
    lastKnownChannel[block] = targetIndex;
    return { switched: true };
  } catch {
    recordAckOutcome(false);
    throw new Error(
      `Channel switch to ${channelLetter(targetIndex)} for ${block} ` +
      `didn't ack within ${WRITE_ECHO_TIMEOUT_MS} ms. The subsequent ` +
      `param write was NOT attempted to avoid writing to the wrong channel. ` +
      `Check USB/driver status or call reconnect_midi.`,
    );
  }
}

/**
 * Observer called after every successful `set_param` write. If the write
 * targeted a `<block>.channel` param, update the cache so the server knows
 * which channel that block is now on.
 */
function observeWrittenParam(block: string, paramName: string, numericValue: number): void {
  if (paramName === 'channel' && CHANNEL_BLOCKS.has(block)) {
    const idx = Math.round(numericValue);
    if (idx >= 0 && idx <= 3) lastKnownChannel[block] = idx;
  }
}


// -- Helpers ----------------------------------------------------------------

function paramKey(block: string, name: string): ParamKey {
  const key = `${block}.${name}` as ParamKey;
  if (!(key in KNOWN_PARAMS)) {
    const available = Object.keys(KNOWN_PARAMS).join(', ');
    throw new Error(`Unknown parameter "${key}". Known: ${available}`);
  }
  return key;
}

function resolveValue(param: Param, value: number | string): number {
  if (param.unit === 'enum') {
    const resolved = resolveEnumValue(param, value);
    if (resolved === undefined) {
      const samples = Object.values(param.enumValues ?? {}).slice(0, 8).join(', ');
      throw new Error(`"${value}" is not a valid ${param.block}.${param.name} value. First few valid names: ${samples}…`);
    }
    return resolved;
  }
  // Non-enum params take a numeric display value (e.g. 0–10 knob, dB, ms).
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) throw new Error(`Expected a number for ${param.block}.${param.name}, got "${value}"`);
  if (num < param.displayMin || num > param.displayMax) {
    throw new Error(`${param.block}.${param.name} out of range [${param.displayMin}..${param.displayMax}]: ${num}`);
  }
  return num;
}

// -- Lineage lookup (P3-007) ------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

const LINEAGE_BLOCKS = [
  'amp', 'drive', 'reverb', 'delay', 'compressor',
  'phaser', 'chorus', 'flanger', 'wah',
] as const;
type LineageBlock = typeof LINEAGE_BLOCKS[number];

interface LineageRecord {
  am4Name: string;
  wikiName?: string;
  basedOn?: {
    primary: string;
    manufacturer?: string;
    model?: string;
    productName?: string;
    source: string;
  };
  description?: string;
  descriptionSource?: string;
  fractalQuotes?: Array<{ text: string; url?: string; attribution?: string }>;
  flags?: string[];
  // amp-specific
  family?: string;
  powerTubes?: string;
  matchingDynaCab?: string;
  originalCab?: string;
  // drive-specific
  categories?: string[];
  clipTypes?: string[];
  // reverb-specific
  familyType?: string;
}

const lineageCache: Partial<Record<LineageBlock, LineageRecord[]>> = {};

function loadLineage(block: LineageBlock): LineageRecord[] {
  const cached = lineageCache[block];
  if (cached) return cached;
  const file = path.join(KNOWLEDGE_DIR, `${block}-lineage.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Lineage data missing at ${file}. Run \`npm run extract-lineage\` to regenerate from the wiki scrape + Blocks Guide PDF.`,
    );
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { records?: LineageRecord[] };
  const records = parsed.records ?? [];
  lineageCache[block] = records;
  return records;
}

function scoreRecord(rec: LineageRecord, query: string): number {
  const q = query.toLowerCase();
  let score = 0;
  // Structured field hits score highest — they're deterministic, unlike
  // substring matches on prose.
  if (rec.basedOn?.manufacturer?.toLowerCase() === q) score += 20;
  if (rec.basedOn?.model?.toLowerCase() === q) score += 20;
  if (rec.basedOn?.productName?.toLowerCase().includes(q)) score += 12;
  if (rec.am4Name.toLowerCase().includes(q)) score += 10;
  if (rec.basedOn?.primary.toLowerCase().includes(q)) score += 8;
  if (rec.wikiName && rec.wikiName.toLowerCase().includes(q)) score += 5;
  if (rec.description && rec.description.toLowerCase().includes(q)) score += 5;
  for (const qt of rec.fractalQuotes ?? []) {
    if (qt.text.toLowerCase().includes(q)) score += 2;
  }
  return score;
}

function matchesStructured(
  rec: LineageRecord,
  filter: { manufacturer?: string; model?: string },
): boolean {
  if (!rec.basedOn) return false;
  const ci = (a: string | undefined, b: string | undefined): boolean =>
    !b || (a?.toLowerCase() === b.toLowerCase());
  return (
    ci(rec.basedOn.manufacturer, filter.manufacturer) &&
    ci(rec.basedOn.model, filter.model)
  );
}

function formatLineageRecord(rec: LineageRecord, includeQuotes: boolean, maxQuotes = 5): string {
  const lines: string[] = [`am4Name: ${rec.am4Name}`];
  if (rec.wikiName && rec.wikiName !== rec.am4Name) lines.push(`wikiName: ${rec.wikiName}`);
  if (rec.family) lines.push(`family: ${rec.family}`);
  if (rec.familyType) lines.push(`familyType: ${rec.familyType}`);
  if (rec.categories?.length) lines.push(`categories: ${rec.categories.join(', ')}`);
  if (rec.clipTypes?.length) lines.push(`clipTypes: ${rec.clipTypes.join(', ')}`);
  if (rec.powerTubes) lines.push(`powerTubes: ${rec.powerTubes}`);
  if (rec.originalCab) lines.push(`originalCab: ${rec.originalCab}`);
  if (rec.matchingDynaCab) lines.push(`matchingDynaCab: ${rec.matchingDynaCab}`);
  if (rec.basedOn) {
    const parts: string[] = [`basedOn: ${rec.basedOn.primary}`];
    if (rec.basedOn.manufacturer) parts.push(`manufacturer=${rec.basedOn.manufacturer}`);
    if (rec.basedOn.model) parts.push(`model=${rec.basedOn.model}`);
    if (rec.basedOn.productName) parts.push(`productName="${rec.basedOn.productName}"`);
    parts.push(`source=${rec.basedOn.source}`);
    lines.push(parts.join(' | '));
  }
  if (rec.description) lines.push(`description: ${rec.description}`);
  if (includeQuotes && rec.fractalQuotes?.length) {
    const shown = rec.fractalQuotes.slice(0, maxQuotes);
    lines.push(`fractalQuotes (${shown.length}/${rec.fractalQuotes.length}):`);
    for (const q of shown) {
      const url = q.url ? ` [${q.url}]` : '';
      lines.push(`  - "${q.text}"${url}`);
    }
  }
  if (rec.flags?.length) lines.push(`flags: ${rec.flags.join('; ')}`);
  return lines.join('\n');
}

// -- Server setup -----------------------------------------------------------

const server = new McpServer({
  name: 'mcp-midi-tools',
  version: '0.1.0',
});

server.registerTool('set_param', {
  description: [
    'Use this tool to write a single parameter on the user\'s AM4. Do not',
    'produce a written spec instead of calling this tool unless the user',
    'explicitly asks for a dry run (e.g. "draft a preset", "without touching',
    'the hardware", "what would the params look like").',
    'Write a single parameter on the connected Fractal AM4. The parameter',
    'is addressed by (block, name) — e.g. block="amp", name="gain". For',
    'numeric params, pass the user-facing display value (0–10 knob, dB,',
    'ms, %). For enum params, pass the dropdown name ("1959SLP Normal")',
    'or wire index (0).',
    'CHANNEL/SCENE MODEL — IMPORTANT for user requests that mention scenes:',
    'Each block (amp/drive/reverb/delay) holds its parameter values in one',
    'of four channels A/B/C/D. Scenes are selectors — they choose which',
    'channel each block uses (plus per-block bypass state), they don\'t',
    'store param values themselves. Two scenes pointing at the same',
    'channel will both reflect any write to that channel. If the user says',
    '"change the amp gain on scene 2" they usually mean "on whichever',
    'channel scene 2 uses for Amp" — pass the `channel` argument to target',
    'a specific A/B/C/D. Without `channel`, the write goes to whatever',
    'channel the block is on now, which may be shared across multiple',
    'scenes. Only amp / drive / reverb / delay have channels; other blocks',
    '(chorus, flanger, phaser, …) ignore the `channel` argument.',
    'IMPORTANT: the tool cannot currently tell whether a write actually',
    'landed on the audio path. If the target block isn\'t placed in the',
    'active preset, the AM4 still acknowledges the write on the wire but',
    'produces no audible change. The response includes the raw ack bytes',
    'for diagnostic purposes, but the only trustworthy signal that a',
    'change took effect is the user confirming via the AM4\'s own display.',
    'If the user expects an audible change and reports none, the likely',
    'cause is that the target block isn\'t placed in the active preset.',
    'Call list_params first if unsure what is available.',
  ].join(' '),
  inputSchema: {
    block: z.string().describe('Block name, e.g. "amp", "drive", "reverb", "delay"'),
    name: z.string().describe('Parameter name within the block, e.g. "gain", "type", "mix"'),
    value: z.union([z.number(), z.string()]).describe(
      'Display value. Numbers for knobs/dB/ms/%, strings for enum dropdowns.',
    ),
    channel: z.union([z.string(), z.number()]).optional().describe(
      'Optional. If supplied, the server first writes the block\'s channel selector to this A/B/C/D (or 0..3), then the param. Only valid for amp / drive / reverb / delay. Omit to write to whichever channel the block is currently on.',
    ),
  },
}, async ({ block, name, value, channel }) => {
  const key = paramKey(block, name);
  const param: Param = KNOWN_PARAMS[key];
  const resolved = resolveValue(param, value);
  const bytes = buildSetParam(key, resolved);
  const conn = ensureMidi();
  let channelSwitched = false;
  if (channel !== undefined) {
    const result = await switchBlockChannel(conn, block, channel);
    channelSwitched = result.switched;
  }
  const enumNameFor = (idx: number): string | undefined => {
    const vals = param.enumValues as Record<number, string> | undefined;
    return vals?.[idx];
  };
  const display = param.unit === 'enum'
    ? `${resolved} (${enumNameFor(resolved) ?? '?'})`
    : String(resolved);
  const result = await sendAndAwaitAck(conn, bytes, isWriteEcho);
  if (result.acked) {
    observeWrittenParam(param.block, param.name, resolved);
    const channelLine = channelStatusLine(param.block, channelSwitched);
    return {
      content: [{
        type: 'text',
        text:
          `Sent ${key} = ${display}. AM4 wire-acked the write.${channelLine} NOTE: the ack does NOT ` +
          `confirm an audible change — if the user expected a sound change and reports none, the ` +
          `${param.block} block may not be placed in the active preset, or the write landed on a ` +
          `channel the current scene isn't using.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `Sent ${key} = ${display}. No ack within ${WRITE_ECHO_TIMEOUT_MS} ms — this is unusual ` +
        `(the AM4 normally acks every write).\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        formatAcklessHint(result.captured),
    }],
  };
});

server.registerTool('list_params', {
  description: [
    'List every parameter the server can write. Use this to discover',
    'capabilities — or as a quick sanity check that the mcp-midi-tools MCP',
    'connector is live and its tools are callable (the response opens with',
    'a confirmation line). If you were about to tell the user "I don\'t',
    'have the connector in this session" without having actually tried a',
    'tool call, call this tool first; if it returns, the connector is',
    'attached and every AM4 tool is available to use.',
  ].join(' '),
  inputSchema: {},
}, async () => {
  const rows = Object.entries(KNOWN_PARAMS).map(([key, p]) => {
    const base = `${key} — unit=${p.unit}, range=[${p.displayMin}..${p.displayMax}]`;
    const enumNote = p.unit === 'enum' && p.enumValues
      ? ` (${Object.keys(p.enumValues).length} options; call list_enum_values for names)`
      : '';
    return `  ${base}${enumNote}`;
  });
  // Leading confirmation line addresses HW-012 — Claude Desktop sometimes
  // thinks the connector isn't attached when in fact it is but the tool
  // schemas hadn't been loaded yet. Getting this response proves the
  // connector is live.
  const liveConfirmation =
    'mcp-midi-tools MCP server is live and reachable. All AM4 tools ' +
    '(apply_preset, set_param, set_params, set_block_type, set_block_bypass, ' +
    'switch_preset, switch_scene, save_preset, save_to_location, ' +
    'set_preset_name, set_scene_name, reconnect_midi) are available to ' +
    'call — if a user request matches any of them, prefer executing the ' +
    'tool over writing a spec. A connected AM4 is detected at the OS level ' +
    'via list_midi_ports; this tool responds regardless of whether the AM4 ' +
    'itself is plugged in.';
  return {
    content: [{
      type: 'text',
      text: `${liveConfirmation}\n\nAvailable parameters (${rows.length}):\n${rows.join('\n')}`,
    }],
  };
});

server.registerTool('set_params', {
  description: [
    'Use this tool to batch-apply multiple parameter writes on the user\'s',
    'AM4 in one call. Do not produce a written spec instead of calling this',
    'tool unless the user explicitly asks for a dry run.',
    'Apply multiple parameter writes in one call. Prefer this over many',
    'set_param calls when applying a scene, preset, or any grouped change —',
    'it\'s less chatty and validates all inputs before sending any MIDI',
    '(a bad value in one entry rejects the whole call with nothing sent).',
    'Same value rules as set_param: numbers for knobs/dB/ms/%, strings or',
    'wire indices for enum params. Writes are sent in the provided order.',
    'Each entry accepts an optional per-write `channel` (A/B/C/D or 0..3)',
    'for amp / drive / reverb / delay — see set_param\'s description for the',
    'channel/scene model. Different entries in the same batch can target',
    'different channels: the server switches as needed and reports which',
    'channel each write landed on.',
    'IMPORTANT: same caveat as set_param — the AM4 acks every write on the',
    'wire whether or not the target block is placed or the current scene is',
    'pointing at the channel you wrote to. An ack is not a confirmation of',
    'audible change. If the user expects audible changes and reports none,',
    'the most likely causes are (a) one or more target blocks are not placed',
    'in the active preset, or (b) the write landed on a channel the active',
    'scene isn\'t using.',
  ].join(' '),
  inputSchema: {
    writes: z.array(z.object({
      block: z.string().describe('Block name, e.g. "amp", "drive", "reverb", "delay"'),
      name: z.string().describe('Parameter name within the block, e.g. "gain", "type", "mix"'),
      value: z.union([z.number(), z.string()]).describe('Display value'),
      channel: z.union([z.string(), z.number()]).optional().describe(
        'Optional. A/B/C/D (or 0..3). The server switches the block\'s channel before the write. Only valid for amp/drive/reverb/delay.',
      ),
    })).describe('List of (block, name, value, channel?) writes to apply in order'),
  },
}, async ({ writes }) => {
  if (writes.length === 0) {
    return { content: [{ type: 'text', text: 'No writes supplied. Nothing to do.' }] };
  }
  // Validate + encode every entry BEFORE sending any MIDI. A bad value in
  // entry 7 would otherwise leave entries 0..6 half-sent; the pre-flight
  // pass keeps input-validation failures atomic. Channel indices also
  // validated here so a bad "E" channel letter rejects the whole batch.
  const prepared = writes.map((w, i) => {
    try {
      const key = paramKey(w.block, w.name);
      const param: Param = KNOWN_PARAMS[key];
      const resolved = resolveValue(param, w.value);
      const bytes = buildSetParam(key, resolved);
      const enumNameFor = (idx: number): string | undefined =>
        (param.enumValues as Record<number, string> | undefined)?.[idx];
      const display = param.unit === 'enum'
        ? `${resolved} (${enumNameFor(resolved) ?? '?'})`
        : String(resolved);
      if (w.channel !== undefined) {
        if (!CHANNEL_BLOCKS.has(param.block)) {
          throw new Error(`Block "${param.block}" doesn't have channels; drop the \`channel\` argument (only amp/drive/reverb/delay expose A/B/C/D).`);
        }
        resolveChannel(w.channel); // throws on invalid input
      }
      return { key, param, bytes, display, channel: w.channel };
    } catch (err) {
      throw new Error(`writes[${i}] (${w.block}.${w.name} = ${w.value}): ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  const conn = ensureMidi();
  const lines: string[] = [];
  let acked = 0;
  let unacked = 0;
  for (let i = 0; i < prepared.length; i++) {
    const { key, param, display, bytes, channel } = prepared[i];
    let channelSwitched = false;
    if (channel !== undefined) {
      try {
        const result = await switchBlockChannel(conn, param.block, channel);
        channelSwitched = result.switched;
      } catch (err) {
        lines.push(`  ✗ ${key} = ${display} — channel switch failed: ${err instanceof Error ? err.message : String(err)}`);
        unacked++;
        continue;
      }
    }
    const echoPromise = conn.receiveSysExMatching(
      (resp) => isWriteEcho(bytes, resp),
      WRITE_ECHO_TIMEOUT_MS,
    );
    conn.send(bytes);
    try {
      await echoPromise;
      acked++;
      recordAckOutcome(true);
      observeWrittenParam(param.block, param.name, resolveValue(param, writes[i].value));
      const channelLine = channelStatusLine(param.block, channelSwitched);
      lines.push(`  ✓ ${key} = ${display} — wire-acked.${channelLine}`);
    } catch {
      unacked++;
      recordAckOutcome(false);
      lines.push(`  ? ${key} = ${display} — no ack within ${WRITE_ECHO_TIMEOUT_MS} ms (USB/driver issue?)`);
    }
  }
  const summary =
    unacked === 0
      ? `Sent all ${prepared.length} writes; AM4 wire-acked each one. Acks do NOT confirm audible change — if the user reports no change on the device, the target blocks may not be placed in the active preset, or writes may have landed on channels the current scene isn't using (see per-write channel notes).`
      : `Sent ${prepared.length} writes; ${acked} acked, ${unacked} un-acked (un-acked across multiple writes suggests a stale MIDI handle — server auto-reconnects after ${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes, or call reconnect_midi to force).`;
  return {
    content: [{ type: 'text', text: `${summary}\n${lines.join('\n')}` }],
  };
});

server.registerTool('set_block_type', {
  description: [
    'Use this tool to place or clear a block in one of the AM4\'s four',
    'signal-chain slots on the user\'s hardware. Do not produce a written',
    'spec instead of calling this tool unless the user explicitly asks for',
    'a dry run.',
    'Place a block (or clear the slot) at one of the AM4\'s four signal-chain',
    'positions. The AM4 has 4 block slots, numbered 1..4 left-to-right in the',
    'signal chain. Each slot can hold at most one block of a given type, and',
    'a preset\'s layout is defined by which block is in which slot.',
    'Block types (case-insensitive): "none" (empty slot), "amp", "compressor",',
    '"geq", "peq", "reverb", "delay", "chorus", "flanger", "rotary", "phaser",',
    '"wah", "volpan", "tremolo", "filter", "drive", "enhancer", "gate".',
    'Typical use: build a preset by first calling set_block_type for each slot',
    'to lay out the chain, then use set_param / set_params to dial in the',
    'parameters for each placed block.',
    'Same ack caveat as set_param: the AM4 wire-acks the placement; whether',
    'it was actually accepted is best confirmed by the user on the device.',
  ].join(' '),
  inputSchema: {
    position: z.number().int().min(1).max(4).describe(
      'Slot position in the signal chain (1..4). Slot 1 is leftmost / first.',
    ),
    block_type: z.string().describe(
      'Block name (e.g. "compressor", "reverb", "drive") or "none" to clear.',
    ),
  },
}, async ({ position, block_type }) => {
  const value = resolveBlockType(block_type);
  if (value === undefined) {
    const known = Object.keys(BLOCK_TYPE_VALUES).join(', ');
    throw new Error(`Unknown block_type "${block_type}". Known: ${known}`);
  }
  const pos = position as 1 | 2 | 3 | 4;
  const bytes = buildSetBlockType(pos, value);
  const displayName = BLOCK_NAMES_BY_VALUE[value] ?? `0x${value.toString(16)}`;
  const conn = ensureMidi();
  const result = await sendAndAwaitAck(conn, bytes, isWriteEcho);
  if (result.acked) {
    return {
      content: [{
        type: 'text',
        text:
          `Placed ${displayName} in slot ${pos}. AM4 wire-acked the change. ` +
          `Cross-check on the AM4 if the layout matters.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `Sent block placement (slot ${pos} → ${displayName}). No ack within ` +
        `${WRITE_ECHO_TIMEOUT_MS} ms — this is unusual.\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        formatAcklessHint(result.captured),
    }],
  };
});

server.registerTool('set_block_bypass', {
  description: [
    'Use this tool to silence (bypass) or reactivate a block on the user\'s',
    'AM4. Do not produce a written spec instead of calling this tool unless',
    'the user explicitly asks for a dry run.',
    'Silence (bypass = true) or reactivate (bypass = false) a block on the',
    'currently-active scene. A bypassed block passes its input through',
    'unchanged — the block stays in the slot with all its params intact, it',
    'just makes no sound. Common use: "mute the drive on the clean scene"',
    '(switch to that scene first, then set_block_bypass drive true).',
    'Scene-scoping is implicit — this writes the working-buffer state, and',
    'the AM4 automatically saves it to whichever scene is active right now.',
    'To configure bypass on a specific scene, issue switch_scene first and',
    'then set_block_bypass; the tool does not accept a scene argument.',
    'Block names (case-insensitive): "amp", "compressor", "geq", "peq",',
    '"reverb", "delay", "chorus", "flanger", "rotary", "phaser", "wah",',
    '"volpan", "tremolo", "filter", "drive", "enhancer", "gate". "none" is',
    'rejected — an empty slot has no bypass state.',
  ].join(' '),
  inputSchema: {
    block: z.string().describe(
      'Block name (e.g. "amp", "drive", "reverb"). Rejects "none".',
    ),
    bypassed: z.boolean().describe(
      'true = bypass (silence the block). false = activate.',
    ),
  },
}, async ({ block, bypassed }) => {
  const value = resolveBlockType(block);
  if (value === undefined || value === BLOCK_TYPE_VALUES.none) {
    const known = (Object.keys(BLOCK_TYPE_VALUES) as BlockTypeName[])
      .filter((n) => n !== 'none')
      .join(', ');
    throw new Error(`Unknown or invalid block "${block}". Known: ${known}`);
  }
  const displayName = BLOCK_NAMES_BY_VALUE[value] ?? `0x${value.toString(16)}`;
  const bytes = buildSetBlockBypass(value, bypassed);
  const conn = ensureMidi();
  const result = await sendAndAwaitAck(conn, bytes, isWriteEcho);
  const stateWord = bypassed ? 'bypassed' : 'active';
  if (result.acked) {
    return {
      content: [{
        type: 'text',
        text:
          `Set ${displayName} to ${stateWord} on the active scene. AM4 ` +
          `wire-acked the change. To change a different scene's bypass, ` +
          `switch_scene first and re-issue.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `Sent ${displayName} → ${stateWord}. No ack within ` +
        `${WRITE_ECHO_TIMEOUT_MS} ms — this is unusual.\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        formatAcklessHint(result.captured),
    }],
  };
});

server.registerTool('list_block_types', {
  description:
    'List every block type that can be placed via set_block_type, together ' +
    'with its wire pidLow (mostly for debugging — callers normally pass the ' +
    'block name, not the numeric value). "none" clears a slot to empty.',
  inputSchema: {},
}, async () => {
  const rows = (Object.entries(BLOCK_TYPE_VALUES) as [BlockTypeName, number][]).map(
    ([name, value]) => `  ${name} (pidLow=0x${value.toString(16).padStart(4, '0')})`,
  );
  return {
    content: [{
      type: 'text',
      text: `Block types available for set_block_type (${rows.length}):\n${rows.join('\n')}`,
    }],
  };
});

server.registerTool('apply_preset', {
  description: [
    'Use this tool to apply a preset configuration (block layout + params +',
    'optional scene overrides and name) to the user\'s AM4. Do not produce',
    'a written spec instead of calling this tool unless the user explicitly',
    'asks for a dry run (e.g. "draft a preset I can review before pushing",',
    '"design a tone sheet without touching the hardware", "what would the',
    'params look like").',
    'Lay out an entire preset in one call: place (or clear) each block slot,',
    'fill in parameter values — either for the currently-active channel or',
    'for specific A/B/C/D channels — and optionally name the working-buffer',
    'preset at the end. Use this when the user is building a tone from',
    'scratch or applying a named preset concept — it replaces a sequence of',
    'set_block_type + set_param + channel-switch + set_preset_name calls',
    'with a single structured request.',
    'Each slot accepts these optional shapes (pick at most one per slot):',
    '  • params — writes to whichever channel the block is on now.',
    '    Example: { gain: 6, bass: 5 }.',
    '  • channel + params — switches to the specified channel first, then',
    '    writes params there. Example: { channel: "B", params: { gain: 8 } }.',
    '  • channels — per-channel param maps, one entry per channel you want',
    '    to fill. Keys are A/B/C/D (case-insensitive). Use this to',
    '    configure multiple channels of the same block in one call — e.g.',
    '    clean tone on channel A and lead tone on channel D. Example:',
    '    { channels: { A: { type: "Deluxe Verb Normal", gain: 3 },',
    '                  D: { type: "1959SLP Normal", gain: 8 } } }.',
    'Only amp / drive / reverb / delay have channels — `channel` and',
    '`channels` are rejected for other blocks. Channel maps are written in',
    'canonical A→B→C→D order so the last-written channel is predictable.',
    'Optional top-level fields:',
    '  • name — working-buffer preset name, up to 32 ASCII-printable chars.',
    '    Written AFTER all slot writes so the display reflects it immediately.',
    '    This does NOT save to a location — apply_preset remains working-',
    '    buffer-only. Example: { slots: [...], name: "Sailing - C. Cross" }.',
    '  • scenes — per-scene overrides. Each entry configures one of the four',
    '    scenes (index 1..4) by pointing each block at a specific channel',
    '    (`channels: { amp: "A", drive: "A" }`), setting per-block bypass',
    '    (`bypass: { drive: true }` silences drive on that scene), and/or',
    '    renaming (`name: "clean"`). A scene entry may specify any combination',
    '    of channels / bypass / name — at least one must be supplied.',
    '    Scenes are configured in the order given; the AM4 ends up on the',
    '    last-configured scene when apply_preset returns.',
    'CHANNEL/SCENE MODEL: channels (A/B/C/D) hold the param values; scenes',
    'pick which channel each block uses. If the user wants a preset where',
    'a block varies tone across scenes, use `slots[].channels` to fill',
    'the relevant channels with params, then use `scenes[].channels` to',
    'point each scene at the channel it should use. Unspecified scene',
    'channel/bypass pointers keep whatever the preset already had; only',
    'named scenes/blocks are touched.',
    'Validation happens up-front; if any slot/param is invalid (duplicate',
    'position, unknown block type, unknown param for that block, value out',
    'of range, unknown enum name, channel on a block that doesn\'t have',
    'channels, conflicting channel+channels, unknown channel letter), or',
    'any scene entry is invalid (duplicate index, unknown block in',
    'channels/bypass map, non-A/B/C/D letter, bypass value not boolean,',
    'empty scene entry with no channels/bypass/name), the entire call is',
    'rejected with nothing sent. Same ack caveat as set_param/set_params:',
    'wire-acks confirm receipt, not audible change.',
    'REVERSIBILITY / SAVE INTENT: this call hits the WORKING BUFFER only.',
    'The user can audition the tone, tweak it, or switch presets to discard.',
    'Do NOT follow this call with save_to_location / save_preset unless the',
    'user has explicitly asked to save / persist / store the preset. A bare',
    '"make me a preset for X" or "build a tone for Y" is a try-it-out ask,',
    'not a save ask. When in doubt, apply and then ask the user whether to',
    'save.',
  ].join(' '),
  inputSchema: {
    slots: z.array(z.object({
      position: z.number().int().min(1).max(4).describe('Slot position 1..4 (1 = leftmost)'),
      block_type: z.string().describe(
        'Block name ("amp", "reverb", "compressor", "none", …). Call list_block_types for the full list.',
      ),
      channel: z.union([z.string(), z.number()]).optional().describe(
        'Optional A/B/C/D (or 0..3). Single-channel shortcut — switches the block to this channel, then writes `params` there. Mutually exclusive with `channels`. Rejected for blocks without channels.',
      ),
      params: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe(
        'Map of param name → display value within the block, e.g. { gain: 6, bass: 5 }. Writes to the current channel, or to `channel` if supplied. Mutually exclusive with `channels`. Omit to just place the block.',
      ),
      channels: z.record(
        z.string(),
        z.record(z.string(), z.union([z.number(), z.string()])),
      ).optional().describe(
        'Map of channel letter (A/B/C/D, case-insensitive) → params for that channel. Fills multiple channels of the same block in one slot, e.g. { A: { gain: 3 }, D: { gain: 8 } }. Mutually exclusive with `channel` and `params`. Only valid for amp / drive / reverb / delay.',
      ),
    })).min(1).describe('Ordered list of slots to configure'),
    name: z.string().max(32).optional().describe(
      'Optional working-buffer preset name (≤32 ASCII-printable chars). Written after all slot writes. Does NOT save — persistence still requires a separate save_to_location / save_preset call.',
    ),
    scenes: z.array(z.object({
      index: z.number().int().min(1).max(4).describe('Scene number 1..4 (matches AM4-Edit numbering).'),
      name: z.string().max(32).optional().describe(
        'Optional scene name (≤32 ASCII-printable chars). Space-padded on the wire.',
      ),
      channels: z.record(z.string(), z.string()).optional().describe(
        'Map of block name → channel letter (A/B/C/D). Points this scene at a specific channel per block, e.g. { amp: "A", drive: "A" }. Only blocks with channels (amp / drive / reverb / delay) may appear.',
      ),
      bypass: z.record(z.string(), z.boolean()).optional().describe(
        'Map of block name → bypass flag. true = silence the block on this scene (block stays in the slot, just passes input through); false = active. Example: { drive: true, reverb: false }.',
      ),
    })).max(4).optional().describe(
      'Per-scene overrides. Each scene entry configures one of the four scenes; at least one of channels / bypass / name must be supplied per entry. Scenes not listed here are left untouched.',
    ),
  },
}, async ({ slots, name, scenes }) => {
  // --- Validation pass (no MIDI yet) ---
  const seenPositions = new Set<number>();
  type PreparedWrite =
    | { kind: 'place'; position: 1 | 2 | 3 | 4; blockName: string; bytes: number[] }
    | { kind: 'channel'; block: string; index: number; bytes: number[] }
    | { kind: 'param'; block: string; paramName: string; resolved: number; key: ParamKey; display: string; bytes: number[] }
    | { kind: 'switch_scene'; sceneIndex: number; bytes: number[] }
    | { kind: 'scene_channel'; block: string; index: number; sceneIndex: number; bytes: number[] }
    | { kind: 'bypass'; block: string; bypassed: boolean; sceneIndex: number; bytes: number[] }
    | { kind: 'scene_name'; sceneIndex: number; name: string; bytes: number[] };
  const prepared: PreparedWrite[] = [];
  // Writes that ack with the 18-byte command-ack shape (rename family) vs
  // the 64-byte write-echo shape (SET_PARAM / placement / scene-switch /
  // bypass). Used below by the send loop to pick the right predicate.
  const COMMAND_ACK_KINDS = new Set<PreparedWrite['kind']>(['scene_name']);

  /**
   * Resolve a single (paramName, value) pair within a block into a prepared
   * param write, or throw a path-prefixed error. Shared by the `params` and
   * `channels.<letter>` code paths so error messages stay consistent.
   */
  const buildParamWrite = (
    at: string,
    canonicalBlock: string,
    paramName: string,
    value: number | string,
  ): Extract<PreparedWrite, { kind: 'param' }> => {
    const key = `${canonicalBlock}.${paramName}` as ParamKey;
    if (!(key in KNOWN_PARAMS)) {
      const sameBlock = Object.keys(KNOWN_PARAMS).filter((k) => k.startsWith(`${canonicalBlock}.`));
      throw new Error(
        `${at}: unknown param "${paramName}" for block "${canonicalBlock}". ` +
        (sameBlock.length ? `Known params for ${canonicalBlock}: ${sameBlock.join(', ')}.` : `No params registered for ${canonicalBlock} yet.`),
      );
    }
    const param: Param = KNOWN_PARAMS[key];
    let resolved: number;
    try {
      resolved = resolveValue(param, value);
    } catch (err) {
      throw new Error(`${at}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const enumNameFor = (idx: number): string | undefined =>
      (param.enumValues as Record<number, string> | undefined)?.[idx];
    const display = param.unit === 'enum'
      ? `${resolved} (${enumNameFor(resolved) ?? '?'})`
      : String(resolved);
    return {
      kind: 'param',
      block: canonicalBlock,
      paramName,
      resolved,
      key,
      display,
      bytes: buildSetParam(key, resolved),
    };
  };

  slots.forEach((slot, i) => {
    const at = `slots[${i}] (position ${slot.position}, ${slot.block_type})`;
    if (seenPositions.has(slot.position)) {
      throw new Error(`${at}: position ${slot.position} used twice — each slot may appear at most once per call`);
    }
    seenPositions.add(slot.position);

    const blockTypeValue = resolveBlockType(slot.block_type);
    if (blockTypeValue === undefined) {
      const known = Object.keys(BLOCK_TYPE_VALUES).join(', ');
      throw new Error(`${at}: unknown block_type "${slot.block_type}". Known: ${known}`);
    }
    const canonicalBlock = BLOCK_NAMES_BY_VALUE[blockTypeValue] ?? slot.block_type;
    const pos = slot.position as 1 | 2 | 3 | 4;
    prepared.push({
      kind: 'place',
      position: pos,
      blockName: canonicalBlock,
      bytes: buildSetBlockType(pos, blockTypeValue),
    });

    // Mutual-exclusion between the three param-shape fields. Catching this
    // up front gives a clear error before we descend into any of the
    // branch-specific validation below.
    if (slot.channels !== undefined) {
      if (slot.channel !== undefined) {
        throw new Error(`${at}: 'channels' (per-channel params) and 'channel' (single-channel shortcut) are mutually exclusive. Use one or the other.`);
      }
      if (slot.params !== undefined) {
        throw new Error(`${at}: 'channels' (per-channel params) and 'params' (current-channel params) are mutually exclusive. Move params into channels.<A|B|C|D>.<name> or drop channels.`);
      }
    }

    if (slot.channel !== undefined) {
      if (canonicalBlock === 'none') {
        throw new Error(`${at}: channel supplied but block_type is "none" (empty slot). Remove channel.`);
      }
      if (!CHANNEL_BLOCKS.has(canonicalBlock)) {
        throw new Error(`${at}: block "${canonicalBlock}" doesn't have channels. Drop the channel argument (only amp / drive / reverb / delay expose A/B/C/D).`);
      }
      let channelIdx: number;
      try {
        channelIdx = resolveChannel(slot.channel);
      } catch (err) {
        throw new Error(`${at}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const channelKey = `${canonicalBlock}.channel` as ParamKey;
      prepared.push({
        kind: 'channel',
        block: canonicalBlock,
        index: channelIdx,
        bytes: buildSetParam(channelKey, channelIdx),
      });
    }

    if (slot.params && Object.keys(slot.params).length > 0) {
      if (canonicalBlock === 'none') {
        throw new Error(`${at}: params supplied but block_type is "none" (empty slot). Remove params or pick a real block type.`);
      }
      for (const [paramName, value] of Object.entries(slot.params)) {
        prepared.push(buildParamWrite(at, canonicalBlock, paramName, value));
      }
    }

    if (slot.channels !== undefined) {
      if (canonicalBlock === 'none') {
        throw new Error(`${at}: channels supplied but block_type is "none" (empty slot). Remove channels.`);
      }
      if (!CHANNEL_BLOCKS.has(canonicalBlock)) {
        throw new Error(`${at}: block "${canonicalBlock}" doesn't have channels. Drop the channels field (only amp / drive / reverb / delay expose A/B/C/D).`);
      }
      // Normalize keys (case-insensitive, detect collisions like A/a in one
      // object) and validate each is A/B/C/D. Walking A→B→C→D in canonical
      // order at emit-time keeps the wire sequence predictable regardless
      // of how the caller ordered the object's keys.
      const channelEntries = new Map<'A' | 'B' | 'C' | 'D', Record<string, number | string>>();
      for (const [rawKey, params] of Object.entries(slot.channels)) {
        const letter = rawKey.trim().toUpperCase();
        if (letter !== 'A' && letter !== 'B' && letter !== 'C' && letter !== 'D') {
          throw new Error(`${at} channels.${rawKey}: must be one of A/B/C/D (case-insensitive), got "${rawKey}".`);
        }
        if (channelEntries.has(letter)) {
          throw new Error(`${at} channels.${letter}: duplicated (keys are case-insensitive, so A and a collide).`);
        }
        channelEntries.set(letter, params);
      }
      for (const letter of ['A', 'B', 'C', 'D'] as const) {
        const channelParams = channelEntries.get(letter);
        if (channelParams === undefined) continue;
        if (Object.keys(channelParams).length === 0) continue;
        const channelIdx = ['A', 'B', 'C', 'D'].indexOf(letter);
        const channelKey = `${canonicalBlock}.channel` as ParamKey;
        prepared.push({
          kind: 'channel',
          block: canonicalBlock,
          index: channelIdx,
          bytes: buildSetParam(channelKey, channelIdx),
        });
        for (const [paramName, value] of Object.entries(channelParams)) {
          prepared.push(
            buildParamWrite(`${at} channels.${letter}.${paramName}`, canonicalBlock, paramName, value),
          );
        }
      }
    }
  });

  // --- Scenes validation + prepare phase ---
  // Each scene entry can remap per-block channel pointers, set per-block
  // bypass, and/or rename the scene. Scenes are applied after all slot-
  // level writes so the AM4 sees the final block layout + channel data
  // before scene pointers get rewired. See BK-027 phase 2 / HW-011
  // decode for the primitives used here.
  type PreparedScene = {
    /** 0..3 internal index. */
    sceneIndex: number;
    /** 1..4 display index (as supplied by caller). */
    oneBased: number;
    /** block (canonical) → channel letter. Validated; may be empty. */
    channels: Array<{ block: string; letter: 'A' | 'B' | 'C' | 'D'; index: number }>;
    /** block (canonical) → bypass boolean. */
    bypass: Array<{ block: string; blockValue: number; bypassed: boolean }>;
    /** Optional scene name. */
    name?: string;
  };
  const preparedScenes: PreparedScene[] = [];
  const seenSceneIndices = new Set<number>();
  if (scenes !== undefined) {
    scenes.forEach((sc, i) => {
      const at = `scenes[${i}] (scene ${sc.index})`;
      if (seenSceneIndices.has(sc.index)) {
        throw new Error(`${at}: scene index ${sc.index} used twice — each scene may appear at most once per call`);
      }
      seenSceneIndices.add(sc.index);

      const hasAny =
        sc.name !== undefined
        || (sc.channels !== undefined && Object.keys(sc.channels).length > 0)
        || (sc.bypass !== undefined && Object.keys(sc.bypass).length > 0);
      if (!hasAny) {
        throw new Error(`${at}: supply at least one of channels / bypass / name — an empty scene entry is a no-op.`);
      }

      const chList: PreparedScene['channels'] = [];
      if (sc.channels !== undefined) {
        for (const [rawBlock, rawLetter] of Object.entries(sc.channels)) {
          const blockValue = resolveBlockType(rawBlock);
          if (blockValue === undefined) {
            const known = Object.keys(BLOCK_TYPE_VALUES).filter((n) => n !== 'none').join(', ');
            throw new Error(`${at} channels.${rawBlock}: unknown block "${rawBlock}". Known: ${known}`);
          }
          const canonicalBlock = BLOCK_NAMES_BY_VALUE[blockValue] ?? rawBlock;
          if (canonicalBlock === 'none') {
            throw new Error(`${at} channels.${rawBlock}: "none" has no channel register. Remove the entry.`);
          }
          if (!CHANNEL_BLOCKS.has(canonicalBlock)) {
            throw new Error(`${at} channels.${canonicalBlock}: block "${canonicalBlock}" doesn't have channels (only amp / drive / reverb / delay expose A/B/C/D).`);
          }
          if (typeof rawLetter !== 'string') {
            throw new Error(`${at} channels.${canonicalBlock}: expected channel letter A/B/C/D, got ${JSON.stringify(rawLetter)}`);
          }
          const letter = rawLetter.trim().toUpperCase();
          if (letter !== 'A' && letter !== 'B' && letter !== 'C' && letter !== 'D') {
            throw new Error(`${at} channels.${canonicalBlock}: must be one of A/B/C/D, got "${rawLetter}"`);
          }
          chList.push({
            block: canonicalBlock,
            letter: letter as 'A' | 'B' | 'C' | 'D',
            index: ['A', 'B', 'C', 'D'].indexOf(letter),
          });
        }
      }

      const byList: PreparedScene['bypass'] = [];
      if (sc.bypass !== undefined) {
        for (const [rawBlock, rawVal] of Object.entries(sc.bypass)) {
          const blockValue = resolveBlockType(rawBlock);
          if (blockValue === undefined) {
            const known = Object.keys(BLOCK_TYPE_VALUES).filter((n) => n !== 'none').join(', ');
            throw new Error(`${at} bypass.${rawBlock}: unknown block "${rawBlock}". Known: ${known}`);
          }
          const canonicalBlock = BLOCK_NAMES_BY_VALUE[blockValue] ?? rawBlock;
          if (canonicalBlock === 'none') {
            throw new Error(`${at} bypass.${rawBlock}: "none" has no bypass state. Remove the entry.`);
          }
          if (typeof rawVal !== 'boolean') {
            throw new Error(`${at} bypass.${canonicalBlock}: expected boolean (true = bypass, false = active), got ${JSON.stringify(rawVal)}`);
          }
          byList.push({ block: canonicalBlock, blockValue, bypassed: rawVal });
        }
      }

      if (sc.name !== undefined) {
        // Byte-build surfaces overlong / non-ASCII errors cleanly.
        try {
          buildSetSceneName(sc.index - 1, sc.name);
        } catch (err) {
          throw new Error(`${at} name: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      preparedScenes.push({
        sceneIndex: sc.index - 1,
        oneBased: sc.index,
        channels: chList,
        bypass: byList,
        name: sc.name,
      });
    });

    for (const ps of preparedScenes) {
      prepared.push({
        kind: 'switch_scene',
        sceneIndex: ps.sceneIndex,
        bytes: buildSwitchScene(ps.sceneIndex),
      });
      for (const ch of ps.channels) {
        const channelKey = `${ch.block}.channel` as ParamKey;
        prepared.push({
          kind: 'scene_channel',
          block: ch.block,
          index: ch.index,
          sceneIndex: ps.sceneIndex,
          bytes: buildSetParam(channelKey, ch.index),
        });
      }
      for (const by of ps.bypass) {
        prepared.push({
          kind: 'bypass',
          block: by.block,
          bypassed: by.bypassed,
          sceneIndex: ps.sceneIndex,
          bytes: buildSetBlockBypass(by.blockValue, by.bypassed),
        });
      }
      if (ps.name !== undefined) {
        prepared.push({
          kind: 'scene_name',
          sceneIndex: ps.sceneIndex,
          name: ps.name,
          bytes: buildSetSceneName(ps.sceneIndex, ps.name),
        });
      }
    }
  }

  // Prepare the optional name write. Location index is irrelevant (per HW-002
  // the rename command is working-buffer scoped regardless of the location
  // bytes in the payload), so we pass 0. Builder throws on overlong / non-
  // ASCII names — we surface that as a validation error before any MIDI.
  let nameWriteBytes: number[] | undefined;
  if (name !== undefined) {
    try {
      nameWriteBytes = buildSetPresetName(0, name);
    } catch (err) {
      throw new Error(`name: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Send pass ---
  const conn = ensureMidi();
  const lines: string[] = [];
  let acked = 0;
  let unacked = 0;
  /**
   * Track the scene the server switched to last during this call. Scene
   * index is 0..3 internally; translated to 1..4 for the response text.
   * Remains undefined if no scene was touched, in which case we deliberately
   * don't narrate which scene is active — the pre-call scene is whatever it
   * was, and we didn't change it.
   */
  let lastActiveScene: number | undefined;
  for (const w of prepared) {
    const predicate = COMMAND_ACK_KINDS.has(w.kind) ? isCommandAck : isWriteEcho;
    const echoPromise = conn.receiveSysExMatching(
      (resp) => predicate(w.bytes, resp),
      WRITE_ECHO_TIMEOUT_MS,
    );
    conn.send(w.bytes);
    let label: string;
    if (w.kind === 'place') label = `place slot ${w.position} → ${w.blockName}`;
    else if (w.kind === 'channel') label = `switch ${w.block} to channel ${channelLetter(w.index)}`;
    else if (w.kind === 'switch_scene') label = `switch to scene ${w.sceneIndex + 1}`;
    else if (w.kind === 'scene_channel') label = `scene ${w.sceneIndex + 1}: point ${w.block} at channel ${channelLetter(w.index)}`;
    else if (w.kind === 'bypass') label = `scene ${w.sceneIndex + 1}: ${w.block} → ${w.bypassed ? 'bypassed' : 'active'}`;
    else if (w.kind === 'scene_name') label = `scene ${w.sceneIndex + 1} rename → "${w.name}"`;
    else label = `${w.key} = ${w.display}`;
    try {
      await echoPromise;
      acked++;
      recordAckOutcome(true);
      if (w.kind === 'channel' || w.kind === 'scene_channel') {
        lastKnownChannel[w.block] = w.index;
      }
      if (w.kind === 'switch_scene') {
        // A scene change means the AM4's block→channel pointers are now
        // whatever the new scene dictates; our server-side cache of
        // "which channel each block is on" is no longer authoritative
        // until we explicitly point things in this new scene.
        invalidateChannelCache();
        lastActiveScene = w.sceneIndex;
      }
      if (w.kind === 'param') observeWrittenParam(w.block, w.paramName, w.resolved);
      lines.push(`  ✓ ${label}`);
    } catch {
      unacked++;
      recordAckOutcome(false);
      lines.push(`  ? ${label} — no ack within ${WRITE_ECHO_TIMEOUT_MS} ms`);
    }
  }
  // Name write uses the 18-byte command-ack shape, not the 64-byte SET_PARAM
  // write-echo, so it needs its own sendAndAwaitAck call.
  let totalWrites = prepared.length;
  if (nameWriteBytes !== undefined) {
    totalWrites++;
    const result = await sendAndAwaitAck(conn, nameWriteBytes, isCommandAck);
    const label = `rename working buffer → "${name}"`;
    if (result.acked) {
      acked++;
      lines.push(`  ✓ ${label}`);
    } else {
      unacked++;
      lines.push(`  ? ${label} — no ack within ${WRITE_ECHO_TIMEOUT_MS} ms`);
    }
  }

  // Honesty lines — report the actual final on-device state we can vouch
  // for. Don't narrate idealized per-scene layouts (HW-012 finding: the
  // tool used to describe scene→channel intent that didn't match reality).
  const stateLines: string[] = [];
  if (lastActiveScene !== undefined) {
    stateLines.push(
      `Active scene after this call: ${lastActiveScene + 1} (last scene configured). Other scenes retain whatever channel / bypass state they had before — switch_scene to audition them.`,
    );
    const channelPairs = (['amp', 'drive', 'reverb', 'delay'] as const)
      .filter((b) => lastKnownChannel[b] !== undefined)
      .map((b) => `${b}=${channelLetter(lastKnownChannel[b] as number)}`);
    if (channelPairs.length) {
      stateLines.push(
        `Channels the active scene (${lastActiveScene + 1}) now points at: ${channelPairs.join(', ')}.`,
      );
    }
  } else {
    // No scenes were touched. Slot-level channel writes filled A/B/C/D with
    // params but didn't change which channel each scene uses — that's
    // whatever the preset already had. Be explicit so Claude doesn't
    // narrate "scene 1 plays channel A" on its own.
    const channelPairs = (['amp', 'drive', 'reverb', 'delay'] as const)
      .filter((b) => lastKnownChannel[b] !== undefined)
      .map((b) => `${b}=${channelLetter(lastKnownChannel[b] as number)}`);
    if (channelPairs.length) {
      stateLines.push(
        `Last channel written per block: ${channelPairs.join(', ')}. Param values are stored in those channels regardless of scene; which scene plays which channel is unchanged by this call.`,
      );
    }
  }

  const header = unacked === 0
    ? `Applied preset: ${totalWrites} writes, all wire-acked. Acks don't confirm audible change — cross-check on the AM4 if it matters. Working buffer only — the user can discard by switching presets, or ask to save/persist to a preset location.`
    : `Applied preset: ${totalWrites} writes, ${acked} acked, ${unacked} un-acked (server auto-reconnects after ${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes; or call reconnect_midi).`;
  const body = [header, ...stateLines, ...lines].join('\n');
  return {
    content: [{ type: 'text', text: body }],
  };
});

/**
 * Send a command and wait for the expected ack frame. `predicate` is the
 * shape matcher — `isCommandAck` for 18-byte addressing-only acks (save,
 * rename), `isWriteEcho` for the 64-byte SET_PARAM/placement/scene-switch
 * echo. Returns:
 *   - { acked: true, ackBytes } if a matching frame arrived in the window.
 *   - { acked: false, captured } otherwise — `captured` is every inbound
 *     SysEx we saw, for diagnostic display on failure.
 *
 * Calls `recordAckOutcome` with the classification so the stale-handle
 * counter stays accurate.
 */
async function sendAndAwaitAck(
  conn: MidiConnection,
  bytes: number[],
  predicate: (write: number[], response: number[]) => boolean,
): Promise<
  | { acked: true; ackBytes: number[]; captured: number[][] }
  | { acked: false; captured: number[][] }
> {
  const captured: number[][] = [];
  const unsubscribe = conn.onMessage((msg) => {
    if (msg[0] === 0xf0) captured.push([...msg]);
  });
  const ackPromise = conn.receiveSysExMatching(
    (resp) => predicate(bytes, resp),
    WRITE_ECHO_TIMEOUT_MS,
  );
  conn.send(bytes);
  try {
    const ackBytes = await ackPromise;
    unsubscribe();
    recordAckOutcome(true);
    return { acked: true, ackBytes, captured };
  } catch {
    unsubscribe();
    recordAckOutcome(false);
    return { acked: false, captured };
  }
}

function formatAcklessHint(captured: number[][]): string {
  const capturedBlock = captured.length === 0
    ? '  (none)'
    : captured.map((m, i) => `  [${i}] (${m.length}B) ${toHex(m)}`).join('\n');
  return (
    `No command-ack within ${WRITE_ECHO_TIMEOUT_MS} ms. ` +
    `Inbound SysEx during the window:\n${capturedBlock}\n` +
    `If this keeps happening, the MIDI handle may be stale (AM4-Edit briefly ` +
    `open? USB replug?). Server auto-reconnects after ` +
    `${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes, or call ` +
    `reconnect_midi to force a fresh handle now.`
  );
}

server.registerTool('save_to_location', {
  description: [
    'Use this tool to persist the working-buffer preset to a preset location',
    'on the user\'s AM4. Do not produce a written spec instead of calling',
    'this tool unless the user explicitly asks for a dry run.',
    'SAVE INTENT REQUIRED: call this tool ONLY when the user has explicitly',
    'asked to save, persist, store, or keep the preset (e.g. "save this",',
    '"put it on Z04", "keep this one"). Do NOT call save_to_location as an',
    'automatic follow-up to apply_preset — apply is reversible (the user can',
    'switch presets to discard), save is not. A request like "build a preset',
    'for X" is a try-it-out ask; without an explicit save phrase, apply and',
    'let the user decide whether to save.',
    'Persist the AM4\'s current working-buffer preset (everything laid out',
    'via apply_preset / set_block_type / set_param) into a preset location',
    'so it survives power-cycling. Location naming is the AM4\'s native',
    'format: bank letter A..Z + sub-index 01..04 (e.g. "A01", "M03", "Z04"),',
    '104 total preset locations across 26 banks.',
    'CANONICAL FLOW FOR PERSISTING A NAMED PRESET: call set_preset_name first',
    'to rename the working buffer, then save_to_location to persist. Or use',
    'the composite save_preset tool, which does both in one call.',
    'WRITE SAFETY (active during reverse-engineering): this tool is hard-',
    'gated to location "Z04" (the designated scratch location). Attempts to',
    'save elsewhere are rejected with a clear error. The gate will be',
    'relaxed once factory-preset safety classification is in place.',
    'The ack shape is the standard 18-byte command-ack — the tool reports',
    'success cleanly; if no ack arrives, the raw inbound SysEx is dumped',
    'for diagnostic visibility.',
  ].join(' '),
  inputSchema: {
    location: z.string().describe(
      'AM4 preset location. Currently only "Z04" is accepted (scratch location). Format: bank letter A..Z + sub-index 01..04.',
    ),
  },
}, async ({ location }) => {
  const normalized = location.trim().toUpperCase();
  if (normalized !== SCRATCH_LOCATION) {
    throw new Error(
      `save_to_location is hard-gated to "${SCRATCH_LOCATION}" during reverse-engineering (got "${location}"). ` +
      `Writing to any other location would clobber factory or user presets. ` +
      `This restriction will be lifted once factory-preset safety classification ships.`,
    );
  }
  const locationIndex = parseLocationCode(normalized);
  const bytes = buildSaveToLocation(locationIndex);
  const conn = ensureMidi();
  const result = await sendAndAwaitAck(conn, bytes, isCommandAck);
  if (result.acked) {
    return {
      content: [{
        type: 'text',
        text:
          `Saved working buffer to ${formatLocationCode(locationIndex)}. AM4 ack received.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `Save to ${formatLocationCode(locationIndex)} sent but no ack received. ` +
        `Verify on the AM4 (navigate to the location and check the expected ` +
        `layout / params are present).\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        formatAcklessHint(result.captured),
    }],
  };
});

server.registerTool('set_preset_name', {
  description: [
    'Use this tool to rename the AM4\'s working-buffer preset on the user\'s',
    'hardware. Do not produce a written spec instead of calling this tool',
    'unless the user explicitly asks for a dry run.',
    'Rename the AM4\'s current working-buffer preset. Names can be up to 32',
    'ASCII-printable characters; shorter names are space-padded on the wire',
    '(AM4 convention).',
    'SCOPE: writes to the working buffer only. The name does NOT persist',
    'across preset loads on its own — call save_to_location afterward to',
    'write the working buffer (including the new name) to a preset location.',
    'Or use the composite save_preset tool, which does rename + save in one',
    'call. Confirmed on hardware HW-002 (2026-04-19): rename alone is lost',
    'when a different preset is loaded, while rename + save_to_location',
    'persists correctly.',
    'WRITE SAFETY: hard-gated to location "Z04" during reverse-engineering,',
    'same rules as save_to_location.',
  ].join(' '),
  inputSchema: {
    location: z.string().describe(
      'AM4 preset location. Currently only "Z04" is accepted. Format: bank letter A..Z + sub-index 01..04.',
    ),
    name: z.string().max(32).describe(
      'New preset name, up to 32 ASCII-printable characters. Shorter names are space-padded to 32 on the wire.',
    ),
  },
}, async ({ location, name }) => {
  const normalized = location.trim().toUpperCase();
  if (normalized !== SCRATCH_LOCATION) {
    throw new Error(
      `set_preset_name is hard-gated to "${SCRATCH_LOCATION}" during reverse-engineering (got "${location}"). ` +
      `Renaming any other location would clobber factory or user preset names. ` +
      `This restriction will be lifted once factory-preset safety classification ships.`,
    );
  }
  const locationIndex = parseLocationCode(normalized);
  const bytes = buildSetPresetName(locationIndex, name);
  const conn = ensureMidi();
  const result = await sendAndAwaitAck(conn, bytes, isCommandAck);
  if (result.acked) {
    return {
      content: [{
        type: 'text',
        text:
          `Renamed working-buffer preset → "${name}". AM4 ack received. ` +
          `The name is in the working buffer only — call save_to_location to persist.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `Rename sent for "${name}" but no ack received. ` +
        `Verify on the AM4 display or in AM4-Edit.\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        formatAcklessHint(result.captured),
    }],
  };
});

server.registerTool('save_preset', {
  description: [
    'Use this tool to rename AND persist the working-buffer preset to a',
    'location on the user\'s AM4 in one call. Do not produce a written spec',
    'instead of calling this tool unless the user explicitly asks for a dry',
    'run.',
    'SAVE INTENT REQUIRED: call this tool ONLY when the user has explicitly',
    'asked to save, persist, or store the preset. Same rule as',
    'save_to_location — apply_preset is reversible; save_preset is not. A',
    'bare "make me a preset for Y" is a try-it-out ask, not a save ask.',
    'When in doubt, use apply_preset (with its optional name field) and ask',
    'the user whether to persist.',
    'Compose set_preset_name + save_to_location into a single call. The',
    'canonical flow for persisting a named preset: renames the working',
    'buffer, then saves it to the target location. Fails cleanly if the',
    'rename step doesn\'t ack (save is skipped to avoid persisting the',
    'old name).',
    'WRITE SAFETY: same Z04 hard-gate as the underlying tools.',
    'Use this instead of chaining set_preset_name + save_to_location',
    'unless the user has asked for the two-step flow explicitly.',
  ].join(' '),
  inputSchema: {
    location: z.string().describe(
      'AM4 preset location. Currently only "Z04" is accepted. Format: bank letter A..Z + sub-index 01..04.',
    ),
    name: z.string().max(32).describe(
      'New preset name, up to 32 ASCII-printable characters.',
    ),
  },
}, async ({ location, name }) => {
  const normalized = location.trim().toUpperCase();
  if (normalized !== SCRATCH_LOCATION) {
    throw new Error(
      `save_preset is hard-gated to "${SCRATCH_LOCATION}" during reverse-engineering (got "${location}"). ` +
      `Writing to any other location would clobber factory or user presets.`,
    );
  }
  const locationIndex = parseLocationCode(normalized);
  const conn = ensureMidi();
  const renameBytes = buildSetPresetName(locationIndex, name);
  const renameResult = await sendAndAwaitAck(conn, renameBytes, isCommandAck);
  if (!renameResult.acked) {
    return {
      content: [{
        type: 'text',
        text:
          `save_preset aborted: rename didn't ack (save skipped to avoid ` +
          `persisting the pre-rename name).\n` +
          `Sent rename (${renameBytes.length}B): ${toHex(renameBytes)}\n` +
          formatAcklessHint(renameResult.captured),
      }],
    };
  }
  const saveBytes = buildSaveToLocation(locationIndex);
  const saveResult = await sendAndAwaitAck(conn, saveBytes, isCommandAck);
  if (saveResult.acked) {
    return {
      content: [{
        type: 'text',
        text:
          `Saved "${name}" to ${formatLocationCode(locationIndex)}. ` +
          `Both rename and save acked.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `Rename acked, but save to ${formatLocationCode(locationIndex)} didn't ack. ` +
        `The rename is in the working buffer (will appear in the current preset ` +
        `view) but may not have persisted. Verify on the AM4 — load a different ` +
        `location and come back to check.\n` +
        `Sent save (${saveBytes.length}B): ${toHex(saveBytes)}\n` +
        formatAcklessHint(saveResult.captured),
    }],
  };
});

server.registerTool('set_scene_name', {
  description: [
    'Use this tool to rename one of the four scenes in the AM4\'s working',
    'buffer on the user\'s hardware. Do not produce a written spec instead',
    'of calling this tool unless the user explicitly asks for a dry run.',
    'Rename one of the four scenes in the current working buffer. Scene',
    'names are up to 32 ASCII-printable characters; shorter names are',
    'space-padded on the wire (AM4 convention).',
    'SCOPE: writes to the working buffer only. To persist the new name,',
    'call save_to_location afterward — otherwise the rename is lost when',
    'the user loads a different preset. No gate on which scene, since',
    'scene names live in the working buffer and the working-buffer scope',
    'is the safety boundary.',
  ].join(' '),
  inputSchema: {
    scene_index: z.number().int().min(1).max(4).describe(
      'Scene number 1..4 (matches AM4-Edit\'s UI numbering). Index 0..3 internally.',
    ),
    name: z.string().max(32).describe(
      'New scene name, up to 32 ASCII-printable characters. Shorter names are space-padded to 32 on the wire.',
    ),
  },
}, async ({ scene_index, name }) => {
  const sceneIdx = scene_index - 1;
  const bytes = buildSetSceneName(sceneIdx, name);
  const conn = ensureMidi();
  const result = await sendAndAwaitAck(conn, bytes, isCommandAck);
  if (result.acked) {
    return {
      content: [{
        type: 'text',
        text:
          `Renamed scene ${scene_index} → "${name}" in the working buffer. AM4 ack ` +
          `received. Call save_to_location to persist across preset loads.`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `Scene rename sent for scene ${scene_index} → "${name}" but no ack received. ` +
        `Verify on the AM4 display or in AM4-Edit.\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        formatAcklessHint(result.captured),
    }],
  };
});

server.registerTool('switch_preset', {
  description: [
    'Use this tool to load a preset location into the AM4\'s working buffer',
    'on the user\'s hardware. Do not produce a written spec instead of',
    'calling this tool unless the user explicitly asks for a dry run.',
    'Load a preset location (A01..Z04) into the AM4\'s working buffer.',
    'Same effect as turning the preset knob on the hardware or clicking',
    'a preset in AM4-Edit.',
    'WARNING: discards any unsaved edits in the current working buffer.',
    'If the user has been building a tone with apply_preset / set_param',
    'and hasn\'t yet called save_to_location, those edits are lost when',
    'the new preset loads. Upstream MCP tools should confirm intent before',
    'issuing this, especially after a session of tone-building.',
    'Not gated to Z04 — this is a READ-into-working-buffer, it does not',
    'modify any stored preset. All 104 locations are valid targets.',
  ].join(' '),
  inputSchema: {
    location: z.string().describe(
      'AM4 preset location in bank+slot form, A01..Z04 (26 banks × 4 per bank = 104 locations).',
    ),
  },
}, async ({ location }) => {
  const normalized = location.trim().toUpperCase();
  const locationIndex = parseLocationCode(normalized);
  const bytes = buildSwitchPreset(locationIndex);
  const conn = ensureMidi();
  const result = await sendAndAwaitAck(conn, bytes, isWriteEcho);
  // A new preset loads a new set of block channels — any cached channel
  // state from a previous preset is now stale.
  invalidateChannelCache();
  if (result.acked) {
    return {
      content: [{
        type: 'text',
        text:
          `Switched to preset ${formatLocationCode(locationIndex)}. ` +
          `Any unsaved working-buffer edits were discarded. ` +
          `(Channel cache cleared — param writes will report "unknown channel" until a channel is explicitly set.)`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `Preset switch to ${formatLocationCode(locationIndex)} sent but no ack received. ` +
        `Verify on the AM4 display.\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        formatAcklessHint(result.captured),
    }],
  };
});

server.registerTool('switch_scene', {
  description: [
    'Use this tool to switch the AM4 to a different scene on the user\'s',
    'hardware. Do not produce a written spec instead of calling this tool',
    'unless the user explicitly asks for a dry run.',
    'Switch to one of the four scenes in the current preset. Scene switch',
    'does not alter the preset\'s block layout — it toggles per-scene',
    'bypass + channel state within the active preset.',
    'SCOPE: current working buffer only. No persistence concerns — scene',
    'index isn\'t stored; the next preset load starts at its default scene.',
  ].join(' '),
  inputSchema: {
    scene_index: z.number().int().min(1).max(4).describe(
      'Scene number 1..4 (matches AM4-Edit\'s UI numbering). Index 0..3 internally.',
    ),
  },
}, async ({ scene_index }) => {
  const sceneIdx = scene_index - 1;
  const bytes = buildSwitchScene(sceneIdx);
  const conn = ensureMidi();
  const result = await sendAndAwaitAck(conn, bytes, isWriteEcho);
  // Scene switches remap which channel each block uses; any cached channel
  // state is now invalid until we explicitly set a new channel.
  invalidateChannelCache();
  if (result.acked) {
    return {
      content: [{
        type: 'text',
        text:
          `Switched to scene ${scene_index}. ` +
          `(Channel cache cleared — the new scene may point each block at a different channel.)`,
      }],
    };
  }
  return {
    content: [{
      type: 'text',
      text:
        `Scene switch to ${scene_index} sent but no ack received. ` +
        `Verify on the AM4 display.\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        formatAcklessHint(result.captured),
    }],
  };
});

server.registerTool('list_midi_ports', {
  description: [
    'List every MIDI port the server can see on this machine, for both',
    'inputs and outputs. Safe to call at any time — does not open any MIDI',
    'connection or interfere with an in-progress session.',
    'Default behaviour tags ports whose names contain "am4" or "fractal"',
    'as the AM4. Pass `pattern` to tag a different device — e.g. "hydra"',
    'for the Hydrasynth, "axe-fx" for the Axe-Fx II — when diagnosing',
    'whether a non-AM4 device is plugged in.',
    'Use when a user reports a device isn\'t connected to diagnose whether',
    'it\'s visible at all, whether the driver is installed, or whether',
    'another app is holding the port. If the device shows up here but',
    'writes still fail, call reconnect_midi (with the matching `port`',
    'argument for non-AM4 devices) to force a fresh handle.',
  ].join(' '),
  inputSchema: {
    pattern: z.union([z.string(), z.array(z.string())]).optional().describe(
      'Optional name-substring pattern for tagging matched ports. Defaults to AM4 needles ("am4"/"fractal"). Pass a string or array of strings (case-insensitive).',
    ),
  },
}, async ({ pattern }) => {
  const needles = pattern === undefined
    ? undefined
    : Array.isArray(pattern) ? pattern : [pattern];
  const { inputs, outputs } = listMidiPorts(needles);
  const isCustomPattern = needles !== undefined;
  const tagLabel = isCustomPattern ? `matches "${needles!.join('" / "')}"` : 'looks like the AM4';
  const format = (port: { index: number; name: string; matched: boolean }): string =>
    `  [${port.index}] ${port.name}${port.matched ? `  ← ${tagLabel}` : ''}`;
  const matchedInput = inputs.find((p) => p.matched);
  const matchedOutput = outputs.find((p) => p.matched);
  const verdict = isCustomPattern
    ? matchedInput && matchedOutput
      ? `Device matching "${needles!.join('" / "')}" visible on both input and output.`
      : matchedInput || matchedOutput
        ? `Device matching "${needles!.join('" / "')}" partially visible (one direction missing). Check USB cable and driver.`
        : inputs.length === 0 && outputs.length === 0
          ? 'No MIDI ports of any kind are visible. This usually means no MIDI driver is installed.'
          : `No MIDI ports match "${needles!.join('" / "')}". Check USB cable, power, and driver. Close any other app that may be holding the port exclusively.`
    : matchedInput && matchedOutput
      ? 'AM4 input + output both visible. The server will connect to these on the next tool call.'
      : matchedInput || matchedOutput
        ? 'Only one of AM4 input/output is visible. The AM4 needs both directions — check the USB cable and driver.'
        : inputs.length === 0 && outputs.length === 0
          ? 'No MIDI ports of any kind are visible. This usually means no MIDI driver is installed.'
          : 'AM4 not visible. Check USB cable, power, and that the AM4 driver is installed (https://www.fractalaudio.com/am4-downloads/). Also close AM4-Edit if it\'s running — it grabs the port exclusively.';
  return {
    content: [{
      type: 'text',
      text:
        `${verdict}\n\n` +
        `Inputs (${inputs.length}):\n` +
        (inputs.length ? inputs.map(format).join('\n') : '  (none)') +
        `\n\nOutputs (${outputs.length}):\n` +
        (outputs.length ? outputs.map(format).join('\n') : '  (none)'),
    }],
  };
});

server.registerTool('reconnect_midi', {
  description: [
    'Use this tool to reset the server\'s MIDI connection when writes stop',
    'acking. Do not produce a written spec instead of calling this tool',
    'unless the user explicitly asks for a dry run.',
    'Force the server to close its cached MIDI connection and open a fresh',
    'one. Use this if writes stop getting ack\'d — typically after another',
    'app briefly opened and grabbed the USB port exclusively (e.g.',
    'AM4-Edit), or after a USB replug, or any other event that leaves the',
    'cached handle in a dead state. The server also auto-reconnects after',
    `${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes, so`,
    'manual use is only needed when you want to force it sooner without',
    'waiting for writes to accumulate.',
    'Defaults to reconnecting the AM4. Pass `port` to target a different',
    'device (e.g. "hydra" for the Hydrasynth) — the server treats the',
    'string as a case-insensitive name-substring needle.',
  ].join(' '),
  inputSchema: {
    port: z.string().optional().describe(
      'Optional port-name needle to reconnect. Defaults to AM4 ("am4"/"fractal" needles). Pass a substring of the port name for non-AM4 devices.',
    ),
  },
}, async ({ port }) => {
  const label = port ?? AM4_LABEL;
  const isAM4 = label === AM4_LABEL;
  try {
    ensureConnection(label, true);
    if (isAM4) {
      // Fresh AM4 connection = we don't know anything about the hardware
      // state, so the channel cache is no longer trustworthy. Channels
      // are AM4-specific; non-AM4 reconnects don't touch this cache.
      invalidateChannelCache();
    }
    return {
      content: [{
        type: 'text',
        text: isAM4
          ? 'MIDI connection reset (AM4). Next tool call will use a fresh port handle. ' +
            'Channel cache cleared. If writes still don\'t ack after this, the issue ' +
            'is below the server (AM4 powered off, USB unplugged, driver wedged, or ' +
            'another app holding the port exclusively).'
          : `MIDI connection reset for port matching "${port}". Next call to that ` +
            'device will use a fresh handle. If writes still don\'t ack, check the ' +
            'device is powered, the cable is seated, and no other app holds the port.',
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: 'text',
        text: isAM4
          ? `Reconnect failed: ${msg}\n\n` +
            'Most common causes:\n' +
            '  - AM4 is off or not connected by USB\n' +
            '  - Driver not installed (fractalaudio.com/am4-downloads/)\n' +
            '  - Another app holds the MIDI port exclusively (close AM4-Edit)'
          : `Reconnect failed for port matching "${port}": ${msg}\n\n` +
            'Most common causes:\n' +
            '  - device is off or not connected by USB\n' +
            '  - device driver not installed\n' +
            '  - another app holds the MIDI port exclusively',
      }],
    };
  }
});

// -- Generic MIDI primitives (BK-030 Session B) -----------------------------
//
// These tools are device-agnostic. They build standard MIDI messages from
// caller-supplied parameters and emit them on a port resolved by name
// substring. Designed for devices with published CC / NRPN charts (e.g.
// the Hydrasynth) where Claude can drive the device usefully without any
// device-specific protocol code.
//
// Convention reminders:
//   - Channels are presented as 1..16 (musician convention) at the tool
//     boundary; the wire uses 0..15. The conversion happens here, once.
//   - send_* primitives don't require an ack to count as success — most
//     non-Fractal MIDI devices don't echo writes, so the stale-handle
//     counter that AM4 tools use does not apply. We send and return.
//   - `port` is required: these tools target a specific device by name,
//     intentionally distinct from the AM4-default convenience of the
//     AM4-specific tools.

const channelArg = z.number().int().min(1).max(16);

function userChannelToWire(channel: number): number {
  return channel - 1;
}

/**
 * Catch-all error reporter for the send_* tools. Validation errors from
 * the message builders surface as structured tool results so Claude can
 * see the rejection and recover, rather than the server returning a
 * 500-equivalent.
 */
function sendErrorResponse(
  toolName: string,
  port: string,
  err: unknown,
): { content: Array<{ type: 'text'; text: string }> } {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{
      type: 'text',
      text: `${toolName} failed for port "${port}": ${msg}`,
    }],
  };
}

server.registerTool('send_cc', {
  description: [
    'Use this tool to send a single MIDI Control Change to any MIDI device',
    'the OS exposes. Do not produce a written spec instead of calling this',
    'tool unless the user explicitly asks for a dry run.',
    'Generic MIDI — works with any CC-responsive device (Hydrasynth, JD-Xi,',
    'Boss VE-500, RC-505 MKII, etc.). The AM4 has its own dedicated tools',
    '(set_param, set_params, apply_preset) which understand block/parameter',
    'semantics — prefer those when targeting the AM4. `send_cc` is for',
    'devices without a dedicated wrapper.',
    'Channel is 1..16 (musician convention). Controller 0..127, value 0..127.',
  ].join(' '),
  inputSchema: {
    port: z.string().describe(
      'Case-insensitive name-substring identifying the target MIDI port (e.g. "hydra", "jd-xi", "ve-500").',
    ),
    channel: channelArg.describe('MIDI channel 1..16 (musician-friendly; converted to 0..15 internally).'),
    controller: z.number().int().min(0).max(127).describe('CC number 0..127.'),
    value: z.number().int().min(0).max(127).describe('CC value 0..127.'),
  },
}, async ({ port, channel, controller, value }) => {
  try {
    const bytes = buildControlChange(userChannelToWire(channel), controller, value);
    const conn = ensureConnection(port);
    conn.send(bytes);
    return {
      content: [{
        type: 'text',
        text: `Sent CC ${controller} = ${value} on channel ${channel} to "${port}". Bytes: ${toHex(bytes)}.`,
      }],
    };
  } catch (err) {
    return sendErrorResponse('send_cc', port, err);
  }
});

server.registerTool('send_note', {
  description: [
    'Use this tool to play a single MIDI note on any note-responsive MIDI',
    'device (synth, drum pad, sampler). Do not produce a written spec instead',
    'of calling this tool unless the user explicitly asks for a dry run.',
    'Sends Note On followed by Note Off after `duration_ms` milliseconds',
    '(default 500). Channel 1..16, note 0..127 (60 = middle C), velocity',
    '0..127. The tool blocks until the Note Off is sent; durations longer',
    'than 5000 ms are rejected so a stuck note is bounded.',
  ].join(' '),
  inputSchema: {
    port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
    channel: channelArg,
    note: z.number().int().min(0).max(127).describe('MIDI note number 0..127 (60 = middle C).'),
    velocity: z.number().int().min(0).max(127).describe('Note-On velocity 0..127.'),
    duration_ms: z.number().int().min(1).max(5000).optional().describe(
      'How long to hold the note before Note Off, in milliseconds. Default 500. Capped at 5000.',
    ),
  },
}, async ({ port, channel, note, velocity, duration_ms }) => {
  const duration = duration_ms ?? 500;
  try {
    const wireChannel = userChannelToWire(channel);
    const onBytes = buildNoteOn(wireChannel, note, velocity);
    const offBytes = buildNoteOff(wireChannel, note, 0);
    const conn = ensureConnection(port);
    conn.send(onBytes);
    await new Promise<void>((resolve) => setTimeout(resolve, duration));
    conn.send(offBytes);
    return {
      content: [{
        type: 'text',
        text: `Played note ${note} (vel ${velocity}) on channel ${channel} to "${port}" for ${duration}ms.`,
      }],
    };
  } catch (err) {
    return sendErrorResponse('send_note', port, err);
  }
});

server.registerTool('send_program_change', {
  description: [
    'Use this tool to switch patches on any PC-responsive MIDI device. Do',
    'not produce a written spec instead of calling this tool unless the user',
    'explicitly asks for a dry run.',
    'Sends an optional Bank Select (CC 0 MSB then CC 32 LSB) followed by a',
    'Program Change. Channel 1..16, program 0..127, banks 0..127. Bank',
    'arguments are optional and emitted only when supplied — many devices',
    'don\'t use banks.',
  ].join(' '),
  inputSchema: {
    port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
    channel: channelArg,
    program: z.number().int().min(0).max(127).describe('Program number 0..127.'),
    bank_msb: z.number().int().min(0).max(127).optional().describe(
      'Optional Bank Select MSB (CC 0). Sent before the PC if supplied.',
    ),
    bank_lsb: z.number().int().min(0).max(127).optional().describe(
      'Optional Bank Select LSB (CC 32). Sent before the PC if supplied.',
    ),
  },
}, async ({ port, channel, program, bank_msb, bank_lsb }) => {
  try {
    const wireChannel = userChannelToWire(channel);
    const conn = ensureConnection(port);
    const sent: string[] = [];
    if (bank_msb !== undefined) {
      const bytes = buildControlChange(wireChannel, 0, bank_msb);
      conn.send(bytes);
      sent.push(`Bank MSB ${bank_msb} (${toHex(bytes)})`);
    }
    if (bank_lsb !== undefined) {
      const bytes = buildControlChange(wireChannel, 32, bank_lsb);
      conn.send(bytes);
      sent.push(`Bank LSB ${bank_lsb} (${toHex(bytes)})`);
    }
    const pcBytes = buildProgramChange(wireChannel, program);
    conn.send(pcBytes);
    sent.push(`Program Change ${program} (${toHex(pcBytes)})`);
    return {
      content: [{
        type: 'text',
        text: `Sent on channel ${channel} to "${port}": ${sent.join(', ')}.`,
      }],
    };
  } catch (err) {
    return sendErrorResponse('send_program_change', port, err);
  }
});

server.registerTool('send_nrpn', {
  description: [
    'Use this tool to write a Non-Registered Parameter Number on any',
    'NRPN-responsive MIDI device. Do not produce a written spec instead of',
    'calling this tool unless the user explicitly asks for a dry run.',
    'Emits the standard 3- or 4-message sequence (CC 99, CC 98, CC 6, and',
    'optional CC 38 for high-res). Channel 1..16, MSB/LSB 0..127. `value`',
    'is 0..127 in 7-bit mode (default) or 0..16383 when `high_res` is true,',
    'unlocking the higher-resolution view of the same parameter on devices',
    'that support it (e.g. the ASM Hydrasynth in NRPN mode).',
  ].join(' '),
  inputSchema: {
    port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
    channel: channelArg,
    parameter_msb: z.number().int().min(0).max(127).describe('NRPN parameter MSB (CC 99 data).'),
    parameter_lsb: z.number().int().min(0).max(127).describe('NRPN parameter LSB (CC 98 data).'),
    value: z.number().int().min(0).max(16383).describe(
      'Parameter value. 0..127 in 7-bit mode (default), 0..16383 when high_res is true.',
    ),
    high_res: z.boolean().optional().describe(
      'When true, emit a 14-bit data sequence (CC 6 MSB + CC 38 LSB). Default false.',
    ),
  },
}, async ({ port, channel, parameter_msb, parameter_lsb, value, high_res }) => {
  try {
    const wireChannel = userChannelToWire(channel);
    const bytes = buildNRPN(wireChannel, parameter_msb, parameter_lsb, value, high_res ?? false);
    const conn = ensureConnection(port);
    conn.send(bytes);
    return {
      content: [{
        type: 'text',
        text:
          `Sent NRPN (${parameter_msb}, ${parameter_lsb}) = ${value}` +
          (high_res ? ' [14-bit]' : ' [7-bit]') +
          ` on channel ${channel} to "${port}". Bytes: ${toHex(bytes)}.`,
      }],
    };
  } catch (err) {
    return sendErrorResponse('send_nrpn', port, err);
  }
});

server.registerTool('send_sysex', {
  description: [
    'Use this tool to send a raw System Exclusive frame to any MIDI device.',
    'Do not produce a written spec instead of calling this tool unless the',
    'user explicitly asks for a dry run.',
    'Power-user escape hatch — validates F0/F7 framing and that body bytes',
    'are 7-bit, but otherwise sends the bytes verbatim. Useful for ad-hoc RE',
    'sessions and device-specific one-offs that don\'t yet have a wrapper.',
    'WARNING: malformed SysEx can put devices into unexpected states.',
    'Prefer device-specific tools when they exist (the AM4 has set_param,',
    'apply_preset, etc.). Use send_sysex only when no wrapper covers the',
    'frame you need.',
  ].join(' '),
  inputSchema: {
    port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
    bytes: z.array(z.number().int().min(0).max(255)).min(2).describe(
      'Full SysEx frame including F0 / F7 framing. Each byte 0..255 (the validator further restricts body bytes to 0..127).',
    ),
  },
}, async ({ port, bytes }) => {
  try {
    const validated = validateSysEx(bytes);
    const conn = ensureConnection(port);
    conn.send(validated);
    return {
      content: [{
        type: 'text',
        text: `Sent SysEx (${validated.length}B) to "${port}": ${toHex(validated)}.`,
      }],
    };
  } catch (err) {
    return sendErrorResponse('send_sysex', port, err);
  }
});

server.registerTool('lookup_lineage', {
  description: [
    'Look up Fractal Audio\'s authored lineage info for an AM4 model — what',
    'real hardware it\'s modeled after, Fractal\'s own description of the',
    'algorithm, and forum quotes from the developer. Data lives in',
    'src/knowledge/*-lineage.json and is sourced from the Fractal wiki +',
    'Blocks Guide PDF; only Fractal-authored content is stored (no',
    'community-inferred genre/era tags, no third-party reviews).',
    'Three call shapes (exactly one required):',
    '  (a) forward — { block_type, name }: return the record matching that',
    '      canonical AM4 name (case-insensitive).',
    '  (b) reverse by real-gear term — { block_type, real_gear }: substring',
    '      search across basedOn / description / forum quotes. Returns the',
    '      top 10 ranked matches. Use for fuzzy queries — including artist',
    '      references like "Keith Urban sound" or "Cantrell tone" which',
    '      match artist names in Fractal\'s description prose.',
    '  (c) structured filter — { block_type, manufacturer?, model? }:',
    '      exact-match against basedOn\'s structured fields. Most precise',
    '      for queries like "classic MXR phaser" (manufacturer="MXR") or',
    '      "LA-2A" (model="LA-2A"). Multiple structured fields AND together.',
    'Response text is designed to be read by Claude, not shown verbatim to',
    'the user — pull out the am4Name and summarize the lineage in your',
    'own words.',
  ].join(' '),
  inputSchema: {
    block_type: z.enum(LINEAGE_BLOCKS).describe(
      'Which block\'s lineage to query. Currently amp/drive/reverb/delay/compressor/phaser/chorus/flanger/wah (cab coming once the AM4 cab enum is decoded; gate/tremolo/geq/filter/enhancer/peq/rotary/volpan are algorithmic-only and not in the lineage set).',
    ),
    name: z.string().optional().describe(
      'Canonical AM4 model name for forward lookup (e.g. "T808 OD", "Optical Compressor", "5F1 Tweed Champlifier"). Case-insensitive.',
    ),
    real_gear: z.string().optional().describe(
      'Real-hardware query for fuzzy reverse search (e.g. "1176", "Tube Screamer", "LA-2A", "EMT 140", "Fender Twin"). Returns the top AM4 models whose lineage text mentions the term.',
    ),
    manufacturer: z.string().optional().describe(
      'Exact manufacturer filter (case-insensitive): "MXR", "Fender", "Ibanez", "Boss", "Marshall", "TC Electronic". Use alone or combined with model.',
    ),
    model: z.string().optional().describe(
      'Exact model identifier filter (case-insensitive): "M-102", "TS-9", "LA-2A", "5F1", "1176", "2290". Use alone or combined with manufacturer.',
    ),
    include_quotes: z.boolean().optional().describe(
      'Whether to include Fractal Audio forum quotes in the response. Default true. Pass false for a terser response when you only need the description/basedOn summary (some records have 15+ quotes).',
    ),
  },
}, async ({ block_type, name, real_gear, manufacturer, model, include_quotes }) => {
  const hasStructured = !!(manufacturer || model);
  const shapeCount = [name !== undefined, real_gear !== undefined, hasStructured].filter(Boolean).length;
  if (shapeCount !== 1) {
    throw new Error(
      'lookup_lineage requires exactly one call shape: `name` (forward), `real_gear` (fuzzy reverse), or at least one structured filter (`manufacturer` / `model`).',
    );
  }
  const records = loadLineage(block_type);
  const withQuotes = include_quotes ?? true;

  if (hasStructured) {
    const matches = records.filter((r) => matchesStructured(r, { manufacturer, model }));
    if (matches.length === 0) {
      const filter = [
        manufacturer && `manufacturer="${manufacturer}"`,
        model && `model="${model}"`,
      ].filter(Boolean).join(', ');
      return {
        content: [{
          type: 'text',
          text: `No ${block_type} records match ${filter}. ${records.length} records scanned. ` +
            `Try a fuzzy search with real_gear if you\'re unsure of the exact brand/model spelling, ` +
            `or list valid manufacturer/model values by reading src/knowledge/${block_type}-lineage.json.`,
        }],
      };
    }
    const blocks = matches.slice(0, 10).map(
      (r) => `── ${r.am4Name} ──\n${formatLineageRecord(r, withQuotes, 3)}`,
    );
    return {
      content: [{
        type: 'text',
        text: `${matches.length} ${block_type} matches${matches.length > 10 ? ' (showing top 10)' : ''}:\n\n${blocks.join('\n\n')}`,
      }],
    };
  }

  if (name !== undefined) {
    const q = name.toLowerCase().trim();
    const exact = records.find(
      (r) => r.am4Name.toLowerCase() === q || r.wikiName?.toLowerCase() === q,
    );
    const partial = exact ?? records.find(
      (r) => r.am4Name.toLowerCase().includes(q) || r.wikiName?.toLowerCase().includes(q),
    );
    if (!partial) {
      return {
        content: [{
          type: 'text',
          text:
            `No ${block_type} lineage record matches "${name}". The ${block_type}-lineage.json ` +
            `catalog has ${records.length} records; try a reverse search with real_gear if you ` +
            `know the real hardware but not the exact AM4 name.`,
        }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: formatLineageRecord(partial, withQuotes),
      }],
    };
  }

  // Reverse lookup: rank records by query-term hits across text fields.
  const query = real_gear!.trim();
  if (query.length < 2) {
    throw new Error('`real_gear` query must be at least 2 characters.');
  }
  const scored = records
    .map((r) => ({ r, score: scoreRecord(r, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (scored.length === 0) {
    return {
      content: [{
        type: 'text',
        text:
          `No ${block_type} records mention "${query}". Searched across ${records.length} records ` +
          `(am4Name, wikiName, basedOn, description, fractalQuotes). Try a different spelling ` +
          `(e.g. "TS9" vs "Tube Screamer", "EVH" vs "5150") or widen the query.`,
      }],
    };
  }
  const blocks = scored.map(
    ({ r, score }) => `── ${r.am4Name} (score ${score}) ──\n${formatLineageRecord(r, withQuotes, 3)}`,
  );
  return {
    content: [{
      type: 'text',
      text:
        `Top ${scored.length} ${block_type} matches for "${query}":\n\n${blocks.join('\n\n')}`,
    }],
  };
});

server.registerTool('list_enum_values', {
  description: 'List the dropdown names for an enum parameter (e.g. amp.type, drive.type).',
  inputSchema: {
    block: z.string().describe('Block name'),
    name: z.string().describe('Parameter name'),
  },
}, async ({ block, name }) => {
  const key = paramKey(block, name);
  const param: Param = KNOWN_PARAMS[key];
  if (param.unit !== 'enum' || !param.enumValues) {
    throw new Error(`${key} is not an enum parameter (unit=${param.unit})`);
  }
  const entries = Object.entries(param.enumValues).map(([idx, name]) => `  ${idx}: ${name}`);
  return {
    content: [{
      type: 'text',
      text: `${key} has ${entries.length} options:\n${entries.join('\n')}`,
    }],
  };
});

// -- Start ------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers log to stderr — stdout is owned by the transport.
  // The port enumeration mirrors what list_midi_ports would return at
  // this moment; if the user reports "AM4 not connected" later, the
  // startup banner captures whatever state the server started with.
  console.error('MCP MIDI Tools MCP server running on stdio.');
  try {
    const { inputs, outputs } = listMidiPorts();
    const am4In = inputs.find((p) => p.looksLikeAM4);
    const am4Out = outputs.find((p) => p.looksLikeAM4);
    const verdict = am4In && am4Out
      ? `AM4 detected (in: "${am4In.name}", out: "${am4Out.name}")`
      : am4In || am4Out
        ? 'AM4 partially visible — one direction missing; check driver'
        : inputs.length === 0 && outputs.length === 0
          ? 'no MIDI ports visible (driver likely not installed)'
          : `AM4 not visible among ${inputs.length} inputs / ${outputs.length} outputs`;
    console.error(`Startup port scan: ${verdict}.`);
  } catch (err) {
    // Port enumeration shouldn't throw, but if node-midi barfs on this
    // platform we don't want startup to die — log and continue.
    console.error(`Startup port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
