# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings. Physical
> hardware tasks (USB captures, round-trip tests, reference dumps) live
> in **`docs/HARDWARE-TASKS.md`** — check that file alongside this one at
> session start.
> Last updated: **2026-04-19** (Session 25 — P5-009 release-polish
> items 1 + 2. New `list_midi_ports` MCP tool enumerates every MIDI
> input/output the server sees and flags which ones look like the AM4
> ("am4" / "fractal" substring). Does NOT open the AM4 connection —
> safe to call mid-session and safe to call before the AM4 is plugged
> in. The "AM4 not found" error path rewritten: now lists common
> causes (power/USB/driver/AM4-Edit exclusivity), shows visible ports
> for diagnostics, and points at `list_midi_ports` + `reconnect_midi`
> as the user-facing recovery path. Tool count 15 → 16. Smoke-server
> assertion covers the new tool (tool wired up, returns
> Inputs/Outputs-structured text). No hardware required — enumeration
> works regardless of AM4 connection state. Preflight green
> (33/33 verify-msg, 16/16 verify-pack, 8/8 verify-echo,
> smoke-server 16 tools).)
> Prior context (Session 24): BK-027 phase 1 —
> kitchen-sink `apply_preset`. Added `slots[i].channels` (A/B/C/D →
> per-channel params) alongside the existing `channel` / `params` shapes.
> Backwards-compatible extension; mutually exclusive with `channel` /
> `params` per-slot. Multi-channel preset build ("clean on A, lead on
> D") now lands in one MCP call instead of the previous ~10 round-trip
> sequence. Smoke-server gained five validation-path assertions — no
> hardware required since all exercise the pre-MIDI validation layer.
> Preflight green. Phase 2 (scenes) still blocked on HW-011.
> Prior context (Session 23): tool-response trim + unified ack helper.
> `sendCommandAndAwaitAck` generalized to
> `sendAndAwaitAck(conn, bytes, predicate)`; `switch_preset` /
> `switch_scene` moved from the passive-capture path to predicate-based
> `isWriteEcho` matching (their ack shape per HW-006/HW-007); `set_param`
> and `set_block_type` success responses trimmed of the Session-19-era
> Sent/Ack/All-inbound hex dumps. Dead `sendAndCapture` helper deleted.
> No hardware work, no new captures — release-readiness / Claude-Desktop
> token-efficiency only. Preflight green (33/33 verify-msg, 16/16
> verify-pack, 8/8 verify-echo, smoke-server 15 tools). No change to
> tool count; no protocol change.
> Prior context (Session 21): scene-switch confirmed, scene-rename
> pidHigh map (`0x37 + sceneIndex`), preset-switch decoded as
> `SET_FLOAT_PARAM` at `pidLow=0xCE / pidHigh=0x0A` with float32
> location index (differs from u32 semantics of scene-switch / save /
> rename). Three new MCP tools landed: `set_scene_name`, `switch_preset`,
> `switch_scene`. Server now exposes 14 tools. 33/33 verify-msg goldens,
> preflight green. Three new round-trip hardware tests queued —
> HW-006/007/008.
> Prior context (Session 20 (cont)): P3-007 lineage
> dictionaries shipped. `scripts/extract-lineage.ts` parses the wiki scrape
> + Blocks Guide PDF into `src/knowledge/{amp,drive,reverb,delay,
> compressor,cab}-lineage.json`. Coverage: amp 219/248 matched (88%)
> with 135 inspired-by parentheticals + 112 Fractal-quoted; drive 69/78
> matched (88%) with 47 Blocks Guide one-liners + full category/clip-type
> taxonomy; reverb 52/79 family-level descriptions + 41 block-level
> Fractal quotes + 4 specific real-gear callouts (London/Sun Plate,
> North/South Church); delay 23/29 Blocks Guide descriptions; compressor
> 19/19 wiki entries matched + 8 with distinct forum-quote lineage (LA-2A,
> 1176, SSL Bus, Fairchild, Dynacomp, Rockman, Orange Squeezer); cab 2048
> entries + 12-creator attribution legend. 107 amp + 14 drive wiki-only
> variants (channel/revision sub-entries not in the enums) kept as
> flagged records so their data is preserved for the agent.
> Schema invariant: `description` and `inspiredBy.primary` never carry
> identical content — `description` is the Fractal-authored prose,
> `inspiredBy` only populates when we have a *distinct* real-gear
> reference (e.g. an amp parenthetical or a forum quote that adds info
> beyond the description).
> Prior context (Session 20): four protocol decodes from
> already-captured pcapngs, no new captures required.
> (a) Per-block channels confirmed on Drive/Reverb/Delay at the same
> `pidHigh=0x07D2` as amp.channel — three byte-exact goldens.
> `drive.channel` / `reverb.channel` / `delay.channel` added to
> `KNOWN_PARAMS` (now 20 entries across 15 blocks).
> (b) Scene switch TENTATIVELY decoded: pidLow=0x00CE, pidHigh=0x000D,
> action=0x0001, value=u32 LE scene index. `buildSwitchScene` +
> byte-exact golden against the one captured switch (to scene 2).
> Only one scene transition in the capture — need captures of
> switches to scenes 1/3/4 to confirm the "value = scene index"
> interpretation.
> (c) Preset-switch capture inconclusive: `session-18-switch-preset
> .pcapng` shows heavy AM4-Edit read-poll traffic around t=14s but
> no clean outgoing switch command — the switch was likely
> hardware-initiated. Needs a re-capture of AM4-Edit explicitly
> switching presets via its UI.
> (d) Gig-prep workflow spec'd as P4-002 in 04-BACKLOG.md — 16-song
> setlist → research → W-Z assignment → batch confirm → save.
> 25/25 verify-msg, 8/8 verify-echo, smoke-server green.)

