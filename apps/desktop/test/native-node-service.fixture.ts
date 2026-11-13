import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDevelopmentService } from '../../../scripts/development/desktop-reload';

const repository = resolve(import.meta.dirname, '../../..');

export async function buildNativeTestService(outdir: string) {
  const runtimeExecutable = realpathSync(process.execPath);
  const service = await buildDevelopmentService(repository, outdir, runtimeExecutable);
  return {
    assets: {
      kind: 'development' as const,
      serviceEntrypoint: join(outdir, 'services', service.id, 'main.js'),
      serviceSha256: service.sha256,
      runtimeExecutable,
      runtimeSha256: createHash('sha256').update(readFileSync(runtimeExecutable)).digest('hex'),
    },
    runtimeAddon: realpathSync(join(repository, 'packages/agent/dist/runtime-native.node')),
  };
}
