import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, key] = process.argv.slice(2);
if (!root || !key || !/^[a-z0-9-]+$/.test(key)) throw Error('invalid_worker_identity');
const request = JSON.parse(readFileSync(join(root, `${key}.request`), 'utf8')) as {
  payload: string;
  hold: boolean;
};
appendFileSync(join(root, 'worker-ledger'), `start:${key}:${process.pid}\n`);
const deadline = Date.now() + 15000;
while (request.hold && !existsSync(join(root, `${key}.release`))) {
  if (Date.now() > deadline) throw Error('owned_worker_deadline');
  await new Promise((r) => setTimeout(r, 5));
}
const digest = createHash('sha256').update(request.payload).digest('hex');
const bytes = Buffer.from(
  `capsule@1\n${digest}\n${Array.from(request.payload).reverse().join('')}`,
);
writeFileSync(join(root, `${key}.pending`), bytes, { mode: 0o600, flag: 'wx' });
renameSync(join(root, `${key}.pending`), join(root, `${key}.capsule`));
appendFileSync(join(root, 'worker-ledger'), `effect:${key}:${bytes.length}\n`);
