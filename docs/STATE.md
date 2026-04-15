# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-14** (Session 06 — 6 new parameters decoded,
> address stability confirmed across presets).

---

## Current phase

**Phase 1 — Protocol RE: 🟢 COMPLETE AND HARDWARE-VERIFIED.** First real
write produced visible parameter change on the device (Session 05).

**Phase 2 — Parameter registry + preset IR + transpiler.** In progress.
Session 06 captured 6 more parameters and decoded them; the parameter
ID structure is now understood.

## The single next action

**Build `src/protocol/params.ts`** — typed parameter registry with
per-parameter scale + unit conversion. All needed data is already in
`samples/captured/decoded/session-06-*.tshark.txt`; no more captures
required to start.

The registry should:
1. Define a `Param` type: `{ name, block, pidLow, pidHigh, unit, scale, displayMin, displayMax }`.
2. Encode the 5 known unit conventions as a `Unit` enum (see "Unit
   conventions" below).
3. Provide `encode(param, displayValue) → internalFloat` and
   `decode(param, internalFloat) → displayValue` helpers.
4. Seed with the 7 known parameters (Amp Gain + the 6 from session 06 —
   table below).
5. Export `KNOWN_PARAMS` keyed by `block.paramName` (e.g.
   `KNOWN_PARAMS['amp.gain']`).

After params.ts: build `src/protocol/setParam.ts` higher-level helper
that takes `(paramKey, displayValue)` and uses the registry to build the
right SET_PARAM message. Then move on to preset IR + transpiler.

## Decoded parameters (sessions 04–06)

`pidLow` = block ID. `pidHigh` = parameter index within block. **Address
is preset-independent — confirmed by capturing on A01 and A2 with
matching pidLow for the Amp block.**

| Block | pidLow | Param | pidHigh | UI scale | Notes |
|---|---|---|---|---|---|
| Amp | `0x003A` | Gain | `0x000B` | ÷10 (UI 0–10) | session 04, A01 |
| Amp | `0x003A` | Bass | `0x000C` | ÷10 | session 06, A2 |
| Amp | `0x003A` | Level | `0x0000` | 1:1 (raw dB) | session 06, A2 |
| Drive | `0x0076` | Drive | `0x000B` | ÷10 | session 06 |
| Drive | `0x0076` | Type | `0x000A` | enum (raw int as float; e.g. 8 = TS808) | session 06 |
| Reverb | `0x0042` | Mix | `0x0001` | ÷100 (UI %) | session 06 |
| Delay | `0x0046` | Time | `0x000C` | ÷1000 (UI ms → internal s) | session 06 |

## Unit conventions seen

1. **`knob_0_10`** — UI shows 0–10, internal stores ÷10 (e.g. Gain, Bass, Drive)
2. **`db`** — UI shows dB, internal stores raw dB (e.g. Amp Level)
3. **`percent`** — UI shows 0–100%, internal stores ÷100 (e.g. Reverb Mix)
4. **`ms`** — UI shows ms, internal stores seconds = ÷1000 (e.g. Delay Time)
5. **`enum`** — UI shows a name from a dropdown, internal stores the
   index as a float32 (e.g. Drive Type 8 = TS808). Each enum-typed
   parameter needs its own value→name table.

## Recent breakthroughs (2026-04-14 sessions)

1. **Address stability across presets confirmed** (Session 06). Amp
   block pidLow = `0x003A` on both A01 and A2. Removes a previously
   open question and means the parameter registry is preset-agnostic.
2. **Parameter ID structure decoded** (Session 06): pidLow is the
   block ID, pidHigh is the parameter index *within* that block. Same
   pidHigh can mean different things in different blocks
   (`0x000C` = Amp Bass *or* Delay Time).
3. **5 unit conventions catalogued** (Session 06).
4. **HARDWARE VERIFICATION** (Session 05 closing): `npm run write-test`
   produced a visible Amp Gain change on the live AM4. End-to-end
   protocol layer confirmed working, not just byte-correct in tests.
5. **`0x01` SET_PARAM message structure fully decoded** (Session 05).
   Body layout = 5 14-bit LE header fields + 8-to-7 packed value bytes.
6. **Float packing scheme cracked** (Session 05) via Ghidra RE of
   `FUN_140156d10` (encoder) and `FUN_140156af0` (decoder) in
   AM4-Edit.exe. Standard sliding-window 8-to-7 bit-pack of IEEE 754
   little-endian float bytes. 4 raw bytes → 5 wire septets.
7. **Implementation built and verified** (Session 05):
   - `src/protocol/checksum.ts` — Fractal XOR checksum
   - `src/protocol/packValue.ts` — sliding 8-to-7 bit-pack/unpack
   - `src/protocol/setParam.ts` — `buildSetFloatParam(param, value)` etc
   - `src/protocol/midi.ts` — node-midi async wrapper
   - `scripts/write-test.ts` — first hardware write (passed 🟢)
   - Verifications: 10/10 pack samples, 2/2 captured-message bytes match.

## Recent breakthroughs (2026-04-14 sessions)

1. **HARDWARE VERIFICATION** (Session 05 closing): `npm run write-test`
   produced a visible Amp Gain change on the live AM4. End-to-end
   protocol layer confirmed working, not just byte-correct in tests.
2. **`0x01` SET_PARAM message structure fully decoded** (Session 05).
   Body layout = 5 14-bit LE header fields + 8-to-7 packed value bytes.
   Earlier "address is 4 bytes" model was wrong: it's two 14-bit fields
   (pidLow, pidHigh) plus a type code, a reserved field, and a payload
   byte count.
3. **Float packing scheme cracked** (Session 05) via Ghidra RE of
   `FUN_140156d10` (encoder) and `FUN_140156af0` (decoder) in
   AM4-Edit.exe. Standard sliding-window 8-to-7 bit-pack of IEEE 754
   little-endian float bytes. No obfuscation. 4 raw bytes → 5 wire septets.
4. **Per-parameter scale conversion** discovered (Session 05): firmware
   stores normalized floats; AM4-Edit applies a per-parameter inverse
   scale on display (Amp Gain × 10, EQ band ÷12 dB, …). Earlier "linear
   pack hypothesis failed" was an artifact of mixing two scales in one
   regression, not a non-linearity in the pack itself.
5. **Implementation built and verified** (Session 05):
   - `src/protocol/checksum.ts` — Fractal XOR checksum
   - `src/protocol/packValue.ts` — sliding 8-to-7 bit-pack/unpack
   - `src/protocol/setParam.ts` — `buildSetFloatParam(param, value)` etc
   - `src/protocol/midi.ts` — node-midi async wrapper
   - `scripts/write-test.ts` — first hardware write (passed 🟢)
   - Verifications: 10/10 pack samples, 2/2 captured-message bytes match.

## Recent breakthroughs (2026-04-14 sessions)

1. **`0x01` SET_PARAM message structure fully decoded** (Session 05). Body
   layout = 5 14-bit LE header fields + 8-to-7 packed value bytes. Earlier
   "address is 4 bytes" model was wrong: it's two 14-bit fields (pidLow,
   pidHigh) plus a type code, a reserved field, and a payload byte count.
