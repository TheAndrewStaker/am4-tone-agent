# Hydrasynth sample patches

This directory holds Hydrasynth patch payloads used by the `hydrasynth-explorer`
device module.

## Files

### Committed
- `init-patch.patch` — the extracted INIT (blank-slate) patch, 2786 bytes.
  Source: `00Init.patch` entry inside `Single INIT Bank.hydra` (see below).
  Used at build time to produce the `INIT_PATCH_BUFFER` constant in
  `src/devices/hydrasynth-explorer/initPatchBuffer.ts`. Structurally
  trivial — represents the device's default state, not a creative preset.

### Local-only (gitignored)
- `single-init-bank.hydra` — the full 128-patch INIT bank as bundled with
  ASM Hydrasynth Manager. Vendor copyright; not redistributed.
- Any other `*.hydra` / `*.hydramulti` files dropped here for inspection.

## Where the bank file came from

ASM Hydrasynth Manager ships factory bank files at
`%USERPROFILE%\Documents\ASM\Hydrasynth\Patch\Packs\` on Windows after
install. The `Single INIT Bank.hydra` file in that directory contains 128
identical INIT patches (named `00Init.patch` through `7fInit.patch`).

## `.hydra` file format (decoded 2026-04-28)

`.hydra` files are uncompressed ZIP archives containing:

- 128 patch entries named `{hex-id}{name}.patch` (e.g. `00Init.patch`).
  Each entry is 2786 bytes — the audible patch payload, no SysEx routing
  header.
- A `list.xml` index with `<patch name="..." id="N"/>` entries.

`.hydramulti` is the multi-mode container (~2× size — separate upper/lower
banks for Hydrasynth Multi mode).

## Wire vs file layout (4-byte difference)

The wire SysEx patch buffer is 2790 bytes. The `.patch` file is 2786 bytes.
The 4-byte difference is the SysEx routing header (`06 00 BANK PATCH` per
`docs/devices/hydrasynth-explorer/references/SysexEncoding.txt`) which the
file format omits.

To convert a `.patch` file to a wire buffer, prepend the 4-byte routing
header. `loadHydraFile()` in `src/devices/hydrasynth-explorer/` does this.

Verified offsets (file → wire):
- ETCD magic bytes at file offset 1762 = wire offset 1766 ✓
- Patch name at file offset 5 = wire offset 9 ✓
