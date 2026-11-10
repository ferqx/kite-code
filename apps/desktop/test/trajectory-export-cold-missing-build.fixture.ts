import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildNativeDesktop } from '../scripts/build-native';

const directory = realpathSync(
  mkdtempSync(resolve(import.meta.dir, '../../../.cache/trajectory-export-cold-missing-')),
);
const original = JSON.parse(
  readFileSync(
    process.argv[2] ??
      resolve(import.meta.dir, '../../../.cache/trajectory-export-native-Xgpl5a/fixture.json'),
    'utf8',
  ),
) as { directory: string };
const bundle = join(original.directory, 'events-only.kite-trajectory'),
  service = join(original.directory, 'service/main.js'),
  runtime = realpathSync(process.execPath),
  hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex'),
  profile = { dataRoot: join(directory, 'unopened-profile'), profile: 'cold' },
  outdir = join(directory, 'app');
await buildNativeDesktop(
  {
    kind: 'development',
    serviceEntrypoint: service,
    serviceSha256: hash(service),
    bunExecutable: runtime,
    bunSha256: hash(runtime),
    buildId: 'trajectory-export-cold-missing',
    apiMajor: 1,
    requiredCapabilities: ['trajectory'],
    profile,
  },
  outdir,
  { testDiagnostics: false },
);
mkdirSync(join(directory, 'driver'), { mode: 0o700 });
const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'trajectory-export-cold-missing.fixture.ts')],
  outdir: join(directory, 'driver'),
  naming: 'driver.mjs',
  target: 'node',
  packages: 'external',
});
if (!build.success) throw new AggregateError(build.logs, 'cold_missing_driver_build_failed');
const fixturePath = join(directory, 'fixture.json');
writeFileSync(fixturePath, JSON.stringify({ directory, outdir, bundle, profile }, null, 2));
const node = Bun.which('node');
if (!node) throw Error('node_driver_required');
console.log(JSON.stringify({ directory, bundle }));
const child = Bun.spawn(
  [
    node,
    join(directory, 'driver/driver.mjs'),
    fixturePath,
    resolve(import.meta.dir, '../package.json'),
  ],
  { cwd: directory, stdout: 'inherit', stderr: 'inherit' },
);
process.exitCode = await child.exited;
