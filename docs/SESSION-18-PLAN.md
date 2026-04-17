# Session 18 — Preset/scene/block commands + read-response format

Goal: decode the handful of SysEx commands that unblock v0.2 of the MCP
server — the ability to apply a full preset (block types, params, scenes,
save-to-slot) on any starting state, including an empty preset slot in
banks W–Z.

Also: fix the read-response decoder. Session 17's `read_param` returns
raw bytes correctly but mis-decodes the value because the response
payload format doesn't match the write-side 8-to-7 pack. One capture of
AM4-Edit reading a known-value param will give us the Rosetta stone.

## Background

**Blocker we're solving:** v0.1's `set_param` / `set_params` only writes
parameters inside blocks that already exist in the active preset. If a
user picks an empty slot or a preset missing the block they want to
tweak, the write is silently absorbed. The MVP story (*"save my Sandman
tone to W01"*) needs the device-level commands for block placement,
preset switching, and preset/scene save.

**Write-safety reminder:** during capture work, writes go to **Z04 only**
(the designated scratch slot — see `DECISIONS.md`). Back up Z04 before
the first capture in this session. Do not touch A01–Z03 in AM4-Edit
during any capture — every mouse-click in AM4-Edit emits traffic we'll
then have to untangle.

## What's not yet decoded

From `docs/SYSEX-MAP.md`, the following function IDs are documented in
the Axe-Fx II spec but unconfirmed on AM4:

| Function | Axe-Fx II name | What it likely does on AM4 | Priority |
|---|---|---|---|
| `0x3C` | SET_PRESET_NUMBER | switch to a stored preset | **P0** |
| `0x0E` | PRESET_BLOCKS_DATA | dump/load block layout of current preset | P1 |
| `0x29` | GET/SET_SCENE_NUMBER | switch active scene (1–4) | P1 |
| (unknown) | block-type assignment | set slot N's block type (Amp/Drive/Reverb/Delay/None) | **P0** |
| (unknown) | save working buffer to slot | commit current state to W01, Z04, etc. | P1 |
| (unknown) | scene save | persist scene config (may be implicit in preset save) | P2 |

Plus:

| Item | Why it matters |
|---|---|
| Read-response payload format (for `0x0E` read_type) | `read_param` currently mis-decodes; need ground-truth to fix |

## Captures to collect

**Capture tooling:** same USBPcap + Wireshark setup used for sessions
06–09. Parse each capture with `scripts/parse-capture.ts`. Diff against
a no-op baseline (AM4-Edit open but idle) to isolate the action.

**Procedure for each capture:**

1. Open AM4-Edit. Connect to the device. Wait ~2 s for idle state.
2. Start USBPcap recording the AM4 USB endpoint.
3. Perform exactly ONE action in AM4-Edit (listed below).
4. Wait 1 s. Stop capture.
5. Save as `samples/captured/session-18-<name>.pcapng`.
6. `npx tsx scripts/parse-capture.ts samples/captured/session-18-<name>.pcapng`
   → append output to `docs/SESSIONS.md` under a new Session 18 heading.

**Write-safety reminder:** any capture that writes to flash writes to
Z04 only. Back up Z04 before the session. Never touch A01–Z03 inside
AM4-Edit during any capture — every click emits traffic we have to
untangle afterwards.

**AM4-Edit auto-poll noise:** AM4-Edit auto-polls visible fields at
~200 Hz. Every capture therefore has baseline READ_PARAM traffic we
need to diff away. The baseline capture (Capture B) is the reference
for that diff.

### Capture B — idle baseline (do this FIRST)

**Why first:** the diff reference that lets every subsequent capture
isolate its one action from AM4-Edit's ambient polling.

**Setup:** AM4-Edit open, connected to the device, displaying Z04
working buffer. Mouse parked outside any editable field. Idle 2 s.

**Action:** start capture, sit still 10 s, stop. Do not click, scroll,
or move the mouse over any field.

**Filename:** `session-18-baseline-idle.pcapng`

### Capture 0 — read response Rosetta (FIX READ_PARAM)

**Why first:** one capture unblocks the `read_param` decoder that every
other MCP-level verification depends on.

**Setup (port-handoff required on Windows):**

1. Make sure AM4-Edit is closed (it holds the USB port exclusively).
2. From a terminal, with the MCP server not running in Claude Desktop:
   `npx tsx -e "import('./src/protocol/midi.js').then(async m => { const c = m.connectAM4(); const s = await import('./src/protocol/setParam.js'); c.send(s.buildSetParam('amp.gain', 6)); c.close(); })"`
   (Or call `set_param amp gain 6` via Claude Desktop and then fully
   quit Claude Desktop — same effect but slower. The terminal one-liner
   exits cleanly and releases the port.)
3. Open AM4-Edit. Connect. Confirm Amp Gain reads 6.0 on both the
   AM4-Edit UI and the AM4 display. Internal float32 = 0.6 exactly
   (guaranteed by the `knob_0_10` encode: `0.6 = display/10`).
4. Move mouse off the Gain field so auto-poll settles.

**Action:** start USBPcap, click back into the Gain field, idle 10 s.
AM4-Edit's 200 Hz auto-poll will emit a READ request + response pair
every ~5 ms — we only need one clean pair.

**Deliverable:**

- Extract the first full READ_PARAM → response pair for `pidLow=0x3A,
  pidHigh=0x0B`.
- Expected internal value = 0.6 (float32 LE `9A 99 19 3F`). The response
  payload must decode to that, under whatever scheme the device uses.
- Document the decode in `SYSEX-MAP.md §6a` → **Read response** subsection.
- Port the decode into `src/protocol/packValue.ts` as
  `unpackReadResponse(wire: Uint8Array): number` and rewire
  `server/index.ts` `read_param` to use it.
- Add a test case to `scripts/verify-msg.ts`: the captured response →
  expected value 0.6.

### Capture 1 — `change-preset`

**Action:** in AM4-Edit, click from working-buffer → stored preset W01.
(The displayed preset number will change on the AM4 as the capture fires.)

**Deliverable:** pin the command byte for `SET_PRESET_NUMBER`. Likely
`0x3C` per Axe-Fx II; confirm payload structure (14-bit preset number?
slot string?). Add `switch_preset(slot: "W01")` tool after decode.

### Capture 2 — `change-block-type`

**Why it's the highest-leverage capture:** unlocks the entire
empty-preset-and-block-reassignment use case.

**Action:** on Z04, working buffer, slot 3 currently holds GTE (gate).
In AM4-Edit, change slot 3 to REV (reverb) via the block-type selector.

**Deliverable:** pin the command byte for block-type assignment. Likely
a new function ID (not `0x01` SET_PARAM — this mutates preset structure,
not a tunable parameter). Record payload layout: slot index, target
block type ID (already in `CACHE-BLOCKS.md`). Add `set_block_type(slot,
type)` tool.

### Capture 3 — `add-block-to-empty-slot`

**Action:** on empty preset (e.g. Z01 if it's empty — verify first, then
capture on a designated empty), add an Amp block to slot 1.

**Deliverable:** confirm whether this is the same command as Capture 2
with starting state = NONE, or a separate "insert" command.

### Capture 4 — `change-scene`

**Action:** on a preset with non-default scenes (any factory preset will
do — do NOT save), press the Scene 1 → Scene 2 button in AM4-Edit.

**Deliverable:** pin command byte (Axe-Fx II uses `0x29`). Add
`switch_scene(n: 1..4)` tool.

### Capture 5 — `save-preset-to-slot`

**Action:** after some trivial tweak to Z04 working buffer, use AM4-Edit
"Save As…" → Z04.

**Deliverable:** pin the "commit working buffer to flash" command.
Add `save_preset(slot: "Z04")` tool. This is the last building block for
a `save_preset(slot, presetIR)` convenience tool later.

### Capture 6 — `save-scene` (SKIPPED)

**Skipped** per founder confirmation: on AM4, a preset save includes
all four scenes in a single operation. There is no separate scene-save
command to decode. Capture 5 (`save-preset-to-slot`) is sufficient.

## Tier 2 — bundle in the same session

These aren't blockers for v0.2 `apply_preset` but are cheap additions
while the hardware is patched in — each is a 10 s capture and each
retires an open question in `STATE.md` or `CACHE-BLOCKS.md`.

### Capture 7 — clear block (set to NONE)

**Why:** confirms "clear a slot" is the same command as Capture 2 with
target type = NONE, or its own command. Needed so `apply_preset` can
overwrite an existing block layout cleanly.

**Setup:** on Z04 working buffer, make sure slot 2 holds something
(any non-NONE block). Confirm on the AM4 display.

**Action:** in AM4-Edit, change slot 2 from its current block → **NONE**.

**Filename:** `session-18-block-clear-to-none.pcapng`

### Capture 8 — read response on Reverb Mix

**Why:** validates that Capture 0's read-response decoder is
block-generic. If the response format keys on `pidLow`, we need to
know before shipping `read_param` for anything beyond Amp.

**Setup:** pick a factory preset with Reverb placed. Use our
`set_param reverb mix 25` to set Reverb Mix to a known value (internal
float32 = 0.25). Confirm on the AM4 display.

**Action:** in AM4-Edit, click into the Reverb Mix field. Idle 10 s.

**Filename:** `session-18-read-response-reverb-mix.pcapng`

### Capture 9 — Drive channel A → B

**Why:** confirms `pidHigh=0x07D2` (channel selector) is block-generic.
Currently proven only for Amp. Unlocks per-block channel writes.

**Setup:** preset with a Drive block present on channel A. Confirm
channel shown as A on the display.

**Action:** in AM4-Edit, change Drive channel **A → B**.

**Filename:** `session-18-drive-channel-a-b.pcapng`

### Capture 10 — Reverb channel A → B

**Setup:** preset with a Reverb block on channel A.

**Action:** change Reverb channel **A → B** in AM4-Edit.

**Filename:** `session-18-reverb-channel-a-b.pcapng`

### Capture 11 — Delay channel A → B

**Setup:** preset with a Delay block on channel A.

**Action:** change Delay channel **A → B** in AM4-Edit.

**Filename:** `session-18-delay-channel-a-b.pcapng`

### Capture 12 — save-as to an empty slot

**Why:** confirms slot-address payload in the preset-save command
handles empty target slots the same as occupied ones. If they differ,
we need two code paths in `save_preset`.

**Setup:** identify an empty slot in bank Y (check AM4-Edit's preset
list). Y01 is typical if untouched. Back up that slot's current state
(even if empty) before the capture. On Z04 working buffer, tweak Amp
Gain trivially so there's something to save.

**Action:** in AM4-Edit, **Save As → <empty slot>**. NOT Z04.

**Filename:** `session-18-save-preset-empty-slot.pcapng`

**Warning:** this capture writes a preset to the chosen slot. Confirm
it's empty first. The write is reversible via AM4-Edit's preset
library, but only if the slot was genuinely empty.

### Capture 13 — read on non-placed block

**Why:** shows how the device responds to a read whose block isn't in
the active preset. If it times out, we can detect "silent absorb" at
tool-call time and return a useful error from `read_param` instead of
pretending the read succeeded.

**Setup:** find (or make on Z04) a preset state with Delay slot empty
(type = NONE).

**Action:** in AM4-Edit, click the Delay Time field. Let it idle 10 s
while AM4-Edit tries to auto-poll the missing block.

**Filename:** `session-18-read-non-placed-delay.pcapng`

### Capture 14 — block type sweep (nice-to-have)

**Why:** gives wire-confirmed block-type IDs for all 4 main types in
a single file, catching any numbering inconsistency between the cache
tag, wire pidLow, and the block-type-assignment command's payload.

**Setup:** on Z04 working buffer, slot 1 currently holds Amp.

**Action:** in AM4-Edit, change slot 1 through **AMP → DRV → REV → DLY
→ AMP**. Pause ~1 second between clicks so each command is visibly
separate in the capture.

**Filename:** `session-18-block-type-sweep.pcapng`

## Tier 3 — tentative block-role confirmations (optional, bonus)

From `docs/CACHE-BLOCKS.md` Capture TODO: every non-Amp/Drive/Reverb/
Delay cache block is TENTATIVE. One Type-dropdown change per block
promotes it to CONFIRMED and unlocks that effect in the MCP server.
Cheap to batch now while hardware is patched in. Pick any factory
preset that exposes the block; swap the Type dropdown once; save
nothing. Each capture is ~10 seconds.

| # | Block (tentative cache role) | Action | Filename |
|---|------------------------------|--------|----------|
| 15 | Chorus (S3 sub-block 2) | change Chorus Type to any other | `session-18-chorus-type.pcapng` |
| 16 | Flanger (S3 sub-block 3) | change Flanger Type | `session-18-flanger-type.pcapng` |
| 17 | Phaser (S3 sub-block 5) | change Phaser Type | `session-18-phaser-type.pcapng` |
| 18 | Wah (S3 sub-block 6) | change Wah Type | `session-18-wah-type.pcapng` |
| 19 | Compressor (S2 block 2) | change Compressor Type | `session-18-comp-type.pcapng` |
| 20 | Graphic EQ (S2 block 3) | change GEQ Type | `session-18-geq-type.pcapng` |

Skip any whose block doesn't appear in any preset you can navigate to
— they can be captured another day.

## Protocol tasks after captures

1. **Update `SYSEX-MAP.md`:**
   - §6a: add "Read response — 23-byte format" subsection with actual
     decode from Capture 0.
   - New §9: block-type assignment command.
   - New §10: preset-save / scene-save commands.
2. **Update `src/protocol/`:**
   - `packValue.ts` — `unpackReadResponse`.
   - `setParam.ts` or new `blockCommands.ts` — builders for each new
     command, mirroring `buildSetParam`'s shape.
3. **Goldens in `scripts/verify-msg.ts`:** one case per new command,
   byte-exact vs. captured wire bytes.

## MCP surface after Session 18

New tools on top of current `{set_param, set_params, read_param,
list_params, list_enum_values}`:

- `switch_preset(slot: string)` — e.g. `"W01"` or `"Z04"`.
- `switch_scene(n: 1..4)`.
- `set_block_type(slot: 1..4, type: "amp"|"drive"|"reverb"|"delay"|"none")`.
- `save_preset(slot: string)` — commits working buffer to flash slot.
- (optionally) `read_block_layout()` — dump current working buffer's 4
  slots.

Later (Session 19+), these compose into a single
`apply_preset(presetIR)` that takes a full JSON preset and:

1. optionally `switch_preset` to a target slot's working buffer,
2. `set_block_type` per slot (including `"none"` to clear),
3. `set_params` for each block's params,
4. per-scene setup if needed (may be implicit in preset save),
5. `save_preset` to commit.

That tool is the real MVP — the one that handles "build me a Sandman
tone and save it to W01" in a single call.

## Exit criteria for Session 18

- [ ] Capture 0 captured, decoded, `read_param` returns correct values
      for a known-state param, `verify-msg.ts` has a new case.
- [ ] Captures 1, 2, 4, 5 decoded and MCP tools landed (`switch_preset`,
      `set_block_type`, `switch_scene`, `save_preset`).
- [ ] `npm run preflight` green.
- [ ] `STATE.md` updated to point at Session 19 (compose into
      `apply_preset`).
- [ ] `SYSEX-MAP.md` updated with new sections.

## What I'm NOT doing in Session 18

- Natural-language → preset-IR (Claude-side). That's Phase 3 of the
  original roadmap and comes after `apply_preset` lands.
- Reading stored preset binary from a slot. Separate problem; orthogonal
  to the MVP path.
- Full decode of `0x0E PRESET_BLOCKS_DATA` response. We'll get block
  layout via AM4-Edit captures — good enough for now.
