# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-15** (Session 12 — 7 blocks decoded across
> Section 2 (442 parameter records, 114 enums). Block 5 (tag=0x98)
> identified as the Amp block via its 248-entry AMP TYPE enum; id=11
> matches Session 08's `amp.gain` pidHigh=0x0b).

---

## Current phase

**Phase 1 — Protocol RE: 🟢 COMPLETE AND HARDWARE-VERIFIED.** First real
write produced visible parameter change on the device (Session 05).

**Phase 2 — Parameter registry + preset IR + transpiler.** Registry +
working-buffer IR + transpiler shipped and capture-verified (Session 07).
Channel-addressing solved in Session 08 — channel A/B/C/D is a regular
SET_PARAM write at `pidHigh = 0x07D2` with the index (0..3) encoded as a
float32. One open question remains before the IR can cover full presets:
**bulk parameter discovery** (Ghidra metadata table extraction below).

## The single next action

### Decode remaining blocks past the sub-section divider at `0x136ee`

Session 12 extended `parseSection2` with **block-header detection**:
blocks 1+ begin with a 40-byte header whose u32 at +4 encodes a
block-type tag in its high 16 bits (`0x00XX0000`). After the header,
normal 32-byte records (id=1, 2, 3, …) resume with the standard
layout. This decoded 7 blocks / 442 records before hitting a
sub-section divider at `0x136ee` (marker `f0 ff 00 00`).

| Block | Tag    | Records | First enum                                    | Likely role |
|-------|--------|---------|-----------------------------------------------|-------------|
| 0     | —      | 98      | id=10 SINE/TRI/SQUARE (LFO waveforms)          | Modifier/Controller template |
| 1     | 0x23   | 34      | id=10 NONE/Pedal 1/Pedal 2 (13 entries)        | Pedal/Expression controllers |
| 2     | 0x2a   | 41      | id=4 Thru/Mute FX Out/Mute Out                 | Input/routing block |
| 3     | 0x17   | 22      | id=4 Thru/Mute                                 | ? (small block) |
| 4     | 0x25   | 36      | id=4 Thru/Mute                                 | ? |
| **5** | **0x98** | **151** | **id=10 = 248 amp models (Plexi, 5153, …)** | **Amp (verified)** |
| 6     | 0x4f   | 77      | id=4 Thru/Mute                                 | ? |

**Amp block verification.** Block 5 id=11 is a tc=0x30 float
`(a=0, b=1, c=10, d=0.001)` — matches Session 08's `amp.gain`
pidHigh=0x0b (knob 0..10). The `(0, 1, 10, 0.001)` quad encodes
*internal 0..1, displayed as 0..10, step 0.001* — the standard
Fractal knob convention. Same block has the cab (id=44, 69 entries),
power tube (id=75, 26 entries), preamp tube (id=76, 9 entries),
mid-boost (id=130), and reactive-load (id=135, 93 entries) enums
we'd expect on the amp model.

**Record layout (final):**

```
+0   u16   flag         (always 0)
+2   u16   id           (1-based within block; for block header: usually 3)
+4   u32   tc_or_tag    (normal records: typecode in low 16 bits;
                          block header: tag in high 16 bits, low 16 = 0)
+8   u32   pad
+12  f32   a            normal record: min / count-depends
+16  f32   b            normal record: max / default
+20  f32   c            normal record: step / display-scale
+24  f32   d            normal record: 0 or extra
+24  if tc == 0x10 (enum):  u32 count + count×LP-ASCII + 4-byte trailer
     else (float):          4-byte trailer (record = 32 bytes)

Block header (40 bytes) precedes the first record of blocks 1+:
  +0..+3   flag, id-like
  +4..+7   tag in high 16 bits
  +8..+19  zeros
  +20..+31 (1.0, 10.0, 0.001) default knob template
  +32..+39 zeros
```

**Next steps (Session 13):**

1. Dump `0x136ee..0x14000` to decode the `f0 ff` sub-section marker
   and the 256-entry `<EMPTY>` user-cab slot list that follows. That
   list is almost certainly the USER CAB parameter — skipping past
   it should reveal more blocks (expect Drive, Reverb, Delay).
2. Extend the parser to jump past the `f0 ff` divider + the 256
   user-cab-slot enum and continue block walking.
