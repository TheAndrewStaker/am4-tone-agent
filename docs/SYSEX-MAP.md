# AM4 SysEx Map — Working Protocol Reference

> **Status:** Phase 1 working reference.
> **Sources:** `docs/wiki/MIDI_SysEx.md`, `MIDI.md`, `Presets.md`, `Scenes.md`,
> `Channels.md`, `Modifiers_and_controllers.md` (scraped 2026-04-14).
> **Update on every sniff session:** flip entries from 🟡 INFERRED / 🔴 UNKNOWN
> to 🟢 CONFIRMED as they are verified against real AM4 traffic.

---

## Legend

- 🟢 **CONFIRMED** — Documented for AM4 on the Fractal wiki, or verified by
  sniffing AM4-Edit traffic against a real device. Safe to use.
- 🟡 **INFERRED** — Not documented for AM4, but the Axe-Fx II / AX8 spec
  defines this function ID and the Fractal SysEx family is historically
  consistent. Treat as a reasonable first guess; verify before shipping.
- 🔴 **UNKNOWN** — No wiki coverage, no reliable template. Requires
  sniffing to determine.

---

## 1. Device Model IDs 🟢

From `MIDI_SysEx.md`. AM4 is 0x15, which is the byte that sits in position 4
of every AM4 SysEx message.

| Hex | Device | SysEx coverage |
|-----|--------|----------------|
| 0x00 | Axe-Fx Standard | Legacy |
| 0x01 | Axe-Fx Ultra | Legacy |
| 0x02 | MFC-101 | Foot controller |
| 0x03 | Axe-Fx II | Fully documented |
| 0x04 | MFC-101 mk3 | Foot controller |
| 0x05 | FX8 | Partial |
| 0x06 | Axe-Fx II XL | Fully documented |
| 0x07 | Axe-Fx II XL+ | Fully documented |
| 0x08 | AX8 | Fully documented (main template for AM4) |
| 0x0A | FX8 mk2 | Partial |
| 0x10 | Axe-Fx III | Separate 3rd-party MIDI PDF |
| 0x11 | FM3 | Separate 3rd-party MIDI PDF |
| 0x12 | FM9 | Separate 3rd-party MIDI PDF |
| 0x14 | VP4 | 5 mode-switch commands only |
| **0x15** | **AM4** | **5 mode-switch commands only** |

---

## 2. Envelope Format 🟡

Inferred to be identical to the Axe-Fx II family structure. The 5 documented
AM4 commands follow this shape exactly, so the envelope itself is safe to
treat as confirmed.

```
Byte 0     0xF0        SysEx start
Byte 1     0x00        Manufacturer ID byte 0  ┐
Byte 2     0x01        Manufacturer ID byte 1  │ Fractal Audio (0x00 01 74)
Byte 3     0x74        Manufacturer ID byte 2  ┘
Byte 4     0x15        Model ID — AM4
Byte 5     0xdd        Function ID
Byte 6..N-2           Payload (function-specific)
Byte N-1   0xdd        Checksum (7-bit, XOR of F0..last payload byte, & 0x7F)
Byte N     0xF7        SysEx end
```

### Worked example — "Switch AM4 to Scenes mode" (🟢 confirmed on wiki)

```
F0 00 01 74 15 12 49 4B F7
│  └──┬──┘  │  │  └─┬─┘ │
│     │     │  │    │   └ SysEx end
│     │     │  │    └───── 49 = mode-switch argument (Scenes); 4B = checksum
│     │     │  └────────── 12 = Function ID (mode switch)
│     │     └───────────── 15 = AM4 model ID
│     └─────────────────── Fractal manufacturer ID
└───────────────────────── SysEx start
```

Checksum verification:
```
0xF0 ^ 0x00 ^ 0x01 ^ 0x74 ^ 0x15 ^ 0x12 ^ 0x49 = 0xCB
0xCB & 0x7F = 0x4B ✓
```

---

## 3. Checksum Algorithm 🟢

