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

### P1-008 Factory preset safety-classification table
- Compute a "factory fingerprint" for each of the 104 factory preset
  slots using the factory bank file.
- Store as `src/safety/factory-fingerprints.ts`.
- Used by the MCP layer's read-classify-backup-confirm-write flow.

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

### P3-007 Model lineage dictionary (translation layer)
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

### P4-001 List all slots with status
- Shows all 104 slots: name, type (factory/user/empty), last modified
- Formatted as compact table for readability

### P4-002 Bulk preset build from setlist
- Input: list of songs
- Claude builds all presets, assigns to consecutive slots
- Single confirmation for the whole batch
- Example: "I'm doing a 311 set — Amber, Down, Creatures, All Mixed Up"

### P4-003 Slot range write with batch safety check
- Read all target slots before any writes
- Report any non-empty non-factory slots that would be overwritten
- Single confirmation covers entire batch

### P4-004 Backup all user presets
- Export all non-factory, non-empty slots to timestamped JSON
- Stored locally in backups/ directory

### P4-005 Setlist mode
- Assign presets to ordered list for a specific show
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

### BK-005 Other device support
- Helix (JSON format — easiest)
- Axe-FX III / FM9 (same SysEx family as AM4 — next logical step)
- Quad Cortex (harder — proprietary)

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

### BK-010 Scene support in `apply_preset`
- **Context:** AM4 has 4 scenes per preset for per-scene bypass +
  channel assignment. "Make this louder for the solo" is natural.
- **Captures:** `session-18-switch-scene.pcapng` exists, not decoded.
- **Scope:** decode the scene-switch protocol; extend `apply_preset`
  shape to take `scenes: [{ index: 1..4, bypass?: [...], channels?: {...} }]`;
  add `set_scene(index)` MCP tool for live scene changes.
- **Prereqs:** per-block channel pidHighs need one capture each to
  confirm (we extrapolated from amp.channel in Session 08 but only
  amp is verified).

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
