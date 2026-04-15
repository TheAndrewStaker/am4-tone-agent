/**
 * Parse AM4-Edit's effectDefinitions cache into structured JSON.
 *
 * Source: %APPDATA%/Fractal Audio/AM4-Edit/effectDefinitions_15_2p0.cache
 *
 * Session 09 located the cache; this script decodes its binary schema.
 *
 * Record layout (byte-packed, not aligned):
 *   +0   u16   id
 *   +2   u16   typecode     — 0x1d = enum; others (0x32, 0x37, …) = float-range
 *   +4   u16   padding
 *   +6   f32   min
 *   +10  f32   max
 *   +14  f32   default
 *   +18  f32   step
 *
 * Whether a record carries an enum string list is not determined by the
 * typecode alone (both tc=0x1d and tc=0x2d have strings in practice, and
 * more may exist). We detect it structurally: read the u32 at +22; if
 * it's a plausible count (1..2048) AND the first `count` length-prefixed
 * ASCII strings parse cleanly, treat the record as an enum.
 *
 * Enum (has strings):
 *   +22  u32   count
 *   +26  count × (u32 length + `length` ASCII bytes)
 *   +N   6-byte trailer `04 00 00 00 00 00`
 *
 * Float-range (no strings):
 *   +22  10-byte zero trailer (total record size = 32 bytes)
 *
 * Sections: the cache is partitioned by a 24-byte `ff ff 00 00 …` marker
 * (first one observed at 0xaa2d). Section 1 is global/system params
 * (86 records, ids 0x0d..0xa2). Section 2 starts with a 104-entry
 * preset-name list, then per-block parameter definitions in a
 * different packed layout (not yet fully decoded — see STATE.md).
 *
 * File header: 16 bytes (two u64 LE = 2, 4), then a 38-byte preamble we
 * currently skip — first parseable record begins at offset 0x36.
 *
 * Run:
 *   npx tsx scripts/parse-cache.ts
 *     → writes samples/captured/decoded/cache-records.json
 *     → prints a short summary to stdout
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface BaseRecord {
  offset: number;
  id: number;
  typecode: number;
  min: number;
  max: number;
  default: number;
  step: number;
}

interface EnumRecord extends BaseRecord {
  kind: 'enum';
  values: string[];
}

interface FloatRangeRecord extends BaseRecord {
  kind: 'float';
}

type Record = EnumRecord | FloatRangeRecord;

const HEADER_SIZE = 22; // id + tc + pad + min + max + def + step
const FLOAT_TRAILER = 10;
const ENUM_TRAILER = 6;

function isAscii(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

function tryReadLPString(buf: Buffer, off: number): { s: string; next: number } | null {
  if (off + 4 > buf.length) return null;
  const len = buf.readUInt32LE(off);
  if (len === 0 || len > 64) return null;
  const end = off + 4 + len;
  if (end > buf.length) return null;
  for (let i = 0; i < len; i++) {
    const b = buf[off + 4 + i];
    if (!isAscii(b)) return null;
  }
  return { s: buf.slice(off + 4, end).toString('ascii'), next: end };
}

/**
 * Speculatively try to parse `count` length-prefixed ASCII strings at
 * `off`. Returns the collected strings and end offset, or null if any
 * string fails to parse.
 */
function tryParseEnumBody(
  buf: Buffer,
  off: number,
): { count: number; values: string[]; next: number } | null {
  if (off + 4 > buf.length) return null;
  const count = buf.readUInt32LE(off);
  if (count < 1 || count > 2048) return null;
  let p = off + 4;
  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = tryReadLPString(buf, p);
    if (!r) return null;
    values.push(r.s);
    p = r.next;
  }
  return { count, values, next: p };
}

const SECTION_MARKER = 0xffff;