3. Identify Drive / Reverb / Delay blocks by their characteristic
   enums (78-entry Drive type at 0x1c3e4; 79-entry Reverb type at
   0x147c4 with "Room, Small"…"Spring, Vibrato-King Custom";
   29-entry Delay type at 0x15b79 with "Digital Mono"…"Surround Delay").
   All three are past `0x136ee` so decoding the divider unblocks them.
4. Confirm block tags (0x98, 0x4f, etc.) do NOT correspond to AM4
   wire pidLow values. Amp wire pidLow=0x3A but block tag=0x98 —
   tag is an internal AM4-Edit schema index, not the wire address.
   Need a separate mapping (likely order-based or discovered via
   capture) from block tag → wire pidLow.
5. Only after Drive/Reverb/Delay blocks are decoded, auto-generate
   `KNOWN_PARAMS` from the parsed JSON.

## Decoded parameters and unit conventions

Live source of truth: `src/protocol/params.ts` (`KNOWN_PARAMS` + `Unit`
union). 8 params across 4 blocks (Amp `0x003A`, Drive `0x0076`, Reverb
`0x0042`, Delay `0x0046`) using 5 unit conventions (`knob_0_10`, `db`,
`percent`, `ms`, `enum`). `pidLow` = block ID, `pidHigh` = parameter
index within block; address is preset-independent. Drive Type enum has
only one entry catalogued so far (8 = `TS808`); Amp Channel enum is
fully populated (0..3 ↔ A..D).

## Recent breakthroughs

Older breakthroughs (sessions 04–08, 10–11) are archived in `SESSIONS.md`.
Only Session 12 (current) is kept here for fast orientation.

1. **7 blocks decoded from Section 2** (Session 12). Block-header
   detection (40-byte prefix with block-type tag in high 16 bits of
   the tc u32) cracked the layout shift that blocked Session 11.
   442 parameter records + 114 enums parsed cleanly.
2. **Amp block identified** (Session 12). Block 5 (tag=0x98) hosts the
   248-entry AMP TYPE enum at id=10. Block 5 id=11 cross-matches
   Session 08's `amp.gain` pidHigh=0x0b — the `(0, 1, 10, 0.001)`
   quad is the *internal 0..1, display 0..10, step 0.001* knob
   convention.
3. **Block tag ≠ wire pidLow** (Session 12). The high-16-bits "tag"
   (0x98 for Amp, 0x4f for block 6, etc.) is AM4-Edit's internal
   schema index — NOT the wire-protocol pidLow (Amp=0x3A). Block
   → wire-pidLow mapping is still open and will need capture
   cross-reference.

Session 08 highlights (still load-bearing):

1. **Per-block channel selector decoded** (Session 08). Channel A/B/C/D
   is a regular SET_PARAM write at `pidLow=0x003A` (Amp), `pidHigh=0x07D2`,
   with the channel index (0..3) packed as an IEEE 754 float32. Two
   captures proved it: `session-09-channel-toggle.pcapng` (A↔B) and
   `session-09-channel-toggle-a-c-d-a.pcapng` (A→C→D→A). All four values
   confirmed by `unpackFloat32LE`. `amp.channel` added to `KNOWN_PARAMS`
   with `unit: 'enum'` and `enumValues: {0:'A', 1:'B', 2:'C', 3:'D'}`;
   `verify-msg.ts` now 5/5 including checksum.
2. **pidHigh decoding correction** (Session 08). Prior to `0x07D2`, every
   observed pidHigh was ≤ 0x7F, so reading the two body bytes as
   little-endian (`(hi << 8) | lo`) gave the same answer as the correct
   septet decode (`(hi << 7) | lo`). Channel was the first param to
   expose the difference — `parse-capture.ts`'s body-hex display still
   shows the septet bytes laid out LE, so always convert with `(hi<<7)|lo`
   when extracting a new `pidHigh` from a capture. Documented in
   SYSEX-MAP.md §6a.
3. **Same pidHigh likely applies to other blocks** (Session 08, unverified).
   The other per-block selectors (Drive/Reverb/Delay) are probably at
   `pidHigh=0x07D2` on their respective `pidLow`. Worth a one-shot
   capture when expanding the registry to per-block channel keys.

## What's known (status legend)

- Device comms, checksum, envelope, model ID, documented commands
  `0x08 / 0x0C / 0x0D / 0x0E / 0x13 / 0x14 / 0x64` — **🟢 confirmed**.
