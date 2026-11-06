import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { initializeLivePermissionFixture } from '../../../../apps/service/test/fixtures/live-permission-fixture';
import { privateDirectory } from '../../test-filesystem';
import { createDefaultProcessConfiguration } from './configuration';
import { defaultTaskRoles } from './roles';

export const revision = '8e350f99ed6651d2c5db82fca3430d5d0d27b01e';
export const roleIds = ['worker', 'code', 'explore', 'plan', 'review'] as const;
export const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export function call(name: string, input: object): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
export function object(value: Json | undefined): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('history_fixture_object');
  return value;
}
export async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error('role_history_deadline');
    await Bun.sleep(5);
  }
}
export function setup(directory: string) {
  const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'fixture' });
  const workspace = join(directory, 'workspace');
  privateDirectory(profile.profilePath);
  privateDirectory(workspace);
  writeFileSync(join(workspace, 'source.txt'), 'Original historical file.\n');
  const userConfigurationPath = join(profile.profilePath, 'config.jsonc');
  const selected = ['files.read', 'files.write', 'task.spawn', 'task.follow_up'];
  writeFileSync(
    userConfigurationPath,
    JSON.stringify({
      modelId: 'history',
      models: [
        {
          id: 'history',
          provider: 'compatible',
          model: 'controlled',
          baseURL: 'http://127.0.0.1:9/v1',
        },
      ],
      tools: selected.map((id) => ({ id })),
    }),
  );
  const options = {
    profile,
    userConfigurationPath,
    localCodex: false as const,
    browser: false as const,
    credentialBackend: createTemporaryCredentialBackend(),
  };
  return { profile, workspace, options, selected };
}

/** Frozen original roles, selection and Tool producer; no current default roles are imported. */
export function legacyHost(directory: string) {
  const paths = setup(directory);
  const host = createDefaultProcessConfiguration({
    ...paths.options,
    child: defaultTaskRoles,
  });
  return { ...paths, host };
}

export async function seed(directory: string, pending = false) {
  const f = legacyHost(directory);
  const store = await openSqliteStore(f.profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let parentCalls = 0;
  const parent: ModelAdapter = {
    async *stream(_request, { signal }) {
      if (parentCalls++ === 0) {
        for (const role of roleIds)
          yield call('spawn_agent', {
            prompt: `Original ${role} assignment.`,
            ...(role === 'worker' ? {} : { preset: role }),
          })[0]!;
        yield { ...finish, reason: 'tool_calls' };
      } else if (pending) {
        yield { type: 'text_delta', text: 'Original parent awaiting its collaborators.' };
        await new Promise<void>((resolve) =>
          signal.aborted
            ? resolve()
            : signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      } else yield finish;
    },
  };
  const child: ModelAdapter = {
    async *stream(_request, { signal }) {
      if (pending) {
        yield { type: 'text_delta', text: 'Original child checkpoint.' };
        await new Promise<void>((resolve) =>
          signal.aborted
            ? resolve()
            : signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      } else {
        yield { type: 'text_delta', text: 'Original child completed.' };
        yield finish;
      }
    },
  };
  const runtime = createRuntime({
    ...f.host,
    store,
    modelConcurrency: 8,
    maxConcurrentSubagents: 8,
    artifacts: createArtifactStore({ profile: f.profile, store }),
    permissions: f.host.permissions!,
    async resolveRunConfiguration(input) {
      return { ...(await f.host.resolveRunConfiguration!(input)), model: parent };
    },
    async resolveChildRunConfiguration(input) {
      return { ...(await f.host.resolveChildRunConfiguration!(input)), model: child };
    },
  });
  try {
    f.host.permissionManagement!(runtime);
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'history',
      rootUri: pathToFileURL(f.workspace).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'Original parent',
    });
    await initializeLivePermissionFixture({
      ...base,
      runtime,
      profile: f.profile,
      workspaceId: 'w',
      mode: 'full',
      trusted: true,
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Run the five original historical assignments.' },
    });
    const carriers = await until(async () => {
      const rows = (await store.listExecutions('s')).filter((row) => row.childSessionId);
      if (rows.length !== 5) return undefined;
      const views = await Promise.all(rows.map((row) => store.getView(row.childSessionId!)));
      return views.every((view) =>
        pending
          ? !view.runs.length || view.runs[0]!.isActive
          : view.runs.length === 1 && view.runs[0]!.status === 'completed',
      )
        ? rows
        : undefined;
    });
    if (!pending) {
      await runtime.waitForCommand('work', { timeoutMs: 10000 });
      await until(async () =>
        (await store.listExecutions('s'))
          .filter((row) => row.childSessionId)
          .every((row) => row.status === 'succeeded')
          ? true
          : undefined,
      );
    }
    const rootView = await store.getView('s');
    return { ...f, store, runtime, base, carriers, rootRun: rootView.runs[0]! };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

if (import.meta.main) {
  const directory = process.argv[2]!;
  const f = await seed(directory, true);
  writeFileSync(
    join(directory, 'ready.json'),
    JSON.stringify({
      expectedStoreId: f.base.expectedStoreId,
      runId: f.rootRun.id,
      expectedOwnerGeneration: (await f.store.getSession('s'))!.ownerGeneration,
    }),
  );
  await new Promise<void>(() => {});
}
