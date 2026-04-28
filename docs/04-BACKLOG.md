# Product Backlog — MCP MIDI Tools

Priority: P0 = must have for phase, P1 = should have, P2 = nice to have

---

## PHASE 0 — Feasibility

### P0-001 Install and configure node-midi on Windows
- Install node-midi npm package
- Confirm native bindings compile (node-gyp required)
- List all MIDI ports and confirm AM4 appears

### P0-002 Send mode switch SysEx to AM4
- Implement basic SysEx send via node-midi
- Send Scenes mode command: F0 00 01 74 15 12 49 4B F7
- Confirm visual change on AM4 display
- ACCEPTANCE: AM4 display changes without AM4-Edit running

### P0-003 Implement Fractal SysEx checksum function
- XOR all bytes, AND with 0x7F
- Unit test with known examples from wiki
- ACCEPTANCE: Checksums match wiki examples

### P0-004 Send firmware version request and parse response
- Send GET_FIRMWARE_VERSION (function 0x08) with checksum
- Listen for response on MIDI input
- Log raw bytes received
- ACCEPTANCE: Non-empty response received

### P0-005 Build MIDI traffic sniffer script
- Open MIDI input port and log all incoming SysEx to console
- Timestamp each message
- Format as annotated hex dump
- ACCEPTANCE: Can capture AM4-Edit traffic visibly

### P0-006 Sniffing session — document AM4-Edit protocol
- Open AM4-Edit and MIDI-OX simultaneously
- Capture: load preset, change amp gain, change delay time, save preset
- Document findings in docs/SESSIONS.md
- ACCEPTANCE: At least one parameter change captured and byte-located

### P0-007 Confirm preset read without AM4-Edit
- Identify GET_PRESET_NAME and GET_PRESET_NUMBER function IDs via sniff
- Send from Node.js, parse response
- ACCEPTANCE: Current preset name returned correctly

---

## PHASE 1 — Protocol Layer

Architecture pivot (2026-04-14): we do NOT encode preset binaries ourselves.
Instead we configure the AM4's working buffer via live commands, then issue
the device's own store command to persist. See `docs/DECISIONS.md`.

### P1-001 Document AM4 SysEx envelope structure ✅ Session 01–02
- Envelope / checksum / model ID `0x15` — confirmed.
- `buildMessage` / `fractalChecksum` live in `scripts/probe.ts` for now.
- Follow-up: promote to `src/protocol/sysex.ts` with unit tests.

### P1-002 Decode preset dump commands (0x77 / 0x78 / 0x79) ✅ Session 03
- Header / 4× chunks / footer structure documented in `SYSEX-MAP.md` §10b.
- Slot addressing (header bytes 6–7 = bank / slot-within-bank) decoded
  from the factory bank.
- Follow-up: write a `PresetDump` builder that patches slot bytes and
  recomputes the header checksum. Use factory preset extraction as source.

### P1-003 USB-capture AM4-Edit traffic — 🔜 Session 04
- Install USBPcap + Wireshark (done).
- Reboot to activate USBPcap driver (pending at time of pause).
- Capture one clean parameter change; save `.pcapng` to
  `samples/captured/session-04-gain-change.pcapng`.
- Write a Node.js pcapng parser to extract outgoing + incoming SysEx.
- ACCEPTANCE: hex dump of the SysEx AM4-Edit sent when Amp Gain changed.

### P1-004 Decode the 0x01 parameter-set command shape — blocked on P1-003
- Identify block ID / parameter ID / value encoding in the captured bytes.
- Verify by replay: first read-only observation of device display, then a
  deliberate SET to confirm round-trip.
- ACCEPTANCE: we can set Amp Gain on the AM4 from our own code and see
  the change reflected both on the device and in AM4-Edit's UI.

### P1-005 Write the "puppet" command library
- Build `src/protocol/live.ts` with: `setBlockParam`, `setBlockChannel`,
  `setBlockBypass`, `setSceneNumber`, `setTempo`, `storePresetToSlot`.
- Wrap the formats decoded in P1-004.
- Unit tests against byte fixtures captured in P1-003.

### P1-006 Build the preset-IR → command-sequence transpiler
- Given an `AM4Preset` IR (see `docs/03-ARCHITECTURE.md`), emit the list
  of live commands needed to configure the device's working buffer.
- Handle: 4 effect slots × N per-block parameters × 4 channels × 4 scenes.
- ACCEPTANCE: applying a known `AM4Preset` to slot Z04 produces audibly
  the same tone as the IR was authored to describe.

### P1-007 Extract per-block parameter ID space — dev incremental, **complete coverage before public release**
- **Dev-time (today):** for each block type on AM4, capture USB traffic
  while AM4-Edit manipulates each control. Map parameter IDs to human-
  readable names (cross-reference the Blocks Guide PDF for semantic
  labels). Register in `KNOWN_PARAMS` (`src/protocol/params.ts`),
  regenerate enums via `gen-cache-enums.ts`. This is incremental —
  during RE we only add the params a given session needs.

- **Release gate (non-negotiable before public launch; see
  LAUNCH-POST-OUTLINE.md release gate and P5-009 pre-release
  ergonomics).** Every `CONFIRMED` block in `CACHE-BLOCKS.md` must
  have its **full exposed param set** in `KNOWN_PARAMS` before the
  MCP server ships to non-developer users. Rationale: Claude Desktop
  treats `list_params` / tool descriptions as authoritative and will
  *not* invent params beyond them — **but it will happily invent
  params that *should* exist on a full-size Fractal unit** (mid,
  treble, presence, master on amp; feedback, mix on delay) when the
  registry looks sparse. A real user typing "bump the mids" to
  Claude should get a tone change, not a validation-error round-trip.

- **Coverage bar per block.** The cache (`cache-section3.json` +
  `cache-section2.json`) enumerates every param record the AM4
  firmware actually addresses per block. Before release, every
  record in a confirmed effect block must be either:
  1. Registered in `KNOWN_PARAMS` with `pidLow/pidHigh/unit/range`
     populated, name matching the AM4-Edit UI label (or the Blocks
     Guide label if UI is terse), and at least one capture-verified
     pidHigh; **or**
  2. Explicitly documented as **intentionally-excluded** (e.g. an
     internal routing flag, a modifier-only knob, a cab/mic
     selector that belongs under a separate tool surface) with a
     one-line rationale in `CACHE-DUMP.md`.
  No param record may be silently omitted — the audit is mechanical
  (every cache record maps to either a registry entry or an excluded
  row).

- **Coverage audit tool.** Add `scripts/audit-param-coverage.ts`
  that iterates `cache-section2.json` + `cache-section3.json`, joins
  against `KNOWN_PARAMS`, and prints per-block:
  `{ block, totalCacheRecords, registered, explicitlyExcluded,
  uncovered }`. Release-gate is `uncovered === 0` for every
  `CONFIRMED` block. Wire into `npm run preflight` behind a
  `PRERELEASE=1` flag so it's opt-in during dev but fails CI at
  tag time.

- **Hallucination mitigation in tool descriptions (short-term, ship
  alongside ongoing coverage work).** Add a compact "what params
  exist per block" cheat-sheet into the `apply_preset` and
  `set_param` tool descriptions, regenerated from `KNOWN_PARAMS`
  at server start so it never drifts. Format:
  `amp: gain, bass, level, channel, type | delay: time, channel,
  type | reverb: mix, channel, type | …`. Keeps the description
  under the MCP description budget while eliminating the "LLM
  assumes mid/treble/presence exist" failure mode observed in
  HW-002 testing (2026-04-18). This is a two-way win: it helps now
  (before coverage is complete, it tells Claude to stay within
  what's registered) and after release (gives Claude a scanable
  reference so it doesn't have to call `list_params` before every
  write).

- **Priority.** Coverage work runs in parallel with Phase 2/3/4;
  not a blocker for in-house iteration. Becomes a hard blocker at
  the v1.0 release tag. The cheat-sheet sub-item is short enough
  to land this cycle.

### P1-008 Factory preset safety-classification + release-time write gate
- **Baseline classification work:**
  - Compute a "factory fingerprint" for each of the 104 factory preset
    locations using the factory bank file
    (`samples/factory/AM4-Factory-Presets-1p01.syx`). Hash of the
    preset's block-layout + parameter tuple should suffice — doesn't
    need to be cryptographic, just distinguishing.
  - Store as `src/safety/factory-fingerprints.ts` (committed, generated
    once from the factory bank).
  - User-preset detection: a single metadata read per location tells
    us whether a slot is empty or populated with a user preset. Cache
    the result in memory per server session; expire on any write to
    that location. Cost: ~50 ms first-hit per location, ~0 ms after.

- **Release-time write gate (this is the user-facing UX at public
  launch; see LAUNCH-POST-OUTLINE.md release gate).** Drop Z04-only
  hard-gating — Z04 is a dev-RE convention, not a public-release
  feature. Replace with a three-tier model applied by `save_to_location`
  and `set_preset_name`:

  | Location status | Default (force=false) | force=true |
  |---|---|---|
  | Empty | Apply silently. No friction. | (same) |
  | User preset | **Refuse.** Return the current preset name in the error so Claude can prompt the user. | Apply + **auto-backup first**. |
  | Factory preset | **Refuse** with "hard warning" framing. | Apply + auto-backup first + verbose "overwrote factory B02 'Marshall JCM800'". |

  Safety net: auto-backup is OUR recovery path, not a Fractal-Bot
  redirect. Store timestamped snapshots locally (`backups/` dir,
  gitignored); expose `restore_location(location, backup_id?)` that
  picks the most recent by default. Factory restore is also ours —
  read from `samples/factory/AM4-Factory-Presets-1p01.syx` when the
  user asks to revert to factory.

- **Claude-agent UX layer on top of the gate** (client-side, not
  server-side — MCP tool stays stateless on force):
  - Conversational recognition: *"just apply it"* / *"overwrite"* /
    *"yes, go"* → pass `force=true` on the next call.
  - Session-mode: *"force writes for this session"* → Claude tracks
    `sessionForce=true` in conversation memory and passes it on every
    subsequent call until *"stop forcing"* or a new session.
  - Combined summary + confirmation prompt pattern (Claude formats;
    tool supplies the data):

    **Multi-location batch (P4-002 setlist, etc):**
    ```
    I'm about to write to 4 locations:
      W01  [empty]      → AmbCln: Compressor → Amp → Delay → Reverb
      W02  [ARCTIC]     → MetalLead: OD → Amp → EQ → Reverb   ⚠ overwrites user preset
      W03  [empty]      → Funk1: Comp → Amp → Wah → Delay
      W04  [empty]      → LeadLayer: Comp → OD → Amp → Chorus+Delay
    Backup of W02's current state will be taken first. Apply?
    ```

    **Single-location detail (narrow edit):**
    ```
    W01 currently: AmbCln (Compressor → Amp → Delay → Reverb)
    Change: set amp.gain 5.0 → 7.5 (other params unchanged)
    Backup taken automatically. Apply?
    ```

    Block-level summary for multi-location. Parameter-level detail
    only when the ask is a targeted single-block change. Keeps the
    prompt scannable.

- **Performance budget:**
  - Empty-slot write: ~100 ms (cache-hit classification + write + ack).
    No perceptible friction.
  - Non-empty write with auto-backup: ~400 ms (classification +
    preset dump ~300 ms + write + ack).
  - Batch of 16 locations with backups: ~6 s. Fits the "overt batch
    action" tolerance in CLAUDE.md's performance budget; Claude tells
    user upfront.
  - `force=true` skips the classification read → straight to write.
    Power-user fast path.

- **Tool surface changes** (implementation checklist):
  - `save_to_location(location, force: boolean = false)` — drop Z04
    hard-gate; enforce tier model.
  - `set_preset_name(location, name, force: boolean = false)` — same.
  - `apply_preset` unchanged — it writes to working buffer only, no
    destructive consequence until a subsequent `save_to_location`.
  - New `backup_location(location)` MCP tool (explicit backup; also
    called internally during force overrides).
  - New `restore_location(location, backup_id?)` MCP tool (replay a
    backup onto the target).
  - New `restore_factory(location)` MCP tool (reads from the embedded
    factory bank; only valid for locations with factory fingerprints).

- **Relation to other backlog items:**
  - **P4-002 (setlist)** already references P1-008 as a hard prereq;
    the summary + confirmation prompt above IS that prereq's UX.
  - **BK-011** (naming) — `set_preset_name` currently hard-gated to
    Z04; P1-008 relaxes it with the same tier model.
  - **Session 21 tools** (`switch_preset`, `set_scene_name`,
    `switch_scene`) — `switch_preset` is not destructive to stored
    presets (loads into working buffer), so no gate. `set_scene_name`
    is working-buffer-scoped, also no gate. `switch_scene` is
    read-only. No changes needed for Session 21 tools at release.

- **What NOT to build into P1-008:**
  - Irreversible-action warnings for factory writes beyond the tier
    gate — the gate itself is sufficient; don't add extra confirmation
    modals.
  - A GUI for backup management — CLI/chat commands are enough for
    v1.
  - A backup retention policy — keep all backups; revisit if disk
    use becomes a concern.

### P1-009 Binary preset encoding — **parked**
- Reverse-engineering the scrambled chunk bodies is off the MVP critical
  path per the 2026-04-14 architecture decision.
- Reopen only if the puppet-the-device path proves insufficient.

### P1-010 Bulk param registration from cache (fulfills P1-007 coverage gate)
- **Status (2026-04-19, Session 25).** Session A infrastructure
  **shipped.** `scripts/gen-params-from-cache.ts`,
  `src/protocol/paramNames.ts` (seed table, 20 entries), generated
  `src/protocol/cacheParams.ts`, and `scripts/verify-cache-params.ts`
  (preflight golden). Adding a `(block, id) → name` entry to
  paramNames.ts and running `npm run gen-params` now automatically
  extends CACHE_PARAMS; preflight proves no regression against
  hand-authored KNOWN_PARAMS. 20/20 in-band KNOWN_PARAMS entries
  regenerate byte-identically from the cache. Remaining sessions
  (B / C / D / E) don't need infra changes — they're name-filling,
  unit-audit, hardware spot-check, and audit-wiring respectively.
- **Context.** P1-007 sets the coverage bar; P1-010 is the concrete
  path to get there without 400 one-off captures. Session 15 proved
  **wire `pidHigh` == cache record `id`** for Amp/Drive/Reverb/Delay,
  and the 11 blocks confirmed in Session 18 all held to the same
  positional pidLow↔cache-block mapping. That means the cache
  (`samples/captured/decoded/cache-section2.json` +
  `cache-section3.json`) already contains `pidLow / pidHigh /
  kind / displayMin / displayMax / step / enumValues` for every
  addressable param across every confirmed block — ~200–350
  user-facing params once scene-snapshot / modifier / internal
  routing rows are filtered out. We just haven't harvested it.

- **Deliverable.** `scripts/gen-params-from-cache.ts` emits
  `src/protocol/cacheParams.ts` (generated, parallel to the
  existing `cacheEnums.ts`) containing a full `KNOWN_PARAMS`-shape
  entry per addressable cache record. `params.ts` imports from both
  `cacheEnums` (types) and `cacheParams` (the bulk registry),
  retaining manually-registered out-of-band params
  (`amp.channel` at `pidHigh=0x07D2`, `amp.level` at
  `pidHigh=0x0000`, any others we discover) as overrides.

- **Session breakdown (~4 Claude sessions + 1 founder capture
  session):**
  1. **Session A — Generator script.** `gen-params-from-cache.ts`:
     walks each CONFIRMED cache block, joins against a block-name
     table, filters non-addressable records (heuristic: record kind
     `float` with `displayMin != displayMax`; skip scene/routing
     sub-blocks 15/16; skip modifier-template block 0), and emits
     one `KNOWN_PARAMS` entry per surviving record.
  2. **Session B — Name mapping.** Per-block manual table mapping
     cache record `id` → UI label, sourced from the Blocks Guide
     PDF (`docs/manuals/Fractal-Audio-Blocks-Guide.txt`) and
     verified against AM4-Edit's own labels where the PDF is
     ambiguous. 15 blocks × ~10–30 records each = tractable. Stored
     as `src/protocol/paramNames.ts` so regeneration doesn't clobber
     hand-edited names.
  3. **Session C — Unit inference + filter hardening.** Heuristics:
     `min=0 max=10 step∈{0.01, 0.1}` → `knob_0_10`;
     `min=-∞ max=+∞ step=0.1` and param name contains "db"/"level"
     → `db`; `max ∈ {2000, 4000, 8000}` and name contains "time" →
     `ms`; `max=100 min=0 step=1` and name contains "mix"/"level"/
     "depth" → `percent`; `kind=enum` → `enum` with values from
     `cacheEnums`. Fall back to `float_raw` for unknown units so
     nothing breaks; audit script flags these for review.
  4. **Session D — Spot-check capture sweep (founder hardware
     time).** For each of the 15 confirmed blocks, pick 5 params
     spanning the block's record range (first, last, three mid).
     Founder clicks the control in AM4-Edit with USBPcap running;
     I decode and diff against the auto-generated entry. Total ~75
     captures, ~1–2 hours of founder time. Pass criterion: every
     captured pidHigh matches the cache-derived value; unit + range
     are correct. Failures are logged per-block and trigger a
     per-param fallback for that block only.
  5. **Session E — Audit wiring + cleanup.** Run the P1-007
     coverage audit script. `uncovered` should drop from
     hundreds → zero for every CONFIRMED block. Fix the residuals
     (mark intentionally-excluded in `CACHE-DUMP.md` or catch in the
     spot-check). Regenerate the `apply_preset` / `set_param` tool
     cheat-sheet from the new registry. Preflight green.

- **Risks + mitigations:**
  - **pidHigh==id could break for an unverified block.** The
    Session-D spot-check is the guard; if any block's spot-check
    fails, we fall back to per-param captures for that block only
    (~30 min per block, bounded).
  - **Name ambiguity between Blocks Guide and AM4-Edit UI.** Pick
    the UI label when they disagree — user-facing consistency
    matters more than PDF fidelity. Flag mismatches in a review
    log so future RE sessions can rationalize.
  - **Non-addressable records leak into the registry.** Filter is
    heuristic, not provable. If a user-facing tool call writes to
    a non-addressable record, the AM4 silently absorbs it — same
    class as the absorb/apply discriminator problem (BK-008) and
    equally benign. Audit pass can tighten the filter based on
    observed silent absorbs.

- **Relation to other items:**
  - **P1-007** — this IS the coverage path; closing P1-010 closes
    P1-007's release gate.
  - **P1-008** — coverage makes the tiered write gate meaningful.
    Shipping factory-safety with only 17 addressable params would
    feel half-finished. Run P1-010 before P1-008 lands in a
    release.
  - **P5-009 item 6** — the hallucination-prevention cheat-sheet
    is generated from the bulk registry. Better registry → better
    cheat-sheet.
  - **BK-014 (Axe-Fx II XL+)** — same bulk approach will apply if
    Axe-Fx II's editor exposes a comparable metadata cache. The
    generator script is the template for a future
    `gen-params-from-cache` per device family.

- **When to schedule.** After the current hardware-test queue
  (HW-006/007/008) clears and before P1-008 implementation begins.
  Depends on nothing outstanding — cache is parsed, block roles
  are confirmed, the generator just needs writing.

### P1-012 Channel-aware param writes (release-critical UX) — ✅ Shape 1 + 2 shipped
- **Status (2026-04-21, Session 28 cont 2).** Shapes 1 + 2 both
  shipped across Sessions 22–28. Shape 1 (transparent current-
  channel reporting) lives in `channelStatusLine()` — every
  `set_param` / `set_params` / `apply_preset` response appends the
  channel the write landed on, sourced from the `lastKnownChannel`
  cache (invalidated by `switch_preset` / `switch_scene` /
  `reconnect_midi`). Shape 2 (explicit `channel?` arg) is live on
  `set_param`, `set_params`, and `apply_preset` (via `slots[i].
  channel` single-channel shortcut or `slots[i].channels` per-
  channel map); BK-027 phase 2 added `scenes[i].channels` too.
  Shape 3 (`set_param_in_scene` scene-first tool) + the
  `read_block_channel` helper remain deferred — both depend on
  unresolved protocol work (BK-025 for scene → channel state
  read-back, BK-008 for a working READ primitive). The release
  gate is met as long as Claude stays within Shape 1/2 semantics,
  which the tool descriptions + `channelStatusLine` direct it to.

- **Context.** HW-009 (2026-04-19) confirmed that `set_param` /
  `set_params` / `apply_preset` write to **whichever channel is
  active for that block right now**. Scenes select channels +
  bypass state; channels hold the param values. Two scenes that
  reference the same channel will both reflect any write to that
  channel — a moving-target footgun when the user expects "change
  the tone on scene 2 only" but unintentionally edits channel A
  which scenes 1 and 2 both use. Tool-level awareness is needed
  before this ships to non-developer users; without it, a
  guitarist asking for a tweak on one scene can silently break
  another.

