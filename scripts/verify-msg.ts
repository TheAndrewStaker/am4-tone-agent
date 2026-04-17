/**
 * Verify built SET_PARAM messages match captured wire bytes byte-for-byte.
 * Run:  npx tsx scripts/verify-msg.ts
 */
import { buildSetFloatParam, buildSetParam } from '../src/protocol/setParam.js';
import { KNOWN_PARAMS } from '../src/protocol/params.js';

function hex(arr: number[]): string {
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cases: { label: string; built: number[]; expected: string }[] = [
  {
    label: 'Amp Gain = 0.0 (internal 0.0)',
    built: buildSetFloatParam(KNOWN_PARAMS['amp.gain'], 0.0),
    expected: 'f000017415013a000b00010000000400000000000025f7',
  },
  {
    label: 'EQ band 1 = -1.0 dB (internal -1/12)',
    built: buildSetFloatParam({ pidLow: 0x003a, pidHigh: 0x003e }, -1 / 12),
    expected: 'f000017415013a003e00010000000400556a552b6839f7',
  },
  {
    label: 'buildSetParam("amp.gain", 0) — high-level path matches low-level',
    built: buildSetParam('amp.gain', 0),
    expected: 'f000017415013a000b00010000000400000000000025f7',
  },
  {
    label: 'buildSetParam("amp.bass", 6) — matches session-06 capture',
    built: buildSetParam('amp.bass', 6),
    expected: 'f000017415013a000c000100000004004d2623137801f7',
  },
  {
    label: 'buildSetParam("amp.channel", 1) — matches session-09 channel-B toggle',
    built: buildSetParam('amp.channel', 1),
    expected: 'f000017415013a00520f010000000400000010037818f7',
  },
  {
    label: 'buildSetParam("chorus.type", 1) — matches session-18 chorus-type',
    built: buildSetParam('chorus.type', 1),
    expected: 'f000017415014e000a0001000000040000001003783bf7',
  },
  {
    label: 'buildSetParam("flanger.type", 8) — matches session-18 flanger-type',
    built: buildSetParam('flanger.type', 8),
    expected: 'f0000174150152000a00010000000400000000040840f7',
  },
  {
    label: 'buildSetParam("phaser.type", 3) — matches session-18 phaser-type',
    built: buildSetParam('phaser.type', 3),
    expected: 'f000017415015a000a00010000000400000008040048f7',
  },
  {
    label: 'buildSetParam("wah.type", 2) — matches session-18 wah-type',
    built: buildSetParam('wah.type', 2),
    expected: 'f000017415015e000a00010000000400000000040044f7',
  },
  {
    label: 'buildSetParam("compressor.type", 2) — matches session-18 comp-type',
    built: buildSetParam('compressor.type', 2),
    expected: 'f000017415012e00130001000000040000000004002df7',
  },
  {
    label: 'buildSetParam("geq.type", 7) — matches session-18 geq-type',
    built: buildSetParam('geq.type', 7),
    expected: 'f000017415013200140001000000040000001c04002af7',
  },
  {
    label: 'buildSetParam("filter.type", 16) — matches session-18 filter-type',
    built: buildSetParam('filter.type', 16),
    expected: 'f0000174150172000a00010000000400000010040870f7',
  },
  {
    label: 'buildSetParam("tremolo.type", 3) — matches session-18 tremolo-type',
    built: buildSetParam('tremolo.type', 3),
    expected: 'f000017415016a000a00010000000400000008040078f7',
  },
  {
    label: 'buildSetParam("enhancer.type", 2) — matches session-18 enhancer-type',
    built: buildSetParam('enhancer.type', 2),
    expected: 'f000017415017a000e00010000000400000000040064f7',
  },
  {
    label: 'buildSetParam("gate.type", 3) — matches session-18 gate-type',
    built: buildSetParam('gate.type', 3),
    expected: 'f0000174150112011300010000000400000008040018f7',
  },
  {
    label: 'buildSetParam("volpan.mode", 1) — matches session-18 volpan-taper (actually Mode dropdown)',
    built: buildSetParam('volpan.mode', 1),
    expected: 'f0000174150166000f00010000000400000010037816f7',
  },
];

let pass = 0;
for (const c of cases) {
  const got = hex(c.built);
  const ok = got === c.expected;
  if (ok) pass++;
  console.log(`${c.label}`);
  console.log(`  built   : ${got}`);
  console.log(`  expected: ${c.expected}`);
  console.log(`  ${ok ? '✓ MATCH' : '✗ MISMATCH'}\n`);
}
console.log(`${pass}/${cases.length} cases match.`);
process.exit(pass === cases.length ? 0 : 1);
