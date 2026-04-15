# Project State — Read This First

> Read this file at the start of every session. It's kept up-to-date with
> current phase, the single next action, and recent findings.
> Last updated: **2026-04-14** (Session 07 — parameter registry built and
> hardware-verified end-to-end via captured-byte comparison).

---

## Current phase

**Phase 1 — Protocol RE: 🟢 COMPLETE AND HARDWARE-VERIFIED.** First real
write produced visible parameter change on the device (Session 05).

**Phase 2 — Parameter registry + preset IR + transpiler.** Registry +
working-buffer IR + transpiler all shipped and capture-verified in
Session 07. Two open questions remain before the IR can grow to cover
full presets: **(a) how channel A/B/C/D selection is encoded** (capture
recipe below), and **(b) bulk parameter discovery** (Ghidra metadata
table extraction below).

## The single next action

### Channel-switch capture pair (highest priority)

Goal: discover whether the active block channel (A/B/C/D) is encoded in
the SET_PARAM address or selected by a separate message.

**Setup (one-time prerequisites — confirmed working in Session 04):**
- AM4 powered on, USB connected
- AM4-Edit v1.00.04 running and connected to the AM4
- Wireshark **launched as Administrator** (right-click → Run as admin)
- Capture interface: **USBPcap2** (the AM4 enumerates on the same root
  hub as the fingerprint reader on this ThinkPad)
- A working Git Bash terminal in `C:/dev/am4-tone-agent/`

**Capture procedure — repeat once per channel:**

For each (channel, filename) pair below:
1. In AM4-Edit, navigate to a preset (any preset is fine — the address
   is preset-independent). Click the **Amp** block to focus it.
2. Use AM4-Edit's channel selector to set the Amp block to the target
   channel (A or B). Confirm the channel indicator updates.
3. In Wireshark, start capture on **USBPcap2**.
4. **Wait ~2 seconds** of idle so the steady-state poll baseline is
   captured before any user action. Then change the **Amp Gain** value
   to a clearly different number (e.g. type `5.0` and press Enter — not
   the same value as your starting point, otherwise AM4-Edit may
   suppress the write).
5. Wait ~2 more seconds, then stop the capture.
6. **File → Save As** → save to:
   - Channel A run: `samples/captured/session-08-amp-gain-channel-A.pcapng`
   - Channel B run: `samples/captured/session-08-amp-gain-channel-B.pcapng`

**Decode both captures to text:**

```bash
tshark -r samples/captured/session-08-amp-gain-channel-A.pcapng \
       -Y sysex -V \
       > samples/captured/decoded/session-08-amp-gain-channel-A.tshark.txt

tshark -r samples/captured/session-08-amp-gain-channel-B.pcapng \
       -Y sysex -V \
       > samples/captured/decoded/session-08-amp-gain-channel-B.tshark.txt
```

(`tshark` lives at `C:\Program Files\Wireshark\tshark.exe` — already on
PATH after a standard Wireshark install.)

**Once both `.tshark.txt` files exist, the analysis steps are:**

1. `npx tsx scripts/parse-capture.ts samples/captured/decoded/session-08-amp-gain-channel-A.tshark.txt`
   — grep the output for the rare `1×` body that starts with `013a000b` (Amp pidLow `0x003a`,
   Gain pidHigh `0x000b`) and `0001` action — that's the channel-A write.
2. Same on `...channel-B.tshark.txt` — same shape, that's the channel-B write.
3. Locate the full message in each capture (search the .tshark.txt for
   the body hex inside `[Reassembled data: f000017415... f7]`).
4. Diff the two full message bytes:
   - **Identical** → channel selected by an earlier message. Diff the
     *non-write* OUT traffic between the two captures to find it. Prime
     suspects: action codes `0x0110` and `0x010d` (logged in SESSIONS.md
     as Session 07 mysteries — only seen for specific Amp pidHighs).
   - **Differing** → channel encoded in `pidLow` or `pidHigh`. The diff
     shows exactly which bits flipped; update `params.ts` accordingly.

### Parallel: Ghidra-extract AM4-Edit's parameter metadata table

Highest-leverage non-capture work. AM4-Edit must store parameter names,
ranges, and enum dropdown strings (Amp Type, Cab IR, Drive Type, Reverb
Type, Delay Type) in static data — finding that table likely bulk-
unlocks hundreds of params at once.

**Setup:**
- Open `AM4-Edit.exe` in Ghidra (the same project used in Session 05 to
  find the float encoder — already analyzed).
- Existing companion script: `scripts/ghidra/FindEncoder.java` shows
  the script style (Ghidra Script Manager → New Script).

**What to look for:**
1. **String search** — likely fastest first pass. Search for known
   parameter names in the Defined Strings window:
   - `"Gain"`, `"Bass"`, `"Mid"`, `"Treble"`, `"Master"`, `"Level"`
   - `"TS808"` (the only Drive Type enum we know)
   - `"Reverb"`, `"Delay"`, `"Chorus"`, `"Phaser"`, `"Tremolo"`
   For each hit, list **References → To** and inspect the calling code.
   A long contiguous run of strings is almost always a metadata table.