- **The model (from CLAUDE.md's terminology table, now
  load-bearing).**
  ```
  Preset ─── 4 slots × 1 block each
              │
              ├── Block (amp / drive / reverb / …)
              │     │
              │     └── 4 channels A/B/C/D (the data: gain, bass, …)
              │
              └── 4 scenes (selectors: per-block bypass + channel pointer)
  ```
  A write to `amp.gain` targets the channel the Amp block is
  currently on. `amp.channel` is already a decoded register
  (pidHigh `0x07D2`, Session 08) — we just haven't been using it
  as a precondition of every param write.

- **Three candidate UX shapes (pick one before implementation).**
  1. **Implicit + transparent.** Every write response says "wrote
     amp.gain=8 to **channel A**" (by reading the current channel
     from the working buffer first, or inferring from a decoded
     scene-switch ack). No new params; Claude Desktop knows what
     channel it's on and can reason from there. Lowest friction,
     highest trust in the read-current-channel mechanism.
  2. **Explicit channel param, optional.** `set_param({ block,
     param, value, channel? })` — omit for "current channel,"
     specify to force a switch first. Two wire transactions when
     specified (channel select + param write). More control,
     more tokens per call.
  3. **Scene-first mental model.** `set_param_in_scene({ scene,
     block, param, value })` that internally looks up scene →
     channel mapping and writes the right channel. Most intuitive
     for users thinking in scene terms; requires decoding BK-025
     (scene-switch ack) first to know scene → channel bindings.
     Highest value, highest cost.

  Recommendation: **ship (1) first** (transparent current-channel
  reporting), then layer (2) on top once the explicit-channel
  use-case is proven. (3) depends on BK-025 and can follow.

- **Deliverables (for shape 1 — minimum viable).**
  1. `read_block_channel(block)` internal helper — not an MCP
     tool — that SET_PARAMs the amp/drive/reverb/delay channel
     register to itself (or does a minimal read via any
     working read primitive we have) and returns the current
     channel index. Cache the result per block per MCP session;
     invalidate on `switch_preset` / `switch_scene` / explicit
     `amp.channel` write.
  2. Every set_param-family tool response appends
     `Wrote to channel X.` (or "Wrote to the currently-active
     channel (index N);" if channel A/B/C/D naming isn't
     available for the block yet).
  3. Tool descriptions (`set_param`, `set_params`, `apply_preset`)
     add a standalone paragraph: *"Param writes target the
     channel (A/B/C/D) currently active for the block. Channels
     are shared across scenes — a write on one scene affects
     every scene that references the same channel. Use
     `switch_scene` first if the user is asking for a
     scene-specific change; use `set_param` on
     `<block>.channel` first if they want to edit a different
     channel's values without switching scenes."*
  4. `apply_preset` extended description: "Builds across the
     active channel only. To build a preset that varies tone
     across scenes, set channels per-slot and call
     `apply_preset` once per channel."

- **Release gate (adds to LAUNCH-POST-OUTLINE.md).** Before v1.0:
  - [ ] Every param-writing tool response surfaces which channel
    was targeted.
  - [ ] Every param-writing tool description explains the channel/
    scene model in plain English.
  - [ ] Smoke test: a fresh Claude Desktop session asked "change
    the tone on scene 2 without affecting scene 1" produces a
    sequence that first checks what channel scene 2 uses, then
    either switches the Amp block to a dedicated channel for
    scene 2 or warns the user that channels are shared.

- **Relation to other items.**
  - **BK-025** — decoding the scene-switch ack payload gives us
    scene → channel mappings directly from the device; unlocks
    UX shape (3) above.
  - **HW-009** — the observation that prompted this item.
  - **Session 08** — already decoded `amp.channel` write; we
    have the wire primitive, just haven't wired it into tool UX.

- **When to schedule.** Shape 1 + 2 deliverables completed across
  Sessions 22–28 (see per-deliverable status above). Shape 3 +
  read-helper stay deferred pending BK-025 / BK-008. Close-out
  audit of tool descriptions done Session 28 cont 2 — everything
  the backlog spec calls for is reflected in the current
  `set_param` / `set_params` / `apply_preset` descriptions.

---

## PHASE 2 — MCP Server MVP

### P2-001 Scaffold MCP server with @modelcontextprotocol/sdk
- Initialize TypeScript project with MCP SDK
- Define server metadata (name, version)
- Add to claude_desktop_config.json
- ACCEPTANCE: Server appears in Claude Desktop tools list

### P2-002 Implement get_device_info MCP tool
- Returns firmware version, current preset, connected status
- Tests Claude can see the device

### P2-003 Implement read_slot MCP tool
- Input: slot name (e.g. "A01")
- Output: preset name, block summary, factory/user/empty status
- Used by Claude before any write operation

### P2-004 Implement apply_preset MCP tool
- Input: slot name + AM4Preset IR object
- Runs safety check (read → classify → confirm flow)
- Requires explicit user confirmation before write
- Returns confirmation summary

### P2-005 Implement backup_slot MCP tool
- Reads current slot contents
- Saves to local JSON backup file with timestamp
- Returns backup ID for restore

### P2-006 Implement restore_slot MCP tool
- Input: slot name + backup ID
- Restores previously backed up preset

### P2-007 End-to-end test: Claude describes tone, it plays on AM4
- Manually describe a simple tone to Claude Desktop
- Claude calls build_preset_from_description (stub — Claude's own output)
- Claude calls apply_preset with confirmation
- ACCEPTANCE: Tone plays on AM4 within one conversation turn

### P2-008 claude_desktop_config.json setup documentation
- Document exact config entry for the MCP server
- Include Windows path handling notes
- Include prerequisite checklist (driver, node version, etc.)

---

## PHASE 3 — Preset Intelligence

### P3-001 Add AM4 owner's manual as Claude project knowledge
- Full manual PDF uploaded to Claude project
- Verified: Claude can answer block navigation questions

### P3-002 Add AM4 block parameter reference as project knowledge
- Structured parameter tables for all blocks
- Exact effect type names, value ranges, channel behavior
- Resolves all FLAGs from the Amber build sheet example

### P3-003 Implement famous tone research capability
- Claude researches artist gear for specific song/era
- Maps real-world gear to AM4 amp models and effect types
- Produces complete AM4Preset IR with all parameters populated
- Test case: Amber by 311

### P3-004 Implement iterative refinement loop
- Claude applies preset, asks "how does it sound?"
- User gives natural language feedback
- Claude maps feedback to parameter adjustments
- Re-applies and confirms
- Test: "too quacky" → reduce filter sensitivity

### P3-005 Factory preset as baseline system
- Before building a tone, optionally reset to factory baseline
- Prevents stale state from previous experiments
- URL reference: fractalaudio.com/downloads/firmware-presets/am4/

### P3-006 Guitar/pickup compensation hints
- After applying a preset, Claude notes which parameters
  are most affected by pickup output level
- Prompts: "Let me know if you need to adjust amp level
  for your pickups"

### P3-007 Model lineage dictionary (translation layer) — 🟢 shipped (Session 20 cont)
Shipped: `scripts/extract-lineage.ts` → `src/knowledge/{amp,drive,reverb,
delay,compressor,cab}-lineage.json`. Source-tagged lineage + Fractal
quotes extracted from the wiki scrape + Blocks Guide PDF. MCP tool
`lookup_lineage` exposes both forward (by name) and reverse (by real
gear) search to Claude Desktop chats. `scripts/audit-lineage.ts` guards
data quality (description/inspiredBy duplication, markdown artifacts).

Coverage: amp 219/248 (88%), drive 69/78 (88%), reverb 52/79
(family-level) + 4 specific real-gear callouts, delay 23/29 Blocks
Guide descriptions, compressor 19/19 wiki-matched + 8 distinct
forum-quote gear references (LA-2A / 1176 / SSL / Fairchild / Dynacomp
/ Rockman / Orange Squeezer / MXR Dyna Comp), cab 2048 entries (full
Axe-Fx III catalog — AM4 filter deferred until the CAB enum is decoded).

Remaining work (parked): manual curation pass on the 107 unmatched amp
variants + 14 drive variants to classify them as canonical-plus-channel
sub-entries vs genuinely-missing-from-enum. Extend lineage extraction
to Chorus / Flanger / Phaser / Filter / Wah blocks once those become
primary in conversational tone-building requests.

- **Why:** the AM4 model catalog is a closed vocabulary the agent MUST
  output correctly (one wrong name = failed SET_PARAM = broken preset).
  "TS808" is obvious; "Class-A 30W → Vox AC30 Top Boost", "Plexi Normal"
  vs "Plexi JumpP-to-P", and "FAS Modern → inspired by Soldano SLO /
  EVH 5150 / Peavey 5150" are subtle enough that fresh-lookup will
  hallucinate or miss. This is a *correctness* requirement, not a
  performance optimization.
- **Scope:** finite, bounded set — counted from the cache (Session 13):
  - 248 amp models
  - 78 drive types
  - 79 reverb types
  - 29 delay types
  - + pitch / filter / chorus / flanger / phaser / compressor / EQ
    (full block list in `cache-section2.json` after Session 13 parser
    lands)
- **Artifacts (ship in repo):**
  - `src/knowledge/amp-lineage.json` — `{am4Name, inspiredBy[], era, family, notes}`
  - `src/knowledge/drive-lineage.json` — same shape (TS808 → Ibanez Tube Screamer, etc.)
  - `src/knowledge/cab-lineage.json` — cab model → real mic/cab pairing
  - `src/knowledge/reverb-types.json`, `delay-types.json` — algorithm descriptions + real hardware inspirations where relevant
- **Pipeline:** extend `scripts/scrape-wiki.ts` to parse the "inspired
  by" column from Fractal's public wiki (which documents most lineage
  explicitly). Cross-check against `cache-strings.txt` to catch any
  names in the catalog that have no wiki entry → those become `[FLAG —
  VERIFY]` entries needing manual curation.
- **Agent integration:** when building a tone, the agent researches
  artist gear fresh (equipboard, Premier Guitar, Rigged), then uses
  the lineage dictionary to translate "1983 Marshall JCM800 2203"
  into the valid AM4 model name. Catalog constrains the output;
  research fills in the "which of the 5 Marshall variants" judgment.
- **Non-goal:** NOT a replacement for parameter-level knowledge
  (P3-002) — that's covered separately. This is specifically the
  name-translation layer. BLOCK-PARAMS.md holds human prose; these
  JSON files are machine-readable and consumed by the agent at
  runtime.

---

## PHASE 4 — Library Management

### P4-001 List all preset locations with status
- Shows all 104 preset locations: name, type (factory/user/empty),
  last modified
- Formatted as compact table for readability

### P4-002 Setlist-to-presets workflow (`apply_setlist`)
- **Target prompt shape:** *"I have a gig coming up with this setlist:
  {N songs}. Build a preset per song with scenes for the most distinctive
  guitar parts. Store them in banks W–Z."*
