// Independently running predecessor fixture: no dependency on current lifecycle or Runtime codecs.
import { chmodSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { readLocalProcessStartIdentity } from '@kite-ai/kite-local-runtime/service';

const [socketPath, homeDigest, workspace] = process.argv.slice(2) as [string, string, string];
if (process.platform !== 'win32') mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
const processStartIdentity = await readLocalProcessStartIdentity();
if (!processStartIdentity) throw new Error('Fixture process identity unavailable');
const instanceId = 'released-old-fixture';
const server = createServer((socket) => {
  let data = '';
  socket.on('data', (chunk) => {
    data += chunk.toString();
    if (!data.includes('\n')) return;
    const request = JSON.parse(data.slice(0, data.indexOf('\n')));
    const base = { schema: 'kite.lifecycle.v1', requestId: request.requestId };
    if (request.operation === 'status') {
      socket.end(
        `${JSON.stringify({
          ...base,
          operation: 'status',
          status: {
            instanceId,
            pid: process.pid,
            processStartIdentity,
            homeDigest,
            workspace,
            buildId: 'old-release-fixture',
            startedAt: '2026-01-01T00:00:00.000Z',
            protocol: 'incompatible-old-business',
            capabilities: [],
            phase: 'ready',
            activeOperations: false,
          },
        })}\n`,
      );
    } else {
      const matched = request.expectedInstanceId === instanceId;
      socket.end(
        `${JSON.stringify({ ...base, operation: 'shutdown', outcome: matched ? 'accepted' : 'instance_changed' })}\n`,
        () => {
          if (matched) server.close(() => process.exit(0));
        },
      );
    }
  });
});
server.listen(socketPath, () => {
  if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
  console.log('ready');
});
