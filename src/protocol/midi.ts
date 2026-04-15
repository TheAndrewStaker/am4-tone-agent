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
    throw new Error(
      'AM4 not found in MIDI device list. Check USB driver / power.\n' +
      'Inputs:\n' + ins.join('\n') + '\n' +
      'Outputs:\n' + outs.join('\n'),
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
