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
> Last updated: 2026-04-19

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
  Worth adding a golden and tightening the ack predicate for rename
  in a follow-up session; HW-002b below validates the save-after-
  rename flow before we invest in a more specific `isRenameAck`.
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
  - Ready to back a dedicated `isCommandAck(sent, resp)` predicate
    so `sendAndCapture` can report structured status ("acked" /
    "no response" / "unexpected inbound") instead of dumping raw
    hex to the caller.
- **Next step:** ship the structured ack path + a composite
  `save_preset(location, name)` tool that fires both commands
  internally — removes the two-round-trip overhead from Claude's
  side. Tracked in this session's follow-ups.

- **Original test plan** (kept for audit trail):
- **For:** HW-002 follow-up; decides whether P1-008's save path needs
  a separate "save with name" variant or whether a plain
  `save_to_location` captures whatever's in the working buffer
  (including the renamed preset title).
- **Why:** HW-002 proved rename alone is working-buffer-only. Before
  we build a combined `save_preset(location, name)` convenience tool,
  we need to know whether the natural two-call sequence (rename
  first, save second) already works. If it does, the convenience tool
  is pure DX sugar. If it doesn't, `save_to_location`'s payload
  doesn't carry the working-buffer name and a real protocol change
  is needed.
- **Steps:**
  1. Restart Claude Desktop (picks up the ack-tracking fix shipped
     2026-04-19).
  2. Load Z04 on the AM4. Build a preset via `apply_preset` if Z04
     is empty.
  3. Ask Claude *"rename Z04 to 'HW002B-TEST'"*. Confirm the name
     shows on the display.
  4. Ask Claude *"save this preset to Z04"* (calls `save_to_location`).
  5. On the AM4 hardware: navigate away from Z04 (load A01), then
     navigate back to Z04.
