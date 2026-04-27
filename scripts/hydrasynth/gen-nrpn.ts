/**
 * Hydrasynth Explorer — generate src/devices/hydrasynth-explorer/nrpn.ts
 * from edisyn's reverse-engineered NRPN spreadsheet.
 *
 * Source:
 *   docs/devices/hydrasynth-explorer/references/nrpn.csv
 *   (vendored from https://github.com/eclab/edisyn — Apache-2.0,
 *    © Sean Luke / GMU; see references/README.md for attribution)
 *
 * Output:
 *   src/devices/hydrasynth-explorer/nrpn.ts
 *
 * Why we need this in addition to the manual's CC chart:
 *   - The CC chart only exposes ~117 parameters. Every other engine
 *     parameter (osc wave type, coarse pitch, filter 1 type, FX
 *     type selection, mod-matrix slots, etc.) is reachable only via
 *     NRPN. edisyn's CSV documents 1655 of them — the complete set
 *     short of the scale-system params (which the device emits as
 *     individual scale notes, not NRPN — out of scope).
 *
 * Run:  npm run hydra:gen-nrpn
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.resolve(
  __dirname,
  '../../docs/devices/hydrasynth-explorer/references/nrpn.csv',
);
const OUTPUT_PATH = path.resolve(
  __dirname,
  '../../src/devices/hydrasynth-explorer/nrpn.ts',
);

/**
 * Minimal CSV parser that handles RFC-4180-style quoting (double-quotes,
 * embedded commas, embedded newlines, escaped `""`). edisyn's CSV uses
 * heavily multi-line quoted descriptions, so the standard "split on
 * comma" trick doesn't work.
 */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

interface NrpnRow {
  name: string;
  cc?: number;
  msb: number;
  lsb: number;
  /**
   * Slot index encoded into the NRPN data-MSB byte for multi-slot
   * params. Several Hydrasynth registers share an NRPN address but
   * use the data-MSB to disambiguate which slot of a numbered family
   * the write targets — e.g. osc1semi / osc2semi / osc3semi all live
   * at NRPN 0x3F 0x11; the data-MSB byte selects oscillator 0/1/2.
   * When defined, the runtime sends `dataMsb` as the data-MSB and
   * the user-supplied value as the data-LSB; when undefined, the
   * user value is split across MSB+LSB as a 14-bit number.
   */
  dataMsb?: number;
  /**
   * Name of the enum lookup table that maps integer indices to
   * display names (e.g. "FILTER_1_TYPES" → ["LP Ladder 12", ...]).
   * Set when the NRPN notes reference one by name — auto-detected
   * at gen time. Tools use this to accept name strings ("Vowel")
   * in addition to integers (10).
   */
  enumTable?: string;
  /**
   * Multiplier applied to the resolved enum index before sending.
   * Hydrasynth's prefxtype / postfxtype use index × 8 sparse
   * encoding: Bypass=0, Chorus=8, Flanger=16, etc. Without the
   * multiplier, "Lo-Fi" (index 5) would write as 5 to the device,
   * which the device interprets as a near-Bypass value.
   */
  enumValueScale?: number;
  /**
   * Alternate names that should resolve to this entry. Auto-derived
   * from the CC catalog (params.ts): when an NRPN param shares its
   * CC with a CC-catalog param, the CC-catalog id (e.g. "filter1.res",
   * "mixer.osc1_vol", "env1.attack") becomes an alias for the NRPN
   * canonical name (e.g. "filter1resonance", "mixerosc1vol",
   * "env1attacksyncoff"). This bridges the two naming conventions
   * so Claude can use whichever it found in `hydra_list_params`.
   */
  aliases?: string[];
  /**
   * Maximum raw wire value, parsed from leading `[0,N]` or `[0-N]`
   * pattern in the notes. Most Hydrasynth engine NRPNs are 14-bit
   * (wireMax 8192) displayed 0..128.0 or 0ms..60sec; some are 7-bit
   * (wireMax 127). Used at runtime to auto-scale 7-bit-style inputs
   * (value ≤ 127) onto 14-bit registers so callers can keep the
   * familiar 0..127 mental model — without this, "value=127" hits a
   * 14-bit register at ~1.5% of max instead of full.
   */
  wireMax?: number;
  /**
   * Range / display notes from the CSV. Often blank for "follow-on"
   * params (osc2type defers to osc1type for its description); we
   * resolve those at generation time so the emitted file is
   * self-contained.
   */
  notes: string;
}

