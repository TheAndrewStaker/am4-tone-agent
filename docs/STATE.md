# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-16** (Session 18 — v0.2 shipped. Write-echo
> confirmation detects silent-absorb; `read_param` removed; 17 params
> across 15 confirmed blocks; Tier-3 captures promoted 11 tentative
> cache-block roles to CONFIRMED. READ-response format is NOT decoded
> (bytes 0-7 are a rotating descriptor/counter, value not at fixed
> offset) — deferred to a future session that will need Ghidra work on
> AM4-Edit's response parser rather than pure capture diffing.)

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

### Test v0.2 write-echo behavior live against hardware

Session 18 shipped echo-verified writes. Before building further, sanity
-check the new failure mode against a real device:

1. Confirm `npm run preflight` still green (it is at commit time —
   16/16 verify-msg goldens, 7/7 verify-echo goldens, smoke-server
   reports 4 tools).
2. Reconnect hardware. Run `npm run write-test` — sanity-check the
   native build.
3. Update `%APPDATA%\Claude\claude_desktop_config.json` (no change
   to stanza; the server path is stable).
4. Restart Claude Desktop. Verify **4** tools now register
   (`set_param`, `set_params`, `list_params`, `list_enum_values`).
   `read_param` is intentionally removed.
5. Load factory preset **A01** (has Amp). Ask *"Set amp gain to 6"*.
   Expected: tool returns "Device confirmed", AM4's display shows 6.0.
6. Load a preset **without Drive placed** (or Z04 scratch). Ask
   *"Set drive.drive to 7"*. Expected: tool returns the silent-absorb
   error — "drive block is NOT placed in the active preset". This is
   the key new behavior vs v0.1.
7. Ask *"Change the reverb type to a spring and the delay to 400 ms
   and compressor type to VCA Modern"* — triggers `set_params` batch.
   Expect per-write echo confirmation and, if any block is missing,
   "Applied N/3 writes, then write #X was silently absorbed".

### Deferred

- **Decode the READ response format.** The 0x0D READ action returns a
  64-byte response with a 40-byte payload. Bytes 0-7 vary per response
  even at stable values (rotating descriptor/counter), bytes 8/11 are
  constant structural markers, bytes 14-39 are zero, and the actual
  current value is NOT at any fixed offset as a packed float32
  (scanned all 5-byte windows against known values 0.2/0.5/0.8/0.25 —
  zero matches). AM4-Edit probably decodes this via a non-trivial
  scheme; cracking it likely needs Ghidra on AM4-Edit's response
  parser. Not a blocker — v0.2 uses WRITE echoes for confirmation.
- **Block-command captures for preset-save / scene-switch / block-type
  assignment.** Captures exist (`session-18-save-preset-z04.pcapng`,
  `session-18-switch-scene.pcapng`, `session-18-block-type-gte-to-rev
  .pcapng`, etc.) but NOT yet decoded into protocol builders. That's
  the next session's work — decoding these unlocks the real MVP
  (`apply_preset` in one call).
- **PEQ and Rotary have pidLow but no Type enum.** KNOWN_PARAMS needs
  specific knob entries (PEQ band freqs/gains, Rotary rate/depth)
  once we decide the naming scheme. Cache records are already in
  `docs/CACHE-DUMP.md`.
- **P3-007 Model Lineage Dictionary** (see `04-BACKLOG.md`) —
  `cacheEnums.ts` is the authoritative input for the wiki-scrape
  pipeline. 15 block dictionaries ready (498 total enum entries).

**Layouts (parser is source of truth — see `scripts/parse-cache.ts`):**

- Section 3 begins at divider `f0 ff 00 00` (0x136f0 on this install),
  followed by `cabNames[256]` (all `<EMPTY>`) and `cabIds[256]` (all
  `0xff`), then a 32-byte block header at ~0x14610, then records.
- Section 3 records use a compressed 24-byte header (tc=u16 at +4,
  floats a/b/c/d at +8..+23). Float records: 32 bytes total (trailer
  u32=0 + extra u32). Enum records: u32 count + strings + u32 trailer.
- `cache-section3.json` contains `{ cabNames, cabIds, records }` where
  each record has `{ offset, block, id, typecode, kind, a, b, c, d,
  values?, extra? }`.

