import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ExecutionRecord, Store } from '@kite-ai/agent/storage';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from './live-permission-fixture';

const [directory, baseURL, phase, runId, expectedOwnerGeneration] = process.argv.slice(2);
assert(directory && baseURL?.startsWith('http://127.0.0.1:') && phase);
const workspace = join(directory, 'workspace');
const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'test' });
const settings = join(profile.profilePath, 'config.jsonc');
if (phase === 'seed') {
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  writeFileSync(
    settings,
    JSON.stringify({
      modelId: 'local',
      models: [{ id: 'local', model: 'fixture', provider: 'compatible', baseURL }],
    }),
    { mode: 0o600 },
  );
}
const store = await openSqliteStore(profile);
const scope = {
  expectedStoreId: (await store.getMetadata()).storeId,
  sessionId: 's',
  subjectId: 'owner',
};
const host = createDefaultProcessConfiguration({
  profile,
  userConfigurationPath: settings,
  localCodex: false,
  credentialBackend: createTemporaryCredentialBackend(),
  browser: false,
  hostConfiguration: {
    configuration: {
      tools: [{ id: 'ask_user', enabled: false }, { id: 'files.read' }, { id: 'skills.load' }],
      skills: [{ id: 'guide', path: 'guide' }],
    },
  },
});
async function cut(execution: ExecutionRecord, status: 'planned' | 'cancelled' = 'planned') {
  const session = await store.getSession(scope.sessionId);
  assert(session && execution.runId && execution.status === status);
  assert.equal(execution.modelDispatched ?? execution.authorization?.dispatched, false);
  console.log(JSON.stringify({ execution, expectedOwnerGeneration: session.ownerGeneration }));
  await new Promise<never>(() => {});
}
let modelPlans = 0;
const observed = new Proxy(store, {
  get(target, key) {
    if (key === 'markDispatching' && phase === 'seed')
      return async (input: Parameters<Store['markDispatching']>[0]) => {
        const execution = await store.getExecution(input.executionId);
        if (execution?.kind === 'model' && ++modelPlans === 2) await cut(execution);
        return target.markDispatching(input);
      };
    if (key === 'planExecution' && phase === 'successor')
      return async (input: Parameters<Store['planExecution']>[0]) => {
        const execution = await target.planExecution(input);
        if (execution.kind === 'tool' && execution.definitionId === 'files.read')
          await cut(execution);
        return execution;
      };
    if (
      key === 'retireUnsentModelForContextRefresh' &&
      (phase === 'steer' || phase === 'steer-cut')
    )
      return async (input: Parameters<Store['retireUnsentModelForContextRefresh']>[0]) => {
        const run = await store.getRun(input.runId);
        assert(run);
        const steer = await runtime.submitCommand({
          ...scope,
          commandId: 'correction',
          request: {
            kind: 'input.steer',
            targetRunId: run.id,
            contextSelectionId: run.contextSelectionId,
            content: 'Apply this latest correction while resuming the work.',
          },
        });
        assert.equal(steer.status, 'accepted');
        const disposition = await target.retireUnsentModelForContextRefresh(input);
        if (phase === 'steer-cut') {
          assert.equal(disposition, 'steered');
          const execution = await store.getExecution(input.executionId);
          assert(execution);
          await cut(execution, 'cancelled');
        }
        return disposition;
      };
    if (key === 'retireUnsentModelForContextRefresh' && phase === 'include-cut')
      return async (input: Parameters<Store['retireUnsentModelForContextRefresh']>[0]) => {
        const run = await store.getRun(input.runId);
        const view = await store.getView(scope.sessionId);
        const evidence = view.executions.find(
          ({ kind, definitionId, status }) =>
            kind === 'tool' && definitionId === 'skills.load' && status === 'succeeded',
        );
        assert(run && evidence?.runId === run.id);
        const included = await runtime.includeResult({
          ...scope,
          commandId: 'include-original',
          targetRunId: run.id,
          expectedContextSelectionId: run.contextSelectionId,
          executionId: evidence.id,
          resultRevision: evidence.resultRevision,
        });
        assert.equal(included.command.status, 'accepted');
        const steer = await runtime.submitCommand({
          ...scope,
          commandId: 'after-include',
          request: {
            kind: 'input.steer',
            targetRunId: run.id,
            contextSelectionId: run.contextSelectionId,
            content: 'Apply this correction after the selected result.',
          },
        });
        assert.equal(steer.status, 'accepted');
        const disposition = await target.retireUnsentModelForContextRefresh(input);
        assert.equal(disposition, 'retired');
        assert.equal((await store.getCommand(included.command.id))?.status, 'accepted');
        assert.equal((await store.getCommand(steer.id))?.status, 'accepted');
        const retired = await store.getExecution(input.executionId);
        assert(retired);
        await cut(retired, 'cancelled');
        return disposition;
      };
    return Reflect.get(target, key);
  },
});
assert(host.permissions && host.permissionManagement);
const runtime = createRuntime({
  ...host,
  permissions: host.permissions,
  store: observed,
  artifacts: createArtifactStore({ profile, store: observed }),
});
host.permissionManagement(runtime);
try {
  if (phase === 'seed') {
    await runtime.createWorkspace({
      expectedStoreId: scope.expectedStoreId,
      id: 'w',
      name: 'Owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      ...scope,
      workspaceId: 'w',
      commandId: 'create',
      title: 'Owned',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      ...scope,
      workspaceId: 'w',
      mode: 'full',
      trusted: true,
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'work',
      request: {
        kind: 'run.start',
        content: 'Continue the original task.',
        selectedSkills: ['guide'],
      },
    });
  } else {
    assert(runId && expectedOwnerGeneration);
    const resume = runtime.resumeRun({
      ...scope,
      runId,
      expectedOwnerGeneration,
      commandId: `resume-${phase}`,
    });
    if (phase === 'reject') {
      await assert.rejects(resume, { code: 'run_configuration_mismatch' });
    } else {
      await resume;
    }
  }
  if (phase !== 'reject') await runtime.waitForCommand('work', { timeoutMs: 8000 });
} finally {
  await runtime.close();
  await store.close();
}
