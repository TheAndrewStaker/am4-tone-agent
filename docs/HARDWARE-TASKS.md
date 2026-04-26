# Hardware Tasks Queue

> **Single queue for all founder-owed verification tasks.** Includes
> physical actions at the device (USB captures, round-trips, reference
> dumps, knob-wiggle spot-checks) AND non-device tests Claude can't
> self-verify (Claude Desktop conversational smoke tests, release-gate
> behavioural checks). Claude Code appends to this file whenever a
> task is identified, without waiting for explicit prompting. Check
> this file at the start of each session; check it again before
> heading to the device so related items can be batched.
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
> Last updated: 2026-04-25 (Session 30 cont — HW-019 + HW-020 +
> HW-021 decoded + archived. **14 new params**: 5 drive (low_cut /
> bass / mid / mid_freq / treble), 3 delay (level / stack_hold /
> ducking), 6 compressor (level / threshold / ratio / attack /
> release / auto_makeup). New unit `ratio` added for compression
> ratios. KNOWN_PARAMS 79 → 93; verify-msg goldens 60 → 74;
> CACHE_PARAMS 69 → 79.
> **Methodology finding**: AM4-Edit's UI is type-dependent —
> different drive types expose different first-page knobs.
> TS808 OD only had drive/tone/level (3 knobs); Blackglass 7K
> exposed those plus 6 EQ-page knobs. Compressor JFET Studio
> exposed 8 knobs (vs the spec's Studio FF assumption). This
> caught us by surprise; queued as **HW-030** = research task
> to map "type → exposed first-page knobs" for every block,
> either by AM4-Edit screenshot pass or by deeper cache-decode
> for per-type visibility flags.
> Three residual addresses queued: HW-027 (delay tempo enum
> extraction at 0x0013), HW-028 (compressor 0x0017 + 0x0029
> unidentified knobs), HW-029 (drive 0x002d unidentified knob).
> Updated priority order: HW-022 > HW-023 > HW-024 > HW-016 >
> HW-030 > HW-017 > HW-026/027/028/029 residuals.
>
> Pre-existing: Session 30 — HW-018 + HW-025 decoded + archived.
> BK-033 fixed (predelay address 0x10 → 0x13). BK-034 cleared as
> not-a-code-bug — captures show our wire is byte-identical to
> AM4-Edit's for all 4 disputed params; HW-014 hardware-display
> divergence is an AM4 screen-rendering quirk. HW-018 added 10
> reverb registers; HW-026 queued for the residual `pidHigh=0x0000`
> Reverb register.)

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

<!-- HW-024 completed 2026-04-25 (Session 30 cont 3) — see Archive
     below for the test report and findings. -->

### HW-032 — Capture newly-discovered first-page knobs (HW-024 finding F4) 🔜

- **For:** HW-024's Phase-2 readback inventoried the AM4 hardware
  display pages for several blocks and surfaced ~25 first-page
  knobs that aren't yet in our param registry. These are the next
  batch of high-value coverage to add.
- **Newly-discovered first-page knobs by block:**
  - **Gate** (HIGH priority — core gate functionality currently
    missing): Threshold, Attenuation, Attack, Release, Hold,
    Sidechain Source, Level.
  - **Filter** (Low-Pass) (HIGH priority — only freq + type
    mapped): Q, Order, Low Cut, High Cut, Level. Plus filter
    page 2: Mode Enable, Mod Type, Frequency, Mod Frequency,
    Mod Rate, Mod Tempo (modulation subsystem).
  - **Flanger** (HIGH priority — only rate + depth + feedback +
    mix + tempo mapped after HW-027; missing Manual, Mod Phase,
    Level).
  - **Enhancer** (MEDIUM): Width, Phase Invert, Pan Left, Pan
    Right, Level. Stereo utility params.
  - **Volpan** (Auto-Swell mode) (MEDIUM): Threshold, Attack,
    Taper, Level. Auto-Swell envelope params.
- **Why:** these are knobs a typical user reaches for. Adding
  them lifts MVP "we cover what users want to set" from "every
  Type knob + the universal mix/balance" to "every block's first
  page." Dovetails with TYPE-KNOBS.md growth.
- **Capture strategy:** one pcapng per block, wiggling each new
  knob in turn. Same methodology as HW-019/020/021. Rough
  capture count: 5 pcapngs (gate, filter, flanger, enhancer,
  volpan).
- **Suggested filenames:**
  - `samples/captured/session-32-gate-extended.pcapng`
  - `samples/captured/session-32-filter-extended.pcapng`
  - `samples/captured/session-32-flanger-extended.pcapng`
  - `samples/captured/session-32-enhancer-extended.pcapng`
  - `samples/captured/session-32-volpan-extended.pcapng`
- **Signal completion:** *"HW-032 done"* + saved paths. Claude
  decodes via `extract-final-writes`, registers the new pidHighs
  in `params.ts` + `paramNames.ts`, and adds verify-msg goldens
  for each.
- **Audio-effect spot-check (bonus):** while at the device, do a
  one-knob-at-a-time A/B for each of the **4 hidden-balance
  blocks** that wire-ack but don't display (amp / chorus /
  flanger / drive being most likely-to-have-stereo-effect). Set
  balance to -100 vs +100; listen for L/R pan. Same for
  `enhancer.mix` (HW-024 finding F1 — phantom on display, but
  audio-effect status unknown). Reports back let us tag each
  param accurately.
- **Priority:** medium — biggest coverage jump for everyday
  user knobs. Recommend pairing with HW-016 next time at the
  device.

### HW-024 — Complete HW-014 spot-check (Round 4 + re-tests + missed params) ✅
*See Archive below for the test report and findings.*

<!-- HW-025 completed 2026-04-25 (Session 30) — see Archive below for the
     decode summary. -->

<!-- HW-015 completed 2026-04-21 — see Archive below -->


