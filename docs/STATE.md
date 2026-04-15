# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-15** (Session 11 — Section 2 record layout
> decoded; 98 records (15 enums) parsed from block 0 of Section 2
> before a layout shift at 0xcc80 halts the walker).

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

### Cross the Section 2 block boundary at `0xcc80`

Session 11 extended `parse-cache.ts` to walk Section 2. Output:
`samples/captured/decoded/cache-section2.json` — 98 records from the
first "block" (15 enums including LFO waveform, beat division, stereo
routing; 9 "assign template" float knobs at ids 1..9 with identical
`min=1, max=10, step=0.001`; a bundle of `OFF/ON` bypass switches).

**Block 0 is almost certainly the Modifier/Controller definition**, not
the Amp block. Evidence: the SINE..ASTABLE LFO waveform enum at id=10,
no matches for Session 08's known amp params (`amp.gain` pidHigh=11,
`amp.level`=0), and the presence of 9 identical "assign knob" slots
which matches Axe-FX/FM-family modifier semantics.

Decoded Section 2 record layout (verified on 3 enums and many floats):

```
+0   u16   flag         (always 0)
+2   u16   id           (1-based, resets per block)
+4   u32   typecode     (0 = float; 0x10 = enum; others seen: 0x20, 0x35, 0x42, 0x44)
+8   f32   a            (float record: min; enum record: min=0)
+12  f32   b            (float record: max; enum record: max = count-1)
+16  f32   c            (float record: step; enum record: default index, often 1)
+20  f32   d            (float record: often 0 or a default; enum record: 0)
+24  if tc == 0x10 (enum):  u32 count + count×LP-ASCII + 4-byte trailer
     else (float):          4-byte trailer (record = 32 bytes)
```

The walker halts at `0xcc80` on the first block-1 record:
- `flag=0 id=3 tc=0x00230000` — **high 16 bits of tc are 0x23 (35)**.
- Floats in this record are shifted 12 bytes later (at +20/+24/+28
  instead of +8/+12/+16) — the same `(1.0, 10.0, 0.001)` assign-knob
  triple appears, just at a different offset.
- Interpretation: either the record is 40+ bytes (extra 8-byte header),
  or the high-word of `tc` is a per-block-start tag (block type ID?)
  that the layout is conditional on.

**Next steps (Session 12):**

1. Hand-decode 3–4 records past `0xcc80` to determine whether block 1
   uses a 40-byte record or a 32-byte record with a different float
   offset, and whether the `tc` high-word encodes block type.
2. Extend `parseSection2` to handle the shifted layout once decoded.
3. Walk the full section and count blocks; match Session 08's known
   params (`amp.gain` pidHigh=0x0b → expected as knob 0..10; 
   `amp.channel` pidHigh=0x07D2 → expected as 4-entry A/B/C/D enum)
   to identify which block index = Amp / Drive / Reverb / Delay.
4. Only then auto-generate `KNOWN_PARAMS` from the parsed JSON.

### Alternative: skip cache-parsing, continue with capture-driven registry

If the block-1 layout resists decoding, fall back to adding
captured-bytes `verify-msg` cases one param at a time. We already have
the method for every new param; it's just slow. The cache is a bulk
shortcut, not a blocker.

## Decoded parameters and unit conventions

Live source of truth: `src/protocol/params.ts` (`KNOWN_PARAMS` + `Unit`
union). 8 params across 4 blocks (Amp `0x003A`, Drive `0x0076`, Reverb
`0x0042`, Delay `0x0046`) using 5 unit conventions (`knob_0_10`, `db`,
`percent`, `ms`, `enum`). `pidLow` = block ID, `pidHigh` = parameter
index within block; address is preset-independent. Drive Type enum has
only one entry catalogued so far (8 = `TS808`); Amp Channel enum is
fully populated (0..3 ↔ A..D).

## Recent breakthroughs

Older breakthroughs (sessions 04–08, 10) are archived in `SESSIONS.md`.
Only Session 11 (current) is kept here for fast orientation.

1. **Section 2 record layout decoded** (Session 11). Unified 24-byte
   header (flag, id, typecode u32, + 4 floats a/b/c/d) followed by
   either an enum body (tc=0x10) or 8-byte float-record tail.
   Verified on SINE-waveform, amp-type (248 entries), and drive-type
   (78 entries including TS808/Klon) enums. 98 records cleanly parsed
   from Section 2's block 0 — identified as the Modifier/Controller
   definition, not a per-effect block.
2. **Anomaly at 0xcc80** (Session 11). First record of block 1 has
   `tc=0x00230000` (high bits set) and the canonical assign-knob float
   triple `(1.0, 10.0, 0.001)` at +20/+24/+28 instead of the expected
   +8/+12/+16. Suggests either extra per-block prefix bytes or a
   tc-dependent record layout. Parser halts here pending Session 12
   work.

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