XOR every byte from SysEx start (`0xF0`) through the last payload byte
(inclusive), then AND the result with `0x7F` to strip the high bit. The
resulting 7-bit value sits directly before `0xF7`.

### TypeScript implementation

```typescript
function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7F;
}

function buildMessage(fn: number, payload: number[] = []): number[] {
  const body = [0xF0, 0x00, 0x01, 0x74, 0x15, fn, ...payload];
  return [...body, fractalChecksum(body), 0xF7];
}
```

### Response checksums 🟢

**All AM4 responses carry a checksum** (confirmed session 2026-04-14 —
observed on 0x08, 0x14, and 0x64 responses). Simpler than Axe-Fx II's
"some do, some don't" split. No known exceptions yet; `0x0D TUNER_INFO`
and `0x10 MIDI_TEMPO_BEAT` are still untested on AM4.

---

## 4. Officially Documented AM4 Commands 🟢

These are the only AM4 commands currently on the wiki. All use Function
ID `0x12` (mode switch).

| Mode | Full SysEx | Function | Arg | Checksum |
|------|-----------|----------|-----|----------|
| Presets | `F0 00 01 74 15 12 48 4A F7` | 0x12 | 0x48 | 0x4A |
| Amp mode | `F0 00 01 74 15 12 58 5A F7` | 0x12 | 0x58 | 0x5A |
| Scenes | `F0 00 01 74 15 12 49 4B F7` | 0x12 | 0x49 | 0x4B |
| Effects | `F0 00 01 74 15 12 4A 48 F7` | 0x12 | 0x4A | 0x48 |
| Tuner / tap | `F0 00 01 74 15 12 18 1A F7` | 0x12 | 0x18 | 0x1A |

### Sibling VP4 (0x14) — same function, different args

| Mode | SysEx | Arg |
|------|-------|-----|
| Presets | `F0 00 01 74 14 12 48 4B F7` | 0x48 |
| Scenes | `F0 00 01 74 14 12 49 4A F7` | 0x49 |
| Effects | `F0 00 01 74 14 12 4A 49 F7` | 0x4A |
| Tuner / tap | `F0 00 01 74 14 12 18 1B F7` | 0x18 |

VP4 and AM4 are preset-compatible per `Presets.md`, so VP4 sniffing data
should translate directly to AM4 in most cases. A VP4 is a useful secondary
reference if one is available.

---

## 5. Axe-Fx II / AX8 Function ID Template 🟡

This is our guessing table for AM4. Each entry below is documented on the
wiki for Axe-Fx II/AX8 (model 0x03 / 0x08) and is a reasonable first-probe
candidate for AM4 (model 0x15). Replace the AM4 model byte (`0x15`) into
each message and try.

