/**
 * Hydrasynth Explorer — MIDI connection helper (output-only for M1).
 *
 * Mirrors the shape of `src/protocol/midi.ts` (the AM4 connection
 * helper) but device-scoped: looks for "hydrasynth" / "asm hydra" in
 * port names, opens an Output, exposes a thin `send` interface.
 *
 * Output-only because M1's tool surface (set_param, set_macro,
 * switch_patch, play_note, list_params) only emits MIDI. M5 will add
 * an Input listener for the bidirectional Macro-as-trigger work.
 */
import midi, { Output } from 'midi';

const HYDRA_PORT_NEEDLES = ['hydrasynth', 'asm hydra'];

export interface HydrasynthConnection {
  send: (bytes: number[]) => void;
  close: () => void;
}

export interface HydrasynthPortInfo {
  index: number;
  name: string;
  looksLikeHydrasynth: boolean;
}

function findHydrasynthOutputIndex(out: Output): number {
  for (let i = 0; i < out.getPortCount(); i++) {
    const name = out.getPortName(i).toLowerCase();
    if (HYDRA_PORT_NEEDLES.some((n) => name.includes(n))) return i;
  }
  return -1;
}

/**
 * Enumerate output ports without opening any. Used by the startup
 * banner so the server can log a verdict ("Hydrasynth detected" /
 * "Hydrasynth not visible") at boot, before any tool call.
 */
export function listHydrasynthOutputs(): HydrasynthPortInfo[] {
  const out = new midi.Output();
  try {
    const result: HydrasynthPortInfo[] = [];
    for (let i = 0; i < out.getPortCount(); i++) {
      const name = out.getPortName(i);
      const lower = name.toLowerCase();
      result.push({
        index: i,
        name,
        looksLikeHydrasynth: HYDRA_PORT_NEEDLES.some((n) => lower.includes(n)),
      });
    }
    return result;
  } finally {
    // node-midi requires explicit cleanup even when no port was opened
    // (closes the underlying ALSA/CoreMIDI/WinMM handle).
    try { out.closePort(); } catch { /* not opened */ }
  }
}

/**
 * Open the Hydrasynth Explorer output. Throws with a diagnostic
 * message if the device isn't visible — caller should surface that
 * to the user (the MCP server catches it and turns it into an MCP
 * error response).
 */
export function connectHydrasynth(): HydrasynthConnection {
  const out = new midi.Output();
  const idx = findHydrasynthOutputIndex(out);
  if (idx < 0) {
    const visible: string[] = [];
    for (let i = 0; i < out.getPortCount(); i++) {
      visible.push(`[${i}] ${out.getPortName(i)}`);
    }
    try { out.closePort(); } catch { /* not opened */ }
    throw new Error(
      `Hydrasynth Explorer not found. Looked for any output port whose name contains: ` +
      `${HYDRA_PORT_NEEDLES.join(' / ')}. Visible outputs: ${visible.length === 0 ? '(none)' : visible.join(', ')}. ` +
      `Likely causes: device not powered on, USB cable not seated, or the OS hasn't enumerated it yet (try unplug + replug).`,
    );
  }
  out.openPort(idx);
  return {
    send: (bytes) => out.sendMessage(bytes),
    close: () => { try { out.closePort(); } catch { /* already closed */ } },
  };
}
