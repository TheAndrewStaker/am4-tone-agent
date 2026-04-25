# Hydrasynth Explorer — device folder

This folder is the working knowledge base for **ASM Hydrasynth Explorer**
support. It mirrors what `docs/SYSEX-MAP.md`, `docs/SESSIONS.md`, etc.
do for the AM4, scoped to one device so device-specific notes don't
pollute the AM4 docs at the top of `docs/`.

> **Branch status:** `hydrasynth-explorer` (created 2026-04-25). Work
> here is **exploratory**. Per
> `memory/feedback_am4_depth_gates_wave_expansion.md`, this branch must
> not merge to main until BK-032 (AM4 first-page coverage) clears.
> Side-branch work is allowed because it fills time while the founder
> is blocked on AM4 hardware captures.

## Index

- **`OVERVIEW.md`** — what the device is, protocol surface, and the
  capability matrix at a glance. Read first.
- **`MIDI-MAP.md`** — the protocol map. CC table, NRPN mode notes,
  patch bank-select scheme, SysEx (unknown). Updated as we capture
  bytes.
- **`FIRST-SMOKE.md`** — the round-trip test plan. Covers what to send,
  what to expect, and the architectural decision (one-shot script for
  this branch vs. eventual BK-030 tool path).

## Status legend (used in this folder)

- 🟢 **confirmed** — verified against captured bytes from the device
  and reproducible.
- 🟡 **structural** — derived from the official manual but not yet
  hardware-verified by us.
- 🔴 **unknown / blocked** — needs capture, document, or community
  decode work.

## Where things live elsewhere

- **Manual (PDF):** `docs/manuals/other-gear/Hydrasynth_Explorer_Owners_Manual_2.2.0.pdf`
- **Manual (text extract):** `docs/manuals/other-gear/Hydrasynth_Explorer_Owners_Manual_2.2.0.txt`
- **Factory patch listing (xlsx):** `docs/manuals/other-gear/Hydrasynth_Single_Factory_Patch_Listing_2.0.xlsx`
- **Backlog entry:** `docs/04-BACKLOG.md` BK-031.
- **Hard prerequisite for shipping:** BK-030 (general-MIDI primitives
  in `mcp-midi-tools`). This branch can prototype without it; tool
  surface lands behind it.
