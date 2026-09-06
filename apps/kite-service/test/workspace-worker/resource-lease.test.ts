import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  createNativeWorkspaceResourceLeasePort,
  type WorkspaceEffectAttempt,
} from '../../src/workspace-worker';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function attempt(
  workerScopeId: string,
  resourceId = 'git-common-dir:sha256:shared',
): WorkspaceEffectAttempt {
  const workspaceIdentityDigest = workerScopeId === 'scope-a' ? 'a'.repeat(64) : 'b'.repeat(64);
  return {
    sessionId: `session-${workerScopeId}`,
    commandId: null,
    invocationId: `invocation-${workerScopeId}`,
    clientId: 'client-1',
    connectionGeneration: 1,
    controllerGeneration: 1,
    workerInstanceId: `worker-${workerScopeId}`,
    ownerId: `worker-${workerScopeId}`,
    workerScopeId,
    workspaceDigest: `sha256:${workspaceIdentityDigest}`,
    attemptId: `attempt-${workerScopeId}`,
    requestDigest: 'c'.repeat(64),
    expiresAtMs: 10_000,
    resourceId,
    kind: 'git',
  };
}

function fixture(processState: 'alive' | 'dead' | 'uncertain' = 'alive') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-resource-owner-')));
  roots.push(root);
  let nonce = 0;
  return createNativeWorkspaceResourceLeasePort({
    coordinationHome: createKiteHomeIdentity(root),
    currentProcessIdentity: () => 'process-current',
    processState: () => processState,
    randomBytes: (size) => new Uint8Array(size).fill(++nonce),
  });
}

describe('OS-user Workspace shared-resource lease', () => {
  test('serializes the same canonical resource across Workspaces', async () => {
    const port = fixture('alive');
    const first = await port.acquire(attempt('scope-a'));
    await expect(port.acquire(attempt('scope-b'))).rejects.toThrow('busy or unverifiable');

    const independent = await port.acquire(attempt('scope-b', 'user-config:other'));
    await independent[Symbol.asyncDispose]();
    await first[Symbol.asyncDispose]();

    const next = await port.acquire(attempt('scope-b'));
    await next[Symbol.asyncDispose]();
  });

  test('recovers only a positively dead exact owner', async () => {
    const deadPort = fixture('dead');
    const abandoned = await deadPort.acquire(attempt('scope-a'));
    const replacement = await deadPort.acquire(attempt('scope-b'));
    await replacement[Symbol.asyncDispose]();
    await expect(abandoned[Symbol.asyncDispose]()).rejects.toThrow();

    const uncertainPort = fixture('uncertain');
    const uncertain = await uncertainPort.acquire(attempt('scope-a'));
    await expect(uncertainPort.acquire(attempt('scope-b'))).rejects.toThrow('busy or unverifiable');
    await uncertain[Symbol.asyncDispose]();
  });
});
