/**
 * Smoke test for the MCP server — spawns it as a child process, does the
 * MCP initialize handshake over stdio, lists tools, and checks every
 * registered tool shows up. Does NOT call any tool that touches MIDI;
 * this is a harness-level check.
 *
 *   npx tsx scripts/smoke-server.ts
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

async function main(): Promise<void> {
  const child = spawn('npx', ['tsx', 'src/server/index.ts'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // Windows needs shell=true for npx
  });

  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  child.on('error', (err) => {
    console.error('spawn error:', err);
    process.exit(1);
  });

  // Buffer stdout and extract complete line-delimited JSON-RPC messages.
  let stdoutBuf = '';
  const pending = new Map<number, (msg: JsonRpc) => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpc;
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch (err) {
        console.error(`bad json line: ${line}`);
        throw err;
      }
    }
  });

  let nextId = 1;
  function request(method: string, params?: unknown): Promise<JsonRpc> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      const msg = { jsonrpc: '2.0', id, method, params };
      child.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  function notify(method: string, params?: unknown): void {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  // MCP handshake: initialize -> notifications/initialized -> tools/list.
  const initResp = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'am4-smoke-test', version: '0.0.1' },
  });
  if (initResp.error) throw new Error(`initialize error: ${initResp.error.message}`);
  console.log('✓ initialize handshake OK');

  notify('notifications/initialized');

  const toolsResp = await request('tools/list', {});
  if (toolsResp.error) throw new Error(`tools/list error: ${toolsResp.error.message}`);
  const tools = (toolsResp.result as { tools: { name: string }[] }).tools;
  const names = tools.map((t) => t.name).sort();
  console.log(`✓ tools/list returned: ${names.join(', ')}`);

  const expected = [
    'apply_preset',
    'list_block_types',
    'list_enum_values',
    'list_midi_ports',
    'list_params',
    'lookup_lineage',
    'reconnect_midi',
    'save_preset',
    'save_to_location',
    'set_block_bypass',
    'set_block_type',
    'set_param',
    'set_params',
    'set_preset_name',
    'set_scene_name',
    'switch_preset',
    'switch_scene',
  ];
  for (const exp of expected) {
    if (!names.includes(exp)) throw new Error(`missing tool: ${exp}`);
  }
  console.log(`✓ all ${expected.length} expected tools registered`);

  // Exercise list_midi_ports — enumerates ports but doesn't open the AM4.
  // Runs green regardless of whether an AM4 is actually connected; we're
  // asserting the tool is wired up and returns structured port info.
  const portsResp = await request('tools/call', {
    name: 'list_midi_ports',
    arguments: {},
  });
  if (portsResp.error) throw new Error(`list_midi_ports error: ${portsResp.error.message}`);
  const portsText = (portsResp.result as { content: { text: string }[] }).content[0].text;
  if (!portsText.includes('Inputs') || !portsText.includes('Outputs')) {
    throw new Error(`list_midi_ports missing Inputs/Outputs sections:\n${portsText}`);
  }
  console.log(`✓ list_midi_ports call returned port enumeration`);

  // BK-030 Session A — list_midi_ports accepts an optional `pattern` arg
  // for tagging non-AM4 devices. Smoke just exercises the input-schema
  // path; the response text adapts to the supplied pattern.
  const patternResp = await request('tools/call', {
    name: 'list_midi_ports',
    arguments: { pattern: 'hydra' },
  });
  if (patternResp.error) throw new Error(`list_midi_ports(pattern) error: ${patternResp.error.message}`);
  const patternText = (patternResp.result as { content: { text: string }[] }).content[0].text;
  if (!patternText.includes('hydra')) {
    throw new Error(`list_midi_ports(pattern="hydra") response missing pattern echo:\n${patternText}`);
  }
  console.log(`✓ list_midi_ports accepts custom pattern argument`);

  // Exercise list_params — doesn't touch MIDI.
  const callResp = await request('tools/call', {
    name: 'list_params',
    arguments: {},
  });
  if (callResp.error) throw new Error(`tools/call error: ${callResp.error.message}`);
  const content = (callResp.result as { content: { type: string; text: string }[] }).content;
  const text = content[0].text;
  if (!text.includes('amp.gain')) throw new Error(`list_params output missing amp.gain:\n${text}`);
  if (!text.includes('amp.type')) throw new Error(`list_params output missing amp.type:\n${text}`);
  // P5-011 item 4: list_params doubles as a connector-live sanity check.
  // The response must lead with a confirmation that the MCP server is
  // reachable and its tools are callable. Don't let this line regress —
  // if it disappears, Claude Desktop's HW-012 failure mode becomes
  // silently harder to diagnose.
  if (!text.includes('am4-tone-agent MCP server is live')) {
    throw new Error(`list_params missing live-confirmation line (P5-011 item 4):\n${text}`);
  }
  console.log(`✓ list_params call returned catalog (${text.split('\n').length} lines) with live-confirmation line`);

  // Exercise lookup_lineage forward + reverse — doesn't touch MIDI, just
  // reads src/knowledge/*.json. Confirms the tool is wired up and the data
  // is present.
  const forwardResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { block_type: 'drive', name: 'T808 OD' },
  });
  if (forwardResp.error) throw new Error(`lookup_lineage forward error: ${forwardResp.error.message}`);
  const forwardText = (forwardResp.result as { content: { text: string }[] }).content[0].text;
  if (!forwardText.includes('T808 OD')) throw new Error(`lookup_lineage forward missing T808 OD:\n${forwardText}`);
  if (!forwardText.includes('Tube Screamer')) throw new Error(`lookup_lineage forward missing Tube Screamer lineage:\n${forwardText}`);
  console.log(`✓ lookup_lineage forward (drive/T808 OD) returned record with Tube Screamer lineage`);

  const reverseResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { block_type: 'compressor', real_gear: '1176', include_quotes: false },
  });
  if (reverseResp.error) throw new Error(`lookup_lineage reverse error: ${reverseResp.error.message}`);
  const reverseText = (reverseResp.result as { content: { text: string }[] }).content[0].text;
  if (!reverseText.includes('JFET Studio Compressor')) {
    throw new Error(`lookup_lineage reverse (compressor/1176) missing JFET Studio Compressor:\n${reverseText}`);
  }
  console.log(`✓ lookup_lineage reverse (compressor/"1176") found JFET Studio Compressor`);

  // Structured filter: compressor by manufacturer ("MXR").
  const mfrResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { block_type: 'compressor', manufacturer: 'MXR', include_quotes: false },
  });
  if (mfrResp.error) throw new Error(`lookup_lineage manufacturer error: ${mfrResp.error.message}`);
  const mfrText = (mfrResp.result as { content: { text: string }[] }).content[0].text;
  if (!mfrText.includes('Dynami-Comp')) {
    throw new Error(`lookup_lineage manufacturer (MXR) missing Dynami-Comp variants:\n${mfrText}`);
  }
  console.log(`✓ lookup_lineage structured (compressor/manufacturer="MXR") found Dynami-Comp`);

  // Phaser block: "classic MXR phaser block" use case from BK-021 spec.
  const phaserResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { block_type: 'phaser', manufacturer: 'MXR', include_quotes: false },
  });
  if (phaserResp.error) throw new Error(`lookup_lineage phaser error: ${phaserResp.error.message}`);
  const phaserText = (phaserResp.result as { content: { text: string }[] }).content[0].text;
  if (!phaserText.includes('Block 90')) {
    throw new Error(`lookup_lineage phaser (MXR) missing Block 90:\n${phaserText}`);
  }
  console.log(`✓ lookup_lineage structured (phaser/manufacturer="MXR") found Block 90`);

  // Wah block by forward lookup.
  const wahResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { block_type: 'wah', name: 'Cry Babe', include_quotes: false },
  });
  if (wahResp.error) throw new Error(`lookup_lineage wah error: ${wahResp.error.message}`);
  const wahText = (wahResp.result as { content: { text: string }[] }).content[0].text;
  if (!wahText.includes('Dunlop') || !wahText.includes('Cry Baby')) {
    throw new Error(`lookup_lineage wah (Cry Babe) missing Dunlop Cry Baby lineage:\n${wahText}`);
  }
  console.log(`✓ lookup_lineage forward (wah/"Cry Babe") returned Dunlop Cry Baby`);

  // apply_preset validation (BK-027 phase 1). Exercises the pre-MIDI
  // validation path so the smoke test runs without a connected AM4.
  // Errors from the handler surface as a tool result with isError=true
  // and a text content block carrying the thrown message.
  const assertApplyPresetError = async (
    label: string,
    args: unknown,
    expectedFragment: string,
  ): Promise<void> => {
    const resp = await request('tools/call', {
      name: 'apply_preset',
      arguments: args,
    });
    const result = resp.result as
      | { isError?: boolean; content: { type: string; text: string }[] }
      | undefined;
    const errMessage = resp.error?.message ?? result?.content?.[0]?.text ?? '';
    const rejected = !!resp.error || result?.isError === true;
    if (!rejected) {
      throw new Error(`apply_preset ${label}: expected rejection, got success: ${JSON.stringify(resp.result)}`);
    }
    if (!errMessage.includes(expectedFragment)) {
      throw new Error(
        `apply_preset ${label}: expected error to include "${expectedFragment}", got:\n${errMessage}`,
      );
    }
  };

  await assertApplyPresetError(
    'mutual exclusion (channel + channels)',
    { slots: [{ position: 1, block_type: 'amp', channel: 'A', channels: { B: { gain: 5 } } }] },
    "'channels' (per-channel params) and 'channel'",
  );
  console.log(`✓ apply_preset rejects channels+channel combo with mutual-exclusion error`);

  await assertApplyPresetError(
    'mutual exclusion (params + channels)',
    { slots: [{ position: 1, block_type: 'amp', params: { gain: 6 }, channels: { A: { bass: 5 } } }] },
    "'channels' (per-channel params) and 'params'",
  );
  console.log(`✓ apply_preset rejects channels+params combo with mutual-exclusion error`);

  await assertApplyPresetError(
    'channels on a block without channels',
    { slots: [{ position: 1, block_type: 'compressor', channels: { A: { ratio: 4 } } }] },
    "doesn't have channels",
  );
  console.log(`✓ apply_preset rejects channels on compressor (no channel register)`);

  await assertApplyPresetError(
    'unknown channel letter',
    { slots: [{ position: 1, block_type: 'amp', channels: { E: { gain: 6 } } }] },
    'must be one of A/B/C/D',
  );
  console.log(`✓ apply_preset rejects unknown channel letter E`);

  await assertApplyPresetError(
    'unknown param inside channels.<letter>',
    { slots: [{ position: 1, block_type: 'amp', channels: { A: { not_a_real_param: 6 } } }] },
    'channels.A.not_a_real_param',
  );
  console.log(`✓ apply_preset surfaces path-like error for unknown param inside channels`);

  // Name-field validation — the schema cap is 32, but the zod max rejects at
  // the input layer with a validation error (not our buildSetPresetName
  // throw). Either way the 33-char name must be rejected.
  await assertApplyPresetError(
    'overlong name',
    { slots: [{ position: 1, block_type: 'amp' }], name: 'x'.repeat(33) },
    '32',
  );
  console.log(`✓ apply_preset rejects overlong name (33 chars)`);

  // scenes[] validation (BK-027 phase 2). Like the slot validation, these
  // fail in the pre-MIDI validation layer so no hardware is required.
  await assertApplyPresetError(
    'scenes: empty scene entry',
    { slots: [{ position: 1, block_type: 'amp' }], scenes: [{ index: 1 }] },
    'at least one of channels / bypass / name',
  );
  console.log(`✓ apply_preset rejects scene entry with no channels/bypass/name`);

  await assertApplyPresetError(
    'scenes: duplicate index',
    {
      slots: [{ position: 1, block_type: 'amp' }],
      scenes: [
        { index: 2, channels: { amp: 'A' } },
        { index: 2, channels: { amp: 'B' } },
      ],
    },
    'used twice',
  );
  console.log(`✓ apply_preset rejects duplicate scene index`);

  await assertApplyPresetError(
    'scenes: unknown block in channels map',
    {
      slots: [{ position: 1, block_type: 'amp' }],
      scenes: [{ index: 1, channels: { not_a_block: 'A' } }],
    },
    'channels.not_a_block',
  );
  console.log(`✓ apply_preset rejects unknown block in scenes[].channels`);

  await assertApplyPresetError(
    'scenes: channels on block without channels',
    {
      slots: [{ position: 1, block_type: 'compressor' }],
      scenes: [{ index: 1, channels: { compressor: 'A' } }],
    },
    "doesn't have channels",
  );
  console.log(`✓ apply_preset rejects scenes[].channels on compressor`);

  await assertApplyPresetError(
    'scenes: non-A/B/C/D letter',
    {
      slots: [{ position: 1, block_type: 'amp' }],
      scenes: [{ index: 1, channels: { amp: 'E' } }],
    },
    'must be one of A/B/C/D',
  );
  console.log(`✓ apply_preset rejects non-A/B/C/D letter in scenes[].channels`);

  await assertApplyPresetError(
    'scenes: unknown block in bypass map',
    {
      slots: [{ position: 1, block_type: 'amp' }],
      scenes: [{ index: 1, bypass: { not_a_block: true } }],
    },
    'bypass.not_a_block',
  );
  console.log(`✓ apply_preset rejects unknown block in scenes[].bypass`);

  await assertApplyPresetError(
    'scenes: "none" in bypass map',
    {
      slots: [{ position: 1, block_type: 'amp' }],
      scenes: [{ index: 1, bypass: { none: true } }],
    },
    'no bypass state',
  );
  console.log(`✓ apply_preset rejects "none" in scenes[].bypass`);

  child.stdin.end();
  await once(child, 'exit');
  const stderrStr = Buffer.concat(stderrChunks).toString('utf8');
  if (!stderrStr.includes('running on stdio')) {
    console.error('⚠ expected startup banner in stderr but saw:');
    console.error(stderrStr);
  } else {
    console.log('✓ startup banner present in stderr');
  }
  console.log('\nSmoke test PASS.');
}

main().catch((err) => {
  console.error('Smoke test FAIL:', err.message);
  process.exit(1);
});
