import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuiltinModelOperationExecutionPortV1 } from '@kite/builtin-runtime/model';
import { createInstalledKiteRuntimeCompositionFactoryV1 } from '#app/bootstrap/model-runtime-composition';

const previousKiteCodeHome = process.env.KITE_CODE_HOME;
const temporaryRoots: string[] = [];

afterEach(() => {
  if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
  else process.env.KITE_CODE_HOME = previousKiteCodeHome;
  for (const root of temporaryRoots.splice(0)) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to remove unexpected test root: ${root}`);
    }
    rmSync(root, { recursive: true });
  }
});

describe('Kite installed Model Runtime composition identity', () => {
  test('reuses one Gateway for one App workspace and rejects a second workspace', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-runtime-composition-')));
    temporaryRoots.push(root);
    process.env.KITE_CODE_HOME = root;
    const workspace = join(root, 'workspace');
    const otherWorkspace = join(root, 'other-workspace');
    mkdirSync(workspace);
    mkdirSync(otherWorkspace);

    const operationExecution: BuiltinModelOperationExecutionPortV1 = Object.freeze({
      execute: async () => {
        throw new Error('composition identity test must not dispatch a Model operation');
      },
    });
    const factory = createInstalledKiteRuntimeCompositionFactoryV1(operationExecution);
    const first = factory(workspace);
    const second = factory(workspace);

    expect(first).toBe(second);
    expect(first.status).toBe('available');
    if (first.status !== 'available' || second.status !== 'available') {
      throw new Error('Model Runtime composition unexpectedly unavailable');
    }
    expect(first.gateway).toBe(second.gateway);
    expect(first.modelEffects).toBe(second.modelEffects);
    expect(first.workspaceFilesystem).toBe(second.workspaceFilesystem);
    expect(() => factory(otherWorkspace)).toThrow(
      'One Kite Runtime composition cannot span multiple workspaces.',
    );
    expect(first.gateway).toBe(second.gateway);
  });
});
