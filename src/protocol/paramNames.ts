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
    // Session B additions (2026-04-19). Cache record signatures at ids
    // 13/14/15 are identical to gain/bass (0..1 range, display-scale 10,
    // step 0.001). The AM4 Owner's Manual line 1563 lists the Amp
    // block's front-panel controls as "Gain, Bass, Mid, Treble,
    // Presence, Level" — Fractal's canonical tone-stack order places
    // Mid/Treble/Presence in exactly that sequence after Bass (Blocks
    // Guide §Tone Page, pp. 9–10). Awaits P1-010 Session D hardware
    // spot-check per the P1-010 plan; structural evidence alone is
    // strong (identical cache layout to confirmed neighbors + manual-
    // documented AM4-specific labels).
    13: 'mid',
    14: 'treble',
    15: 'presence',
  },
  drive: {
    10: 'type',
    11: 'drive',
    // AM4 Owner's Manual line 1330: "Page Right and dial in Drive, Tone,
    // and Level." Cache records at 0x0C and 0x0D have the identical
    // knob_0_10 signature to drive.drive (0x0B); typical pedal-UI order
    // matches. `mix` at 0x0E follows the universal Mix Page pattern
    // (percent). All three await Session D hardware spot-check.
    12: 'tone',
    13: 'level',
    14: 'mix',
  },
  reverb: {
    1: 'mix',
    10: 'type',
    // Blocks Guide §Reverb Basic Page (p. 82): "Predelay — Adds extra
    // delay before the reverb starts." Cache 0x10 signature (0..0.25s
    // × 1000 → 0..250 ms) matches the canonical reverb predelay range.
    16: 'predelay',
  },
  delay: {
    // Mix follows the universal percent-at-0x01 pattern (Blocks Guide
    // §Common Mix/Level Parameters, p. 7). "delay block uses a
    // different Mix Law compared to other blocks" — same param, just
    // different internal curve; still the wet/dry knob.
    1: 'mix',
    10: 'type',
    12: 'time',
  },
  // Universal `mix` at pidHigh 0x01 across every effect block that
  // exposes a Mix Page per the Blocks Guide (p. 7). Skipped for
  // Amp/Drive (different semantics), Wah/GEQ/Gate/VolPan (no wet/dry —
  // AM4 manual p.34 line 1423: "Effects with no mix, such as Wah,
  // GEQ, etc., will show 'NA'"). Cache signature matches percent
  // (0..1 × 100) structurally identical to the confirmed reverb.mix.
  chorus: {
    1: 'mix',
    10: 'type',
  },
  flanger: {
    1: 'mix',
    10: 'type',
  },
  phaser: {
    1: 'mix',
    10: 'type',
  },
  wah: {
    10: 'type',
  },
  compressor: {
    1: 'mix',
    19: 'type',
  },
  geq: {
    20: 'type',
  },
  filter: {
    1: 'mix',
    10: 'type',
  },
  tremolo: {
    1: 'mix',
    10: 'type',
  },
  enhancer: {
    1: 'mix',
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
