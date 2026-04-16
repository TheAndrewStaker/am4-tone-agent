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

### Capture 0 — read response Rosetta (FIX READ_PARAM)

**Why first:** one capture unblocks the `read_param` decoder that every
other MCP-level verification depends on.

**Setup:** on Z04 working buffer, set Amp Gain to exactly **6.0** via
physical knob (or via our own `set_param amp gain 6`, confirmed on the
device display).

**Action:** in AM4-Edit, *manually poll* the Gain field. The 200 Hz
auto-poll will emit a READ request + response pair every ~5 ms. Ten
seconds of capture is fine — we only need one clean pair.

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

### Capture 6 — `save-scene` (optional, confirm only)

**Action:** tweak params in working buffer scene 2; press AM4-Edit's
"save scene" button (if it exists separately).

**Deliverable:** either a dedicated scene-save command, or confirmation
that scene data is committed only as part of a full preset save.

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
