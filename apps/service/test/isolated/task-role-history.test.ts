import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { defaultTaskRoles as originalRoles } from '../../../../tests/fixtures/subagent-role-history/8e350f99ed6651d2c5db82fca3430d5d0d27b01e/roles';
import {
  call,
  finish,
  object,
  revision,
  roleIds,
  seed,
  setup,
  until,
} from '../../../../tests/fixtures/subagent-role-history/8e350f99ed6651d2c5db82fca3430d5d0d27b01e/scenario';
import { createTaskConfiguration as originalTaskConfiguration } from '../../../../tests/fixtures/subagent-role-history/8e350f99ed6651d2c5db82fca3430d5d0d27b01e/task-configuration';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';

const fixture = new URL(
  `../../../../tests/fixtures/subagent-role-history/${revision}/`,
  import.meta.url,
);
const captured = JSON.parse(
  gunzipSync(readFileSync(new URL('service-configurations.json.gz', fixture))).toString('utf8'),
) as {
  producerRevision: string;
  configurations: { role: string; root: Json; child: Json; carrier: Json }[];
};
function serviceSnapshot(configuration: Json): Record<string, Json> {
  const snapshot = object(object(configuration).snapshot);
  return typeof snapshot.roleId === 'string' ? object(snapshot.configuration) : snapshot;
}

test('historical producer inputs and five real Service configurations are frozen at the original revision', () => {
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', fixture), 'utf8')) as {
    revision: string;
    sourceByteHashes: Record<string, string>;
  };
  expect(provenance.revision).toBe(revision);
  for (const [path, digest] of Object.entries(provenance.sourceByteHashes))
    expect(
      createHash('sha256')
        .update(readFileSync(new URL(path, fixture)))
        .digest('hex'),
    ).toBe(digest);
  expect(captured.producerRevision).toBe(revision);
  expect(captured.configurations.map((record) => record.role)).toEqual([...roleIds]);
  const original = originalTaskConfiguration(originalRoles);
  const catalogue = JSON.parse(readFileSync(new URL('task-catalogue.json', fixture), 'utf8'));
  expect(
    [...original.tools.values()].map(
      ({ id, version, description, inputSchema, model, recovery }) => ({
        id,
        version,
        description,
        inputSchema,
        model,
        recovery,
      }),
    ),
  ).toEqual(catalogue.tools);
  for (const record of captured.configurations) {
    expect(object(serviceSnapshot(record.root).task).roles).toEqual(original.snapshot.roles);
    expect(object(object(record.child).snapshot).roleId).toBe(record.role);
    expect(object(record.carrier).id).toBe(record.role);
  }
});

type ChildInput = Parameters<
  NonNullable<ReturnType<typeof createDefaultProcessConfiguration>['resolveChildRunConfiguration']>
>[0];
async function currentRuntime(
  directory: string,
  parent: ModelAdapter,
  child: ModelAdapter,
  prepareChild?: (input: ChildInput) => ChildInput,
) {
  const paths = setup(directory);
  const host = createDefaultProcessConfiguration(paths.options);
  const store = await openSqliteStore(paths.profile);
  const childInputs: Parameters<NonNullable<typeof host.resolveChildRunConfiguration>>[0][] = [];
  const runtime = createRuntime({
    ...host,
    store,
    modelConcurrency: 8,
    maxConcurrentSubagents: 8,
    permissions: host.permissions!,
    artifacts: createArtifactStore({ profile: paths.profile, store }),
    async resolveRunConfiguration(input) {
      return { ...(await host.resolveRunConfiguration!(input)), model: parent };
    },
    async resolveRecoveryRunConfiguration(input) {
      return { ...(await host.resolveRecoveryRunConfiguration!(input)), model: parent };
    },
    async resolveChildRunConfiguration(input) {
      childInputs.push(input);
      return {
        ...(await host.resolveChildRunConfiguration!(prepareChild?.(input) ?? input)),
        model: child,
      };
    },
  });
  host.permissionManagement!(runtime);
  return { ...paths, host, store, runtime, childInputs };
}

