# AM4 Sniffing Session Log

Raw capture + annotation per session. One section per session, newest on
top. See `docs/SYSEX-MAP.md` for the consolidated working reference; this
file is the chronological trail that reference is built from.

---

## 2026-04-14 — Session 03 — Preset `.syx` Export Analysis

**Device / firmware:** AM4 f/w 2.00, same setup. AM4-Edit v1.00.04.
**Approach:** instead of live-sniffing AM4-Edit (blocked by port filtering), we
exported preset `.syx` files directly from AM4-Edit's Save-As feature and
analyzed the file format.

### Files captured

In `samples/factory/`:
- `A01-original.syx` — preset A01, Amp Gain = 3.00 (12,352 B)
- `A01-gain-plus-1.syx` — same preset, Amp Gain = 4.00 (12,352 B)
- `A01-clean-a.syx` / `A01-clean-b.syx` — two back-to-back exports, no edits (12,352 B each)
- `AM4-Factory-Presets-1p01.syx` — Fractal's full factory bank, 104 presets (1,284,608 B)

### Findings

**🟢 File structure (12,352 B single-preset dump):**

| Msg | Offset | Size | Function | Role |
|-----|--------|------|----------|------|
| 1 | 0 | 13 B | `0x77` | PRESET_DUMP_HEADER |
| 2–5 | 13, 3095, 6177, 9259 | 3082 B × 4 | `0x78` | PRESET_DUMP_CHUNK |
| 6 | 12341 | 11 B | `0x79` | PRESET_DUMP_FOOTER |

**🟢 Slot encoding decoded** — from factory bank headers:

```
[A01] F0 00 01 74 15 77 00 00 00 20 00 47 F7   bank=0  slot=0
[A02] F0 00 01 74 15 77 00 01 00 20 00 46 F7   bank=0  slot=1
[B01] F0 00 01 74 15 77 01 00 00 20 00 46 F7   bank=1  slot=0
```

- **Byte 6** = bank index, 0x00–0x19 (A–Z)
- **Byte 7** = slot within bank, 0x00–0x03
- **Byte 8–10** = `00 20 00` (fixed; probably size/version marker)
- **Byte 11** = envelope checksum

User exports use `7F 00` in bytes 6–7 as a "current working buffer" sentinel
(matches the `0x7F` query sentinel elsewhere in Axe-Fx III 3rd-party protocol).
When we write a preset to slot Z04, bytes 6–7 must be `19 03`.

**🟢 Chunk prefix** — every `0x78` message starts with identical 14 bytes:
```
F0 00 01 74 15 78 00 08 07 02 00 55 54 02
```
Envelope (6) + fixed chunk header (8).  Payload region is byte 15 onwards.

**🟢 Chunks 4 & 5 are shared padding** — identical across all presets in the
factory bank AND across all user exports. 6,164 bytes out of 12,352 are dead
space (block slots unused by the preset, zero-initialized but position-wise
fixed). All meaningful preset data lives in chunks 2 & 3.

**🔴 Chunks 2 & 3 are per-export scrambled.** Two clean exports of the SAME
preset with zero edits show ~2,732 differing bytes. Factory A01 vs factory A02
show ~2,612 + 1,103 differing bytes. The magnitudes are similar whether
comparing same-preset-different-export, same-preset-different-edit, or
different-presets — which means simple byte-diffing CANNOT locate a parameter
value in chunks 2–3.

