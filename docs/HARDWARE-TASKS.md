# Hardware Tasks Queue

> Physical actions the founder needs to perform at the device (USB
> captures, round-trip tests, reference dumps). Claude Code appends to
> this file when hardware work is required and cannot perform it alone.
> Check this file at the start of each session.
>
> **Active focus:** AM4, Axe-Fx II XL+, and ASM Hydrasynth Explorer
> (founder-owned, Wave 1 RE). Device priority order for Wave 1:
> **AM4 → Axe-Fx II → Hydrasynth Explorer**. Hydrasynth needs
> minimal hardware-RE work — its MIDI CC chart is fully published
> (manual pp. 94–96) so most validation is "does the CC land on the
> expected engine parameter" rather than capture-based decode. See
> BK-031 in 04-BACKLOG.md for the Hydrasynth support plan.
>
> Other owned gear (RC-505 MKII, VE-500, SPD-SX) is **research-only
> for now** — no active hardware tasks queued until the Wave 1 devices
> are cleared. The JD-Xi (BK-020) has been demoted from the founder's
> collection (replaced by the Hydrasynth Explorer) and is now a
> community-support item with no founder-hardware validation.
>
> Last updated: 2026-04-21 (Session 28 — BK-027 phase 2 orchestration
> shipped; HW-013 queued for a round-trip round-trip of the `scenes[]`
> path on the device.)

## Status key

- 🔜 **Pending** — awaiting founder action
- ⏳ **Done, awaiting decode** — capture / test complete, Claude to process
- ✅ **Complete** — decoded / integrated / archived (see bottom of file)

## Done signal

When you finish an item, say **"HW-NNN done"** in chat. Include the saved
path (if a capture) or the observed behavior (if a round-trip test).
Claude picks up from there and moves the item to ⏳ or ✅.

---

## Pending — next up

### HW-013 — Round-trip `apply_preset` with `scenes[]` 🔜

- **For:** BK-027 phase 2 hardware verification (Session 28 shipped
  the orchestrator but the end-to-end scene-switch + scene-channel +
  scene-bypass + scene-name sequence has only been wire-verified via
  the individual primitives — HW-011 captures + the HW-012 phase 1
  round-trip). This is the first full-stack exercise of the new
  `scenes[]` path.
- **Why:** catches ordering, ack-shape, and response-text honesty
  bugs that static tests can't. Specifically confirms that (a) the
  AM4 ends up on the last-configured scene, (b) each scene's
  channel-pointer writes stick across the scene-switch boundary,
  (c) bypass state is preserved per-scene, (d) the response text's
  "active scene after this call: N" claim matches the device's
  display.
- **Steps:**
  1. Ensure `Z04` is free (or acceptable to overwrite). In Claude
     Desktop with the connector attached, ask Claude to build a
     4-scene preset, e.g.:
     > "Build me a 4-scene preset on Z04 called 'scene test': amp
     > (with channel A tuned clean: gain 3, channel D tuned lead:
     > gain 8), reverb mix 30 on channel A. Scene 1 'clean' uses
     > amp channel A with reverb active. Scene 2 'crunch' uses amp
     > channel D with reverb bypassed. Scene 3 'lead' uses amp
     > channel D with reverb active. Scene 4 'ambient' uses amp
     > channel A with reverb active. Do not save."
  2. Confirm on the device: the AM4 should be on scene 4 when the
     call returns (last configured). Check the display shows the
     correct scene name.
  3. Cycle through scenes 1 → 2 → 3 → 4 on the device (or via
     `switch_scene`) and audibly verify: scene 1 is clean + wet,
     scene 2 is lead + dry (reverb bypassed), scene 3 is lead + wet,
     scene 4 is clean + wet.
  4. Ask Claude to rename scene 4 to "verify4" via a separate
     `set_scene_name` call, then switch back to scene 1 and to
     scene 4, and confirm the name persists in-session.
  5. Signal "HW-013 done" with observed behavior. If anything
     differs from the narrative above, quote the `apply_preset`
     response text exactly so the discrepancy can be traced.
