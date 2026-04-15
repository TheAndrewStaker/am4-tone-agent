/**
 * Verify the (wire-pidLow → cache block) mapping and dump the
 * candidate parameter metadata per block for KNOWN_PARAMS generation.
 *
 * **The key insight of Session 15**: wire `pidHigh` directly equals the
 * cache record `id` within the right block. Finding the "right block"
 * for each wire pidLow was the last missing piece; see the table below.
 *
 * Confirmed mappings (verified by this script — each block's candidate
 * records line up with KNOWN_PARAMS by id, and the main effect-type
 * enum at a canonical low id matches Session 13's findings):
 *
 *   Amp    pidLow=0x3A  ↔  S2 block 5         tag=0x98   151 recs
 *   Drive  pidLow=0x76  ↔  S3 sub-block 9                49 recs
 *   Reverb pidLow=0x42  ↔  S3 sub-block 0                72 recs
 *   Delay  pidLow=0x46  ↔  S3 sub-block 1                89 recs
 *
 * Run after `npx tsx scripts/parse-cache.ts`:
 *   npx tsx scripts/map-cache-params.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_PARAMS, type Param } from '../src/protocol/params.js';

interface CacheRec {
  offset: number;
  block: number;
  id: number;
  typecode: number;
  kind: 'float' | 'enum' | 'blockHeader';
  a?: number; b?: number; c?: number; d?: number;
  values?: string[];
}

const DECODED_DIR = 'samples/captured/decoded';
const s2: CacheRec[] = JSON.parse(readFileSync(join(DECODED_DIR, 'cache-section2.json'), 'utf8'));
const s3Wrap = JSON.parse(readFileSync(join(DECODED_DIR, 'cache-section3.json'), 'utf8'));
const s3: CacheRec[] = s3Wrap.records;

// Mapping from wire pidLow → (section, cache block index). Pinned here
// because deriving it automatically is fragile: modifier-assign enums
// ("NONE  … 63/64", 79 entries) appear in many blocks, confounding the
// obvious "biggest enum = main type" heuristic. The table is instead
// verified structurally in this script.
interface BlockLoc { section: 'S2' | 'S3'; block: number; recs: CacheRec[]; }
const CACHE_BLOCK_MAP: Record<number, BlockLoc> = {
  0x3a: { section: 'S2', block: 5, recs: s2 },  // Amp
  0x76: { section: 'S3', block: 9, recs: s3 },  // Drive
  0x42: { section: 'S3', block: 0, recs: s3 },  // Reverb
  0x46: { section: 'S3', block: 1, recs: s3 },  // Delay
};

function paramRecsFor(recs: CacheRec[], block: number): CacheRec[] {
  return recs.filter((r) => r.block === block && r.kind !== 'blockHeader');
}

// Group KNOWN_PARAMS by block name for display.
const byBlock = new Map<string, Param[]>();
for (const p of Object.values(KNOWN_PARAMS) as Param[]) {
  const arr = byBlock.get(p.block) ?? [];
  arr.push(p);
  byBlock.set(p.block, arr);
}

console.log('Verifying KNOWN_PARAMS against pinned cache-block map\n');

let verified = 0;
let unverified = 0;
for (const [blockName, params] of byBlock) {
  const pidLow = params[0].pidLow;
  const loc = CACHE_BLOCK_MAP[pidLow];
  if (!loc) {
    console.log(`  ${blockName}  pidLow=0x${pidLow.toString(16)}  (no cache mapping — skipped)`);
    continue;
  }
  const byId = new Map(paramRecsFor(loc.recs, loc.block).map((r) => [r.id, r]));
  console.log(`  ${blockName.padEnd(8)} pidLow=0x${pidLow.toString(16).padStart(2, '0')}  →  ${loc.section} block ${loc.block}  (${byId.size} records)`);

  for (const p of params) {
    const rec = byId.get(p.pidHigh);
    if (!rec) {
      const note = p.pidHigh > 0xff
        ? ' (out-of-band — expected not in cache)'
        : ' (NOT FOUND — investigate)';
      console.log(`      ${p.name.padEnd(8)} pidHigh=0x${p.pidHigh.toString(16).padStart(4, '0')}${note}`);
      if (p.pidHigh <= 0xff) unverified++;
      continue;
    }
    const expectEnum = p.unit === 'enum';
    const kindOk = expectEnum ? rec.kind === 'enum' : rec.kind === 'float';
    const ok = kindOk ? '✓' : '✗';
    const extra = rec.kind === 'enum'
      ? `enum count=${rec.values!.length} [${rec.values![0]}…]`
      : `float [${rec.a}..${rec.b}]`;
    console.log(`      ${ok} ${p.name.padEnd(8)} pidHigh=0x${p.pidHigh.toString(16).padStart(4, '0')}  id=${rec.id} unit=${p.unit}  ${extra}`);
    if (kindOk) verified++;
    else unverified++;
  }
  console.log('');
}
console.log(`verified: ${verified} params, unverified: ${unverified} params`);

// Dump each main block's candidate parameter set — source data for the
// next step, auto-generating KNOWN_PARAMS entries.
console.log('\n=== Block parameter tables ===');
for (const [pidLow, loc] of Object.entries(CACHE_BLOCK_MAP)) {
  const recs = paramRecsFor(loc.recs, loc.block).sort((a, b) => a.id - b.id);
  console.log(`\npidLow=0x${Number(pidLow).toString(16)}  (${loc.section} block ${loc.block}, ${recs.length} params):`);
  for (const r of recs) {
    if (r.kind === 'enum') {
      console.log(`  id=${r.id.toString().padStart(3)}  enum × ${r.values!.length}  [${r.values![0]}${r.values!.length > 1 ? ', …, ' + r.values![r.values!.length - 1] : ''}]`);
    } else {
      console.log(`  id=${r.id.toString().padStart(3)}  float  a=${r.a} b=${r.b} c=${r.c} d=${r.d}`);
    }
  }
}
