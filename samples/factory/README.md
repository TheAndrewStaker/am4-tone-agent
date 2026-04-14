# Factory presets — local-only reference set

This directory is gitignored for `.syx`, `.pdf`, and `.txt` files — Fractal
Audio's factory preset data is their IP and we don't redistribute it.

After cloning, populate this directory yourself to match what the project's
reverse-engineering notes reference.

## Fractal-distributed files

Download from https://www.fractalaudio.com/am4-downloads/ (look for the
"Factory Presets" archive for the AM4):

| Filename | Notes |
|----------|-------|
| `AM4-Factory-Presets-1p01.syx` | All 104 factory preset slots in one file. Version matches AM4 firmware; update when firmware updates. |
| `README AM4+VP4 Presets Update Guide.pdf` | Fractal's own guide on installing factory preset banks via Fractal-Bot. |

## Your own exports

For reverse-engineering and diff analysis, the project assumes you can
produce single-preset exports via AM4-Edit's **File → Export Preset** menu
and save them here. The commits reference these filenames:

- `A01-original.syx` — factory A01, unmodified baseline
- `A01-gain-plus-1.syx` — same preset with Amp Gain +1
- `A01-clean-a.syx` / `A01-clean-b.syx` — two back-to-back exports without
  any edits between them (used to detect per-export randomization)

These exports are derivative of Fractal's factory preset, so they're also
excluded from the repo by `.gitignore` — keep them local.

See `docs/SESSIONS.md` Session 03 for the analysis performed on these files.