- Preset dump format (`0x77/0x78/0x79`) + slot addressing — **🟢 confirmed**.
- `0x01` SET_PARAM message format + value encoding — **🟢 fully decoded**.
- Parameter ID structure — **🟢 (Session 06, preset-independent)**.
- 8 params / 4 blocks / 5 units — **🟢 in `params.ts`**.
- Channel A/B/C/D addressing — **🟢 (Session 08: Amp `pidHigh=0x07D2`,
  float32 index 0..3; other blocks' channel pidHigh unverified)**.
- Drive Type enum table — **🟡 only `8 → TS808` known**.
- Full preset binary layout inside `0x78` chunks — **🔴 scrambled, parked**.

MVP scope, target-user definition, and write-safety rules are
authoritative in `CLAUDE.md` and `DECISIONS.md` — not duplicated here.

## Roadmap landmarks

- **Now:** finish decoding cache Section 2 across all blocks — Session 11 cracked block 0, Session 12 needs the block-1 layout shift.
- **Then:** expand `WorkingBufferIR` → full `PresetIR` (block placement,
  4 scenes, per-block channel assignment) — the transpiler will need to
  emit a channel-select write (now understood) before that block's
  param writes.
- **Then:** scaffold MCP server (`src/server/`) with first two tools
  (`read_slot`, `apply_preset`).
- **Then:** natural-language → preset-IR (Claude side).
- **Phase 5:** packaging to signed `.exe` (see `docs/04-BACKLOG.md`).

## Where everything lives

- `src/protocol/` — verified protocol layer (checksum, pack, params, setParam, midi).
- `src/ir/` — preset IR (`preset.ts` working-buffer scope) + `transpile.ts`.
- `docs/SESSIONS.md` — every RE session, chronological, with raw captures.
- `docs/SYSEX-MAP.md` — working protocol reference (🟢/🟡/🔴 tagged).
  §6a/§6b updated 2026-04-14 with the cracked encoding.
- `docs/DECISIONS.md` — architecture and scope decisions with rationale.
- `docs/REFERENCES.md` — local PDFs + factory bank + community sources.
- `docs/BLOCK-PARAMS.md` — AM4 block types and effect types ground truth.
- `docs/04-BACKLOG.md` — phased work item list.
- `scripts/probe.ts` — read-only device probe.
- `scripts/sniff.ts` — bidirectional MIDI proxy (superseded by USBPcap).
- `scripts/diff-syx.ts` — byte-level diff of two `.syx` files.
- `scripts/parse-capture.ts` — parses tshark dumps of USBPcap captures.
- `scripts/verify-pack.ts` — 10-sample round-trip test of float pack/unpack.
- `scripts/verify-msg.ts` — built-vs-captured message byte comparison.
- `scripts/write-test.ts` — first hardware write (Amp Gain).
- `scripts/verify-transpile.ts` — IR → command sequence round-trip check.
- `scripts/ghidra/FindEncoder.java` — Ghidra script that found the encoder.
- `scripts/ghidra/FindParamTable.java` — Ghidra string-cluster search that
  *ruled out* static metadata in the exe (Session 09).
- `scripts/peek-cache.ts` — scratchpad walker of the AM4-Edit metadata
  cache. Superseded by `parse-cache.ts` but kept for reference.
- `scripts/parse-cache.ts` — structural decoder for the cache. Parses
  Section 1 (87 global-setting records) cleanly into typed JSON.
- `scripts/dump-cache-head.ts` — hex+ASCII peek tool for cache offsets.
- `samples/captured/decoded/cache-strings.txt` — 7,610 length-prefixed
  strings extracted from `effectDefinitions_15_2p0.cache`.
- `samples/captured/decoded/cache-records.json` — parsed Section 1.
- `samples/captured/decoded/cache-section2.json` — parsed Section 2 block 0 (98 records).
- `scripts/scrape-wiki.ts` — Fractal wiki scraper.

## How to use this file

Update at the end of every substantive session:
- Change "The single next action" to the next concrete step.
- Move completed items out of "Recent breakthroughs" once they're no
  longer urgent context.
- Keep the file under ~200 lines — it's an orientation doc, not an
  archive. Archive belongs in `SESSIONS.md` and `BACKLOG.md`.