2. **Float packing scheme cracked** (Session 05) via Ghidra RE of
   `FUN_140156d10` (encoder) and `FUN_140156af0` (decoder) in
   AM4-Edit.exe. It's a standard sliding-window 8-to-7 bit-pack of the
   IEEE 754 little-endian float bytes. No obfuscation, no XOR, no
   scrambling. 4 raw bytes → 5 wire septets.
3. **Per-parameter scale conversion** discovered (Session 05): firmware
   stores normalized floats; AM4-Edit applies a per-parameter inverse
   scale on display (Amp Gain × 10, EQ band ÷12 dB, …). Earlier "linear
   pack hypothesis failed" was an artifact of mixing two scales (Amp
   Gain ×10 and EQ ÷12) in one regression, not a non-linearity in the
   pack itself.
4. **Implementation built and verified** (Session 05):
   - `src/protocol/checksum.ts` — Fractal XOR checksum
   - `src/protocol/packValue.ts` — sliding 8-to-7 bit-pack/unpack
   - `src/protocol/setParam.ts` — `buildSetFloatParam(param, value)` etc
   - `src/protocol/midi.ts` — node-midi async wrapper
   - `scripts/write-test.ts` — first hardware write attempt
   - Verifications: 10/10 pack samples, 2/2 captured-message bytes match.

