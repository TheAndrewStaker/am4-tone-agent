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
  },
}, async ({ block, name, value }) => {
  const key = paramKey(block, name);
  const param: Param = KNOWN_PARAMS[key];
  const resolved = resolveValue(param, value);
  const bytes = buildSetParam(key, resolved);
  const conn = ensureMidi();
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
    return {
      content: [{
        type: 'text',
        text:
          `Sent ${key} = ${display}. AM4 wire-acked the write. NOTE: the ack ` +
          `does NOT confirm an audible change — the AM4 acks writes to absent ` +
          `blocks the same way it acks writes to placed ones. If the user ` +
          `expected a sound change and reports none, the ${param.block} block ` +
          `is probably not placed in the active preset.\n` +
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
    'IMPORTANT: same caveat as set_param — the AM4 acks every write on the',
    'wire whether or not the target block is placed, so an ack is not a',
    'confirmation of audible change. If the user expects audible changes',
    'and reports none, the most likely cause is that one or more target',
    'blocks are not placed in the active preset.',
  ].join(' '),
  inputSchema: {
    writes: z.array(z.object({
      block: z.string().describe('Block name, e.g. "amp", "drive", "reverb", "delay"'),
      name: z.string().describe('Parameter name within the block, e.g. "gain", "type", "mix"'),
      value: z.union([z.number(), z.string()]).describe('Display value'),
    })).describe('List of (block, name, value) writes to apply in order'),
  },
}, async ({ writes }) => {
  if (writes.length === 0) {
    return { content: [{ type: 'text', text: 'No writes supplied. Nothing to do.' }] };
  }
  // Validate + encode every entry BEFORE sending any MIDI. A bad value in
  // entry 7 would otherwise leave entries 0..6 half-sent; the pre-flight
  // pass keeps input-validation failures atomic.
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
      return { key, param, bytes, display };
    } catch (err) {
      throw new Error(`writes[${i}] (${w.block}.${w.name} = ${w.value}): ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  const conn = ensureMidi();
  const lines: string[] = [];
  let acked = 0;
  let unacked = 0;
  for (let i = 0; i < prepared.length; i++) {
    const { key, display } = prepared[i];
    const { bytes } = prepared[i];
    const echoPromise = conn.receiveSysExMatching(
      (resp) => isWriteEcho(bytes, resp),
      WRITE_ECHO_TIMEOUT_MS,
    );
    conn.send(bytes);
    try {
      await echoPromise;
      acked++;
      recordAckOutcome(true);
      lines.push(`  ✓ ${key} = ${display} — wire-acked`);
    } catch {
      unacked++;
      recordAckOutcome(false);
      lines.push(`  ? ${key} = ${display} — no ack within ${WRITE_ECHO_TIMEOUT_MS} ms (USB/driver issue?)`);
    }
  }
  const summary =
    unacked === 0
      ? `Sent all ${prepared.length} writes; AM4 wire-acked each one. Acks do NOT confirm audible change — if the user reports no change on the device, the target blocks are probably not placed in the active preset.`
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
    'Shape: { slots: [{ position: 1..4, block_type: "amp"|..., params?: {...} }] }.',
    'For each slot the tool emits the block-placement write first, then one',
    'set-param write per entry in `params`. Params are keyed by the',
    'parameter name within the block (e.g. { gain: 6, bass: 5 }) — the tool',
    'joins `block_type` + param name internally. Skip `params` to just place',
    'the block.',
    'Validation happens up-front; if any slot/param is invalid (duplicate',
    'position, unknown block type, unknown param for that block, value out',
    'of range, unknown enum name) the entire call is rejected with nothing',
    'sent. Same ack caveat as set_param/set_params: wire-acks confirm receipt,',
    'not audible change.',
  ].join(' '),
  inputSchema: {
    slots: z.array(z.object({
      position: z.number().int().min(1).max(4).describe('Slot position 1..4 (1 = leftmost)'),
      block_type: z.string().describe(
        'Block name ("amp", "reverb", "compressor", "none", …). Call list_block_types for the full list.',
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
    | { kind: 'param'; key: ParamKey; display: string; bytes: number[] };
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
    const label = w.kind === 'place'
      ? `place slot ${w.position} → ${w.blockName}`
      : `${w.key} = ${w.display}`;
    try {
      await echoPromise;
      acked++;
      recordAckOutcome(true);
      lines.push(`  ✓ ${label}`);
    } catch {
      unacked++;
      recordAckOutcome(false);
      lines.push(`  ? ${label} — no ack within ${WRITE_ECHO_TIMEOUT_MS} ms`);
    }
  }
  const header = unacked === 0
    ? `Applied preset: ${prepared.length} writes, all wire-acked. Acks don't confirm audible change — cross-check on the AM4 if it matters.`
    : `Applied preset: ${prepared.length} writes, ${acked} acked, ${unacked} un-acked (server auto-reconnects after ${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes; or call reconnect_midi).`;
  return {
    content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }],
  };
});

