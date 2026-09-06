import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { createKiteServiceRuntimeComposition } from '../src/composition';

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { force: true, recursive: true });
  root = undefined;
});

test('starts neutral and admits a trusted workspace lazily', async () => {
  root = mkdtempSync(join(realpathSync(homedir()), 'kite-service-composition-'));
  const workspacePath = join(root, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  const trustStorePath = join(root, 'workspace-trust.jsonc');
  const checkpointPath = join(root, 'checkpoints.sqlite');
  const composition = createKiteServiceRuntimeComposition({
    checkpointPath,
    workspaceTrustStorePath: trustStorePath,
  });
  try {
    // Creating and starting the process-wide application does not resolve config, MCP, Skill, or
    // a Workspace template.
    await expect(composition.application.start()).resolves.toBeUndefined();
    const queried = await composition.appControl.gateway.discovery.queryWorkspaceTrust({
      schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
      workspace: workspacePath,
    });
    expect(queried.status).toBe('unknown');
    const decided = await composition.appControl.gateway.discovery.decideWorkspaceTrust({
      schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
      workspace: queried.workspace,
      observedStatus: queried.status,
      expectedRevision: queried.revision,
      decision: 'trust',
      externalReadScopeDigest: queried.externalReadScope.digest,
    });
    expect(decided.outcome).toBe('recorded');
    expect(composition.appControl.admitWorkspace(workspacePath)).toEqual(queried.workspace);
  } finally {
    await composition[Symbol.asyncDispose]();
  }
});

test.skipIf(process.platform === 'win32')(
  'rejects a second process owner through a canonical Store path alias',
  async () => {
    root = mkdtempSync(join(realpathSync(homedir()), 'kite-service-store-owner-'));
    const alias = `${root}-alias`;
    symlinkSync(root, alias, 'dir');
    const first = createKiteServiceRuntimeComposition({
      checkpointPath: join(root, 'checkpoints.sqlite'),
    });
    try {
      expect(() =>
        createKiteServiceRuntimeComposition({
          checkpointPath: join(alias, 'checkpoints.sqlite'),
        }),
      ).toThrow('already has a process owner');
    } finally {
      await first[Symbol.asyncDispose]();
      rmSync(alias, { force: true });
    }
  },
);