## What's known, short version

- Device comms, checksum, envelope, model ID, all documented commands
  `0x08 / 0x0C / 0x0D / 0x0E / 0x13 / 0x14 / 0x64` — **🟢 confirmed**.
- Preset dump format (`0x77/0x78/0x79`) + slot addressing — **🟢 confirmed**.
- `0x01` SET_PARAM message format AND value encoding — **🟢 fully decoded**.
- Parameter ID structure (pidLow=block, pidHigh=param-in-block) — **🟢
  decoded session 06; preset-independent**.
- 7 parameters across 4 blocks with 5 unit conventions — **🟢 catalogued**
  (see table above). Many more to add but the pattern is clear.
- Drive Type → enum-name mapping — **🟡 only TS808 = 8 known; need a
  capture per type to fill the dropdown table**.
- Full preset binary layout inside `0x78` chunks — **🔴 scrambled, parked**.

## MVP scope (committed in `DECISIONS.md`)

User describes a tone → Claude composes a preset plan → Claude sends
parameter-set commands to configure AM4's working buffer → Claude issues
store to a user-chosen slot → AM4 sounds right. Includes: full block
chain, 4 scenes with per-block channel assignment, reusable channel-block
library. Does NOT include: live toggles, live tweaks, or scene-switch as a
feature (those are deliberately out of scope).

Target user: **a guitarist with a Claude account, not a developer.**
Distribution: signed Windows `.exe`, one-click Claude Desktop config.

## Write-safety protocol (always in force)

- `scripts/probe.ts` is read-only forever.
- `scripts/write-test.ts` only modifies the **working buffer** (no Z04
  backup needed — values revert on preset change / power cycle).
- For PERSISTENT writes (the eventual `0x77` STORE command), only slot
  **Z04** is ever written during RE. Back it up before every write.
- MCP layer enforces read-classify-backup-confirm-write; non-bypassable.
- Full rules in `docs/DECISIONS.md`.

## Roadmap landmarks

- **Now:** run `npm run write-test` against the live AM4. Confirm the
  amp's Gain value actually changes. (Hardware-in-the-loop verification.)
- **Next:** build a parameter-ID registry (`src/protocol/params.ts`)
  capturing per-parameter scale + display unit. Capture more parameter
  addresses (Amp Master, Cab IR, Drive type, Reverb mix, Delay time…).
- **Then:** preset-IR (`src/ir/preset.ts`) + transpiler (preset-IR →
  command sequence).
- **Then:** scaffold MCP server (`src/server/`) with the first two tools
  (`read_slot`, `apply_preset`).
- **Then:** natural-language → preset-IR (Claude side).
- **Phase 5:** packaging to signed `.exe` (see `docs/04-BACKLOG.md`).

## Where everything lives

- `src/protocol/` — verified protocol layer (checksum, pack, setParam, midi).
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
- `scripts/ghidra/FindEncoder.java` — Ghidra script that found the encoder.
- `scripts/scrape-wiki.ts` — Fractal wiki scraper.

## How to use this file

Update at the end of every substantive session:
- Change "The single next action" to the next concrete step.
- Move completed items out of "Recent breakthroughs" once they're no
  longer urgent context.
- Keep the file under ~200 lines — it's an orientation doc, not an
  archive. Archive belongs in `SESSIONS.md` and `BACKLOG.md`.
