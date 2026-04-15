# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-14** (Session 05 closed — first real write
> verified on hardware).

---

## Current phase

**Phase 1 — Protocol RE: 🟢 COMPLETE AND HARDWARE-VERIFIED.** The 0x01
SET_PARAM message is fully decoded end-to-end and a code-built write
produced a visible parameter change on the device (Amp Gain 1.0 → 0.5 →
1.0, observed on AM4 display, Session 05 closing run).

Entering **Phase 2 — Parameter registry + preset IR + transpiler.**

## The single next action

**Capture 4–6 additional parameter writes via USBPcap to seed the
parameter registry.** Without more parameter IDs and per-parameter
scales we can't build any real preset. Suggested capture targets, all on
preset A01:

| # | Action in AM4-Edit | Filename |
|---|---|---|
| 1 | Amp block: change **Master** to a non-default value | `session-06-amp-master.pcapng` |
| 2 | Amp block: change **Bass** to a non-default value | `session-06-amp-bass.pcapng` |
| 3 | Drive block: change **Type** (e.g. to TS808) | `session-06-drive-type.pcapng` |
| 4 | Drive block: change **Drive** level | `session-06-drive-level.pcapng` |
| 5 | Reverb block: change **Mix** to ~30% | `session-06-reverb-mix.pcapng` |
| 6 | Delay block: change **Time** to 500 ms | `session-06-delay-time.pcapng` |

Capture procedure: same as Session 05 (see SYSEX-MAP §6 "USB capture
workflow"). After each capture, drop the file in `samples/captured/` and
ping me — I'll parse them, infer the parameter IDs, and build
`src/protocol/params.ts`.

Once params.ts exists, the rest of Phase 2 (preset IR + transpiler +
first multi-parameter preset write) is unblocked.

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
- Per-parameter scales (Amp Gain ×10, EQ ÷12) — **🟡 spot-verified, full
  table TBD as we add parameters**.
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