test('a current parent follows up all five historical collaborators without renaming or widening old explore', async () => {
  const directory = temporaryDirectory('kite-task-role-history-idle-');
  let old: Awaited<ReturnType<typeof seed>> | undefined;
  let current: Awaited<ReturnType<typeof currentRuntime>> | undefined;
  try {
    old = await seed(directory);
    const original = await Promise.all(
      old.carriers.map(async (carrier) => ({
        carrier,
        view: await old!.store.getView(carrier.childSessionId!),
      })),
    );
    const ids = original.map(({ carrier }) => carrier.childSessionId!);
    const originalRoot = old.rootRun.configuration;
    for (const record of original) {
      const historical = captured.configurations.find(
        (item) => item.role === record.carrier.childConfiguration!.id,
      )!;
      expect(serviceSnapshot(record.view.runs[0]!.configuration).task).toEqual(
        serviceSnapshot(historical.child).task,
      );
      expect(object(object(record.view.runs[0]!.configuration).snapshot).roleToolIds).toEqual(
        object(object(historical.child).snapshot).roleToolIds,
      );
    }
    await old.runtime.close();
    old = undefined;
    let parentTurns = 0;
    const childTools: string[][] = [];
    current = await currentRuntime(
      directory,
      {
        async *stream(request) {
          const spawn = request.tools.find((tool) => tool.id === 'spawn_agent')!;
          expect(object(object(spawn.inputSchema.properties).preset).enum).toEqual([
            'general',
            'explore',
          ]);
          if (parentTurns++ === 0) {
            for (const id of ids)
              yield call('follow_up_agent', {
                agent_id: id,
                content: 'Read source.txt and report the actual historical task result.',
              })[0]!;
            yield { ...finish, reason: 'tool_calls' };
          } else yield finish;
        },
      },
      {
        async *stream(request) {
          childTools.push(request.tools.map((tool) => tool.id));
          if (request.messages.some((message) => message.role === 'tool')) {
            yield { type: 'text_delta', text: 'Continued original assignment.' };
            yield finish;
          } else yield* call('read_file', { path: 'source.txt' });
        },
      },
    );
    const expectedStoreId = (await current.store.getMetadata()).storeId;
    await current.runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'follow-all',
      request: { kind: 'run.start', content: 'Continue each original collaborator once.' },
    });
    await current.runtime.waitForCommand('follow-all', { timeoutMs: 10000 });
    const failedFollowUps = (await current.store.listExecutions('s'))
      .filter((row) => row.definitionId === 'task.follow_up' && row.status === 'failed')
      .map((row) => ({ id: row.id, result: row.result }));
    expect(failedFollowUps).toEqual([]);
    try {
      await until(async () => {
        const views = await Promise.all(ids.map((id) => current!.store.getView(id)));
        return views.every(
          (view) => view.runs.length === 2 && view.runs.every((run) => run.status === 'completed'),
        )
          ? true
          : undefined;
      });
    } catch (cause) {
      throw Error(
        JSON.stringify(
          (await current.store.listExecutions('s'))
            .filter((row) => row.kind === 'tool')
            .map((row) => ({
              definition: row.definitionId,
              status: row.status,
              diagnostic:
                row.result &&
                object(row.result).details &&
                object(object(row.result).details).diagnostic,
            })),
        ),
        { cause },
      );
    }
    expect(childTools).toHaveLength(10);
    expect(current.childInputs).toHaveLength(5);
    for (const record of original) {
      const view = await current.store.getView(record.carrier.childSessionId!);
      expect(view.runs[0]!.configuration).toEqual(record.view.runs[0]!.configuration);
      const next = view.runs[1]!;
      expect(object(object(next.configuration).snapshot).roleId).toBe(
        record.carrier.childConfiguration!.id,
      );
      expect(object(object(next.configuration).snapshot).roleToolIds).toEqual(
        object(object(record.view.runs[0]!.configuration).snapshot).roleToolIds,
      );
      expect(
        view.executions.filter(
          (row) =>
            row.runId === next.id &&
            row.definitionId === 'files.read' &&
            row.status === 'succeeded',
        ),
      ).toHaveLength(1);
      if (record.carrier.childConfiguration!.id === 'explore') {
        expect(object(next.configuration).tools).toEqual(
          object(record.view.runs[0]!.configuration).tools,
        );
        expect(object(serviceSnapshot(next.configuration).task).roles).toEqual(
          object(serviceSnapshot(record.view.runs[0]!.configuration).task).roles,
        );
      }
    }
    expect((await current.store.getView('s')).runs[0]!.configuration).toEqual(originalRoot);
    expect(
      (await current.store.listExecutions('s')).filter((row) => row.childSessionId),
    ).toHaveLength(10);
  } finally {
    await old?.runtime.close();
    await current?.runtime.close();
    removeTemporaryDirectory(directory);
  }
}, 30000);

