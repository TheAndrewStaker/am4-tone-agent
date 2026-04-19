/**
 * Minimal MIDI port wrapper for AM4 communication.
 *
 * Wraps node-midi to:
 *   - find the AM4 by port-name substring
 *   - enable SysEx (off by default in node-midi)
 *   - return promises for clean async/await usage
 *
 * Caller must call `close()` to release ports.
 */
import midi, { Input, Output } from 'midi';

export interface AM4Connection {
  send: (bytes: number[]) => void;
  /** Resolves with the next inbound SysEx message, or rejects on timeout. */
  receiveSysEx: (timeoutMs?: number) => Promise<number[]>;
  /**
   * Wait for the first inbound SysEx that satisfies `predicate`. Non-matching
   * messages are silently dropped until `timeoutMs` elapses. Register BEFORE
   * the outgoing write so the response can't race ahead of the listener.
   */
  receiveSysExMatching: (
    predicate: (bytes: number[]) => boolean,
    timeoutMs?: number,
  ) => Promise<number[]>;
  /** Subscribe to ALL inbound messages (SysEx + non-SysEx). */
  onMessage: (handler: (bytes: number[]) => void) => () => void;
  close: () => void;
}

function findPortByName(
  port: Input | Output,
  needles: string[],
): number {
  for (let i = 0; i < port.getPortCount(); i++) {
    const name = port.getPortName(i).toLowerCase();
    if (needles.some((n) => name.includes(n))) return i;
  }
  return -1;
}

export interface MidiPortInfo {
  index: number;
  name: string;
  direction: 'input' | 'output';
  looksLikeAM4: boolean;
}

const AM4_PORT_NEEDLES = ['am4', 'fractal'];

function enumeratePorts(
  port: Input | Output,
  direction: 'input' | 'output',
): MidiPortInfo[] {
  const out: MidiPortInfo[] = [];
  for (let i = 0; i < port.getPortCount(); i++) {
    const name = port.getPortName(i);
    const lower = name.toLowerCase();
    out.push({
      index: i,
      name,
      direction,
      looksLikeAM4: AM4_PORT_NEEDLES.some((n) => lower.includes(n)),
    });
  }
  return out;
}

/**
 * List every MIDI input and output the OS exposes, without opening the
 * AM4 connection. Used by the `list_midi_ports` MCP tool and by the
 * "AM4 not found" error path for diagnostics.
 *
 * Opens and immediately releases short-lived node-midi handles so a
 * subsequent `connectAM4()` still sees a clean state.
 */
export function listMidiPorts(): { inputs: MidiPortInfo[]; outputs: MidiPortInfo[] } {
  const input = new midi.Input();
  const output = new midi.Output();
  try {
    return {
      inputs: enumeratePorts(input, 'input'),
      outputs: enumeratePorts(output, 'output'),
    };
  } finally {
    input.closePort();
    output.closePort();
  }
}

export function connectAM4(): AM4Connection {
  const input = new midi.Input();
  const output = new midi.Output();

  const inputPort = findPortByName(input, ['am4', 'fractal']);
  const outputPort = findPortByName(output, ['am4', 'fractal']);

  if (inputPort === -1 || outputPort === -1) {
    const ins: string[] = [];
    for (let i = 0; i < input.getPortCount(); i++) ins.push(`  [${i}] ${input.getPortName(i)}`);
    const outs: string[] = [];
    for (let i = 0; i < output.getPortCount(); i++) outs.push(`  [${i}] ${output.getPortName(i)}`);
    const noPorts = ins.length === 0 && outs.length === 0;
    // Caller receives this as the error message surfaced by the MCP tool.
    // Keep it actionable: list what we DID see, name the common causes, and
    // point at the list_midi_ports tool for re-checking after the user fixes
    // the underlying issue.
    throw new Error(
      'AM4 not found in the MIDI device list. Common causes:\n' +
      '  - AM4 is powered off or not connected by USB\n' +
      '  - AM4 USB driver not installed (https://www.fractalaudio.com/am4-downloads/)\n' +
      '  - Another app has the AM4 open exclusively (close AM4-Edit)\n' +
      (noPorts
        ? '\nNo MIDI ports of any kind are visible to the server — this usually means the driver is missing.\n'
        : '\nMIDI ports the server can see (none matched "am4" / "fractal"):\n' +
          'Inputs:\n' + (ins.length ? ins.join('\n') : '  (none)') + '\n' +
          'Outputs:\n' + (outs.length ? outs.join('\n') : '  (none)') + '\n') +
      '\nOnce the AM4 is visible, call the `list_midi_ports` MCP tool to confirm the server sees it, then retry. Use `reconnect_midi` to force a fresh handle.',
    );
  }

  // Enable SysEx (false = don't ignore SysEx); ignore timing + active-sensing.
  input.ignoreTypes(false, true, true);

  const handlers = new Set<(bytes: number[]) => void>();
  input.on('message', (_dt: number, bytes: number[]) => {
    for (const h of handlers) h(bytes);
  });

  input.openPort(inputPort);
  output.openPort(outputPort);

  return {
    send: (bytes) => output.sendMessage(bytes),
    receiveSysEx: (timeoutMs = 1000) =>
      new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          handlers.delete(handler);
          reject(new Error(`Timeout waiting for SysEx response after ${timeoutMs}ms`));
        }, timeoutMs);
        const handler = (bytes: number[]) => {
          if (bytes[0] !== 0xf0) return;
          clearTimeout(timer);
          handlers.delete(handler);
          resolve(bytes);
        };
        handlers.add(handler);
      }),
    receiveSysExMatching: (predicate, timeoutMs = 1000) =>
      new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          handlers.delete(handler);
          reject(new Error(`Timeout waiting for matching SysEx after ${timeoutMs}ms`));
        }, timeoutMs);
        const handler = (bytes: number[]) => {
          if (bytes[0] !== 0xf0) return;
          if (!predicate(bytes)) return;
          clearTimeout(timer);
          handlers.delete(handler);
          resolve(bytes);
        };
        handlers.add(handler);
      }),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close: () => {
      handlers.clear();
      input.closePort();
      output.closePort();
    },
  };
}

export function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