server.registerTool('save_to_location', {
  description: [
    'Persist the AM4\'s current working-buffer preset (everything laid out',
    'via apply_preset / set_block_type / set_param) into a preset location',
    'so it survives power-cycling. Location naming is the AM4\'s native',
    'format: bank letter A..Z + sub-index 01..04 (e.g. "A01", "M03", "Z04"),',
    '104 total preset locations across 26 banks.',
    'WRITE SAFETY (active during reverse-engineering): this tool is hard-',
    'gated to location "Z04" (the designated scratch location). Attempts to',
    'save elsewhere are rejected with a clear error. The gate will be',
    'relaxed once factory-preset safety classification is in place (backlog',
    'P1-008).',
    'The save-command ack shape is not fully decoded — the tool just sends',
    'the command and reports any inbound SysEx in the 300 ms window for',
    'diagnostic visibility. Verify the save took effect by loading the',
    'location on the AM4 and confirming the expected layout / params.',
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
      `This restriction will be lifted once factory-preset safety classification ships (backlog P1-008).`,
    );
  }
  const locationIndex = parseLocationCode(normalized);
  const bytes = buildSaveToLocation(locationIndex);
  const conn = ensureMidi();
  const captured: number[][] = [];
  const unsubscribe = conn.onMessage((msg) => {
    if (msg[0] === 0xf0) captured.push([...msg]);
  });
  conn.send(bytes);
  await new Promise<void>((resolve) => setTimeout(resolve, WRITE_ECHO_TIMEOUT_MS));
  unsubscribe();
  const formatCaptured = (): string => {
    if (captured.length === 0) return '  (none)';
    return captured.map((m, i) => `  [${i}] (${m.length}B) ${toHex(m)}`).join('\n');
  };
  return {
    content: [{
      type: 'text',
      text:
        `Sent save command for location ${formatLocationCode(locationIndex)} (index ${locationIndex}). ` +
        `The save-command ack shape isn't fully decoded, so the tool doesn't ` +
        `assert success — verify by navigating to the location on the AM4 and ` +
        `confirming the expected layout/params are now there.\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        `All inbound SysEx during the ${WRITE_ECHO_TIMEOUT_MS} ms window:\n` +
        formatCaptured(),
    }],
  };
});

server.registerTool('set_preset_name', {
  description: [
    'Rename the preset stored at a specific location. Names can be up to',
    '32 ASCII-printable characters; shorter names are space-padded on the',
    'wire (AM4 convention). Unlike set_param/apply_preset, this tool',
    'targets a stored preset location directly — it is the "save a preset',
    'with a name" complement to save_to_location.',
    'WRITE SAFETY: hard-gated to location "Z04" during reverse-engineering,',
    'same rules as save_to_location. The gate lifts once factory-preset',
    'safety classification (P1-008) ships.',
    'It\'s not yet confirmed whether rename persists on its own or needs',
    'a subsequent save_to_location call — verify on the AM4 display after',
    'calling. Scene renames use a separate command and are a follow-up',
    'session (BK-011).',
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
      `This restriction will be lifted once factory-preset safety classification ships (backlog P1-008).`,
    );
  }
  const locationIndex = parseLocationCode(normalized);
  const bytes = buildSetPresetName(locationIndex, name);
  const conn = ensureMidi();
  const captured: number[][] = [];
  const unsubscribe = conn.onMessage((msg) => {
    if (msg[0] === 0xf0) captured.push([...msg]);
  });
  conn.send(bytes);
  await new Promise<void>((resolve) => setTimeout(resolve, WRITE_ECHO_TIMEOUT_MS));
  unsubscribe();
  const formatCaptured = (): string => {
    if (captured.length === 0) return '  (none)';
    return captured.map((m, i) => `  [${i}] (${m.length}B) ${toHex(m)}`).join('\n');
  };
  return {
    content: [{
      type: 'text',
      text:
        `Sent rename: location ${formatLocationCode(locationIndex)} → "${name}". The rename-command ` +
        `ack shape isn't fully decoded; verify by viewing the preset name on the AM4 ` +
        `or in AM4-Edit. If the name didn't stick, try calling save_to_location ` +
        `afterward — it's not yet confirmed whether rename persists on its own.\n` +
        `Sent (${bytes.length}B): ${toHex(bytes)}\n` +
        `All inbound SysEx during the ${WRITE_ECHO_TIMEOUT_MS} ms window:\n` +
        formatCaptured(),
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
    return {
      content: [{
        type: 'text',
        text:
          'MIDI connection reset. Next tool call will use a fresh port handle. ' +
          'If writes still don\'t ack after this, the issue is below the server ' +
          '(AM4 powered off, USB unplugged, driver wedged, or another app holding ' +
          'the port exclusively).',
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
