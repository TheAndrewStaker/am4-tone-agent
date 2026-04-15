/**
 * Verify built SET_PARAM messages match captured wire bytes byte-for-byte.
 * Run:  npx tsx scripts/verify-msg.ts
 */
import { buildSetFloatParam, KNOWN_PARAMS } from '../src/protocol/setParam.js';

function hex(arr: number[]): string {
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cases: { label: string; built: number[]; expected: string }[] = [
  {
    label: 'Amp Gain = 0.0 (internal 0.0)',
    built: buildSetFloatParam(KNOWN_PARAMS.AMP_GAIN_PRESET_A01, 0.0),
    expected: 'f000017415013a000b00010000000400000000000025f7',
  },
  {
    label: 'EQ band 1 = -1.0 dB (internal -1/12)',
    built: buildSetFloatParam({ pidLow: 0x003a, pidHigh: 0x003e }, -1 / 12),
    expected: 'f000017415013a003e00010000000400556a552b6839f7',
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