- **Priority:** high — release-gate for BK-027. No new primitives
  are expected; this is end-to-end verification. Failure here points
  at ordering / stateful-scoping bugs in the tool layer that static
  tests miss.

---

## Queued next — Axe-Fx II XL+ (BK-014)

**Not active.** Gated on: the remaining AM4 pending items above
clearing, plus the AM4 depth quality-gate (see memory
`feedback_am4_depth_gates_wave_expansion.md` — P1-010 bulk param
coverage, P1-012 channel-aware writes, P1-008 factory-preset safety).
Axe-Fx II uses a different SysEx family from AM4 (model ID `0x03` vs
`0x15`, different parameter-ID space, different preset binary layout
— see BK-014 for the architectural implications). The methodology is
identical to AM4's capture-based RE: **Axe-Edit III** (the editor for
Axe-Fx II, despite the name) is clicked, USBPcap captures the USB
traffic, and we decode.

Specific hardware tasks (firmware-version handshake, capture campaign)
will be added here when BK-014 activates — deliberately not pre-populated
because the exact first captures depend on what `fractal-protocol-core`
looks like after the BK-012 package split.

---

## Queued next — Hydrasynth Explorer (BK-031)

**Not active.** Gated on the AM4 depth quality-gate AND the BK-014
Axe-Fx II slot (per founder-stated priority: AM4 → Axe-Fx II →
Hydrasynth). Once BK-031 activates, the first hardware tasks will be
**CC-mapping validation** (does CC N on channel M land on the expected
engine parameter per manual pp. 94–96?) rather than capture-based
decode — the Hydrasynth's MIDI is fully documented, unlike Fractal's
RE-required protocol. Estimated hardware time: one founder session
spot-checking 5–10 CCs per module.

If ASM publishes or the community has reverse-engineered the SysEx
patch format later, HW entries for patch-dump / patch-upload captures
would land here.

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
- **Priority:** low — research-only, behind AM4 + Axe-Fx II +
  Hydrasynth. Do when the active queue is clear.

### RC-505 MKII / VE-500

**No hardware tasks queued.** These devices have publicly-documented
MIDI Implementation PDFs (VE-500's is present in
`docs/manuals/other-gear/`). Initial scope doesn't require capture-based
RE — just reading the docs. Hardware tasks for these will be queued when
BK-017 / BK-018 activate, which is after the Wave 1 line wraps.

### JD-Xi (BK-020) — community-support item, no founder hardware

The founder previously owned a JD-Xi but is replacing it with the
Hydrasynth Explorer. BK-020 stays on the backlog as a community-support
target (Roland published its MIDI Implementation, so decoding doesn't
need founder hardware), but no HW-NNN tasks will be queued here —
validation would need a community contributor with the device.

---

## Archive — completed

Kept for audit-trail (decoded findings live inline with the original
task). Ordered by HW-NNN ascending; most recent completions have the
highest numbers.

### HW-001 — Capture scenes 1/3/4 switches ✅

- **Captured 2026-04-18:** `samples/captured/session-21-switch-scene-1-3-4.pcapng`
- **Decoded Session 21:** confirmed `value = scene index 0..3` (u32 LE),
  pidHigh fixed at `0x000D`. Byte-exact goldens for all 4 scenes in
  `verify-msg`. `buildSwitchScene` unchanged; `switch_scene` MCP tool
  registered.
- **For:** confirms scene-switch decode (STATE.md "single next action";
  Session 20 tentative)
- **Why:** Session 20 captured only the switch *to* scene 2 and
  tentatively decoded it as "value = scene index" at
  `pidLow=0x00CE / pidHigh=0x000D / action=0x0001`. Capturing scenes 1,
  3, 4 decides between "value = scene index" (current hypothesis) and
  "pidHigh changes per scene."

### HW-002 — Test `set_preset_name` persistence on Z04 ✅

- **Tested 2026-04-19** (after ack-tracking fix; see below).
- **Outcome #2 confirmed: rename writes the working buffer only.** The
  new name appeared on the display immediately but was gone after
  navigating away and back. `set_preset_name` on its own is not a
  persistent rename — a subsequent `save_to_location` is required.
