# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-16** (Session 19 — four protocol wins, one
> correction, three new tools. (a) False-confirm bug triaged: AM4 wire-
> acks every write regardless of block placement, so ack-based apply/
> absorb detection can't work with what we currently decode (BK-008).
> Tool language made honest. (b) Block placement cracked: pidLow=0x00CE,
> pidHigh=0x000F..0x0012 (slots 1–4), value=block pidLow as float32.
> (c) Off-by-one corrected after hardware test (BLOCK_SLOT_PID_HIGH_BASE
> 0x0010 → 0x000F). Block placement hardware-verified end-to-end.
> (d) `apply_preset` MCP tool collapses placement + params into a single
> call. (e) **Save-to-slot decoded** (§6d): function=0x01, pidLow=pidHigh=0,
> action=0x001B, payload=uint32 LE slot index. `save_to_slot` MCP tool
> added, hard-gated to Z04 during RE (P1-008 will relax). Server now
> exposes **8 tools**. 20/20 verify-msg, 8/8 verify-echo.)

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

### Test `save_to_slot` live — round-trip a built preset via Z04

Session 19 shipped `save_to_slot` (Z04-gated) after decoding the save
command from `session-18-save-preset-z04.pcapng`. The save-ack shape
isn't decoded, so success is confirmed by reloading the slot on the
hardware.

1. Restart Claude Desktop (picks up `save_to_slot`; 8 tools now).
2. Build a preset with `apply_preset` (e.g. *"build a clean preset with
   compressor, amp, delay, reverb"*).
3. Ask *"save this to Z04"*. Tool should wire-ack; no audible change.
4. On the AM4, navigate away from Z04 (e.g. load A01) then back to Z04.
   The saved layout + params should reappear. If they don't, the save
   didn't persist — grab the inbound-SysEx log from the tool response
   and we'll compare against AM4-Edit's save traffic.
5. Try *"save this to A05"* or similar → expect a clear rejection
   error ("hard-gated to Z04").

### Earlier follow-up (still valid) — `apply_preset` build

The initial `apply_preset` hardware test already passed (Session 19:
compressor → slot 1, amp/delay/reverb → 2/3/4, amp.gain + reverb.mix
both audibly landed). No action needed.

1. Restart Claude Desktop to pick up `apply_preset`.
2. Load **Z04**, clear blocks on the device.
3. Ask Claude something like *"build me a clean preset with compressor,
   amp (gain 4, bass 6), delay (time 350 ms), and reverb (spring studio,
   mix 35%)"*. Expect Claude to emit a single `apply_preset` tool call
   with the structured slots list, and the AM4 to land at the right
   layout + params in one shot.
4. Verify on the hardware: chain matches, amp gain/bass match, delay time
   matches, reverb type/mix match. Any unintended state from a previous
   preset at slots 5+ (none exist) or unused params (stale values from
   the prior preset — apply_preset doesn't currently reset every param,
   only the ones specified) is a known limitation, not a bug.

Open follow-ons (bigger scopes, see backlog):

- **Scenes.** 4 scenes per preset; `session-18-switch-scene.pcapng`
  exists but builders aren't written. Extending `apply_preset` to take
  `scenes: [...]` unlocks full preset fidelity.
- **Per-block channels.** amp.channel (A/B/C/D) is decoded; other blocks'
  channel pidHigh is extrapolated from amp — worth one capture each to
  confirm before exposing channel control in `apply_preset`.
- **Save to slot / switch preset.** `session-18-save-preset-z04.pcapng`,
  `session-18-switch-preset.pcapng` are captured but not decoded.
  Decoding closes the loop for persistent preset generation.

### What's deferred

- **Apply/absorb discriminator** — the AM4 wire-acks writes whether or
  not the target block is placed (Session 19 hardware finding). Echo
  timing can't tell applied from absorbed. Parked as `BK-008`; unblocks
  truly honest audible-change detection once decoded.
- **Preset save / load / scene switch protocol decode.** Captures exist
  (`session-18-save-preset-z04.pcapng`, `session-18-switch-scene.pcapng`,
  `session-18-switch-preset.pcapng`) but builders aren't written yet.
  Unblocks persistent preset generation (build from scratch + store).

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
Sessions 15–19 (current) are kept here for fast orientation.

000000. **Session 19 — three wins: ack triage, block-placement decode, new
        MCP tools.**

        **19a (ack triage):** Hardware testing via Claude Desktop produced
        four false-confirms on absent-block writes (amp.gain, drive.drive,
        flanger.type, reverb.type/Ambience). First fix attempted: tighten
        `isWriteEcho` to require `hdr4 = 0x0028` (reject the 23-byte
        receipt-echo of our own bytes, accept only the 64-byte device
        frame). Second hardware test killed that hypothesis — the AM4
        emits the 64-byte frame for absorbed writes too. Triage: ack
        presence does NOT indicate apply. Tool language reworked to be
        honest ("wire-acked; not a confirmation of audible change") and
        `set_params` no longer aborts on missing acks. Diagnostic capture
        of all inbound SysEx during the write window now included in
        every tool response. Apply/absorb detection parked as BK-008.

        **19b (block placement cracked):** Three Session-18 captures
        (block-clear, GEQ→Reverb, none→Amp) decoded into one protocol
        rule: block placement is a regular WRITE to pidLow=0x00CE,
        pidHigh=0x0010+slot-1, with the target block's own pidLow as
        the float32 value (0 = "none"). See SYSEX-MAP §6c. The decoded
        values matched the known pidLow table exactly (Reverb=0x42,
        Amp=0x3A). `buildSetBlockType` landed with 3/3 byte-exact
        `verify-msg` goldens against captured wire bytes.

        **19c (new MCP tools):** `set_block_type(position, block_type)`
        and `list_block_types` registered. Server now exposes 6 tools.
        Block-type dictionary (18 entries incl. "none") lives in
        `src/protocol/blockTypes.ts`.

        **19d (off-by-one correction):** First hardware test of
        `set_block_type` landed position 1 on device slot 2, and position
        4 (pidHigh 0x0013) produced a structurally different ack plus
        observed side effects on an unrelated slot. Concluded the three
        Session-18 captures were slots 2/3/4, not 1/2/3. Fixed base
        from `0x0010` to `0x000F` so positions 1..4 map to pidHighs
        0x0F..0x12. Re-test confirmed: compressor→slot 1, amp→slot 2,
        delay→slot 3, reverb→slot 4 all landed on the labelled AM4 slot,
        then amp.gain=6 + reverb.mix=40 both audibly applied.

        **19e (apply_preset tool):** Collapses the N block placements +
        M param writes of a full preset into a single MCP call. Takes
        `{ slots: [{ position, block_type, params? }] }`. Validates all
        input up-front (unknown block/param, out-of-range value, enum
        name typo, duplicate position) before sending any MIDI. Returns
        a per-write ack summary same shape as `set_params`. 7th MCP
        tool registered.

        **19f (save-to-slot decoded + tool):** `session-18-save-preset-
        z04.pcapng` produced one unique command: function=0x01,
        pidLow=pidHigh=0x0000, **action=0x001B**, payload = 4-byte
        uint32 LE slot index (Z04 → 103 → `67 00 00 00` raw →
        `33 40 00 00 00` packed). `buildSaveToSlot` + captured golden
        land in `verify-msg` (20/20). `save_to_slot` MCP tool is the
        8th, hard-gated to Z04 per CLAUDE.md write-safety rules until
        P1-008 (factory preset safety classification) arrives.
        Save-command ack shape still unresolved — the tool dumps all
        inbound SysEx in the 300 ms window instead of asserting.

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