- **Flow:**
  1. **Plan** — Claude researches each song's guitar gear/parts (uses
     P3-007 lineage dictionary to translate real hardware → AM4 models),
     drafts a preset IR per song (blocks + params + scenes + names).
  2. **Authorize the target range** (see "Probing is too slow" below).
     Claude tells the user: *"I'll write N presets to locations W01–Z04.
     Anything stored there now will be overwritten. If that range
     includes presets you want to keep, say so and I'll pick a
     different range."* No probing; the user's explicit response is
     authorization. If the user is uncertain, offer `P4-001`'s listing
     as a separate opt-in step (also not free — see notes).
  3. **Summarize + confirm** — present a single table: song → preset
     location → new preset name → block summary. User confirms once
     for the whole batch.
  4. **Apply + save + name** — once BK-028 ships, the batch is a
     single `build_and_save_presets({ presets: [...], force: true })`
     call carrying all N preset specs. Before BK-028 lands, it's N ×
     (`apply_preset` + `save_preset`) MCP calls, which the setlist
     workflow still works with but pays the full per-call LLM-
     latency overhead (~50–85 s for 16 presets — flag in the
     confirmation summary so the user expects the wait). Fail-fast:
     halt on the first write that doesn't wire-ack and return
     partial progress (which locations landed, which didn't).
  5. **Audition (optional)** — `load_location` each saved preset in
     turn so the user hears the result. Skippable per the latency
     budget — a 16-preset audition is ~16 × (load + wait).
- **Probing is too slow (decision):** the original plan called for
  reading every target preset location's metadata before writing. At
  ~50 ms per metadata read (if such a cheap command exists; none
  decoded yet) × 16 locations = 800 ms — acceptable if cheap, but a
  full preset dump (`0x77/0x78/0x79`) would be 5–8 seconds, which
  violates the CLAUDE.md latency budget. Until we either (a) decode
  a bulk "read all preset names" command, or (b) cache names after
  first read, the batch writer does NOT probe — it trusts the user's
  bank-range authorization in step 2. This converts probing from a
  perf cost into a UX moment (user explicitly names safe banks) and
  is the safer default anyway.
- **Confirmation policy** (MCP layer; applies to all write tools, not
  just this one):
  | Situation | Behavior |
  |---|---|
  | Single preset, target = currently-loaded location | Apply to working buffer. **Do not auto-save** — user audits and decides. |
  | Single preset, explicit location target ≠ currently loaded | Summarize → confirm → `apply_preset` + `save_to_location` + `set_preset_name`. |
  | Batch (≥ 2 preset locations) | Authorize the target range with the user (step 2 above) → summarize plan → single batch confirmation → apply + save + name each. |
  | Write touching ≥ 3 blocks (even on active preset) | Show summary + confirm before sending. |
  | Target = factory-classified preset location (P1-008) | Hard block. Refuse without explicit override. |
  | Target = non-empty non-factory user location, known from prior `P4-001` listing | Warn with current name, require explicit confirmation. |
- **Prereqs (hard blockers):**
  - P1-008 factory-preset safety classification (relaxes Z04-only gate).
  - BK-010 scenes in `apply_preset` (setlist prompt specifically asks
    for per-part scenes).
  - BK-011 scene naming finish (3 more captures for sceneIdx → pidHigh).
  - Preset-switch command decode (for audition step;
    `session-18-switch-preset.pcapng` already captured but inconclusive).
- **Prereqs (soft / nice-to-have):**
  - P3-007 model lineage dictionary — makes the song-research step
    reliable instead of hallucination-prone.
  - BK-009 `get_block_layout` — lets the batch planner diff before
    overwriting on partial edits.
  - Bulk "read all preset names" command decode — would let us cheaply
    list populated locations and remove step 2's friction. Track as a
    backlog item when a plausible capture surfaces.
- **Non-goals:**
  - Does NOT replace `apply_preset` for single-preset authoring on Z04 —
    that's the audit-and-save-yourself default.
  - Does NOT build a GUI setlist editor (that's P4-005).
  - Does NOT probe individual preset locations before writing (see
    "Probing is too slow" above).

### P4-003 Preset-location range write with batch safety check
- Subsumed by P4-002's confirmation policy. Keep as a pointer: any
  tool that touches more than one preset location MUST authorize the
  range with the user first and present a single pre-write summary.

### P4-004 Backup all user presets
- Export all non-factory, non-empty preset locations to timestamped JSON
- Stored locally in backups/ directory
- **Latency note:** a full backup is 104 × full-preset-dump = ~30–60 s.
  Runs out of band (user invokes explicitly; not inline in a
  conversation turn). Show progress.

### P4-005 Setlist mode
- Assign presets to an ordered list for a specific show
- View/edit setlist by talking to Claude
- "Move Amber before Down in tonight's setlist"

---

## PHASE 5 — Public MVP Distribution

Goal: a guitarist with a Claude account can install and use the tone agent
without installing Node, a C++ toolchain, or editing JSON by hand. See
`docs/DECISIONS.md` for the packaged-binary decision.

### P5-001 Evaluate packager choices
- Candidates: `@yao-pkg/pkg` (maintained `pkg` fork), `nexe`, `node-sea` (Node's
  built-in single-executable-application), or Electron shell if a GUI is added
- Must support: Windows x64 first, macOS + Linux later, embedded native `.node`
  binaries (for `node-midi`)
- Deliverable: short writeup in `docs/DECISIONS.md` with the chosen tool

### P5-002 Build the Windows `.exe`
- Produce a single `mcp-midi-tools.exe` that embeds the MCP server + bundled
  `node-midi` prebuild
- Verify it runs on a clean Windows machine with no Node and no Visual Studio
- ACCEPTANCE: on a fresh VM, downloading + double-clicking the `.exe` starts
  the MCP server and a `node -v`-less machine can reach it

### P5-003 One-click Claude Desktop MCP registration
- Installer (or first-run helper) writes the correct `claude_desktop_config.json`
  entry automatically — user never opens a JSON file
- If Claude Desktop is running, prompt the user to restart it
- ACCEPTANCE: non-technical user can go from "download" to "AM4 tool appears
  in Claude Desktop" with no manual file edits

### P5-004 AM4 USB driver prerequisite check
- On first run, detect whether the Fractal AM4 USB driver is installed
- If missing, open the Fractal downloads page and halt with a clear message
- ACCEPTANCE: running the exe on a machine without the driver produces an
  actionable instruction, not a stack trace

### P5-005 Installer signing and SmartScreen handling
- Code-sign the `.exe` (EV cert preferred for reputation warm-up)
- Document the SmartScreen "unrecognized publisher" workaround for the first
  unsigned release so early users are not scared off
- ACCEPTANCE: signed build does not trip SmartScreen on a fresh Windows 11

### P5-006 macOS + Linux builds (follow-up)
- Repeat P5-002 for macOS (arm64 + x64, notarized) and Linux (x64 AppImage)
- Deferred until Windows MVP has real users

### P5-007 Auto-update mechanism
- Embedded update check on launch; offer to download new build
- Keep implementation minimal — a GitHub Releases poll is enough for v1
- ACCEPTANCE: a v0.1.1 build can prompt v0.1.0 users to upgrade

### P5-008 MCPB bundle — one-click install manifest
- **Context:** Anthropic's MCPB (MCP Bundle) format bundles an MCP server
  + node_modules + a manifest.json so users install by double-clicking a
  `.mcpb` file in Claude Desktop. Supersedes the ad-hoc `.exe` + manual
  JSON-edit path for end users. See spec:
  https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
- **Scope:**
  1. Write `manifest.json` describing server name, version, entry point
     (Node + `src/server/index.ts` → compiled JS), required tools, and
     user-facing config fields.
  2. Keep current auto-detection (name-substring match in
     `src/protocol/midi.ts`) as the default path — no user config needed
     for the typical case. Expose `midi_port_name` as an **optional**
     manifest config field only as an override for users with multiple
     Fractal devices, a port the auto-detect can't match (rare rename),
     or users running the server against a virtual MIDI bridge. The UI
     should be empty/"(auto-detect)" by default, not a required pick.
  3. Pin all dependencies to exact versions (`package.json` `"dependencies"`
     with `x.y.z` not `^x.y.z`). `.mcpb` ships `node_modules` and a
     transitive bump can brick installs.
  4. GitHub Actions workflow: on tag, run `mcpb pack`, attach the
     resulting `.mcpb` to a GitHub Release.
- **Relation to P5-001..P5-006:** MCPB is one realization of the packaging
  goal. May replace P5-002 (`.exe`) for Claude-Desktop-first distribution;
  the signed `.exe` is still useful for users running the agent outside
  Claude Desktop.

### P5-009 Pre-release ergonomics
- **Context:** small polish items that block feeling "released-quality"
  even if all protocol/packaging work is done. Drawn from Claude Desktop's
  session-19 feedback.
- **Items:**
  1. ✅ **Shipped Session 25.** `list_midi_ports` MCP tool enumerates
     every input/output the server sees, tagging AM4-looking ports
     ("am4" / "fractal" substring). Connection-free — doesn't open the
     AM4, safe to call mid-session. Verdict line surfaces the
     common failure modes (both visible / one visible / none visible).
     Implementation: `listMidiPorts()` helper in `src/protocol/midi.ts`,
     tool handler in `src/server/index.ts`, smoke-server assertion.
  2. ✅ **Shipped Session 25.** `connectAM4()` "AM4 not found" error
     rewritten: lists common causes (power/USB/driver/AM4-Edit
     exclusivity), shows visible ports for diagnostics, and directs
     users to `list_midi_ports` + `reconnect_midi` as the recovery
     path. No more stack traces on the first tool call when the AM4
     isn't connected.
  3. ✅ **Shipped Session 25.** Startup banner extended: the server
     now logs a port-detection verdict to stderr on boot — one of
     "AM4 detected (in: ..., out: ...)", "AM4 partially visible",
     "no MIDI ports visible", or "AM4 not visible among N inputs /
     M outputs". Mirrors what `list_midi_ports` would return at
     server-start time, so a Claude Desktop user sees the server's
     view of the USB state in the MCP log before the first tool call.
  4. ✅ **Shipped Session 25 (cont 3).** `README.md` at the repo root
     covers: what you can ask Claude to do today, requirements (AM4
     driver, Node 18+, VS Build Tools, Claude client), install +
     preflight + write-test, three connection paths (Claude Desktop
     JSON config incl. the Microsoft Store sandboxed-path note,
     Claude Code `claude mcp add`, raw MCP client over stdio), a
     three-step "confirm it works" smoke flow ending with *"Place a
     compressor in slot 1 and set the level to 6"* (watches the AM4
     display update), a tool cheat-sheet table for all 16 tools,
     safety-default summary (Z04 gate, write-echo verification,
     read-only probe), project layout, and cross-links to CLAUDE.md,
     MCP-SETUP.md, STATE.md, SYSEX-MAP.md, SESSIONS.md, backlog,
     CONTRIBUTING.md, SECURITY.md, NOTICE, LICENSE. Opens with the
     Fractal trademark disclaimer, which also closes P5-010's
     README-disclaimer pending item below.
  5. Guardrail on `save_to_slot` — the Z04-only gate is P1-008's job to
     relax; confirm the error message points users at the right escape
     hatch once that ships.
  6. **Param coverage before release** — see P1-007. `KNOWN_PARAMS`
     must cover every param record in `CACHE-BLOCKS.md` for every
     `CONFIRMED` block before v1.0, and the `apply_preset` /
     `set_param` tool descriptions must ship the regenerated-at-
     startup param cheat-sheet. Without both, Claude Desktop
     hallucinates full-size-Fractal params (mid/treble/presence on
     amp, feedback/mix on delay) and the UX regresses to
     validation-error ping-pong. Observed 2026-04-18 during HW-002
     testing.

### P5-010 License and trademark hygiene
- ✅ **Shipped Session 25 (cont 2).** Apache-2.0 `LICENSE` at the
  repo root (copyright 2026 Stephen Staker). Apache-2.0 chosen over
  MIT for patent-retaliation protection.
- ✅ **Shipped Session 25 (cont 2).** `NOTICE` file per Apache-2.0
  convention — includes project copyright, trademark disclaimer for
  Fractal Audio / AM4, and third-party attribution skeleton for
  `@modelcontextprotocol/sdk`, `node-midi`, `zod`.
- ✅ **Shipped Session 25 (cont 2).** `package.json` updated with
  `"license": "Apache-2.0"` and `"author"` set.
- ✅ **Shipped Session 25 (cont 2).** `CONTRIBUTING.md` (minimal
  licensing note + preflight instructions) and `SECURITY.md`
  (vulnerability contact + scope).
- ✅ **Shipped Session 25 (cont 3).** README disclaimer landed
  alongside the README itself (P5-009 #4) — an "Unaffiliated
  community tool" block directly under the title names the Fractal
  Audio / AM4 trademarks and points at `NOTICE` for the full
  statement.
- 🔜 **Pending.** Branding / package-name review for implicit
  endorsement cues — superseded by **BK-029** (project rename)
  below. Block public distribution on BK-029.

### P5-011 Assistant-side UX for MCP tool discovery
- **Context (2026-04-21, Session 27 HW-012).** Founder ran a full
  round-trip of `apply_preset` with the per-channel shape and the
  hardware path worked. But the Claude Desktop session initially
  responded with a spec-only answer — *"I don't have the am4-tone-agent
  connected in this session"* — even though the connector was
  attached. Founder had to nudge explicitly ("i see the connector") to
  get Claude to load the tool schemas and execute. Two compounding
  causes:
  1. **Deferred tool loading** — MCP tools are surfaced to the model
     as names-only until their schemas are actively pulled into
     context. Claude is supposed to notice deferred-tool names that
     match a user request and load them, but the heuristic misfires
     when the request doesn't contain obvious tool-trigger phrasing.
     This is Anthropic-side platform behavior, not something we can
     patch directly.
  2. **Project system prompt biased toward spec output** — framed the
     assistant as a *"design and planning agent"* that *"builds
     detailed preset configurations,"* which naturally reads as
     *produce a spec*. Never told the assistant that an MCP
     connector might be attached and should be used.

- **Shipped this session (Session 27).**
  - Rewrote `CLAUDE.md` § "Project System Prompt (for Claude
    Project)" — default to tool use, spec-only mode only on explicit
    dry-run ask, instruction to check the deferred tool list on
    every AM4-related request, retained verification discipline and
    terminology rules. Founder must re-paste the updated prompt into
    the Claude.ai project settings for it to take effect on new
    Claude.ai conversations.

- **Still pending — more important than the Claude.ai prompt fix.**
  Claude Desktop has no user-configurable app-level system prompt,
  which means the Claude.ai-Project rewrite doesn't help Desktop
  users at all. The **MCP tool descriptions** (registered by the
  server at `src/server/index.ts`) are the only lever. Today those
  descriptions explain *what each tool does*; they don't tell the
  model *when to prefer executing over speccing*, and they don't
  tell the model *when NOT to call* (save_preset after a build-a-
  tone ask — Sailing transcript, 2026-04-21). Full audit rubric:

  1. **Call-to-action lead (every mutation tool).** For every tool
     that changes hardware state — `apply_preset`, `set_param`,
     `set_params`, `switch_preset`, `switch_scene`, `save_preset`,
     `save_to_location`, `set_preset_name`, `set_scene_name`,
     `set_block_type`, `set_block_bypass`, `reconnect_midi`: the
     description's first sentence is a *call-to-action* — "Use this
     tool to {do X} on the user's AM4. Do not produce a written
     spec unless the user explicitly asks for a dry run."
     ✅ Shipped Session 28 cont (2026-04-21). All 12 mutation tools
     now open with the uniform call-to-action pair; dry-run phrasing
     examples embedded on the creative tools (`apply_preset`,
     `set_param`) so Claude knows what an explicit dry-run ask looks
     like.

  2. **Save-intent clause (every persistence tool).** Every tool
     that writes to a preset LOCATION (not the working buffer) —
     `save_to_location`, `save_preset`, future `restore_location` —
     gets an explicit: *"Call this ONLY when the user has asked to
     save / persist / store the preset (e.g. 'save this', 'put it
     on Z04', 'keep this one'). Do NOT call as an automatic follow-
     up to apply_preset — apply is reversible, save is not. A bare
     'build me a preset for X' is a try-it-out ask, not a save
     ask."*
     ✅ Partial (Session 27): `save_to_location`, `save_preset`,
     and the apply_preset description's REVERSIBILITY block all
     carry this language now. Remaining tools are working-buffer
     only and don't need it.

  3. **Reversibility clause (every working-buffer tool).** Every
     tool that writes to the WORKING BUFFER only (not a location)
     — `apply_preset`, `set_param`, `set_params`, `set_block_type`,
     `set_block_bypass`, `switch_preset`, `switch_scene`,
     `set_preset_name`, `set_scene_name` — gets a closing: *"This
     change is reversible by switching presets. Do not chase it
     with save_to_location / save_preset unless the user asked to
     save."*
     ✅ Partial (Session 27): `apply_preset` has it. Remaining
     working-buffer tools need the line added.

  4. **Top-of-tool-list sanity note.** Add a short confirmation
     (in whichever tool is read first — `list_params` or
     `list_midi_ports`) that the connector is live and AM4 tools
     are available, so the model can't slide into the "I don't
     have the connector" failure mode seen on HW-012.
     ✅ Shipped Session 28 cont (2026-04-21). `list_params`
     response now opens with an explicit live-confirmation line
     listing every callable AM4 tool plus a nudge to prefer
     executing over writing a spec. The tool's description also
     tells Claude this is a safe sanity-check call when unsure
     whether the connector is attached.

  5. **Smoke-test for spec-vs-execute default.** Manual Claude
     Desktop session with a minimal "make my amp louder" prompt —
     the assistant's first message must be a tool call, not a
     spec. Hard to automate; record as a manual release-test item
     in HARDWARE-TASKS.md form.
     ⏳ Not started.

- **Release-gate status.** Items (1) and (4) shipped Session 28
  cont; (2) and (3) partially shipped Session 27 cont and fully
  closed by the Session 28 apply_preset response-text rewrite. Only
  (5) — the manual Claude-Desktop smoke test — remains, queued as a
  founder-owed verification step (HW-NNN in HARDWARE-TASKS.md when
  we reach it). End users installing the packaged `.exe` never edit
  any prompt and never know a Claude.ai Project exists — tool
  descriptions are their only UX surface, and that audit is now
  complete.

- **Relation.** Sits alongside P5-003 (one-click MCP registration)
  + P5-008 (MCPB packaging) as the *conversational-UX* leg of the
  release-readiness triad: install → register → use.

---

## BACKLOG (Future / Unscheduled)

### BK-001 Human-readable preset document output
- After building a preset, optionally produce a formatted build sheet
- Similar to Amber 311 example document
- Useful as printed reference at gig

### BK-002 Preset comparison
- "How does this preset differ from the factory one?"
- Show parameter diffs in readable format

### BK-003 Tone matching from reference track
- User describes a recorded tone
- Claude searches for artist gear info, builds closest match

### BK-004 Claude API mode (no Desktop required)
- Standalone app using Claude API directly
- Removes Claude Desktop dependency for advanced users

### BK-005 Other device support (umbrella)
Concrete expansion targets are tracked as their own backlog items,
roughly in the order we'd tackle them:
1. **Fractal family** — BK-014 (Axe-Fx II XL+), BK-015 (Axe-Fx III /
   FM9 / FM3 / VP4 community beta). Same manufacturer, same SysEx
   envelope, shared wiki + Blocks Guide. P3-007 lineage data already
   covers them.
2. **Roland / Boss family** — BK-016 (umbrella), BK-017 / BK-018 /
   BK-019 / BK-020 (founder's RC-505 MKII, VE-500, SPD-SX, JD-Xi).
   Different SysEx family from Fractal but structurally simpler —
   Roland publishes full MIDI implementation PDFs, so zero capture-
   based RE per device. Unlocks broader home-studio use cases.
3. **Deferred / unscheduled:**
   - Helix (JSON preset format — easiest structurally, but totally
     different protocol; no reuse of Fractal or Roland work beyond
     the MCP/UX shell)
   - Quad Cortex (proprietary, closed protocol — hardest)

### BK-006 Web UI for preset library browsing
- Visual slot map
- Drag to reorder setlist
- Compare presets side by side

### BK-007 Remote control from Claude mobile app (laptop-as-bridge)
- Goal: user plays guitar away from laptop, talks to Claude on their
  phone, and the command flows phone → Claude cloud → laptop → AM4 USB.
- The laptop stays the MIDI bridge (phone has no USB/driver path to AM4).
- Requires two capabilities we don't have yet:
  1. **Remote-reachable MCP transport.** Extend the MCP server (Phase 2)
     with an HTTPS / streaming-HTTP mode in addition to stdio. Add
     per-client auth tokens so only the user's Claude instance can
     reach it. A lot of the MCP ecosystem is moving to this transport
     already — check `@modelcontextprotocol/sdk` for current support
     before designing a custom layer.
  2. **NAT traversal for non-technical users.** Home laptops aren't
     reachable from the public internet. Leading candidates:
     - **Cloudflare Tunnel** (free, no router config, stable DNS name)
     - **Tailscale Funnel** (simpler auth story, runs without extra
       infra on the user's account)
     - **ngrok** (easiest demo, paid plan needed for a stable URL)
     The packager (Phase 5) would bundle whichever we pick and
     auto-configure a tunnel on first run of `--remote` mode.
- Claude mobile integration path is the open question: the phone app's
  ability to reach user-provided MCP servers is evolving. Revisit once
  the desktop MVP is live — if mobile MCP lands natively, this
  simplifies to "paste the tunnel URL into your account"; if not, a
  thin Anthropic-connector shim may be needed.
- Security constraints: remote mode MUST honour the write-safety rules
  (`CLAUDE.md` Do Not list; scratch-slot-only writes) and should scope
  to read-only tools by default, with writes gated on an explicit
  per-session confirmation the laptop owner approves locally.
- Out of scope for MVP — parked here so the architecture can leave
  room for it (keep the MCP server transport pluggable, don't
  hardcode stdio-only assumptions).

### ~~BK-013~~ MIDI connection resilience — ✅ shipped Session 19
Landed as: consecutive-timeout auto-reconnect (threshold 2) in
`ensureMidi()` plus an explicit `reconnect_midi` MCP tool. Ack-less
writes across multiple tool calls now self-heal without requiring a
Claude Desktop restart. Every ack-less tool response mentions
reconnect_midi as a manual escape hatch.

### BK-012 Abstract protocol into a standalone npm package
- **Context:** `src/protocol/` is already IO-free and MCP-free — it's a
  pure SysEx library with the checksum, value pack/unpack, params
  registry, block types, slot naming, and command builders. Splitting
  it out lets third parties (other Fractal owners, community editors,
  alternative MCP implementations, CLIs) reuse the protocol work
  without adopting the MCP server, and keeps this repo's MCP surface
  small + focused.
- **Target shape (monorepo, npm workspaces):**
  ```
  packages/
    am4-protocol/         # pure: checksum, packValue, params,
                          # blockTypes, slots, builders. No Node deps.
                          # Publishable.
    am4-midi/             # thin MIDI wrapper (node-midi). Depends on
                          # am4-protocol. Node-only. Publishable.
    am4-mcp-server/       # current src/server/. Depends on both.
                          # Publishable separately or bundled via MCPB
                          # (P5-008).
  ```
  Keep everything in one repo initially so protocol changes + MCP
  consumer updates land in one PR. Publish separately when each
  package stabilises.
- **API stability:** before publishing, audit `src/protocol/` exports
  for public-surface quality — consistent naming (e.g. `buildSetParam`
  vs `buildSetFloatParam` vs `buildSetBlockType` is fine but document
  the convention), minimal surface, no leaking-implementation types.
  SemVer from 0.x until stable.
- **Community gesture:** reach out to Fractal before publishing anything
  that trades on their product names. Their SysEx docs are public and
  third-party editors exist, so precedent is favorable — but a
  heads-up email + link to the repo is the right etiquette. Trademark
  non-endorsement language from P5-010 applies to all packages.
- **Relation to other items:**
  - P5-008 (MCPB bundle) wraps `am4-mcp-server` — unchanged by this
    split.
  - P5-010 (license + trademark) applies per-package, same terms.
  - BK-009 / BK-010 / BK-011 (future protocol features) land in
    `am4-protocol` by default, with MCP tool wiring in the server
    package.

### ~~BK-011~~ Preset and scene naming — 🟢 decode shipped Session 21
- **Shipped:** `buildSetPresetName` (Session 19g) + `buildSetSceneName`
  (Session 21) decoded. MCP tools `set_preset_name` and `set_scene_name`
  registered. Scene pidHigh map is `0x0037 + sceneIndex` (scenes 1..4).
  Both 32-byte payloads space-padded, ASCII-only validated. Byte-exact
  goldens in `verify-msg`.
- **Remaining work:** hardware-test whether the rename writes persist
  across preset reloads (HW-002 for preset, HW-008 for scene). If the
  writes are working-buffer-scoped, design a combined `save_preset`
  tool that chains `save_to_location` + `set_preset_name` +
  `set_scene_name`s in one call so the agent doesn't have to orchestrate
  the ordering manually.
- **Unlock:** when a user says *"build the Boston Rockman tone and
  save it"*, the saved preset reads "Boston Rockman" on the device
  instead of leftover name. Scene names surface in the UI for
  rehearsal / gig clarity.

### BK-009 `get_block_layout` — read current working-buffer chain
- **Context:** Claude Desktop suggested (Session 19) that additive tweaks
  are painful without a way to see what's currently on the unit. `apply_preset`
  currently overwrites, but a user asking *"add a delay before the reverb"*
  needs to know what's already there.
- **Feasibility:** cheap. The block-slot register family (pidLow=0x00CE,
  pidHigh=0x000F..0x0012) is decoded for writes. Reading back the same
  addresses should return the current block's pidLow as a float32 — no
  READ-response decoding needed if the read echo shape is the same.
- **Scope:** MCP tool `get_block_layout()` returning `[{position, block_type}]`
  for slots 1..4. Probe on hardware first to confirm the 0x0D READ action
  on pidLow=0xCE returns a parseable value at a fixed offset (unlike
  parameter reads — see BK-008).
- **Unlock:** additive edits, "what's in slot 2?" queries, apply_preset
  can diff before writing instead of clobbering.

### BK-010 Scene support in `apply_preset` — 🟢 closed (superseded by BK-027 phase 2)
- **Status (2026-04-21, Session 27):** all prerequisite decodes landed.
  BK-010's deliverable — per-scene bypass + per-scene channel state in
  `apply_preset` — is now entirely in BK-027 phase 2's scope. The
  primitives needed are:
  - **Scene-channel** — no new primitive. Use the existing channel-
    switch (`pidHigh=0x07D2`, value = float(channel index)) under an
    active scene. The AM4 self-scopes.
  - **Scene-bypass** — `buildSetBlockBypass(blockPidLow, bypassed)` at
    `pidHigh=0x0003`, float32(1.0) = bypass / float32(0.0) = activate.
    Shipped Session 27 with 4 byte-exact goldens. MCP tool
    `set_block_bypass` also shipped.
  - **Scene name** — `buildSetSceneName` (already shipped Session 21).
  - **Scene switch** — `buildSwitchScene` (already shipped Session 21).
- **What's left:** wire these into `apply_preset`'s `scenes[]` input
  (BK-027 phase 2, active work item). Close this entry and delete the
  ⏳ status marker once phase 2 ships.

### BK-014 Axe-Fx II XL+ support (first expansion — founder owns one)
- **Context:** Founder owns an Axe-Fx II XL+ alongside the AM4. It's an
  older Fractal generation with a larger installed base than AM4 (sold
  2013–2020, tens of thousands of units). The corresponding editor,
  **Axe-Edit**, is the Axe-Fx II equivalent of AM4-Edit and can be used
  the same way — USBPcap captures while clicking in Axe-Edit give us
  byte-exact wire traffic to decode.
- **The important caveat:** Axe-Fx II is the *older* SysEx family. AM4 /
  Axe-Fx III / FM9 / FM3 / VP4 share a modern family (model IDs 0x15,
  0x10, 0x11, 0x13, 0x17). Axe-Fx II uses model ID **0x03** with a
  different parameter-ID space, different preset binary layout, and a
  different block catalog. This is NOT a drop-in reskin of AM4 —
  it's a parallel protocol stack.
- **Architectural implication:** `src/protocol/` currently encodes
  AM4-specific constants (model byte, `KNOWN_PARAMS`, `blockTypes`,
  `cacheEnums`). To support multiple devices cleanly, the protocol
  layer needs parametrization — this is the natural moment to land
  BK-012 (protocol-as-package split) as `packages/fractal-protocol-core`
  (envelope, checksum, value packing, device-abstract types) plus
  per-device packages (`am4-protocol`, `axefx2-protocol`). The MCP
  server either auto-detects which device is connected via the firmware-
  version query (function 0x08) or exposes a `device` config field.
- **Reusable wins:**
  - SysEx envelope + checksum + value-pack/unpack: unchanged.
  - P3-007 lineage dictionaries: already multi-device (wiki covers all
    Fractal generations). Axe-Fx II's amp catalog is a subset of the
    union `cacheEnums.ts` could eventually hold.
  - MCP server shape (tool set, safety rules, scratch-slot policy):
    identical UX.
  - USBPcap + `parse-capture.ts`: unchanged.
- **Net-new work:**
  - Axe-Fx II model ID + envelope quirks (read the Axe-Fx II MIDI
    reference PDF — the only one Fractal published for this family).
  - Capture-based decode of the Axe-Fx II SET_PARAM shape (likely
    different bit-layout; may or may not use the same septet encoding).
  - Extract Axe-Edit's equivalent metadata cache file (equivalent to
    AM4-Edit's `effectDefinitions_15_2p0.cache`; the `15` is the AM4
    model ID, so Axe-Fx II's version likely sits alongside with `03`).
  - Preset dump format decode (Axe-Fx II uses a different chunked
    format than AM4's 0x77/0x78/0x79).
  - Block catalog + `KNOWN_PARAMS` for Axe-Fx II's effect set.
- **Scope phasing:**
  1. Refactor `src/protocol/` into device-abstract + AM4-specific halves
     (blocks BK-012's package split).
  2. Phase 0 equivalent for Axe-Fx II: firmware version query +
     mode-switch replays to confirm comms work.
  3. Phase 1 equivalent: SET_PARAM decode via capture, matching the AM4
     session cadence (SESSIONS.md template applies directly).
  4. Extract Axe-Edit cache, generate `cacheEnums-axefx2.ts`, decode
     per-block parameters.
  5. MCP server device-detection (query firmware at startup, route
     tool calls to the right protocol package).
- **Why this is the right next step after AM4 MVP:** the founder has
  the hardware on hand, can run Axe-Edit captures immediately, and
  already knows the RE workflow. Axe-Fx II gives us a second data point
  for the "device-abstract protocol layer" design — without a second
  device, we'd over-fit the abstraction to AM4's quirks.

### BK-015 Axe-Fx III / FM9 / FM3 / VP4 — community beta
- **Context:** the modern Fractal family (same SysEx family as AM4)
  represents by far the largest addressable market — Axe-Fx III alone
  has an active user base an order of magnitude larger than AM4, and
  FM9/FM3 add more. Once BK-014 lands (proves the device-abstract
  protocol layer works), extending to the III-family is structurally
  easy: same model-ID family, same envelope, likely the same SET_PARAM
  encoding with different parameter IDs and a bigger catalog.
- **Why this needs community beta rather than founder-driven RE:** the
  founder doesn't own an Axe-Fx III / FM9 / FM3 / VP4. All capture-based
  RE has to come from other users' hardware. That changes the workflow
  from "plug in and click" to "ship a test build + capture guide to a
  trusted beta tester."
- **Prereqs:**
  - BK-014 complete (device-abstract protocol shipped, multi-device
    shape proven).
  - Public-facing MVP of AM4 tone agent so there's a working tool to
    point beta testers at as proof-of-concept.
  - Capture kit: a guided USBPcap walkthrough doc (what to capture,
    how to name files, how to send them back). Non-technical
    acceptable — the target users are guitarists, not devs.
- **Beta recruitment:** the Fractal Audio forum is where III/FM9
  owners hang out. A "looking for beta testers for a Claude-based tone
  assistant" post with demo video (showing AM4 working end-to-end)
  is the likely channel. Expect 5–10 volunteers if the AM4 demo is
  compelling; we only need 1–2 per device model for the initial capture
  set.
- **Per-device scope (each follows BK-014's phasing):**
  1. Extract `cacheEnums` from that device's Fractal-Bot / Axe-Edit III
     metadata file if available (III-family editors all cache
     effect definitions in a comparable way — format unconfirmed).
  2. If no cache: capture-based enumeration via tester clicking through
     every block Type dropdown (tedious but tractable; ~1 session per
     beta tester per device).
  3. Mode-switch + firmware-version sanity check: prove comms work
     against unfamiliar hardware before any parameter writes.
  4. Write the first parameter against the scratch location on the
     tester's device (hardest trust moment — get explicit consent,
     use scratch-only rules, have them back up the target location
     first).
  5. Expand to the device's full parameter catalog via capture cadence.
- **Market framing:** supporting AM4 + Axe-Fx II + Axe-Fx III + FM9
  covers roughly the full Fractal-owning guitarist population who
  might plausibly install Claude Desktop. That's 6-figures of
  potential users, not the dozens who'd intersect with AM4-only. This
  is where the project's distribution story (P5-002 signed .exe, P5-008
  MCPB bundle) starts paying off.
- **Non-goals:**
  - NOT trying to reverse-engineer closed formats without vendor-
    authorized tooling. If any device's protocol isn't decodable via
    editor-traffic capture, we skip it and document why.
  - NOT committing to per-device parity with AM4 tooling. The MVP for
    each new device is "can Claude build and apply a preset." Advanced
    features (scene switching, layout editing, backup/restore) roll
    out per device as interest warrants.

### BK-016 Roland / Boss device family — umbrella
- **Context:** founder owns four Roland/Boss devices (RC-505 MKII,
  VE-500, SPD-SX, JD-Xi) and uses them actively. All four are in the
  **Roland/Boss SysEx family** (manufacturer ID `0x41`), which is a
  completely separate protocol family from Fractal's (`0x00 0x01 0x74`).
  Structurally this is a second device family, not just a new device —
  the `fractal-protocol-core` package from BK-012 needs a sibling
  `roland-protocol-core`.
- **Why this is strategically valuable:**
  - Unlocks a second and fundamentally different user segment:
    home-studio / loop / synth players, not just Fractal-guitar users.
  - The four targeted devices together cover a wide range of MIDI-
    controllable gear categories (loop station, vocal FX, sample pad,
    synth) — proves the abstraction generalizes.
  - Roland's MIDI implementations are **publicly documented PDFs**.
    Every device has an official "MIDI Implementation" doc with the
    complete address table. That's zero capture-based RE per device
    vs the 20+ session cost we paid on AM4.
  - Turns "AM4 tone agent" into a more general proposition ("my local
    MIDI gear, from a chat interface") which broadens the story for
    Fractal forum posts, Roland forums, synth communities, etc.
- **Shared protocol shape** (applies to all 4 target devices — see
  individual items for device-specific quirks):
  ```
  F0 41 <dev> <model> <cmd> <addr:3+> <data..> <checksum> F7
  ```
  - `<cmd>` = `0x11` (RQ1 / data request, read) or `0x12` (DT1 / data
    set, write). Just two verbs across the family.
  - `<addr>` = 3 or 4 bytes depending on device generation. Parameters
    are addressable — every knob / mode / preset-select lives at a
    fixed address documented in the MIDI impl PDF.
  - `<checksum>` = `(128 − ((sum of addr + data) mod 128)) mod 128`.
    Different algorithm from Fractal's XOR checksum.
- **Concepts that generalize vs Fractal:**
  | Concept | Fractal | Roland/Boss |
  |---|---|---|
  | Preset | "preset location" (A01..Z04) | "program" / "patch" / "memory" / "kit" |
  | Parameter | pidLow + pidHigh | 32-bit address |
  | Preset-select | `save_to_location` family | just write to the "current program" address |
  | Scene | 4 performance variations per preset | NOT A CONCEPT — each device has its own sub-structure (tracks, parts, pads, effect blocks) |
  | Bypass-per-effect | block-placement system | per-effect enable address |
- **Tool-surface design decision:** expose **domain-named MCP tools
  per device**, NOT generic `set_parameter(addr, value)`. The Roland
  MIDI docs give us symbolic names for every address for free (e.g.
  `0x18000020 = FILTER CUTOFF`), so typing them up is mechanical.
  Generic tools would force Claude to know the address space cold and
  lose all the domain semantics that make agent-driven control
  compelling.
- **Core architecture deltas from Fractal:**
  - `packages/roland-protocol-core` (envelope, checksum, address
    pack/unpack, RQ1/DT1 verbs).
  - Per-device package: `packages/boss-rc505mk2`, `packages/boss-ve500`,
    `packages/roland-spd-sx`, `packages/roland-jd-xi` — each holds
    the address table, enum dictionaries, preset semantics.
  - MCP server loads device-specific tool sets based on which devices
    are connected (auto-detect via Identity Request `F0 7E 7F 06 01 F7`
    — a universal MIDI query every Roland/Boss device responds to with
    its model ID).
- **Prereqs:** BK-012 (protocol package split) must land first.
  Without it, there's no home for the second protocol family.
- **Phasing:** implement devices in order of simplicity / doc
  maturity: JD-Xi (BK-020, most documented + founder actively uses),
  then VE-500 (BK-018), then RC-505 MKII (BK-017, most complex state
  model — 5 tracks + rhythms), then SPD-SX (BK-019, sample management
  adds scope).
- **Non-goals:**
  - NOT attempting sample upload / firmware updates / anything beyond
    preset + parameter control. Roland's sample-transfer protocols
    exist but are separate scope.
  - NOT attempting real-time performance streaming (note-on/note-off
    is in scope only where needed for tool-verification, e.g. "trigger
    pad 3 to audition the kit").

### BK-017 Boss RC-505 MKII support
- **Device:** 5-track loop station with rhythm + input/track effects.
- **MIDI surface:** USB-MIDI class-compliant. Identity response model
  ID specific to RC-505 MKII (different from original RC-505).
- **Preset concept:** "memory". 99 user memories + init template.
- **Sub-element concept:** 5 loop tracks + rhythm; each track has
  independent level, pan, reverse flag, FX slot; rhythm has pattern +
  variation. The MCP surface should expose track-level tools:
  `rc505_select_memory(n)`, `rc505_set_track_level(track, level)`,
  `rc505_set_rhythm_pattern(name)`, etc.
- **Source of truth:** Boss publishes the RC-505 MKII MIDI
  Implementation PDF on boss.info. Primary reference, no RE needed.
- **Biggest scope risk:** the state model is richer than AM4's
  (5 tracks × per-track FX × rhythm variations). Coming up with a
  coherent MCP tool set that covers looping workflows without
  ballooning the surface area is the main design challenge.
- **Useful workflows worth supporting early:**
  - Load/save full memories with a natural name.
  - "Set up a quick ambient loop memory with shimmer reverb on track 1,
    delay on track 2."
  - Rhythm pattern + tempo scripting per-memory.

### BK-018 Boss VE-500 support
- **Device:** vocal multi-effects pedal.
- **MIDI surface:** USB-MIDI + TRS MIDI.
- **Preset concept:** "patch". 99 user + 99 preset patches.
- **Sub-element concept:** effect chain (Dynamics / Preamp / Pitch /
  Harmony / FX1 / FX2 / Reverb / Delay / Looper). Closer to AM4's
  signal chain than RC-505's track model — the existing AM4 block-slot
  concept maps reasonably well, just with a different block catalog.
- **Documented MIDI surface (from `VE-500_MIDI_ImpleChart_eng01_W.pdf`,
  researched 2026-04-18):**
  - ✅ Program Change (1–128) — patch select
  - ✅ CC 1–31 and 64–95 — **only for parameters the user has
    pre-assigned to a CC slot on the device itself**; typically
    continuous params (Harmony Level, Key, Reverb Mix)
  - ✅ Bank Select MSB (CC 0), Clock
  - ❌ SysEx address map — **explicitly closed**: the chart says
    *"Specifications of System Exclusive message is not opened for
    users."* Every Boss 500-series pedal (MD-500, RV-500, DD-500,
    DD-200, VE-500, SY-300, GT-1000) follows the same closed pattern.
- **What this means for scope:**
  - **Agent-useful without RE:** patch selection + tweaking whichever
    parameters the user has manually mapped to CC on the pedal. This
    is real value ("switch to my harmony patch, pull harmony level
    down 20%"), but it's not deep editing.
  - **Deep editing (effect-type swaps, routing, patch creation):**
    requires capture-based RE of Boss Tone Studio's USB traffic —
    same methodology as AM4, same class of effort.
- **Strategic re-frame:** VE-500 is NOT the "easy documented win" the
  original backlog assumed. It's a capture-based RE project. The
  consolation is cross-device leverage — if we crack VE-500, the same
  SysEx conventions likely apply to the rest of the 500 series and
  the GT-1000, unlocking the entire Boss flagship line in roughly
  one RE project's worth of effort.
- **Unique opportunity:** harmony / pitch features are highly
  expressive from an agent interface ("set harmony to close thirds in
  G major above the lead"). Good demo content once deep editing
  lands; until then, patch-change + CC is what's on the menu.

### BK-019 Roland SPD-SX support
- **Device:** sample pad (9 onboard pads + external trigger inputs).
- **Preset concept:** "kit" (100 kits). Each pad holds a WAVE + optional
  SUB WAVE, per-pad mode (one-shot / loop / alternate), mute group.
  Per-kit master FX + 2 kit FX slots.
- **MIDI surface (documented in OM; no separate MIDI Implementation
  Chart exists — updated 2026-04-18):**
  - ✅ Program Change → kit selection
  - ✅ Control Change (CC #1–#95) → master FX, CONTROL 1/2 knobs, kit FX
    switches — user-assignable on the device
  - ✅ Note on/off → pad triggers (velocity-sensitive)
  - ❌ **No SysEx address map.** Roland's SPD-SX downloads are: Owner's
    Manual, Effect Guide, Using SPD-SX Wave Manager, Sound List. There
    is no MIDI Implementation Chart PDF — unlike every other device in
    BK-016 (JD-Xi, VE-500, RC-505 MKII all publish one). Kit editing
    over MIDI/SysEx is therefore not possible; the MIDI surface is thin
    (kit select + perf control + trigger).
- **The WAV-management problem (founder's actual ask):** "give Claude
  some WAVs and tell it where to put them" + "reorganize kits." Neither
  is reachable via MIDI. Two remaining paths evaluated:
  1. **Wave Manager USB protocol RE** — `USB MODE = WAVE MGR` runs a
     proprietary, undocumented USB link with the Wave Manager desktop
     app. libusb capture + RE. Hard, no published spec, no reference
     implementation.
  2. **USB flash drive file-format RE (chosen compromise,
     2026-04-18)** — the OM documents `UTILITY → SAVE (USB MEM)` and
     `LOAD (USB MEM)` at either KIT+SETTINGS or ALL granularity.
     Device writes a structured folder to the flash drive; we RE the
     file format, modify it, user loads it back via the device's own
     UI. No USB protocol, no drivers, no WAVE MGR mode — pure
     file-format work, tractable with `hexdump` + the Wave Manager user
     guide as feature spec.
- **Scope (flash-drive approach):**
  - User runs `SAVE (USB MEM) → ALL` to a blank drive — reference dump.
  - MCP server parses the folder layout (kit definitions + WAV pool).
  - Agent operations: assign WAVs to specific kits/pads, rename kits,
    reorder / swap kit positions, bulk import WAVs into the wave pool,
    back up and restore kit banks.
  - User plugs drive back in → `LOAD (USB MEM)`. Done.
- **Architectural placement:** does **NOT** sit under
  `packages/roland-protocol-core` — that package is for the Roland
  MIDI SysEx (RQ1/DT1) family, which this feature does not use.
  Likely a standalone `packages/roland-spd-sx-flash` (or similar) built
  on Node's `fs`, not on `node-midi`. BK-016's "no sample management"
  non-goal is **explicitly overridden** here because file-format RE is
  a different technical category from the MIDI/SysEx umbrella that
  non-goal was written against.
- **Local manuals** (`docs/manuals/other-gear/`, added 2026-04-18):
  - `SPD-SX_OM.pdf` / `.txt` — owner's manual. Save/load flash-drive
    operations on pp. 65–66; full MIDI settings pp. 67–68.
  - `SPD-SX_Wave_Manager_e02.pdf` — Wave Manager user guide. Does not
    contain the USB protocol, but documents every operation Wave
    Manager performs on kit/wave data — functions as the **feature
    spec** for what our flash-drive MCP server needs to replicate.
  - `SPD-SX_EffectGuide.pdf` — per-effect parameter reference for the
    master FX / kit FX catalog. Needed if we extend scope from
    kit-structure editing to per-effect parameter editing.
  - `SPD-SX_PA.pdf`, `SPD-SX_eng04_W.pdf` — to be catalogued when this
    BK is picked up.
- **Feasibility probe (first session when BK-019 activates):** `SAVE
  (USB MEM) → ALL` a known kit configuration, hex-dump the output.
  If kit metadata is plaintext or lightly structured: the approach is
  viable, proceed to full file-format decode. If the format is
  encrypted or heavily obfuscated: the flash-drive path fails, fall
  back to Wave Manager USB RE or drop the feature.
- **Prereqs:** BK-012 (protocol-as-package split) lands first so there's
  a clean home for a non-protocol-core package.
- **Unlock:** first MCP device that manages *sample libraries* rather
  than *parameter state* — proves the agent-driven UX for bulk asset
  workflows (organize, rename, rearrange), applicable to other
  samplers if the pattern works.

### BK-020 Roland JD-Xi support — **likely first Roland target**
- **Device:** crossover synth (analog + digital + drums).
- **MIDI surface:** USB-MIDI.
- **Preset concept:** "program". 256 programs (128 preset + 128 user).
- **Sub-element concept:** 4 parts per program — analog synth, digital
  synth 1, digital synth 2, drum kit. Each part is independently
  addressable (filter / env / LFO / etc).
- **Source of truth:** Roland JD-Xi MIDI Implementation PDF — one of
  Roland's most thoroughly documented recent devices. Full address
  table + parameter ranges + tone-category enums all published.
- **Why it's the right first Roland target:**
  - Best public doc coverage.
  - Founder actively uses it.
  - Synth control through natural language ("make the lead darker,
    open up the filter on attack, slower LFO") is an inherently good
    agent demo — unlike loop-station state, where the interesting
    action is real-time performance that MIDI commands can't quite
    match.
  - Address space is large but well-structured; makes a good test of
    the "domain-named tools over generic set_parameter" decision.
- **Useful workflows:**
  - "Give me a warm pad on part 1 and a plucky lead on part 2."
  - Patch copying between parts.
  - Category-aware tone selection ("pick a bell from the digital
    synth 1 preset bank").

### BK-021 Lineage schema migration — 🟢 shipped (Session 20 cont)
Shipped: renamed `inspiredBy` → `basedOn` to match Fractal's wording,
added structured `manufacturer` / `model` / `productName` fields
(best-effort extraction from wiki parens + Blocks Guide rows + forum
quotes), and added `heuristic-inferred` source tag for allusion cases
(e.g. "legendary original from Denmark" → `{ manufacturer: "TC
Electronic", model: "2290" }` via MODEL_TO_BRAND table).
`lookup_lineage` MCP tool accepts structured filters (`manufacturer` /
`model`) with exact-match scoring prioritized above substring scoring.
Fractal-original detection (`isFractalOriginal`) leaves `basedOn`
absent on records like Zephyr and FAS Boost — absence now unambiguously
means "no real-gear model". Sibling inheritance on amps preserves all
structured fields.

Artist attribution was briefly added as a schema field but removed —
coverage was inherently patchy (required a curated artist list), and
the fuzzy `real_gear` filter already handles artist queries via
substring-match against description prose ("Cantrell" / "Satriani" /
"Urban" are all in the Fractal wiki text). `detectArtist` stays as an
internal sanitization step that strips artist possessives from
`productName` (so 5F8 Tweed reads "Fender Tweed Twin 5F8" not
"Keith Urbans Tweed Twin 5F8"), but is no longer exposed.

Smoke tests verify: `name="T808 OD"` (forward), `real_gear="1176"`
(fuzzy reverse), `manufacturer="MXR"` (structured) all work. Audit
invariant added: description mentions "based on" but basedOn missing
is flagged. Related follow-up: BK-022 (extend to remaining blocks)
stays pending.

### BK-021.old Lineage schema migration — original spec (kept for reference)
- **Problem:** The current lineage schema uses `inspiredBy` inconsistently.
  It populates only when a *distinct* real-gear reference exists beyond
  `description` (to avoid duplication), which means *absence* of
  `inspiredBy` is semantically ambiguous — it could mean "no real-gear
  lineage" OR "lineage is buried inside `description`". The two cases
  are indistinguishable from the JSON alone.
- **Concrete failure case** (the one that triggered this item): the
  delay `2290 w/ Modulation` has `description: "Based on the legendary
  original from Denmark."` and no `inspiredBy`. The model is clearly
  based on the TC Electronic 2290 Dynamic Digital Delay, but the string
  "TC Electronic" appears nowhere in the record. A user prompt like
  *"give me a classic MXR phaser block"* routes to a reverse-lookup
  call — and that call misses lineages expressed as allusions or
  buried in description prose.
- **Target schema:**
  ```typescript
  interface LineageRecord {
    am4Name: string;
    wikiName?: string;
    description?: string;
    descriptionSource?: 'fractal-wiki' | 'fractal-blocks-guide';
    inspiredBy?: {
      primary: string;           // always the short real-gear noun phrase
                                 // e.g. "MXR M-102 Dyna Comp",
                                 //      "TC Electronic 2290 Dynamic Digital Delay"
      manufacturer?: string;     // "MXR"          — populated when unambiguous
      model?: string;            // "M-102"        — populated when unambiguous
      productName?: string;      // "Dyna Comp"    — populated when unambiguous
      source: 'fractal-wiki' | 'fractal-blocks-guide' | 'fractal-forum-quote';
    };
    fractalQuotes: FractalQuote[];
    // block-specific fields unchanged
  }
  ```
- **Invariants the migration enforces:**
  1. `inspiredBy` is present on every record that has *any* real-gear
     lineage, regardless of whether the source was a wiki paren, a
     Blocks Guide row, a forum quote, or description prose.
  2. `inspiredBy.primary` is the distilled short noun phrase, never a
     duplicate of `description` (may share content but differs in form).
  3. Absence of `inspiredBy` means "no real-gear lineage exists in
     sources" — Fractal-originals (FAS Modern, Zephyr delay, etc.).
     Agents can rely on this signal.
  4. Structured fields (`manufacturer`, `model`, `productName`) are
     best-effort, absent when parsing is ambiguous. Agents filter by
     `.primary` substring-match as the fallback.
- **Extractor work:**
  - Parse wiki amp parens (`"narrow-panel Fender Tweed Champ, 5F1"`,
    `"100W PRS Archon"`) into structured fields where patterns allow.
  - Parse drive parens (`"Ibanez TS-9 Tube Screamer"`,
    `"MXR M77 Custom Badass Modified O.D."`) — Blocks Guide rows give
    us cleaner inputs here; the Blocks Guide PDF is the preferred
    source for drives.
  - **For delays and compressors where description carries the lineage
    prose** (e.g. `"Based on the Carbon Copy delay."`): extract the
    short form into `inspiredBy.primary` even when it'd overlap with
    description. Accept the apparent redundancy — the fields serve
    different roles (`primary` = search key, `description` = narrative).
  - **Allusion-style descriptions** (2290's "legendary original from
    Denmark") need manual curation or a heuristic cross-reference
    against the `am4Name` — in this case `am4Name` contains "2290"
    which is the model number, so we can synthesize
    `{ primary: "TC Electronic 2290", model: "2290" }` with a "heuristic-inferred"
    source tag. Keep the heuristic conservative — fail open rather
    than fabricate.
- **Reverse-lookup wins after migration:**
  - *"classic MXR phaser"* → matches `inspiredBy.manufacturer == "MXR"`
    scoped to phaser block, returns the closest AM4 phaser type.
  - *"TC Electronic 2290"* → matches `inspiredBy.primary` directly.
  - *"LA-2A"* → matches `inspiredBy.model` on the Optical Compressor
    record.
  - Current behavior: all three fall back to substring search on
    `description`, which is brittle and misses allusion-style entries.
- **Non-goals:**
  - NOT attempting a fully-structured `era` field. The sources don't
    consistently say whether a model is based on the original-era
    design or a reissue; auto-extracting era produces wrong values
    more often than right ones.
  - NOT splitting `description` into separate `manual` / `wiki` /
    `blocks-guide` fields. The AM4 Owner's Manual has no per-model
    prose, and the wiki/Blocks Guide content is usually the same or
    a superset, so splitting creates empty slots without adding info.
    `descriptionSource` tags the single `description` field instead.
- **Migration path:**
  1. Extend the extractor with an `inspiredBy.primary` extraction pass
     that runs against description + wiki paren + forum quotes in
     priority order. Always populates when any real-gear content is
     present.
  2. Add structured `manufacturer` / `model` / `productName` parsers
     for the common patterns (`"Brand Model ProductType"`,
     `"ProductName (Brand Adjective)"`). Skip records where the
     parser isn't confident.
  3. Update `lookup_lineage` MCP tool to expose structured reverse
     filters: `lookup_lineage({ block_type, manufacturer: "MXR" })`
     returns all MXR-modeled records.
  4. Update `scripts/audit-lineage.ts` to verify the new invariants
     (inspiredBy always present when description has "based on" /
     allusion markers).
- **Acceptance test:** *"Give me a classic MXR phaser block"* — with
  the schema migration + phaser lineage extraction (BK-022), Claude
  should reliably return the correct AM4 phaser type via reverse
  `lookup_lineage`.
- **Relation to device-family expansion (BK-005, BK-014, BK-015,
  BK-016):** the structured `inspiredBy` becomes much more valuable
  once multiple devices share the lineage data — a user asking for
  "MXR Phase 90" could match a Fractal phaser model OR a Roland/Boss
  effect that models the same pedal. The schema migration is a
  prerequisite for cross-device lineage queries.

### BK-022 Extend lineage extraction to remaining blocks — 🟡 partial (Session 20 cont)
Shipped: phaser / chorus / flanger / wah lineage via a generalized
`extractSimpleBlock` helper that handles the three inline-description
formats Fractal uses in these wikis (`**Name : desc**`, `1. Name: desc`,
`1. **Name**`). Coverage: phaser 9/17, chorus 1/20 (wiki has no per-type
descriptions beyond names — the Japan CE-2 basedOn came via the
MODEL_TO_BRAND inference), flanger 10/32, wah 6/9. `lookup_lineage`
MCP tool now accepts these 4 block types (9 total lineage blocks).
Smoke test verifies the "classic MXR phaser" query returns Block 90.

Remaining (not scheduled): Filter, Rotary, Tremolo/Panner, Gate,
Enhancer, Graphic EQ, Parametric EQ. These are mostly algorithmic
blocks with minimal real-gear lineage per BK-022's coverage estimate;
Fractal's wiki rarely writes "based on X" descriptions for them.
Skip until explicit user demand materializes.

- **Scope:** add lineage extraction for the blocks P3-007 didn't cover:
  Chorus, Flanger, Phaser, Wah, Filter, Rotary, Tremolo/Panner, Gate,
  Enhancer, Graphic EQ, Parametric EQ.
- **Why now isn't the time:** The current 5 blocks (amp / drive /
  reverb / delay / compressor) cover the highest-value preset-building
  categories. The remaining blocks are lower-leverage for typical tone
  requests — users say "MXR phaser" less often than "Tube Screamer" or
  "Marshall JCM800". Ship the schema migration (BK-021) first so we
  don't re-emit the remaining blocks in the old schema and migrate
  them twice.
- **Source availability check:**
  - `docs/wiki/Phaser_block.md`, `Chorus_block.md`, `Flanger_block.md`,
    `Wah_block.md`, `Filter_block.md`, etc. all exist (scraped).
  - Each follows the same **Name** header + > description pattern as
    the compressor wiki. The compressor extractor can be generalized.
  - Blocks Guide PDF has no per-type tables for these; wiki is the
    sole source.
- **Expected coverage** (rough estimate, based on wiki spot-checks):
  - Phaser: strong — specific real-gear callouts (MXR Phase 90, EHX
    Small Stone, Mu-Tron Bi-Phase).
  - Chorus, Flanger: strong — classic pedals (CE-1, CE-2, Electric
    Mistress, A/DA Flanger).
  - Wah: moderate — wah archetypes (Cry Baby, Vox V847) are named
    but sometimes generic.
  - Filter: mostly generic (envelope filter, state-variable), less
    real-gear lineage.
  - Rotary, Tremolo, Gate, Enhancer, EQ blocks: minimal lineage data;
    mostly algorithmic.
- **Prereq:** BK-021 (schema migration) — extend the new schema
  naturally to these blocks rather than migrating twice.

### BK-008 Decode the 40-byte write-ack payload (apply vs absorb discriminator)
- **Context:** every AM4 write produces a 64-byte ack with a 40-byte param
  descriptor (`hdr4 = 0x0028`). Session 18 hypothesized "ack arrives ⇒ write
  landed; no ack ⇒ absorbed by absent block". Session 19 hardware testing
  falsified this — the ack arrives identically for writes to absent blocks
  that produce no audible change. The server now labels the ack as a
  wire-level ack and explicitly warns it does NOT confirm audible change.
- **Open question:** does the 40-byte payload carry a placed-vs-absent flag
  we haven't decoded? Two paired samples exist (A01 amp.gain=6 applied in
  Session 18; reverb.mix=50 absorbed in Session 19) and they differ in
  trailing payload content (applied has zeros from byte 14; absorb has
  non-zero content through byte 23). Sample size of 2 is too small to
  claim a discriminator — needs paired captures for the same param with
  block placed vs not placed.
- **Minimum viable work:**
  1. Capture paired writes for 3–4 params (reverb.mix, delay.time,
     drive.drive, comp.attack) with block placed and absent.
  2. Byte-diff the 40-byte payloads within each pair.
  3. If a consistent discriminator byte (or pattern) falls out, wire it
     into `isWriteEcho` or a sibling `isAppliedEcho` predicate.
  4. If no consistent discriminator exists in the write-ack payload,
     fall back to one of: (a) decode the 0x0D READ response format and
     use read-diff-after-write, or (b) find + decode a block-layout
     query command and precheck client-side.
- **Unlock:** honest apply/absorb detection. Today the tool says "ack
  received, ack is not a confirmation of audible change"; with this
  work it could say "write landed" or "write absorbed — block not
  placed" with confidence.

### BK-023 MIDI Implementation PDF → MCP registry parser
- **Context:** post-AM4, the natural platform play is supporting more
  gear. For any vendor that publishes a MIDI Implementation PDF with a
  full Parameter Address Map (Roland across its synth line, Korg,
  Yamaha, documented Boss entry-level like GT-1, Access, Novation),
  almost all of the reverse-engineering work AM4 required is already
  done — the doc *is* the registry. A parser that ingests the PDF and
  emits a `KNOWN_PARAMS`-shaped registry + minimal transpiler config
  would collapse weeks of per-device RE into a single ingest step.
- **Target output per device:** the same artifacts AM4 has today —
  a `params.ts`-style registry with `pidLow/pidHigh/unit/range/enum`
  per param, a block/section list, and device metadata (manufacturer
  byte, model byte, SysEx envelope shape). Paired with a thin
  protocol-core module for that vendor family (Roland envelope,
  Yamaha envelope, etc.).
- **Why this is worth doing:** the multi-device roadmap (BK-014
  Fractal family + BK-016 Roland/Boss family) gets materially cheaper
  if we build this once and reuse it. JD-Xi (BK-020) is the natural
  first consumer — fully-documented Roland device, big address space,
  tests the parser and the tool-surface generator end-to-end.
- **Scope sketch:**
  1. PDF-to-structured-ingest: most vendor docs have the Parameter
     Address Map in consistent tabular form (Address | Name | Value
     Range | Description). Layout-aware `pdftotext` + regex gets most
     of the way; fuzzier tables need manual review.
  2. Vendor protocol-core modules: one per SysEx envelope family
     (`fractal-core` exists; add `roland-core`, later `korg-core`,
     `yamaha-core`).
  3. Registry format that's shared across vendors — the current AM4
     `KNOWN_PARAMS` shape is close; extract into `@mcp-midi/registry`
     (or similar) once BK-012 package split lands.
  4. Optional: a `generate-tools-from-registry` step that emits
     MCP tool definitions (`set_param`, `set_params`, `list_params`,
     `list_enum_values`) automatically given a registry + vendor-core.
- **Prerequisite:** BK-012 (protocol-as-package split). Without that,
  every new device is a copy-paste fork instead of a package consumer.
- **Non-goals:** pattern / sequence data (not in published docs for
  most vendors), preset-catalog / factory-bank metadata, audio-rate
  MIDI (SysEx-over-audio, etc.). Firmware-closed devices (Boss
  500-series, Line 6 Helix) are out of scope for this item and
  handled by BK-024.
- **Dependency on BK-024:** once this ships, the long tail of gear
  without MIDI Impl docs becomes the interesting frontier — that's
  what the capture wizard is for.

### BK-024 Capture wizard for undocumented-SysEx devices
- **Context:** vendors like Boss (500-series, GT-1000), Line 6
  (Helix), Fractal, and most boutique pedal builders ship gear whose
  protocol is controlled entirely through a closed editor app. BK-023
  doesn't help for these devices — there's no PDF to parse. The only
  path is the AM4 path: capture the editor's USB traffic, decode the
  protocol, and build a registry by hand.
- **Opportunity:** the AM4 RE process, now proven across 20+ sessions,
  is a repeatable methodology — not a one-time investigation. If we
  package the tooling and the workflow, we can offer it to users as
  a guided BYOD ("bring your own device") path: the user runs our
  wizard, it walks them through capture + parse + verify, and at the
  end they have a registry that plugs into the same MCP shell every
  other device uses.
- **What the wizard would include:**
  - Capture: scripted USBPcap setup for Windows + equivalents on mac
    / Linux, with a "record this specific action in your editor"
    prompt model ("change the amp type now", "select a different
    reverb", etc.).
  - Parse: a generalized `parse-capture.ts` that handles the major
    SysEx envelope families (Universal, Roland, Yamaha, Fractal-style
    proprietary) and surfaces the deltas between captures.
  - Decode assist: the wizard proposes pidLow / pidHigh / encoding
    hypotheses based on the deltas and asks the user to confirm. The
    human still needs to recognize "oh, that's a float32 LE" or "that's
    a septet-packed nibble" — those deductions can't be automated.
  - Verify: `verify-msg` goldens built automatically from the captures,
    plus `verify-pack` for round-tripping the proposed encoding.
- **Honest limits:** a wizard cannot replace human deduction for
  checksum schemes, value encodings, or proprietary packing (Fractal's
  septet chunking, Roland's checksum, etc.). Realistic productivity
  gain is roughly 50% vs AM4-from-scratch — enough to make a weekend
  project feasible instead of a month-long one, but still not
  push-button.
- **Why this is the long-tail unlock:** documented devices (BK-023)
  are maybe 40% of what a working musician owns. Closed-SysEx devices
  are the other 60%. A credible capture wizard is how this project
  becomes *the* local MIDI-gear-agent platform instead of a
  Fractal-specific curiosity.
- **Sequencing:** Phase-6+, after BK-014/015/020 have validated the
  multi-device architecture. Premature to build before we've actually
  lived through 3–4 device onboardings and learned which parts of the
  workflow are stable enough to package.
- **Dependency:** BK-012 (package split) and BK-023 (registry format
  shared across devices).

### BK-025 Decode scene-switch ack payload (scene → channel mappings)
- **Context.** Every `switch_scene` call produces a 64-byte
  write-echo whose 40-byte payload varies per scene in a structured
  way. HW-006 (2026-04-19) captured all four scenes and showed byte 24
  constant at `0x1F` (suspected block-placement bitmask: 4 blocks ×
  1 bit = 5 bits = 0b11111) and bytes 20–23 / 25–26 varying per scene.
  Almost certainly encodes per-block bypass + channel pointers
  (which channel each block uses on that scene). Decoding it unlocks
  scene-first UX in P1-012 (Shape 3 tool: `set_param_in_scene` maps
  scene → channel internally) AND gives us a read-back path for scene
  state without depending on the unsolved READ response format
  (STATE.md "deferred").

- **Captured scene-switch ack payloads (bytes 15+ of the 64-byte ack):**
  ```
  Scene 1:  00 00 00 00 00 00 00 00 00 0C 00 00 …  (mostly zero — baseline)
  Scene 2:  00 40 00 00 00 05 2E 55 2A 1F 0C 20 …
  Scene 3:  01 00 00 00 00 05 2E 54 2A 1F 4C 40 …
  Scene 4:  01 40 00 00 00 00 00 01 00 1F 4C 60 …
  ```
  - Bytes 15–17: septet-packed scene index
    (0 / 0x80 / 0x100 / 0x180 → `00 00`, `00 40`, `01 00`, `01 40`).
  - Byte 24: `0x1F` on scenes 2–4, `0x00` on scene 1 — hypothesis
    that it's a block-placement bitmask that only populates once
    the scene diverges from defaults. If so, scene 1 baseline has
    zero for this byte because the scene hasn't been individually
    configured (it inherits from preset defaults).
  - Bytes 20–23 and 25–26: the interesting ones. Likely per-block
    bypass + channel state encoded as nibbles or packed bits.

- **Deliverables.**
  1. New capture campaign (HW-011 to be queued) — construct a preset
     with **known** bypass/channel state per scene (e.g. scene 2:
     Amp bypassed + Drive on channel B; scene 3: all blocks active
     on channel A). Switch through all four scenes; capture acks;
     diff against the known ground-truth. Should let us pin each
     varying byte to a specific (block, attribute) pair.
  2. `parseSceneAck(bytes)` in `src/protocol/sceneAck.ts` that
     returns `{ sceneIndex, blocks: [{ block, bypass, channel }] }`.
     Byte-exact goldens in `verify-msg` (4 scenes × N ground-truth
     presets).
  3. Wire into the `switch_scene` MCP tool response — after the
     ack, include `scene ${N} state: amp=A bypass, drive=B, reverb=C,
     delay=A` in the response text. This lets Claude know the
     channel mapping without a separate read.

- **Risks.** Payload may not cleanly encode channel — could be
  modifier state or scene-level param override values instead.
  If so, we'll need a different read path to get scene → channel
  mappings. Fallback: maintain server-side state via explicit
  channel writes (P1-012 Shape 1 as-is).

- **When to schedule.** Next protocol-RE session after P1-012 ships
  enough state tracking to be useful. Lightweight — 4 existing
  captures already in hand, need ~4 more with known ground-truth
  to disambiguate.

### BK-026 Decode preset-switch ack payload (preset state snapshot)
- **Context.** Every `switch_preset` call produces a 64-byte
  write-echo whose 40-byte payload differs per preset. HW-007
  (2026-04-19) captured A01 / B03 / M02 / Z04 with varying byte
  signatures, and sparse presets (A01, Z04 "Clean Machine") had
  mostly-zero payloads while richer factory presets (M02) carried
  distinctive non-zero bytes. Likely encodes enough of the preset's
  layout + active scene to let us read back a loaded preset's
  skeleton without a full dump.

- **Captured preset-switch ack payloads (bytes 15+ of the 64-byte ack):**
  ```
  A01 (idx 0):   00 00 00 00 00 00 00 00 00 0C 00 00 00 00 …
  B03 (idx 6):   03 00 18 04 00 66 34 6E 1E 4D 40 03 18 …
  M02 (idx 49):  18 40 08 44 15 12 25 73 1F 0D 07 10 00 …
  Z04 (idx 103): 33 40 19 64 10 00 01 00 1F 4C 26 03 18 …
  ```
  - Bytes 15–17: septet-packed location index (A01=0x00, B03=0x06,
    M02=0x31, Z04=0x67 — matches the outgoing float32-packed index).
  - Bytes 18–28: vary richly per preset. Likely encodes block
    layout (which blocks in which slots) and possibly active scene
    + a few parameter values.

- **Deliverables.**
  1. Capture a small corpus of **known-content** presets (we already
     control Z04 via `apply_preset`; capture a sparse preset, a
     full-chain preset, and 2–3 factory presets whose content we
     inspect via the AM4 display).
  2. `parsePresetAck(bytes)` — returns
     `{ locationIndex, blockLayout: ['amp'|'none',…], activeScene? }`.
  3. Wire into the `switch_preset` MCP tool response.

- **Deprioritized vs BK-025.** Scene-switch payload is richer in
  immediate UX value (scene-first tools); preset-switch is more a
  read-back convenience. Do BK-025 first, transfer the decoding
  technique to BK-026.

- **When to schedule.** After BK-025 ships — same methodology,
  likely half the effort because we have a template by then.

### BK-027 Kitchen-sink `apply_preset` (blocks × channels × scenes, one call) — ✅ shipped (both phases)
- **Status (2026-04-21, Session 28):** **Phase 2 shipped.** `scenes[]`
  added to the tool schema; orchestrator composes `switch_scene` →
  per-block channel-switch → per-block `set_block_bypass` →
  `set_scene_name` at the tool layer (no new protocol primitive —
  Session 27's HW-011 decode supplied everything needed). Response
  text rewritten to report the actual final active scene + its
  channel pointers, replacing the idealized-scene narration that
  tripped HW-012. Seven new pre-MIDI validation smoke assertions.
  Hardware round-trip deferred to the next session touching the
  device — the primitives are each individually hardware-verified
  (HW-011 + Session 27 MCP tool test; BK-027 phase 1 round-trip per
  HW-012), so this session is orchestration only.

- **Phase 1 status (2026-04-21):** **Hardware-verified (Session 27,
  HW-012).** `slots[i].channels` per-channel param maps round-tripped
  on the device — 12 writes landed clean, block layout correct, per-
  channel amp values confirmed (channel A: Deluxe Verb Normal / gain
  3; channel D: 1959SLP Normal / gain 8; reverb mix 30 on channel A).
  Optional `name?` field shipped Session 27 (cont) after the
  Sailing-transcript UX test — `apply_preset({slots, name})` writes
  the working-buffer name at the end; still does NOT save (apply/save
  boundary preserved).

- **HW-012 finding (closed Session 28).** Phase 1 left the tool
  narrating scene intent that didn't match the actual final
  active-channel-per-block state. Phase 2's response rewrite
  eliminates the idealized narration entirely: when scenes are
  configured, the response reports the last-active scene (the one
  the AM4 is on when the call returns) and the channels that scene
  now points at, sourced from `lastKnownChannel` after the send loop.
  When scenes aren't configured, the response reverts to a
  channels-only story with an explicit "scene pointers unchanged by
  this call" caveat so Claude can't invent scene state that wasn't
  touched.
- **Context.** Session 22 conversation produced a realistic user prompt
  the tool stack currently can't satisfy in one call: *"make a preset
  with a clean scene, a crunch scene, a rhythm scene, and a solo
  scene; amp channels A+B use the same type with different gains for
  clean/crunch; channels C+D use another amp type with different gains
  for rhythm/solo."* Today that needs:
  1. `apply_preset` to place Amp,
  2. a `set_params` with 8 channel-scoped writes to fill A/B/C/D,
  3. four **missing** scene→channel writes (blocked on HW-011),
  4. four `set_scene_name` calls,
  5. `save_preset`.
  5+ MCP round-trips and a non-trivial sequencing problem for Claude.
  The founder's 2026-04-19 call was clear: grow `apply_preset` into
  a kitchen-sink "here's my whole preset" tool so Claude can plan
  once, send once. Keep the small tools (`set_param`,
  `set_block_type`, `set_scene_name`, etc.) for surgical edits;
  this is the counterpart for "build a complete preset."

- **Proposed shape (input schema):**
  ```typescript
  apply_preset({
    // Block layout + per-channel params for each slot
    slots: [
      {
        position: 1,
        block_type: "amp",
        // Optional. Per-channel param values (A/B/C/D). Only valid
        // for amp / drive / reverb / delay. If omitted, no channel
        // values are written (preserves whatever's there already).
        channels: {
          A: { type: "Deluxe Verb Normal", gain: 3 },
          B: { type: "Deluxe Verb Normal", gain: 6 },
          C: { type: "1959SLP Normal", gain: 5 },
          D: { type: "1959SLP Normal", gain: 8 },
        },
        // Back-compat shortcut. Equivalent to `channels: { <active>: {...} }`
        // — writes to whatever channel the block is currently on.
        params?: { gain: 6, bass: 5 },
        // Back-compat shortcut. Equivalent to `channels: { <passed>: params }`
        // — switches to the specified channel first, writes params there.
        channel?: "A" | "B" | "C" | "D",
      },
      { position: 2, block_type: "reverb", channels: { A: { mix: 30 } } },
    ],
    // Per-scene configuration. Omit to leave scenes at defaults.
    // channels / bypass depend on HW-011 / BK-010 decodes.
    scenes?: [
      {
        index: 1,
        name?: "clean",
        // scene → channel pointer per block. HW-011 / BK-010 decode.
        channels?: { amp: "A", drive: "A", reverb: "A", delay: "A" },
        // scene → bypass flag per block. HW-011 decode.
        bypass?: { amp: false, drive: true, reverb: false, delay: false },
      },
      { index: 2, name: "crunch", channels: { amp: "B" } },
      { index: 3, name: "rhythm", channels: { amp: "C" } },
      { index: 4, name: "solo",   channels: { amp: "D" } },
    ],
  })
  ```
  The tool does **not** save. Chain with `save_preset(location, name)`
  to persist. (Founder's 2026-04-19 call: keep `save_preset` lean as
  rename + save; don't grow it into a combined "build + save."
  Working buffer vs stored preset is a meaningful boundary.)

- **Execution order inside the handler.** Preserves current
  apply_preset semantics and adds scenes + multi-channel config:
  1. Validation pass (atomic): all slot blocks, all channel letters,
     all scene indices, all scene→block references must exist.
     Kitchen-sink means the rejection messages need to be precise —
     path-like *"slots[0].channels.B.type: unknown amp type "foo""*
     not just "invalid input."
  2. Block placement writes (one per slot with a non-"none" type).
  3. Per-slot channel param writes: for each slot that supplies
     `channels`, walk the A→B→C→D order, switch channel, write
     params. Skip missing channels (e.g. `channels: { A: {...} }`
     only touches channel A).
  4. Per-scene writes (blocked on HW-011 decodes): for each scene
     that supplies `channels` or `bypass`, emit the appropriate
     scene-channel / scene-bypass writes.
  5. Scene name writes (if `scenes[i].name` supplied) via the
     existing rename command.
  6. Return a per-write ack summary plus channel-status lines.

- **Dependencies + phasing.**
  - **Phase 1 (shipped Session 24, hardware-verified Session 27):**
    `slots[i].channels` — per-channel param maps via the existing
    channel-switch + SET_PARAM primitives.
  - **Phase 2 (shipped Session 28):** `scenes[]` support. All
    required primitives already existed — scene-switch (Session 21),
    scene-channel reuses the existing channel-switch under an active
    scene (Session 27 HW-011 decode), scene-bypass via
    `buildSetBlockBypass` at `pidHigh=0x0003` (Session 27 HW-011
    decode), scene-name via `set_scene_name` (Session 21). The
    orchestrator walks: for each `scenes[i]` → `switch_scene(i)`
    → channel-switch per block in `scenes[i].channels` →
    `set_block_bypass` per block in `scenes[i].bypass` →
    `set_scene_name` if supplied. Ack-shape branching: scene-name
    uses the 18-byte `isCommandAck`; all other scene-phase writes
    use the 64-byte `isWriteEcho`. Hardware round-trip deferred to
    the next session using the device (primitives each
    individually HW-verified).

- **Why not grow `save_preset` too?** Two reasons.
  1. **Separation of concerns.** `apply_preset` operates on the
     working buffer; `save_preset` persists the working buffer.
     Conflating them muddles the "is this change reversible?"
     question. Today a user can apply_preset, experiment, and
     `switch_preset A01` to discard. Fold save in and that escape
     hatch disappears.
  2. **Tool-description token budget.** Every MCP tool description
     is shown to Claude every session. A do-everything tool needs
     a description that covers every use case, which costs tokens
     on every conversation. Two focused tools have two focused
     descriptions and compose naturally.
  Keep `save_preset(location, name)` as the rename-then-save
  composite it already is.

- **When to schedule.** Phase 1 shipped Session 24 + hardware-verified
  Session 27. Phase 2 shipped Session 28 (orchestration-only, no new
  protocol work).

- **Relation to other items.**
  - **BK-010 Scene support in apply_preset** — closed 2026-04-21
    (Session 27). Fully superseded by the phase 2 deliverable.
  - **HW-011** — ✅ archived. Decode complete.
  - **HW-012 response-text honesty fix** — ✅ bundled into phase 2.
  - **P1-012 Channel awareness** — phase 1 extends the per-write
    channel mechanism to per-channel batches, building on the
    same cache + switch primitives.
  - **P5-009 item 4 (nice-to-have sugar `set_block_channels`)** —
    redundant once BK-027 phase 1 ships; delete that sugar idea
    or fold it as an alias that forwards to apply_preset.

### BK-028 Bulk preset build-and-save (unblocks P4-002 setlist workflow)
- **Context.** Session 22 conversation raised the realistic scenario
  of a user asking Claude to build and save 10 presets in one prompt
  (e.g. *"build my gig setlist"*). With the granular tool surface
  that requires 20 MCP calls (10 × apply_preset + 10 × save_preset),
  and the math is ugly:
  - Per preset with full kitchen-sink shape: ~60–90 wire writes @
    ~50 ms each = **3–4.5 s of wire time per preset**.
  - × 10 presets = **30–45 s of wire**.
  - Plus 20 × MCP round-trips with LLM latency between each call
    (Claude has to generate the next call after reading the previous
    response) = another **20–40 s** of LLM overhead.
  - Total: **~50–85 s** for a 10-preset batch. CLAUDE.md's perf
    budget caps "avoid altogether" at 5 s. This is 10× that.
  A single bulk tool with one MCP round-trip eliminates the LLM-
  latency-between-calls overhead entirely (the per-preset wire time
  is still there, but that's unavoidable). Brings the total to
  ~30–45 s — still long, but one operation the user is warned about
  upfront instead of 20 interleaved tool calls.

- **Proposed shape.**
  ```typescript
  build_and_save_presets({
    presets: [
      {
        location: "W01",
        name: "Opener clean",
        slots: [ /* same shape as BK-027 apply_preset.slots */ ],
        scenes: [ /* same shape as BK-027 apply_preset.scenes */ ],
      },
      { location: "W02", name: "Ballad drive", slots: [...], scenes: [...] },
      // … up to ~26 entries (one per bank the session targets; bounded
      // by AM4's 104 preset locations minus whatever's write-gated)
    ],
    // Force tier from P1-008 write gate. true = overwrite
    // non-empty targets with auto-backup; false = refuse non-empty.
    // Applies to every preset in the batch; per-preset override
    // possible via presets[i].force if needed (deferred until
    // someone actually wants mixed-force batches).
    force?: boolean,
  })
  ```

- **Execution order inside the handler.**
  1. **Validation pass (atomic).** All preset specs validated
     end-to-end before ANY wire writes: every block name, channel
     letter, param name/value, scene index, location code, and the
     P1-008 gate tier per target location. Any failure rejects the
     entire batch with nothing sent. Error paths include the
     `presets[i]` index so Claude can fix the offending preset
     without rebuilding the whole payload.
  2. **Pre-flight backup (P1-008 integration).** For any target
     location marked "user preset" or "factory preset" that's being
     overwritten under `force=true`, take a timestamped backup
     BEFORE any writes in that preset's sequence. Backup path
     recorded in the final response for user reference.
  3. **Per-preset execution, sequential.** For each preset in
     order: apply_preset (working buffer) → save_preset(location,
     name). Track ack status per preset. On first un-acked save,
     stop the batch (don't leave the user with an unpredictable
     half-written setlist).
  4. **Status summary at the end.** Return per-preset status:
     `{ location, name, status: "saved" | "backup_taken_then_saved"
     | "skipped_gate" | "failed_mid_sequence", writes: N, errors?: [...] }`.
     Plus a batch-level summary line Claude can parrot back to the
     user: *"Built 7 of 10 presets (W01–W07). W08 failed during
     scene writes; W09–W10 not attempted. Backups from forced
     overwrites: W03 → backups/2026-04-19-W03-overdrive.syx."*

- **Progress reporting gap.** MCP doesn't stream intermediate
  progress; the client blocks until the tool returns. For a
  45-second call this means Claude Desktop shows a spinner with no
  milestone visibility. Mitigations:
  - **Claude-side warning** (required): Claude tells the user
    upfront *"I'll build 10 presets, this will take about a minute."*
    Tool description explicitly instructs this behavior.
  - **stderr heartbeat** (optional): the tool logs
    `building preset 3/10 (W03 "Ballad drive")…` to stderr per
    preset. Doesn't reach Claude Desktop's UI but shows up in
    logs for debugging long-runs.
  - **Phased variant** (future, if needed): split into
    `plan_preset_batch` (validate + return plan with estimated
    time) → user confirms → `execute_preset_batch(plan_id)`.
    More MCP roundtrips but explicit confirmation of the big
    operation. Probably overkill for MVP.

- **Error handling — mid-batch failures.**
  - Validation errors (pre-flight): whole batch rejected, nothing
    sent, Claude gets a structured list of fix-ups.
  - Wire-level errors (mid-batch): stop on first un-acked save,
    report what succeeded. Don't leave the user guessing whether
    W05 was partially saved — either it acked or we bailed.
  - Working buffer state after failure: uncertain, since
    apply_preset leaves the working buffer at the last built preset.
    Tool response flags this so Claude can warn the user
    *"your working buffer now reflects W07's layout — navigate
    away and back to a saved preset if you want a clean slate."*

- **Relation to other items.**
  - **P4-002 Gig setlist workflow** — this is the primitive P4-002
    consumes. P4-002's 16-song research→W-Z-assignment→batch-save
    flow becomes a single `build_and_save_presets` call after all
    the research is done.
  - **P1-008 Factory preset safety** — `force` param and backup
    semantics piggyback on P1-008's tier model. BK-028 can't ship
    before P1-008 (the gate enforcement is P1-008's job).
  - **BK-027 Kitchen-sink apply_preset** — this tool's `presets[i]`
    shape is literally BK-027's shape + `{ location, name }`. Land
    BK-027 first (phase 1 is ready today); BK-028 is a thin
    batch-and-save wrapper on top.
  - **Future — `plan_preset_batch` companion (no BK id yet)** — a
    read-only variant for very long batches, if the no-progress
    problem becomes real in practice.

- **When to schedule.** After BK-027 phase 1 (kitchen-sink apply
  landed) and P1-008 (write gate). Both are prerequisites. Not
  urgent on its own — the 20-tool-calls workflow works today, just
  slowly. Becomes urgent when a user first tries a real setlist
  build and the latency stings.

### BK-029 Project rename before first public distribution

- **Context.** "AM4" is Fractal Audio Systems, Inc.'s product name
  and implicit trademark. The current project name `am4-tone-agent`
  and every self-reference ("AM4 Tone Agent") use that mark in a
  way that could read as implying an affiliation or endorsement.
  The P5-010 NOTICE file carries an explicit disclaimer, but a
  non-trademark-adjacent project name is the cleaner defense for a
  public release — removes the trademark question instead of just
  disclaiming it.
- **Decided (2026-04-19):** **"MCP MIDI Tools"**
  (package name `mcp-midi-tools`). Chosen after evaluating
  "Conversational Presets" (narrower than the roadmap — the
  Hydrasynth Explorer has *patches*, not presets, and a loop
  station has loops), "Tone Tools" (guitar-centric — a synth
  user says "patch," not "tone"), and the goofy "MCP MIDI Music
  Tools / MMMT."
  - "MCP" is an explicit, forum-searchable qualifier (surfaces
    the project on Fractal Forum / Hydrasynth Discord / Gearspace
    when users search for "Claude MCP <device>").
  - "MIDI Tools" accurately describes what it is — a tool layer
    over MIDI, not a product brand. Stays honest if the roadmap
    ever includes non-MIDI protocols (unlikely, but the name
    doesn't close that door awkwardly).
  - Requires a credible general-MIDI layer to earn the
    generality — see **BK-030** below. The rename should land
    *after* BK-030 primitives ship so the name isn't
    aspirational.
- **Scope of the rename (one pass, before any public push):**
  - `package.json` `"name"` field.
  - Repo name on GitHub (the origin remote URL changes; all old
    clones need a `git remote set-url`).
  - `LICENSE` + `NOTICE` project title lines.
  - `README.md` title + install-paths examples (the README itself
    is still pending; see P5-009 #4).
  - Every doc under `docs/` that self-references "AM4 Tone Agent"
    (`STATE.md`, `SESSIONS.md`, `CLAUDE.md`, planning docs) —
    keep references to the **device** as "AM4" (that's correct
    factual usage; trademark fair use for interoperability), but
    replace project-name references.
  - MCP server metadata: `server.name` / `version` in
    `src/server/index.ts`.
  - Tool descriptions that self-reference ("AM4 Tone Agent" vs
    the tool doing the actual work) — search-and-replace pass.
  - `docs/MCP-SETUP.md` install snippets (the server name appears
    in `claude_desktop_config.json` examples).
  - `scripts/smoke-server.ts` if it asserts on the server name.
  - `src/knowledge/` file names stay — they're device-catalog
    files, not project-brand files.
- **Device-name usage that STAYS:** the string "AM4" is the
  correct factual name for the hardware the server talks to.
  Keep it in tool descriptions, manuals references, capture
  filenames, protocol decodes, etc. Only the *project* name
  changes; the device it controls keeps its real name.
- **Blockers:**
  - ✅ Name decided: **MCP MIDI Tools** (2026-04-19).
  - BK-030 general-MIDI primitives need to ship first so the new
    name is backed by real generality, not aspirational.
  - Whether to do a `git mv` to a new repo name on GitHub or
    create a new repo and re-push history. `git mv` at the
    repo level is just a GitHub-side rename and auto-redirects
    existing clones — lower friction.
- **When to schedule.** Before any of: npm publish, public GitHub
  repo flip, `.exe` release (P5-005), or community beta
  (BK-015). Can also land opportunistically earlier if the
  founder decides on a name — the mechanical pass is ~30 minutes
  + an hour of grep auditing.
- **Non-goals:**
  - Renaming decoded capture files, SysEx documentation, cache
    files, etc. — those are *about* the AM4 device and their
    names reflect that accurately.
  - Renaming the current MCP tool set (`apply_preset`,
    `save_to_location`, etc.) — tool names are device-neutral
    already.

### BK-030 General-MIDI primitive tools (earns the "MCP MIDI Tools" name) — ✅ Closed (Session 30 cont 5–7)

**Status:** All three sessions shipped. Tool count 17 → 22 (`send_cc`, `send_note`, `send_program_change`, `send_nrpn`, `send_sysex`). Pure builder functions live in `src/protocol/generic/midiMessages.ts` (the future `midi-core` package boundary). README has a Generic MIDI quick-start with five conversational examples; `docs/MCP-SETUP.md` updated. BK-029 (project rename) is unblocked.

- **Context.** The current 16 tools are almost all AM4-specific
  wrappers. `list_midi_ports` enumeration is already generic (it
  walks every node-midi port), but its "verdict" string tags AM4
  ports only. `reconnect_midi` calls `connectAM4()` directly. To
  justify renaming the project to **MCP MIDI Tools** (BK-029),
  there needs to be a real general-MIDI layer that works against
  any MIDI device the user plugs in — not just AM4. Without it,
  the name over-promises.
- **Why now.** Two roadmap signals force this forward:
  1. The founder's next device (Hydrasynth Explorer, BK-031) is
     addressable *today* via stock CC and NRPN — zero device-
     specific protocol RE needed. A general `send_cc` /
     `send_nrpn` tool set would let Claude drive the Hydrasynth
     on day one, before any Hydrasynth-specific wrappers exist.
  2. BK-014 (Axe-Fx II XL+) will want the port-selection
     generalization anyway. Landing the primitives first means
     Axe-Fx II work drops into a multi-device-shaped codebase
     instead of forcing a retrofit halfway through.
- **Deliverable — 7 new/generalized tools:**
  - `list_midi_ports` (generalize): drop the AM4-specific tag;
    return every input/output with raw port name. Optional
    `pattern` param for callers that want tagging (future
    device packages pass their own pattern). Connection-free.
  - `reconnect_midi` (generalize): accept a `port` identifier
    (name substring or exact). Current AM4 path stays as the
    default when no port is given, for backwards compat with
    existing tool descriptions.
  - `send_cc(port, channel, cc, value)` — one-shot Control
    Change. 0..127 each, no device-side assumption. Works on
    any CC-responsive device.
  - `send_note(port, channel, note, velocity, duration_ms?)` —
    send a Note On + (after duration) a Note Off. Triggers
    pads (SPD-SX), plays synths (Hydrasynth, JD-Xi), drives
    any MIDI-note-responsive gear. `duration_ms` default ~500.
  - `send_program_change(port, channel, program, bank_msb?,
    bank_lsb?)` — PC with optional bank-select prefix. Flips
    patches on anything PC-responsive (Hydrasynth's bank
    select scheme documented in its manual p. 83; Fractal,
    Roland, and Boss all support this too).
  - `send_nrpn(port, channel, msb, lsb, value, high_res?)` —
    14-bit capable Non-Registered Parameter Number. Unlocks
    the Hydrasynth's deeper engine controls immediately (the
    Hydrasynth's NRPN mode addresses the same params as its CC
    chart at higher resolution; enabled via "MIDI Param TX/RX
    = NRPN" on the device).
  - `send_sysex(port, bytes[])` — raw SysEx. Power-user escape
    hatch; validates F0 / F7 framing but nothing else. Useful
    for ad-hoc RE sessions (sending captured frames to see what
    happens) and for device-specific one-offs that don't yet
    have a wrapper. Explicit tool description warns users this
    can brick a device if mis-used.
- **Implementation notes:**
  - Connection registry: a small map `{ portName → { in, out,
    staleCounter } }` replacing the single cached AM4 handle.
    Each tool takes a `port` argument; `connectAM4()` becomes
    `connect(portPattern)` with the AM4 pattern as one caller.
  - Stale-handle auto-reconnect (BK-013 heuristic) is generic
    MIDI behavior — applies per-port in the registry. No rewrite
    needed, just per-port bookkeeping.
  - Ack-less outcomes from `send_*` primitives feed the same
    stale-counter. Unlike AM4 tools, generic primitives don't
    *require* an ack to succeed — a `send_cc` call with no echo
    is normal, not an error. So the primitives don't participate
    in the "missing ack → warn user" pattern that AM4 tools use.
  - Primitives live in a new `src/protocol/generic/` directory
    so they're obviously portable. When BK-012 splits into
    packages, these become `packages/midi-core/`.
- **Session breakdown:**
  1. **Session A — Registry + generalized list/reconnect. ✅
     Shipped Session 30 cont 5.**
     Connection layer is now keyed by `label`
     (`connections: Map<string, RegistryEntry>` in
     `src/server/index.ts`); the default label `"am4"` keeps every
     existing AM4 callsite identical. `MidiConnection` type and
     `connect({ needles, notFoundLeadIn?, notFoundHints? })` live
     in `src/protocol/midi.ts`; `connectAM4()` is a thin wrapper.
     `list_midi_ports` accepts optional `pattern`; `reconnect_midi`
     accepts optional `port`. `looksLikeAM4` stays as a back-compat
     field on `MidiPortInfo` alongside the new generic `matched`.
     Tool count unchanged (17). Preflight green; smoke covers the
     new pattern arg.
  2. **Session B — Send primitives (cc, note, program_change,
     nrpn, sysex). ✅ Shipped Session 30 cont 6.** Five new MCP
     tools registered in `src/server/index.ts`; pure message
     builders live in `src/protocol/generic/midiMessages.ts`.
     Tool count 17 → 22 (one above the original spec target
     because the AM4 server also has `lookup_lineage` from a
     later session). Channel convention: 1..16 at the tool
     boundary, 0..15 internally. send_* primitives bypass the
     AM4 stale-handle counter — most non-Fractal devices don't
     echo writes. 8 new smoke assertions covering happy paths
     against a bogus port (proves wiring) plus Zod / framing /
     range rejections.
  3. **Session C — Docs + examples. ✅ Shipped Session 30 cont 7.**
     README rewritten with a two-table tool catalog (17 AM4-specific
     + 5 generic-MIDI primitives) and a new **Generic MIDI
     quick-start** section: five conversational examples paired
     with the literal tool-call shape (filter cutoff via CC 74,
     single-note trigger, bank-select-prefixed Program Change,
     14-bit NRPN, raw SysEx). Examples target a Hydrasynth so
     the generality is obvious; the SysEx example targets the
     AM4 to show the escape hatch is bidirectional. Tool-
     description audit was already satisfied at write time
     (every send_* tool leads with the standard call-to-action
     template). `docs/MCP-SETUP.md` had a stale "3 tools" line
     in the Connectors discovery section; updated to 22.
- **Dependencies + relation to other items:**
  - **BK-029** — blocker. Rename lands after this ships so the
    new name isn't aspirational.
  - **BK-012** — big win. The protocol split becomes cleaner
    because `src/protocol/generic/` is obviously the future
    `midi-core` package boundary.
  - **BK-031 (Hydrasynth)** — consumes BK-030 immediately.
    The Hydrasynth's entire CC/NRPN-addressable surface is
    usable through `send_cc` / `send_nrpn` on day one, before
    a single Hydrasynth-specific tool exists. That makes
    BK-031's early sessions mostly about schema wrappers
    ("set_hydrasynth_filter_cutoff" as sugar around
    `send_cc(port, channel, 74, value)`), not protocol RE.
  - **BK-014 (Axe-Fx II)** — benefits. Axe-Fx work can use
    `reconnect_midi` with a different port pattern without
    forcing `connectAxeFx()` to diverge from `connectAM4()`
    at the wrapper layer.
  - **BK-017 to BK-020 (Roland/Boss)** — unblocked for basic
    control. Any Roland device with a published CC chart is
    controllable through `send_cc` before a device-specific
    package exists. The device package then becomes schema
    sugar, not raw-protocol work.
- **When to schedule.** Ahead of BK-029 (rename) and BK-014
  (Axe-Fx II). Estimated 2–3 Claude sessions, no hardware
  dependency.
- **Non-goals:**
  - Sequenced / timed playback (`play_pattern`, clock transport
    control). Interesting but out of scope for primitive tools
    — belongs in a higher-level "performance" tool set, TBD.
  - MIDI input capture / listening. The MCP tool shape is
    request/response; streaming input back to the LLM needs
    a different pattern and probably waits for MCP
    bidirectional transport maturity.
  - Device-specific param names. Those live in device packages
    (AM4, Hydrasynth, Axe-Fx II), not here.

### BK-031 Hydrasynth Explorer support (replaces JD-Xi in founder's collection)

- **Context.** Founder's next synth purchase (replacing the JD-Xi
  in their collection). ASM Hydrasynth Explorer: 8-voice, 3
  oscillators, 2 filters, 5 envelopes, 5 LFOs, 4 Mutators,
  8 Macros, 32-slot mod matrix, arp + effects. Keytar form
  factor (scaled-down variant of the Hydrasynth Keyboard /
  Desktop / Deluxe). Owner's manual shipped locally at
  `docs/manuals/other-gear/Hydrasynth_Explorer_Owners_Manual_2.2.0.pdf`.
- **MIDI depth (researched 2026-04-19).** **Extraordinarily
  editable over public MIDI, zero RE required for most of the
  engine.** Summary:
  - Full MIDI CC chart published (manual pp. 94–96). Every major
    synthesis parameter has a dedicated CC number: all 3 oscs
    (wavscan, cent, FRate, vol, pan), both filters (cutoff, res,
    type, drive, keytrack, vel-env, ENV1amt, LFO1amt each),
    all 5 envelopes × 4 stages, all 5 LFOs × gain/rate, all 4
    mutators × ratio/depth/dry-wet, 8 macros, pre-FX, post-FX,
    delay, reverb, arp, voice.
  - NRPN mode toggle (`MIDI Param TX/RX = NRPN`, manual p. 82)
    sends the same param set at higher resolution. Enables
    14-bit addressing for precise edits.
  - SysEx patch dump / receive exists ("Send Patch / All
    Patches" actions, manual p. 82) but **ASM does not publish
    the SysEx patch format.** RE required for patch-as-data
    work. Not needed for edit-oriented tools.
  - Program Change + Bank Select (CC 0 MSB / CC 32 LSB) for
    patch switching across all 8 banks A–H. Documented.
  - MPE support. Out of scope for MVP but future.
- **Why this device now.** BK-030 primitives make it accessible
  immediately — every CC and NRPN is addressable via the
  generic tools with zero Hydrasynth-specific code. The device-
  specific package adds schema sugar + lineage, not raw
  protocol work. That makes BK-031 one of the lowest-effort
  devices on the roadmap to add with real depth.
- **Deliverable (MVP):**
  - Schema module `src/knowledge/hydrasynth/params.ts` — every
    CC from the manual chart, with `{ module, name, cc, nrpn?,
    range, unit }`. Extracted from the manual's CC chart table
    (already in-repo as the extracted .txt).
  - Optional NRPN map — if the manual documents the NRPN
    numbers explicitly, populate alongside each CC entry. If
    not, ship CC-only for v1 and queue NRPN RE as a follow-up
    (worst case: one capture session with any MIDI monitor tool
    + the Hydrasynth in NRPN TX mode).
  - Tool set (schema sugar over BK-030 primitives):
    - `set_hydrasynth_param(port, module, name, value)` —
      looks up CC, calls `send_cc` (or `send_nrpn` if caller
      passes `high_res: true`).
    - `list_hydrasynth_params(module?)` — enumerate the
      param registry, optionally filtered by module.
    - `switch_hydrasynth_patch(port, bank, program)` — bank
      select MSB/LSB + PC, wraps `send_program_change`.
    - `list_hydrasynth_patches()` — reads the factory patch
      listing xlsx (`docs/manuals/other-gear/Hydrasynth_Single_Factory_Patch_Listing_2.0.xlsx`,
      already in-repo) and returns `[{ bank, program, name,
      category, author? }]`. One-time parse baked into a
      generated JSON.
    - `lookup_hydrasynth_patch(query)` — fuzzy search over the
      factory listing ("pad", "pluck", "Blush Response's
      ambient stuff"). Optional, stretch goal — depends on
      how rich the xlsx metadata is.
- **Sessions (rough):**
  1. **A — Param registry.** Parse the CC chart out of the
     extracted manual text. Emit `params.ts`. Sanity check a
     handful of entries by hand (Filter 1 Cutoff = CC 74,
     Macro 1 = CC 16, etc.).
  2. **B — Device tool set.** Register 4–5 MCP tools. Smoke-
     server assertions for validation (invalid bank, out-of-
     range value, unknown param name). No hardware required.
  3. **C — Patch-listing ingestion.** Parse the xlsx into
     JSON; build `list_hydrasynth_patches` + optional
     `lookup_hydrasynth_patch`. If the xlsx has thin metadata
     (name-only), defer `lookup` to a later session.
  4. **D — Hardware validation.** Founder plays through
     Claude: "set filter 1 cutoff to 80," "switch to the pad
     bank," "make the attack longer across all envelopes."
     Validates the CC path end-to-end. Founder-time only;
     no Claude RE work.
  5. **E (stretch) — SysEx patch format RE.** If the Hydrasynth
     community has published partial decodes (Surge XT, Dexed-
     style editors, forum threads), pick up the format and add
     `dump_hydrasynth_patch` / `upload_hydrasynth_patch`. If
     not, queue as a dedicated future item.
- **Dependencies:**
  - **BK-030** — hard prerequisite. No point writing
    Hydrasynth tools against a connection layer that assumes
    a single AM4 handle.
  - **BK-029** — project-rename lands before this is
    public-facing. Device-specific package naming
    (`hydrasynth-protocol`, `hydrasynth-mcp-tools` or similar
    per the BK-012 layout) assumes the new project name.
  - **BK-012** — clean package boundaries help but not
    strictly blocking; can land `src/protocol/hydrasynth/`
    as a sibling to `src/protocol/am4/` in the interim and
    extract during the split.
- **When to schedule.** After AM4 stabilizes + BK-014 (Axe-Fx
  II) progresses — per founder's stated device priority (AM4 →
  Axe-Fx II → Hydrasynth). Approximate effort: 3–4 sessions +
  one founder hardware-validation session. No capture-based RE
  (unlike Fractal devices) — the manual is the primary source.
- **Founder context.** Hydrasynth is the founder's first deep-
  dive into synthesis from scratch (guitar + amp background).
  Tool descriptions should lean on synthesis concepts as
  pedagogy — "Filter 1 cutoff: low values close the filter,
  making the sound darker / muffled; raise it for brightness"
  — rather than assuming synth vocabulary. That helps the
  founder's learning curve and makes the tools friendly to
  other first-time synth owners too.
- **Non-goals (v1):**
  - Multi-Hydrasynth Overflow mode (manual p. 83) — niche.
  - Microtonal scale uploads — deferred to a later item.
  - MPE routing — deferred.
  - The Hydrasynth Deluxe's multi-patch mode (the Explorer is
    single-patch only, so this simplifies scope).
- **Relation to JD-Xi (BK-020).** Founder is replacing the
  JD-Xi with the Hydrasynth for their own collection. BK-020
  stays on the backlog as a *community-support* item — JD-Xi
  is still an interesting target (Roland published its MIDI
  Implementation) but is no longer validated on the founder's
  own hardware. Demote BK-020 from "likely first Roland
  target" to "future community contribution, founder-hardware
  validation unavailable."

### BK-032 AM4-Edit first-page coverage — release-gate scope

- **Context.** Scoped 2026-04-21 by founder direction during Session
  29 wrap-up. When asked whether we're on track to support "all amp
  block settings" before release, the agreed target became more
  precise: **every parameter visible on AM4-Edit's first page for
  every block type.** The rationale: first-page knobs are the primary
  controls an intermediate-to-advanced user reaches for; deeper
  Advanced-page params are power-user territory and post-MVP.
  Front-page knobs vary by block TYPE (e.g. Spring reverb has Number
  Of Springs / Spring Tone / Spring Drive / Boiiinnng!, while Plate
  reverb has Plate Size / Diffusion / Crossover Freq / Low + High
  Freq Time / Early + Late Level) so coverage is per-block-per-type,
  not flat.
- **Why.** Release marketing is "Claude can control your AM4 in
  natural language." If a user says *"add some boiiinnng to the
  spring reverb"* and the tool doesn't know what Boiiinnng is, the
  MCP is below the bar. First-page knobs capture the vocabulary a
  guitarist uses.
- **Current state (per `src/protocol/params.ts`, 2026-04-21):**
  - **Amp** ✅ front-panel complete (Session 29). Advanced page is
    post-MVP per CLAUDE.md section "What's still deferred".
  - **Reverb** ✅ first-page complete (HW-018 / Session 30). 10 new
    registers landed: high_cut / low_cut / input_gain / density /
    dwell / stereo_spread / ducking / quality / stack_hold / drip.
    One register (`pidHigh=0x0000`, likely `reverb.level`) deferred
    to HW-026 as a low-priority disambiguation.
  - **Drive** 🟡 partial — Type / Drive / Tone / Level / Mix +
    Balance + Channel registered. EQ 1 + Advanced page (Low/High
    Cut, Bass/Mid/Treble, Clip Type, Bias) missing. HW-019 closes.
  - **Delay** 🟡 partial — Type / Time / Mix / Feedback +
    Balance + Channel registered. Master Feedback, Drive, Bit
    Reduction, Echo Pan, Spread, Tempo missing. HW-020 closes.
  - **Compressor** 🔴 minimal — only Type / Mix / Balance. Threshold,
    Ratio, Attack, Release, Knee, Auto Makeup, Detector Type
    missing. HW-021 closes.
  - **Chorus / Flanger / Phaser / Tremolo** 🟡 partial — Type /
    Rate / Depth / Mix + Balance for each. Tempo (BPM-sync),
    Manual (flanger/phaser), LFO Type, Voices (chorus) missing.
    HW-022 closes.
  - **Wah / Filter / Gate / GEQ** 🔴 minimal — only Type + Balance
    (+ Filter Freq). HW-023 closes.
- **HW tasks queued (see `docs/HARDWARE-TASKS.md`):** optimized 2026-
  04-21 cont to one-pcapng-per-block with sequential wiggles — each
  knob produces a unique pidHigh transition in the wire; the
  decoder aligns them to the BG Basic Page order listed in each
  task. Total capture count: **13** (was 58 with per-knob files).
  - HW-018 Reverb — 2 captures (Hall + Spring) ✅ Session 30
  - HW-019 Drive — 1 capture (TS808)
  - HW-020 Delay — 1 capture (Digital Mono)
  - HW-021 Compressor — 1 capture (Studio FF + Optical end)
  - HW-022 Modulation — 4 captures (chorus / flanger / phaser /
    tremolo, one per block since each has its own pidLow)
  - HW-023 Secondary — 4 captures (wah / filter / gate / GEQ)

  **Why not fewer captures?** Binary inspection of AM4-Edit.exe
  (Session 29 cont 5) confirmed the knob labels are NOT stored as
  plain strings anywhere on disk — not in the exe, not in
  english.laxml, not in effectDefinitions_15_2p0.cache, not in
  existing inbound SysEx traffic. Wire captures are the only
  deduction path. The 58→13 optimization comes from batching knobs
  per block; 13 is the floor for this methodology given one block
  (with its own pidLow) per capture.
- **Priority order.** HW-018 → HW-019 → HW-020 → HW-021 → HW-022 →
  HW-023 (by block popularity). Each is cheap capture-wise
  (5–15 min per block group); the founder can batch them across
  multiple short sessions or do one long sweep.
- **Definition of done.** All HW-018..HW-023 tasks complete and
  their captures decoded into `KNOWN_PARAMS` + `verify-msg`
  goldens. verify-cache-params stays 100% byte-matching. STATE.md
  reflects new param count and BK-032 flips to ✅. Then Wave 1
  device expansion (BK-030 / BK-029 / BK-014 / BK-031) is
  formally unblocked.
- **Relation to HW-014 / HW-024 / HW-025 and HW-017.** HW-014
  (Session D structurally-decoded spot-check) closed Session 29
  cont 7 with 28 verified + 5 bugs; remaining coverage queued
  as HW-024 (Round 4 + re-tests) and the bug-fix work as BK-033
  + BK-034 (driven by HW-025 captures). HW-017 (count-type
  disambiguation) gets partially absorbed into HW-020 (resolves
  delay id=64 via Bit Reduction capture), HW-022 (resolves
  phaser id=22 via Order capture), and HW-023 (resolves filter
  id=28 via Order capture). The remaining HW-017 items (drive
  id=24, gate id=14) can stay as a separate low-priority bucket.
- **Relation to AM4-depth-gate.** Was previously informally "amp
  depth + the structurally-decoded params." BK-032 formalizes the
  full scope across every block. The Wave 1 device expansion
  (BK-014 Axe-Fx II, BK-031 Hydrasynth) remains gated on BK-032
  clearing.

### BK-033 `reverb.predelay` dead-address fix ✅ (closed Session 30)

- **Closed 2026-04-25** — HW-025 capture #1
  (`session-30-reverb-predelay.pcapng`, Pre-Delay → 85 ms) revealed
  AM4-Edit writes to `pidLow=0x0042 / pidHigh=0x0013` with
  `float32(0.085)`. The cache id=16 record we'd been using
  (`pidHigh=0x0010`) was structurally plausible (range 0..0.25s,
  scale ×1000) but firmware-dead — writes ack and disappear.
- **Fix landed.** One-byte address swap in `params.ts`; existing
  `unit: 'ms'` ÷1000 scale is correct. `paramNames.ts` cache
  mapping `16: 'predelay'` removed so the auto-generator no
  longer emits the wrong cacheParams entry; predelay is now
  hand-authored in `KNOWN_PARAMS` only. Byte-exact `verify-msg`
  golden anchors the new address. See SYSEX-MAP §6j and
  SESSIONS.md Session 30 for the full decode.

### BK-034 Per-block float encoding divergence (4-param cluster) ✅ (closed Session 30 — not-a-code-bug)

- **Closed 2026-04-25 — proven not a wire-layer bug.** HW-025
  captures #2..#5 showed AM4-Edit's wire is **byte-identical**
  to our builder's output for the four disputed params (modulo
  the benign action=0x0001 vs 0x0002 quirk documented in
  SYSEX-MAP §6i). Capture summary:

  | Param | AM4-Edit wire | Display value |
  |---|---|---|
  | `chorus.rate` | `0x004e/0x000c`, `float32(3.4)` | 3.4 Hz |
  | `flanger.mix` | `0x0052/0x0001`, `float32(0.54)` | 54% |
  | `flanger.feedback` | `0x0052/0x000e`, `float32(-0.61)` | -61% |
  | `phaser.mix` | `0x005a/0x0001`, `float32(0.88)` | 88% |

  Our `params.ts` entries already produce these exact bytes.
  HW-014's hardware-display readbacks (3.4→0.5 Hz / 54%→50% /
  -61%→0% / 88%→53%) therefore can't be encoding bugs in our
  code. Most likely explanation is an **AM4 hardware-screen
  rendering quirk** for those specific block+knob combos —
  AM4-Edit displays the values correctly. Possible alternative
  is a HW-014 readback channel-state artifact, but the wire
  equivalence is decisive.
- **Resolution.** All four `params.ts` entries keep their
  existing addresses and units. Comments updated to remove the
  BUG flags and record the wire-equivalence finding. Four new
  byte-exact `verify-msg` goldens lock the wire bytes. Going
  forward, verify these four params via AM4-Edit, not the AM4
  hardware display, until the screen-side rendering is
  characterised. The "Option A (per-param encode/decode
  overrides)" plumbing originally proposed for this fix is
  unnecessary and not implemented. See SYSEX-MAP §6j and
  SESSIONS.md Session 30 for full detail.
- **Open follow-up (low priority).** Characterise the AM4
  hardware-screen rendering quirk so future HW-014-style
  spot-checks know what to expect when reading these knobs from
  the hardware display. Could be queued as a future research
  item but doesn't block release — AM4-Edit is the
  authoritative readback for these four params.

### BK-035 AM4 tool-description UX polish — research first, then maybe ship

- **For:** evaluate whether porting the Hydrasynth-explorer session's
  tool-description improvements (Session 2026-04-27 / 28) helps the AM4
  workflow. Three candidate fixes; **the third is risky and explicitly
  requires evaluation before shipping.**

- **Context — what we shipped on hydrasynth-explorer.** Three changes
  collapsed multi-minute Tom-Petty-recipe runs to single-batch
  end-to-end:
  1. Embedded a ~50-name cheat-sheet directly in the engine-param
     tool descriptions, with explicit "DON'T pre-discover names"
     guidance.
  2. Added a fuzzy-ranked search across canonical names + aliases +
     notes; surfaced as smart suggestions in error responses AND as
     a query-aware fallback `hydra_param_catalog` tool.
  3. **Demoted / replaced the legacy `hydra_list_params` tool**
     (117 CCs only, no NRPN coverage, structurally redundant).

- **Why it might apply to AM4.** The AM4 server has 22 tools; the
  same defensive `list_params` calls before patch builds happen
  there too. AM4 already has `resolveEnumValue` (so
  `amp.type="Brit Hi 1"` works) and Unit-typed display-to-wire
  conversion (no auto-scale needed), so two of the four
  Hydrasynth-side fixes don't translate. The remaining three —
  cheat-sheet, smart errors, demote/replace `list_params` —
  conceptually fit.

- **The risk on AM4 specifically — flagged by founder
  2026-04-28.** Demoting `list_params` could regress AM4 tone
  matching. AM4's KNOWN_PARAMS catalog is 132 entries, smaller
  than Hydrasynth's 1175, and gets used in more diverse / less
  predictable patch-design conversations than Hydrasynth's 50ish
  common knobs. If a cheat-sheet doesn't cover the param Claude
  reaches for, AND the fuzzy error suggestions miss, AND
  list_params is demoted to "fallback only" — Claude might
  hallucinate plausible-sounding but wrong names, or just give up.
  On Hydrasynth this risk is bounded by the 95% cheat-sheet
  coverage; on AM4 the long-tail patch-design vocabulary might
  reach further into the catalog.

- **Required before any code change — research + evaluation.**
  Don't just port the changes blindly. Specifically:
  1. **Audit existing AM4 tool descriptions** in
     `src/server/index.ts` to see what's already there. The AM4
     server is more mature than the Hydrasynth side; some of
     these fixes may already exist in some form.
  2. **Sample real AM4 patch-design conversations** (Tom Petty,
     Neil Young, Allman Brothers, etc. — pick 4-5 archetypal
     prompts) and watch how Claude builds them on the CURRENT
     description set. How many `list_params` calls does it make?
     Is it picking right names from intuition or verifying first?
  3. **Hypothesis test**: prepare a branch with the cheat-sheet
     embedded but `list_params` NOT yet demoted. Run the same
     conversations. Did the cheat-sheet alone cut the
     `list_params` calls? If yes → cheat-sheet is the load-bearing
     fix and list-tool demotion may be overkill.
  4. **Then decide on demotion**. If list_params is still being
     called pathologically AFTER the cheat-sheet, evaluate whether
     the catalog tool + smart errors actually cover the calls
     it's making. If not — keep `list_params` in current shape;
     just improve descriptions and error suggestions.

- **Acceptance criteria for shipping (any subset):**
  - Cheat-sheet: shipped if it measurably reduces `list_params`
    calls in 4 of 5 sample conversations without increasing
    "unknown parameter" errors.
  - Smart errors: shipped if fuzzy match resolves the same
    misses that current dumb-substring catches, plus more.
  - List_params demotion / replacement: shipped only if (a)
    cheat-sheet alone doesn't kill the defensive calls AND
    (b) the proposed catalog/error replacement covers every
    real-world call observed in the audit. Default to
    keeping it.

- **Pragmatic order if the research says yes:** ship the
  cheat-sheet + smart errors as separate commits (low risk,
  reversible). Hold the list_params demotion separately;
  ship only with explicit evidence it's net-positive.

- **Estimate:** research + sampling ~1 hour. If shipping all
  three: another ~2 hours. If shipping cheat-sheet + smart
  errors only: ~45 min.

- **Priority:** medium — UX polish, not protocol/release-gate
  work. Queue for after BK-032 first-page coverage closes (the
  remaining HW-037 enhancer screenshot is the only thing left
  there).

### BK-036 Hydrasynth SysEx patch flow — atomic single-message batch + `.hydra` loading

- **For:** unblock three related Hydrasynth use cases that all need
  the same underlying SysEx infrastructure:
  1. **Atomic patch writes** — send a complete patch as ONE
     ~3.3 KB SysEx message instead of 100+ NRPN sequences.
     ~3 ms wire time vs ~300 ms; no drop-risk; eliminates
     pacing concerns entirely.
  2. **`.hydra` file loading** — read patches from `.hydra` /
     `.patch` files (per BK-NNN .hydra-decoder backlog) and
     push them via SysEx instead of decomposing into NRPN
     calls.
  3. **Slot-targeted writes** — write to a stored patch slot
     (Bank A–H, program 0–127) without disturbing the
     working buffer. NRPN can't do this — it only edits the
     currently-loaded patch.

- **Founder's stated priority (2026-04-28).** "Want this sooner
  rather than later because I originally wanted .hydra support
  and we should always prefer batch approaches with hardware
  latency in mind." Ship after the next 1–2 hardware test
  rounds confirm the freshPatch merge-batch approach is
  sufficient for live patch building; SysEx is the proper
  permanent solution.

- **Source material — already vendored.**
  - `docs/devices/hydrasynth-explorer/references/SysexEncoding.txt`
    (695 lines, edisyn) — full envelope spec: `F0 00 20 2B 00 6F
    …DATA… F7`, base64-encoded payload, 4-byte CRC-32. Documents
    the handshake / patch-request / chunked-dump / write / bank-
    name flows with literal byte traces.
  - `docs/devices/hydrasynth-explorer/references/SysexPatchFormat.txt`
    (2906 lines, edisyn) — byte-offset map of the 2462-byte
    decoded patch. Every parameter's slot. Reference Java code
    in `references/ASMHydrasynth.java`'s `Decode.java` /
    `Encode.java`.

- **Order of operations (estimated 2–3 focused sessions).**

  1. **SysEx envelope module** (~1 session). New file
     `src/devices/hydrasynth-explorer/sysexEnvelope.ts`:
     - `wrapSysex(payload: Uint8Array): number[]` — produces the
       full F0…F7 message: header, base64 payload, CRC-32, footer.
     - `unwrapSysex(msg: number[]): Uint8Array` — reverse.
     - CRC-32 over the data block (one-liner with bitwise math
       or import from `node-crc`).
     - Base64 encode/decode (built-in `Buffer`).
     - Test harness producing byte-exact output against edisyn's
       documented examples.

  2. **Patch byte-map encoder** (~1 session). New file
     `src/devices/hydrasynth-explorer/patchEncoder.ts`:
     - `encodePatch(params: Map<canonicalName, number>): Uint8Array`
       — 2462-byte patch buffer, every parameter at the offset
       documented in SysexPatchFormat.txt.
     - Generated from a hand-curated mapping of canonical NRPN
       names → patch byte offsets. (NOT auto-generated from the
       2906-line spec — too noisy. Hand-pick the ~100-200 params
       that map cleanly; everything else stays at INIT defaults.)
     - `decodePatch(buf: Uint8Array): Map<canonicalName, number>`
       — reverse, for reading patches from device or `.hydra`
       files.

  3. **MCP tool surface** (~1 session, depends on 1+2).
     - `hydra_apply_patch({ params: [...], slot?: 'A001' })` —
       atomic patch send via SysEx. With `slot`, writes to the
       stored slot; without, writes to the working buffer.
     - `hydra_request_patch({ slot?: 'A001' })` — query device
       for its current patch (working buffer or stored slot),
       parses the response, returns the param map.
     - `hydra_load_hydra_file({ path: '...' })` — reads a `.hydra`
       file, extracts each `.patch`, sends via SysEx.
     - Existing `hydra_set_engine_params` stays — useful for
       single-knob tweaks. The new batch path is for whole-patch
       work.

  4. **Hardware verification.** Round-trip tests: build a patch
     via NRPN → save → request via SysEx → assert byte-equality.
     One full bank-load test against a vendor `.hydra` file.

- **Why this maps to founder's request.** The "always prefer batch
  with hardware latency in mind" framing is exactly what SysEx
  delivers — one wire message instead of 100, atomic, drop-free.
  The `.hydra` use case becomes trivial once this lands (just
  SysEx-wrap each `.patch` file and send).

- **Ship order with `freshPatch` already shipped.** `freshPatch`
  is the interim — covers the "fresh recipe" use case with
  acceptable latency (~300 ms). SysEx replaces it for fresh-patch
  builds AND opens up the slot-write + `.hydra` flows. Once
  SysEx lands, `freshPatch` can be deprecated to a thin alias
  that constructs an INIT_PATCH-merged param map and calls
  `hydra_apply_patch`.

- **Risk: front-panel envelope mismatch.** Edisyn's notes flag
  that the device's front-panel "Send Patch" / "Send Bank"
  buttons emit a non-standard `F0 01…` / `F0 02…` envelope
  that edisyn declined to RE. Our flow uses the documented
  `F0 00 20 2B 00 6F` envelope per the spec — different code
  path, should work, but needs hardware verification on first
  send. If it doesn't, the workaround is to RE the front-panel
  envelope from a USBPcap capture of ASM Manager doing a
  Save-Patch operation.

- **Priority — escalated to P0 (2026-04-28).** `freshPatch` did
  NOT prove sufficient. Hardware testing post-BK-037 confirmed
  silence persists from causes the NRPN prelude can't address —
  most likely INIT_PATCH disabling factory mod-matrix routings
  (e.g. env1 → DCA amp), but exact root cause not pinned because
  the founder explicitly chose to stop debugging the NRPN prelude
  and pivot to SysEx as the durable solution. SysEx eliminates
  the bleed-through whack-a-mole entirely: a complete patch is
  sent atomically, every parameter at a known value, no prelude
  to debug. INIT_PATCH retires once SysEx lands.

- **Pivot decision (2026-04-28).** Founder confirmed: stop
  investigating INIT_PATCH bugs; ship BK-036 instead. Iconic-tone
  testing pauses until SysEx lands (~2-3 sessions of work).

- **What survives from BK-037:**
  - **Bipolar auto-scale** (encoding.ts) stays — benefits every
    single-knob NRPN tweak (`filter1cutoff = 90`, etc.), which is
    the natural conversational flow even when SysEx is the
    patch-build primitive. The bipolar flag carries through to
    SysEx encoding too (display values still need signed semantics
    in the patch byte map).
  - **`hydra_apply_init` tool** stays as the recovery primitive
    but rewires under the hood: instead of sending the 99-write
    NRPN prelude, it sends a known-good default *patch* via
    SysEx (~3 ms wire time vs ~300 ms, audible-by-construction
    since every byte is set explicitly).

- **What retires when BK-036 ships:**
  - `INIT_PATCH` template (`initPatch.ts`) — replaced by a
    default patch buffer encoded once via `encodePatch`.
  - `freshPatch: true` flag on `hydra_set_engine_params` —
    deprecated; recipe-style requests route through
    `hydra_apply_patch` instead. Or kept as a thin alias that
    builds an init-merged param map and calls
    `hydra_apply_patch`.
  - BK-037 deliverable 6 (filter2 / amp-vel INIT_PATCH expansion)
    — never built. Subsumed by SysEx covering all 1175 params.

### BK-037 Hydrasynth bipolar-aware auto-scale + INIT_PATCH safety — 🟡 partially shipped, remainder superseded by BK-036

- **Status (2026-04-28):** Deliverables 1, 2, 3, 4, 5 shipped.
  Deliverable 6 (INIT_PATCH expansion for filter2/amp-vel) and
  any further INIT_PATCH bug-hunting (e.g. mod-matrix routings)
  are **abandoned** in favor of BK-036's SysEx patch flow, which
  eliminates the prelude entirely. Hardware validation revealed a
  third silence cause (likely mod-matrix targets disabling
  factory routings) that was not pinned down before the pivot —
  it's irrelevant once the NRPN prelude retires.

- **What shipped (still in production):**
  - `displayMin` / `displayMax` flagged on 483 bipolar registry
    entries (gen-nrpn.ts auto-detection).
  - Bipolar-aware `resolveNrpnValue` — value 0 → wire-center for
    bipolar params; signed offsets for ±N. Carries forward to
    BK-036 since SysEx patch encoding still needs signed display
    semantics for the same params.
  - `hydra_apply_init` MCP tool (currently sends INIT_PATCH;
    rewires under BK-036 to send a SysEx default patch).
  - `params: minItems: 0` schema relax + runtime guard.
  - 13 new bipolar goldens in `verify-encoding.ts`.

- **What's abandoned (do not implement):**
  - Deliverable 6 — filter2/amp-vel INIT_PATCH expansion.
  - Mod-matrix-target investigation — factory routings get
    re-installed when SysEx sends a complete patch, so the
    "INIT_PATCH disables critical routes" problem evaporates.
  - Any further INIT_PATCH bug-hunting.

- **Original problem statement preserved below for context.**
  Surfaced 2026-04-28 during Van Halen "Jump" silence diagnosis.
  Two distinct bipolar-related defects landed the device in
  unrecoverably-silent state from `freshPatch: true` alone.

- **Root cause confirmed on hardware** (2026-04-28, Session
  post-Van-Halen):
  - The auto-scale rule (`wire = round(value × wireMax / 128)`) is
    correct for unipolar params (display 0..N). For bipolar params
    (display −N..+N centered at wire `wireMax/2`), value 0 maps to
    wire 0 = max NEGATIVE display, not center.
  - INIT_PATCH writes `value: 0` to two bipolar params intending
    "neutral":
    - `filter1env1amount` → display **−64** (envelope slams filter
      shut on every note; user-confirmed `Filter1.ENV1amt = -64.0`
      on device).
    - `filter1keytrack` → display **−200%** (cutoff drops 200% per
      octave; user-confirmed `KEYTRACK = -200%` on device).
  - Compounding effect: prelude sets cutoff = 128, then yanks
    cutoff down by 64 (env mod) and again by up to 200% (keytrack)
    on any note above the keytrack reference. Result: silent or
    near-silent across the full keyboard.
  - Diagnosis confirmed by isolating prelude-only via
    `hydra_set_engine_params({ params: [{name: "osc1type", value:
    "Sine"}], freshPatch: true })` — the no-op overlay leaves only
    the prelude, which silenced an INIT-baseline patch.
  - Same trap is dormant for any user write to a bipolar param
    (env amounts, pan, keytrack, mod-matrix depth, etc.). The
    Van Halen "Jump" silence Claude couldn't recover from in
    Session 4 (2026-04-28) had this as one of two layered causes.

- **Deliverables:**

  1. **Bipolar-aware auto-scale.** Add a `bipolar?: true` flag to
     registry entries whose display range is signed. Sweep
     `nrpn.ts` for notes containing `[-`, `2's complement`,
     `centered`, signed-range patterns; tag each entry. Estimated
     30–60 entries (pan, keytrack, env amounts, glide signed
     values, mod-matrix depths, vibrato depth in some cases).
     When `bipolar: true`, auto-scale becomes:
     - value 0   → wire = `wireMax / 2`     (display 0, no mod)
     - value +N  → wire = `wireMax/2 + round(N × (wireMax/2) / N_MAX)`
     - value -N  → wire = `wireMax/2 - round(N × (wireMax/2) / N_MAX)`
     where `N_MAX` is the display-side maximum (64 for env amount,
     200 for keytrack, etc.). Either store `displayMax` in the
     registry or derive a per-entry signedness convention.

     Alternative: refuse to auto-scale bipolar params and require
     raw wire values (`wireMax/2 ± offset`). Less ergonomic but
     simpler. Lean toward auto-scale + bipolar flag for symmetry
     with unipolar.

  2. **Fix the two confirmed INIT_PATCH bugs.** Once (1) lands,
     `filter1env1amount = 0` and `filter1keytrack = 0` resolve
     correctly. Add golden tests asserting both produce
     wire 4096 (display 0), not wire 0 (display −64 / −200%).

  3. **`hydra_apply_init` recovery tool.** Sends INIT_PATCH only,
     no user params, ~300ms wire time. Recovery primitive when an
     agent paints itself silent. Tool description should call out:
     *"use this when the device has gone unexpectedly silent after
     recipe writes — restores audible-saw default state."* Always
     audible by construction (single sine osc, max mixer vol,
     filter wide open, env1 sustain max, all FX bypassed, no
     bipolar mod routing post-fix).

  4. **Relax `params: minItems: 1` on `hydra_set_engine_params`**
     when `freshPatch: true`. Lets debug callers send prelude-only
     batches without the no-op-param workaround. Pure schema
     change.

  5. **Audit registry for missed bipolar entries.** Sweep
     `nrpn.ts` notes for signed-range markers; tag each entry's
     `bipolar` flag and `displayMax`. Estimate: 30–60 entries.
     Outputs feed (1) and (6).

  6. **Expand INIT_PATCH coverage** for filter2 (`filter2env1amount`,
     `filter2keytrack`, `filter2drive`, `filter2env1velsen`),
     amp velocity sensitivity, and any other bipolar params that
     can carry destructive values forward from a prior patch.
     Bleed-through path the current prelude doesn't close. Use
     (5)'s tagged registry to find candidates.

- **Test plan:**
  - Golden tests in `verify-encoding.ts` for every tagged bipolar
    param: assert value 0 → wire `wireMax/2` (display 0); value +N
    and −N → wire `wireMax/2 ± offset`.
  - Lock the two confirmed INIT_PATCH bugs in goldens so they
    never regress.
  - Hardware A/B: from device-INIT button, then
    `hydra_set_engine_params({ params: [...], freshPatch: true })`
    must remain audible. Bonus check: device shows
    `Filter1.ENV1amt = 0.0` and `KEYTRACK = 0%`.
  - Re-run Van Halen "Jump" recipe with `freshPatch: true` —
    should land cleanly without iterative-fix-then-INIT-button
    cycle. Update ICONIC-TONES.md results log row from 🟡 to ✅
    (or new ❌ if there's a third hidden cause).

- **Risk / non-obvious:**
  - Existing recipes that pass numeric values to bipolar params
    expecting unipolar behavior will change behavior. Document
    prominently in the tool description; possibly emit a
    `bipolar: true` annotation in the response so callers see it.
    Mitigated by limited recipe corpus so far (iconic-tones tests
    only) — small blast radius.
  - `hydra_apply_init` overlaps with `freshPatch: true` (no
    params). Both have their place: `apply_init` is the cleaner
    recovery primitive; `freshPatch` is the merge-overlay
    primitive. Keep both.
  - Auto-scale convention asymmetry: unipolar `value: 0` = off,
    bipolar `value: 0` = center. Risk of caller confusion. Tool
    description should make the convention loud and explicit, and
    the smart-error suggestion should say
    *"this is a bipolar param — value 0 = no modulation, ±N for
    signed offset"*.

- **Sequencing:**
  - (5) feeds (1). Run sweep first, then implement bipolar logic.
  - (1) → (2) — encoding correctness lands.
  - (3) + (4) independent, can ship together.
  - (6) last; benefits from (5)'s registry tagging.
  - Estimate: 1 session for (1)+(2)+(5); 0.5 session for (3)+(4);
    0.5 session for (6). Total ~2 sessions of focused work.

- **Priority:** P0. The current `freshPatch` prelude is a known
  destructive write — every `freshPatch: true` call silences the
  device. This is a regression-class bug, not a polish item. Ship
  before the next hardware test that uses `freshPatch`.

### BK-038 Hydrasynth `hydra_reconnect_midi` tool + sticky-error recovery

- **Status:** Open. Surfaced 2026-04-28 immediately after BK-037
  shipped, while attempting to validate the bipolar fix on hardware.

- **Problem.** The Hydrasynth Explorer MCP server has no equivalent
  to the AM4 server's `reconnect_midi` tool. Two failure modes
  observed in the same session:
  1. Server started while the synth was powered off / unplugged →
     `midiError` got cached at module level and stayed sticky for
     the full server lifetime. Every subsequent tool call threw
     "no Hydrasynth output port found", even after the device was
     reconnected. The user's only recourse was a full Claude
     Desktop restart (which respawns the server).
  2. Mid-session unplug + replug invalidates the cached handle but
     the server keeps using it (writes go to a dead handle). No
     way to force a refresh without restarting Desktop.

- **Comparison.** AM4 server (`src/server/index.ts`) has
  `reconnect_midi({ port? })` that closes the cached handle and
  reopens. Auto-recovers after `STALE_HANDLE_TIMEOUT_THRESHOLD`
  consecutive ack-less writes. Hydrasynth needs the same shape.

- **Deliverables:**
  1. **`hydra_reconnect_midi` MCP tool.** Inputs: optional `port`
     name needle (defaults to "hydra"/"asm" needles already used
     in `connectHydrasynth`). Behavior: closes current handle if
     open, resets both `midi` and `midiError` module-level
     variables, calls `connectHydrasynth()` fresh, returns the
     port enumeration so the caller sees what the server can
     find. On failure, returns the discovered port list so the
     user can pick a different needle.
  2. **`hydra_list_midi_ports` tool** (or fold into reconnect).
     Returns currently-visible MIDI input/output port names. Lets
     Claude diagnose "is the OS even seeing the device?" without
     attempting a write.
  3. **Sticky-error recovery.** When `midiError` is set, retry
     once on the next tool call instead of throwing immediately —
     transient enumeration delays at startup shouldn't permanently
     wedge the server. Track retry attempts so we don't spam
     `connectHydrasynth()` on every call when the device is
     genuinely absent.
  4. **Auto-reconnect after N ack-less writes** (mirrors AM4
     server's STALE_HANDLE_TIMEOUT_THRESHOLD). Less critical for
     Hydrasynth since NRPN writes don't ack — but a write-counter
     reset on next tool call is still useful for the unplug-replug
     case if we add round-trip detection later.

- **Test plan:**
  - Unit: open server with no device → first tool call throws but
    `midiError` is NOT sticky → call again with device connected →
    succeeds.
  - Manual: start server, call any tool (fails), connect device,
    call `hydra_reconnect_midi`, verify the next write lands.
  - Manual: mid-session unplug + replug + reconnect call sequence
    must restore writes without a Claude Desktop restart.

- **Risk / non-obvious:**
  - The current "sticky error" was probably defensive — re-trying
    `connectHydrasynth()` on every call would log noise if the
    device is genuinely absent. Mitigation: cache the failure
    timestamp and only retry if N seconds have passed, or if a
    `reconnect` was called explicitly.
  - node-midi's port enumeration requires a process restart on
    some platforms to pick up newly-connected devices. Test on
    Windows specifically — the user's primary platform — to
    confirm we can reuse an existing midi.Output() instance to
    rescan, or whether we need to instantiate a new one.

- **Priority:** P1. Doesn't gate hardware testing the way BK-037
  did — user can still validate fixes via a full Claude Desktop
  restart — but it adds significant friction every time the device
  is power-cycled or unplugged. Ship before the founder shares
  the tool with non-technical users (they will absolutely unplug
  things).
