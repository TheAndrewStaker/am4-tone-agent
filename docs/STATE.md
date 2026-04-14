# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-14** (after Session 03).

---

## Current phase

**Phase 1 — Protocol RE (in progress).** Phase 0 feasibility was confirmed
(USB MIDI comms, Axe-Fx III command set applies to AM4, preset dump/store
format known). The blocker for MVP is AM4-Edit's outgoing `0x01` parameter-set
command format — undocumented, needed to "puppet the device" per the
architecture decision in `docs/DECISIONS.md` (2026-04-14).

## The single next action

**Capture AM4-Edit's outgoing SysEx via USBPcap + Wireshark to decode
the `0x01` parameter-set command.**

Exact steps the user is mid-execution on:

1. ✅ Install USBPcap and Wireshark.
2. ⏳ **Reboot Windows** to activate the USBPcap kernel filter driver
   (current blocker — `sc query USBPcap` shows `STATE : 1 STOPPED` until
   reboot).
3. After reboot, reconnect the AM4 via USB and launch AM4-Edit. Load
   preset A01 and wait 5 seconds.
4. In Wireshark, identify the USBPcap interface carrying AM4 traffic
   (double-click each USBPcap1/2/3 until one shows live traffic when
   wiggling an AM4 knob).
5. Start a clean capture:
   - Click green shark fin to start.
   - Wait 3 seconds (baseline).
   - In AM4-Edit, move Amp Gain by exactly 1 notch (3.0 → 4.0).
   - Wait 1 second.
   - Click red square to stop.
6. `File → Save As → samples/captured/session-04-gain-change.pcapng`.
7. Paste the filename back to Claude; parser script will decode the
   outgoing SysEx and we'll identify the parameter-set command shape.

## Recent breakthroughs (2026-04-14 sessions)

1. **Protocol family = Axe-Fx III** (Session 02). All AM4 responses match
   the public 3rd-party MIDI spec. Model byte is `0x15`. See `SYSEX-MAP.md`.
2. **Preset dump format decoded** (Session 03). `0x77` header + 4× `0x78`
   chunks + `0x79` footer = 12,352 bytes. Bytes 6–7 of header encode
   `bank_index, slot_within_bank` (0–25, 0–3) → full slot addressing.
3. **Preset bodies are scrambled per-export** (Session 03). Two clean
   exports of the same preset differ by ~2,700 bytes. Cracking this is
   weeks of work with uncertain payoff — so we pivoted architecture.
4. **Architecture: puppet the device, don't encode binaries.** We
   configure the AM4's working buffer via live commands (same as AM4-Edit
   does), then issue the documented store. Device is the encoder.
   Pending: the live-command format itself.

## What's known, short version

- Device comms, checksum, envelope, model ID, all documented commands
  `0x08 / 0x0C / 0x0D / 0x0E / 0x13 / 0x14 / 0x64` — **🟢 confirmed**.
- Preset dump format (`0x77/0x78/0x79`) + slot addressing — **🟢 confirmed**.
- Parameter-set / channel-set / scene-set via AM4-Edit's `0x01` editor
  stream — **🔴 shape unknown, Session 04 target**.
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

- **Next (Session 04):** USB capture + decode `0x01` command format.
- **After that:** write `scripts/write-test.ts` with one proof-of-concept
  parameter set + verify by reading back device state.
- **Then:** build param-set and store helpers in `src/protocol/`; build the
  preset-IR → command-sequence transpiler.
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
- `scripts/scrape-wiki.ts` — Fractal wiki scraper (run `npm run scrape-wiki
  -- P0` to refresh).

## How to use this file

Update this file at the end of every substantive session:

- Change "The single next action" to the next concrete step.
- Move completed items out of "Recent breakthroughs" once they're
  no longer urgent context.
- Keep the file under ~200 lines — it's an orientation doc, not an
  archive. Archive belongs in `SESSIONS.md` and `BACKLOG.md`.