---

## Current phase

**Phase 1 — Protocol RE: 🟢 COMPLETE AND HARDWARE-VERIFIED.** First real
write produced visible parameter change on the device (Session 05).

**Phase 2 — Parameter registry + preset IR + transpiler.** Registry +
working-buffer IR + transpiler shipped and capture-verified (Session 07).
Channel-addressing solved in Session 08 — channel A/B/C/D is a regular
SET_PARAM write at `pidHigh = 0x07D2` with the index (0..3) encoded as a
float32. One open question remains before the IR can cover full presets:
**bulk parameter discovery** (Ghidra metadata table extraction below).

## The single next action

### Capture the two undecoded scene-level writes (HW-011)

HW-006 / HW-007 / HW-008 from Session 21 all closed green on hardware
(scene switch, preset switch, scene-name persistence). Session 22
decoded both the save ack and the rename ack into the 18-byte
`isCommandAck` shape; Session 23 trimmed response sizes and unified
the ack helper. The remaining Phase 1 gap is the per-scene writes
that make multi-scene tones actually play as intended:

1. **Scene → channel assignment.** "Scene 2 uses the Amp block's
   channel B." Without this write, all four scenes default to channel
   A and the per-channel tones you configured never select.
2. **Scene → bypass state.** "Scene 3 bypasses the Drive block."
   Without this write, bypass state is global to the preset, not per
   scene.

Queued in detail as **HW-011** — three scene-channel captures + three
scene-bypass captures in one hardware session (~15 min). Closes BK-010
and unlocks BK-027 phase 2 (kitchen-sink `apply_preset` with per-slot
channel + scene arrays).

Hardware-test follow-ups (deferred from prior sessions, still outstanding):

### Hardware-test `set_preset_name` and confirm whether rename persists

Session 19 (cont.) decoded preset rename: same register as block
placement (pidLow=0x00CE), new pidHigh=0x000B, new action=0x000C,
36-byte payload = 4-byte slot + 32-byte space-padded ASCII name.
Byte-exact golden match against the captured rename of Z04 to "boston".

What needs hardware verification:

1. Restart Claude Desktop (picks up `set_preset_name`; 9 tools now).
2. Build a preset on Z04 via `apply_preset`.
3. Ask Claude to *"rename Z04 to <something distinctive>"*. Tool sends
   the rename; no audible change.
4. On the AM4, navigate away from Z04 and back. Check the slot name.
   Did the new name stick? Options:
   - **Name changed on display immediately and persists through
     navigation:** rename is atomic — persists on its own.
   - **Name changed on display but reverts after navigation:** rename
     only writes the working buffer; need to call `save_to_slot`
     afterward to persist.
   - **Name didn't change at all:** rename command requires a
     different pidHigh or payload convention we missed.
5. If rename alone doesn't persist, the natural UX is to add a combined
   `save_preset` tool that does `save_to_slot` + `set_preset_name` in
   one call. Straightforward once we know the ordering.