- **Report which outcome you see:**
  - Name `HW002B-TEST` persists through the navigation → `save_to_
    location` captures the working-buffer name. Add a convenience
    `save_preset(location, name)` tool that does both in order;
    close BK-011 naming.
  - Name reverts to whatever was stored pre-rename → `save_to_
    location` doesn't carry the name. Need to decode a distinct
    "save with name" command or find a payload flag we're missing
    in the save command. Capture an AM4-Edit "save-as-named"
    interaction and diff against `session-18-save-preset-z04.pcapng`.
  - Anything weirder (name partially persists, blocks lost, etc.) →
    paste the tool-response `diagnostic_inbound_sysex` from both
    calls; we'll decode from there.

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
  tool (ship-now item #4) would have collapsed this to one call
  and avoided the redundant first save. Justifies prioritizing #4
  above pure description polish.

### HW-004 — Capture scene renames for scenes 2, 3, 4 ✅

- **Captured 2026-04-18:**
  - `samples/captured/session-22-rename-scene-2.pcapng` (name "clean")
  - `samples/captured/session-22-rename-scene-3.pcapng` (name "chorus")
  - `samples/captured/session-22-rename-scene-4.pcapng` (name "lead")
- **Decoded Session 21:** pidHigh linear pattern
  `0x0037 + sceneIndex` (scenes 1..4 → 0x37/0x38/0x39/0x3A). Payload
  identical to preset rename except bytes 0..3 are zeroed (working-buffer
  scope). `buildSetSceneName` + `set_scene_name` MCP tool landed.
  Closes BK-011 decode. Scene 1 name still uses Session 19g capture.
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

### HW-005 — Re-capture AM4-Edit switching presets (UI-initiated) ✅

- **Captured 2026-04-18:** `samples/captured/session-22-switch-preset-via-ui.pcapng`
- **Decoded Session 21:** preset switch is a `SET_FLOAT_PARAM` at
  `pidLow=0x00CE / pidHigh=0x000A`, value = preset location index as
  **float32** (NOT u32 — differs from scene-switch and save-to-slot
  which use u32). User's A01→A02→A01 click sequence captured as
  float 1.0 and float 0.0. `buildSwitchPreset` + `switch_preset` MCP
  tool landed.
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
  queued as **BK-025**; cracking it would let us read back scene
  state without needing the opaque READ response shape (still
  deferred since Session 18).

### HW-007 — Hardware-test `switch_preset` ✅

- **Tested 2026-04-19.** All four targeted locations (A01 / B03 / M02
  / Z04) loaded correctly on the AM4 display. Float32 encoding handles
  the full 0..103 index range with no edge-case issues.
- **New decode lead — preset-switch ack carries preset state.** 64-byte
  write-echo payload varies per preset, with bytes 15–17 encoding the
  location index (`00 00 00` / `03 00` / `18 40` / `33 40` for
  A01/B03/M02/Z04) and a richer payload region (18–28) than scene
  switches. Sparse presets (A01 / Z04 "Clean Machine") carry mostly
  zeros; mid-bank factory presets (M02) have richer bytes
  (`12 25 73 1F`, etc.). Likely encodes block layout + active scene
  + some param snapshot. Decode queued as **BK-026**; same
  motivation as BK-025 — a protocol read-back path that doesn't
  depend on the unsolved READ response format.
- **CRITICAL new protocol finding — param writes are scene-scoped.**
  During the destructive-test phase the user (on scene 2) called
  `set_param amp.gain 3.00` and the write produced a normal wire-ack
  but **no audible change**. Same user (now on scene 1) repeated
  the identical write and the gain did change. The two wire
  exchanges were **byte-identical** — same sent bytes, same 64-byte
  ack. Implications:
  1. The AM4 accepts and acks every SET_PARAM write regardless of
     scene, but only applies it to the currently-active scene's
     context. Non-active scenes silently retain their prior value.
  2. `isWriteEcho` matching is **not** a "param landed" confirmation
     when the user isn't on scene 1 — it's just "message was
     parsed." This is distinct from the absorb/apply problem
     (BK-008, block-not-placed) — it's a third failure mode.
  3. Every `set_param` / `set_params` / `apply_preset` call should
     either know the current scene, warn when not on scene 1, or
     accept a `scene_index` param that auto-switches first. Tool-
     level UX decision needed before release.
  4. Re-examining the ack: same bytes for scene 2 (no-op) and scene
     1 (applied) means the ack payload does **not** carry the
     applied value, so we can't use it to detect which scene's
     context received the write. We'd need a switch_scene +
     re-read flow, or to decode the scene-state bytes in the
     switch_scene ack (BK-025) to confirm per-scene values.
- **Follow-up queued: HW-009** below — a dedicated capture sweep that
  confirms the scene-scoped-write finding with paired writes on
  multiple scenes, to rule out the alternative hypothesis ("it was
  actually the scene change that reset the block, not the write
  that was ignored"). Until verified, treat this as **strongly
  suspected, not confirmed**.

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
- **Re-interpreting HW-007.** The original "no audible change on
  scene 2" observation was probably NOT a silent write — the write
  went to the active channel fine, but scene 2 may have had the
  amp block bypassed, masking the audible effect. Without a
  rigorous bypass/channel check during HW-007 we can't prove
  that for certain, but the channel-scoped model is consistent
  with all HW-009 observations and with Fractal's documented scene
  semantics. Safe to drop the scene-scoped-write theory.
- **Release-critical UX implication.** Every param-writing tool
  (`set_param`, `set_params`, `apply_preset`) writes to "whichever
  channel is active right now" — a moving target. Without channel
  awareness, a user asking Claude to tweak a tone can inadvertently
  modify channel A across multiple scenes. Tool-UX redesign
  tracked in **P1-012 Channel-aware param writes** (see backlog).
- **Kept for reference — retained test steps:**

- **For:** confirming the HW-007 observation that `set_param` writes
  apply only to the active scene's context. If true, every param-
  writing tool needs scene awareness — see P1-011 below for the UX
  implications.
- **Why:** HW-007's single-sequence observation could have an
  alternative explanation (e.g. switching scenes reset the block
  because scene 2 had the amp bypassed; scene 1 didn't). A paired
  capture sequence disambiguates.
- **Steps:**
  1. Load Z04 ("Clean Machine" from HW-003) on the AM4 hardware.
  2. Switch to scene 2. Note the amp.gain value on the display.
  3. Ask Claude *"set amp.gain to 8"*. Record the ack hex and
     whether the display updated.
  4. Switch to scene 1 **without restarting the conversation**.
     Observe the amp.gain value on the display — is it the original
     Z04 gain, or does scene 1 carry its own value?
  5. Repeat step 3 on scene 1 (set gain to 8). Record whether the
     display updates.
  6. Switch back to scene 2. Observe amp.gain — is it still the
     original Z04 value, or did scene 2 inherit the scene-1 write?
- **Outcomes:**
  - Scene 2's display didn't change from the write, scene 1's did,
    and scene 2 still shows its original value after the round-trip
    → **scene-scoped writes confirmed**. Every `set_param` needs
    scene awareness. P1-011 becomes a release blocker.
  - Scene 2's display DID change but we misread it earlier → revert
    HW-007's note, write applies globally.
  - Something weirder (e.g. the write applies to both scenes after
    a switch) → paste the full sequence of tool-response hex and
    we'll decode.

### HW-012 — Round-trip `apply_preset` with the new per-slot `channels` shape 🔜

- **For:** BK-027 phase 1 (Session 24). The new shape produces the same
  primitive writes (channel-switch + SET_PARAM) that Session 19 already
  verified on hardware, but an end-to-end hardware test confirms the
  orchestration across channels in one call — ordering, per-channel
  param landing, and `lastKnownChannel` tracking.
- **Why this isn't automatic.** `apply_preset`'s goldens are captured
  at the protocol layer (byte-exact against known writes). The channels
  field stitches several such writes together; stitching-layer bugs
  (wrong letter mapping, missing channel switch before params, param
  order mismatch) won't fail the goldens. One hardware session
  confirms the orchestration.
- **Steps:**
  1. Restart Claude Desktop (picks up the extended `apply_preset`
     schema — no new tool count, same 15 tools).
  2. Load Z04 on the AM4. Navigate to clear / known state.
  3. Ask Claude *"build me a preset with amp on slot 1: channel A at
     gain 3 using Deluxe Verb Normal, and channel D at gain 8 using
     1959SLP Normal. Reverb on slot 2 with mix 30 on channel A."*
  4. Observe a **single** `apply_preset` call (not a sequence). Verify
     on the AM4:
     - Slot 1 shows amp, slot 2 shows reverb.
     - Switching the AM4's Amp channel knob between A and D shows the
       two distinct amp types + gains.
     - Reverb mix 30 on whichever channel is active.
  5. Optional: ask *"now switch the amp to channel A"* (or use the
     hardware knob) and verify gain 3 is there; then channel D and
     verify gain 8.
- **Expected outcome:** preset plays correctly with per-channel
  tonality, zero follow-up tool calls needed after the initial
  `apply_preset`. If the channel walk misbehaves (e.g. channel D
  receives channel A's values), capture the tool response text and
  compare the prepared-writes ✓/? lines against the user's intent.
- **Not a blocker for release:** this is validation of a
  convenience-layer change, not a protocol decode. The shape can
  safely ship pre-test since the underlying writes are all
  previously-verified primitives.

### HW-011 — Capture scene→channel and scene→bypass assignments (BK-010 + BK-027) 🔜

- **For:** the two remaining undecoded scene-level writes — (a) "scene N
  points Amp at channel X" and (b) "scene N bypasses block Y." Once
  decoded, BK-027's kitchen-sink `apply_preset` can finish the full
  preset model end-to-end (including the multi-scene / multi-channel
  example in the session 22 conversation).
- **Why this is the critical gap.** The tools today can build block
  layout (`apply_preset`), fill channel values (`set_params` with per-
  write channel), switch scenes, and rename scenes. What they *cannot*
  do: tell a scene which channel each block should use, or which blocks
  to bypass on that scene. Without those writes, a preset's four scenes
  all inherit whatever defaults the preset was initialized with —
  usually all-channel-A, no bypass — so the per-channel tone variations
  you went to the trouble of configuring never actually play.

- **Steps (two captures in one session):**
  1. **Scene-channel capture.** Load Z04 on the AM4. Open AM4-Edit's
     scene editor. Pick scene 2 and change its Amp-block channel from
     **A** to **B** (via whatever UI the editor exposes — dropdown or
     per-scene channel selector). Save as
     `samples/captured/session-23-scene-2-amp-channel-b.pcapng`.
  2. Repeat for scene 3 Amp → C, scene 4 Amp → D (three captures total
     — scenes 2/3/4, each with a distinct non-default channel). Save
     as `session-23-scene-{3,4}-amp-channel-{c,d}.pcapng`.
  3. **Scene-bypass capture.** Still on scene 2, toggle Amp's bypass
     from active → bypassed. Save as
     `samples/captured/session-23-scene-2-amp-bypass.pcapng`.
  4. Repeat for Drive (scene 3 drive bypass) and Reverb (scene 4
     reverb bypass) — 3 bypass captures so we can confirm the command
     generalizes across blocks.
- **Expected decode output:**
  - Scene-channel write: most likely `SET_FLOAT_PARAM` at
    `pidLow=0x00CE` with a `pidHigh` that encodes (scene index,
    block slot). Byte-exact goldens per capture. `buildSetSceneChannel
    (sceneIndex, block, channelIndex)` in `src/protocol/setParam.ts`.
  - Scene-bypass write: similar shape, different action/pidHigh. May
    turn out to be the same register as scene-channel with a bit flag
    difference. `buildSetSceneBypass(sceneIndex, block, bypassed)`.
- **Also captured for free during this session:** the 64-byte
  write-echo payload for each change, which feeds **BK-025**
  (scene-state read-back) by giving us known-ground-truth scene
  states to diff against.
- **Scope:** AM4 only (Axe-Fx II / other gear protocols handled
  separately). Session completes in one hardware pass — ~15 min of
  clicking + capture.

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
