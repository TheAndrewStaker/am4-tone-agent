# Hydrasynth Explorer — third-party references

Vendored from the **eclab/edisyn** project (a multi-synth patch editor
maintained by Sean Luke at George Mason University). edisyn ships its
own Hydrasynth reverse-engineering notes alongside the editor module;
they're the most complete source for the Hydrasynth wire protocol that
exists outside ASM's internal tools.

- Upstream: https://github.com/eclab/edisyn/tree/master/edisyn/synth/asmhydrasynth/info
- License: Apache-2.0
- Author / RE credit: Sean Luke (George Mason University)
- Snapshot date: 2026-04-26

## Files

| File | Lines | What it documents |
|---|---|---|
| `nrpn.csv` | 1655 | Every parameter's NRPN MSB / LSB, parameter range, display-vs-internal notes. The single source of truth for sending live engine writes. |
| `SysexPatchFormat.txt` | 2906 | Byte-offset map of a single decoded patch (~1.7 KB binary blob). Field-by-field layout of every oscillator, mixer, filter, envelope, LFO, mutator, mod-matrix slot, FX, macro, and patch-metadata field. |
| `SysexEncoding.txt` | 695 | The SysEx envelope + base64 + CRC-32 wrapping that the device uses around the decoded patch. Includes the documented Send / Request / Bank-write flows. |

## How we use these

- **Read .hydra files locally.** A `.hydra` is a ZIP of `.patch`
  files; each `.patch` is the same payload `SysexPatchFormat.txt`
  describes (the front-panel "Send Patch" SysEx output less the
  envelope). Our decoder in `src/devices/hydrasynth-explorer/`
  walks the byte-offset map to expose every parameter as a typed
  field.
- **Send live engine edits.** `nrpn.csv` is read at build / test
  time to validate our NRPN write functions against ranges
  documented per parameter.
- **Push edited patches.** Combine the patch encoder with
  `SysexEncoding.txt`'s envelope-and-CRC rules to produce a SysEx
  blob the Hydrasynth accepts.

## Caveats from edisyn's own notes

- ASM's PDF manual disagrees with the device on a handful of
  parameter names and ranges. edisyn's CSV documents the
  device-observed truth; defer to it over the manual when they
  conflict.
- Bulk NRPN bursts can drop on the device side. Pace ≥ 2 ms per
  message (4 ms on Deluxe). Order matters — modes before types,
  types before LFO waves, LFO waves before BPM-syncs, BPM-syncs
  before wavescan waves, wavescan waves before everything else.
- The device echoes back the NRPN you send unless TX is disabled.
  Plan the listener loop accordingly.
- Scale parameters (scale type / notes / lock) emit individual
  scale-note SysEx, not NRPN. Out of scope for guitarist-targeted
  tooling.
- The front-panel "Send Patch" / "Send Bank" buttons emit a
  non-standard `F0 01…` / `F0 02…` envelope (squats a different
  vendor's namespace). edisyn declined to RE that path — instead
  use the documented Send / Request flow.

## Attribution

This directory's vendored files are © Sean Luke and the edisyn
contributors, used under the terms of the Apache License 2.0. Keep
this README and the upstream link if you fork the repo.
