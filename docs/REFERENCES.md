# External References — MCP MIDI Tools

Primary sources available locally or online, what they cover, and when to consult each.
Update this file whenever a new reference is added to the project.

---

## Official Fractal Audio documents (local)

All files below live in `docs/manuals/` unless noted. Plain-text `.txt` extractions
sit next to each PDF for grep-ability.

### `docs/manuals/AM4-Owners-Manual.pdf` (8.4 MB, extracted to `.txt`, 2956 lines)
Primary AM4 user manual from Fractal Audio. The authoritative source for:
- Hardware controls, footswitch functions, rear-panel I/O.
- Preset navigation model (A01–Z04, scenes, channels).
- Per-block parameter names as shown on the AM4 display — treat as **ground truth**
  for block-TYPE names and parameter labels when writing presets.
- Global setup menu (I/O, MIDI channel, noise gate, etc.).

### `docs/manuals/Fractal-Audio-Blocks-Guide.pdf` (3.7 MB, extracted to `.txt`, 4745 lines)
Deep per-block parameter reference covering the entire current Fractal product line
(Axe-Fx III / FM9 / FM3 / AM4 / VP4). Use when the AM4 owner's manual is too terse.
Contains:
- Full parameter lists for every effect block TYPE (e.g., every Delay type, every
  Reverb type) with parameter ranges and units.
- Channel/modifier/controller architecture.
- Is the correct source for "what does parameter X do" once you know the TYPE.

### `docs/manuals/Axe-Fx III MIDI for 3rd Party Devices.pdf` (220 KB, extracted to `AxeFx3-MIDI-3rdParty.txt`)
The only public SysEx protocol document from Fractal. AM4 is in the same family,
so this defines the "baseline" command set (bypass 0x0A, channel 0x0B, scene 0x0C,
patch/scene name query 0x0D/0x0E, status dump 0x13, tempo 0x14). **AM4 has been
empirically confirmed to follow this spec** (session 02, 2026-04-14) with AM4-specific
extensions above block ID 200 and an internal editor-streaming function `0x01`
not documented here. See `docs/SYSEX-MAP.md` for the AM4-resolved mapping.

### `samples/factory/README AM4+VP4 Presets Update Guide.pdf` (extracted alongside)
Short guide on using **Fractal-Bot** (the librarian built into AM4-Edit) to push
`.syx` files to the device. Confirms that `.syx` files are literal SysEx byte
streams — the same bytes sent over USB MIDI during upload — and that AM4/VP4
banks are handled differently from Axe-Fx III family banks.

### `samples/factory/AM4-Factory-Presets-1p01.syx` (1.28 MB)
Full AM4 factory preset bank as distributed by Fractal. Contains all 104 slots
worth of presets in a single `.syx` dump. Can be parsed the same way as
individual exports (header `0x77` / chunks `0x78` / footer `0x79`) — multiplied
by the number of presets.

---

## Other-manufacturer manuals (local)

Docs for devices on the multi-device expansion roadmap (BK-014..BK-020).
All files live in `docs/manuals/other-gear/`. **PDFs are gitignored** for
copyright and size reasons; only the plain-text extractions are committed.
If you need the source PDF, obtain it from the manufacturer's downloads
page. Extract with `pdftotext -layout <file>.pdf <file>.txt` (ships with
Git for Windows).

### Fractal Audio — Axe-Fx II XL+ (BK-014)
*No manuals local yet.* Add Axe-Edit III docs and the Axe-Fx II MIDI
reference here when BK-014 activates.

### Roland SPD-SX (BK-019)
- `SPD-SX_OM.txt` — Owner's Manual. Primary reference. **Key sections for
  BK-019:** USB save/load (pp. 65–66), USB MODE switch (p. 63),
  documented MIDI surface (pp. 67–68).
