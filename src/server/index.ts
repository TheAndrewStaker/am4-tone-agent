#!/usr/bin/env node
/**
 * AM4 Tone Agent — MCP server (stdio).
 *
 * Exposes Claude Desktop tools that talk to a local Fractal AM4 over
 * USB/MIDI. MVP tools:
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
 *   "am4": {
 *     "command": "npx",
 *     "args": ["tsx", "C:\\\\dev\\\\am4-tone-agent\\\\src\\\\server\\\\index.ts"],
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
import { connectAM4, type AM4Connection, toHex } from '../protocol/midi.js';

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

let midi: AM4Connection | undefined;
let midiError: Error | undefined;

/**
 * How many ack-less writes we tolerate before assuming the MIDI handle is
 * stale and forcing a reconnect on the next use. Two is chosen so a single
 * "block not placed" silent-absorb doesn't trigger a reconnect (that's a
 * legitimate no-ack and should keep the handle), but two in a row across
 * any tool calls looks like the handle is actually dead.
 */
const STALE_HANDLE_TIMEOUT_THRESHOLD = 2;
let consecutiveTimeouts = 0;

/**
 * Call after a write/ack pair completes. Resets the stale-handle counter on
 * success; increments it on timeout. The counter is process-global, not
 * per-tool, so patterns like "apply_preset 3 writes all time out" count as
 * 3 consecutive and trip the reconnect threshold.
 */
function recordAckOutcome(acked: boolean): void {
  if (acked) consecutiveTimeouts = 0;
  else consecutiveTimeouts++;
}

function closeMidiSafely(conn: AM4Connection | undefined): void {
  if (!conn) return;
  try {
    conn.close();
  } catch {
    // Closing a stale handle can throw; ignore — we're discarding it anyway.
  }
}

function ensureMidi(forceReconnect = false): AM4Connection {
  if (forceReconnect || consecutiveTimeouts >= STALE_HANDLE_TIMEOUT_THRESHOLD) {
    closeMidiSafely(midi);
    midi = undefined;
    midiError = undefined;
    consecutiveTimeouts = 0;
  }
  if (midi) return midi;
  if (midiError) throw midiError;
  try {
    midi = connectAM4();
    return midi;
  } catch (err) {
    midiError = err instanceof Error ? err : new Error(String(err));
    throw midiError;
  }
}

process.on('exit', () => closeMidiSafely(midi));

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
  conn: AM4Connection,
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

/**
 * Send a command whose ack shape is not yet decoded, wait the standard echo
 * window, and collect every inbound SysEx frame that arrived. Records the
 * ack outcome against the stale-handle counter (any inbound = acked, empty
 * window = ack-less) and returns a formatted capture block plus a reconnect
 * hint that handlers append to their response text on ack-less.
 *
 * Used by tools whose ack shape we can't yet predicate-match against the
 * sent bytes: save_to_location, set_preset_name, set_scene_name,
 * switch_preset, switch_scene. Tools with fully-decoded echo shapes
 * (set_param, set_params, set_block_type, apply_preset) use
 * `receiveSysExMatching(isWriteEcho, …)` directly and call
 * `recordAckOutcome` themselves.
 *
 * The reconnect hint was missing from the five tools above — a real bug
 * exposed during HW-002 testing (2026-04-19) where three consecutive
 * ack-less writes against a dead MIDI transport never triggered the
 * auto-reconnect because none of them registered their ack-less outcome.
 */
