# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-15** (Session 13 — post-divider region cracked:
> 17 sub-blocks, 695 additional records, including Reverb Type (79),
> Delay Type (29), and Drive Type (78). All main effect blocks now
> located. Post-divider uses a compressed 24-byte record header —
> different layout from pre-divider.)

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

### Land Session 13 findings in `parse-cache.ts` + auto-generate `KNOWN_PARAMS`

Session 13 decoded the post-divider region in a scratch script
(`/tmp/parse-post3.mjs` — not committed). **17 sub-blocks, 695
additional records, including all three missing main effect blocks.**
Next session: port the scratch parser into `scripts/parse-cache.ts` as
a `parseSection3` function, commit the enriched `cache-section2.json`
(or split to a new `cache-section3.json`), and then auto-generate
`KNOWN_PARAMS` from the JSON.

**Post-divider region layout (Section 3 — 0x136f0 onward):**

1. Divider marker `f0 ff 00 00` at 0x136f0 + 18 zero pad (24 bytes
   total)
2. User-cab slot *names*: u32 count=256 + 256 × LP-ASCII (all
   `<EMPTY>` on this install) — 0x13706..0x14209
3. 2-byte pad + u32 count=256 + 256 × u32 cab IDs (all 0xff
   sentinel) — 0x1420c..0x1460f
4. Section 3 block header (32 bytes) at 0x14610 — **different layout
   from pre-divider 40-byte header**
5. Section 3 records from 0x14636

**Section 3 record layout (compressed, 24-byte header):**

```
+0   u16   flag           (0)
+2   u16   id             (1-based within block)
+4   u16   tc             (typecode; 0x10 = enum among others)
+6   u16   pad            (0)
+8   f32   a              min
+12  f32   b              max
+16  f32   c              display-scale
+20  f32   d              step
+24  if enum:  u32 count + count×(u32 len + ASCII) + u32 trailer
     if float: u32 trailer (0) + u32 extra  → record = 32 bytes
```

The "extra" u32 at +28 of float records is structurally padding;
semantics unclear (sometimes matches next record's id-prefix).
Enum detection is still structural: try to parse strings, fall back
to float.

**17 sub-blocks found post-divider (by distinguishing enum):**

| Block | Start     | Recs | Big enum (id=10 or nearby)                                      | Likely role |
|-------|-----------|------|-----------------------------------------------------------------|-------------|
| 0     | 0x14636   | 72   | id=10 × 79 `Room, Small … Spring, Vibrato-King Custom`         | **Reverb** |
| 1     | 0x159eb   | 89   | id=10 × 29 `Digital Mono … Surround Delay`                      | **Delay** |
| 2     | 0x17f57   | 31   | id=10 × 20 `Digital Mono … Vibrato 2`                           | Multi-Delay? |
| 3     | 0x18c6a   | 35   | id=10 × 32 `Digital Mono … Manual Cancel Flanger`               | Chorus/Flanger? |
| 4–7   | 0x198f3…  | —    | id=14/15 × 79 `NONE … 63/64`                                     | Pitch? |
| 8     | 0x1b74d   | 40   | id=27 × 32 `OFF … 32`                                            | ? |
| **9** | **0x1c28f** | **49** | **id=10 × 78 `Rat Distortion … Swedish Metal`**            | **Drive** |
| 10–16 | 0x1d079…  | —    | various                                                          | Compressor/EQ/Filter/etc |

Stopped at 0x1f926 (~49KB left in cache unparsed).

**Next steps (Session 14):**

1. Port `/tmp/parse-post3.mjs` logic into `scripts/parse-cache.ts` as
   `parseSection3`. Re-run `npm run preflight`.
2. Cross-reference the 4 "main" blocks (Amp pre-divider, Reverb/Delay/
   Drive post-divider) against wire `pidLow` values (`0x3A`, `0x42`,
   `0x46`, `0x76`). The wire-pidLow ordering is NOT the cache block
   order — this mapping is still open and needs either capture
   cross-reference or a heuristic based on characteristic params
   (e.g., find Drive block by its "type=TS808 default" param).
3. Auto-generate `KNOWN_PARAMS` entries for each confirmed
   block/param. Start with Reverb and Delay since those are the most
   obvious to validate by ear.
4. After `KNOWN_PARAMS` is generated, start on **P3-007 Model lineage
   dictionary** (see `04-BACKLOG.md`) — the 248-amp × 78-drive ×
   79-reverb × 29-delay model names are ready to feed into the
   wiki-scrape pipeline for the real-world-gear-inspired-by mapping.
5. Decode the remaining ~49KB tail past 0x1f926 if it turns out to
   contain additional blocks (scene templates? preset metadata?).

## Decoded parameters and unit conventions

Live source of truth: `src/protocol/params.ts` (`KNOWN_PARAMS` + `Unit`
union). 8 params across 4 blocks (Amp `0x003A`, Drive `0x0076`, Reverb
`0x0042`, Delay `0x0046`) using 5 unit conventions (`knob_0_10`, `db`,
`percent`, `ms`, `enum`). `pidLow` = block ID, `pidHigh` = parameter
index within block; address is preset-independent. Drive Type enum has
only one entry catalogued so far (8 = `TS808`); Amp Channel enum is
fully populated (0..3 ↔ A..D).

## Recent breakthroughs

Older breakthroughs (sessions 04–08, 10–12) are archived in `SESSIONS.md`.
Only Session 13 (current) is kept here for fast orientation.

1. **Post-divider region cracked — 17 blocks, 695 records**
   (Session 13). The `f0 ff 00 00` marker at 0x136f0 introduces a
   256-entry user-cab slot table (names + IDs, 0xf20 bytes), then
   Section 3 begins at 0x14610 with a **compressed 24-byte record
   header** (different from pre-divider's 24-byte-header-with-extra
   layout). Reverb Type (79), Delay Type (29), and Drive Type (78)
   all located — closing Phase 1's protocol-RE loop.
2. **All main effect blocks now enumerated.** Amp (pre-divider, 248
   models), Drive (post-divider block 9, 78 types), Reverb (block 0,
   79 types), Delay (block 1, 29 types). The catalog is ready to
   feed into `KNOWN_PARAMS` auto-generation AND the P3-007 Model
   Lineage Dictionary work.
3. **Pre-divider vs post-divider layout difference.** Pre-divider
   records use 24-byte header with tc=u32 and a/b/c/d floats at
   +8..+23. Post-divider records use 24-byte header with tc=u16 at
   +4 (not +8) and a/b/c/d floats at +8..+23 with different total
   record size (32 bytes for float). Block headers differ too:
   pre-divider is 40 bytes with tag in high 16 bits of u32 at +4;
   post-divider is 32 bytes with tag in high 16 bits of u32 at +8.
4. **Block tag ≠ wire pidLow** (Session 12, still open). Amp wire
   pidLow=0x3A but block tag=0x98. The cache's block order also
   differs from wire pidLow order. Block → wire-pidLow mapping is
   still open.

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
