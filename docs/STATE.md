# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-15** (Session 09 — AM4-Edit's parameter
> metadata cache located at %APPDATA%; contains all 7,610 param names
> and enum strings we need to bulk-populate `KNOWN_PARAMS`).

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

### Parse `effectDefinitions_15_2p0.cache` into `KNOWN_PARAMS`

Session 09 located the parameter metadata. It's not in the exe — AM4-Edit
queries the AM4 at startup and caches the result at:

```
%APPDATA%\Fractal Audio\AM4-Edit\effectDefinitions_15_2p0.cache
```

129 KB. Contains **7,610 length-prefixed ASCII strings** (every drive
model, amp model, reverb type, delay type, cab IR name, MIDI label, and
routing-mode enum we need) plus float ranges and record headers.
Extracted string dump: `samples/captured/decoded/cache-strings.txt`.
Scratchpad walker: `scripts/peek-cache.ts`.

**Next step: write `scripts/parse-cache.ts`** — a full schema decoder
that outputs a typed JSON table `{ (pidLow, pidHigh) → { name, min,
max, default, step, unit, enumValues? } }`. That replaces the entire
hand-curated `KNOWN_PARAMS` workflow.

Schema recipe (see SESSIONS.md Session 09 for full detail):
1. 16-byte header: two uint64 LE = `(2, 4)` — probably (version, flags).
2. Record stream. Two observed shapes:
   - **Float-range:** `[id:u16] 37 00 00 00 00 00 <min:f32> <max:f32>
     <default:f32> <step:f32> <padding>`.
   - **Enum:** `[id:u16] 1d 00 ... <count:u32>
     [<len:u32><ASCII bytes>]*count`.
3. The heuristic walker in `peek-cache.ts` desyncs after ~950 records —
   it's scanning blindly; a proper parser should read each record header
   then step forward by the exact payload size.

Ground-truth validation: Session 08 captures give 8 known `(pidLow,
pidHigh) → (name, range)` pairs. If cache record `id` field matches
`pidHigh` 1:1 on those 8, the mapping is direct. If not, we'll discover
the offset/indirection by diffing.

### Alternative: skip cache-parsing, continue with capture-driven registry

If the cache schema proves harder than expected, fall back to adding
captured-bytes `verify-msg` cases one param at a time. We already have
the method for every new param; it's just slow. The cache is a bulk
shortcut, not a blocker.

**Setup:**
- Open `AM4-Edit.exe` in Ghidra (the same project used in Session 05 to
  find the float encoder — already analyzed).
- Existing companion script: `scripts/ghidra/FindEncoder.java` shows
  the script style (Ghidra Script Manager → New Script).

**What to look for:**
1. **String search** — likely fastest first pass. Search for known
   parameter names in the Defined Strings window:
   - `"Gain"`, `"Bass"`, `"Mid"`, `"Treble"`, `"Master"`, `"Level"`
   - `"TS808"` (the only Drive Type enum we know)
   - `"Reverb"`, `"Delay"`, `"Chorus"`, `"Phaser"`, `"Tremolo"`
   For each hit, list **References → To** and inspect the calling code.
   A long contiguous run of strings is almost always a metadata table.
2. **Cross-reference the SET_PARAM call site.** The encoder
   `FUN_140156d10` is called from somewhere; trace upward to find code
   that maps a UI control to a `(pidLow, pidHigh, scale, displayName)`
   tuple. That structure IS the metadata table.
3. **Look for arrays of struct-like records** near any param name
   string. Common shape: `{ const char* name; uint16_t pidHigh; float
   scale; uint8_t unitCode; ... }`.

**What to capture and drop in the repo:**
- Save findings to `docs/sessions/session-08-ghidra-notes.md` (create
  the dir if needed): table address, struct shape guess, screenshot or
  ASCII paste of 2–3 contiguous records.
- If an enum string table is found (e.g. all Drive Types in order),
  paste the raw strings — even unparsed it's gold.

Once the shape is known, write `scripts/ghidra/ExtractParamTable.java`
modeled on `FindEncoder.java` to dump the table mechanically, and feed
the output into `KNOWN_PARAMS` (`src/protocol/params.ts`).

## Decoded parameters and unit conventions

Live source of truth: `src/protocol/params.ts` (`KNOWN_PARAMS` + `Unit`
union). 8 params across 4 blocks (Amp `0x003A`, Drive `0x0076`, Reverb
`0x0042`, Delay `0x0046`) using 5 unit conventions (`knob_0_10`, `db`,
`percent`, `ms`, `enum`). `pidLow` = block ID, `pidHigh` = parameter
index within block; address is preset-independent. Drive Type enum has
only one entry catalogued so far (8 = `TS808`); Amp Channel enum is
fully populated (0..3 ↔ A..D).

## Recent breakthroughs

Older breakthroughs (sessions 04–07) are archived in `SESSIONS.md`. Only
session-08 (current) is kept here for fast orientation.

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

- **Now:** Ghidra metadata extraction (single next action above).
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
  cache. Starting point for the real parser.
- `samples/captured/decoded/cache-strings.txt` — 7,610 length-prefixed
  strings extracted from `effectDefinitions_15_2p0.cache`.
- `scripts/scrape-wiki.ts` — Fractal wiki scraper.

## How to use this file

Update at the end of every substantive session:
- Change "The single next action" to the next concrete step.
- Move completed items out of "Recent breakthroughs" once they're no
  longer urgent context.
- Keep the file under ~200 lines — it's an orientation doc, not an
  archive. Archive belongs in `SESSIONS.md` and `BACKLOG.md`.