async function sendAndCapture(
  conn: AM4Connection,
  bytes: number[],
): Promise<{ captured: number[][]; capturedText: string; hint: string }> {
  const captured: number[][] = [];
  const unsubscribe = conn.onMessage((msg) => {
    if (msg[0] === 0xf0) captured.push([...msg]);
  });
  conn.send(bytes);
  await new Promise<void>((resolve) => setTimeout(resolve, WRITE_ECHO_TIMEOUT_MS));
  unsubscribe();
  const acked = captured.length > 0;
  recordAckOutcome(acked);
  const capturedText = captured.length === 0
    ? '  (none)'
    : captured.map((m, i) => `  [${i}] (${m.length}B) ${toHex(m)}`).join('\n');
  const hint = acked
    ? ''
    : `\nNo inbound SysEx in the ${WRITE_ECHO_TIMEOUT_MS} ms window. If this ` +
      `keeps happening across writes, the MIDI handle may be stale (AM4-Edit ` +
      `briefly open? USB replug?). Server auto-reconnects after ` +
      `${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes, or call ` +
      `reconnect_midi to force a fresh handle now.`;
  return { captured, capturedText, hint };
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
  name: 'am4-tone-agent',
  version: '0.1.0',
});

server.registerTool('set_param', {
  description: [
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
  // Capture every inbound SysEx during the write window so we can report
  // the raw protocol traffic alongside our verdict. This is diagnostic
  // output added in Session 19 to debug false-confirm reports — the
  // matched echo alone isn't enough to tell apply from absorb if the
  // `isWriteEcho` predicate is still too loose.
  const captured: number[][] = [];
  const unsubscribe = conn.onMessage((msg) => {
    if (msg[0] === 0xf0) captured.push([...msg]);
  });
  // Register the echo listener BEFORE sending so a fast device response
  // can't race ahead of us.
  const echoPromise = conn.receiveSysExMatching(
    (resp) => isWriteEcho(bytes, resp),
    WRITE_ECHO_TIMEOUT_MS,
  );
  conn.send(bytes);
  const enumNameFor = (idx: number): string | undefined => {
    const vals = param.enumValues as Record<number, string> | undefined;
    return vals?.[idx];
  };
  const display = param.unit === 'enum'
    ? `${resolved} (${enumNameFor(resolved) ?? '?'})`
    : String(resolved);
  const formatCaptured = (): string => {
    if (captured.length === 0) return '  (none)';
    return captured.map((m, i) => `  [${i}] (${m.length}B) ${toHex(m)}`).join('\n');
  };
  try {
    const ack = await echoPromise;
    unsubscribe();
    recordAckOutcome(true);
    observeWrittenParam(param.block, param.name, resolved);
    const channelLine = channelStatusLine(param.block, channelSwitched);
    return {
      content: [{
        type: 'text',
        text:
          `Sent ${key} = ${display}. AM4 wire-acked the write.${channelLine} NOTE: the ack ` +
          `does NOT confirm an audible change — the AM4 acks writes to absent ` +
          `blocks the same way it acks writes to placed ones. If the user ` +
          `expected a sound change and reports none, the ${param.block} block ` +
          `is probably not placed in the active preset, OR the change landed on a ` +
          `channel the current scene isn't using.\n` +
          `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
          `Ack (${ack.length}B): ${toHex(ack)}\n` +
          `All inbound SysEx during the ${WRITE_ECHO_TIMEOUT_MS} ms window:\n` +
          formatCaptured(),
      }],
    };
  } catch {
    unsubscribe();
    recordAckOutcome(false);
    return {
      content: [{
        type: 'text',
        text:
          `Sent ${key} = ${display}. No ack within ${WRITE_ECHO_TIMEOUT_MS} ms — ` +
          `this is unusual (the AM4 normally acks every write). If this persists ` +
          `across several writes, the MIDI handle may be stale (e.g. AM4-Edit ` +
          `was briefly open) — the server auto-reconnects after ` +
          `${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes, or ` +
          `you can call reconnect_midi to force it now.\n` +
          `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
          `All inbound SysEx during the ${WRITE_ECHO_TIMEOUT_MS} ms window:\n` +
          formatCaptured(),
      }],
    };
  }
});

server.registerTool('list_params', {
  description: 'List every parameter the server can write. Use this to discover capabilities.',
  inputSchema: {},
}, async () => {
  const rows = Object.entries(KNOWN_PARAMS).map(([key, p]) => {
    const base = `${key} — unit=${p.unit}, range=[${p.displayMin}..${p.displayMax}]`;
    const enumNote = p.unit === 'enum' && p.enumValues
      ? ` (${Object.keys(p.enumValues).length} options; call list_enum_values for names)`
      : '';
    return `  ${base}${enumNote}`;
  });
  return {
    content: [{
      type: 'text',
      text: `Available parameters (${rows.length}):\n${rows.join('\n')}`,
    }],
  };
});

server.registerTool('set_params', {
  description: [
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
  const conn = ensureMidi();
  const captured: number[][] = [];
  const unsubscribe = conn.onMessage((msg) => {
    if (msg[0] === 0xf0) captured.push([...msg]);
  });
  const echoPromise = conn.receiveSysExMatching(
    (resp) => isWriteEcho(bytes, resp),
    WRITE_ECHO_TIMEOUT_MS,
  );
  conn.send(bytes);
  const displayName = BLOCK_NAMES_BY_VALUE[value] ?? `0x${value.toString(16)}`;
  const formatCaptured = (): string => {
    if (captured.length === 0) return '  (none)';
    return captured.map((m, i) => `  [${i}] (${m.length}B) ${toHex(m)}`).join('\n');
  };
  try {
    const ack = await echoPromise;
    unsubscribe();
    recordAckOutcome(true);
    return {
      content: [{
        type: 'text',
        text:
          `Placed ${displayName} in slot ${pos}. AM4 wire-acked the change. ` +
          `NOTE: the ack does NOT confirm the block-slot layout actually ` +
          `updated on the device — cross-check on the AM4 if it matters.\n` +
          `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
          `Ack (${ack.length}B): ${toHex(ack)}\n` +
          `All inbound SysEx during the ${WRITE_ECHO_TIMEOUT_MS} ms window:\n` +
          formatCaptured(),
      }],
    };
  } catch {
    unsubscribe();
    recordAckOutcome(false);
    return {
      content: [{
        type: 'text',
        text:
          `Sent block placement (slot ${pos} → ${displayName}). No ack within ` +
          `${WRITE_ECHO_TIMEOUT_MS} ms — this is unusual. If this keeps happening, ` +
          `the MIDI handle may be stale; server auto-reconnects after ` +
          `${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes, or ` +
          `call reconnect_midi to force.\n` +
          `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
          `All inbound SysEx during the ${WRITE_ECHO_TIMEOUT_MS} ms window:\n` +
          formatCaptured(),
      }],
    };
  }
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
    'Lay out an entire preset in one call: place (or clear) each block slot',
    'and set the parameters within each placed block. Use this when the',
    'user is building a tone from scratch or applying a named preset concept',
    '— it replaces a sequence of set_block_type + set_params calls with a',
    'single structured request.',
    'Shape: { slots: [{ position: 1..4, block_type: "amp"|..., channel?: "A"|"B"|"C"|"D", params?: {...} }] }.',
    'For each slot the tool emits the block-placement write first, then (if',
    '`channel` is specified) a channel-switch write for that block, then one',
    'set-param write per entry in `params`. Params are keyed by the',
    'parameter name within the block (e.g. { gain: 6, bass: 5 }) — the tool',
    'joins `block_type` + param name internally. Skip `params` to just place',
    'the block.',
    'CHANNEL/SCENE MODEL: channels (A/B/C/D) hold the param values; scenes',
    'pick which channel each block uses. `channel` on a slot selects which',
    'channel the params get written to, for that block only. Only amp / drive',
    '/ reverb / delay have channels — the argument is rejected for other',
    'blocks. If the user wants a preset where one slot varies tone across',
    'scenes, call apply_preset once per channel to fill out that block\'s',
    'channel values. If the user doesn\'t mention scenes, omit `channel` and',
    'the writes land on whatever channel each block is currently on.',
    'Validation happens up-front; if any slot/param is invalid (duplicate',
    'position, unknown block type, unknown param for that block, value out',
    'of range, unknown enum name, channel on a block that doesn\'t have',
    'channels) the entire call is rejected with nothing sent. Same ack',
    'caveat as set_param/set_params: wire-acks confirm receipt, not audible',
    'change.',
  ].join(' '),
  inputSchema: {
    slots: z.array(z.object({
      position: z.number().int().min(1).max(4).describe('Slot position 1..4 (1 = leftmost)'),
      block_type: z.string().describe(
        'Block name ("amp", "reverb", "compressor", "none", …). Call list_block_types for the full list.',
      ),
      channel: z.union([z.string(), z.number()]).optional().describe(
        'Optional A/B/C/D (or 0..3). If supplied for amp / drive / reverb / delay, the tool switches that block\'s channel before writing the slot\'s params. Rejected for blocks without channels.',
      ),
      params: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe(
        'Map of param name → display value within the block, e.g. { gain: 6, bass: 5 }. Omit or leave empty to just place the block without parameters.',
      ),
    })).min(1).describe('Ordered list of slots to configure'),
  },
}, async ({ slots }) => {
  // --- Validation pass (no MIDI yet) ---
  const seenPositions = new Set<number>();
  type PreparedWrite =
    | { kind: 'place'; position: 1 | 2 | 3 | 4; blockName: string; bytes: number[] }
    | { kind: 'channel'; block: string; index: number; bytes: number[] }
    | { kind: 'param'; block: string; paramName: string; resolved: number; key: ParamKey; display: string; bytes: number[] };
  const prepared: PreparedWrite[] = [];

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
        prepared.push({
          kind: 'param',
          block: canonicalBlock,
          paramName,
          resolved,
          key,
          display,
          bytes: buildSetParam(key, resolved),
        });
      }
    }
  });

  // --- Send pass ---
  const conn = ensureMidi();
  const lines: string[] = [];
  let acked = 0;
  let unacked = 0;
  for (const w of prepared) {
    const echoPromise = conn.receiveSysExMatching(
      (resp) => isWriteEcho(w.bytes, resp),
      WRITE_ECHO_TIMEOUT_MS,
    );
    conn.send(w.bytes);
    let label: string;
    if (w.kind === 'place') label = `place slot ${w.position} → ${w.blockName}`;
    else if (w.kind === 'channel') label = `switch ${w.block} to channel ${channelLetter(w.index)}`;
    else label = `${w.key} = ${w.display}`;
    try {
      await echoPromise;
      acked++;
      recordAckOutcome(true);
      if (w.kind === 'channel') lastKnownChannel[w.block] = w.index;
      if (w.kind === 'param') observeWrittenParam(w.block, w.paramName, w.resolved);
      lines.push(`  ✓ ${label}`);
    } catch {
      unacked++;
      recordAckOutcome(false);
      lines.push(`  ? ${label} — no ack within ${WRITE_ECHO_TIMEOUT_MS} ms`);
    }
  }
  const header = unacked === 0
    ? `Applied preset: ${prepared.length} writes, all wire-acked. Acks don't confirm audible change — cross-check on the AM4 if it matters. Per-slot channel targets are reflected in the channel lines above; params that follow a channel switch landed on that channel.`
    : `Applied preset: ${prepared.length} writes, ${acked} acked, ${unacked} un-acked (server auto-reconnects after ${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes; or call reconnect_midi).`;
  return {
    content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }],
  };
});