| ID | Symbolic name | Direction | Priority for AM4 Phase 1 |
|----|---------------|-----------|--------------------------|
| 0x01 | GET_BLOCK_PARAMETERS_LIST | req | P1 — after 0x02 works |
| 0x02 | GET/SET_BLOCK_PARAMETER_VALUE | both | **P0 — live-tweak MVP** |
| 0x07 | GET/SET_MODIFIER_VALUE | both | P2 |
| 0x08 | GET_FIRMWARE_VERSION | both | 🟢 confirmed — v2.00 build Mar 20 2026 |
| 0x09 | SET_PRESET_NAME | req | P1 — try as AM4 name query (read side may differ) |
| 0x0D | TUNER_INFO | resp only | P2 |
| 0x0E | PRESET_BLOCKS_DATA | both | P1 — shape of loaded preset; may also carry name |
| 0x0F | GET_PRESET_NAME | req | 🔴 **REJECTED on AM4** (ACK with result 0x05) |
| 0x10 | MIDI_TEMPO_BEAT | resp only | P2 |
| 0x11 | GET/SET_BLOCK_XY | both | P1 (likely channel-select on AM4) |
| 0x12 | (mode switch) | req | 🟢 confirmed |
| 0x13 | GET_CPU_USAGE | both | P2 |
| 0x14 | GET_PRESET_NUMBER | both | 🟢 confirmed — 14-bit decode |
| 0x17 | GET_MIDI_CHANNEL | both | P2 |
| 0x20 | GET_GRID_LAYOUT_AND_ROUTING | both | P1 — preset structure |
| 0x21 | FRONT_PANEL_CHANGE_DETECTED | resp only | P1 — needs 0x08 first |
| 0x23 | MIDI_LOOPER_STATUS | both | N/A (AM4 has no looper) |
| 0x29 | GET/SET_SCENE_NUMBER | both | P1 |
| 0x2A | GET_PRESET_EDITED_STATUS | both | P2 |
| 0x2E | SET_TYPED_BLOCK_PARAMETER_VALUE | req | P2 (float variant of 0x02) |
| 0x32 | BATCH_LIST_REQUEST_START | resp only | P1 |
| 0x33 | BATCH_LIST_REQUEST_COMPLETE | resp only | P1 |
| 0x3C | SET_PRESET_NUMBER | req | **P0 — switch presets** |
| 0x42 | DISCONNECT_FROM_CONTROLLER | req | P1 — needed for clean shutdown after 0x08 |
| 0x64 | MULTIPURPOSE_RESPONSE | resp only | 🟢 confirmed — `[echoed_fn, result_code]` format |
| 0x7A / 0x7B / 0x7C | IR download protocol | req | P3 — IR loading |

### Phase 1 "live-tweak" MVP — the narrow path

The smallest shippable cut relies on just four function IDs:

1. **0x08 GET_FIRMWARE_VERSION** — handshake, proves two-way comms, unlocks
   `0x21` change-detected notifications.
2. **0x14 GET_PRESET_NUMBER** — read current state.
3. **0x0F GET_PRESET_NAME** — human-readable confirmation we're on the right slot.
4. **0x02 GET/SET_BLOCK_PARAMETER_VALUE** — tweak a parameter in real time.

If those four work, we have a demo-able product without needing to reverse
the preset binary format. Everything harder (full preset read/write, scene
encoding, modifier graphs) comes after.

---

## 6. Byte-Level Templates for Phase 1 Commands 🟡

All payloads below are **Axe-Fx II/AX8-derived guesses** for AM4. Expected
to work with just the model byte swapped, but verify every one on the
first sniff session.

### 0x08 GET_FIRMWARE_VERSION 🟢

```
Request:  F0 00 01 74 15 08 [CS] F7

Observed AM4 response (session 2026-04-14, firmware 2.00):
  F0 00 01 74 15 08 MAJ MIN R1 R2 R3 R4 R5 [build-date ASCII] 00 [nulls] [CS] F7

  Example: F0 00 01 74 15 08 02 00 03 04 05 00 00
           "Mar 20 2026 06:46:54" 00 00 00 00 00 00 00 00 00 00 00 00 67 F7

  MAJ = 0x02 (firmware major version 2)
  MIN = 0x00 (firmware minor version 0)
  R1..R5 = 03 04 05 00 00 (reserved, purpose unknown — stable across reads)
  Build date: null-terminated ASCII "Mon DD YYYY HH:MM:SS" format
  Null padding: appears to pad total response to a fixed length
```

**Note:** AM4 extends the Axe-Fx II format with a build-date string — the
prefix bytes through R5 are Axe-Fx II-compatible; everything after is AM4
(and probably newer Fractal products) specific.

After this request, the device is expected to begin broadcasting `0x21`
FRONT_PANEL_CHANGE_DETECTED whenever a front-panel value changes — behavior
not yet verified on AM4. Always send `0x42 DISCONNECT_FROM_CONTROLLER`
before closing the port.

### 0x14 GET_PRESET_NUMBER 🟢

```
Request:  F0 00 01 74 15 14 [CS] F7

Observed AM4 response (session 2026-04-14):
  F0 00 01 74 15 14 PP QQ [CS] F7

  Example: F0 00 01 74 15 14 00 00 04 F7
           decode14(0x00, 0x00) = 0 → slot A01
```

