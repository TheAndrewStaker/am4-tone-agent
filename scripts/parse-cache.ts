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
 * (86 records, ids 0x0d..0xa2). Section 2 has its own layout:
 *
 *   [0xaa2d] ff ff 00 00 … 68 00 00 00         section marker + count=104
 *   [0xaa47] 104 × preset-slot name            (each: u32 len + len ASCII)
 *   [end]    run of per-block param records    (24-byte header, see below)
 *
 * Section 2 record layout (verified against SINE-waveform enum @0xb893,
 * amp-type enum @0xe7c0, drive-type enum @0x1c3cc):
 *
 *   +0   u16  flag         (always 0 observed)
 *   +2   u16  id           (1-based, per-block)
 *   +4   u32  typecode     (0 = float knob, 16 = enum string list)
 *   +8   u32  pad          (always 0 observed)
 *   +12  f32  a
 *   +16  f32  b
 *   +20  f32  c
 *   +24  if tc == 0 (float):  f32 d  + 4-byte trailer  (record = 32 bytes)
 *        if tc == 16 (enum):  u32 count
 *                             count × (u32 len + len ASCII)
 *                             4-byte trailer
 *
 * For enum records, (a,b,c) = (max, default, min) and (max == count-1).
 * Verified: SINE enum (count=10, max=9), amp-type (count=248, max=247),
 * drive-type (count=78, max=77). All have min=0, default=1.
 *
 * For float records, the four floats are captured as-is and labelled
 * (a,b,c,d) pending semantic interpretation — the first block in
 * section 2 has ids 1..9 that are all (1.0, 10.0, 0.001, 0.0), likely
 * a 9-slot modifier / assign template rather than block-specific params.
 *
 * Block boundaries: ids are 1-based and reset per block. A decrease in
 * id between consecutive records marks a new block.
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

// Section 2 record types — layout differs from Section 1.
interface Section2Base {
  offset: number;
  block: number; // block index, 0-based, assigned by the parser on id-reset
  id: number;    // 1-based within block
  typecode: number;
}
interface Section2Float extends Section2Base {
  kind: 'float';
  a: number; b: number; c: number; d: number;
}
interface Section2Enum extends Section2Base {
  kind: 'enum';
  max: number;
  default: number;
  min: number;
  values: string[];
}
// Block header preceding the first parameter record of blocks 1+.
// 40 bytes; the u32 at +4 has the block-type tag in its high 16 bits
// (e.g. 0x00230000 → blockType=0x23). Floats at +20/+24/+28 match the
// assign-knob template (1.0, 10.0, 0.001), so the header also carries
// a default knob spec.
interface Section2BlockHeader {
  kind: 'blockHeader';
  offset: number;
  block: number;
  blockTag: number; // high 16 bits of the tc u32
  floatsAt20: [number, number, number];
}
type Section2Record = Section2Float | Section2Enum | Section2BlockHeader;

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

/**
 * Skip past the Section 2 preamble: the `ff ff 00 00` marker, padding,
 * u32 count (=104), and the 104 variable-length preset-slot names.
 * Returns the offset of the first parameter record.
 */
function skipSection2Preamble(buf: Buffer, markerOff: number): number {
  // Scan forward from the marker to find the u32 count = 104 (0x68)
  // followed by 104 LP-strings. The preamble has ~22 bytes of zeros
  // between the `ff ff` marker and the count.
  let off = markerOff + 2; // skip `ff ff`
  // Find the count byte run. Section 2 at 0xaa2d: count at 0xaa43.
  // Robust: skip forward until a plausible u32 count in [50, 256]
  // appears AND the next 4 bytes look like an LP-string length.
  while (off + 8 <= buf.length) {
    const count = buf.readUInt32LE(off);
    if (count === 104) {
      const firstLen = buf.readUInt32LE(off + 4);
      if (firstLen > 0 && firstLen <= 64) break;
    }
    off += 2;
  }
  if (off + 8 > buf.length) throw new Error('Section 2 preamble count not found');

  const count = buf.readUInt32LE(off);
  let p = off + 4;
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt32LE(p);
    if (len === 0 || len > 64) throw new Error(`preset-name ${i} bad len=${len} at 0x${p.toString(16)}`);
    p += 4 + len;
  }

  // Then there's a short tail (u32 `02 00 00 00`, u32 `63 00 00 00`,
  // a run of zeros) before the first record. The first record begins
  // at the first `[flag=00 00] [id=01 00]` pattern — id=1 marks the
  // start of the first block's parameter list.
  while (p + 32 <= buf.length) {
    const flag = buf.readUInt16LE(p);
    const id = buf.readUInt16LE(p + 2);
    if (flag === 0 && id === 1) return p;
    p++;
  }
  throw new Error('Section 2: no id=1 record found after preset names');
}