/**
 * Send a command that produces the 18-byte `isCommandAck` shape (save,
 * preset-rename, scene-rename) and classify the response. Returns:
 *   - { acked: true, ackBytes } if an isCommandAck frame arrived in the
 *     window. `ackBytes` is the matching frame.
 *   - { acked: false, captured } otherwise — `captured` is every inbound
 *     SysEx we saw, for diagnostic display on failure.
 *
 * Calls `recordAckOutcome` with the classification so the stale-handle
 * counter stays accurate.
 */
async function sendCommandAndAwaitAck(
  conn: AM4Connection,
  bytes: number[],
): Promise<
  | { acked: true; ackBytes: number[]; captured: number[][] }
  | { acked: false; captured: number[][] }
> {
  const captured: number[][] = [];
  const unsubscribe = conn.onMessage((msg) => {
    if (msg[0] === 0xf0) captured.push([...msg]);
  });
  const ackPromise = conn.receiveSysExMatching(
    (resp) => isCommandAck(bytes, resp),
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
  const result = await sendCommandAndAwaitAck(conn, bytes);
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
  const result = await sendCommandAndAwaitAck(conn, bytes);
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
  const renameResult = await sendCommandAndAwaitAck(conn, renameBytes);
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
  const saveResult = await sendCommandAndAwaitAck(conn, saveBytes);
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
  const result = await sendCommandAndAwaitAck(conn, bytes);
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
  const { capturedText, hint } = await sendAndCapture(conn, bytes);
  // A new preset loads a new set of block channels — any cached channel
  // state from a previous preset is now stale.
  invalidateChannelCache();
  return {
    content: [{
      type: 'text',
      text:
        `Switched to preset ${formatLocationCode(locationIndex)} (index ${locationIndex}). ` +
        `Any unsaved working-buffer edits were discarded. Verify on the AM4 display. ` +
        `(Channel cache cleared — subsequent param writes will report "unknown channel" ` +
        `until a channel is explicitly set.)\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        `All inbound SysEx during the ${WRITE_ECHO_TIMEOUT_MS} ms window:\n` +
        capturedText + hint,
    }],
  };
});

server.registerTool('switch_scene', {
  description: [
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
  const { capturedText, hint } = await sendAndCapture(conn, bytes);
  // Scene switches remap which channel each block uses; any cached channel
  // state is now invalid until we explicitly set a new channel.
  invalidateChannelCache();
  return {
    content: [{
      type: 'text',
      text:
        `Switched to scene ${scene_index}. Verify on the AM4 display. ` +
        `(Channel cache cleared — the new scene may point each block at a ` +
        `different channel than scene ${scene_index === 1 ? '2..4' : '1'}.)\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        `All inbound SysEx during the ${WRITE_ECHO_TIMEOUT_MS} ms window:\n` +
        capturedText + hint,
    }],
  };
});