<!--
  HW-018 through HW-023 are the release-gate "AM4-Edit first-page coverage"
  task family, scoped 2026-04-21 by founder direction: the release target
  is every parameter on AM4-Edit's first page of every block type, because
  "those are the primary options an intermediate-to-advanced user would
  want to use." See `docs/04-BACKLOG.md` BK-032 for scope rationale.

  Optimized 2026-04-21 cont: one-pcapng-per-block with sequential wiggles
  replaces the original per-knob-per-file plan. Capture count dropped
  from 58 → 13. Each knob produces a unique pidHigh in the wire; the
  decoder reads the pidHigh transitions in order and aligns them to the
  BG-documented Basic Page sequence listed below. Post-decode cross-
  checks against known pidHighs (where overlaps exist) validate the
  alignment before registering new entries.

  ## Capture discipline (applies to all HW-018..HW-023)

  1. Start USBPcap recording on the AM4's USB interface (same as HW-015).
  2. Load the target block and preset described in each task.
  3. **Wiggle each knob in the order listed, one at a time.** Move
     each knob from its current value to a clearly-different value
     (e.g. 3 → 7, or rotate through a few enum options). Don't
     sweep — a couple of discrete moves per knob is cleanest.
  4. **Pause ~1 second between knobs** — the gap gives the decoder
     clean separation when the wire traffic from knob N ends and
     knob N+1 begins. Without the gap, overlapping writes get harder
     to disambiguate.
  5. For enum selectors (Type / Mode / OFF/ON), click through 2-3
     options in sequence; the wire will show the pidHigh transition
     on each click.
  6. Stop recording. Save as the filename shown in each task.
  7. Signal "HW-NNN done" with the saved path.

  Priority order (most-used block first):
    HW-018 Reverb → HW-019 Drive → HW-020 Delay
    HW-021 Compressor → HW-022 Modulation → HW-023 Secondary
-->

<!-- HW-018 completed 2026-04-25 (Session 30) — see Archive below for the
     decode summary. -->

### HW-030 — Map "type → exposed first-page knobs" for every block 🔜

- **For:** removes the surprise-factor from every future BK-032 HW
  capture. AM4-Edit's UI is type-dependent (TS808 OD shows 3 knobs
  on Drive's first page; Blackglass 7K shows 9; Klone Chiron
  relabels Tone→"Treble" / Level→"Output"). Today we have no
  committed map of which type exposes which first-page knobs, so
  every HW capture spec ends up partial.
- **Step 1 (cache-side decode) — DONE, partial fail.** Session 30
  cont investigation ruled out the simplest hypotheses: (a) no
  per-type subset table after section 3 (only 2 bytes unparsed
  in a 129 KB file), (b) `english.laxml` is just UI string
  translations, (c) AM4-Edit installs no other metadata files.
  The remaining `extra` field per cache record gives a partial
  signal (extra=1 correlates with universal-knob status; extra=0
  with type-dependent) but isn't a complete per-type map. The
  per-type rendering logic appears compiled into AM4-Edit.exe
  (21.7 MB binary). Findings written up in `docs/TYPE-KNOBS.md`
  with the universal-knob set + Drive/Delay/Compressor/Reverb
  per-type rows seeded from existing captures.
- **Step 2 — Lazy AM4-Edit screenshot pass** (founder hardware,
  ongoing). Don't try to enumerate all 700+ block-type
  combinations upfront. Instead, when you next have AM4-Edit
  open at the device, screenshot the Edit page for 2–3 types per
  block (one minimalist + one feature-rich + one outlier), append
  rows to `docs/TYPE-KNOBS.md`'s per-type tables. ~15 blocks × 3
  types × ~5 min each = ~4 hours total spread across sessions.
- **Why:** lazy population is enough for MVP. Claude can use
  TYPE-KNOBS.md to give "knob X isn't on type Y, switch types
  first" hints for the captured types, and fall back to a
  permissive write-anyway behaviour for uncatalogued types
  (preserving the wire-permissive nature we know from HW-014's
  `geq.balance` finding). Full coverage doesn't gate release.
- **Pass criterion:** `docs/TYPE-KNOBS.md` has at least 2–3 type
  rows per block for the 5 most-used blocks (Amp, Drive, Delay,
  Reverb, Compressor). Modulation + secondary blocks queued
  behind HW-022/023.
- **Signal completion:** *"HW-030 step 2 partial — added
  {block}/{type} rows"* + path to AM4-Edit screenshot screenshots
  if helpful. No single done-signal — file grows opportunistically.
- **Priority:** medium — useful but not gating. HW-022/023 can
  proceed in parallel (capture whatever AM4-Edit exposes for the
  type the founder picks, document it as we go).
- **Optional — HW-031 (Ghidra investigation of AM4-Edit.exe).**
  If lazy step 2 turns out to be too tedious or Claude wants
  full coverage automatically, queue a Ghidra session to look
  for per-type Qt page-template resources inside the .exe. Not
  scoped here — would need its own HW-NNN.

### HW-029 — Resolve unidentified Drive `pidHigh=0x002d` (knob_0_10) 🔜

- **For:** closes the residual register from HW-019 decode. The
  Blackglass 7K capture wrote 0x002d once with internal float 0.3.
  Cache id=45 has signature `float a=0 b=1 c=10 d=0.001 extra=0`
  (knob_0_10) but no Blocks Guide name match.
- **Why:** the EQ-page knobs (Bass/Mid/Treble/Mid Freq/Low Cut)
  were registered by cache-id sequence; this register sits in the
  cache "tail" zone (ids 39+ where Diode A/B + post-EQ + advanced
  knobs live). Without a wiggle-isolation capture, naming it
  would replay the Session 26 Master/Presence mis-inference class
  of bug.
- **Setup:** AM4 plugged in, AM4-Edit open, USBPcap recording.
  Same methodology as HW-015.