Likely scrambling mechanism: **MIDI 7-bit safe encoding + per-export
random/session padding**. Forum research
([forum.fractalaudio.com](https://forum.fractalaudio.com/threads/axe-fx-iii-and-deconstructing-parsing-a-syx-sysex-preset-file.159885/))
indicates Axe-Fx III uses 3-septet-per-byte bit-packing with names split
across bytes. AM4 presumably inherits this. Format has NOT been publicly
cracked by the community.

### Strategic pivot

Attacking the binary format directly is weeks of work with uncertain payoff.
Instead we pivot to a different architecture: **puppet the device**. AM4-Edit
doesn't construct preset binaries in-memory either — it uses the device's
live editor protocol (function `0x01`) to set parameters on the working
buffer, then issues the store command (`0x77/0x78/0x79`) to persist. We do
the same programmatically.

This requires reverse-engineering AM4-Edit's outgoing `0x01` command shape,
which the loopMIDI-based sniffer couldn't capture (AM4-Edit rejects virtual
ports). Next step: USBPcap + Wireshark to capture at the USB kernel level.

### Retractions

- No retractions from prior sessions.

### Next session plan (Session 04)

1. Capture a Wireshark trace of AM4-Edit changing one parameter (Amp Gain +1).
2. Extract AM4-Edit's outgoing SysEx messages and AM4's responses.
3. Decode the `0x01` parameter-set command format.
4. Write a proof-of-concept "set parameter" function using the sniffed format.
5. Combine with the already-decoded `0x77/0x78/0x79` store command to persist
   a configured preset.

---

## 2026-04-14 — Session 02 — Axe-Fx III Protocol Confirmed

**Device / firmware:** AM4, firmware 2.00, same USB/driver setup.
**Script:** `scripts/probe.ts` after swapping Axe-Fx II guesses for Axe-Fx III opcodes (0x0C, 0x0D, 0x0E, 0x13, 0x14 query forms).
**Primary source consulted between sessions:** `docs/manuals/AxeFx3-MIDI-3rdParty.txt` (official Fractal PDF, text-extracted).

### Raw capture (trimmed to new probes)

```
→ F0 00 01 74 15 0C 7F 63 F7                            [Q_SCENE query]
← F0 00 01 74 15 0C 00 1C F7                            [scene 0 = displayed as 1]

→ F0 00 01 74 15 0D 7F 7F 1D F7                         [Q_PATCH_NAME query]
← F0 00 01 74 15 0D 03 52 [32 × 0x00] 4C F7             [preset id 03 52, empty name]

→ F0 00 01 74 15 0E 7F 61 F7                            [Q_SCENE_NAME query]
← F0 00 01 74 15 0E 00 [32 bytes mostly 0, with 10 43 30 stray] 7D F7
                                                         [scene 0, name field looks uninitialised]

→ F0 00 01 74 15 14 7F 7F 04 F7                         [Q_TEMPO query]
← F0 00 01 74 15 14 60 5B 3F F7                         [raw 11744; probably BPM × 100 = 117.44]

→ F0 00 01 74 15 13 03 F7                               [STATUS_DUMP]
← F0 00 01 74 15 13 25 00 46 | 2A 00 46 | 3E 00 44 | 4E 01 10 | 29 F7
                              ↑ 4 three-byte packets (id id dd per Axe-Fx III spec)
```

### Decoded STATUS_DUMP packets

| Packet | ID (dec) | Axe-Fx III enum | dd (bin) | Bypass | Channel | Ch count |
|--------|----------|-----------------|----------|--------|---------|----------|
| 1 | 37 | ID_INPUT1 | 01000110 | engaged | D (3) | 4 |
| 2 | 42 | ID_OUTPUT1 | 01000110 | engaged | D (3) | 4 |
| 3 | 62 | ID_CAB1 | 01000100 | engaged | C (2) | 4 |
| 4 | **206** | _beyond Axe-Fx III public enum_ | 00010000 | engaged | A (0) | 1 |

### Key findings

| Claim | Confidence | Evidence |
|-------|------------|----------|
| AM4 follows Axe-Fx III 3rd-party MIDI spec | 🟢 confirmed | Every III opcode returned structured data, not rc=0x05 NACK |
| Block IDs use Axe-Fx III enum (IDs ≥ 37) | 🟢 confirmed | 37/42/62 match ID_INPUT1/OUTPUT1/CAB1 exactly |
| AM4 extends the III enum above 200 | 🟡 inferred | ID 206 appears in STATUS_DUMP, not in the public enum; most likely the Amp block |
| AMP on AM4 has a single "channel" | 🟡 inferred | Packet 4 reports 1 channel; consistent with "pick-one-of-437-amp-models" rather than A/B/C/D |
| Axe-Fx II opcodes are NOT accepted | 🟢 confirmed (session 01 + this session) | 0x02 with all six guessed block IDs → rc=0x05 |
| Current preset has no name | 🟢 confirmed | 32 null bytes in 0x0D response |
| "Preset 0 = A01" claim from Session 01 | 🔴 **retracted** | 0x14 on AM4 is TEMPO, not GET_PRESET_NUMBER |

### Retractions from Session 01

- `0x14` was misinterpreted as GET_PRESET_NUMBER (Axe-Fx II meaning). On AM4 it is SET/GET_TEMPO. The `00 00` payload from session 01 was a malformed query (no `7F 7F` payload) returning a default/zero value, not a preset index.
- `0x0F` was not "AM4-specific preset-name query candidate." It's the Axe-Fx II GET_PRESET_NAME, which AM4 correctly rejects. The real command is `0x0D` QUERY PATCH NAME per the Axe-Fx III spec.

### Side observations

- The `0x64` MULTIPURPOSE_RESPONSE NACK pattern is NOT present in the Axe-Fx III 3rd-party spec — yet AM4 uses it for rejected commands. So AM4's NACK behavior is a superset/blend of the two families.
- Response checksums are uniformly present. No `0x0D TUNER_INFO` equivalent observed (tuner wasn't active).

### Next session plan — shifts significantly

Per the project owner's scope direction (MVP = preset authoring, not live control), the
next step is **NOT** testing `0x0A`/`0x0B` bypass/channel writes. Instead:

1. Install MIDI-OX. Sniff AM4-Edit performing these four workflows, and
   capture raw SysEx for each:
   - Load a factory preset from device to AM4-Edit (preset DUMP OUT)
   - Push a modified preset from AM4-Edit to the device (preset DUMP IN — this is the STORE command we need)
   - Change one parameter (e.g., Amp gain from 5 to 6) and observe the delta messages
   - Save the modified preset back to its slot
2. From (1b), identify the preset upload opcode and byte layout.
3. From (1c) / (1d), begin the parameter-locate diff work in `scripts/diff-syx.ts`.
4. Set up slot **Z04** as the permanent scratch slot — document in `DECISIONS.md`
   (done) and reference in every future write test.

---

## 2026-04-14 — Session 01 — First Probe

**Device:** Fractal AM4, firmware v2.00 (build Mar 20 2026 06:46:54),
direct USB to Windows ThinkPad, Fractal driver installed.
**Script:** `scripts/probe.ts` (commit after `ignoreTypes(false, true, true)` fix).
**Tools:** no AM4-Edit, no MIDI-OX — just our probe.

### Goal
Confirm basic two-way communication and test whether Axe-Fx II/AX8
function IDs work on AM4 as first-guess templates.

### Raw capture

```
→ F0 00 01 74 15 12 49 4B F7                           [SCENES_MODE]
← F0 00 01 74 15 64 12 00 66 F7                        [ACK fn=0x12 rc=0x00]

→ F0 00 01 74 15 08 18 F7                              [GET_FIRMWARE_VERSION]
← F0 00 01 74 15 08 02 00 03 04 05 00 00
  4D 61 72 20 32 30 20 32 30 32 36 20 30 36 3A 34 36 3A 35 34
  00 00 00 00 00 00 00 00 00 00 00 00 67 F7            [firmware v2.00 + build date]

→ F0 00 01 74 15 0F 1F F7                              [GET_PRESET_NAME]
← F0 00 01 74 15 64 0F 05 7E F7                        [ACK fn=0x0F rc=0x05 — REJECTED]

→ F0 00 01 74 15 14 04 F7                              [GET_PRESET_NUMBER]
← F0 00 01 74 15 14 00 00 04 F7                        [preset 0 = A01]
```

### Decoded findings

| Message | Meaning | Confidence |
|---------|---------|------------|
| `0x64` MULTIPURPOSE_RESPONSE format | `[echoed_fn, result_code]` same as Axe-Fx II | 🟢 confirmed |
| Result code `0x00` | OK | 🟢 confirmed on `0x12` |
| Result code `0x05` | Parsed but not honored | 🟢 confirmed on `0x0F` |
| `0x08` GET_FIRMWARE_VERSION | Works. Extended format: Axe-Fx II prefix (MAJ MIN + 5 reserved) then null-terminated ASCII build date | 🟢 confirmed |
| `0x14` GET_PRESET_NUMBER | Works. Two-byte 14-bit value, payload `00 00` = preset 0 (A01) | 🟢 confirmed |
| `0x0F` GET_PRESET_NAME | Rejected with rc=0x05. AM4 uses a different mechanism for this | 🔴 needs sniffing |
| All responses carry checksums | Simpler than Axe-Fx II's split | 🟢 confirmed (small sample) |
| Envelope / checksum / model ID 0x15 | Match expectations | 🟢 confirmed |

### Side observations

- AM4 reportedly jumped to scene 3 after the mode switch. Hypothesis:
  device remembers last-selected scene per preset; scene-mode entry
  just displays it. Not a side effect of any command sent. To confirm:
  manually select scene 1, exit scene mode, re-run probe.
- `node-midi` requires `input.ignoreTypes(false, true, true)` before
  `openPort()` or it silently drops all SysEx. First probe run produced
  zero responses for exactly this reason. Documented in probe.ts.

### Next session plan

1. **Find the real preset-name query.** Probe candidates in this order:
   - `0x0E` PRESET_BLOCKS_DATA (may carry name as part of block list)
   - `0x09` (Axe-Fx II SET_PRESET_NAME — may be dual-purpose on AM4)
   - Scan `0x30`–`0x50` for any function ID that returns name-shaped data
   - If nothing surfaces, open AM4-Edit with MIDI-OX and watch what
     query it uses when loading a preset
2. **Test `0x02` GET_BLOCK_PARAMETER_VALUE** with a guessed block ID
   (106 = Amp 1 from Axe-Fx II). Query mode (`M=0x00`) on parameter 0.
   If rc=0x00 comes back with a label string, we have the live-tweak MVP
   unblocked. If rc=0x05, swap block ID and retry.
3. **Test `0x3C` SET_PRESET_NUMBER** to switch to a different preset.
   Audible confirmation: preset name visible on device display.
4. **Test `0x29` GET_SCENE_NUMBER**. Expect a two-byte scene index
   response (0–3 on AM4).
