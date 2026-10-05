import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, token] = process.argv.slice(2);
if (!root || !token || !/^[a-f0-9]{64}$/.test(token)) throw Error('worker_identity_invalid');
const request = JSON.parse(readFileSync(join(root, 'request.json'), 'utf8'));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
if (hash(request.executionId) !== token) throw Error('worker_request_mismatch');
const identity = { token, executionId: request.executionId, pid: process.pid };
appendFileSync(join(root, 'ledger'), `start:${token}:${process.pid}\n`);
writeFileSync(join(root, 'started.json'), JSON.stringify(identity), { flag: 'wx' });
process.on('SIGTERM', () => {
  appendFileSync(join(root, 'ledger'), `stop:${token}\n`);
  writeFileSync(
    join(root, 'eof.json'),
    JSON.stringify({ ...identity, outcome: 'cancelled', digest: null }),
    { flag: 'wx' },
  );
  process.exit(0);
});
const deadline = Date.now() + 10000;
while (!existsSync(join(root, 'release'))) {
  if (Date.now() > deadline) throw Error('owned_worker_deadline');
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const body = `deferred@1\n${token}\n${request.payload}`;
writeFileSync(join(root, 'result.txt'), body, { flag: 'wx' });
appendFileSync(join(root, 'ledger'), `effect:${token}:${Buffer.byteLength(body)}\n`);
writeFileSync(
  join(root, 'eof.json'),
  JSON.stringify({ ...identity, outcome: 'succeeded', digest: hash(body) }),
  { flag: 'wx' },
);
