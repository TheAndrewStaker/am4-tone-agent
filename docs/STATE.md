# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-15** (Session 10 — cache binary schema decoded
> for Section 1 [global settings, 87 records]; Section 2 [per-block
> param definitions] identified but not yet parsed — different layout
> after the `ff ff` marker at 0xaa2d).

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

### Decode Section 2 of `effectDefinitions_15_2p0.cache`

Session 10 shipped `scripts/parse-cache.ts`, a structural decoder for
the cache's record format (22-byte header `u16 id, u16 tc, u16 pad,
f32 min, f32 max, f32 default, f32 step`, then either an enum payload
or 10-byte trailer). It cleanly parses **Section 1** of the cache —
87 records covering global/system settings, ids `0x0d..0xa2`. Output:
`samples/captured/decoded/cache-records.json`.

Section 1 is **not** where block-parameter metadata lives. Cache ids in
Section 1 don't match any `(pidLow, pidHigh)` from Session 08.

Section 2 starts at the `ff ff 00 00` marker at offset `0xaa2d`:

1. `0xaa2d..0xb74d` — 104-entry preset-name list (A01…Z04 and
   `<EMPTY>`). Useful incidentally; not blocking.
2. `0xb74d..end` — **the per-block parameter definitions**. Each
   record is 32 bytes with the same `min/max/default/step` shape but
   non-4-byte aligned and without the id/tc layout we used for
   Section 1. First clear record boundary at `0xb775` (id=1, knob:
   min=0.0, max=1.0, def=10.0, step=0.001). Previous block header /
   preamble between `0xaa2d` and `0xb775` is the puzzle.

**Next steps:**
1. Hex-dump `0xaa2d..0xb800` with `scripts/dump-cache-head.ts <off>`
   and hand-align block headers (look for a `pidLow` byte matching
   `0x3a` (Amp), `0x76` (Drive), `0x42` (Reverb), `0x46` (Delay)).
2. Once block-header shape is known, extend `parse-cache.ts` to emit
   `{ pidLow, pidHigh, min, max, default, step, unit, enumValues? }`.
3. Cross-check against Session 08's eight known params. Expected
   matches: `amp.gain` (0x3a, 0x0b) knob 0..10; `amp.level` (0x3a, 0x00)
   dB -80..20; `drive.type` (0x76, 0x0a) enum with ~128 entries
   including TS808; etc.
4. Auto-generate `KNOWN_PARAMS` from the parsed JSON (via a
   codegen step, not by hand).

### Alternative: skip cache-parsing, continue with capture-driven registry

If Section 2's layout resists decoding, fall back to adding
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

Older breakthroughs (sessions 04–08) are archived in `SESSIONS.md`. Only
Session 10 (current) is kept here for fast orientation.

1. **Cache binary schema decoded — Section 1** (Session 10). 87 global
   setting records parsed cleanly with a 22-byte header + enum/float
   payload. Enum detection is structural (try parsing strings at +22),
   not typecode-based — both `tc=0x1d` and `tc=0x2d` carry strings.
   Section 2 (per-block params) uses a different layout — TBD.

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

- **Now:** decode cache Section 2 (per-block params) — see single next action above.
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
- `scripts/scrape-wiki.ts` — Fractal wiki scraper.

## How to use this file

Update at the end of every substantive session:
- Change "The single next action" to the next concrete step.
- Move completed items out of "Recent breakthroughs" once they're no
  longer urgent context.
- Keep the file under ~200 lines — it's an orientation doc, not an
  archive. Archive belongs in `SESSIONS.md` and `BACKLOG.md`.
