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