/**
 * Hand-curated overrides where the NRPN notes use an inline-list
 * form ("[0,9] output as 0,8,16,... representing Bypass, Chorus,
 * Flanger, ...") rather than naming a canonical enum table. We
 * map these to the corresponding ASMHydrasynth.java enum and
 * record any value-scaling rule.
 */
const ENUM_OVERRIDES: Record<string, { enumTable: string; enumValueScale?: number }> = {
  prefxtype: { enumTable: 'FX_TYPES', enumValueScale: 8 },
  postfxtype: { enumTable: 'FX_TYPES', enumValueScale: 8 },
  // Mutator mode notes use inline string lists ("FM-Linear", ...)
  // instead of naming MUTANT_MODES; link manually.
  mutator1mode: { enumTable: 'MUTANT_MODES' },
  mutator2mode: { enumTable: 'MUTANT_MODES' },
  mutator3mode: { enumTable: 'MUTANT_MODES' },
  mutator4mode: { enumTable: 'MUTANT_MODES' },
  // Filter 2 type notes use inline ("LP-BP-HP", "LP-Notch-HP") form.
  filter2type: { enumTable: 'FILTER_2_TYPES' },
  // Mutator FM-Linear sources (inline list, names match MUTANT_SOURCES_FM_LIN).
  mutator1sourcefmlin: { enumTable: 'MUTANT_SOURCES_FM_LIN' },
  mutator2sourcefmlin: { enumTable: 'MUTANT_SOURCES_FM_LIN' },
  mutator3sourcefmlin: { enumTable: 'MUTANT_SOURCES_FM_LIN' },
  mutator4sourcefmlin: { enumTable: 'MUTANT_SOURCES_FM_LIN' },
  // Mutator Osc-Sync sources.
  mutator1sourceoscsync: { enumTable: 'MUTANT_SOURCES_OSC_SYNC' },
  mutator2sourceoscsync: { enumTable: 'MUTANT_SOURCES_OSC_SYNC' },
  mutator3sourceoscsync: { enumTable: 'MUTANT_SOURCES_OSC_SYNC' },
  mutator4sourceoscsync: { enumTable: 'MUTANT_SOURCES_OSC_SYNC' },
};

/**
 * The CSV uses a "look up the first numbered sibling" convention for
 * blank Notes columns — e.g. osc2type's Notes is empty; the reader
 * is expected to read osc1type's Notes. We materialize that
 * inheritance up front so consumers don't need to.
 *
 * The base-name mapping strips trailing digit runs ("osc1type" →
 * "osctype" base; "lfo3step15" → "lfostep" base). Some param
 * families have multiple numeric segments (lfoNstepM); we strip
 * every digit run so the base name groups them all.
 */
function baseName(name: string): string {
  return name.replace(/\d+/g, '');
}

function parseNrpnHex(s: string): { msb: number; lsb: number } | undefined {
  const m = s.match(/0x([0-9A-Fa-f]{1,2})\s+0x([0-9A-Fa-f]{1,2})/);
  if (!m) return undefined;
  return { msb: parseInt(m[1], 16), lsb: parseInt(m[2], 16) };
}

function parseCC(s: string): number | undefined {
  if (!s) return undefined;
  const m = s.match(/^\s*0x([0-9A-Fa-f]{1,2})\s*$/) ?? s.match(/^\s*(\d+)\s*$/);
  if (!m) return undefined;
  return parseInt(m[1], m[0].includes('x') ? 16 : 10);
}