AM4 has 104 slots (A01–Z04), which fits in 7 bits — the high byte (QQ) is
expected to always be 0x00 in practice, but the decoding treats it as a
full 14-bit value for forward compatibility.

### 0x0F GET_PRESET_NAME 🔴 REJECTED on AM4

```
Request:  F0 00 01 74 15 0F [CS] F7

Observed AM4 response (session 2026-04-14):
  F0 00 01 74 15 64 0F 05 7E F7
  → MULTIPURPOSE_RESPONSE acknowledging 0x0F with result code 0x05

The command is parsed and checksum-validated, but AM4 returns a non-OK
result code. The actual preset-name query must use a different function
ID on AM4. Candidates to try on the next session:
  - 0x09 (Axe-Fx II SET_PRESET_NAME may be dual-purpose on AM4)
  - 0x0E PRESET_BLOCKS_DATA (may carry name in its payload)
  - Sniff AM4-Edit loading a preset and look for the name query
  - Scan function IDs 0x30–0x50 for unmapped responses
```

### 0x3C SET_PRESET_NUMBER

```
Request:  F0 00 01 74 15 3C PP QQ [CS] F7
          PP = preset # bits 0-6
          QQ = preset # bits 7-13 (expected to be 0 for AM4)

Expected response:
          F0 00 01 74 15 64 3C 00 [CS] F7   (0x64 MULTIPURPOSE_RESPONSE, OK)
```

### 0x64 MULTIPURPOSE_RESPONSE 🟢

The AM4's generic ACK / NACK for commands that don't have their own
structured response. Format:

```
F0 00 01 74 15 64 FN RC [CS] F7
  FN = function ID being acknowledged
  RC = result code
```

### Result codes (observed)

| RC | Meaning | Observed on |
|----|---------|-------------|
| 0x00 | OK / accepted | `0x12` mode switch |
| 0x05 | Command parsed, not honored (unsupported or invalid in current state) | `0x0F` GET_PRESET_NAME |

Treat any result code ≠ 0x00 as "we guessed wrong — investigate." The
parser should dispatch on `FN` to associate the ACK with the originating
request.

### 0x02 GET/SET_BLOCK_PARAMETER_VALUE

The heart of the live-tweak MVP. Request payload:

```
Request:  F0 00 01 74 15 02 B0 B1 P0 P1 V0 V1 V2 M [CS] F7
          B0 B1 = block ID (14-bit, bits 0-6 then 7-13)
          P0 P1 = parameter ID (14-bit, same encoding)
          V0 V1 V2 = parameter value (16-bit, bits 0-6 / 7-13 / 14-15)
          M = 0x00 query, 0x01 set

Expected response:
          F0 00 01 74 15 02 B0 B1 P0 P1 V0 V1 V2 L1 L2 ... Lk 00 [CS] F7
          Lk = parameter label as null-terminated ASCII, e.g. "GAIN"
```

**Special parameter ID 255 (0xFF 0x01) = bypass/engage:**

```
Engage block:  payload = B0 B1 FF 01 00 00 00 01
Bypass block:  payload = B0 B1 FF 01 01 00 00 01
```

---

## 7. Parameter Value Encoding 🟡

### 14-bit IDs (block ID, parameter ID)

```
byte0 = id & 0x7F
byte1 = (id >> 7) & 0x7F
```

```typescript
const encode14 = (n: number): [number, number] => [n & 0x7F, (n >> 7) & 0x7F];
const decode14 = (b0: number, b1: number): number =>
  (b0 & 0x7F) | ((b1 & 0x7F) << 7);
```

### 16-bit parameter values (0–65534)

```
byte0 = value & 0x7F
byte1 = (value >> 7) & 0x7F
byte2 = (value >> 14) & 0x7F
```

