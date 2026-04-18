# Product Backlog — AM4 Tone Agent

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

### P1-007 Extract per-block parameter ID space (incremental)
- For each block type on AM4, capture USB traffic while AM4-Edit
  manipulates each control.
- Map parameter IDs to human-readable names (cross-reference the Blocks
  Guide PDF for semantic labels).
- Store in `src/knowledge/<block>.ts` as structured TypeScript constants.
- Incremental — we only need the parameters a given preset actually uses.

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
  4. **Apply + save + name** — for each song, run `apply_preset` +
     `save_to_location` + `set_preset_name` in order. Fail-fast: halt
     on the first write that doesn't wire-ack and return partial
     progress (which locations landed, which didn't).
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
- Produce a single `am4-tone-agent.exe` that embeds the MCP server + bundled
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
  1. `list_midi_ports` MCP tool — list every MIDI port the server sees,
     directional, with names, so users can pick one by name and we can
     diagnose "AM4 not found" reports remotely.
  2. Graceful "AM4 not connected" error — first tool call should return
     a clear message (USB? driver? port auto-detect missed the device?)
     instead of a stack trace. List the ports actually seen and point at
     the `midi_port_name` override (P5-008) as the escape hatch. Extend
     the honesty already present in wire-ack language.
  3. Startup-banner log of detected ports to stderr (already present,
     just confirm it matches what `list_midi_ports` would return).
  4. README with install paths per client (Claude Desktop double-click,
     Claude Code `claude mcp add`, raw JSON config) and a "confirm it
     works" smoke flow ("ask Claude to place a compressor, watch AM4
     display update").
  5. Guardrail on `save_to_slot` — the Z04-only gate is P1-008's job to
     relax; confirm the error message points users at the right escape
     hatch once that ships.

### P5-010 License and trademark hygiene
- MIT or Apache-2.0 LICENSE file at the repo root.
- README disclaimer: unaffiliated community tool; "Fractal Audio" and
  "AM4" are Fractal's trademarks; this project controls a device the
  user owns via documented SysEx. Explicit non-endorsement language.
- Review any branding (logo, tool names, package name) for implicit
  endorsement cues before pushing to npm / a public release.

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

### BK-010 Scene support in `apply_preset` — ⏳ partial (switch decoded, per-scene payload still open)
- **Context:** AM4 has 4 scenes per preset for per-scene bypass +
  channel assignment. "Make this louder for the solo" is natural.
- **Decoded (Session 20 + Session 21):** scene-switch command —
  `pidLow=0x00CE / pidHigh=0x000D`, u32 LE scene index 0..3. MCP tool
  `switch_scene(scene_index)` shipped; hardware-test queued as HW-006.
  Scene-rename also shipped (BK-011). Scene-to-scene transitions now
  usable end-to-end.
- **Still open for BK-010's real goal:** extending `apply_preset` IR
  to carry per-scene bypass + channel state. The `apply_preset` shape
  should accept `scenes: [{ index: 1..4, bypass?: [...], channels?: {...} }]`
  and emit the correct write sequence. The per-scene bypass/channel
  commands are NOT decoded — we know scene index changes via switch,
  but the underlying "this block is bypassed in scene N" writes haven't
  been captured. Capture of AM4-Edit toggling bypass-per-scene is the
  next protocol step.
- **Prereqs:** per-block channel pidHighs need one capture each to
  confirm (we extrapolated from amp.channel in Session 08 but only
  amp is verified).

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