- **Capture: 1 pcapng** —
  `samples/captured/session-31-drive-id45.pcapng`. Load
  Blackglass 7K. Switch to AM4-Edit's Advanced page. Identify
  the knob whose adjustment writes to `pidLow=0x0076 / pidHigh=0x2d`
  (move each Advanced-page knob in turn until you see the wire
  match the address). Note the knob's UI label.
- **Signal completion:** *"HW-029 done"* + saved path + UI label
  observed.
- **Priority:** low — bounded scope. Does not block release.

### HW-028 — Resolve unidentified Compressor `pidHigh=0x0017` + `pidHigh=0x0029` 🔜

- **For:** closes residual registers from HW-021 decode. JFET
  Studio capture wrote both addresses but neither matches a
  Blocks Guide knob clearly. Cache id=23 (0x17) is `float a=0
  b=1 c=20 d=0.0005` (display 0..20, fine step). Cache id=41
  (0x29) is `float a=0 b=1 c=10 d=0.001` (knob_0_10 cap b=1) but
  the capture wrote internal 1.2 — exceeds cache cap, suggesting
  either the cap is inaccurate or this register is something
  else entirely.
- **Why:** like HW-029, registering these without a wiggle-
  isolation capture risks mis-inference. Knee Type (cache id=14
  enum HARD/MED-HARD/MEDIUM/MED-SOFT/SOFT) and Detector Type
  (cache id=16 enum RMS/PEAK/RMS+PEAK/HALF-WAVE) are the
  obvious "missing" comp-page knobs we'd expect; one or both of
  0x17 / 0x29 might map elsewhere on the JFET Studio's UI (a
  type-specific knob like JFET Drive or Saturation).
- **Setup:** as HW-029.
- **Capture: 1 pcapng** —
  `samples/captured/session-31-comp-jfet-id23-id41.pcapng`. Load
  JFET Studio. Wiggle each remaining first-page knob (Knee Type,
  Detector Type, Output, JFET-specific knobs) in turn, pausing
  ~1s between, until 0x17 and 0x29 are each isolated.
- **Signal completion:** *"HW-028 done"* + saved path + which
  knobs landed at 0x17 and 0x29.
- **Priority:** low — bounded scope.

<!-- HW-027 completed 2026-04-25 (Session 30 cont 2) — see Archive
     below for the decode summary. -->


### HW-026 — Resolve unidentified `pidHigh=0x0000` on Reverb (likely Level) 🔜

- **For:** closes the residual register from HW-018 decode. Both Hall
  and Spring captures wrote 12 / 7 times respectively to
  `pidLow=0x0042 / pidHigh=0x0000` with continuous-slider sweep
  patterns (final ≈0.56 / 0.74). The cache has no metadata at id=0
  for the reverb block, so structural inference alone can't pin it.
- **Why:** likely candidate is `reverb.level` (the output-level dB
  knob shown on the right side of the AM4-Edit Reverb Config page —
  screenshot value -5.6 dB). But a raw-dB interpretation of the
  capture's 0..1 range doesn't match the screenshot's -5.6 dB, so
  either the encoding is normalized 0..1 representing some dB curve,
  or 0x0000 is a different knob entirely.
- **Setup:** AM4 plugged in, AM4-Edit open, USBPcap recording. Same
  methodology as HW-015.
- **Capture: 1 pcapng** — `samples/captured/session-31-reverb-level.pcapng`.
  Load any reverb type. **Set the Level knob in the right-hand panel
  to exactly -10.0 dB** (or some other clearly-distinct value), one
  discrete write. The wire bytes will reveal both the address (if
  it lands at 0x0000 → confirmed Level; if elsewhere → 0x0000 is
  something else) and the encoding (raw dB vs normalized).
- **Signal completion:** *"HW-026 done"* + saved path.
- **Priority:** low — bounded scope. Output Level is a "quality of
  life" knob, not core to MVP tone-shaping. Does not block release.

<!-- HW-019 + HW-020 + HW-021 completed 2026-04-25 (Session 30 cont)
     — see Archive below for the decode summaries. -->

### HW-022 — Modulation blocks first-page completion 🔜

- **For:** BK-032 — #5 priority. Bundles chorus / flanger / phaser
  / tremolo since they share LFO-based structure.
- **Why:** Each has Rate / Depth / Mix registered; Tempo, Manual,
  LFO controls, block-specific structure (chorus.voices,
  phaser.order) missing.
- **Captures: 4 pcapngs** (one per block — each has its own pidLow
  so they must be in separate recordings).

  **Capture A — Chorus:**
  `samples/captured/session-30-chorus-basic.pcapng`

  Load any Chorus type. Wiggle in this order:
  1. Number Of Voices (count 2..8)
  2. Tempo (enum)
  3. Delay Time (ms)

  **Capture B — Flanger:**
  `samples/captured/session-30-flanger-basic.pcapng`

  Load any Flanger type. Wiggle in this order:
  1. Tempo (enum)
  2. Manual (ms)
  3. Low Cut (Hz)
  4. High Cut (Hz)
  5. Bass Focus (if exposed)
  6. Drive (if exposed)

  **Capture C — Phaser:**
  `samples/captured/session-30-phaser-basic.pcapng`

  Load any Phaser type. Wiggle in this order:
  1. Tempo (enum)
  2. Depth (%)
  3. Manual
  4. Tone
  5. Order / Stages — **this resolves the HW-017 phaser id=22
     ambiguity**

  **Capture D — Tremolo:**
  `samples/captured/session-30-tremolo-basic.pcapng`

  Load any Tremolo/Panner type. Wiggle in this order:
  1. Tempo (enum)
  2. LFO Type (waveform enum)
  3. LFO Duty Cycle

- **Signal:** *"HW-022 done"* + 4 saved paths.

### HW-023 — Secondary blocks first-page completion 🔜

- **For:** BK-032 — #6 priority. Catches wah / filter / gate / GEQ.
  Also resolves HW-017's filter id=28 question.
