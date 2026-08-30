import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  createNativeWorkspaceOwnerLockPort,
  type WorkspaceWorkerIdentity,
} from '../../src/workspace-worker';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function worker(
  instance: string,
  digest: `sha256:${string}` = `sha256:${'a'.repeat(64)}`,
): WorkspaceWorkerIdentity {
  return {
    workerScopeId: `scope-${digest.slice(-8)}`,
    workerInstanceId: instance,
    buildId: 'build-1',
    workspace: { canonicalPath: '/workspace', projectId: 'project-1', workspaceDigest: digest },
  };
}

function fixture(processState: 'alive' | 'dead' | 'uncertain' = 'alive') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-workspace-owner-')));
  roots.push(root);
  let nonce = 0;
  return createNativeWorkspaceOwnerLockPort({
    coordinationHome: createKiteHomeIdentity(root),
    currentProcessIdentity: () => 'process-current',
    processState: () => processState,
    randomBytes: (size) => new Uint8Array(size).fill(++nonce),
  });
}

describe('OS-user Workspace owner lock', () => {
  test('rejects a second same-Workspace writer while allowing a different Workspace', async () => {
    const port = fixture('alive');
    const first = await port.acquire(worker('worker-1'));
    await expect(port.acquire(worker('worker-2'))).rejects.toThrow('busy or unverifiable');
    const other = await port.acquire(worker('worker-3', `sha256:${'b'.repeat(64)}`));
    await other[Symbol.asyncDispose]();
    await first[Symbol.asyncDispose]();
    const replacement = await port.acquire(worker('worker-4'));
    await replacement[Symbol.asyncDispose]();
  });

  test('replaces only a positively dead exact owner and fails closed for uncertain state', async () => {
    const deadPort = fixture('dead');
    const abandoned = await deadPort.acquire(worker('worker-dead'));
    // Simulate a crashed owner by intentionally leaving its exact file in place.
    const replacement = await deadPort.acquire(worker('worker-replacement'));
    await replacement[Symbol.asyncDispose]();
    await expect(abandoned[Symbol.asyncDispose]()).rejects.toThrow();

    const uncertainPort = fixture('uncertain');
    const uncertain = await uncertainPort.acquire(worker('worker-uncertain'));
    await expect(uncertainPort.acquire(worker('worker-blocked'))).rejects.toThrow(
      'busy or unverifiable',
    );
    await uncertain[Symbol.asyncDispose]();
  });
});
