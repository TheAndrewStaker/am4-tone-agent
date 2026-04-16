#!/usr/bin/env node
/**
 * AM4 Tone Agent — MCP server (stdio).
 *
 * Exposes Claude Desktop tools that talk to a local Fractal AM4 over
 * USB/MIDI. MVP tools:
 *
 *   - set_param          write one parameter (numeric or enum-by-name)
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import {
  KNOWN_PARAMS,
  decode,
  resolveEnumValue,
  type Param,
  type ParamKey,
} from '../protocol/params.js';
import { buildSetParam, buildReadParam } from '../protocol/setParam.js';
import { unpackFloat32LE } from '../protocol/packValue.js';
import { connectAM4, type AM4Connection, toHex } from '../protocol/midi.js';

// -- MIDI lazy-init ---------------------------------------------------------

let midi: AM4Connection | undefined;
let midiError: Error | undefined;

function ensureMidi(): AM4Connection {
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

process.on('exit', () => { try { midi?.close(); } catch { /* ignore */ } });

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

// -- Server setup -----------------------------------------------------------

const server = new McpServer({
  name: 'am4-tone-agent',
  version: '0.1.0',
});

server.registerTool('set_param', {
  description: [
    'Write a single parameter on the connected Fractal AM4.',
    'The parameter is addressed by (block, name) — e.g. block="amp", name="gain".',
    'For numeric params, pass the user-facing display value (0–10 knob, dB, ms, %).',
    'For enum params, pass the dropdown name ("1959SLP Normal") or wire index (0).',
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
  ensureMidi().send(bytes);
  const enumNameFor = (idx: number): string | undefined => {
    const vals = param.enumValues as Record<number, string> | undefined;
    return vals?.[idx];
  };
  const display = param.unit === 'enum'
    ? `${resolved} (${enumNameFor(resolved) ?? '?'})`
    : String(resolved);
  return {
    content: [{
      type: 'text',
      text: `Sent ${key} = ${display}. Wire bytes: ${toHex(bytes)}`,
    }],
  };
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
    'it is less chatty and validates all inputs before sending any MIDI',
    '(either the whole batch applies or nothing does). Same value rules as',
    'set_param: numbers for knobs/dB/ms/%, strings or wire indices for enum',
    'params. Writes are sent in the provided order.',
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
  // Validate + encode every entry BEFORE sending any MIDI. This keeps the
  // batch atomic from the caller's POV: a bad value in entry 7 won't leave
  // entries 0..6 half-applied.
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
      return { key, bytes, display };
    } catch (err) {
      throw new Error(`writes[${i}] (${w.block}.${w.name} = ${w.value}): ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  const conn = ensureMidi();
  const lines: string[] = [];
  for (const { key, bytes, display } of prepared) {
    conn.send(bytes);
    lines.push(`  ${key} = ${display}`);
  }
  return {
    content: [{
      type: 'text',
      text: `Applied ${prepared.length} writes:\n${lines.join('\n')}`,
    }],
  };
});

server.registerTool('read_param', {
  description: [
    'Read a parameter from the connected AM4 to confirm the current value.',
    'Use after set_param when you need to verify a write actually applied —',
    'a silent absorb usually means the target block is not present in the',
    'active preset. The AM4 will not apply writes to blocks that aren\'t',
    'placed. Returns the decoded display value plus raw response bytes.',
  ].join(' '),
  inputSchema: {
    block: z.string().describe('Block name, e.g. "amp", "drive", "reverb", "delay"'),
    name: z.string().describe('Parameter name within the block, e.g. "gain", "type", "mix"'),
  },
}, async ({ block, name }) => {
  const key = paramKey(block, name);
  const param: Param = KNOWN_PARAMS[key];
  const req = buildReadParam(param, 0x0e);
  const conn = ensureMidi();
  conn.send(req);
  let reply: number[];
  try {
    reply = await conn.receiveSysEx(1500);
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `No response reading ${key} within 1500 ms. Wire sent: ${toHex(req)}. ` +
              `This usually means the target block is not present in the active preset — ` +
              `try a factory preset that already has ${block} placed.`,
      }],
    };
  }
  const hex = toHex(reply);
  if (reply.length < 9 || reply[0] !== 0xf0 || reply[reply.length - 1] !== 0xf7) {
    return { content: [{ type: 'text', text: `Unparsable reply for ${key}. Raw: ${hex}` }] };
  }
  // Response payload format is NOT fully decoded yet (see docs/SYSEX-MAP.md §6a
  // "Read response — format open"). The 5-byte payload at bytes[len-7..len-2]
  // does not unpack via the write-side 8-to-7 scheme — responses for known
  // non-zero values yield denormalized floats. Until a capture of AM4-Edit
  // reading a known value pins down the format, we return raw bytes and a
  // clearly-labeled experimental decode. Treat the decoded number as a hint,
  // not ground truth.
  const payloadStart = reply.length - 7;
  const payloadEnd = reply.length - 2;
  let experimental: string;
  try {
    const packed = new Uint8Array(reply.slice(payloadStart, payloadEnd));
    const f = unpackFloat32LE(packed);
    const displayValue = decode(param, f);
    experimental = String(displayValue);
  } catch (err) {
    experimental = `(decode failed: ${err instanceof Error ? err.message : String(err)})`;
  }
  const payloadHex = toHex(reply.slice(payloadStart, payloadEnd));
  return {
    content: [{
      type: 'text',
      text:
        `Read ${key}. Response format is NOT yet decoded — treat the value below as unreliable.\n` +
        `  raw payload (5 bytes): ${payloadHex}\n` +
        `  experimental decode (write-side unpack): ${experimental}\n` +
        `  full reply: ${hex}\n` +
        `To verify whether a write actually applied, watch the AM4's display. ` +
        `Decode will be fixed after Session 18 capture of an AM4-Edit read.`,
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
