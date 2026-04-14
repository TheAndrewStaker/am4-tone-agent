# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-14** (after Session 04).

---

## Current phase

**Phase 1 — Protocol RE (in progress).** The `0x01` parameter R/W command
shape is now 🟢 confirmed (Session 04). The remaining Phase 1 work is
(a) decoding the 6-byte float packing scheme and (b) writing a real
test write to slot Z04 via `scripts/write-test.ts`. After that, Phase 1
closes and we move to the transpiler + MCP scaffold.

## The single next action

**Decode the 6-byte IEEE 754 float packing scheme from Session 04's 8
samples, then write `scripts/write-test.ts` to perform a single verified
param-set write to slot Z04.**

Exact steps:

1. Write `scripts/decode-float-pack.ts`. Input: the 8 (float → 6 wire
   bytes) samples from `SYSEX-MAP.md §6b`. Strategy: iterate over
   candidate unpacking schemes (Roland 8-to-7, Fractal 3-septet, nibble
   pack, bit-reversed variants) and check which recovers all 8 floats
   from their wire bytes bijectively. Target: one scheme that produces a
   `packFloat32(f: number) → Uint8Array(6)` function.
2. Sanity-check by round-tripping: `pack(4.0)` should equal
   `00 66 73 19 43 70` byte-for-byte.
3. Write `scripts/write-test.ts` (not yet created). Read-classify-backup
   protocol per `DECISIONS.md`:
   - Back up slot Z04 (read via 0x77/0x78/0x79 store → save to
     `samples/captured/Z04-backup-YYYY-MM-DD.syx`).
   - Send a `0x01` WRITE to Amp Gain = 2.50 (non-trivial value,
     mantissa ≠ 0 to exercise the packing).
   - Read back via the appropriate `0x01` read-type.
   - Compare written and read-back values; assert equality.
4. Update `SYSEX-MAP.md §6b` (🟡 → 🟢) with the decoded packing scheme.

## Recent breakthroughs (2026-04-14 sessions)

1. **`0x01` param-set command shape confirmed** (Session 04). 23-byte OUT
   writes, 18-byte OUT reads. Action code at body offset 5 (`01` =
   WRITE; `0D/10/26/0E/1F` = read-by-type). See `SYSEX-MAP.md §6a`.
2. **Amp Gain parameter address = `3A 00 0B 00`** on preset A01 (Session
   04). First confirmed AM4 parameter address.
3. **Value encoding is 32-bit IEEE 754 float** (Session 04). 8 samples
   captured; zero-mantissa values share `00 66 73 XX 43 XX` skeleton,
   non-zero-mantissa values break it. Packing scheme TBD — finite-search
   problem, not blocked.
4. **Architecture: puppet the device, don't encode binaries.** We
   configure the AM4's working buffer via live `0x01` writes (same as
   AM4-Edit), then issue the documented `0x77/0x78/0x79` store. Device
   is the encoder. Session 04 unblocked the live-write path.

## What's known, short version

- Device comms, checksum, envelope, model ID, all documented commands
  `0x08 / 0x0C / 0x0D / 0x0E / 0x13 / 0x14 / 0x64` — **🟢 confirmed**.
- Preset dump format (`0x77/0x78/0x79`) + slot addressing — **🟢 confirmed**.
- `0x01` parameter R/W dispatcher shape (header, action codes, length
  byte) — **🟢 confirmed (Session 04)**.
- 6-byte float packing scheme inside `0x01` write payload — **🟡 8
  samples captured; scheme not yet decoded**.
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
- Write experiments live in a separate `scripts/write-test.ts` (not
  yet created).
- Only slot **Z04** is ever written during RE. Back it up before every
  write.
- MCP layer enforces read-classify-backup-confirm-write; non-bypassable.
- Full rules in `docs/DECISIONS.md`.

## Roadmap landmarks

- **Next (Session 05):** decode float packing + write `scripts/write-test.ts`.
- **After that:** build param-set and store helpers in `src/protocol/`; build
  the preset-IR → command-sequence transpiler.
- **Then:** scaffold MCP server (`src/server/`) with the first two tools
  (`read_slot`, `apply_preset`).
- **Then:** natural-language → preset-IR (Claude side).
- **Phase 5:** packaging to signed `.exe` (see `docs/04-BACKLOG.md`).

## Where everything lives

- `docs/SESSIONS.md` — every RE session, chronological, with raw captures.
- `docs/SYSEX-MAP.md` — working protocol reference (🟢/🟡/🔴 tagged).
- `docs/DECISIONS.md` — architecture and scope decisions with rationale.
- `docs/REFERENCES.md` — local PDFs (AM4 manual, Blocks Guide, Axe-Fx III
  MIDI PDF), factory bank, and community sources.
- `docs/BLOCK-PARAMS.md` — AM4 block types and effect types ground truth.
- `docs/04-BACKLOG.md` — phased work item list.
- `scripts/probe.ts` — read-only device probe.
- `scripts/sniff.ts` — bidirectional MIDI proxy (requires loopMIDI; blocked
  by AM4-Edit's port filtering — superseded by USBPcap approach for
  capturing AM4-Edit traffic).
- `scripts/diff-syx.ts` — byte-level diff of two `.syx` files.
- `scripts/parse-capture.ts` — parses a `tshark -V -Y sysex` dump of a
  USBPcap capture and bucketises OUT SysEx by body pattern. Reveals reads
  vs. writes at a glance.
- `scripts/scrape-wiki.ts` — Fractal wiki scraper (run `npm run scrape-wiki
  -- P0` to refresh).

## USB capture workflow (for when you need another one)

1. Plug AM4 into the right-side USB port. Confirm `sc query USBPcap`
   shows `STATE : 4 RUNNING`.
2. Launch Wireshark **as Administrator**. AM4 is on **USBPcap2**.
3. Use the surgical-capture procedure: start capture, wait 3s baseline,
   perform the single action, wait 1s, stop. Save to
   `samples/captured/<name>.pcapng`.
4. Dump: `"C:/Program Files/Wireshark/tshark.exe" -r <file>.pcapng -Y sysex
   -V > samples/captured/decoded/<name>.tshark.txt`
5. Parse: `npx tsx scripts/parse-capture.ts samples/captured/decoded/<name>.tshark.txt`
6. 23-byte OUT messages = writes. 18-byte OUT = reads. See Session 04 in
   `SESSIONS.md` for the worked example.

## How to use this file

Update this file at the end of every substantive session:

- Change "The single next action" to the next concrete step.
- Move completed items out of "Recent breakthroughs" once they're
  no longer urgent context.
- Keep the file under ~200 lines — it's an orientation doc, not an
  archive. Archive belongs in `SESSIONS.md` and `BACKLOG.md`.
