# Hardware Tasks Queue

> Physical actions the founder needs to perform at the device (USB
> captures, round-trip tests, reference dumps). Claude Code appends to
> this file when hardware work is required and cannot perform it alone.
> Check this file at the start of each session.
>
> **Active focus:** AM4 and Axe-Fx II XL+ (founder-owned, Wave 1 RE).
> Other owned gear (RC-505 MKII, VE-500, SPD-SX, JD-Xi) is
> **research-only for now** — no active hardware tasks queued until the
> Fractal line is cleared.
>
> Last updated: 2026-04-18

## Status key

- 🔜 **Pending** — awaiting founder action
- ⏳ **Done, awaiting decode** — capture / test complete, Claude to process
- ✅ **Complete** — decoded / integrated / archived

## Done signal

When you finish an item, say **"HW-NNN done"** in chat. Include the saved
path (if a capture) or the observed behavior (if a round-trip test).
Claude picks up from there and moves the item to ⏳ or ✅.

---

## Active queue — AM4 (Phase 1 wrap)

### HW-001 — Capture scenes 1/3/4 switches 🔜

- **For:** confirms scene-switch decode (STATE.md "single next action";
  Session 20 tentative)
- **Why:** Session 20 captured only the switch *to* scene 2 and
  tentatively decoded it as "value = scene index" at
  `pidLow=0x00CE / pidHigh=0x000D / action=0x0001`. Capturing scenes 1,
  3, 4 decides between "value = scene index" (current hypothesis) and
  "pidHigh changes per scene."
- **Steps:**
  1. Start USBPcap, attach to the AM4 interface.
  2. In AM4-Edit, click scene 1 → 3 → 4 → 1 (or a similar sequence
     that visits each scene).
  3. Save as `samples/captured/session-21-switch-scene-1-3-4.pcapng`.
- **Expected:** three 23-byte writes all at `pidLow=0x00CE`,
  `pidHigh=0x000D`, `action=0x0001`, varying only in the packed u32 LE
  value (0, 2, 3 respectively).
- **If the pidHighs differ across writes:** we're in the "pidHigh per
  scene" world instead — `buildSwitchScene` needs a different shape.

### HW-002 — Test `set_preset_name` persistence on Z04 🔜

- **For:** STATE.md follow-up; unblocks finishing BK-011 (naming)
- **Why:** the rename command is byte-correct against the captured wire
  (Session 19g) but we don't know if the rename alone persists, or
  whether it writes the working buffer only and needs a `save_to_slot`
  after.
- **Steps:**
  1. Restart Claude Desktop (picks up `set_preset_name`; 9 tools now).
  2. Build a preset on **Z04** via `apply_preset`.
  3. Ask Claude *"rename Z04 to <something distinctive>"*.
  4. On the AM4 hardware unit, navigate away from Z04 (load A01), then
     navigate back to Z04.
- **Report which outcome you see:**
  - Name changed on display immediately and **persists** through
    navigation → rename is atomic. Best case.
  - Name changed on display but **reverts** after navigation → rename
    only writes the working buffer; we add a combined `save_preset`
    tool that does `save_to_slot` + `set_preset_name` in one call.
  - Name didn't change at all → we missed a pidHigh / payload
    convention; re-examine the capture.

### HW-003 — Round-trip a built preset via Z04 (save + reload) 🔜

- **For:** Phase 1 wrap — confirms `save_to_slot` actually persists
- **Why:** save-ack shape was not decoded (Session 19f), so a hardware
  reload is the only way to verify the save actually landed.
- **Steps:**
  1. Restart Claude Desktop (picks up `save_to_slot`; 8 tools).
  2. Ask Claude *"build a clean preset with compressor, amp, delay,
     reverb"* (or similar).
  3. Ask *"save this to Z04"*. Tool should wire-ack.
  4. On the AM4: navigate to **A01**, then back to **Z04**. Saved
     layout + params should reappear.
  5. Negative test: *"save this to A05"* → expect clean rejection
     ("hard-gated to Z04 per CLAUDE.md write-safety rules").
- **If the save doesn't persist:** paste back the inbound-SysEx log
  from the tool response. We'll diff it against AM4-Edit's save
  traffic in `session-18-save-preset-z04.pcapng`.

### HW-004 — Capture scene renames for scenes 2, 3, 4 🔜

- **For:** BK-011 (scene naming completion)
- **Why:** scene 1 rename was captured (pidHigh=`0x0037`), Session 19g
  extrapolated the per-scene mapping but hasn't verified scenes 2–4.
  Three captures settle the scene-index → pidHigh map.