Scene rename decoding is the follow-up: capture renames for scenes 2,
3, 4 (we have scene 1's capture), then add `set_scene_name(sceneIndex,
name)` with the pidHigh-per-scene map. Tracked in BK-011.

### Earlier follow-up — round-trip a built preset via Z04

Session 19 shipped `save_to_slot` (Z04-gated) after decoding the save
command from `session-18-save-preset-z04.pcapng`. The save-ack shape
isn't decoded, so success is confirmed by reloading the slot on the
hardware.

1. Restart Claude Desktop (picks up `save_to_slot`; 8 tools now).
2. Build a preset with `apply_preset` (e.g. *"build a clean preset with
   compressor, amp, delay, reverb"*).
3. Ask *"save this to Z04"*. Tool should wire-ack; no audible change.
4. On the AM4, navigate away from Z04 (e.g. load A01) then back to Z04.
   The saved layout + params should reappear. If they don't, the save
   didn't persist — grab the inbound-SysEx log from the tool response
   and we'll compare against AM4-Edit's save traffic.
5. Try *"save this to A05"* or similar → expect a clear rejection
   error ("hard-gated to Z04").

### Earlier follow-up (still valid) — `apply_preset` build

The initial `apply_preset` hardware test already passed (Session 19:
compressor → slot 1, amp/delay/reverb → 2/3/4, amp.gain + reverb.mix
both audibly landed). No action needed.

1. Restart Claude Desktop to pick up `apply_preset`.
2. Load **Z04**, clear blocks on the device.
3. Ask Claude something like *"build me a clean preset with compressor,
   amp (gain 4, bass 6), delay (time 350 ms), and reverb (spring studio,
   mix 35%)"*. Expect Claude to emit a single `apply_preset` tool call
   with the structured slots list, and the AM4 to land at the right
   layout + params in one shot.
4. Verify on the hardware: chain matches, amp gain/bass match, delay time
   matches, reverb type/mix match. Any unintended state from a previous
   preset at slots 5+ (none exist) or unused params (stale values from
   the prior preset — apply_preset doesn't currently reset every param,
   only the ones specified) is a known limitation, not a bug.

Open follow-ons (bigger scopes, see backlog):

- **Scenes.** 4 scenes per preset; `session-18-switch-scene.pcapng`
  exists but builders aren't written. Extending `apply_preset` to take
  `scenes: [...]` unlocks full preset fidelity.
- **Per-block channels.** amp.channel (A/B/C/D) is decoded; other blocks'
  channel pidHigh is extrapolated from amp — worth one capture each to
  confirm before exposing channel control in `apply_preset`.
- **Save to slot / switch preset.** `session-18-save-preset-z04.pcapng`,
  `session-18-switch-preset.pcapng` are captured but not decoded.
  Decoding closes the loop for persistent preset generation.

### What's deferred

- **Apply/absorb discriminator** — the AM4 wire-acks writes whether or
  not the target block is placed (Session 19 hardware finding). Echo
  timing can't tell applied from absorbed. Parked as `BK-008`; unblocks
  truly honest audible-change detection once decoded.
- **Preset save / load / scene switch protocol decode.** Captures exist
  (`session-18-save-preset-z04.pcapng`, `session-18-switch-scene.pcapng`,
  `session-18-switch-preset.pcapng`) but builders aren't written yet.
  Unblocks persistent preset generation (build from scratch + store).

### Deferred

- **Decode the READ response format.** The 0x0D READ action returns a
  64-byte response with a 40-byte payload. Bytes 0-7 vary per response
  even at stable values (rotating descriptor/counter), bytes 8/11 are
  constant structural markers, bytes 14-39 are zero, and the actual
  current value is NOT at any fixed offset as a packed float32
  (scanned all 5-byte windows against known values 0.2/0.5/0.8/0.25 —
  zero matches). AM4-Edit probably decodes this via a non-trivial
  scheme; cracking it likely needs Ghidra on AM4-Edit's response
  parser. Not a blocker — v0.2 uses WRITE echoes for confirmation.
- **Block-command captures for preset-save / scene-switch / block-type
  assignment.** Captures exist (`session-18-save-preset-z04.pcapng`,
  `session-18-switch-scene.pcapng`, `session-18-block-type-gte-to-rev
  .pcapng`, etc.) but NOT yet decoded into protocol builders. That's
  the next session's work — decoding these unlocks the real MVP
  (`apply_preset` in one call).
- **PEQ and Rotary have pidLow but no Type enum.** KNOWN_PARAMS needs
  specific knob entries (PEQ band freqs/gains, Rotary rate/depth)
  once we decide the naming scheme. Cache records are already in
  `docs/CACHE-DUMP.md`.
- **P3-007 Model Lineage Dictionary** (see `04-BACKLOG.md`) —
  `cacheEnums.ts` is the authoritative input for the wiki-scrape
  pipeline. 15 block dictionaries ready (498 total enum entries).

**Layouts (parser is source of truth — see `scripts/parse-cache.ts`):**

- Section 3 begins at divider `f0 ff 00 00` (0x136f0 on this install),
  followed by `cabNames[256]` (all `<EMPTY>`) and `cabIds[256]` (all
  `0xff`), then a 32-byte block header at ~0x14610, then records.
- Section 3 records use a compressed 24-byte header (tc=u16 at +4,
  floats a/b/c/d at +8..+23). Float records: 32 bytes total (trailer
  u32=0 + extra u32). Enum records: u32 count + strings + u32 trailer.
- `cache-section3.json` contains `{ cabNames, cabIds, records }` where
  each record has `{ offset, block, id, typecode, kind, a, b, c, d,
  values?, extra? }`.

**17 sub-blocks (from `cache-section3.json`, summary printed by
`parse-cache.ts`):** sub-block 0 = Reverb (72 recs, id=10 enum × 79),
sub-block 1 = Delay (89 recs, id=10 enum × 29), sub-block 9 = Drive
(49 recs, id=10 enum × 78). Remaining 14 sub-blocks are Chorus/Flanger
/Pitch/EQ/Compressor/Filter candidates — role assignment still open.

**Next steps (Session 15+):**

1. Cross-reference the 4 main blocks (Amp pre-divider block 5, Reverb/
   Delay/Drive post-divider sub-blocks 0/1/9) against wire `pidLow`
   values (`0x3A`, `0x42`, `0x46`, `0x76`). Preferred heuristic:
   Drive's `id=10` enum at index 8 is `TS808` — matches `params.ts`
   Drive Type, so sub-block 9 ↔ `pidLow=0x76`. Confirm Reverb/Delay
   by capturing AM4-Edit setting Reverb Type and Delay Type and
   matching the resulting `pidHigh` to the cache record IDs.
2. Auto-generate `KNOWN_PARAMS` entries for each confirmed
   block/param. Start with Reverb and Delay since those are the most
   obvious to validate by ear.
3. After `KNOWN_PARAMS` is generated, start on **P3-007 Model lineage
   dictionary** (see `04-BACKLOG.md`) — the 248-amp × 78-drive ×
   79-reverb × 29-delay model names are ready to feed into the
   wiki-scrape pipeline for the real-world-gear-inspired-by mapping.
4. Decode the remaining ~49KB tail past 0x1f926 if it turns out to
   contain additional blocks (scene templates? preset metadata?).

## Decoded parameters and unit conventions

Live source of truth: `src/protocol/params.ts` (`KNOWN_PARAMS` + `Unit`
union). 11 params across 4 blocks (Amp `0x003A`, Drive `0x0076`, Reverb
`0x0042`, Delay `0x0046`) using 5 unit conventions (`knob_0_10`, `db`,
`percent`, `ms`, `enum`). `pidLow` = block ID, `pidHigh` = parameter
index within block; address is preset-independent. All 4 type enums
(Amp 248 / Drive 78 / Reverb 79 / Delay 29) are populated from
`cacheEnums.ts`. Amp Channel enum is fully populated (0..3 ↔ A..D).
Capture-verified entries: `amp.gain/bass/level/channel`, `drive.drive/
type=TS808`, `reverb.mix`, `delay.time`. Cache-derived and untested:
`amp.type`, `reverb.type`, `delay.type`, plus the expanded `drive.type`
index table (only index 8 has been wire-verified).

## Recent breakthroughs

Older breakthroughs (sessions 04–08, 10–14) are archived in `SESSIONS.md`.
Sessions 15–19 (current) are kept here for fast orientation.

0000000000. **Session 25 — P5-009 release-polish (list_midi_ports + graceful
            AM4-not-found).** Two pre-release ergonomics items landed with
            zero hardware work. New `list_midi_ports` MCP tool enumerates
            inputs + outputs via a connection-free `listMidiPorts()` helper
            in `src/protocol/midi.ts`, tagging AM4-looking ports and
            returning a verdict line ("AM4 input + output both visible" /
            "Only one of AM4 input/output is visible" / "No MIDI ports of
            any kind are visible"). The "AM4 not found" error in
            `connectAM4()` rewritten to list the three common causes
            (power/USB/driver, AM4-Edit port exclusivity, missing driver),
            show whatever ports ARE visible, and point at `list_midi_ports`
            + `reconnect_midi` as the recovery path. Tool count 15 → 16.
            Smoke-server picked up a `list_midi_ports` assertion — verifies
            the tool is wired up and returns Inputs/Outputs-structured
            output (port content itself is environment-dependent). Closes
            P5-009 items 1 and 2. Preflight green.

000000000. **Session 24 — BK-027 phase 1 (kitchen-sink `apply_preset`).**
           `apply_preset` now accepts `slots[i].channels`, a per-channel
           param map keyed by A/B/C/D (case-insensitive), mutually
           exclusive with the legacy `channel` / `params` shapes.
           Validation is atomic and path-like ("slots[0] channels.B.gain:
           out of range [0..10]: 12"). Per-slot execution walks the
           channel map in A→B→C→D canonical order regardless of how
           the caller ordered the object keys — each letter emits a
           channel-switch write followed by its param writes, so the
           wire sequence is deterministic. Backwards-compatible: no
           existing apply_preset call shape changes behavior; this is
           purely additive. Smoke-server picked up five
           validation-path assertions (channel+channels conflict,
           params+channels conflict, channels on a block without
           channels, unknown letter, unknown param path). Preflight
           green. Phase 2 (scenes) remains blocked on HW-011 per
           backlog.

00000000. **Session 23 — tool-response trim + unified ack helper.**
          `sendCommandAndAwaitAck` generalized to
          `sendAndAwaitAck(conn, bytes, predicate)` so every tool that
          awaits an inbound SysEx ack uses one helper regardless of
          ack shape (`isCommandAck` for 18-byte addressing acks,
          `isWriteEcho` for 64-byte param / placement / switch acks).
          `switch_preset` and `switch_scene` moved off the passive-
          capture path onto predicate-based matching — their ack is
          the standard `isWriteEcho` shape per HW-006/HW-007 — so
          their happy-path response is now a single verdict line
          instead of a raw-hex dump. `set_param` and `set_block_type`
          success responses trimmed of the Session-19-era Sent/Ack/
          All-inbound hex blocks (obsolete once the echo predicate
          stabilized). Ack-less paths still carry diagnostic hex.
          Dead `sendAndCapture` helper deleted. No protocol change,
          no hardware work, no tool-count change. Preflight green.

0000000. **Session 20 (cont) — P3-007 Model Lineage Dictionary shipped.**
         `scripts/extract-lineage.ts` parses `docs/wiki/*.md` + `docs/
         manuals/Fractal-Audio-Blocks-Guide.txt` into five JSON files
         under `src/knowledge/`, cross-referenced against the canonical
         `cacheEnums.ts` catalog. Source-tagged: every qualitative field
         carries `source: 'fractal-blocks-guide' | 'fractal-wiki'` so
         the agent knows provenance. Only Fractal-authored content is
         captured; brand-authored quotes (Xotic, JHS, Macari's, etc.)
         and community-inferred genre/era tags are deliberately omitted
         per user preference for accuracy over coverage. Entries that
         don't match any canonical AM4 enum name (channel-variant
         sub-entries like "BRIT JVM OD1 ORANGE/RED/GREEN") are kept as
         flagged records rather than dropped. `npm run extract-lineage`
         regenerates the JSONs from sources.

000000. **Session 19 — three wins: ack triage, block-placement decode, new
        MCP tools.**

        **19a (ack triage):** Hardware testing via Claude Desktop produced
        four false-confirms on absent-block writes (amp.gain, drive.drive,
        flanger.type, reverb.type/Ambience). First fix attempted: tighten
        `isWriteEcho` to require `hdr4 = 0x0028` (reject the 23-byte
        receipt-echo of our own bytes, accept only the 64-byte device
        frame). Second hardware test killed that hypothesis — the AM4
        emits the 64-byte frame for absorbed writes too. Triage: ack
        presence does NOT indicate apply. Tool language reworked to be
        honest ("wire-acked; not a confirmation of audible change") and
        `set_params` no longer aborts on missing acks. Diagnostic capture
        of all inbound SysEx during the write window now included in
        every tool response. Apply/absorb detection parked as BK-008.

        **19b (block placement cracked):** Three Session-18 captures
        (block-clear, GEQ→Reverb, none→Amp) decoded into one protocol
        rule: block placement is a regular WRITE to pidLow=0x00CE,
        pidHigh=0x0010+slot-1, with the target block's own pidLow as
        the float32 value (0 = "none"). See SYSEX-MAP §6c. The decoded
        values matched the known pidLow table exactly (Reverb=0x42,
        Amp=0x3A). `buildSetBlockType` landed with 3/3 byte-exact
        `verify-msg` goldens against captured wire bytes.

        **19c (new MCP tools):** `set_block_type(position, block_type)`
        and `list_block_types` registered. Server now exposes 6 tools.
        Block-type dictionary (18 entries incl. "none") lives in
        `src/protocol/blockTypes.ts`.

        **19d (off-by-one correction):** First hardware test of
        `set_block_type` landed position 1 on device slot 2, and position
        4 (pidHigh 0x0013) produced a structurally different ack plus
        observed side effects on an unrelated slot. Concluded the three
        Session-18 captures were slots 2/3/4, not 1/2/3. Fixed base
        from `0x0010` to `0x000F` so positions 1..4 map to pidHighs
        0x0F..0x12. Re-test confirmed: compressor→slot 1, amp→slot 2,
        delay→slot 3, reverb→slot 4 all landed on the labelled AM4 slot,
        then amp.gain=6 + reverb.mix=40 both audibly applied.

        **19e (apply_preset tool):** Collapses the N block placements +
        M param writes of a full preset into a single MCP call. Takes
        `{ slots: [{ position, block_type, params? }] }`. Validates all
        input up-front (unknown block/param, out-of-range value, enum
        name typo, duplicate position) before sending any MIDI. Returns
        a per-write ack summary same shape as `set_params`. 7th MCP
        tool registered.

        **19f (save-to-slot decoded + tool):** `session-18-save-preset-
        z04.pcapng` produced one unique command: function=0x01,
        pidLow=pidHigh=0x0000, **action=0x001B**, payload = 4-byte
        uint32 LE slot index (Z04 → 103 → `67 00 00 00` raw →
        `33 40 00 00 00` packed). `buildSaveToSlot` + captured golden
        land in `verify-msg` (20/20). `save_to_slot` MCP tool is the
        8th, hard-gated to Z04 per CLAUDE.md write-safety rules until
        P1-008 (factory preset safety classification) arrives.
        Save-command ack shape still unresolved — the tool dumps all
        inbound SysEx in the 300 ms window instead of asserting.

        **19g (preset rename decoded + tool; scene rename partial):**
        `session-20-rename-preset.pcapng` produced a 60-byte unique
        command: function=0x01, pidLow=0x00CE (same block-slot
        register), pidHigh=0x000B, **action=0x000C**, hdr4=0x0024
        (36-byte raw payload). Payload = 4-byte slot index + 32-byte
        ASCII name, **space-padded** (0x20) not null-padded. Session
        `session-20-rename-scene.pcapng` shares the envelope / action
        / payload structure with a different pidHigh (0x0037) and the
        slot-index field zeroed — scenes are scoped to the working
        buffer. Only one scene captured, so scene-index → pidHigh
        mapping needs three more captures (BK-011). `buildSetPreset-
        Name` + golden in `verify-msg` (21/21). `set_preset_name` MCP
        tool is the 9th, hard-gated to Z04.

        **19h (packing bug surfaced):** The 36-byte name payload didn't
        match a single-pass `packValue` call because the sliding-window
        algorithm actually **restarts every 7 raw bytes** — chunked
        7→8 encoding. Small payloads (≤ 7 raw) were already one chunk,
        so every earlier test passed by coincidence. Added
        `packValueChunked` / `unpackValueChunked`; existing code paths
        are unaffected (all use ≤ 7 raw bytes per value). Updated
        SYSEX-MAP §6b (and new §6e) with the correct chunking rule.

        **19i (MIDI self-healing + reconnect tool):** Session 19 hardware
        test hit a stale-handle scenario after the user opened AM4-Edit
        — our cached MIDI connection still "looked open" but writes
        produced zero acks. Fixed two ways: (1) `ensureMidi()` now
        tracks consecutive ack-less writes; after 2 in a row, the next
        call closes the cached handle and opens a fresh one
        automatically. (2) New `reconnect_midi` MCP tool lets the user
        force a fresh handle on demand — surfaced in every ack-less
        tool response as a manual escape hatch. No more Claude Desktop
        restarts needed after brief AM4-Edit excursions or USB
        replugs. BK-013 closed. Server now exposes **10 tools**.

00000. **Session 18 — write-echo confirmation + 11 blocks confirmed.**
       Three sub-phases:
       
       **18a (echo protocol):** After `set_param`, listen for a 64-byte
       response with matching pidLow/pidHigh and `action=0x0001`
       within 300 ms. Presence = write took; timeout = silent-absorb
       (block not placed in active preset). Implemented via
       `receiveSysExMatching` in `midi.ts` and `isWriteEcho`
       predicate in `setParam.ts`. Covers `set_param` and
       `set_params` (per-write echo, stops on first silent-absorb).
       `read_param` removed — the AM4's READ response carries
       metadata, not current value, at any fixed offset.
       
       **18b (6 Tier-3 block Type captures):** Chorus (0x4E),
       Flanger (0x52), Phaser (0x5A), Wah (0x5E), Compressor (0x2E),
       GEQ (0x32) — each Type-dropdown change confirmed the wire
       pidLow matches the cache sub-block's position. Added 6
       KNOWN_PARAMS entries + 6 byte-exact verify-msg goldens.
       
       **18c (5 more blocks + 2 address-only):** Filter (0x72),
       Tremolo (0x6A), Enhancer (0x7A), Gate (0x92), Volume/Pan
       (0x66) — 5 more Type/Mode selectors, all with goldens.
       Parametric EQ (0x36) and Rotary (0x56) captures pinned
       their pidLows but they have no Type enum; KNOWN_PARAMS
       entries deferred until we pick specific knobs. Cache block
       roles: all 4 main S2 effect blocks + all 11 S3 effect
       sub-blocks now CONFIRMED. See `CACHE-BLOCKS.md`.
       
       Final: 17 KNOWN_PARAMS across 15 confirmed blocks; 16/16
       verify-msg goldens + 7/7 verify-echo goldens green.

000. **Type-enum dictionaries wired into params.ts** (Session 16).
     `scripts/gen-cache-enums.ts` emits `src/protocol/cacheEnums.ts`
     with AMP/DRIVE/REVERB/DELAY type arrays (248/78/79/29 entries).
     `KNOWN_PARAMS` now carries `amp.type`, `reverb.type`, `delay.type`;
     `drive.type` expanded from 1 entry to full 78-entry table;
     `delay.time` displayMax corrected from 5000 ms to 8000 ms.
     `docs/CACHE-DUMP.md` is the human-readable companion showing
     every param record for the 4 mapped blocks. Preflight green.

00. **Wire pidHigh == cache record id** (Session 15). Cross-referenced
    `KNOWN_PARAMS` against parsed cache via `scripts/map-cache-params.ts`:
    6/7 known params line up by id directly (amp.gain → cache id=11,
    amp.bass → id=12, drive.type → id=10 with 78-entry enum, …). This
    pins block → wire pidLow: Amp=S2 block 5 (tag=0x98), Drive=S3
    sub-block 9, Reverb=S3 sub-block 0, Delay=S3 sub-block 1. Two
    KNOWN_PARAMS are "out-of-band" (pidHigh not in per-block table):
    `amp.channel` (0x07D2) and `amp.level` (0x0000). The cache now
    supplies exact displayMin/displayMax/step for every in-band param
    and full enum tables (248 amps, 78 drives, 79 reverbs, 29 delays,
    138 cabs, 69 mics).
0. **Section 3 parser landed** (Session 14). `scripts/parse-cache.ts`
   now emits `cache-section3.json` with 256 user-cab names, 256 user-
   cab IDs, and 695 parameter records across 17 sub-blocks. All wire-
   visible enum strings (Reverb/Delay/Drive types, 78–79 entries each)
   are now in committed JSON. `npm run preflight` green.
1. **Post-divider region cracked — 17 blocks, 695 records**
   (Session 13). The `f0 ff 00 00` marker at 0x136f0 introduces a
   256-entry user-cab slot table (names + IDs, 0xf20 bytes), then
   Section 3 begins at 0x14610 with a **compressed 24-byte record
   header** (different from pre-divider's 24-byte-header-with-extra
   layout). Reverb Type (79), Delay Type (29), and Drive Type (78)
   all located — closing Phase 1's protocol-RE loop.
2. **All main effect blocks now enumerated.** Amp (pre-divider, 248
   models), Drive (post-divider block 9, 78 types), Reverb (block 0,
   79 types), Delay (block 1, 29 types). The catalog is ready to
   feed into `KNOWN_PARAMS` auto-generation AND the P3-007 Model
   Lineage Dictionary work.
3. **Pre-divider vs post-divider layout difference.** Pre-divider
   records use 24-byte header with tc=u32 and a/b/c/d floats at
   +8..+23. Post-divider records use 24-byte header with tc=u16 at
   +4 (not +8) and a/b/c/d floats at +8..+23 with different total
   record size (32 bytes for float). Block headers differ too:
   pre-divider is 40 bytes with tag in high 16 bits of u32 at +4;
   post-divider is 32 bytes with tag in high 16 bits of u32 at +8.
4. **Block tag ≠ wire pidLow** (Session 12, still open). Amp wire
   pidLow=0x3A but block tag=0x98. The cache's block order also
   differs from wire pidLow order. Block → wire-pidLow mapping is
   still open.

Session 08 highlights (still load-bearing):

1. **Per-block channel selector decoded** (Session 08). Channel A/B/C/D
   is a regular SET_PARAM write at `pidLow=0x003A` (Amp), `pidHigh=0x07D2`,
   with the channel index (0..3) packed as an IEEE 754 float32. Two
   captures proved it: `session-09-channel-toggle.pcapng` (A↔B) and
   `session-09-channel-toggle-a-c-d-a.pcapng` (A→C→D→A). All four values
   confirmed by `unpackFloat32LE`. `amp.channel` added to `KNOWN_PARAMS`
   with `unit: 'enum'` and `enumValues: {0:'A', 1:'B', 2:'C', 3:'D'}`;
   `verify-msg.ts` now 5/5 including checksum.
2. **pidHigh decoding correction** (Session 08). Prior to `0x07D2`, every
   observed pidHigh was ≤ 0x7F, so reading the two body bytes as
   little-endian (`(hi << 8) | lo`) gave the same answer as the correct
   septet decode (`(hi << 7) | lo`). Channel was the first param to
   expose the difference — `parse-capture.ts`'s body-hex display still
   shows the septet bytes laid out LE, so always convert with `(hi<<7)|lo`
   when extracting a new `pidHigh` from a capture. Documented in
   SYSEX-MAP.md §6a.
3. **Same pidHigh likely applies to other blocks** (Session 08, unverified).
   The other per-block selectors (Drive/Reverb/Delay) are probably at
   `pidHigh=0x07D2` on their respective `pidLow`. Worth a one-shot
   capture when expanding the registry to per-block channel keys.

## What's known (status legend)

- Device comms, checksum, envelope, model ID, documented commands
  `0x08 / 0x0C / 0x0D / 0x0E / 0x13 / 0x14 / 0x64` — **🟢 confirmed**.
- Preset dump format (`0x77/0x78/0x79`) + slot addressing — **🟢 confirmed**.
- `0x01` SET_PARAM message format + value encoding — **🟢 fully decoded**.
- Parameter ID structure — **🟢 (Session 06, preset-independent)**.
- 8 params / 4 blocks / 5 units — **🟢 in `params.ts`**.
- Channel A/B/C/D addressing — **🟢 (Session 08: Amp `pidHigh=0x07D2`,
  float32 index 0..3; other blocks' channel pidHigh unverified)**.
- Drive Type enum table — **🟡 only `8 → TS808` known**.
- Full preset binary layout inside `0x78` chunks — **🔴 scrambled, parked**.

MVP scope, target-user definition, and write-safety rules are
authoritative in `CLAUDE.md` and `DECISIONS.md` — not duplicated here.

## Roadmap landmarks

- **Strategic direction:** multi-device expansion is scoped in the
  backlog in two waves.
  - **Wave 1 — Fractal family:** BK-014 (Axe-Fx II XL+, founder-owned,
    capture-based RE like AM4) then BK-015 (Axe-Fx III / FM9 / FM3 /
    VP4 community beta). This is where the addressable market jumps
    from dozens to 6-figure guitarist populations.
  - **Wave 2 — Roland / Boss family:** BK-016 umbrella + BK-017/018/019/
    020 (RC-505 MKII, VE-500, SPD-SX, JD-Xi — all founder-owned).
    Different SysEx family from Fractal (`0x41` manufacturer vs
    Fractal's `0x00 0x01 0x74`) but structurally simpler because
    **Roland publicly publishes full MIDI Implementation PDFs** — zero
    capture-based RE per device vs the 20+ sessions we paid on AM4.
    Opens the home-studio / synth / loop segment, broadens the project
    from "Fractal tone agent" to "local MIDI gear agent."
  - Both waves require landing BK-012 (protocol package split) first,
    which becomes much more load-bearing with a second protocol family
    in scope: it becomes `fractal-protocol-core` + `roland-protocol-
    core` + per-device packages.
- **Now:** finish decoding cache Section 2 across all blocks — Session 11 cracked block 0, Session 12 needs the block-1 layout shift.
- **Then:** expand `WorkingBufferIR` → full `PresetIR` (block placement,
  4 scenes, per-block channel assignment) — the transpiler will need to
  emit a channel-select write (now understood) before that block's
  param writes.
- **Then:** scaffold MCP server (`src/server/`) with first two tools
  (`read_slot`, `apply_preset`).
- **Then:** natural-language → preset-IR (Claude side).
- **Phase 5:** packaging to signed `.exe` (see `docs/04-BACKLOG.md`).

## Where everything lives

- `src/protocol/` — verified protocol layer (checksum, pack, params, setParam, midi).
- `src/ir/` — preset IR (`preset.ts` working-buffer scope) + `transpile.ts`.
- `docs/SESSIONS.md` — every RE session, chronological, with raw captures.
- `docs/SYSEX-MAP.md` — working protocol reference (🟢/🟡/🔴 tagged).
  §6a/§6b updated 2026-04-14 with the cracked encoding.
- `docs/DECISIONS.md` — architecture and scope decisions with rationale.
- `docs/REFERENCES.md` — local PDFs + factory bank + community sources.
- `docs/BLOCK-PARAMS.md` — AM4 block types and effect types ground truth.
- `docs/04-BACKLOG.md` — phased work item list.
- `docs/PROMPT-COVERAGE.md` — living table of user prompt patterns → minimum tool-call path + status. Release-gate ready (every row ✅ or deliberately-accepted ⚠, zero ❌). Update when tools ship / decodes land / new prompt patterns surface. See CLAUDE.md "Living documentation" section for exact triggers.
- `docs/HARDWARE-TASKS.md` — founder-owed physical actions (captures, round-trips). Check at session start; append HW-NNN when Claude identifies a hardware action it can't perform itself.
- `scripts/probe.ts` — read-only device probe.
- `scripts/sniff.ts` — bidirectional MIDI proxy (superseded by USBPcap).
- `scripts/diff-syx.ts` — byte-level diff of two `.syx` files.
- `scripts/parse-capture.ts` — parses tshark dumps of USBPcap captures.
- `scripts/verify-pack.ts` — 10-sample round-trip test of float pack/unpack.
- `scripts/verify-msg.ts` — built-vs-captured message byte comparison.
- `scripts/write-test.ts` — first hardware write (Amp Gain).
- `scripts/verify-transpile.ts` — IR → command sequence round-trip check.
- `scripts/ghidra/FindEncoder.java` — Ghidra script that found the encoder.
- `scripts/ghidra/FindParamTable.java` — Ghidra string-cluster search that
  *ruled out* static metadata in the exe (Session 09).
- `scripts/peek-cache.ts` — scratchpad walker of the AM4-Edit metadata
  cache. Superseded by `parse-cache.ts` but kept for reference.
- `scripts/parse-cache.ts` — structural decoder for the cache. Parses
  Section 1 (87 global-setting records), Section 2 (465 records / 7
  blocks) and Section 3 (695 records / 17 sub-blocks + cab tables)
  cleanly into typed JSON.
- `scripts/map-cache-params.ts` — verifies KNOWN_PARAMS against the
  parsed cache with the pinned (pidLow → cache block) mapping, and
  dumps each main block's candidate parameter list.
- `scripts/gen-cache-enums.ts` — generates `src/protocol/cacheEnums.ts`
  and `docs/CACHE-DUMP.md` from the parsed cache JSON.
- `src/protocol/cacheEnums.ts` — generated Amp/Drive/Reverb/Delay type
  dictionaries, imported by `params.ts`.
- `docs/CACHE-DUMP.md` — committed human-readable dump of the 4 mapped
  blocks (ids, kinds, ranges, enum values).
- `docs/CACHE-BLOCKS.md` — every cache block with tentative effect-role
  assignment + evidence + capture TODO list.
- `src/server/index.ts` — MCP server over stdio. Tools: `set_param`,
  `list_params`, `list_enum_values`.
- `scripts/smoke-server.ts` — client-side MCP handshake harness
  verifying the server comes up and serves tool listings.
- `docs/MCP-SETUP.md` — Claude Desktop wiring instructions.
- `scripts/dump-cache-head.ts` — hex+ASCII peek tool for cache offsets.
- `samples/captured/decoded/cache-strings.txt` — 7,610 length-prefixed
  strings extracted from `effectDefinitions_15_2p0.cache`.
- `samples/captured/decoded/cache-records.json` — parsed Section 1.
- `samples/captured/decoded/cache-section2.json` — parsed Section 2 (465 records across 7 blocks: routing + Amp tag=0x98 + Utility blocks).
- `samples/captured/decoded/cache-section3.json` — parsed Section 3 (695 records across 17 sub-blocks + 256 user-cab names/ids).
- `scripts/scrape-wiki.ts` — Fractal wiki scraper.
- `scripts/extract-lineage.ts` — parses wiki + Blocks Guide into the
  lineage JSONs. Re-run via `npm run extract-lineage`.
- `src/knowledge/amp-lineage.json` — 326 amp records (219 canonical +
  107 variant), with family/powerTubes/matchingDynaCab/originalCab +
  inspired-by + Fractal Audio quotes where available.
- `src/knowledge/drive-lineage.json` — 83 drive records (69 canonical +
  14 variant), each with categories + clipTypes + Blocks Guide
  description + wiki inspired-by.
- `src/knowledge/reverb-lineage.json` — 79 reverb type records (family-
  level descriptions) + a `__block_level__` record holding 41 Fractal
  Audio forum quotes about the reverb algorithm.
- `src/knowledge/delay-lineage.json` — 29 delay type records with
  Blocks Guide descriptions + per-type Fractal Audio quotes.
- `src/knowledge/compressor-lineage.json` — 19 compressor type records
  matched to `COMPRESSOR_TYPES`. Wiki + Fractal forum quotes; 8 carry
  distinct `inspiredBy` extracted from forum quotes that add gear info
  beyond the wiki description (LA-2A, Urei 1176, SSL Bus, Fairchild,
  Dynacomp, Rockman, Orange Squeezer, MXR Dyna Comp variants).
- `src/knowledge/phaser-lineage.json` — 17 phaser records (9 with
  basedOn: MXR Phase 90, Fulltone Deja-Vibe, EHX Bad Stone, Maestro
  MP-1, Morley Pro PFA, Korg PHS-1, Boss Super Phaser, Mutron Bi-Phase).
- `src/knowledge/chorus-lineage.json` — 20 chorus records (1 with
  basedOn via am4Name heuristic — Japan CE-2 → Boss CE-2; wiki has
  no per-type descriptions for this block).
- `src/knowledge/flanger-lineage.json` — 32 flanger records (10 with
  basedOn: MXR 117, Boss BF-2, EHX Electric Mistress, A/DA; many
  entries are FAS-original types named after songs).
- `src/knowledge/wah-lineage.json` — 9 wah records (6 with basedOn:
  Vox Clyde McCoy / V845 / V846, Dunlop Cry Baby, Colorsound, Morley,
  Tycobrahe Parapedal).
- `scripts/audit-lineage.ts` — data-quality checker for the lineage
  JSONs. Flags description/inspiredBy duplication, quote/field overlap,
  and markdown artifacts. Run ad-hoc via `npx tsx scripts/audit-lineage.ts`.
- **MCP tool** `lookup_lineage({ block_type, name? | real_gear? |
  manufacturer?/model? })` — forward lookup by canonical AM4 name,
  fuzzy reverse search by real-gear term (also catches artist queries
  via description-prose substring match), or exact structured filter
  against `basedOn.{manufacturer, model}` (BK-021). Answers queries
  like "classic MXR phaser" (manufacturer="MXR"), "LA-2A"
  (model="LA-2A"), or "Cantrell tone" via real_gear="Cantrell". Loads
  the JSONs lazily at first call. Server now exposes **11 tools**.
- `src/knowledge/cab-lineage.json` — 2048 cab records (full Axe-Fx III
  catalog; AM4 uses a 138-cab subset — filter once the CAB enum is
  decoded) + 12-creator attribution legend.

## How to use this file

Update at the end of every substantive session:
- Change "The single next action" to the next concrete step.
- Move completed items out of "Recent breakthroughs" once they're no
  longer urgent context.
- Keep the file under ~200 lines — it's an orientation doc, not an
  archive. Archive belongs in `SESSIONS.md` and `BACKLOG.md`.