- **Why:** These blocks currently have only Type + Balance (+
  Filter Freq). User-facing knobs missing for each.
- **Captures: 4 pcapngs** (one per block).

  **Capture A — Wah:**
  `samples/captured/session-30-wah-basic.pcapng`

  Load any Wah type. Wiggle in this order:
  1. Frequency (Hz — move the wah-pedal position simulation)
  2. Resonance / Q
  3. Min Frequency (Expert page)
  4. Max Frequency (Expert page)

  **Capture B — Filter:**
  `samples/captured/session-30-filter-basic.pcapng`

  Load any Filter type. Wiggle in this order:
  1. Order — **resolves HW-017 filter id=28** (2nd vs 4th order)
  2. Q / Resonance

  **Capture C — Gate/Expander:**
  `samples/captured/session-30-gate-basic.pcapng`

  Load any Gate/Expander type. Wiggle in this order:
  1. Threshold (dB)
  2. Ratio
  3. Attack (ms)
  4. Release / Hold Time (ms)

  **Capture D — Graphic EQ:**
  `samples/captured/session-30-geq-basic.pcapng`

  Load a Graphic EQ. Wiggle each of the 10 band-gain sliders in
  order (lowest frequency band first, highest last). One wiggle per
  band, then move to the next.

- **Signal:** *"HW-023 done"* + 4 saved paths.

---

### HW-017 — Disambiguate count-type candidates (Session 29 follow-up) 🔜

- **For:** closes the count/semitones naming follow-up in STATE.md's
  AM4-depth queue. Five cache candidates have integer-step signatures
  whose UI names can't be determined from Blocks Guide text alone —
  they need single-knob captures to pin the label.
- **Why:** Session 29's headline finding was that cache-signature-only
  naming caught a Master/Presence mis-inference. These five candidates
  are in the same risk zone; registering them without a capture would
  re-open that class of bug. Each capture takes ~20 seconds.
- **Setup:** AM4 plugged in, AM4-Edit open, USBPcap running. Same
  methodology as HW-011 / HW-015.