function parse(buf: Buffer): { records: Record[]; stoppedAt: number; reason?: string } {
  const records: Record[] = [];
  let off = 0x36; // skip file header + 38-byte preamble
  let reason: string | undefined;

  while (off + HEADER_SIZE <= buf.length) {
    const start = off;
    const id = buf.readUInt16LE(off);
    const tc = buf.readUInt16LE(off + 2);

    // Section boundary: cache has a secondary section starting with
    // `ff ff 00 00` that uses a different layout we haven't decoded.
    // Stop cleanly here — section 1 is what we can trust.
    if (id === SECTION_MARKER) {
      reason = `section marker (ff ff) reached at 0x${off.toString(16)}`;
      break;
    }
    // pad at off+4
    const min = buf.readFloatLE(off + 6);
    const max = buf.readFloatLE(off + 10);
    const def = buf.readFloatLE(off + 14);
    const step = buf.readFloatLE(off + 18);

    const enumBody = tryParseEnumBody(buf, off + HEADER_SIZE);
    if (enumBody) {
      records.push({
        offset: start,
        id,
        typecode: tc,
        min, max, default: def, step,
        kind: 'enum',
        values: enumBody.values,
      });
      off = enumBody.next + ENUM_TRAILER;
    } else {
      records.push({
        offset: start,
        id,
        typecode: tc,
        min, max, default: def, step,
        kind: 'float',
      });
      off += HEADER_SIZE + FLOAT_TRAILER; // 32 bytes
    }
  }

  return { records, stoppedAt: off, reason };
}

const appdata = process.env.APPDATA;
if (!appdata) throw new Error('APPDATA not set');
const cachePath = join(appdata, 'Fractal Audio', 'AM4-Edit', 'effectDefinitions_15_2p0.cache');
const buf = readFileSync(cachePath);

console.log(`cache: ${cachePath}`);
console.log(`size: ${buf.length} bytes`);

const { records, stoppedAt, reason } = parse(buf);

console.log(`\nparsed ${records.length} records; stopped at 0x${stoppedAt.toString(16)} (${buf.length - stoppedAt} bytes remaining)`);
if (reason) console.log(`stop reason: ${reason}`);

const enums = records.filter((r): r is EnumRecord => r.kind === 'enum');
const floats = records.filter((r): r is FloatRangeRecord => r.kind === 'float');
const totalStrings = enums.reduce((n, r) => n + r.values.length, 0);

console.log(`  enums:       ${enums.length} (${totalStrings} strings total)`);
console.log(`  float-range: ${floats.length}`);

const tcHist = new Map<number, number>();
for (const r of records) tcHist.set(r.typecode, (tcHist.get(r.typecode) ?? 0) + 1);
console.log(`\nrecords by typecode:`);
const tcSorted = [...tcHist.entries()].sort((a, b) => b[1] - a[1]);
for (const [tc, n] of tcSorted) {
  console.log(`  0x${tc.toString(16).padStart(4, '0')}: ${n}`);
}

const idSet = new Set(records.map(r => r.id));
console.log(`\nunique ids: ${idSet.size}, id range: 0x${Math.min(...idSet).toString(16)}..0x${Math.max(...idSet).toString(16)}`);

console.log(`\nfirst 15 records:`);
for (const r of records.slice(0, 15)) {
  const extra = r.kind === 'enum'
    ? `  values[${r.values.length}]: ${r.values.slice(0, 4).map(s => `"${s}"`).join(', ')}${r.values.length > 4 ? ', …' : ''}`
    : '';
  console.log(`  @0x${r.offset.toString(16).padStart(5, '0')}  id=0x${r.id.toString(16).padStart(4, '0')}  tc=0x${r.typecode.toString(16).padStart(4, '0')}  kind=${r.kind}  min=${r.min}  max=${r.max}  def=${r.default}  step=${r.step}${extra}`);
}

const outDir = 'samples/captured/decoded';
const outPath = join(outDir, 'cache-records.json');
writeFileSync(outPath, JSON.stringify(records, null, 2));
console.log(`\nwrote ${outPath}`);