- **Side finding — rename ack shape decoded (Session 22).** The
  successful rename produced an 18-byte inbound echo:
  `F0 00 01 74 15 01 4E 01 0B 00 0C 00 00 00 00 00 59 F7`.
  Envelope + function `0x01` + pidLow `0x00CE` + pidHigh `0x000B` +
  action `0x000C` + 4-byte zero payload + checksum. Same addressing
  as the outgoing command; 4-byte zero payload is the success signal.
- **Side finding — ack-tracking bug discovered and fixed.** The
  first three rename attempts during this test hit a dead MIDI
  transport and returned zero inbound SysEx. Auto-reconnect never
  fired because `set_preset_name` and `save_to_location` didn't
  register their ack-less outcomes with `recordAckOutcome` and their
  response text didn't hint at `reconnect_midi`. Fixed by factoring
  all five capture-window tools (save, rename preset, rename scene,
  switch preset, switch scene) through a shared `sendAndCapture`
  helper; ack outcomes now count against the stale-handle threshold
  uniformly and every ack-less response surfaces the reconnect
  escape hatch. Preflight green.

### HW-002b — Verify `save_to_location` after `set_preset_name` persists the rename ✅

- **Tested 2026-04-19.** Name "rename-save-test" set via
  `set_preset_name Z04`, then `save_to_location Z04` called
  immediately after. Navigated A01 → Z04 on the AM4; the new name
  was still showing. Two-step `rename → save` is the canonical flow
  for persisting named presets.