function parseSection2(buf: Buffer, start: number): { records: Section2Record[]; stoppedAt: number; reason: string } {
  // Section 2 record (verified):
  //   +0  u16 flag (0)
  //   +2  u16 id (1-based, resets per block)
  //   +4  u32 typecode
  //   +8  f32 a
  //   +12 f32 b
  //   +16 f32 c
  //   +20 f32 d
  //   +24 if enum (strings follow): u32 count + strings + 4-byte trailer
  //       else: 4-byte trailer (record = 32 bytes)
  //
  // Enum detection is structural: try tryParseEnumBody at +24. When the
  // strings parse cleanly, treat as enum. Typecode 16 appears to always
  // mean enum; other typecodes (0, 0x35, 0x42, …) mean float-range.
  const records: Section2Record[] = [];
  let off = start;
  let prevId = 0;
  let block = 0;

  let reason = 'reached end of buffer';
  while (off + 28 <= buf.length) {
    const flag = buf.readUInt16LE(off);
    const id = buf.readUInt16LE(off + 2);
    const tc = buf.readUInt32LE(off + 4);

    // Block header detection: blocks 1+ begin with a 40-byte header whose
    // u32 at +4 has its high 16 bits set (blockTag), the floats are at
    // +20/+24/+28 instead of +12/+16/+20, and the "id" field at +2 is
    // actually the record count (not a parameter id). After the 40 bytes,
    // normal 32-byte records (id=1, 2, 3, …) resume.
    if (flag === 0 && (tc >>> 16) !== 0 && (tc & 0xffff) === 0) {
      const blockTag = tc >>> 16;
      const f1 = buf.readFloatLE(off + 20);
      const f2 = buf.readFloatLE(off + 24);
      const f3 = buf.readFloatLE(off + 28);
      block++;
      records.push({
        kind: 'blockHeader', offset: off, block, blockTag,
        floatsAt20: [f1, f2, f3],
      });
      off += 40;
      prevId = 0;
      continue;
    }

    // Record validity: flag=0, id in [1, 2048]. Typecodes seen in body:
    // 0, 0x10, 0x20, 0x35, 0x42, 0x44, 0x100. Ceiling stays loose.
    if (flag !== 0 || id === 0 || id > 2048 || tc > 0xffff) {
      reason = `stopped at 0x${off.toString(16)}: flag=${flag} id=${id} tc=0x${tc.toString(16)}`;
      break;
    }

    if (id <= prevId) block++;
    prevId = id;

    const a = buf.readFloatLE(off + 8);
    const b = buf.readFloatLE(off + 12);
    const c = buf.readFloatLE(off + 16);
    const d = buf.readFloatLE(off + 20);

    const enumBody = tryParseEnumBody(buf, off + 24);
    if (enumBody) {
      records.push({
        offset: off, block, id, typecode: tc,
        kind: 'enum', min: a, max: b, default: c, values: enumBody.values,
      });
      off = enumBody.next + 4;
    } else {
      records.push({ offset: off, block, id, typecode: tc, kind: 'float', a, b, c, d });
      off += 32;
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

// --- Section 2 ---

console.log(`\n--- Section 2 ---`);
const section2Start = skipSection2Preamble(buf, stoppedAt);
console.log(`first record at 0x${section2Start.toString(16)}`);

const { records: s2, stoppedAt: s2StoppedAt, reason: s2Reason } = parseSection2(buf, section2Start);
console.log(`parsed ${s2.length} records; ${s2Reason}`);
console.log(`${buf.length - s2StoppedAt} bytes remaining unparsed after block 0`);

// Block summary
const blocks = new Map<number, Section2Record[]>();
for (const r of s2) {
  const arr = blocks.get(r.block) ?? [];
  arr.push(r);
  blocks.set(r.block, arr);
}
console.log(`block count: ${blocks.size}`);
for (const [b, recs] of blocks) {
  const params = recs.filter(r => r.kind !== 'blockHeader') as (Section2Float | Section2Enum)[];
  const enums = params.filter(r => r.kind === 'enum') as Section2Enum[];
  const header = recs.find(r => r.kind === 'blockHeader') as Section2BlockHeader | undefined;
  const maxId = params.length ? Math.max(...params.map(r => r.id)) : 0;
  const firstEnum = enums[0];
  const peek = firstEnum ? `  first enum: id=${firstEnum.id} count=${firstEnum.values.length} [${firstEnum.values.slice(0, 3).join(', ')}${firstEnum.values.length > 3 ? ', …' : ''}]` : '';
  const tagNote = header ? `  tag=0x${header.blockTag.toString(16)}` : '';
  console.log(`  block ${b.toString().padStart(2)}: ${params.length.toString().padStart(3)} records, maxId=${maxId}, enums=${enums.length}${tagNote}${peek}`);
}

const s2Path = join(outDir, 'cache-section2.json');
writeFileSync(s2Path, JSON.stringify(s2, null, 2));
console.log(`\nwrote ${s2Path}`);