- **Capture targets (5 knobs):**
  1. **Delay id=64 knob (pidHigh=0x0040, range 0..24 step=1).** Two
     candidates per Blocks Guide: "Number Of Taps" (Multi-Tap Delay
     type) OR "Bit Reduction" (Mono Delay type). Load a Multi-Tap
     delay type and wiggle the taps knob; then load a Mono Delay and
     wiggle the Bit Reduction knob. Whichever capture writes to
     `pidHigh=0x0040` is the answer. Save as
     `session-30-delay-taps.pcapng` and
     `session-30-delay-bit-reduction.pcapng`.
  2. **Phaser id=22 knob (pidHigh=0x0016, range 0..11 step=0).**
     Blocks Guide says phaser has an "Order" control "Sets the number
     of phase shifting circuits--or 'stages'--in increments of two"
     from 2 to 12. Cache range 0..11 might be index 0..5 mapped to
     2,4,…,12 — or something else entirely. Wiggle the Order/Stages
     knob once; the capture's float value tells us. Save as
     `session-30-phaser-order.pcapng`.
  3. **Drive id=24 knob (pidHigh=0x0018, range 0..24 step=1).**
     STATE.md tentatively called this `drive.bits` but Blocks Guide
     puts Bit Reduction on the Delay block (see #1), not Drive. This
     knob probably has a different role. Wiggle whatever knob on the
     Drive Edit page fits the 0..24 range (look for EQ/post-EQ shift
     or similar). Save as `session-30-drive-id24.pcapng`.
  4. **Gate id=14 knob (pidHigh=0x000E, range 1..20 step=0).**
     Structure suggests "Ratio" or similar threshold-shaping control.
     Wiggle any Gate knob that reads 1–20 range. Save as
     `session-30-gate-id14.pcapng`.
  5. **Filter id=28 knob (pidHigh=0x001C, range 1..12 step=0).**
     Possibly a filter "Order" similar to phaser, or "Stages" for a
     cascaded filter. Wiggle the matching knob. Save as
     `session-30-filter-id28.pcapng`.
- **Signal completion:** *"HW-017 done"* + list of saved paths. Claude
  processes captures via the same pipeline as HW-015 and registers
  named params for the ones that resolve cleanly. Any that still
  ambiguate (e.g. multiple wiggle captures pointing to the same
  pidHigh) get flagged for further investigation.
- **Priority:** low — unlocks ~5 niche params that aren't front-panel
  essentials. Defer behind HW-013 (release-gate), HW-014 (blocks
  release-gate by surfacing mid/treble verification), and HW-016
  (Claude Desktop smoke). Do when founder has free device time.

### HW-016 — Claude Desktop first-turn-tool-call smoke (P5-011 item 5) 🔜

- **For:** release-gate verification that the Session 28 cont tool-
  description rewrites (call-to-action leads + list_params sanity
  note) actually eliminated the Claude-Desktop spec-output failure
  mode observed on HW-012.
- **Why:** HW-012's root cause was Claude Desktop responding with
  a written spec instead of calling the tool, because (a) deferred
  tool schemas weren't loaded and (b) the Claude.ai project prompt
  biased toward spec output. We fixed (b) via the prompt rewrite
  (Session 27 cont) and (a) via the mutation-tool call-to-action
  leads (Session 28 cont). This test confirms the fix holds in a
  fresh conversation.
- **Setup:** Open a brand-new Claude Desktop conversation (not a
  continuation of an existing one — deferred-tool schemas load
  per-conversation). AM4 can be plugged in or not — this test is
  about Claude's *first-turn behaviour*, not whether the write
  succeeds. If plugged in, bonus: confirms the full execute-path
  too.
- **Prompts to try (one per conversation):**
  1. *"Make my amp louder."* — expected first-turn: a tool call
     (`set_param amp.gain <higher value>` or `set_param
     amp.level <higher value>`), not a spec explaining what
     command you'd need.
  2. *"Build me a clean preset."* — expected first-turn:
     `apply_preset` call, not a markdown preset-spec.
  3. *"What's on Z04 right now?"* — expected first-turn: a read
     attempt (`switch_preset Z04` + visual confirmation ask, or
     a `list_params`-based sanity note). Some spec output here
     is OK since we don't have a READ primitive; what's NOT OK
     is Claude claiming the connector is unavailable.
- **Pass criterion:** for prompts 1 + 2, first-turn message is a
  tool call. For prompt 3, first-turn engages the tools or asks
  the user to confirm on the device, but does NOT claim the
  connector isn't attached.
- **Fail criterion:** first-turn response is a prose spec with no
  tool calls, or claims the connector isn't attached without
  having attempted a tool call. If this happens, Claude owes
  another iteration on tool descriptions.
- **Signal completion:** *"HW-016 done"* + copy-paste of Claude's
  first-turn response for each prompt so we can tighten the
  descriptions if needed.
- **Priority:** medium — release-gate but bounded in impact. If
  it fails, we iterate on tool descriptions rather than block
  shipping on it.

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

### HW-015 — Advanced-controls capture session ✅

- **Captured 2026-04-21** — 12 pcapngs in `samples/captured/`:
  `session-29-amp-{master, master-2, depth, presence, output-level,
  out-boost-toggle}.pcapng`, `session-29-{delay, flanger,
  phaser}-feedback.pcapng`, `session-29-reverb-{size, plate-size,
  number-of-springs, spring-tone}.pcapng`. Founder captured beyond
  the original 8-knob scope — the reverb bonus captures (2 originally
  optional + 2 extra) and the out-boost toggle (added mid-session)
  round it out.
- **Decoded Session 29 — one structural correction + 11 new registers.**
  Core finding: `pidHigh=0x000F` on the Amp block was registered as
  `amp.presence` in Session 26 from cache signature alone. Two
  captures on Marshall-family amps proved the register is **Master**
  (not Presence), and the real Presence lives at `pidHigh=0x001E`.
  See SYSEX-MAP §6i for the full table of new addresses. 11 new
  byte-exact goldens in `verify-msg` (48/48 green); KNOWN_PARAMS
  grew 59 → 69 entries.
- **AM4-Edit quirk noted.** All 12 captures used `action=0x0002`
  on the wire, not the `action=0x0001` our builder emits. Value-byte
  packing matches byte-for-byte; only the action field differs. Both
  work on hardware — documented as a benign version/mode difference
  in SYSEX-MAP §6i.
- **Amp-depth release-gate movement.** HW-014 is now higher-priority
  because Session 29 surfaced a mis-inference (`amp.presence`→Master)
  that cache-signature-only naming missed. Mid/Treble at
  0x000D/0x000E remain structural and need HW-014 to close.

### HW-014 — P1-010 Session D structurally-decoded param spot-check ✅ (with bug findings)

- **Tested 2026-04-21** — built `P1010-D SPOT CHECK` preset on Z04
  with 4 rounds of distinctive-value writes across 15 of 17 block
  types. **28 params hardware-verified, 5 confirmed bugs, 27
  hidden on hardware display (not failures), 16 untested (Round
  4 enhancer/gate/volpan + 2 placement-only blocks). Bugs queued
  to BK-033 + BK-034; remainder coverage to HW-024 + HW-025.**
- **Verified correct (28 params)** — see
  Round-1..Round-3 readbacks in SESSIONS.md Session 29 cont 7.
  Headlines: (a) Session 29's `amp.master` (0x000F) /
  `amp.depth` (0x001A) / `amp.presence` (0x001E) re-mapping
  confirmed correct on a 5153 50W Blue (knobs were hidden on
  the original 1959SLP test because Plexis don't have a
  Master). (b) `amp.mid` / `treble` / `presence` / `bass` —
  all hardware-verified, clearing the Session-29 worry that
  other knob_0_10 amp registers might be cache-signature
  mis-inferences. The 0x000F Master-vs-Presence mistake was a
  one-off, not systemic. (c) `geq.balance` displayed at -67 —
  proves the universal Balance register works at the wire-layer
  (other blocks just hide it from the AM4 hardware display).
  (d) All 9 type enums verified (amp/drive/reverb/delay/
  chorus/tremolo/wah/filter/geq) — the cache-derived enum
  catalog is solid.
- **Bug 1 — `reverb.predelay` dead address (BK-033).** Three
  writes (85, 0, 250 ms) all wire-acked, display stayed at 20.0
  ms default. Sending the maximum value still didn't move it.
  Address (`pidLow=0x0042 / pidHigh=0x0010`) is wrong, or that
  register is something else (write-only diagnostic? hidden
  field?) and predelay lives elsewhere. Fixed via HW-025
  capture #1.
- **Bug 2 — per-block float encoding divergence (BK-034).**
  Four params: `chorus.rate` (3.4 Hz → 0.5 Hz), `flanger.mix`
  (54% → 50%), `flanger.feedback` (-61% → 0; +99% → 90%),
  `phaser.mix` (88% → 53%). Pattern: address verified
  (extreme values land), mid-range values land somewhere
  unrelated. The same `packFloat32LE` encoder works correctly
  for `delay.feedback`, `delay.mix`, `tremolo.rate`,
  `chorus.mix`, `reverb.mix`. So the bug is per-block
  firmware behavior, not the encoder. Most diagnostic
  observation: `chorus.rate` 3.4 → 0.5 Hz looks like
  log-knob mapping (knob 0.34 → 0.479 Hz on a 0.1..10 Hz log
  curve). Fix needs HW-025 captures #2..#5 to compare
  AM4-Edit's wire bytes against ours.
- **Hidden on hardware display (27 params, not failures).**
  Most balance/mix params on most blocks, plus
  `amp.tonestack_location`, `amp.master_vol_location`,
  `reverb.shift_1/2`, `reverb.springs/spring_tone` (non-spring
  type). These wrote and wire-acked but the AM4's hardware
  screen doesn't expose them. AM4-Edit would. Verifying via
  AM4-Edit is queued under HW-024 (not blocking release since
  `geq.balance` proved the Balance register works).
- **Cosmetic — model-specific drive labels.** On Klone Chiron,
  `drive.tone` displays as "Treble" and `drive.level` as
  "Output". Underlying register is the same, behavior matches
  the real Klon Centaur. Not a bug; worth a `params.ts`
  comment so future readers don't get confused.

### HW-013 — Round-trip `apply_preset` with `scenes[]` ✅

- **Tested 2026-04-21** — first attempt blocked: server saw only the
  Windows wavetable synth, no AM4. The connection-failure response
  named the four likely causes (off / unplugged / AM4-Edit grabbing
  the port / driver) and pointed at `list_midi_ports` +
  `reconnect_midi`. Founder reconnected, signaled "connected now,"
  and the second attempt completed cleanly: the kitchen-sink
  4-scene `apply_preset` on Z04 ("scene test") landed end-to-end
  and all changes were applied and verified on the device.
  Subsequent `set_scene_name` rename of scene 4 also persisted
  across in-session scene switches. **BK-027 phase 2 is now
  hardware-verified end-to-end.**
- **Bonus signal for HW-016 (deferred Claude Desktop smoke).**
  Claude Desktop called `apply_preset` first-turn on the multi-
  scene preset prompt — no fall-back to a written spec, even
  on the first attempt that hit the connection failure. This is
  effectively prompt #2 of HW-016 ("Build me a clean preset.")
  passing on its tool-call criterion, against a more-demanding
  prompt than the test plan called for. Prompts #1 ("Make my
  amp louder.") and #3 ("What's on Z04 right now?") are still
  owed for HW-016 closure.
- **Diagnostic side-finding worth noting.** The user-facing
  diagnostic from `connectAM4` failing read cleanly: it named
  AM4-Edit exclusivity as a likely cause, which is the most
  common reason in practice (the founder almost certainly had
  AM4-Edit open). P5-009 #2 (graceful "AM4 not found" error)
  is doing what it was designed to do.

### HW-024 — Complete HW-014 spot-check (Round 4 + re-tests + missed params) ✅

- **Tested 2026-04-25 (Session 30 cont 3)** via Claude Desktop
  with the `am4-tone-agent` connector attached. Two phases on
  Z04 — Phase 1 covered Round 4 + flanger.rate re-check
  (4 slots: enhancer + gate + volpan + flanger), Phase 2
  covered targeted re-tests (4 slots: amp.level + filter.freq +
  reverb springs + phaser.rate). 28 wire writes total, all
  acked.
- **Verified params (9)**: `enhancer.type` (Classic),
  `gate.type` (Modern Gate), `volpan.mode` (Auto-Swell),
  `flanger.rate` (1.7 Hz, was unconfirmed from HW-014 Round 2),
  `phaser.rate` (2.3 Hz, ditto), `amp.level` (+8 dB at non-
  default positive), `filter.freq` (1250 → 1249.9 Hz on
  Low-Pass type — 0.1 Hz quantization drift, see F3),
  `reverb.springs` (5, first-ever test), `reverb.spring_tone`
  (7.30, first-ever test).
- **Finding F1 — `enhancer.mix` is a phantom on hardware
  display.** Wire writes ack but the Enhancer block has no
  Mix knob on any page. Visible knobs are Width / Phase Invert
  / Pan Left / Pan Right / Balance / Level. Pre-HW-024 we had
  `enhancer.mix` registered via the universal Mix-Page rule
  (cache id=1, percent signature). Comment added in `params.ts`
  flagging "wire-acked, no observed hardware effect"; audio-
  effect spot-check queued under HW-032.
- **Finding F2 — `enhancer.balance` IS visible on hardware
  display** at the expected -33%. Breaks the HW-014 pattern of
  "balance hidden on every block tested." Implication: balance
  visibility is block-type-dependent; effect blocks hide it
  as an output mixer, but stereo-utility blocks like the
  enhancer expose it. Comment in `params.ts` per-block balance
  block now lists visible vs hidden per block.
- **Finding F3 — `filter.freq` shows sub-Hz quantization at
  high values.** Wrote 1250 Hz; readback was 1249.9 Hz
  (0.008% relative error). Likely float→fixed-point rounding
  in the firmware's filter-coefficient solver; drift scales
  with frequency. Functionally inaudible. Comment in
  `params.ts` warns against assuming exact equality on
  round-trip for filter.freq.
- **Finding F4 — ~25 unmapped first-page knobs surfaced.**
  Hardware page inventories during readback revealed knobs
  the Blocks Guide describes generically but we hadn't
  registered: Gate (Threshold/Attenuation/Attack/Release/Hold/
  Sidechain Source/Level), Filter Low-Pass (Q/Order/Low Cut/
  High Cut/Level + page 2 modulation subsystem), Flanger
  (Manual/Mod Phase/Level), Enhancer (Width/Phase Invert/
  Pan L/Pan R/Level), Volpan Auto-Swell (Threshold/Attack/
  Taper/Level). Queued as **HW-032** (next-up capture pass).
- **Cumulative status across HW-014 + HW-024**: 73 params
  hardware-confirmed, 15 wire-acked-but-display-hidden (14
  balance + enhancer.mix), 1 marginal (filter.freq drift).
  No hardware-display mismatch surfaced this session — every
  Round-4 enum and every re-test landed exactly on the AM4
  display.
- **Methodology validated**: Claude Desktop + MCP connector
  flow worked end-to-end. Initial first-turn message reported
  "MCP server isn't connected" before the connector was
  enabled — relevant signal for HW-016's first-turn smoke
  (founder reports the connector was disabled at conversation-
  start; once enabled, Claude proceeded with tool calls
  cleanly). Doesn't fully close HW-016 since the prompt was
  not the HW-016 set, but reinforces that the connection-state
  diagnostic copy works.
- `params.ts` comments updated to reflect HW-024 verifications,
  enhancer.mix phantom flag, filter.freq quantization note,
  and per-block balance visibility table.

### HW-027 — Extract delay tempo-division enum (79 entries) ✅

- **Resolved 2026-04-25 (Session 30 cont 2)** — pure Claude-side
  work, no founder hardware. Extended `scripts/gen-cache-enums.ts`
  to extract a shared `TEMPO_DIVISIONS_VALUES` const from the
  cache (using delay block id=19 as the source-of-truth); the
  same 79-entry enum appears 14 times across the cache (delay × 6,
  chorus × 2, reverb / flanger / rotary / phaser / tremolo /
  filter × 1 each), all string-identical.
- **5 new tempo params registered**:
  - `delay.tempo` (pidHigh=0x0013) — wire-verified from
    session-30-delay-basic-digital-mono (captured value=11 = "1/8").
  - `chorus.tempo` (0x000d), `flanger.tempo` (0x000c),
    `phaser.tempo` (0x000e), `tremolo.tempo` (0x000f) — structural-
    by-symmetry. Every modulation block exposes a Tempo Sync knob
    per Blocks Guide §Common LFO Parameters; the first/lowest-id
    79-entry tempo enum on each block is canonically that knob.
- **Deferred**: filter / reverb / rotary / drive tempo registers
  (semantics uncertain — auto-wah env follower vs LFO sync;
  reverb-modulation tempo is Vibrato-King-type-only). Drive's
  cache has tempo-shape enums but they're at the per-tap delay
  modeling layer of an unusual drive type; skipping.
- **Goldens.** 1 new byte-exact entry in `verify-msg`
  (`delay.tempo`); the 4 structural entries don't have captures
  yet so no goldens. Total 75/75.
- **Hand-authoring rationale**: tempo entries live directly in
  `KNOWN_PARAMS` rather than via paramNames + generator, because
  the generator's enum-handling defaults to the block's
  TYPES_VALUES, which would mis-import for these non-Type enums.
  Same pattern as `delay.stack_hold` and `compressor.auto_makeup`
  (Session 30 cont).

### HW-019 — Drive first-page completion ✅

- **Captured 2026-04-25** — 2 pcapngs in `samples/captured/`:
  `session-30-drive-basic-t808-od.pcapng` and
  `session-30-drive-basic-blackglass-7k.pcapng`. Founder noted that
  not all spec'd knobs were available across drive types — TS808 OD
  is a 3-knob Tube Screamer emulation (Drive/Tone/Level only) so
  its capture confirms the basic page but adds no new registers.
  Blackglass 7K (high-gain bass amp emu) exposed 6 EQ-page knobs.
- **Decoded Session 30 cont** — 5 new drive registers:
  - `low_cut` (0x0010, hz 20..2000) — captured at 1000 Hz.
  - `bass` (0x0014, knob_0_10) — captured at 1.0.
  - `mid` (0x0015, knob_0_10) — captured at 4.0.
  - `mid_freq` (0x0016, hz 200..2000) — captured at 800 Hz.
  - `treble` (0x0017, knob_0_10) — captured at 2.0.
  Mapping was by cache-id signature + sequence, not capture order
  (the founder's wiggle order on Blackglass differed from the spec
  order). 5 new byte-exact verify-msg goldens.
- **Open follow-ups.**
  - `pidLow=0x0076/pidHigh=0x002d` written once at internal 0.3
    (knob_0_10 signature in cache id=45) but no clear Blocks Guide
    name match. Queued as **HW-029** for a single-knob capture.
  - The "exposed knobs differ per type" finding queued as **HW-030**
    — a meta task to map type→knob-list across all blocks before
    HW-022/023 are written.

### HW-020 — Delay first-page completion ✅

- **Captured 2026-04-25** —
  `samples/captured/session-30-delay-basic-digital-mono.pcapng`.
  Founder noted the spec's wiggle order (Tempo / Master Feedback /
  Drive / Bit Reduction / Echo Pan / Spread / Right Post Delay)
  didn't match what was exposed on Digital Mono — captured 7 unique
  pidHighs, three already-known (mix / time / feedback) plus 4 new.
