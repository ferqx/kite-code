import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packageTraceExtension } from '../src/bundle';

const [entry, manifest, output] = process.argv.slice(2);
if (!entry || !manifest || !output)
  throw Error('usage: pack.ts entry.ts manifest.json output.json');
const packaged = await packageTraceExtension(
  resolve(entry),
  JSON.parse(readFileSync(manifest, 'utf8')),
);
writeFileSync(resolve(output), `${JSON.stringify(packaged)}\n`, { flag: 'wx', mode: 0o600 });
