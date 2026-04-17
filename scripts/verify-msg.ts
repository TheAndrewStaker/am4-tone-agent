/**
 * Verify built SET_PARAM messages match captured wire bytes byte-for-byte.
 * Run:  npx tsx scripts/verify-msg.ts
 */
import {
  buildSaveToLocation,
  buildSetBlockType,
  buildSetFloatParam,
  buildSetParam,
  buildSetPresetName,
  buildSwitchScene,
} from '../src/protocol/setParam.js';
import { KNOWN_PARAMS } from '../src/protocol/params.js';
import { BLOCK_TYPE_VALUES } from '../src/protocol/blockTypes.js';
import { parseLocationCode } from '../src/protocol/locations.js';

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
    label: 'buildSetParam("drive.channel", 1) — matches session-18 drive-channel-a-b',
    built: buildSetParam('drive.channel', 1),
    expected: 'f000017415017600520f010000000400000010037854f7',
  },
  {
    label: 'buildSetParam("reverb.channel", 1) — matches session-18 reverb-channel-a-b',
    built: buildSetParam('reverb.channel', 1),
    expected: 'f000017415014200520f010000000400000010037860f7',
  },
  {
    label: 'buildSetParam("delay.channel", 1) — matches session-18 delay-channel-a-b',
    built: buildSetParam('delay.channel', 1),
    expected: 'f000017415014600520f010000000400000010037864f7',
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
  // Session-18 block-placement captures. pidHigh base was 0x0010 when we
  // first wrote these tests; Session 19 hardware mapping showed position
  // 1 should send pidHigh 0x000F, not 0x0010, so captured pidHighs
  // 0x10/0x11/0x12 correspond to positions 2/3/4 under the corrected
  // base address (not 1/2/3 as initially assumed from filenames).
  {
    label: 'buildSetBlockType(2, none) — matches session-18 block-clear-to-none',
    built: buildSetBlockType(2, BLOCK_TYPE_VALUES.none),
    expected: 'f000017415014e01100001000000040000000000004bf7',
  },
  {
    label: 'buildSetBlockType(3, reverb) — matches session-18 block-type-gte-to-rev',
    built: buildSetBlockType(3, BLOCK_TYPE_VALUES.reverb),
    expected: 'f000017415014e01110001000000040000001044100ef7',
  },
  {
    label: 'buildSetBlockType(4, amp) — matches session-18 block-add-none-to-amp',
    built: buildSetBlockType(4, BLOCK_TYPE_VALUES.amp),
    expected: 'f000017415014e01120001000000040000000d041050f7',
  },
  {
    label: 'buildSaveToLocation(Z04) — matches session-18 save-preset-z04',
    built: buildSaveToLocation(parseLocationCode('Z04')),
    expected: 'f00001741501000000001b000000040033400000007df7',
  },
  {
    label: 'buildSetPresetName(Z04, "boston") — matches session-20-rename-preset',
    built: buildSetPresetName(parseLocationCode('Z04'), 'boston'),
    expected: 'f000017415014e010b000c00000024003340000003095e733a1b6d6201004020100804020100402010080402010040201008040201004020100009f7',
  },
  {
    // TENTATIVE — only switch-to-scene-2 captured. pidHigh=0x000D + value=u32
    // scene index is extrapolated from the block-placement / save-to-slot
    // pattern. Need captures of switches to scenes 1/3/4 to confirm.
    label: 'buildSwitchScene(1) — matches session-18-switch-scene',
    built: buildSwitchScene(1),
    expected: 'f000017415014e010d00010000000400004000000016f7',
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