```typescript
const encode16 = (v: number): [number, number, number] => [
  v & 0x7F, (v >> 7) & 0x7F, (v >> 14) & 0x7F,
];
const decode16 = (b0: number, b1: number, b2: number): number =>
  (b0 & 0x7F) | ((b1 & 0x7F) << 7) | ((b2 & 0x7F) << 14);
```

### 32-bit float (0x2E SET_TYPED_BLOCK_PARAMETER_VALUE only)

5 bytes, split 7+7+7+7+4 — rarely needed on AM4 since the integer form
(`0x02`) is simpler and covers the same parameters.

---

## 8. Block IDs 🟡

**⚠️ The numbers below are Axe-Fx II/AX8 block IDs. AM4 block IDs are
undocumented.** Historical pattern suggests the Fractal family keeps block
IDs stable across products where the block exists — but this is a
guess-and-check situation. Every ID below needs verification.

From the `Effects_list` wiki page (🟢 confirmed), AM4 has exactly these
blocks, one of each:

| Block | On AM4? | Likely ID (from Axe-Fx II/AX8, verify) |
|-------|---------|-----------------------------------------|
| Amp | ✅ 1 | 106 |
| Cab | ✅ 1 | 108 |
| Chorus | ✅ 1 | 116 |
| Compressor | ✅ 1 | 100 |
| Delay | ✅ 1 | 112 |
| Drive | ✅ 2 | 133, 134 |
| Enhancer | ✅ 1 | 135 |
| Filter | ✅ 1 | 131 |
| Flanger | ✅ 1 | 118 |
| Gate/Expander | ✅ 1 | 150 |
| Graphic EQ | ✅ 1 | 102 |
| Parametric EQ | ✅ 1 | 104 |
| Phaser | ✅ 1 | 122 |
| Reverb | ✅ 1 | 110 |
| Rotary | ✅ 1 | 120 |
| Tremolo/Panner | ✅ 1 | 128 |
| Volume/Pan | ✅ 1 | 127 |
| Wah | ✅ 1 | 124 |
| Controllers | system (no bypass, no channels) | 141 |
| Input Noise Gate | system (per-preset) | 139 |
| Output mixer | system (per-preset) | 140 |
| Scene MIDI | system | (Axe-Fx III-era block — ID unknown) |

Blocks the wiki explicitly says **NOT on AM4**: Crossover, Dynamic
Distortion, FXL (send/return), Formant, IR Player, Looper, Megatap Delay,
Mixer, Multi Delay, Multitap Delay, Multiband Compressor, Multiplexer,
Pitch, Plex Delay, Resonator, Ring Modulator, Synth, Ten-Tap Delay, Tone
Match, Vocoder. Don't probe these IDs.

### Block counts = max instances per preset

The `(N)` column on the `Effects_list` table is **how many instances of
that block type you can use in a single preset's chain**, not how many
distinct block IDs exist in the protocol. AM4 has `Drive (2)`, meaning a
single preset can contain up to two Drive blocks in its effect slots —
which is why Axe-Fx II exposes distinct `Drive 1` (133) and `Drive 2`
(134) block IDs for per-instance parameter addressing. Every other block
type on AM4 is limited to one instance per preset.

---

## 9. Scene & Channel Structure 🟡

### Scenes — from `Scenes.md`

- **Scene count on AM4: 4** 🟢 (confirmed). Scene index is 0–3 in SysEx,
  displayed as 1–4 on the device.
- Per-scene state: block bypass/engage + per-block channel selection +
  output level + MIDI commands (Scene MIDI block) + Control Switch states
  (though AM4/VP4 lack Control Switches per `Modifiers_and_controllers.md`).
- Routing (the grid) is fixed across all scenes.
- Scene numbering is 0-indexed in SysEx (0–3), 1-indexed on display (1–4).
- Function `0x29` GET/SET_SCENE_NUMBER — value `0x7F` in the payload means
  "query"; any other value is a set.

### Channels — from `Channels.md`

- 4 channels per block (A, B, C, D). Each channel is effectively a mini
  preset — all parameters are stored independently per channel.
