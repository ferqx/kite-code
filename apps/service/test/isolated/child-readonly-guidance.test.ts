import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { type ContextSource, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { expect, test } from '#kite-test';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { defaultTaskRoles } from '../../src/task-configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const sourceId = 'builtin.task:read-only-assignment';
const roles = ['general', 'explore'] as const;
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: object): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
const object = (value: Json | undefined) => value as Record<string, Json>;

async function scenario(recoverSource: boolean, legacyParent = false) {
  const root = temporaryDirectory('kite-child-readonly-guidance-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'fixture' });
  const workspace = join(root, 'workspace');
  privateDirectory(profile.profilePath);
  privateDirectory(workspace);
  writeFileSync(join(workspace, 'source.txt'), 'fixture source\n');
  const configPath = join(profile.profilePath, 'config.jsonc');
  const configuration = {
    modelId: 'original',
    models: ['original', 'later'].map((id) => ({
      id,
      provider: 'compatible',
      model: 'unused-controlled-model',
      baseURL: 'http://127.0.0.1:9/v1',
    })),
    tools: ['files.read', 'files.write', 'task.spawn'].map((id) => ({ id })),
  };
  writeFileSync(configPath, JSON.stringify(configuration));
  const hostOptions = {
    profile,
    userConfigurationPath: configPath,
    localCodex: false as const,
    browser: false as const,
    credentialBackend: createTemporaryCredentialBackend(),
  };
  const host = createDefaultProcessConfiguration({
    ...hostOptions,
    ...(legacyParent
      ? {
          permissions: {
            async authorize() {
              return { allowed: true, revision: 'fixture-original-parent-contract' };
            },
          },
        }
      : {}),
  });
  // Rebind a child with the current default host while retaining the actual
  // parent's legacy frozen contract. This isolates inheritance, not OS recovery.
  const childHost = legacyParent ? createDefaultProcessConfiguration(hostOptions) : host;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let cold: ReturnType<typeof createRuntime> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    const parents = new Map(
      roles.map((role) => [
        role,
        createFixedModel([
          call('spawn_agent', {
            prompt: 'Read source.txt and report the actual value.',
            ...(role === 'general' ? {} : { preset: role }),
          }),
          [finish],
        ]),
      ]),
    );
    const children = new Map(
      roles.map((role) => [
        role,
        createFixedModel([call('read_file', { path: 'source.txt' }), [finish]]),
      ]),
    );
    runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      artifacts: createArtifactStore({ profile, store }),
      async resolveRunConfiguration(input) {
        const binding = await host.resolveRunConfiguration!(input);
        return { ...binding, model: parents.get(input.session.id as (typeof roles)[number])! };
      },
      async resolveChildRunConfiguration(input) {
        const binding = await childHost.resolveChildRunConfiguration!(input);
        if (legacyParent)
          expect(
            (binding.toolBehaviors ?? []).some((behavior) => behavior.prepareReview !== undefined),
          ).toBe(false);
        return {
          ...binding,
          model: children.get(input.configurationId as (typeof roles)[number])!,
        };
      },
    });
    if (legacyParent) childHost.permissionManagement!(runtime);
    service = await startService({
      runtime,
      permissionManagement: host.permissionManagement!(runtime),
      subjectId: 'owner',
      buildId: 'child-readonly-guidance',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'sessions'],
      },
    });
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(workspace).href,
    });
    type RecoveryInput = Parameters<NonNullable<typeof host.resolveRecoveryRunConfiguration>>[0];
    let saved: RecoveryInput | undefined;
    let originalSource: ContextSource | undefined;
    for (const role of recoverSource || legacyParent ? (['explore'] as const) : roles) {
      await client.createSession({
        expectedStoreId: storeId,
        sessionId: role,
        workspaceId: 'w',
        commandId: `create-${role}`,
        title: role,
      });
      await initializeLivePermissionFixture({
        runtime,
        profile,
        expectedStoreId: storeId,
        subjectId: 'owner',
        sessionId: role,
        workspaceId: 'w',
        mode: 'full',
        trusted: true,
      });
      await client.startRun(role, {
        expectedStoreId: storeId,
        commandId: `work-${role}`,
        kind: 'run.start',
        content: 'Delegate the file read and report its result.',
      });
      await runtime.waitForCommand(`work-${role}`, { timeoutMs: 5000 });
      const deadline = Date.now() + 5000;
      let carrier: Awaited<ReturnType<typeof store.listExecutions>>[number] | undefined;
      for (;;) {
        carrier = (await store.listExecutions(role)).find(
          (e) => e.definitionId === `agent/${role}` && e.status === 'succeeded',
        );
        if (carrier?.childSessionId) break;
        if (Date.now() > deadline)
          throw Error(
            `child_guidance_deadline:${role}:${JSON.stringify((await store.listExecutions(role)).map((row) => ({ definition: row.definitionId, status: row.status, result: row.result })))}`,
          );
        await sleepTimer(5);
      }
      const readonly = role === 'explore';
      expect(parents.get(role)!.requests).toHaveLength(2);
      expect(children.get(role)!.requests).toHaveLength(2);
      for (const request of parents.get(role)!.requests)
        expect(request.messages.some((m) => m.sourceIds?.includes(sourceId))).toBe(false);
      for (const request of children.get(role)!.requests) {
        const messages = request.messages.filter((m) => m.sourceIds?.includes(sourceId));
        expect(messages).toHaveLength(readonly ? 1 : 0);
        if (readonly) {
          expect(messages[0]!.role).toBe('system');
          expect(messages[0]!.content).toContain('do not create, modify, or delete business files');
          expect(messages[0]!.content).toContain('unauthorized network connections');
          expect(messages[0]!.content).toContain(
            'Necessary exploration may create temporary scripts and temporary artifacts',
          );
          expect(messages[0]!.content).toContain(
            'Keep business source, configuration and data unchanged',
          );
          expect(messages[0]!.content).toContain(
            'not a separate approval mode or execution sandbox',
          );
          expect(messages[0]!.content).toContain(
            'including cat, command chains such as &&, and pipelines',
          );
          expect(messages[0]!.content).not.toContain('only one literal');
          expect(messages[0]!.content).toContain(
            `Role assignment: ${defaultTaskRoles.find((r) => r.id === role)!.description}`,
          );
        }
      }
      const executions = await store.listExecutions(carrier.childSessionId!);
      expect(
        executions.some((e) => e.definitionId === 'files.read' && e.status === 'succeeded'),
      ).toBe(true);
      const model = executions.find((e) => e.kind === 'model')!;
      const run = (await store.getRun(model.runId!))!;
      const manifest = object(run.configuration);
      const snapshot = object(object(manifest.snapshot).configuration);
      expect(snapshot.defaultAutoReview).toBe(legacyParent ? null : 'shell_risk');
      expect(Object.hasOwn(snapshot, 'readOnlyTaskSource')).toBe(readonly);
      if (role === 'explore') {
        originalSource = snapshot.readOnlyTaskSource as unknown as ContextSource;
        const parentCommand = (await store.getCommand(`work-${role}`))!;
        const parentRun = (await store.getRun((parentCommand.receipt as { runId: string }).runId))!;
        const hostSnapshot = structuredClone(object(object(parentRun.configuration).snapshot));
        hostSnapshot.readOnlyTaskSource = snapshot.readOnlyTaskSource!;
        object(object(hostSnapshot.planning).binding).readOnlyTask = true;
        saved = {
          // Isolate the host Source branch using the real root manifest and the real child Source.
          // Keep its original root catalogue/protocol; this does not simulate child Run recovery.
          run: {
            ...parentRun,
            configuration: { ...object(parentRun.configuration), snapshot: hostSnapshot },
          },
          command: parentCommand,
          session: (await store.getSession(role))!,
          workspace: (await store.getWorkspace('w'))!,
          signal: new AbortController().signal,
        };
      }
    }
    expect(saved).toBeDefined();
    if (!recoverSource) return;
    client.disposeNetwork();
    client = undefined;
    await service.close();
    service = undefined;
    runtime = undefined;
    store = undefined;
    writeFileSync(configPath, JSON.stringify({ ...configuration, modelId: 'later' }));
    const coldHost = createDefaultProcessConfiguration({
      ...hostOptions,
      child: defaultTaskRoles.map((role) => ({
        ...role,
        toolPolicy: 'parent',
        description: 'CHANGED CURRENT ROLE MUST NOT REPLACE THE ORIGINAL SOURCE',
      })),
    });
    store = await openSqliteStore({ ...profile, mode: 'readonly' });
    cold = createRuntime({ ...coldHost, store, permissions: coldHost.permissions! });
    coldHost.permissionManagement!(cold);
    const request = {
      sessionId: saved!.session.id,
      runId: saved!.run.id,
      workspaceId: 'w',
      definitionId: 'original',
      input: null,
    };
    // Test only host Source reassembly, not the separate outer child-role recovery envelope.
    const rebound = await coldHost.resolveRecoveryRunConfiguration!(saved!);
    try {
      expect(rebound.modelId).toBe('original');
      expect((await rebound.sources!.capture(request)).find((s) => s.id === sourceId)).toEqual(
        originalSource,
      );
      expect(
        (await rebound.sources!.captureBatch!([request, request])).filter((s) => s.id === sourceId),
      ).toEqual([originalSource!]);
      expect(JSON.stringify(rebound.snapshot)).not.toContain('CHANGED CURRENT ROLE');
    } finally {
      await rebound.dispose?.();
    }
    const old = { ...saved!, run: structuredClone(saved!.run) };
    delete object(object(old.run.configuration).snapshot).readOnlyTaskSource;
    const legacy = await coldHost.resolveRecoveryRunConfiguration!(old);
    try {
      expect((await legacy.sources!.capture(request)).some((s) => s.id === sourceId)).toBe(false);
    } finally {
      await legacy.dispose?.();
    }
    const damaged = { ...saved!, run: structuredClone(saved!.run) };
    object(object(object(damaged.run.configuration).snapshot).readOnlyTaskSource).content =
      'damaged';
    await expect(coldHost.resolveRecoveryRunConfiguration!(damaged)).rejects.toMatchObject({
      code: 'recovery_configuration_unavailable',
    });
  } finally {
    client?.disposeNetwork();
    if (service) await service.close();
    else if (runtime) await runtime.close();
    await cold?.close();
    if (!service && !runtime && !cold) await store?.close();
    removeTemporaryDirectory(root);
  }
}

test(
  'actual child requests receive semantic read-only guidance; root and ordinary children do not',
  () => scenario(false),
  20000,
);
test(
  'cold host Source recovery preserves original child guidance and rejects damaged source',
  () => scenario(true),
  20000,
);
test(
  'a current default child host preserves the actual legacy parent review contract',
  () => scenario(false, true),
  20000,
);
