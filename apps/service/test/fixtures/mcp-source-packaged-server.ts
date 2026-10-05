import { appendFileSync, writeFileSync } from 'node:fs';

const ledger = process.argv[2]!;
writeFileSync(
  `${ledger}.pid`,
  JSON.stringify({
    server: process.pid,
    guardian: process.ppid,
    visible: process.env.PACKAGED_VISIBLE ?? null,
  }),
);
let buffered = '';
for await (const chunk of process.stdin) {
  buffered += chunk.toString();
  while (buffered.includes('\n')) {
    const end = buffered.indexOf('\n');
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    const rpc = JSON.parse(line) as { id?: number; method: string; params?: unknown };
    if (rpc.id === undefined) continue;
    appendFileSync(ledger, `${JSON.stringify(rpc)}\n`);
    let result: unknown;
    if (rpc.method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'owned-packaged', version: '1' },
        capabilities: { tools: {} },
      };
    } else if (rpc.method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'packaged_effect',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string', const: 'exact' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
        ],
      };
    } else if (rpc.method === 'tools/call') {
      appendFileSync(`${ledger}.effects`, `${JSON.stringify(rpc.params)}\n`);
      result = { content: [{ type: 'text', text: 'OWNED_PACKAGED_EFFECT_ONCE' }] };
    } else throw new Error(`unexpected_rpc:${rpc.method}`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n`);
  }
}