- **Confirmed command-ack shape (both save and rename).** 18 bytes,
  identical structure across both tools:
  ```
  F0 00 01 74 15 01 <pidLow septets> <pidHigh septets>
  <action septets> 00 00 00 00 <checksum> F7
  ```
  - Rename ack: `F0 00 01 74 15 01 4E 01 0B 00 0C 00 00 00 00 00 59 F7`
  - Save ack:   `F0 00 01 74 15 01 00 00 00 00 1B 00 00 00 00 00 0A F7`
  - Addressing bytes (pidLow / pidHigh / action) echo the outgoing
    command verbatim. Payload field (4 bytes) is zero = success.
    Differs from SET_PARAM's 64-byte / 40-byte-payload echo — a
    distinct "command ack" shape for addressing-only commands.
  - Backed by a dedicated `isCommandAck(sent, resp)` predicate so
    `sendAndCapture` reports structured status ("acked" / "no
    response" / "unexpected inbound").

### HW-003 — Round-trip a built preset via Z04 (save + reload) ✅

- **Tested 2026-04-19.** `apply_preset` built a 4-block chain
  (Optical Compressor → Deluxe Verb Normal amp → Analog Stereo
  Delay → Deluxe Spring reverb, 13 writes). `save_to_location Z04`
  acked. Preset named "Clean Machine" via `set_preset_name` + a
  follow-up `save_to_location`. Negative test (save to `A05`) was
  cleanly rejected with the Z04-gated error — user-facing copy
  matches the backlog reference.
- **Three-call dance observed.** Claude-Desktop-side did
  `save_to_location` → `set_preset_name` → `save_to_location`
  again, because it realized after the rename that names are
  working-buffer-only. The composite `save_preset(location, name)`
  tool shipped Session 22 and collapses this to one call.

### HW-004 — Capture scene renames for scenes 2, 3, 4 ✅

- **Captured 2026-04-18:**
  - `samples/captured/session-22-rename-scene-2.pcapng` (name "clean")
  - `samples/captured/session-22-rename-scene-3.pcapng` (name "chorus")
  - `samples/captured/session-22-rename-scene-4.pcapng` (name "lead")
- **Decoded Session 21:** pidHigh linear pattern
  `0x0037 + sceneIndex` (scenes 1..4 → 0x37/0x38/0x39/0x3A). Payload
  identical to preset rename except bytes 0..3 are zeroed (working-buffer
  scope). `buildSetSceneName` + `set_scene_name` MCP tool landed.

### HW-005 — Re-capture AM4-Edit switching presets (UI-initiated) ✅

- **Captured 2026-04-18:** `samples/captured/session-22-switch-preset-via-ui.pcapng`
- **Decoded Session 21:** preset switch is a `SET_FLOAT_PARAM` at
  `pidLow=0x00CE / pidHigh=0x000A`, value = preset location index as
  **float32** (NOT u32 — differs from scene-switch and save-to-slot
  which use u32). User's A01→A02→A01 click sequence captured as
  float 1.0 and float 0.0. `buildSwitchPreset` + `switch_preset` MCP
  tool landed.

### HW-006 — Hardware-test `switch_scene` ✅

- **Tested 2026-04-19.** All four scene switches (2→3→4→1) visible on
  the AM4 display.
- **New decode lead — scene-switch ack carries per-scene state.** Each
  switch returned the full 64-byte write-echo (hdr4=0x0028, 40-byte
  payload) which differs between scenes in a structured way:
  ```
  Scene 1:  …00 00 00 00 00 00 00 00 00 0C 00 00 00 00 00…  (baseline)
  Scene 2:  …00 40 00 00 00 05 2E 55 2A 1F 0C 20 00 00 00…
  Scene 3:  …01 00 00 00 00 05 2E 54 2A 1F 4C 40 00 00 00…
  Scene 4:  …01 40 00 00 00 00 00 01 00 1F 4C 60 00 00 00…
  ```
  Bytes 15–17 encode the scene index (Fractal's septet packing,
  0 / 0x80 / 0x100 / 0x180 → `00 00`, `00 40`, `01 00`, `01 40`).
  Byte 24 is `0x1F` for scenes 2–4 (block-placement bitmask? 4 blocks
  placed = 0b11111 = 0x1F across 5 bits). Bytes 20–23 and 25–26 vary
  per scene — probably per-block bypass/channel state. Decode
  queued as **BK-025**.

### HW-007 — Hardware-test `switch_preset` ✅

- **Tested 2026-04-19.** All four targeted locations (A01 / B03 / M02
  / Z04) loaded correctly on the AM4 display. Float32 encoding handles
  the full 0..103 index range with no edge-case issues.
- **New decode lead — preset-switch ack carries preset state.** 64-byte
  write-echo payload varies per preset, with bytes 15–17 encoding the
  location index (`00 00 00` / `03 00` / `18 40` / `33 40` for
  A01/B03/M02/Z04) and a richer payload region (18–28) than scene
  switches. Decode queued as **BK-026**.
- **Initial scene-scoped-write hypothesis (disproven by HW-009).** During
  destructive testing the user observed an amp.gain write that didn't
  change tone on scene 2, then did on scene 1. HW-009 re-ran the test
  rigorously and showed the correct model is **channel-scoped writes**,
  not scene-scoped — see HW-009's decoded finding.

### HW-008 — Hardware-test `set_scene_name` persistence ✅

- **Tested 2026-04-19.** Renamed scenes 2/3/4 to "verse"/"chorus"/
  "solo" (scene 1 left at default), then `save_to_location Z04`.
  Names persisted across preset switch. **Naming stack complete:**
  set_preset_name + set_scene_name + save_to_location is the
  canonical sequence for a fully-named persisted preset. BK-011
  closed.

### HW-009 — Verify the scene-scoped param write finding (HW-007 follow-up) ✅

- **Tested 2026-04-19 — original hypothesis DISPROVEN; true finding
  is channel-scoped writes.**
- **Sequence A (on scene 2):** `set_param amp.gain 8` → amp.gain
  became 8 on scene 2. Switched to scene 1 — **scene 1 also showed
  amp.gain=8**.
- **Sequence B (on scene 1):** `set_param amp.gain 5` → amp.gain
  became 5 on scene 1. Switched to scene 2 — **scene 2 also showed
  amp.gain=5**.
- **Interpretation (matches Fractal's model).** Param writes target
  the **channel** (A/B/C/D) that's active for that block right now,
  not the scene. Scenes are selectors — they choose which channel
  each block uses + per-block bypass state, but they don't store
  param values themselves. When two scenes reference the same
  channel, a write on one scene is visible on the other because
  both are looking at the same channel's data.
- **Release-critical UX implication.** Every param-writing tool
  (`set_param`, `set_params`, `apply_preset`) writes to "whichever
  channel is active right now" — a moving target. Without channel
  awareness, a user asking Claude to tweak a tone can inadvertently
  modify channel A across multiple scenes. Tool-UX redesign
  tracked in **P1-012 Channel-aware param writes** (see backlog).

### HW-011 — Capture scene→channel and scene→bypass assignments ✅

- **Captured 2026-04-21** — 6 pcapngs in `samples/captured/`:
  `session-23-scene-{2,3,4}-amp-channel-{b,c,d}.pcapng` and
  `session-23-scene-{2,3,4}-{amp,drive,reverb}-bypass.pcapng`.
  Founder added a 7th capture (`session-23-scene-2-amp-unbypass.pcapng`)
  mid-decode to give verify-msg symmetric goldens for bypass-OFF.
- **Decoded Session 27 — hypothesis was wrong, simpler than expected.**
  - **Scene→channel**: no new primitive. It's the existing channel-
    switch at `pidHigh=0x07D2` (decoded Session 08), value =
    float(channel index). The AM4 is stateful and scopes the write
    to whichever scene is active. Same rule as HW-009's channel-
    scoped param writes.
  - **Scene→bypass**: new decode. SET_PARAM at the block's own
    pidLow, `pidHigh=0x0003`, value = float32(1.0) to bypass /
    float32(0.0) to activate. Shared across amp / drive / reverb
    — same register for every bypass-capable block. No scene index
    on the wire; also self-scopes to the active scene.
  - New primitive `buildSetBlockBypass(blockPidLow, bypassed)` and
    MCP tool `set_block_bypass` shipped. Byte-exact goldens for 4
    states (amp/drive/reverb bypass-ON + amp bypass-OFF) in
    `verify-msg`. SYSEX-MAP.md §6h has the full decode. Tool count
    16 → 17.
  - **Bonus AM4-Edit observation** — the `action=0x0017,
    pidHigh=0x3E81` housekeeping pattern (2 reads before, 2 reads
    after every real WRITE) now confirmed across bypass captures
    too, not just block-placement. Still not required to emit.
- BK-010 closed as a result; BK-027 phase 2 is unblocked.

### HW-012 — Round-trip `apply_preset` with the per-slot `channels` shape ✅

- **Tested 2026-04-21** — 12-write `apply_preset` round-trip landed
  clean on hardware. Block layout + per-channel amp values
  (channel A: Deluxe Verb Normal / gain 3; channel D: 1959SLP
  Normal / gain 8) + reverb mix 30 all confirmed on-device. Phase
  1 of BK-027 is now hardware-verified.
- **Finding 1 — Claude Desktop deferred-tool miss.** Initial user
  prompt produced a spec-only response ("I don't have the
  am4-tone-agent connected in this session") even though the
  connector was attached. User had to nudge ("i see the connector")
  before Claude loaded the tool schemas and executed. Root cause is
  Claude Desktop's deferred tool-schema loading combined with a
  Claude.ai Project system prompt biased toward spec output. Fix
  queued as **P5-011** (MCP tool-description audit) — the lever on
  Claude Desktop behavior is the tool descriptions themselves, since
  Desktop has no user-configurable system prompt.
- **Finding 2 — `apply_preset` response text overstates scene
  semantics.** Response narrated "strum channel A for the clean
  tone, then flip to channel D" but scene 1 was actually on channel
  D (the last channel the A→B→C→D walk wrote to). Until scene→channel
  writes compose into `apply_preset` (BK-027 phase 2), all scenes
  inherit the end-of-walk channel. Response-text honesty fix lands
  alongside phase 2.

---

## How this file stays honest

- Claude Code **adds** a new HW-NNN entry under "Pending — next up"
  whenever it identifies a hardware action it can't perform itself.
  Detailed enough that the founder can do it without re-reading the
  backlog.
- Founder signals completion with "HW-NNN done" + the saved path or
  observed behavior.
- Claude moves the item from "Pending — next up" to "Archive —
  completed" once the follow-up decode / integration work lands, and
  updates any referenced backlog item.
- Archive items are tightened to their decoded findings; the verbose
  original test steps are pruned when they no longer serve audit
  purposes. The full history is always recoverable from git.