- Switching is gapless.
- Per-block channel selection is stored per-scene.
- Axe-Fx III/FM9/FM3 use MIDI CC values 0/1/2/3 for channel A/B/C/D — AM4
  behavior not documented; Function `0x11` GET/SET_BLOCK_XY is the likely
  SysEx equivalent.
- On AM4/VP4 the Controllers block has no channels (unlike Axe-Fx III/FM9).

---

## 10. Modifiers & Controllers 🟡

From `Modifiers_and_controllers.md`:

- **16 modifiers per AM4 preset** (vs 24 on Axe-Fx III/FM9/FM3).
- **4 external controllers** on AM4 (vs 16 on Axe-Fx III/FM9/FM3).
- **No Control Switches** on AM4/VP4 (big siblings have them).

### Internal controller sources

LFO, Sequencer, ADSR, Envelope Follower, Pitch Detector.

### Modifier parameter selectors (Function 0x07)

Axe-Fx II/AX8 exposes modifier fields via a selector byte in the payload:

| Selector | Parameter |
|----------|-----------|
| 0x0 | Source (which controller) |
| 0x1 | Min |
| 0x2 | Max |
| 0x3 | Start |
| 0x4 | Mid |
| 0x5 | End |
| 0x6 | Slope |
| 0x7 | Damping |
| 0x8 | (reserved) |
| 0x9 | (reserved) |
| 0xA | Auto engage |
| 0xB | PC reset |
| 0xC | Off value |
| 0xD | Scale |
| 0xE | Offset |

---

## 10b. Preset Dump Commands (0x77 / 0x78 / 0x79) 🟢

Confirmed from AM4-Edit's `.syx` export (session 03, 2026-04-14, A01 preset).
The librarian uses a header-chunks-footer protocol — literally the same bytes
for file-based `.syx` and over-the-wire upload per the Fractal Presets Update
Guide (`samples/factory/`).

### Anatomy of a single-preset dump (12,352 bytes total)

```
Msg 1  offset 0       13B    func 0x77  PRESET_DUMP_HEADER
Msg 2  offset 13      3082B  func 0x78  PRESET_DUMP_CHUNK (1 of 4)
Msg 3  offset 3095    3082B  func 0x78  PRESET_DUMP_CHUNK (2 of 4)
Msg 4  offset 6177    3082B  func 0x78  PRESET_DUMP_CHUNK (3 of 4)
Msg 5  offset 9259    3082B  func 0x78  PRESET_DUMP_CHUNK (4 of 4)
Msg 6  offset 12341   11B    func 0x79  PRESET_DUMP_FOOTER
```

### 0x77 PRESET_DUMP_HEADER

Observed: `F0 00 01 74 15 77 7F 00 00 20 00 38 F7`

- Payload `7F 00 00 20 00` — 5 bytes.
  - Byte meaning not yet fully decoded. `7F 00` may be a "source=current slot"
    marker (7F is the query-sentinel in other commands). `00 20 00` might encode
    the chunk count or payload-size hint.
- `38 F7` — checksum + SysEx end.

### 0x78 PRESET_DUMP_CHUNK

Format observed: `F0 00 01 74 15 78 [chunk_header:2?] [data:~3072] [cs] F7`

- Each chunk is 3082 bytes total. Envelope = 8 bytes. Payload ≈ 3074 bytes.
- Chunk 1 starts with a different data signature than chunks 4–5 — chunks 4–5
  are mostly zeros (preset padding for unused slots / channels).
- The diff between two exports (A01 with gain=3 vs A01 with gain=4) shows that
  within chunks 2–3 the bytes differ pervasively (>90% of the active region),
  while chunks 4–5 are almost entirely identical. This pattern is consistent
  with **scrambled or XOR-masked payload data**, not plaintext — see §11.

### 0x79 PRESET_DUMP_FOOTER

Observed: `F0 00 01 74 15 79 71 6F 00 77 F7`

