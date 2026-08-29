import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorWorkerIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import { WORKSPACE_WORKER_PROCESS_DESCRIPTOR_SCHEMA_ } from '../../src/workspace-worker/process-host';
import { createWorkspaceWorkerProcessStatePort } from '../../src/workspace-worker/process-state';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worker-state-')));
  roots.push(root);
  return root;
}

function identity(workerScopeId: string): CoordinatorWorkerIdentity {
  return {
    role: 'worker',
    workerScopeId,
    instanceId: 'instance-state',
    buildId: 'build-state',
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
    clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
  };
}

function descriptor(workerScopeId: string) {
  return {
    schema: WORKSPACE_WORKER_PROCESS_DESCRIPTOR_SCHEMA_,
    identity: identity(workerScopeId),
    workspaceDigest: `sha256:${'a'.repeat(64)}`,
    pid: 42_001,
    startedAt: '2026-08-29T00:00:00.000Z',
    processStartIdentity: 'worker-state-start',
    storeProfile: 'kite-agent-server-api-v1-2026-08-29',
    layoutGeneration: 'layout-state',
    endpoint: {
      origin: 'http://127.0.0.1:43142',
      websocketUrl: 'ws://127.0.0.1:43142/rpc',
    },
    controlOrigin: 'http://127.0.0.1:43143',
  } as const;
}

describe('Workspace Worker process state', () => {
  test('stores descriptor and launch credential in distinct owner-only files', async () => {
    const root = makeRoot();
    const state = createWorkspaceWorkerProcessStatePort(createKiteHomeIdentity(join(root, 'home')));
    const value = descriptor('scope-state');
    const credential = 'a'.repeat(43);
    await state.publishControlCredential('scope-state', credential);
    await state.publish(value);

    await expect(state.read('scope-state')).resolves.toEqual(value);
    await expect(state.listDescriptors!()).resolves.toEqual([value]);
    await expect(state.readControlCredential('scope-state')).resolves.toBe(credential);
    expect(state.paths.descriptorForScope('scope-state')).not.toContain('scope-state');
    expect(state.paths.controlCredentialForScope('scope-state')).not.toContain('scope-state');
    expect(lstatSync(state.paths.descriptorForScope('scope-state')).nlink).toBe(1);
    expect(lstatSync(state.paths.controlCredentialForScope('scope-state')).nlink).toBe(1);
    if (process.platform !== 'win32') {
      expect(lstatSync(state.paths.descriptorForScope('scope-state')).mode & 0o077).toBe(0);
      expect(lstatSync(state.paths.controlCredentialForScope('scope-state')).mode & 0o077).toBe(0);
    }
  });

  test('never overwrites an existing launch marker and clears only an exact credential', async () => {
    const root = makeRoot();
    const state = createWorkspaceWorkerProcessStatePort(createKiteHomeIdentity(join(root, 'home')));
    await state.publishControlCredential('scope-marker', 'b'.repeat(43));
    await expect(
      state.publishControlCredential('scope-marker', 'c'.repeat(43)),
    ).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(
      state.clearControlCredential('scope-marker', 'c'.repeat(43)),
    ).rejects.toMatchObject({ code: 'corrupt' });
    await state.clearControlCredential('scope-marker', 'b'.repeat(43));
    await expect(state.readControlCredential('scope-marker')).resolves.toBeUndefined();
  });

  test('fails closed for symlink and hardlink aliases', async () => {
    const root = makeRoot();
    const state = createWorkspaceWorkerProcessStatePort(createKiteHomeIdentity(join(root, 'home')));
    const value = descriptor('scope-alias');
    await state.publish(value);
    const descriptorPath = state.paths.descriptorForScope('scope-alias');
    const alias = join(root, 'descriptor-alias');
    symlinkSync(descriptorPath, alias);
    rmSync(descriptorPath);
    symlinkSync(alias, descriptorPath);
    await expect(state.read('scope-alias')).rejects.toMatchObject({ code: 'corrupt' });

    rmSync(descriptorPath);
    await state.publish(value);
    const hardlink = join(root, 'descriptor-hardlink');
    linkSync(state.paths.descriptorForScope('scope-alias'), hardlink);
    await expect(state.read('scope-alias')).rejects.toMatchObject({ code: 'corrupt' });
    rmSync(hardlink);
    chmodSync(state.paths.descriptorForScope('scope-alias'), 0o644);
    await expect(state.read('scope-alias')).rejects.toMatchObject({ code: 'permission' });
  });
});
