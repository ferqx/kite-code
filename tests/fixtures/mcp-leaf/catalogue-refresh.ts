import { appendFileSync, readFileSync } from 'node:fs';

const [cataloguePath, ledgerPath] = process.argv.slice(2);
if (!cataloguePath || !ledgerPath) throw new Error('owned_catalogue_arguments_missing');
for await (const line of console) {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) continue;
  appendFileSync(ledgerPath, `${JSON.stringify({ method: rpc.method, params: rpc.params })}\n`);
  const result =
    rpc.method === 'initialize'
      ? {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'owned', version: '1' },
          capabilities: { tools: {} },
        }
      : rpc.method === 'tools/list'
        ? { tools: JSON.parse(readFileSync(cataloguePath, 'utf8')) }
        : { content: [{ type: 'text', text: 'actual owned remote result' }] };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
}