test('removing files.read from the current parent refuses an old explore follow-up before new child work', async () => {
  const directory = temporaryDirectory('kite-task-role-history-narrow-');
  let old: Awaited<ReturnType<typeof seed>> | undefined;
  let current: Awaited<ReturnType<typeof currentRuntime>> | undefined;
  try {
    old = await seed(directory);
    const carrier = old.carriers.find((row) => row.childConfiguration!.id === 'explore')!;
    const original = await old.store.getView(carrier.childSessionId!);
    await old.runtime.close();
    old = undefined;
    let parentCalls = 0;
    let childCalls = 0;
    current = await currentRuntime(
      directory,
      {
        async *stream() {
          if (parentCalls++ === 0)
            yield* call('follow_up_agent', {
              agent_id: carrier.childSessionId!,
              content: 'Read the original file once more.',
            });
          else yield finish;
        },
      },
      {
        async *stream() {
          childCalls++;
          yield finish;
        },
      },
    );
    const configuration = JSON.parse(readFileSync(current.options.userConfigurationPath, 'utf8'));
    configuration.tools = configuration.tools.filter(
      (tool: { id: string }) => tool.id !== 'files.read',
    );
    writeFileSync(current.options.userConfigurationPath, JSON.stringify(configuration));
    const expectedStoreId = (await current.store.getMetadata()).storeId;
    await current.runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'narrow-follow',
      request: {
        kind: 'run.start',
        content: 'Continue the old explorer with the current narrower parent selection.',
      },
    });
    await current.runtime.waitForCommand('narrow-follow', { timeoutMs: 10000 });
    const tool = (await current.store.listExecutions('s')).find(
      (row) => row.definitionId === 'task.follow_up',
    )!;
    expect(tool.status).toBe('failed');
    expect(tool.result).toMatchObject({
      details: { accepted: false, error: { code: 'preparation_failed' } },
    });
    expect(childCalls).toBe(0);
    expect((await current.store.getView(carrier.childSessionId!)).runs).toEqual(original.runs);
    expect((await current.store.getView(carrier.childSessionId!)).executions).toEqual(
      original.executions,
    );
    expect((await current.store.getExecution(carrier.id))!.result).toEqual(carrier.result);
    expect(
      (await current.store.listExecutions('s')).filter((row) => row.childSessionId),
    ).toHaveLength(5);
  } finally {
    await old?.runtime.close();
    await current?.runtime.close();
    removeTemporaryDirectory(directory);
  }
}, 30000);