- **Decoded Session 30 cont** — 3 new delay registers (1 deferred):
  - `level` (0x0000, db -80..20) — captured at -10 dB. Universal
    "Level" pattern (no cache record at id=0; out-of-band hand-
    author, mirrors `amp.level`).
  - `stack_hold` (0x001f, enum OFF/STACK/HOLD) — captured at
    STACK. Same per-block-non-Type-enum shape as `reverb.stack_hold`.
  - `ducking` (0x002e, db 0..80) — captured at 2 dB. Same signature
    as `reverb.ducking`.
  - **Deferred**: `delay.tempo` (0x0013, enum 79 entries [NONE /
    1/64 TRIP / ... / 63/64]) — captured at index 11 (= "1/8")
    but registering it requires extending `gen-cache-enums.ts` to
    emit a `TEMPO_DIVISIONS_VALUES` shared enum. Queued as
    **HW-027** (no hardware action; Claude-side generator
    extension).
  - **Note**: HW-020 was originally specced to resolve HW-017's
    delay id=64 (pidHigh=0x0040, Taps vs Bit Reduction) ambiguity.
    The Digital Mono capture didn't write to 0x0040 — that
    register is type-specific (Multi-Tap delay or Mono Delay
    type). HW-017 remains pending; the Digital Mono capture
    didn't expose Bit Reduction either, suggesting Digital Mono
    has no Bit Reduction knob at all.
