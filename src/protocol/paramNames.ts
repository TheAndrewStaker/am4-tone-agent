/**
 * Hand-maintained name table for cache-derived parameters.
 *
 * Pipeline (P1-010): `scripts/gen-params-from-cache.ts` walks every
 * CONFIRMED cache block, looks up each record's `id` in this table,
 * and emits a `KNOWN_PARAMS`-shape entry if a name is present.
 * Records without a name here are NOT emitted — they stay dormant
 * until a human assigns them a UI label (Session B of P1-010).
 *
 * Why a manual table instead of just emitting `param_{id}` placeholders:
 * MCP tool callers (Claude) need real human names to reason about
 * parameters. `amp.gain=6` is useful; `amp.param_11=6` is not. The
 * cache only stores ids + ranges, not labels.
 *
 * Sources for labels (in priority order):
 *   1. Wire captures that pin a name to a `(pidLow, pidHigh)` pair
 *      (highest confidence — see SYSEX-MAP §6a for the decode rule).
 *   2. `docs/manuals/Fractal-Audio-Blocks-Guide.txt` param descriptions.
 *   3. AM4-Edit UI labels observed via AM4-Edit screenshots.
 *
 * Key shape: `block name` (from the CONFIRMED table in
 * `docs/CACHE-BLOCKS.md`, e.g. "amp", "drive", "reverb") → `cache id
 * → param name`. The generator joins this against `cache-section2/3`
 * via the `(section, blockIndex)` lookup in `gen-params-from-cache.ts`.
 *
 * Seed (2026-04-19, Session 25): every name already registered in
 * `KNOWN_PARAMS`. As Session B lands AM4-Edit captures for more
 * params, names get appended here and the generator picks them up.
 *
 * OUT-OF-BAND PARAMS (not in the cache; hand-registered in
 * `KNOWN_PARAMS` directly, not through this pipeline):
 *   - `amp.level` / other-block `level` — pidHigh=0x0000, no cache
 *     record at id=0.
 *   - `{amp,drive,reverb,delay}.channel` — pidHigh=0x07D2, no cache
 *     record (Session 08 decoded this directly from wire captures).
 *
 * These remain in `params.ts` regardless of what this file says.
 */
export const PARAM_NAMES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  amp: {
    10: 'type',
    11: 'gain',
    12: 'bass',
  },
  drive: {
    10: 'type',
    11: 'drive',
  },
  reverb: {
    1: 'mix',
    10: 'type',
  },
  delay: {
    10: 'type',
    12: 'time',
  },
  chorus: {
    10: 'type',
  },
  flanger: {
    10: 'type',
  },
  phaser: {
    10: 'type',
  },
  wah: {
    10: 'type',
  },
  compressor: {
    19: 'type',
  },
  geq: {
    20: 'type',
  },
  filter: {
    10: 'type',
  },
  tremolo: {
    10: 'type',
  },
  enhancer: {
    // AM4-Edit labels this "Mode" but we keep `type` for cross-block consistency.
    14: 'type',
  },
  gate: {
    19: 'type',
  },
  volpan: {
    // The Volume-vs-Auto-Swell selector. Registered as `volpan.mode` in
    // KNOWN_PARAMS for historical reasons — keep the name stable.
    15: 'mode',
  },
} as const;
