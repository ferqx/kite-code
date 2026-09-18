import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import { createMockModelServer } from '../../../tests/tui-system/harness/fixtures';
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

test('resolves persisted and newly selected Session models in the production Service composition', async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-service-model-route-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const modelServer = createMockModelServer();
  try {
    modelServer.setResponses([
      { message: { content: 'restored response' } },
      { message: { content: 'switched response' } },
    ]);
    const userConfigPath = join(root, 'config.jsonc');
    writeFileSync(
      userConfigPath,
      JSON.stringify({
        provider: {
          local: {
            type: 'openai-compatible',
            apiKey: 'test-key',
            baseURL: modelServer.baseURL,
            model: 'one',
            models: ['one', 'two'],
          },
        },
        model: 'local:one',
      }),
    );
    const options = {
      checkpointPath: join(root, 'checkpoints.sqlite'),
      userConfigPath,
      workspaces: [{ workspace, sandboxBackend: 'none' }],
    } as const;
    const composition = createKiteServiceRuntimeComposition(options);
    try {
      const created = await composition.runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'create-alternate-model',
        type: 'create_session',
        workspace,
        bootstrapSessionId: 'alternate-model',
        model: { provider: 'local', name: 'two' },
      });
      expect(created).toMatchObject({ status: 'applied', sessionId: 'alternate-model' });
      expect(
        await composition.runtime.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId: 'alternate-model',
        }),
      ).toMatchObject({ status: 'ok', session: { model: { provider: 'local', name: 'two' } } });
      const defaultCreated = await composition.runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'create-default-model',
        type: 'create_session',
        workspace,
        bootstrapSessionId: 'default-model',
        model: { provider: 'local', name: 'one' },
      });
      expect(defaultCreated).toMatchObject({ status: 'applied', sessionId: 'default-model' });
      const scopedControl = composition.appControl.gateway.forWorkspace(
        composition.appControl.admitWorkspace(workspace),
      );
      const before = await scopedControl.getProviderModelSnapshot({
        schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
        workspace: composition.appControl.admitWorkspace(workspace),
      });
      const selected = await scopedControl.selectProviderModel({
        schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
        workspace: composition.appControl.admitWorkspace(workspace),
        provider: 'local',
        name: 'two',
        expectedRevision: before.revision,
      });
      expect(selected.outcome).toBe('applied');
      expect(
        await composition.runtime.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId: 'default-model',
        }),
      ).toMatchObject({ status: 'ok', session: { model: { provider: 'local', name: 'one' } } });
      expect(
        await composition.runtime.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId: 'alternate-model',
        }),
      ).toMatchObject({ status: 'ok', session: { model: { provider: 'local', name: 'two' } } });
      const restoredDefault = await scopedControl.selectProviderModel({
        schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
        workspace: composition.appControl.admitWorkspace(workspace),
        provider: 'local',
        name: 'one',
        expectedRevision: selected.snapshot.revision,
      });
      expect(restoredDefault.outcome).toBe('applied');
    } finally {
      await composition[Symbol.asyncDispose]();
    }
    const restarted = createKiteServiceRuntimeComposition(options);
    try {
      const subscription = restarted.runtime.subscribe({
        spec: { scope: 'session', sessionId: 'alternate-model' },
      });
      const iterator = subscription[Symbol.asyncIterator]();
      await iterator.next();
      expect(
        await restarted.runtime.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: 'start-restored-alternate',
          type: 'start_turn',
          sessionId: 'alternate-model',
          expectedRevision: 0,
          input: 'hello',
        }),
      ).toMatchObject({ status: 'applied' });
      for (let attempt = 0; attempt < 100 && modelServer.getRequestCount() === 0; attempt++) {
        await Bun.sleep(10);
      }
      expect(modelServer.getRequests()[0]?.body.model).toBe('two');
      let completed = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const notification = await iterator.next();
        if (notification.done) throw new Error('Restored Session closed before terminal.');
        if (
          'durability' in notification.value &&
          notification.value.durability === 'durable' &&
          notification.value.sessionId === 'alternate-model' &&
          notification.value.projection.session.currentRun?.status === 'completed'
        ) {
          completed = true;
          break;
        }
      }
      expect(completed).toBe(true);
      await iterator.return?.();
      const switchedIterator = restarted.runtime
        .subscribe({
          spec: { scope: 'session', sessionId: 'alternate-model' },
        })
        [Symbol.asyncIterator]();
      await switchedIterator.next();
      const current = await restarted.runtime.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: 'alternate-model',
      });
      if (current.status !== 'ok' || !current.session)
        throw new Error('Restored Session is unavailable.');
      let switchedReceipt: Awaited<ReturnType<typeof restarted.runtime.command>> | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        switchedReceipt = await restarted.runtime.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          commandId: `start-switch-model-${attempt}`,
          type: 'start_turn',
          sessionId: 'alternate-model',
          expectedRevision: current.session.revision,
          input: 'hello',
          model: { provider: 'local', name: 'one' },
        });
        if (switchedReceipt.status !== 'rejected' || switchedReceipt.code !== 'runtime_busy') break;
        await Bun.sleep(10);
      }
      expect(switchedReceipt).toMatchObject({ status: 'applied' });
      for (let attempt = 0; attempt < 100 && modelServer.getRequestCount() < 2; attempt++) {
        await Bun.sleep(10);
      }
      expect(modelServer.getRequests()[1]?.body.model).toBe('one');
      let switchedCompleted = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const notification = await switchedIterator.next();
        if (notification.done) throw new Error('Switched Session closed before terminal.');
        if (
          'durability' in notification.value &&
          notification.value.durability === 'durable' &&
          notification.value.sessionId === 'alternate-model' &&
          notification.value.projection.session.currentRun?.status === 'completed'
        ) {
          switchedCompleted = true;
          break;
        }
      }
      expect(switchedCompleted).toBe(true);
      await switchedIterator.return?.();
      expect(
        await restarted.runtime.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId: 'default-model',
        }),
      ).toMatchObject({ status: 'ok', session: { model: { provider: 'local', name: 'one' } } });
    } finally {
      await restarted[Symbol.asyncDispose]();
    }
  } finally {
    modelServer.stop();
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
