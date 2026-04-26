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
   * Range / display notes from the CSV. Often blank for "follow-on"
   * params (osc2type defers to osc1type for its description); we
   * resolve those at generation time so the emitted file is
   * self-contained.
   */
  notes: string;
}

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
  out.push('  /** NRPN MSB byte (0..127). */');
  out.push('  readonly msb: number;');
  out.push('  /** NRPN LSB byte (0..127). */');
  out.push('  readonly lsb: number;');
  out.push('  /** 7-bit CC alias if the param is also on the manual chart. */');
  out.push('  readonly cc?: number;');
  out.push('  /** Range + display instructions from edisyn\'s CSV. */');
  out.push('  readonly notes: string;');
  out.push('}');
  out.push('');
  out.push('export const HYDRASYNTH_NRPNS: readonly HydrasynthNrpn[] = [');
  for (const e of entries) {
    const ccPart = e.cc !== undefined ? `, cc: 0x${e.cc.toString(16).padStart(2, '0')}` : '';
    const notes = JSON.stringify(e.notes);
    out.push(
      `  { name: ${JSON.stringify(e.name).padEnd(36)}, msb: 0x${e.msb.toString(16).padStart(2, '0')}, lsb: 0x${e.lsb.toString(16).padStart(2, '0')}${ccPart}, notes: ${notes} },`,
    );
  }
  out.push('];');
  out.push('');
  out.push('const BY_NAME = new Map(HYDRASYNTH_NRPNS.map((e) => [e.name, e] as const));');
  out.push('');
  out.push('/** Lookup by canonical name. Returns undefined if the name is unknown. */');
  out.push('export function findHydraNrpn(name: string): HydrasynthNrpn | undefined {');
  out.push('  return BY_NAME.get(name);');
  out.push('}');
  out.push('');

  fs.writeFileSync(OUTPUT_PATH, out.join('\n'), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
  console.log(`  entries: ${entries.length}`);
  console.log(`  with CC alias: ${entries.filter((e) => e.cc !== undefined).length}`);
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