test('default Service recovery preparation rejects unknown historical task roles and versions without dispatch', async () => {
  const directory = temporaryDirectory('kite-task-role-history-invalid-catalogue-');
  let old: Awaited<ReturnType<typeof seed>> | undefined;
  let current: Awaited<ReturnType<typeof currentRuntime>> | undefined;
  try {
    old = await seed(directory);
    const run = old.rootRun;
    const command = (await old.store.getCommand('work'))!;
    const session = (await old.store.getSession('s'))!;
    const workspace = (await old.store.getWorkspace('w'))!;
    await old.runtime.close();
    old = undefined;
    let modelCalls = 0;
    const never: ModelAdapter = {
      async *stream() {
        modelCalls++;
        yield finish;
      },
    };
    current = await currentRuntime(directory, never, never);
    const cursor = (await current.store.getMetadata()).lastChangeCursor;
    for (const mutation of ['role', 'version'] as const) {
      const damaged = structuredClone(run);
      const roles = object(object(object(damaged.configuration).snapshot).task).roles as Record<
        string,
        Json
      >[];
      if (mutation === 'role') {
        roles[0]!.id = 'unknown-historical-role';
        roles[0]!.configurationId = 'unknown-historical-role';
      } else roles[0]!.configurationVersion = 'unknown-version';
      // This invokes only the trusted Service preparation hook. It does not claim Store/CAS qualification.
      await expect(
        current.host.resolveRecoveryRunConfiguration!({
          command,
          run: damaged,
          session,
          workspace,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'recovery_configuration_unavailable' });
    }
    expect(modelCalls).toBe(0);
    expect((await current.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await current.store.getRun(run.id))!.configuration).toEqual(run.configuration);
  } finally {
    await old?.runtime.close();
    await current?.runtime.close();
    removeTemporaryDirectory(directory);
  }
}, 30000);

test('damaged historical child Source is rejected by default Service preparation without altering saved work', async () => {
  const directory = temporaryDirectory('kite-task-role-history-invalid-source-');
  let old: Awaited<ReturnType<typeof seed>> | undefined;
  let current: Awaited<ReturnType<typeof currentRuntime>> | undefined;
  try {
    old = await seed(directory);
    const carrier = old.carriers.find((row) => row.childConfiguration!.id === 'explore')!;
    const original = await old.store.getView(carrier.childSessionId!);
    await old.runtime.close();
    old = undefined;
    let parentCalls = 0;
    let childCalls = 0;
    let preparations = 0;
    current = await currentRuntime(
      directory,
      {
        async *stream() {
          if (parentCalls++ === 0)
            yield* call('follow_up_agent', {
              agent_id: carrier.childSessionId!,
              content: 'Continue the original exploration.',
            });
          else yield finish;
        },
      },
      {
        async *stream() {
          childCalls++;
          yield finish;
        },
      },
      (input) => {
        // Core supplies the real persisted carrier first; corruption is confined to this trusted test hook.
        expect(input.originalConfiguration).toBeDefined();
        const originalConfiguration = structuredClone(input.originalConfiguration!);
        const envelope = object(object(originalConfiguration.snapshot).snapshot);
        object(object(envelope.configuration).readOnlyTaskSource).content =
          'Changed historical source without its original digest.';
        preparations++;
        return { ...input, originalConfiguration };
      },
    );
    const expectedStoreId = (await current.store.getMetadata()).storeId;
    await current.runtime.submitCommand({
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'damaged-follow',
      request: {
        kind: 'run.start',
        content: 'Continue the collaborator with its original configuration.',
      },
    });
    await current.runtime.waitForCommand('damaged-follow', { timeoutMs: 10000 });
    const tool = (await current.store.listExecutions('s')).find(
      (row) => row.definitionId === 'task.follow_up',
    )!;
    expect(preparations).toBe(1);
    expect(tool.result).toMatchObject({
      details: { accepted: false, diagnostic: { code: 'recovery_configuration_unavailable' } },
    });
    expect(childCalls).toBe(0);
    expect((await current.store.getView(carrier.childSessionId!)).runs).toEqual(original.runs);
    expect((await current.store.getView(carrier.childSessionId!)).executions).toEqual(
      original.executions,
    );
    expect((await current.store.getExecution(carrier.id))!.childConfiguration).toEqual(
      carrier.childConfiguration,
    );
    expect(
      (await current.store.listExecutions('s')).filter((row) => row.childSessionId),
    ).toHaveLength(5);
  } finally {
    await old?.runtime.close();
    await current?.runtime.close();
    removeTemporaryDirectory(directory);
  }
}, 30000);

test('SIGKILL recovery restores the original root catalogue and historical child carriers exactly once', async () => {
  const directory = temporaryDirectory('kite-task-role-history-cold-');
  const childProcess = Bun.spawn(
    [process.execPath, fileURLToPath(new URL('scenario.ts', fixture)), directory],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let current: Awaited<ReturnType<typeof currentRuntime>> | undefined;
  try {
    await until(async () => (existsSync(join(directory, 'ready.json')) ? true : undefined));
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
      expectedStoreId: string;
      runId: string;
      expectedOwnerGeneration: string;
    };
    childProcess.kill('SIGKILL');
    await childProcess.exited;
    const paths = setup(directory);
    const readonly = await openSqliteStore({ ...paths.profile, mode: 'readonly' });
    const before = await readonly.getView('s');
    const carriers = before.executions.filter((row) => row.childSessionId);
    const originalChildren = await Promise.all(
      carriers.map(async (carrier) => ({
        carrier,
        view: await readonly.getView(carrier.childSessionId!),
      })),
    );
    const cursor = (await readonly.getMetadata()).lastChangeCursor;
    expect(carriers).toHaveLength(5);
    expect((await readonly.getMetadata()).lastChangeCursor).toBe(cursor);
    await readonly.close();
    let rootCalls = 0;
    let childCalls = 0;
    current = await currentRuntime(
      directory,
      {
        async *stream(request) {
          rootCalls++;
          const spawn = request.tools.find((tool) => tool.id === 'spawn_agent')!;
          expect(object(object(spawn.inputSchema.properties).preset).enum).toEqual([
            'code',
            'explore',
            'plan',
            'review',
          ]);
          yield { type: 'text_delta', text: 'Original parent recovered.' };
          yield finish;
        },
      },
      {
        async *stream() {
          childCalls++;
          yield { type: 'text_delta', text: 'Original child recovered.' };
          yield finish;
        },
      },
    );
    const input = { ...ready, commandId: 'resume-original', sessionId: 's', subjectId: 'owner' };
    const receipt = await current.runtime.resumeRun(input);
    expect(receipt.receipt).toMatchObject({ outcome: 'run_resumed', runId: ready.runId });
    await until(async () => {
      const rows = (await current!.store.listExecutions('s')).filter((row) => row.childSessionId);
      return rows.length === 5 && rows.every((row) => row.status === 'succeeded')
        ? true
        : undefined;
    });
    expect(childCalls).toBe(5);
    await until(async () =>
      (await current!.store.getRun(ready.runId))!.status === 'completed' ? true : undefined,
    );
    expect(rootCalls).toBeGreaterThan(0);
    expect((await current.store.getRun(ready.runId))!.configuration).toEqual(
      before.runs[0]!.configuration,
    );
    for (const record of originalChildren) {
      expect((await current.store.getExecution(record.carrier.id))!.childConfiguration).toEqual(
        record.carrier.childConfiguration,
      );
      const view = await current.store.getView(record.carrier.childSessionId!);
      expect(view.runs).toHaveLength(1);
      if (record.view.runs.length)
        expect(view.runs[0]!.configuration).toEqual(record.view.runs[0]!.configuration);
    }
    expect(await current.runtime.resumeRun(input)).toEqual(receipt);
    expect(childCalls).toBe(5);
  } finally {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL');
      await childProcess.exited;
    }
    await current?.runtime.close();
    removeTemporaryDirectory(directory);
  }
}, 30000);
