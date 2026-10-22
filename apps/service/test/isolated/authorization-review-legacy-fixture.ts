import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// Frozen from the real pre-boundary producer after its pending approval was written,
// followed by SIGKILL. Keep the legacy child/carrier proof and private body bindings
// intact so compatibility reads do not depend on reintroducing an old write path.
const root = process.env.KITE_REVIEW_FIXTURE_ROOT!;
const files = JSON.parse(
  gunzipSync(
    readFileSync(new URL('./fixtures/legacy-auto-pending.json.gz', import.meta.url)),
  ).toString(),
) as Record<string, { data: string; mode: number }>;
for (const [relative, file] of Object.entries(files)) {
  if (relative === 'ready.json' || relative.startsWith('data/.coordination/')) continue;
  if (relative.split('/').some((part) => part === '..') || relative.startsWith('/'))
    throw Error('Invalid fixture path');
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, Buffer.from(file.data, 'base64'), { mode: file.mode });
  chmodSync(path, file.mode);
}
writeFileSync(join(root, 'ready.json'), Buffer.from(files['ready.json']!.data, 'base64'), {
  mode: 0o600,
});
// The test kills this producer before opening the restored profile through readonly HTTP.
setInterval(() => {}, 1000);
await new Promise(() => {});