- **Goldens.** 3 new byte-exact entries in `verify-msg`.

### HW-021 — Compressor first-page completion ✅

- **Captured 2026-04-25** —
  `samples/captured/session-30-comp-basic-jfet-studio.pcapng`.
  Founder used JFET Studio (not the spec'd Studio FF) — different
  type, different exposed knobs. The spec assumed Studio FF would
  expose Threshold/Ratio/Attack/Release/Knee/Auto Makeup/Detector;
  JFET Studio exposed 8 unique writes including 6 cleanly mapped
  to those canonical compressor controls plus 2 unidentified.
- **Decoded Session 30 cont** — 6 new compressor registers + 1 new
  unit:
  - `level` (0x0000, db -80..20) — captured at -8 dB. Universal
    Level pattern (same as `delay.level` / `amp.level`).
  - `threshold` (0x000a, db -60..20) — captured at -30 dB.
  - `ratio` (0x000b, **NEW UNIT** `ratio` 1..20) — captured at
    1.0 (= 1:1). The new `ratio` unit is semantic-only (display =
    internal, scale 1) so Claude reads "ratio 4" as 4:1 not 4 dB.
  - `attack` (0x000c, ms 0.1..100) — captured at 0.8 ms.
  - `release` (0x000d, ms 2..2000) — captured at 100 ms.
  - `auto_makeup` (0x000f, enum OFF/ON) — captured at OFF.
- **Open follow-ups.**
  - `pidHigh=0x0017` (cache id=23, float 0..1 c=20) and
    `pidHigh=0x0029` (cache id=41, knob_0_10 but capture wrote
    1.2 exceeding cache cap b=1) — both unidentified. Queued as
    **HW-028** for a single-knob capture each.
  - Knee Type (cache id=14, expected at 0x000e) and Detector Type
    (cache id=16, expected at 0x0010) weren't reached in this
    capture. Will be picked up under HW-028 if exposed on JFET
    Studio, or queued separately if only exposed on other types.
- **Goldens.** 6 new byte-exact entries in `verify-msg`.

### HW-018 — Reverb first-page completion ✅

- **Captured 2026-04-25** —
  `samples/captured/session-30-reverb-basic-hall.pcapng` (Hall, Medium)
  and `samples/captured/session-30-reverb-spring.pcapng` (Spring,
  Large). Founder couldn't identify the BG-Basic-Page knob names
  (Crossover Frequency / Low Freq Time / etc.) in AM4-Edit's UI for
  these reverb types, so wiggled every knob on the main Config page
  for both — methodology variation that was actually more
  informative for decode.
- **Decoded Session 30** — 10 new reverb registers landed in
  `KNOWN_PARAMS`:
  - Universal: `high_cut` (0x0c, hz 200..20000), `low_cut` (0x14,
    hz 20..2000), `input_gain` (0x17, percent), `ducking` (0x28,
    db 0..80).
  - Hall-algorithmic: `density` (0x18, count 4..8), `stereo_spread`
    (0x27, bipolar_percent ±200), `quality` (0x2f, enum
    ECONOMY/NORMAL/HIGH/ULTRA-HIGH), `stack_hold` (0x30, enum
    OFF/STACK/HOLD).
  - Spring-engine: `dwell` (0x24, knob_0_10), `drip` (0x34,
    percent).
  Five mappings cross-validated against founder screenshots:
  Spring's input_gain (0.8217 → 82.17%), dwell (0.4741 → 4.741),
  drip (0.9183 → 91.83%), springs (4), spring_tone (already
  registered, capture re-confirmed).
- **Tooling.** `scripts/extract-final-writes.ts` added — final-
  value-per-pidHigh aggregator; the right shape for HW-018-style
  multi-wiggle captures.
- **Open follow-up.** `pidLow=0x0042/pidHigh=0x0000` written 12 / 7
  times (Hall / Spring) but has no cache record. Likely
  `reverb.level` (output dB knob shown in screenshots) but the
  wire encoding doesn't match raw-dB interpretation. Queued as
  **HW-026** for a single-knob disambiguation capture.
- **Goldens.** 7 new byte-exact entries in `verify-msg` (3 of the
  10 omitted because their captures used AM4-Edit's `action=0x0002`
  variant; the goldens encode our canonical `action=0x0001` form,
  matching SYSEX-MAP §6i / §6j conventions).

### HW-025 — Bug-investigation captures for HW-014 findings ✅

- **Captured 2026-04-25** — 5 pcapngs in `samples/captured/`:
  `session-30-reverb-predelay.pcapng`, `session-30-chorus-rate.pcapng`,
  `session-30-flanger-mix.pcapng`, `session-30-flanger-feedback.pcapng`,
  `session-30-phaser-mix.pcapng`.
- **BK-033 fixed (capture #1).** AM4-Edit's "Pre-Delay → 85 ms" wrote
  `pidLow=0x0042/pidHigh=0x0013` with `float32(0.085)`. Our registry
  had `pidHigh=0x0010` (a structurally-plausible cache record that
  was firmware-dead). One-byte address swap in `params.ts`; existing
  `unit: 'ms'` ÷1000 scale is correct. Cache name removed from
  `paramNames.ts` so the generator no longer emits the wrong mapping.
- **BK-034 cleared as not-a-code-bug (captures #2..#5).** All four
  AM4-Edit wires (chorus.rate=3.4 Hz, flanger.mix=54%,
  flanger.feedback=-61%, phaser.mix=88%) are byte-identical to our
  builder's output (modulo the benign action=0x0001 vs 0x0002
  variation). HW-014's hardware-display divergence is therefore an
  AM4 hardware-screen rendering quirk, not a wire-layer bug.
  Comments updated to remove BUG flags; verify these four params via
  AM4-Edit, not the AM4 hardware display.
- **Goldens.** 5 new byte-exact entries in `verify-msg` (1 BK-033 +
  4 BK-034 wire-match anchors).

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