- Payload `71 6F 00` — 3 bytes. Most likely a whole-preset checksum or data-
  integrity value. Changes when any data byte changes (the 4-byte diff in the
  0x3000 window during the gain-change test lands in the footer).
- `77 F7` — checksum + SysEx end.

### Upload semantics

Per `samples/factory/README AM4+VP4 Presets Update Guide.pdf`: the same byte
sequence that exports a preset can be sent back to the device via the librarian
(Fractal-Bot) to upload it. No transformation needed. This is how a preset
write-to-slot will work in our encoder — concatenate `[0x77 header] [0x78 × 4
chunks] [0x79 footer]`, stream the bytes over the AM4 MIDI Out, wait for the
device's MULTIPURPOSE_RESPONSE ACK.

**Target slot for the dump** is encoded in the header (byte meaning TBD). The
slot-selection byte is the one piece of the format we MUST decode correctly
before issuing any write — see the write-safety protocol in `docs/DECISIONS.md`.

## 11. Preset Binary Format 🔴

From `Presets.md`:

- Export format: `.syx` (standard MIDI SysEx dump).
- AM4 presets are **mutually compatible with VP4** — shared format.
- AM4 presets are **incompatible with Axe-Fx III / FM3 / FM9** — different
  block IDs and parameter layouts.
- Hardware is always ready to receive a preset (no prep handshake).
- Loaded presets sit in a temporary buffer until explicitly stored.
- Compatible with generic MIDI librarians (MIDI-OX on Windows, SysEx
  Librarian on macOS) for dumping / loading.

Nothing about the binary layout itself is documented. This is the risky
phase of the project. Concrete plan once 0x02 works:

1. Export two factory presets via a generic librarian. Diff byte-by-byte
   with `scripts/diff-syx.ts`.
2. Change one parameter in AM4-Edit, export, diff the export. The changed
   bytes locate that parameter in the binary.
3. Repeat across representative parameters (amp gain, delay time, reverb
   mix, filter frequency, scene selection) until the structure is mapped.
4. Document findings in `docs/SYSEX-MAP.md` under a new "Preset binary
   layout" section, and in `docs/SESSIONS.md` for the per-session log.

---

## 12. Phase 1 Action Plan (derived from this map)

In priority order, each step either succeeds or reveals a concrete blocker:

1. **Run `scripts/probe.ts`** with the AM4 connected. Confirm enumeration,
   send the documented Scenes mode switch, observe display change.
2. **Send 0x08 GET_FIRMWARE_VERSION** as a first probe. Capture whatever
   response arrives. Even a silent response tells us something (command
   accepted but no reply vs. command rejected).
3. **Sniff AM4-Edit** doing a preset switch, a single parameter change,
   and a scene switch. Cross-reference captured bytes against Sections 5–6.
4. **Implement 0x02 SET_BLOCK_PARAMETER_VALUE** for ONE parameter (Amp
   gain). Audible change on the device = live-tweak MVP is unblocked.
5. **Fill in the confirmed block IDs and parameter IDs** for that one
   block as a template for the rest.
6. **Document each discovery** in `docs/SESSIONS.md` with raw hex and
   annotation, and flip the relevant 🟡 entries to 🟢 in this file.

---

## 13. What's Still 🔴 UNKNOWN

- Whether AM4 responses carry a checksum at all (Axe-Fx II family splits
  by function — AM4 may differ).
- Whether the device requires any initialization handshake before
  accepting non-mode-switch commands.
- The AM4-specific block ID values (Section 8 lists Axe-Fx II guesses).
- The parameter ID space for every block type — verified one block at a
  time via sniffing.
- Scene count (4 vs 8 — sources disagree).
- How modifiers are encoded in the preset binary.
- Whether any undocumented function IDs exist that AM4-Edit uses
  exclusively — forum threads about Axe-Fx III 0x51/0x52/0x53 suggest the
  possibility.
- The entire preset binary format.

Every unknown above maps to a specific sniff-session experiment. None are
structurally impossible — all are tedious.
