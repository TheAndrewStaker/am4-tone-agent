# Type → Knob Map — Wiki-derived (HW-033)

**Auto-generated from `src/knowledge/{block}-lineage.json`. Do not edit by
hand — re-run `npm run build-type-knobs` after `npm run extract-lineage`
to refresh.**

Companion to `docs/TYPE-KNOBS.md` (the manually-maintained record of
hardware-captured per-type knob sets). Both files exist because
Fractal's wiki documents what the modeled device looks like, while AM4
hardware reveals what AM4-Edit actually exposes. Per the wiki rule
(`docs/wiki/Drive_block.md` line 232: "The controls on the Basic page of
the Drive correspond with the knobs on the modeled devices"), wiki-derived
knobs are a strong prior for the AM4-Edit Basic page knob set, but Fractal
sometimes adds or renames knobs (Klon Centaur's wiki Tone/Output appear in
AM4-Edit as drive.tone/drive.level, plus a universal drive.mix that's not
on the original pedal).

## How to use this file

- For an uncatalogued type the user asks about, look up the row here as a
  starting hint of which params will exist on AM4-Edit's Basic page.
- "Mapped params" lists the `params.ts` keys we matched the wiki labels
  to. "Unmapped wiki labels" surfaces vocabulary the registry doesn't
  cover yet — review against `params.ts` to see if a missing param
  should be added (often a switch like "Bump switch" / "Mode switch"
  that maps to an enum, or a Fractal-renamed knob).
- When a hardware capture lands for a type, prefer the captured row in
  `docs/TYPE-KNOBS.md` over this file's entry.

## Coverage summary

- **32 types** have wiki-derived knob lists across 2 blocks.
- **15 unmapped wiki labels** await review (knobs the wiki names but `params.ts` doesn't yet register).

- Drive: 31 types
- Reverb: 0 types
- Delay: 0 types
- Compressor: 0 types
- Amp: 0 types
- Phaser: 1 types
- Chorus: 0 types
- Flanger: 0 types
- Wah: 0 types

---

## Drive (`drive`)

Wiki-derived per-type knob lists, extracted by
`scripts/extract-lineage.ts` from Fractal wiki "Controls:" prose.
These are **priors**, not ground truth — Fractal occasionally
renames or adds knobs vs. the modeled device. Always trust a
hardware capture over a wiki-derived row when they disagree.

| Type | Modeled device | Wiki-derived knobs | Mapped params | Unmapped wiki labels |
|------|---------------|--------------------|---------------|---------------------|
| 77 Custom OD | MXR M77 Badass Modified OD | Tone, Output, 100HZ cut/boost, Gain, Bump switch | drive.tone, drive.level, drive.drive | 100HZ cut/boost, Bump switch |
| Angry Chuck | JHS V3 Angry Charlie | Drive, Volume, Bass, Middle, Treble | drive.drive, drive.level, drive.bass, drive.mid, drive.tone | — |
| BB Pre | Xotic BB | Gain, Volume, Bass, Treble | drive.drive, drive.level, drive.bass, drive.tone | — |
| Blackglass 7K | Darkglass B7K Microtubes | Blend, Level, Drive, Low, Low Mids, Hi Mids, Treble | drive.mix, drive.level, drive.drive, drive.bass, drive.mid, drive.mid_freq, drive.tone | — |
| Blues OD | Marshall Bluesbreaker Mk1 | Gain, Tone | drive.drive, drive.tone | — |
| BOX O'CRUNCH | MI Audio V1 Crunch Box | Gain, Tone | drive.drive, drive.tone | — |
| Esoteric ACB | Xotic AC | Gain, Volume, Bass, Treble | drive.drive, drive.level, drive.bass, drive.tone | — |
| Esoteric RCB | Xotic RC v1 | Gain, Volume, Bass, Treble | drive.drive, drive.level, drive.bass, drive.tone | — |
| Eternal Love | Lovepedal Eternity | Level, Drive, Glass | drive.level, drive.drive | Glass |
| Full OD | Fulltone Full-Drive 2 | Volume, Tone, Overdrive, Boost | drive.level, drive.tone, drive.drive | Boost |
| Gauss Drive | Mesa Flux-Drive | Level, Gain, Bass, Treble | drive.level, drive.drive, drive.bass, drive.tone | — |
| Griddle Cake | Crowther Hot Cake | Level, Presence, Drive | drive.level, drive.drive | Presence |
| Guardian Photon Speed | Greer Lightspeed | Loudness, Drive, Freq | drive.level, drive.drive | Freq |
| Heartpedal 11 | Lovepedal OD11 / Eleven | Level, Drive, Bass, Tone | drive.level, drive.drive, drive.bass, drive.tone | — |
| Jam Ray | Venuram Jan Ray | Volume, Bass, Treble, Gain | drive.level, drive.bass, drive.tone, drive.drive | — |
| Klone Chiron | Klon Centaur / KTR | Gain, Treble, Output | drive.drive, drive.tone, drive.level | — |
| M-Zone Distortion | Boss MT-2 Metal Zone | Level, 3-band EQ, Distortion | drive.level, drive.drive | 3-band EQ |
| NOBELLIUM OVD-1 | ODR-1 Nobels BC Natural | Drive, Spectrum, Level, Bass Cut | drive.drive, drive.mid_freq, drive.level, drive.low_cut | — |
| Octave Distortion | Tycobrahe Octavia | Volume, Boost | drive.level | Boost |
| OD 250 | DOD 250: | Gain, Level | drive.drive, drive.level | — |
| PI Fuzz | Electro-Harmonix Big Muff Pi current | Volume, Tone, Sustain | drive.level, drive.tone, drive.drive | — |
| PI FUZZ - RUSSIAN | Electro-Harmonix Russian Big Muff Pi | Output, Distortion | drive.level, drive.drive | — |
| Shred Distortion | Marshall Shredmaster | Gain, Bass, Treble, Contour, Volume | drive.drive, drive.bass, drive.tone, drive.level | Contour |
| Sonic Drive | Ibanez SD-9 Maxon/ Sonic | Distortion, Level, Tone | drive.drive, drive.level, drive.tone | — |
| Sunrise Splendor | JHS V4 Morning Glory | Volume, Drive, Tone, Gain switch, High Cut switch | drive.level, drive.drive, drive.tone | High Cut switch |
| Super Fuzz | Univox Super-Fuzz | Balance, Expander | drive.level, drive.drive | — |
| T808 OD | Ibanez TS-808 Tube Screamer | Drive, Tone, Level | drive.drive, drive.tone, drive.level | — |
| TIMOTHY DOWN | Paul Cochrane V4 Timmy | Bass, Gain, Volume, Treble | drive.bass, drive.drive, drive.level, drive.tone | — |
| Tone of Kings | Analog Man King Tone | Drive, Volume, Tone | drive.drive, drive.level, drive.tone | — |
| Tube Drive 3-Knob | Butler Tube Driver | Out Level, EQ, Tube Drive | drive.level | EQ, Tube Drive |
| Zen Master | Hermida Zendrive | Vol, Gain, Tone, Voice | drive.level, drive.drive, drive.tone | Voice |

## Reverb (`reverb`)

_No wiki-derived control lists extracted for this block yet._

## Delay (`delay`)

_No wiki-derived control lists extracted for this block yet._

## Compressor (`compressor`)

_No wiki-derived control lists extracted for this block yet._

## Amp (`amp`)

_No wiki-derived control lists extracted for this block yet._

## Phaser (`phaser`)

Wiki-derived per-type knob lists, extracted by
`scripts/extract-lineage.ts` from Fractal wiki "Controls:" prose.
These are **priors**, not ground truth — Fractal occasionally
renames or adds knobs vs. the modeled device. Always trust a
hardware capture over a wiki-derived row when they disagree.

| Type | Modeled device | Wiki-derived knobs | Mapped params | Unmapped wiki labels |
|------|---------------|--------------------|---------------|---------------------|
| Naughty Rock | Electro-Harmonix Bad Stone | Rate, Manual Shift, Feedback, Auto/Manual | phaser.rate, phaser.feedback | Manual Shift, Auto/Manual |

## Chorus (`chorus`)

_No wiki-derived control lists extracted for this block yet._

## Flanger (`flanger`)

_No wiki-derived control lists extracted for this block yet._

## Wah (`wah`)

_No wiki-derived control lists extracted for this block yet._