**17 sub-blocks (from `cache-section3.json`, summary printed by
`parse-cache.ts`):** sub-block 0 = Reverb (72 recs, id=10 enum × 79),
sub-block 1 = Delay (89 recs, id=10 enum × 29), sub-block 9 = Drive
(49 recs, id=10 enum × 78). Remaining 14 sub-blocks are Chorus/Flanger
/Pitch/EQ/Compressor/Filter candidates — role assignment still open.

**Next steps (Session 15+):**

1. Cross-reference the 4 main blocks (Amp pre-divider block 5, Reverb/
   Delay/Drive post-divider sub-blocks 0/1/9) against wire `pidLow`
   values (`0x3A`, `0x42`, `0x46`, `0x76`). Preferred heuristic:
   Drive's `id=10` enum at index 8 is `TS808` — matches `params.ts`
   Drive Type, so sub-block 9 ↔ `pidLow=0x76`. Confirm Reverb/Delay
   by capturing AM4-Edit setting Reverb Type and Delay Type and
   matching the resulting `pidHigh` to the cache record IDs.
2. Auto-generate `KNOWN_PARAMS` entries for each confirmed
   block/param. Start with Reverb and Delay since those are the most
   obvious to validate by ear.
3. After `KNOWN_PARAMS` is generated, start on **P3-007 Model lineage
   dictionary** (see `04-BACKLOG.md`) — the 248-amp × 78-drive ×
   79-reverb × 29-delay model names are ready to feed into the
   wiki-scrape pipeline for the real-world-gear-inspired-by mapping.
4. Decode the remaining ~49KB tail past 0x1f926 if it turns out to
   contain additional blocks (scene templates? preset metadata?).

## Decoded parameters and unit conventions

Live source of truth: `src/protocol/params.ts` (`KNOWN_PARAMS` + `Unit`
union). 11 params across 4 blocks (Amp `0x003A`, Drive `0x0076`, Reverb
`0x0042`, Delay `0x0046`) using 5 unit conventions (`knob_0_10`, `db`,
`percent`, `ms`, `enum`). `pidLow` = block ID, `pidHigh` = parameter
index within block; address is preset-independent. All 4 type enums
(Amp 248 / Drive 78 / Reverb 79 / Delay 29) are populated from
`cacheEnums.ts`. Amp Channel enum is fully populated (0..3 ↔ A..D).
Capture-verified entries: `amp.gain/bass/level/channel`, `drive.drive/
type=TS808`, `reverb.mix`, `delay.time`. Cache-derived and untested:
`amp.type`, `reverb.type`, `delay.type`, plus the expanded `drive.type`
index table (only index 8 has been wire-verified).

## Recent breakthroughs

Older breakthroughs (sessions 04–08, 10–14) are archived in `SESSIONS.md`.
Sessions 15–18 (current) are kept here for fast orientation.

00000. **Session 18 — write-echo confirmation + 11 blocks confirmed.**
       Three sub-phases:
       
       **18a (echo protocol):** After `set_param`, listen for a 64-byte
       response with matching pidLow/pidHigh and `action=0x0001`
       within 300 ms. Presence = write took; timeout = silent-absorb
       (block not placed in active preset). Implemented via
       `receiveSysExMatching` in `midi.ts` and `isWriteEcho`
       predicate in `setParam.ts`. Covers `set_param` and
       `set_params` (per-write echo, stops on first silent-absorb).
       `read_param` removed — the AM4's READ response carries
       metadata, not current value, at any fixed offset.
       
       **18b (6 Tier-3 block Type captures):** Chorus (0x4E),
       Flanger (0x52), Phaser (0x5A), Wah (0x5E), Compressor (0x2E),
       GEQ (0x32) — each Type-dropdown change confirmed the wire
       pidLow matches the cache sub-block's position. Added 6
       KNOWN_PARAMS entries + 6 byte-exact verify-msg goldens.
       
       **18c (5 more blocks + 2 address-only):** Filter (0x72),
       Tremolo (0x6A), Enhancer (0x7A), Gate (0x92), Volume/Pan
       (0x66) — 5 more Type/Mode selectors, all with goldens.
       Parametric EQ (0x36) and Rotary (0x56) captures pinned
       their pidLows but they have no Type enum; KNOWN_PARAMS
       entries deferred until we pick specific knobs. Cache block
       roles: all 4 main S2 effect blocks + all 11 S3 effect
       sub-blocks now CONFIRMED. See `CACHE-BLOCKS.md`.
       
       Final: 17 KNOWN_PARAMS across 15 confirmed blocks; 16/16
       verify-msg goldens + 7/7 verify-echo goldens green.

