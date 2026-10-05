import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [ledger, catalogue, gate] = process.argv.slice(2) as [string, string, string];
let buffer = '';
const send = (id: unknown, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const request = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    void handle(request);
  }
});
async function handle(request: {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}) {
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    appendFileSync(ledger, 'connect\n');
    send(request.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'local-fixture', version: '1' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
    });
  } else if (request.method === 'tools/list') {
    const value = JSON.parse(readFileSync(catalogue, 'utf8'));
    send(request.id, Array.isArray(value) ? { tools: value } : value);
  } else if (request.method === 'tools/call') {
    appendFileSync(ledger, `effect:${JSON.stringify(request.params)}\n`);
    while (gate && !existsSync(gate)) await Bun.sleep(5);
    send(request.id, {
      content: [{ type: 'text', text: 'fixed-result' }],
      structuredContent: { version: 'old' },
    });
  } else if (request.method === 'resources/list')
    send(request.id, { resources: [{ uri: 'fixture://resource', name: 'resource' }] });
  else if (request.method === 'resources/read')
    send(request.id, { contents: [{ uri: request.params?.uri, text: 'resource-text' }] });
  else if (request.method === 'prompts/list')
    send(request.id, { prompts: [{ name: 'guidance', description: 'local prompt' }] });
  else if (request.method === 'prompts/get')
    send(request.id, {
      messages: [{ role: 'user', content: { type: 'text', text: 'prompt-text' } }],
    });
  else send(request.id, {});
}
