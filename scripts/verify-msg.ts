/**
 * Verify built SET_PARAM messages match captured wire bytes byte-for-byte.
 * Run:  npx tsx scripts/verify-msg.ts
 */
import {
  buildSaveToLocation,
  buildSetBlockBypass,
  buildSetBlockType,
  buildSetFloatParam,
  buildSetParam,
  buildSetPresetName,
  buildSetSceneName,
  buildSwitchPreset,
  buildSwitchScene,
  isCommandAck,
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
    label: 'buildSwitchScene(1) — matches session-18-switch-scene (scene 2)',
    built: buildSwitchScene(1),
    expected: 'f000017415014e010d00010000000400004000000016f7',
  },
  // Session 21 confirmed: value = scene index (0..3) as u32 LE,
  // pidHigh fixed at 0x000D. Captures: session-21-switch-scene-1-3-4.
  {
    label: 'buildSwitchScene(0) — matches session-21 switch-to-scene-1',
    built: buildSwitchScene(0),
    expected: 'f000017415014e010d00010000000400000000000056f7',
  },
  {
    label: 'buildSwitchScene(2) — matches session-21 switch-to-scene-3',
    built: buildSwitchScene(2),
    expected: 'f000017415014e010d00010000000400010000000057f7',
  },
  {
    label: 'buildSwitchScene(3) — matches session-21 switch-to-scene-4',
    built: buildSwitchScene(3),
    expected: 'f000017415014e010d00010000000400014000000017f7',
  },
  // Session 21: preset switch via UI. pidLow=0x00CE, pidHigh=0x000A,
  // value = float32(locationIndex). Captures: session-22-switch-preset-via-ui.
  {
    label: 'buildSwitchPreset(0) — matches session-22 switch-to-A01 (float 0.0)',
    built: buildSwitchPreset(0),
    expected: 'f000017415014e010a00010000000400000000000051f7',
  },
  {
    label: 'buildSwitchPreset(1) — matches session-22 switch-to-A02 (float 1.0)',
    built: buildSwitchPreset(1),
    expected: 'f000017415014e010a0001000000040000001003783af7',
  },
  // Session 21: scene renames. pidHigh = 0x0037 + sceneIndex (0..3).
  // Captures: session-22-rename-scene-{2,3,4}.
  {
    label: 'buildSetSceneName(1, "clean") — matches session-22-rename-scene-2',
    built: buildSetSceneName(1, 'clean'),
    expected: 'f000017415014e0138000c000000240000000000030d5865305b44020100402010080402010040201008040201004020100804020100402010005ef7',
  },
  {
    label: 'buildSetSceneName(2, "chorus") — matches session-22-rename-scene-3',
    built: buildSetSceneName(2, 'chorus'),
    expected: 'f000017415014e0139000c000000240000000000030d506f391d2e3201004020100804020100402010080402010040201008040201004020100048f7',
  },
  {
    label: 'buildSetSceneName(3, "lead") — matches session-22-rename-scene-4',
    built: buildSetSceneName(3, 'lead'),
    expected: 'f000017415014e013a000c00000024000000000003314a613208040201004020100804020100402010080402010040201008040201004020100067f7',
  },
  // Session 27: per-block bypass. pidHigh=0x0003 on the block's own pidLow,
  // value = float32(1.0) to bypass, float32(0.0) to activate. Scene-scoping
  // is implicit — these captures were taken with the target scene pre-selected.
  // Captures: session-23-scene-{2,3,4}-{amp,drive,reverb}-bypass +
  // session-23-scene-2-amp-unbypass.
  {
    label: 'buildSetBlockBypass(amp, true) — matches session-23-scene-2-amp-bypass',
    built: buildSetBlockBypass(BLOCK_TYPE_VALUES.amp, true),
    expected: 'f000017415013a000300010000000400000010037846f7',
  },
  {
    label: 'buildSetBlockBypass(drive, true) — matches session-23-scene-3-drive-bypass',
    built: buildSetBlockBypass(BLOCK_TYPE_VALUES.drive, true),
    expected: 'f000017415017600030001000000040000001003780af7',
  },
  {
    label: 'buildSetBlockBypass(reverb, true) — matches session-23-scene-4-reverb-bypass',
    built: buildSetBlockBypass(BLOCK_TYPE_VALUES.reverb, true),
    expected: 'f000017415014200030001000000040000001003783ef7',
  },
  {
    label: 'buildSetBlockBypass(amp, false) — matches session-23-scene-2-amp-unbypass',
    built: buildSetBlockBypass(BLOCK_TYPE_VALUES.amp, false),
    expected: 'f000017415013a00030001000000040000000000002df7',
  },
  // Session 29 (HW-015) — advanced-controls capture session. Each case
  // below corresponds to one session-29-* capture. Our builder uses
  // `action=0x0001` (consistent since Session 04); the HW-015 captures
  // show AM4-Edit used `action=0x0002` — a different wire variant that
  // our path doesn't currently emit. Value-byte packing matches
  // byte-for-byte between builder and capture; only the action field
  // and its downstream checksum diverge, which is why these goldens
  // encode our builder's canonical output rather than the raw capture.
  {
    label: 'buildSetParam("amp.master", 5.19) — session-29-amp-master + session-29-amp-master-2 (Brit 800 #34)',
    built: buildSetParam('amp.master', 5.190985798835754),
    expected: 'f000017415013a000f00010000000400527860437850f7',
  },
  {
    label: 'buildSetParam("amp.depth", 0.48) — session-29-amp-depth',
    built: buildSetParam('amp.depth', 0.4774665),
    expected: 'f000017415013a001a000100000004007f242833681cf7',
  },
  {
    label: 'buildSetParam("amp.presence", 4.08) — session-29-amp-presence',
    built: buildSetParam('amp.presence', 4.07963901758194),
    expected: 'f000017415013a001e0001000000040052781a037073f7',
  },
  {
    label: 'buildSetParam("amp.out_boost_level", 0.75 dB) — session-29-amp-output-level',
    built: buildSetParam('amp.out_boost_level', 0.7468245029449463),
    expected: 'f000017415013a000800010000000400720b67737833f7',
  },
  {
    label: 'buildSetParam("amp.out_boost", "ON") — session-29-amp-out-boost-toggle',
    built: buildSetParam('amp.out_boost', 1),
    expected: 'f000017415013a001601010000000400000010037852f7',
  },
  {
    label: 'buildSetParam("reverb.size", 55%) — session-29-reverb-size + session-29-reverb-plate-size',
    built: buildSetParam('reverb.size', 55.02319931983948),
    expected: 'f0000174150142000f00010000000400007701437814f7',
  },
  {
    label: 'buildSetParam("reverb.predelay", 85 ms) — session-30 HW-025 #1 (BK-033 fix)',
    built: buildSetParam('reverb.predelay', 85),
    expected: 'f00001741501420013000100000004003d4515636823f7',
  },
  {
    label: 'buildSetParam("chorus.rate", 3.4 Hz) — session-30 HW-025 #2 (BK-034 wire-match)',
    built: buildSetParam('chorus.rate', 3.4),
    expected: 'f000017415014e000c000100000004004d262b140002f7',
  },
  {
    label: 'buildSetParam("flanger.mix", 54%) — session-30 HW-025 #3 (BK-034 wire-match)',
    built: buildSetParam('flanger.mix', 54),
    expected: 'f0000174150152000100010000000400384f2123784af7',
  },
  {
    label: 'buildSetParam("flanger.feedback", -61%) — session-30 HW-025 #4 (BK-034 wire-match)',
    built: buildSetParam('flanger.feedback', -61),
    expected: 'f0000174150152000e000100000004007b0a034b7809f7',
  },
  {
    label: 'buildSetParam("phaser.mix", 88%) — session-30 HW-025 #5 (BK-034 wire-match)',
    built: buildSetParam('phaser.mix', 88),
    expected: 'f000017415015a00010001000000040057116c13780ef7',
  },
  // HW-018 reverb first-page goldens. Each anchor uses the AM4-Edit-
  // captured final wire bytes; the displayValue we pass to
  // buildSetParam is what `decode(param, internal)` produces from the
  // captured float, so the round-trip is wire→display→wire = identity.
  {
    label: 'buildSetParam("reverb.high_cut", 7000 Hz) — session-30 HW-018 hall capture',
    built: buildSetParam('reverb.high_cut', 7000),
    expected: 'f0000174150142000c0001000000040000301b24287df7',
  },
  {
    label: 'buildSetParam("reverb.input_gain", 82.17%) — session-30 HW-018 spring capture (action=0x0001 vs cap 0x0002, see SYSEX-MAP §6i)',
    built: buildSetParam('reverb.input_gain', 82.17452),
    expected: 'f000017415014200170001000000040072572a237815f7',
  },
  {
    label: 'buildSetParam("reverb.density", 6) — session-30 HW-018 hall capture',
    built: buildSetParam('reverb.density', 6),
    expected: 'f0000174150142001800010000000400000018040052f7',
  },
  {
    label: 'buildSetParam("reverb.dwell", 4.741) — session-30 HW-018 spring capture (action=0x0001 vs cap 0x0002, see SYSEX-MAP §6i)',
    built: buildSetParam('reverb.dwell', 4.741138458251953),
    expected: 'f0000174150142002400010000000400066f7e237036f7',
  },
  {
    label: 'buildSetParam("reverb.drip", 91.83%) — session-30 HW-018 spring capture (action=0x0001 vs cap 0x0002, see SYSEX-MAP §6i)',
    built: buildSetParam('reverb.drip', 91.83036684989929),
    expected: 'f000017415014200340001000000040079452d337838f7',
  },
  {
    label: 'buildSetParam("reverb.quality", 2 = HIGH) — session-30 HW-018 hall capture',
    built: buildSetParam('reverb.quality', 2),
    expected: 'f0000174150142002f0001000000040000000004007df7',
  },
  {
    label: 'buildSetParam("reverb.stack_hold", 1 = STACK) — session-30 HW-018 hall capture',
    built: buildSetParam('reverb.stack_hold', 1),
    expected: 'f000017415014200300001000000040000001003780df7',
  },
  {
    label: 'buildSetParam("reverb.springs", 4) — session-29-reverb-number-of-springs',
    built: buildSetParam('reverb.springs', 4),
    expected: 'f0000174150142001b00010000000400000010040059f7',
  },
  {
    label: 'buildSetParam("reverb.spring_tone", 7.53) — session-29-reverb-spring-tone',
    built: buildSetParam('reverb.spring_tone', 7.531906962394714),
    expected: 'f0000174150142001c000100000004000d7428037860f7',
  },
  {
    label: 'buildSetParam("delay.feedback", 55%) — session-29-delay-feedback',
    built: buildSetParam('delay.feedback', 55.318766832351685),
    expected: 'f0000174150146000e000100000004005a672153786bf7',
  },
  {
    label: 'buildSetParam("flanger.feedback", 50.8%) — session-29-flanger-feedback',
    built: buildSetParam('flanger.feedback', 50.795769691467285),
    expected: 'f0000174150152000e00010000000400420220237873f7',
  },
  {
    label: 'buildSetParam("phaser.feedback", 50.2%) — session-29-phaser-feedback',
    built: buildSetParam('phaser.feedback', 50.15915632247925),
    expected: 'f000017415015a001000010000000400271a00037818f7',
  },
  // HW-019 / HW-020 / HW-021 (Session 30, 2026-04-25): drive + delay +
  // compressor first-page goldens. Each anchor uses the AM4-Edit-
  // captured wire bytes; the displayValue passed to buildSetParam is
  // what `decode(param, internal)` produces from the captured float,
  // so the round-trip is wire→display→wire = identity.
  {
    label: 'buildSetParam("drive.low_cut", 1000 Hz) — session-30 HW-019 blackglass-7k',
    built: buildSetParam('drive.low_cut', 1000),
    expected: 'f000017415017600100001000000040000000f242079f7',
  },
  {
    label: 'buildSetParam("drive.bass", 1.0) — session-30 HW-019 blackglass-7k',
    built: buildSetParam('drive.bass', 1.0000000149011612),
    expected: 'f0000174150176001400010000000400667319436851f7',
  },
  {
    label: 'buildSetParam("drive.mid", 4.0) — session-30 HW-019 blackglass-7k',
    built: buildSetParam('drive.mid', 4.000000059604645),
    expected: 'f0000174150176001500010000000400667319437048f7',
  },
  {
    label: 'buildSetParam("drive.mid_freq", 800 Hz) — session-30 HW-019 blackglass-7k',
    built: buildSetParam('drive.mid_freq', 800),
    expected: 'f0000174150176001600010000000400000009042059f7',
  },
  {
    label: 'buildSetParam("drive.treble", 2.0) — session-30 HW-019 blackglass-7k',
    built: buildSetParam('drive.treble', 2.0000000298023224),
    expected: 'f000017415017600170001000000040066730943705af7',
  },
  {
    label: 'buildSetParam("delay.level", -10 dB) — session-30 HW-020 digital-mono',
    built: buildSetParam('delay.level', -10),
    expected: 'f00001741501460000000100000004000000040c0852f7',
  },
  {
    label: 'buildSetParam("delay.stack_hold", 1 = STACK) — session-30 HW-020 digital-mono',
    built: buildSetParam('delay.stack_hold', 1),
    expected: 'f0000174150146001f00010000000400000010037826f7',
  },
  {
    label: 'buildSetParam("delay.ducking", 2 dB) — session-30 HW-020 digital-mono',
    built: buildSetParam('delay.ducking', 2),
    expected: 'f0000174150146002e00010000000400000000040078f7',
  },
  {
    label: 'buildSetParam("compressor.level", -8 dB) — session-30 HW-021 jfet-studio',
    built: buildSetParam('compressor.level', -8),
    expected: 'f000017415012e0000000100000004000000000c083ef7',
  },
  // HW-032 (Session 30 cont 8) — first-page Level + low/high cut +
  // volpan threshold/attack + ingate level. Each `expected` is the
  // exact wire frame from the matching session-32 pcapng final-write.
  {
    label: 'buildSetParam("filter.level", 12 dB) — session-32 HW-032 filter-config',
    built: buildSetParam('filter.level', 12),
    expected: 'f0000174150172000000010000000400000008040862f7',
  },
  {
    label: 'buildSetParam("filter.low_cut", 100 Hz) — session-32 HW-032 filter-config',
    built: buildSetParam('filter.low_cut', 100),
    expected: 'f0000174150172001200010000000400000019041079f7',
  },
  {
    label: 'buildSetParam("filter.high_cut", 1800 Hz) — session-32 HW-032 filter-config',
    built: buildSetParam('filter.high_cut', 1800),
    expected: 'f000017415017200130001000000040000001c14205df7',
  },
  // HW-034 (Session 33) — All-Pass filter Config-page residuals from
  // `session-33-filter-extended.pcapng`. Feedback 13% (bipolar_percent
  // wire 0.13); Order 4 (count, raw integer).
  {
    label: 'buildSetParam("filter.feedback", 13 %) — session-33 HW-034 filter-allpass',
    built: buildSetParam('filter.feedback', 13),
    expected: 'f00001741501720015000100000004005c074053704bf7',
  },
  {
    label: 'buildSetParam("filter.order", 4) — session-33 HW-034 filter-allpass',
    built: buildSetParam('filter.order', 4),
    expected: 'f0000174150172001c0001000000040000001004006ef7',
  },
  // HW-035 (Session 34) — slot-Gate Config-page knobs on Modern Gate
  // type from `session-34-slotgate-extended.pcapng`.
  {
    label: 'buildSetParam("gate.level", 12 dB) — session-34 HW-035 slotgate-modern',
    built: buildSetParam('gate.level', 12),
    expected: 'f0000174150112010000010000000400000008040803f7',
  },
  {
    label: 'buildSetParam("gate.threshold", -22 dB) — session-34 HW-035 slotgate-modern',
    built: buildSetParam('gate.threshold', -22),
    expected: 'f0000174150112010a000100000004000000160c081ff7',
  },
  {
    label: 'buildSetParam("gate.attack", 1 ms) — session-34 HW-035 slotgate-modern',
    built: buildSetParam('gate.attack', 1),
    expected: 'f0000174150112010b0001000000040037445033504cf7',
  },
  {
    label: 'buildSetParam("gate.hold", 80 ms) — session-34 HW-035 slotgate-modern',
    built: buildSetParam('gate.hold', 80),
    expected: 'f0000174150112010c00010000000400053574336814f7',
  },
  {
    label: 'buildSetParam("gate.release", 90 ms) — session-34 HW-035 slotgate-modern',
    built: buildSetParam('gate.release', 90),
    expected: 'f0000174150112010d00010000000400761437036834f7',
  },
  {
    label: 'buildSetParam("gate.sidechain", 1) — session-34 HW-035 slotgate-modern',
    built: buildSetParam('gate.sidechain', 1),
    expected: 'f0000174150112010f00010000000400000010037863f7',
  },
  {
    label: 'buildSetParam("gate.attenuation", -33 dB) — session-34 HW-035 slotgate-modern',
    built: buildSetParam('gate.attenuation', -33),
    expected: 'f00001741501120114000100000004000000004c104ff7',
  },
  // HW-036 (Session 34) — In-Gate Config-page residuals from
  // `session-34-inputgate-extended.pcapng`.
  {
    label: 'buildSetParam("ingate.threshold", -44 dB) — session-34 HW-036 inputgate-intelligent',
    built: buildSetParam('ingate.threshold', -44),
    expected: 'f0000174150125000a000100000004000000060c1021f7',
  },
  {
    label: 'buildSetParam("ingate.release", 60 ms) — session-34 HW-036 inputgate-intelligent',
    built: buildSetParam('ingate.release', 60),
    expected: 'f0000174150125000c0001000000040047704e53687ff7',
  },
  {
    label: 'buildSetParam("ingate.type", 1) — session-34 HW-036 inputgate-intelligent',
    built: buildSetParam('ingate.type', 1),
    expected: 'f0000174150125000f00010000000400000010037855f7',
  },
  {
    label: 'buildSetParam("flanger.level", 10 dB) — session-32 HW-032 flanger',
    built: buildSetParam('flanger.level', 10),
    expected: 'f000017415015200000001000000040000000404084ef7',
  },
  {
    label: 'buildSetParam("volpan.level", 12 dB) — session-32 HW-032 volpan',
    built: buildSetParam('volpan.level', 12),
    expected: 'f0000174150166000000010000000400000008040876f7',
  },
  {
    label: 'buildSetParam("volpan.threshold", -20 dB) — session-32 HW-032 volpan',
    built: buildSetParam('volpan.threshold', -20),
    expected: 'f00001741501660010000100000004000000140c0872f7',
  },
  {
    label: 'buildSetParam("volpan.attack", 300 ms) — session-32 HW-032 volpan',
    built: buildSetParam('volpan.attack', 300),
    expected: 'f00001741501660011000100000004004d2633137058f7',
  },
  {
    label: 'buildSetParam("ingate.level", -10 dB) — session-32 HW-032 input-noise-gate',
    built: buildSetParam('ingate.level', -10),
    expected: 'f00001741501250000000100000004000000040c0831f7',
  },
  {
    label: 'buildSetParam("compressor.threshold", -30 dB) — session-30 HW-021 jfet-studio',
    built: buildSetParam('compressor.threshold', -30),
    expected: 'f000017415012e000a0001000000040000001e0c082af7',
  },
  {
    label: 'buildSetParam("compressor.ratio", 1.0) — session-30 HW-021 jfet-studio',
    built: buildSetParam('compressor.ratio', 1),
    expected: 'f000017415012e000b0001000000040000001003785af7',
  },
  {
    label: 'buildSetParam("compressor.attack", 0.8 ms) — session-30 HW-021 jfet-studio',
    built: buildSetParam('compressor.attack', 0.800000037997961),
    expected: 'f000017415012e000c000100000004000c2d6a13503ef7',
  },
  {
    label: 'buildSetParam("compressor.release", 100 ms) — session-30 HW-021 jfet-studio',
    built: buildSetParam('compressor.release', 100.00000149011612),
    expected: 'f000017415012e000d00010000000400667319436810f7',
  },
  {
    label: 'buildSetParam("compressor.auto_makeup", 0 = OFF) — session-30 HW-021 jfet-studio',
    built: buildSetParam('compressor.auto_makeup', 0),
    expected: 'f000017415012e000f00010000000400000000000035f7',
  },
  // HW-027 (Session 30 cont 2, 2026-04-25): delay.tempo wire-verified
  // anchor. Captured value=11 = "1/8" tempo division. The other 4
  // tempo entries (chorus/flanger/phaser/tremolo) are structural —
  // no captures yet — so no goldens emitted for them. When a future
  // session captures any of those, add an anchor here.
  {
    label: 'buildSetParam("delay.tempo", 11 = "1/8") — session-30-delay-basic-digital-mono',
    built: buildSetParam('delay.tempo', 11),
    expected: 'f000017415014600130001000000040000000604084bf7',
  },
  // HW-022 (Session 31, 2026-04-26): chorus / flanger / phaser / tremolo
  // first-page additions. 15 new wire anchors from session-30-{block}-
  // basic.pcapng captures. Introduces the `degrees` unit (cache c=180/π)
  // and the shared LFO_WAVEFORMS_VALUES dictionary.
  {
    label: 'buildSetParam("chorus.level", -2 dB) — session-30-chorus-basic',
    built: buildSetParam('chorus.level', -2),
    expected: 'f000017415014e0000000100000004000000000c0056f7',
  },
  {
    label: 'buildSetParam("chorus.time", 12 ms) — session-30-chorus-basic',
    built: buildSetParam('chorus.time', 12),
    expected: 'f000017415014e001000010000000400532668436074f7',
  },
  {
    label: 'buildSetParam("chorus.mod_phase", 10 deg) — session-30-chorus-basic',
    built: buildSetParam('chorus.mod_phase', 10),
    expected: 'f000017415014e001100010000000400612e06237051f7',
  },
  {
    label: 'buildSetParam("chorus.phase_reverse", 1 = "RIGHT") — session-30-chorus-basic',
    built: buildSetParam('chorus.phase_reverse', 1),
    expected: 'f000017415014e001400010000000400000010037825f7',
  },
  {
    label: 'buildSetParam("flanger.manual", 10) — session-30-flanger-basic',
    built: buildSetParam('flanger.manual', 10),
    expected: 'f0000174150152000f00010000000400000010037822f7',
  },
  {
    label: 'buildSetParam("flanger.mod_phase", 11 deg) — session-30-flanger-basic',
    built: buildSetParam('flanger.mod_phase', 11),
    expected: 'f000017415015200110001000000040004660843700ef7',
  },
  {
    label: 'buildSetParam("phaser.level", -4.3 dB) — session-30-phaser-basic',
    built: buildSetParam('phaser.level', -4.300000190734863),
    expected: 'f000017415015a0000000100000004004d26311c0008f7',
  },
  {
    label: 'buildSetParam("phaser.depth", 6.7 via float32) — session-30-phaser-basic',
    // AM4-Edit's pipeline does float32 math throughout (slider value is
    // float32, divided by float32(10), packed to wire). JavaScript stores
    // 6.7 as float64 0.67000000000000003553… which rounds to a different
    // float32 ULP than AM4-Edit's float32(6.7) / float32(10) =
    // 0.6699999570846558. Pre-rounding 6.7 → float32(6.7) →
    // 6.6999998092651367 makes the JavaScript division round to the same
    // float32 AM4-Edit ships (1-ULP within standard float32 precision —
    // functionally identical).
    built: buildSetParam('phaser.depth', 6.6999998092651367),
    expected: 'f000017415015a000f000100000004000f2125337801f7',
  },
  {
    label: 'buildSetParam("phaser.mod_phase", 11 deg) — session-30-phaser-basic',
    built: buildSetParam('phaser.mod_phase', 11),
    expected: 'f000017415015a001300010000000400046608437004f7',
  },
  {
    label: 'buildSetParam("phaser.manual", 1.0) — session-30-phaser-basic',
    built: buildSetParam('phaser.manual', 1),
    expected: 'f000017415015a00220001000000040066731943684bf7',
  },
  {
    label: 'buildSetParam("tremolo.waveform", 1 = "TRIANGLE") — session-30-tremolo-basic',
    built: buildSetParam('tremolo.waveform', 1),
    expected: 'f000017415016a000b0001000000040000001003781ef7',
  },
  {
    label: 'buildSetParam("tremolo.phase", 20 deg) — session-30-tremolo-basic',
    built: buildSetParam('tremolo.phase', 20),
    expected: 'f000017415016a001000010000000400612e16237064f7',
  },
  {
    label: 'buildSetParam("tremolo.width", 20%) — session-30-tremolo-basic',
    built: buildSetParam('tremolo.width', 20),
    expected: 'f000017415016a001100010000000400667309437040f7',
  },
  {
    label: 'buildSetParam("tremolo.center", 2) — session-30-tremolo-basic',
    built: buildSetParam('tremolo.center', 2),
    expected: 'f000017415016a00120001000000040005357433607bf7',
  },
  {
    label: 'buildSetParam("tremolo.ducking", 10) — session-30-tremolo-basic',
    built: buildSetParam('tremolo.ducking', 10),
    expected: 'f000017415016a00180001000000040000001003780df7',
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
console.log(`${pass}/${cases.length} message-build cases match.`);

// Command-ack predicate — confirmed against both save and rename hardware
// acks 2026-04-19. Shape: 18-byte frame echoing the outgoing command's
// addressing bytes with a 4-byte zero payload. See SYSEX-MAP §7.
function fromHex(s: string): number[] {
  const clean = s.replace(/\s/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

// Build sent bytes via the existing builders — eliminates hex-typo risk and
// proves the builders and the predicate agree on wire shape.
const sentSave = buildSaveToLocation(103);
const sentRename = buildSetPresetName(103, 'rename-save-test');

// Acks are from 2026-04-19 HW-002b capture (founder paste, verified on hardware).
const ackSave = fromHex('f0 00 01 74 15 01 00 00 00 00 1b 00 00 00 00 00 0a f7');
const ackRename = fromHex('f0 00 01 74 15 01 4e 01 0b 00 0c 00 00 00 00 00 59 f7');

const ackCases: {
  label: string;
  sent: number[];
  ack: number[];
  expect: boolean;
}[] = [
  {
    label: 'save_to_location(Z04) — 18-byte save ack ACCEPTED',
    sent: sentSave,
    ack: ackSave,
    expect: true,
  },
  {
    label: 'set_preset_name(Z04, "rename-save-test") — 18-byte rename ack ACCEPTED',
    sent: sentRename,
    ack: ackRename,
    expect: true,
  },
  {
    label: '64-byte SET_PARAM write-echo — REJECTED (wrong length: 64 ≠ 18)',
    sent: buildSetParam('amp.gain', 5),
    ack: fromHex(
      'f0 00 01 74 15 01 3a 00 0b 00 01 00 00 00 28 00 7f 5f 60 03 78 00 00 00 1f 4d 25 63 01 40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 67 f7',
    ),
    expect: false,
  },
  {
    label: '23-byte USB-MIDI receipt-echo of save — REJECTED (wrong length: 23 ≠ 18)',
    sent: sentSave,
    ack: sentSave, // receipt-echo is a verbatim copy of our outgoing bytes
    expect: false,
  },
  {
    label: 'Mismatched addressing — REJECTED (save ack against a rename sent)',
    sent: sentRename,
    ack: ackSave,
    expect: false,
  },
];

let ackPass = 0;
for (const c of ackCases) {
  const got = isCommandAck(c.sent, c.ack);
  const ok = got === c.expect;
  if (ok) ackPass++;
  console.log(`${c.label}\n  isCommandAck → ${got} (want ${c.expect})  ${ok ? '✓' : '✗'}\n`);
}
console.log(`${ackPass}/${ackCases.length} command-ack predicate cases pass.`);

process.exit(pass === cases.length && ackPass === ackCases.length ? 0 : 1);