2. **Cross-reference the SET_PARAM call site.** The encoder
   `FUN_140156d10` is called from somewhere; trace upward to find code
   that maps a UI control to a `(pidLow, pidHigh, scale, displayName)`
   tuple. That structure IS the metadata table.
3. **Look for arrays of struct-like records** near any param name
   string. Common shape: `{ const char* name; uint16_t pidHigh; float
   scale; uint8_t unitCode; ... }`.

**What to capture and drop in the repo:**
- Save findings to `docs/sessions/session-08-ghidra-notes.md` (create
  the dir if needed): table address, struct shape guess, screenshot or
  ASCII paste of 2–3 contiguous records.
- If an enum string table is found (e.g. all Drive Types in order),
  paste the raw strings — even unparsed it's gold.

Once the shape is known, write `scripts/ghidra/ExtractParamTable.java`
modeled on `FindEncoder.java` to dump the table mechanically, and feed
the output into `KNOWN_PARAMS` (`src/protocol/params.ts`).

## Decoded parameters and unit conventions

Live source of truth: `src/protocol/params.ts` (`KNOWN_PARAMS` + `Unit`
union). 7 params across 4 blocks (Amp `0x003A`, Drive `0x0076`, Reverb
`0x0042`, Delay `0x0046`) using 5 unit conventions (`knob_0_10`, `db`,
`percent`, `ms`, `enum`). `pidLow` = block ID, `pidHigh` = parameter
index within block; address is preset-independent. Drive Type enum has
only one entry catalogued so far (8 = `TS808`).

## Recent breakthroughs

Older breakthroughs (sessions 04–06) are archived in `SESSIONS.md`. Only
session-07 (current) is kept here for fast orientation.

1. **Working-buffer IR + transpiler shipped** (Session 07). `src/ir/`
   exports `WorkingBufferIR` (flat param map) and `transpile(ir)` →
   `number[][]`. `npm run verify-transpile` confirms 3/3 emitted
   messages equal `buildSetParam(key, value)` and `amp.bass=6` still
   matches the captured AM4-Edit wire bytes.
2. **Parameter registry shipped and hardware-verified** (Session 07).
   `src/protocol/params.ts` → `KNOWN_PARAMS` (7 params keyed
   `block.name`), `Unit` union, `encode`/`decode`. `setParam.ts` gained
   `buildSetParam(key, displayValue)`. `verify-msg.ts` 4/4. End-to-end
   pipeline closed: display value → unit scale → float pack → envelope
   → wire bytes identical to AM4-Edit.
3. **Channel-evidence partial** (Session 07): identical pidHighs polled
   across all 4 blocks (`0x0003`, `0x0f5d`, `0x0f66`); `0x0f66` polled
   most heavily for the focused block — likely block-level metadata
   (bypass / active channel / type), not per-param. **Channel-switch
   behaviour itself still needs the capture pair** in "next action".
   Mystery action codes `0x0026`, `0x0110`, `0x010d` logged in
   SESSIONS.md for later.

## What's known (status legend)

- Device comms, checksum, envelope, model ID, documented commands
  `0x08 / 0x0C / 0x0D / 0x0E / 0x13 / 0x14 / 0x64` — **🟢 confirmed**.
- Preset dump format (`0x77/0x78/0x79`) + slot addressing — **🟢 confirmed**.
- `0x01` SET_PARAM message format + value encoding — **🟢 fully decoded**.
- Parameter ID structure — **🟢 (Session 06, preset-independent)**.
- 7 params / 4 blocks / 5 units — **🟢 in `params.ts`**.
- Channel A/B/C/D addressing — **🟡 partial; capture pair pending (see
  next action)**.
- Drive Type enum table — **🟡 only `8 → TS808` known**.
- Full preset binary layout inside `0x78` chunks — **🔴 scrambled, parked**.

MVP scope, target-user definition, and write-safety rules are
authoritative in `CLAUDE.md` and `DECISIONS.md` — not duplicated here.

## Roadmap landmarks

- **Now:** channel-switch capture pair + Ghidra metadata extraction
  (both detailed in "single next action").
- **Then:** expand `WorkingBufferIR` → full `PresetIR` (block placement,
  4 scenes, per-block channel assignment) — needs (a) above.
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
- `scripts/probe.ts` — read-only device probe.
- `scripts/sniff.ts` — bidirectional MIDI proxy (superseded by USBPcap).
- `scripts/diff-syx.ts` — byte-level diff of two `.syx` files.
- `scripts/parse-capture.ts` — parses tshark dumps of USBPcap captures.
- `scripts/verify-pack.ts` — 10-sample round-trip test of float pack/unpack.
- `scripts/verify-msg.ts` — built-vs-captured message byte comparison.
- `scripts/write-test.ts` — first hardware write (Amp Gain).
- `scripts/verify-transpile.ts` — IR → command sequence round-trip check.
- `scripts/ghidra/FindEncoder.java` — Ghidra script that found the encoder.
- `scripts/scrape-wiki.ts` — Fractal wiki scraper.

## How to use this file

Update at the end of every substantive session:
- Change "The single next action" to the next concrete step.
- Move completed items out of "Recent breakthroughs" once they're no
  longer urgent context.
- Keep the file under ~200 lines — it's an orientation doc, not an
  archive. Archive belongs in `SESSIONS.md` and `BACKLOG.md`.