000. **Type-enum dictionaries wired into params.ts** (Session 16).
     `scripts/gen-cache-enums.ts` emits `src/protocol/cacheEnums.ts`
     with AMP/DRIVE/REVERB/DELAY type arrays (248/78/79/29 entries).
     `KNOWN_PARAMS` now carries `amp.type`, `reverb.type`, `delay.type`;
     `drive.type` expanded from 1 entry to full 78-entry table;
     `delay.time` displayMax corrected from 5000 ms to 8000 ms.
     `docs/CACHE-DUMP.md` is the human-readable companion showing
     every param record for the 4 mapped blocks. Preflight green.

00. **Wire pidHigh == cache record id** (Session 15). Cross-referenced
    `KNOWN_PARAMS` against parsed cache via `scripts/map-cache-params.ts`:
    6/7 known params line up by id directly (amp.gain → cache id=11,
    amp.bass → id=12, drive.type → id=10 with 78-entry enum, …). This
    pins block → wire pidLow: Amp=S2 block 5 (tag=0x98), Drive=S3
    sub-block 9, Reverb=S3 sub-block 0, Delay=S3 sub-block 1. Two
    KNOWN_PARAMS are "out-of-band" (pidHigh not in per-block table):
    `amp.channel` (0x07D2) and `amp.level` (0x0000). The cache now
    supplies exact displayMin/displayMax/step for every in-band param
    and full enum tables (248 amps, 78 drives, 79 reverbs, 29 delays,
    138 cabs, 69 mics).
0. **Section 3 parser landed** (Session 14). `scripts/parse-cache.ts`
   now emits `cache-section3.json` with 256 user-cab names, 256 user-
   cab IDs, and 695 parameter records across 17 sub-blocks. All wire-
   visible enum strings (Reverb/Delay/Drive types, 78–79 entries each)
   are now in committed JSON. `npm run preflight` green.
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
  Section 1 (87 global-setting records), Section 2 (465 records / 7
  blocks) and Section 3 (695 records / 17 sub-blocks + cab tables)
  cleanly into typed JSON.
- `scripts/map-cache-params.ts` — verifies KNOWN_PARAMS against the
  parsed cache with the pinned (pidLow → cache block) mapping, and
  dumps each main block's candidate parameter list.
- `scripts/gen-cache-enums.ts` — generates `src/protocol/cacheEnums.ts`
  and `docs/CACHE-DUMP.md` from the parsed cache JSON.
- `src/protocol/cacheEnums.ts` — generated Amp/Drive/Reverb/Delay type
  dictionaries, imported by `params.ts`.
- `docs/CACHE-DUMP.md` — committed human-readable dump of the 4 mapped
  blocks (ids, kinds, ranges, enum values).
- `docs/CACHE-BLOCKS.md` — every cache block with tentative effect-role
  assignment + evidence + capture TODO list.
- `src/server/index.ts` — MCP server over stdio. Tools: `set_param`,
  `list_params`, `list_enum_values`.
- `scripts/smoke-server.ts` — client-side MCP handshake harness
  verifying the server comes up and serves tool listings.
- `docs/MCP-SETUP.md` — Claude Desktop wiring instructions.
- `scripts/dump-cache-head.ts` — hex+ASCII peek tool for cache offsets.
- `samples/captured/decoded/cache-strings.txt` — 7,610 length-prefixed
  strings extracted from `effectDefinitions_15_2p0.cache`.
- `samples/captured/decoded/cache-records.json` — parsed Section 1.
- `samples/captured/decoded/cache-section2.json` — parsed Section 2 (465 records across 7 blocks: routing + Amp tag=0x98 + Utility blocks).
- `samples/captured/decoded/cache-section3.json` — parsed Section 3 (695 records across 17 sub-blocks + 256 user-cab names/ids).
- `scripts/scrape-wiki.ts` — Fractal wiki scraper.

## How to use this file

Update at the end of every substantive session:
- Change "The single next action" to the next concrete step.
- Move completed items out of "Recent breakthroughs" once they're no
  longer urgent context.
- Keep the file under ~200 lines — it's an orientation doc, not an
  archive. Archive belongs in `SESSIONS.md` and `BACKLOG.md`.