server.registerTool('reconnect_midi', {
  description: [
    'Force the server to close its cached MIDI connection and open a fresh',
    'one. Use this if writes stop getting ack\'d — typically after AM4-Edit',
    'was briefly opened and grabbed the USB port exclusively, or after a',
    'USB replug, or any other event that leaves the cached handle in a',
    'dead state. The server also auto-reconnects after',
    `${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes, so`,
    'manual use is only needed when you want to force it sooner without',
    'waiting for writes to accumulate.',
  ].join(' '),
  inputSchema: {},
}, async () => {
  try {
    ensureMidi(true);
    // Fresh connection = we don't know anything about the hardware state.
    invalidateChannelCache();
    return {
      content: [{
        type: 'text',
        text:
          'MIDI connection reset. Next tool call will use a fresh port handle. ' +
          'Channel cache cleared. If writes still don\'t ack after this, the issue ' +
          'is below the server (AM4 powered off, USB unplugged, driver wedged, or ' +
          'another app holding the port exclusively).',
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: 'text',
        text:
          `Reconnect failed: ${msg}\n\n` +
          'Most common causes:\n' +
          '  - AM4 is off or not connected by USB\n' +
          '  - Driver not installed (fractalaudio.com/am4-downloads/)\n' +
          '  - Another app holds the MIDI port exclusively (close AM4-Edit)',
      }],
    };
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
  console.error('AM4 Tone Agent MCP server running on stdio.');
}

main().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