- `SPD-SX_Wave_Manager_e02.txt` — "Using SPD-SX Wave Manager" guide.
  Doesn't contain the USB protocol, but documents every operation Wave
  Manager performs on kit/wave data — serves as the **feature spec** for
  the flash-drive-based MCP approach chosen in BK-019.
- `SPD-SX_EffectGuide.txt` — Master + Kit effect parameter reference.
  Needed when BK-019 extends from kit-structure editing to per-effect
  parameter editing.
- `SPD-SX_PA.txt` — Sound List (Factory Data v1.01). 210 factory wave
  names. Useful when the agent references waves by name while assigning
  them to kits.
- **No MIDI Implementation Chart exists.** Roland publishes only four
  SPD-SX docs (OM, Wave Manager, Effect Guide, Sound List) — no separate
  MIDI Impl PDF, unlike JD-Xi / VE-500. Documented MIDI surface is thin
  (Program Change, Control Change, Note on/off only). This is why
  BK-019's feature scope goes through the USB flash drive path.

### Roland JD-Xi (BK-020)
- `JD-Xi_MIDI_Implementation.txt` — full MIDI Implementation Chart.
  Primary reference for BK-020; complete address table + parameter
  ranges + tone-category enums.

### ASM Hydrasynth Explorer (BK-031, founder-owned 2026-04-25)
- `Hydrasynth_Explorer_Owners_Manual_2.2.0.txt` — full owner's manual
  (5,695 lines). Single source for everything: synthesis architecture,
  modulation matrix, system setup, MIDI implementation. **Primary
  reference for BK-031.** ASM does not publish a separate MIDI
  Implementation Chart PDF — the manual is the spec.
  - **MIDI CC chart** at pp. 94–96 of the PDF (lines 5353–5605 in the
    `.txt`). The chart is laid out as two side-by-side tables ("Sorted
    by Module" + "Sorted by CC Number") and `pdftotext` interleaves
    the columns — the `.txt` extraction is **not directly parseable**.
    Re-extract via column-restricted `pdftotext -layout` or hand-
    transcription before generating a CC table. See
    `docs/devices/hydrasynth-explorer/MIDI-MAP.md` § FOLLOW-UPS.
  - **MIDI system setup** at pp. 80–83 (Param TX/RX = CC vs NRPN,
    Bank Select scheme, MPE toggle, Send Patch / Send All Patches
    SysEx triggers).
  - **Patch architecture** at pp. 74–77 (Browser, Save, Compare,
    Favorites).
- `Hydrasynth_KB_DR_Owners_Manual_2.2.0.pdf` — manual for the
  larger Hydrasynth Keyboard / Desktop / Deluxe siblings. Same
  synthesis engine, additional features (multi-patch on Deluxe, real
  ribbon controller). Useful when Hydrasynth-line-wide questions come
  up; the Explorer manual takes precedence for our device.
- `Hydrasynth_Single_Factory_Patch_Listing_2.0.xlsx` — official
  factory-patch list (8 banks × 128 patches). Bank / program / name /
  category. Source for the BK-031 `list_hydrasynth_patches` tool —
  parse once into JSON during BK-031 step B.
- **Working device folder:** `docs/devices/hydrasynth-explorer/`
  (created on the `hydrasynth-explorer` branch 2026-04-25). Contains
  `OVERVIEW.md` (capability matrix), `MIDI-MAP.md` (working protocol
  reference), `FIRST-SMOKE.md` (round-trip test plan).
- **No SysEx implementation chart published** by ASM. The "Send
  Patch" / "Send All Patches" actions on the device emit SysEx in an
  undocumented format. Decoding is BK-031 step E (stretch goal).
- **NRPN mapping not in the manual.** The manual states NRPN mode
  addresses the same parameters as CC mode at higher resolution but
  doesn't publish the MSB/LSB pairs. Decode by capturing MIDI from
  the device with Param TX = NRPN — a one-shot founder hardware task
  when BK-031 starts.

### Boss VE-500 (BK-018)
- `VE-500_MIDI_ImpleChart.txt` — MIDI Implementation Chart. Confirms the
  SysEx address map is **closed** ("Specifications of System Exclusive
  message is not opened for users") — so deep editing requires
  capture-based RE of Boss Tone Studio; the CC + Program Change surface
  is what's available out of the box. See BK-018 for scope implications.

### Boss RC-505 MKII (BK-017)
*No manuals local yet.* Add the RC-505 MKII MIDI Implementation PDF
from boss.info when BK-017 activates.

---

## Community sources (online, not local)

### Fractal Audio Wiki — `https://wiki.fractalaudio.com/wiki/index.php`
Scraped copy lives in `docs/wiki/` (gitignored; regenerate via
`npm run scrape-wiki -- P0` for block params, `P1` for protocol pages).
- `MIDI_SysEx` page — what little is documented for AM4 on the wiki (5 mode-switch
  commands). The rest of the AM4 protocol is inferred from the Axe-Fx III PDF
  above, not the wiki.
- Block pages (`Amp_block.md`, `Delay_block.md`, etc.) — community parameter
  notes, often matching the Blocks Guide PDF.

### Fractal Audio Forum — `https://forum.fractalaudio.com`
Active community. Useful search terms:
- "AM4 sysex" — user experiments and findings.
- "preset format" — reverse-engineering discussions (mostly Axe-Fx III, some apply).
- "3rd party MIDI" — expected usage and gotchas.

### Axe-Fx III preset-format reverse-engineering
Community projects that have partially reverse-engineered the Axe-Fx III preset
binary are potential cross-references for AM4 (same family, similar format):
- Not formally indexed here; search `github.com` for `axefx3` / `fractal preset parser`.

---

## Our own generated references

### `docs/BLOCK-PARAMS.md`
Committed working reference for AM4 block types and their available effect TYPEs.
Distilled from the wiki scrape + AM4 owner's manual. First stop when building a
preset IR.

### `docs/SYSEX-MAP.md`
Working SysEx protocol reference, AM4-resolved. Updated after every sniff/probe
session. First stop when encoding a message to send.

### `docs/SESSIONS.md`
Chronological log of every reverse-engineering session with raw captures and
decoded findings. Use to understand how a claim in SYSEX-MAP became confirmed.

### `src/knowledge/*-lineage.json`
Model lineage dictionaries generated from the wiki scrape + Blocks Guide PDF
by `scripts/extract-lineage.ts`. One file per block (amp/drive/reverb/delay/
cab). Each record carries `am4Name` (canonical from `cacheEnums.ts`),
`inspiredBy` (with `source` tag), `description`, `fractalQuotes`, and
block-specific metadata (family/powerTubes/matchingDynaCab for amps;
categories/clipTypes for drives; creator prefix for cabs). Re-run via
`npm run extract-lineage` whenever the wiki scrape is refreshed.

Provenance policy: only Fractal-authored content is captured (Blocks Guide
entries, wiki parentheticals, forum quotes attributed `[Fractal Audio]`).
Brand-authored quotes (Xotic, JHS, Macari's) and community-inferred
qualitative tags (genre, era, mood adjectives) are deliberately omitted to
avoid hallucination risk — any record without a Fractal source has its
field populated via `flags: ['VERIFY: ...']` and no `inspiredBy`.

### `docs/DECISIONS.md`
Architectural and scope decisions with rationale. Read before proposing changes
to: MIDI library choice, module system, distribution model, MVP scope, or
write-safety protocol.

---

## How to use this file

- Before searching the web, check whether a local manual covers the question —
  `grep -l <term> docs/manuals/*.txt` is fast and precise.
- When adding a new PDF or external reference to the project, add a section to
  this file so future Claude Code sessions discover it without rescanning.
- Prefer the AM4 owner's manual over the Blocks Guide when they disagree on
  AM4-specific behavior — the Blocks Guide covers the whole product line and
  may describe features not present on AM4.