- **Steps:**
  1. USBPcap on AM4.
  2. In AM4-Edit, rename **scene 2** to a distinctive string. Save as
     `samples/captured/session-22-rename-scene-2.pcapng`.
  3. Rename **scene 3** → `session-22-rename-scene-3.pcapng`.
  4. Rename **scene 4** → `session-22-rename-scene-4.pcapng`.
- **Expected:** same envelope / action / payload shape as scene 1's
  rename capture, with a different pidHigh per scene. Report the three
  new pidHighs (or confirm no pattern).

### HW-005 — Re-capture AM4-Edit switching presets (UI-initiated) 🔜

- **For:** Phase 1 wrap — preset-switch decode (currently inconclusive,
  STATE.md "deferred")
- **Why:** `session-18-switch-preset.pcapng` shows heavy read-poll
  traffic but no clean outgoing switch command — the last switch was
  likely hardware-initiated on the device, not sent from AM4-Edit. A
  clean UI-initiated capture isolates the command.
- **Steps:**
  1. USBPcap on AM4.
  2. In AM4-Edit, click **explicitly** on a different preset in the
     preset list (e.g. A01 → A02) using the editor UI (not the AM4
     hardware buttons).
  3. Wait ~1 s, click back (A02 → A01).
  4. Save as `samples/captured/session-22-switch-preset-via-ui.pcapng`.
- **Expected:** 1–2 clean outgoing writes distinct from the polling
  noise. Report the isolated frames (`parse-capture` handles the
  separation).

---

## Queued next — Axe-Fx II XL+ (BK-014)

**Not active.** Hardware focus shifts here once the AM4 active queue
(HW-001..HW-005) clears. Axe-Fx II uses a different SysEx family from
AM4 (model ID `0x03` vs `0x15`, different parameter-ID space, different
preset binary layout — see BK-014 for the architectural implications).
The methodology is identical to AM4's capture-based RE: **Axe-Edit III**
(the editor for Axe-Fx II, despite the name) is clicked, USBPcap
captures the USB traffic, and we decode.

Specific hardware tasks (HW-010 firmware-version handshake, HW-011
capture campaign) will be added here when BK-014 activates — deliberately
not pre-populated because the exact first captures depend on what
`fractal-protocol-core` looks like after the BK-012 package split.

---

## Research-only / deferred (other owned gear)

Non-Fractal captures are **not active**. Listed so they're discoverable,
not confused with the active queue.

### HW-020 — SPD-SX flash-drive format feasibility probe 🔜 (research)

- **For:** BK-019 feasibility probe — decides between flash-drive
  file-format RE vs Wave Manager USB RE
- **Why:** if `SAVE (USB MEM) → ALL` produces a plaintext-ish folder
  structure, BK-019's chosen compromise is viable and the WAV-
  management feature is tractable. If the format is encrypted or
  heavily obfuscated, we drop the feature or escalate to Wave Manager
  USB RE.
- **Steps:**
  1. Insert a freshly-formatted FAT32 USB flash drive into the SPD-SX
     rear **USB MEMORY** port (not the COMPUTER port).
  2. On the SPD-SX: `MENU → UTILITY → SAVE (USB MEM) → ALL`. Confirm.
  3. Eject the drive, connect to Windows, copy the entire drive
     contents to `samples/captured/spdsx-reference-dump/`.
  4. Signal "HW-020 done". Claude hex-dumps the structure and reports
     whether the format is tractable.
- **Priority:** low — research-only, behind AM4 + Axe-Fx II. Do when
  the active queue is clear.

### RC-505 MKII / VE-500 / JD-Xi

**No hardware tasks queued.** These devices have publicly-documented
MIDI Implementation PDFs (present in `docs/manuals/other-gear/` for
JD-Xi and VE-500). Initial scope doesn't require capture-based RE —
just reading the docs. Hardware tasks for these will be queued when
BK-017 / BK-018 / BK-020 activate, which is after the Fractal line
wraps.

---

## How this file stays honest

- Claude Code **adds** a new HW-NNN entry whenever it identifies a
  hardware action it can't perform itself. Detailed enough that the
  founder can do it without re-reading the backlog.
- Founder signals completion with "HW-NNN done" + the saved path or
  observed behavior.
- Claude moves the item to ⏳ (done, awaiting decode) or ✅ (complete)
  and updates any referenced backlog item.
- Entries stay in the file until the next archive sweep — not deleted
  on completion, so the founder has a record of what was done.