function main(): void {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCSV(raw);

  // Find the header row — the one whose first cell is exactly "Name".
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === 'Name') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Could not find "Name" header row in nrpn.csv');
  }

  const dataRows = rows.slice(headerIdx + 1);
  const entries: NrpnRow[] = [];
  const skipped: string[] = [];

  for (const r of dataRows) {
    const name = (r[0] ?? '').trim();
    if (!name) continue;
    const ccCell = (r[1] ?? '').trim();
    const nrpnCell = (r[2] ?? '').trim();
    const notesCell = (r[3] ?? '').trim();
    const nrpn = parseNrpnHex(nrpnCell);
    if (!nrpn) {
      // The CSV has a few preamble-like rows that survive the header
      // detection (e.g. blank-but-with-leading-cell rows). Skip them.
      skipped.push(name);
      continue;
    }
    entries.push({
      name,
      cc: parseCC(ccCell),
      msb: nrpn.msb,
      lsb: nrpn.lsb,
      notes: notesCell,
    });
  }

  // Resolve "follow-on" notes: if a row's notes are empty, find the
  // first earlier row in the same base-name group with non-empty
  // notes and inherit. Idempotent + keeps the original ordering.
  const firstNotesByBase = new Map<string, string>();
  for (const e of entries) {
    if (!e.notes) continue;
    const base = baseName(e.name);
    if (!firstNotesByBase.has(base)) {
      firstNotesByBase.set(base, e.notes);
    }
  }
  for (const e of entries) {
    if (!e.notes) {
      const base = baseName(e.name);
      const inherited = firstNotesByBase.get(base);
      if (inherited) e.notes = inherited;
    }
  }

  // Validations: NRPN bytes in 0..127, no duplicate (msb,lsb,name) — same
  // (msb,lsb) is fine across separate names because the Hydrasynth uses
  // MSB to disambiguate (e.g. osc1semi/osc2semi/osc3semi all share LSB
  // but the device interprets MSB as oscillator selector).
  for (const e of entries) {
    if (e.msb < 0 || e.msb > 127) throw new Error(`bad MSB ${e.msb} on ${e.name}`);
    if (e.lsb < 0 || e.lsb > 127) throw new Error(`bad LSB ${e.lsb} on ${e.name}`);
  }
  // BPM-sync "Schrödinger" duplicates: edisyn's CSV has two NRPN
  // entries for several time-domain params (e.g. `lfo3step1` at
  // 0x3A 0x20 AND at 0x3A 0x28). One addresses the BPM-sync-OFF
  // variant; the other addresses the BPM-sync-ON variant. Both
  // are real registers in the device's working memory. We keep
  // both but tag the second occurrence as `<name>_bpm_sync` so
  // the lookup map keys are unique. The original CSV name maps
  // to the first (lowest-address) variant by default — matches
  // most "set X to Y" intents where the user doesn't say "BPM
  // sync" explicitly.
  const seen = new Map<string, NrpnRow>();
  const renamed: NrpnRow[] = [];
  for (const e of entries) {
    const prior = seen.get(e.name);
    if (!prior) {
      seen.set(e.name, e);
      renamed.push(e);
      continue;
    }
    const tagged = { ...e, name: `${e.name}_bpm_sync` };
    if (seen.has(tagged.name)) {
      throw new Error(`triple+ duplicate name: ${e.name}`);
    }
    seen.set(tagged.name, tagged);
    renamed.push(tagged);
  }
  // Use the renamed list going forward.
  entries.length = 0;
  entries.push(...renamed);

  // Detect multi-slot NRPN families: groups of entries that SHARE an
  // NRPN address but whose names differ only by a numeric index. The
  // device's data-MSB byte selects which slot the write targets.
  // Examples: osc1semi/osc2semi/osc3semi all share 0x3F 0x11; the
  // data-MSB is 0/1/2 respectively. mutator1mode/mutator2mode/etc.
  // share 0x3F 0x21 with the same indexing convention.
  //
  // Edisyn's CSV documents this in plain text ("MSB = Osc [0,2]")
  // for one canonical entry per family. We auto-detect it from the
  // address-shared structure rather than parsing the prose, which is
  // both simpler and catches families the prose forgot to annotate.
  //
  // Naming convention: the numeric index in the name is 1-based on the
  // device UI (osc1, osc2, osc3); the data-MSB is 0-based. We map
  // name-N → dataMsb=N-1.
  const slotPattern = /^([a-z][a-z_]*?)(\d+)([a-z_]*)$/;
  const byNrpn = new Map<string, NrpnRow[]>();
  for (const e of entries) {
    const key = `${e.msb.toString(16)}/${e.lsb.toString(16)}`;
    const list = byNrpn.get(key);
    if (list) list.push(e);
    else byNrpn.set(key, [e]);
  }
  let slotFamilyCount = 0;
  for (const group of byNrpn.values()) {
    if (group.length <= 1) continue;
    // Every entry in the group must match the slot pattern AND share
    // the same prefix + suffix (only the numeric part differs).
    const matches = group.map((e) => e.name.match(slotPattern));
    if (matches.some((m) => !m)) continue;
    const fingerprints = new Set(matches.map((m) => `${m![1]}|${m![3]}`));
    if (fingerprints.size !== 1) continue;
    // Confirmed multi-slot family. Assign data-MSB by name index.
    for (let i = 0; i < group.length; i++) {
      const idx = Number.parseInt(matches[i]![2], 10);
      group[i].dataMsb = idx - 1;
    }
    slotFamilyCount++;
  }

  // Detect enum-table references in the notes column. Edisyn writes
  // "[0-218] OSC_WAVES" or "[0,15] FILTER_1_TYPES" when the param
  // indexes a named lookup table. We grep for any token matching the
  // ALL_CAPS_WITH_UNDERSCORES naming convention that ASMHydrasynth.java
  // uses, then verify the named table actually exists in enums.ts.
  const ENUMS_PATH = path.resolve(__dirname, '../../src/devices/hydrasynth-explorer/enums.ts');
  const knownEnumNames = new Set<string>();
  if (fs.existsSync(ENUMS_PATH)) {
    const enumsText = fs.readFileSync(ENUMS_PATH, 'utf8');
    const exportRe = /export const ([A-Z][A-Z_0-9]+):/g;
    let em: RegExpExecArray | null;
    while ((em = exportRe.exec(enumsText)) !== null) {
      knownEnumNames.add(em[1]!);
    }
  }
  // Build a CC → CC-catalog-id map so we can derive aliases for NRPN
  // entries that share a CC with the CC catalog. The CC catalog is
  // generated from cc-chart-raw.txt and lives in
  // src/devices/hydrasynth-explorer/params.ts; we read it as text and
  // pull the cc/id pairs out.
  const PARAMS_PATH = path.resolve(__dirname, '../../src/devices/hydrasynth-explorer/params.ts');
  const ccToCatalogId = new Map<number, string>();
  if (fs.existsSync(PARAMS_PATH)) {
    const paramsText = fs.readFileSync(PARAMS_PATH, 'utf8');
    const re = /\bcc:\s*(\d+)[^,]*,\s*module:[^,]*,\s*parameter:[^,]*,\s*id:\s*"([^"]+)"/g;
    let pm: RegExpExecArray | null;
    while ((pm = re.exec(paramsText)) !== null) {
      ccToCatalogId.set(Number.parseInt(pm[1]!, 10), pm[2]!);
    }
  }
  let aliasCount = 0;

  let enumLinkedCount = 0;
  for (const e of entries) {
    // Hand-curated overrides take precedence (FX sparse encoding etc.).
    const stripped = e.name.replace(/_bpm_sync$/, '');
    const override = ENUM_OVERRIDES[stripped];
    if (override) {
      e.enumTable = override.enumTable;
      e.enumValueScale = override.enumValueScale;
      enumLinkedCount++;
      continue;
    }
    // Otherwise scan the notes for a known enum-table token.
    const tokenRe = /\b([A-Z][A-Z_0-9]{2,})\b/g;
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(e.notes)) !== null) {
      if (knownEnumNames.has(tm[1]!)) {
        e.enumTable = tm[1]!;
        enumLinkedCount++;
        break;
      }
    }
  }

  // Derive CC-catalog aliases. For each NRPN entry that has a CC, look
  // up the matching CC-catalog id and add it as an alias if it's
  // different from the canonical NRPN name.
  for (const e of entries) {
    if (e.cc === undefined) continue;
    const catalogId = ccToCatalogId.get(e.cc);
    if (!catalogId) continue;
    if (catalogId === e.name) continue;
    e.aliases = [catalogId];
    aliasCount++;
  }

  // Parse wireMax from the leading "[0,N]" or "[0-N]" pattern in the
  // notes. Skips entries whose notes start with "MSB = ..." (multi-
  // slot) — those have a sub-range in the LSB but no clean leading
  // [0,N] for the data field as a whole.
  const wireMaxRe = /^\[0[,\-](\d+)\]/;
  let wireMaxCount = 0;
  for (const e of entries) {
    const m = e.notes.match(wireMaxRe);
    if (!m) continue;
    const max = Number.parseInt(m[1]!, 10);
    if (max > 0 && max <= 16383) {
      e.wireMax = max;
      wireMaxCount++;
    }
  }

  // Emit TypeScript.
  const out: string[] = [];
  out.push('// AUTO-GENERATED FILE — do not edit by hand.');
  out.push('// Source:  docs/devices/hydrasynth-explorer/references/nrpn.csv');
  out.push('// Regen:   npm run hydra:gen-nrpn');
  out.push('//');
  out.push('// Vendored from eclab/edisyn (Apache-2.0, © Sean Luke / GMU).');
  out.push('// See docs/devices/hydrasynth-explorer/references/README.md.');
  out.push('//');
  out.push('// Each entry maps a canonical parameter name (e.g. "osc1type")');
  out.push('// to the NRPN MSB+LSB pair the Hydrasynth listens on. `cc` is');
  out.push('// populated when the same parameter is also reachable via the');
  out.push('// manual\'s 7-bit CC chart (~117 of 1655 params). `notes`');
  out.push('// carries the range + display rules from the CSV — references');
  out.push('// to ALL_CAPS_TABLES (e.g. OSC_WAVES) live in edisyn\'s');
  out.push("// ASMHydrasynth.java; we don't ship those tables yet.");
  out.push('');
  out.push('export interface HydrasynthNrpn {');
  out.push('  /** Canonical parameter name (e.g. "osc1type"). Stable across versions. */');
  out.push('  readonly name: string;');
  out.push('  /** NRPN address MSB byte (0..127). */');
  out.push('  readonly msb: number;');
  out.push('  /** NRPN address LSB byte (0..127). */');
  out.push('  readonly lsb: number;');
  out.push('  /**');
  out.push('   * For multi-slot families (osc1/2/3, mutator1..4, mod1..32, etc.),');
  out.push('   * the slot index encoded as the NRPN data-MSB byte. Auto-detected');
  out.push('   * from shared-NRPN-address sibling entries at gen time. When defined,');
  out.push('   * the user-supplied value is sent as data-LSB only; when undefined,');
  out.push('   * the value is split across data-MSB+LSB as a 14-bit number.');
  out.push('   */');
  out.push('  readonly dataMsb?: number;');
  out.push('  /**');
  out.push('   * Name of the enum lookup table from enums.ts (e.g. "OSC_WAVES",');
  out.push('   * "FILTER_1_TYPES", "FX_TYPES"). Auto-detected from the notes column');
  out.push('   * at gen time. When set, the runtime accepts a name string in addition');
  out.push('   * to a number for the value field.');
  out.push('   */');
  out.push('  readonly enumTable?: string;');
  out.push('  /**');
  out.push('   * Multiplier applied to a resolved enum index before sending. Used for');
  out.push("   * Hydrasynth's sparse-encoded FX type (×8 — Bypass=0, Chorus=8, etc.).");
  out.push('   */');
  out.push('  readonly enumValueScale?: number;');
  out.push('  /** 7-bit CC alias if the param is also on the manual chart. */');
  out.push('  readonly cc?: number;');
  out.push('  /**');
  out.push('   * Alternate names that resolve to this entry — typically the');
  out.push("   * CC-catalog id (e.g. \"mixer.osc1_vol\" aliases \"mixerosc1vol\";");
  out.push("   * \"env1.attack\" aliases \"env1attacksyncoff\"). Bridges the CC and");
  out.push('   * NRPN naming conventions so callers can use either.');
  out.push('   */');
  out.push('  readonly aliases?: readonly string[];');
  out.push('  /**');
  out.push('   * Maximum raw wire value (parsed from leading "[0,N]" in notes).');
  out.push('   * 8192 for 14-bit linear params (mixer vols, filter cutoff/res,');
  out.push('   * sustain, env timings); 127 or smaller for 7-bit params.');
  out.push('   */');
  out.push('  readonly wireMax?: number;');
  out.push('  /** Range + display instructions from edisyn\'s CSV. */');
  out.push('  readonly notes: string;');
  out.push('}');
  out.push('');
  out.push('export const HYDRASYNTH_NRPNS: readonly HydrasynthNrpn[] = [');
  for (const e of entries) {
    const dataMsbPart = e.dataMsb !== undefined ? `, dataMsb: ${e.dataMsb}` : '';
    const enumTablePart = e.enumTable !== undefined ? `, enumTable: ${JSON.stringify(e.enumTable)}` : '';
    const enumScalePart = e.enumValueScale !== undefined ? `, enumValueScale: ${e.enumValueScale}` : '';
    const ccPart = e.cc !== undefined ? `, cc: 0x${e.cc.toString(16).padStart(2, '0')}` : '';
    const aliasPart = e.aliases && e.aliases.length > 0 ? `, aliases: ${JSON.stringify(e.aliases)}` : '';
    const wireMaxPart = e.wireMax !== undefined ? `, wireMax: ${e.wireMax}` : '';
    const notes = JSON.stringify(e.notes);
    out.push(
      `  { name: ${JSON.stringify(e.name).padEnd(36)}, msb: 0x${e.msb.toString(16).padStart(2, '0')}, lsb: 0x${e.lsb.toString(16).padStart(2, '0')}${dataMsbPart}${enumTablePart}${enumScalePart}${ccPart}${aliasPart}${wireMaxPart}, notes: ${notes} },`,
    );
  }
  out.push('];');
  out.push('');
  out.push('const BY_NAME = new Map<string, HydrasynthNrpn>();');
  out.push('for (const e of HYDRASYNTH_NRPNS) {');
  out.push('  BY_NAME.set(e.name, e);');
  out.push('  if (e.aliases) for (const a of e.aliases) BY_NAME.set(a, e);');
  out.push('}');
  out.push('');
  out.push('/**');
  out.push(' * Lookup by canonical name OR alias. Aliases include the matching');
  out.push(" * CC-catalog id when one exists (e.g. \"mixer.osc1_vol\", \"env1.attack\",");
  out.push(" * \"filter1.res\") so callers don't have to know which naming convention");
  out.push(' * the NRPN map uses internally.');
  out.push(' */');
  out.push('export function findHydraNrpn(name: string): HydrasynthNrpn | undefined {');
  out.push('  return BY_NAME.get(name);');
  out.push('}');
  out.push('');

  fs.writeFileSync(OUTPUT_PATH, out.join('\n'), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
  console.log(`  entries: ${entries.length}`);
  console.log(`  with CC alias: ${entries.filter((e) => e.cc !== undefined).length}`);
  console.log(`  with dataMsb (multi-slot families): ${entries.filter((e) => e.dataMsb !== undefined).length}`);
  console.log(`  multi-slot families detected: ${slotFamilyCount}`);
  console.log(`  with enumTable (named-value linkage): ${enumLinkedCount}`);
  console.log(`  with CC-catalog alias: ${aliasCount}`);
  console.log(`  with wireMax (auto-scale eligible): ${wireMaxCount}`);
  console.log(`  notes inherited: ${entries.filter((e) => e.notes && !rawNotesPresent(dataRows, e.name)).length}`);
  if (skipped.length > 0) {
    console.log(`  skipped (no NRPN): ${skipped.length}`);
  }
}

/** True if the original CSV row for `name` had non-empty notes. */
function rawNotesPresent(dataRows: string[][], name: string): boolean {
  for (const r of dataRows) {
    if ((r[0] ?? '').trim() === name) {
      return (r[3] ?? '').trim() !== '';
    }
  }
  return false;
}

main();
