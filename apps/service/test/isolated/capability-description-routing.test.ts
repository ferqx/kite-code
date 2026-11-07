import { expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AuthorizationRequest } from '@kite-ai/agent/extensions';
import type { CapabilityDescription } from '@kite-ai/agent/permissions';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';

// Factory instrumentation stays in a separate process. Only request metadata is
// queried; no Shell, Browser, Web or MCP effect is dispatched.
async function scenario(kind: string) {
  let resolvedBinding: import('@kite-ai/agent').RunConfiguration | undefined;
  let owner: 'none' | 'shell' | 'files' | 'task' = 'none';
  const calls: string[] = [];
  const fileChain: string[] = [];
  const fallback: string[] = [];
  let shellIdentity:
    | Partial<Pick<CapabilityDescription, 'kind' | 'definitionId' | 'definitionVersion'>>
    | undefined;
  const hit = (actual: typeof owner, request: AuthorizationRequest) => {
    if (owner !== actual)
      throw Error(`foreign_descriptor:${actual}:${request.kind}:${request.definitionId}`);
    calls.push(actual);
  };
  const permissions = await import('@kite-ai/agent/permissions');
  const createPolicy = permissions.createPermissionPolicy;
  const createBusiness = permissions.createBusinessPermissionPolicy;
  let ordinary: Parameters<typeof createPolicy>[0]['describeCapability'] | undefined;
  let businessGate: Parameters<typeof createBusiness>[0]['gate'] | undefined;
  let plannedDescription: CapabilityDescription | null | undefined;
  const planning = async (request: AuthorizationRequest): Promise<CapabilityDescription | null> => {
    plannedDescription = undefined;
    await businessGate!(request);
    return (plannedDescription as CapabilityDescription | null | undefined) ?? null;
  };
  const planningModule = await import('@kite-ai/agent/planning');
  const createPlanning = planningModule.createPlanningValidation;
  mock.module('@kite-ai/agent/planning', () => ({
    ...planningModule,
    createPlanningValidation(...args: Parameters<typeof planningModule.createPlanningValidation>) {
      const actual = createPlanning(...args);
      return {
        ...actual,
        permissionGate(input: Parameters<typeof actual.permissionGate>[0]) {
          plannedDescription = input.capability as CapabilityDescription | null;
          return actual.permissionGate(input);
        },
      };
    },
  }));
  const planningConfiguration = await import('../../src/planning-configuration');
  mock.module('../../src/planning-configuration', () => ({
    ...planningConfiguration,
    // Metadata probes deliberately use one actual Model ID for differently shaped requests.
    // Bypass only this causal read, never dispatch; observe the actual gate's owner descriptor.
    readPlanningPermissionState: async () => ({ status: 'disabled' as const }),
  }));
  mock.module('@kite-ai/agent/permissions', () => ({
    ...permissions,
    createPermissionPolicy(input: Parameters<typeof createPolicy>[0]) {
      if (input.readCheckContext) ordinary = input.describeCapability;
      return createPolicy(input);
    },
    createBusinessPermissionPolicy(input: Parameters<typeof createBusiness>[0]) {
      businessGate = input.gate;
      return createBusiness(input);
    },
  }));
  const shellModule = await import('@kite-ai/agent/permissions/shell');
  const { createShellExtension } = await import('@kite-ai/agent/shell');
  const forbiddenShellEffect = () => {
    throw Error('shell_dispatch_forbidden_in_routing_fixture');
  };
  const shellExtension = createShellExtension({
    job: {
      id: 'shell.command',
      version: '1',
      description: 'Metadata-only fixture; never dispatched.',
      inputSchema: { type: 'object' },
      start: forbiddenShellEffect,
      observe: forbiddenShellEffect,
      cancel: forbiddenShellEffect,
      dispose: forbiddenShellEffect,
    },
  });
  mock.module('@kite-ai/agent/permissions/shell', () => ({
    ...shellModule,
    async createShellConfiguration() {
      return {
        extensions: [shellExtension],
        snapshot: { available: true, tools: [{ id: 'shell.execute', definitionVersion: '1' }] },
        describe: () => ({ effects: ['process', 'unknown'], safeRead: false }),
        async describeRequest(request: AuthorizationRequest) {
          hit('shell', request);
          return { effects: ['read'], safeRead: true, hardAllowed: true, ...shellIdentity };
        },
        commandDigest(request: AuthorizationRequest) {
          hit('shell', request);
          return 'a'.repeat(64);
        },
        async prepareRiskReview() {
          throw Error('review_preparation_forbidden_in_metadata_fixture');
        },
      };
    },
  }));
  const fileModule = await import('@kite-ai/agent/files');
  const { withSessionOutputs, withPlanFileTools, withInputFileReads, withExternalFileReads } =
    fileModule;
  function observeFileChain<
    T extends {
      describeRequest(request: AuthorizationRequest): Promise<CapabilityDescription | null>;
    },
  >(name: string, adapter: T): T {
    return {
      ...adapter,
      async describeRequest(request: AuthorizationRequest) {
        fileChain.push(name);
        return adapter.describeRequest(request);
      },
    };
  }
  mock.module('@kite-ai/agent/files', () => ({
    ...fileModule,
    withSessionOutputs: (...args: Parameters<typeof withSessionOutputs>) =>
      observeFileChain('outputs', withSessionOutputs(...args)),
    withPlanFileTools: (...args: Parameters<typeof withPlanFileTools>) =>
      observeFileChain('plan', withPlanFileTools(...args)),
    withInputFileReads: (...args: Parameters<typeof withInputFileReads>) =>
      observeFileChain('inputs', withInputFileReads(...args)),
    withExternalFileReads: (...args: Parameters<typeof withExternalFileReads>) =>
      observeFileChain('external', withExternalFileReads(...args)),
  }));
  const checkpointModule = await import('../../src/file-checkpoint-configuration');
  const createFiles = checkpointModule.createDefaultFileCheckpointConfiguration;
  let readVersion = '';
  mock.module('../../src/file-checkpoint-configuration', () => ({
    ...checkpointModule,
    createDefaultFileCheckpointConfiguration(input: Parameters<typeof createFiles>[0]) {
      const files = createFiles(input);
      readVersion = files.tools.find((tool) => tool.id === 'files.read')!.version;
      return {
        ...files,
        async describeRequest(request: AuthorizationRequest) {
          hit('files', request);
          return files.describeRequest(request);
        },
      };
    },
  }));
  const taskModule = await import('@kite-ai/agent/task');
  const createTaskClassifier = taskModule.createDefaultTaskRequestClassifier;
  mock.module('@kite-ai/agent/task', () => ({
    ...taskModule,
    createDefaultTaskRequestClassifier(input: Parameters<typeof createTaskClassifier>[0]) {
      const describe = createTaskClassifier(input);
      return (request: AuthorizationRequest) => {
        hit('task', request);
        return describe(request);
      };
    },
  }));
  const mcpModule = await import('../../src/mcp-configuration');
  const sourceModule = await import('../../src/mcp-source-configuration');
  const createMcp = mcpModule.createMcpConfiguration;
  const createSources = sourceModule.createMcpSourceConfiguration;
  const remote = (request: AuthorizationRequest, revision: string): CapabilityDescription => ({
    kind: request.kind,
    definitionId: request.definitionId,
    definitionVersion: request.definitionVersion,
    revision,
    effects: ['unknown'],
    hardAllowed: true,
    safeRead: false,
  });
  mock.module('../../src/mcp-configuration', () => ({
    ...mcpModule,
    createMcpConfiguration(input: Parameters<typeof createMcp>[0]) {
      const mcp = createMcp(input);
      return {
        ...mcp,
        select(...args: Parameters<typeof mcp.select>) {
          const selected = mcp.select(...args);
          return {
            ...selected,
            describe(request: AuthorizationRequest) {
              fallback.push('selected');
              return request.definitionId === 'routing.remote'
                ? remote(request, 'selected-remote')
                : selected.describe(request);
            },
          };
        },
      };
    },
  }));
  mock.module('../../src/mcp-source-configuration', () => ({
    ...sourceModule,
    createMcpSourceConfiguration(input: Parameters<typeof createSources>[0]) {
      const sources = createSources(input);
      return {
        ...sources,
        describe(request: AuthorizationRequest) {
          fallback.push('sources');
          return request.definitionId === 'routing.source'
            ? remote(request, 'source-first')
            : sources.describe(request);
        },
      };
    },
  }));
  const [agent, ai, configuration, profileModule, sqlite, artifacts, credentials, fixture] =
    await Promise.all([
      import('@kite-ai/agent'),
      import('@kite-ai/ai'),
      import('../../src/configuration'),
      import('@kite-ai/agent/profile'),
      import('@kite-ai/agent/sqlite'),
      import('@kite-ai/agent/artifacts'),
      import('@kite-ai/agent/config'),
      import('../fixtures/live-permission-fixture'),
    ]);
  const root = temporaryDirectory('kite-capability-routing-');
  let runtime: ReturnType<typeof agent.createRuntime> | undefined;
  let store: Awaited<ReturnType<typeof sqlite.openSqliteStore>> | undefined;
  try {
    const workspace = join(root, 'workspace');
    privateDirectory(workspace);
    const profile = profileModule.selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    privateDirectory(profile.profilePath);
    const user = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      user,
      JSON.stringify({
        modelId: 'shell.execute',
        models: [
          {
            id: 'shell.execute',
            provider: 'compatible',
            model: 'unused',
            baseURL: 'http://127.0.0.1:9/v1',
          },
        ],
        tools: ['files.read', 'shell.execute', 'task.spawn', 'browser.snapshot', 'web_fetch'].map(
          (id) => ({ id }),
        ),
      }),
    );
    const host = configuration.createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: user,
      localCodex: false,
      credentialBackend: credentials.createTemporaryCredentialBackend(),
      browser: false,
      webFetch: {
        network: {
          policy: { mode: 'off' },
          async admitHop() {
            throw Error('network_forbidden_in_routing_fixture');
          },
        },
      },
      ...(kind === 'custom-checker'
        ? {
            authorizationCheck: {
              id: 'custom',
              version: 'fixture',
              modelId: 'custom-model',
              model: { stream: forbiddenShellEffect },
            },
          }
        : {}),
    });
    store = await sqlite.openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const model = ai.createFixedModel([
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]);
    runtime = agent.createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      artifacts: artifacts.createArtifactStore({ profile, store }),
      async resolveRunConfiguration(input) {
        resolvedBinding = await host.resolveRunConfiguration!(input);
        return { ...resolvedBinding, model };
      },
    });
    host.permissionManagement!(runtime);
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      subjectId: 'owner',
      workspaceId: 'w',
      title: 'Routing',
    });
    await fixture.initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      workspaceId: 'w',
      mode: 'full',
      trusted: true,
    });
    await runtime.submitCommand({
      expectedStoreId,
      commandId: 'work',
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Answer without effects.' },
    });
    await runtime.waitForCommand('work');
    expect(model.requests).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(fallback).toEqual([]);
    expect(ordinary).toBeFunction();
    expect(planning).toBeFunction();
    const modelExecution = (await store.listExecutions('s')).find((row) => row.kind === 'model')!;
    expect(modelExecution.status).toBe('succeeded');
    const request = (
      definitionId: string,
      requestKind: AuthorizationRequest['kind'] = 'tool',
      definitionVersion = '1',
    ): AuthorizationRequest => ({
      sessionId: 's',
      runId: modelExecution.runId!,
      executionId: modelExecution.id,
      kind: requestKind,
      definitionId,
      definitionVersion,
      input: {},
      signal: new AbortController().signal,
    });
    if (kind === 'review-contract' || kind === 'custom-checker') {
      const enabled = kind === 'review-contract';
      const snapshot = resolvedBinding!.snapshot as Record<
        string,
        import('@kite-ai/agent/extensions').Json
      >;
      expect(snapshot.defaultAutoReview).toBe(enabled ? 'shell_risk' : null);
      expect(snapshot.defaultAutoReviewDigest).toBe(
        enabled ? permissions.shellRiskReviewContractDigest : undefined,
      );
      const shellBehavior = resolvedBinding!.toolBehaviors!.find(
        (behavior) =>
          behavior.capability.kind === 'tool' &&
          behavior.capability.definitionId === 'shell.execute',
      )!;
      expect(typeof shellBehavior.prepareReview).toBe(enabled ? 'function' : 'undefined');
      expect(typeof shellBehavior.interpretReview).toBe(enabled ? 'function' : 'undefined');
      expect(shellBehavior.grantSatisfiesDefaultCheck).toBe(enabled ? true : undefined);
      expect(typeof shellBehavior.grantOffers).toBe('function');
      owner = 'shell';
      expect(
        (await ordinary!({ ...request('shell.execute'), input: { key: 'query', command: 'pwd' } }))
          ?.autoReview,
      ).toBe(enabled ? 'check' : undefined);
      owner = 'files';
      expect(
        (
          await ordinary!({
            ...request('files.read', 'tool', readVersion),
            input: { path: 'local.txt' },
          })
        )?.autoReview,
      ).toBe(enabled ? 'none' : undefined);
      owner = 'none';
      expect((await ordinary!(request('routing.remote')))?.autoReview).toBeUndefined();
      expect(await ordinary!(request('shell.execute', 'tool', 'future'))).toBeNull();
      if (enabled) {
        const command = (await store.getCommand('work'))!;
        const run = (await store.getRun(modelExecution.runId!))!;
        const recovery = {
          command,
          run,
          session: (await store.getSession('s'))!,
          workspace: (await store.getWorkspace('w'))!,
          signal: new AbortController().signal,
        };
        const rebound = await host.resolveRecoveryRunConfiguration!(recovery);
        try {
          expect((rebound.snapshot as Record<string, unknown>).defaultAutoReview).toBe(
            'shell_risk',
          );
          expect(rebound.authorizationCheck?.version).toBe(
            resolvedBinding!.authorizationCheck!.version,
          );
          expect(
            rebound.toolBehaviors!.find(
              (behavior) => behavior.capability.definitionId === 'shell.execute',
            )?.prepareReview,
          ).toBeFunction();
        } finally {
          await rebound.dispose?.();
        }
        const oldRun = structuredClone(run);
        delete (
          (oldRun.configuration as Record<string, import('@kite-ai/agent/extensions').Json>)
            .snapshot as Record<string, import('@kite-ai/agent/extensions').Json>
        ).defaultAutoReview;
        delete (
          (oldRun.configuration as Record<string, import('@kite-ai/agent/extensions').Json>)
            .snapshot as Record<string, import('@kite-ai/agent/extensions').Json>
        ).defaultAutoReviewDigest;
        await expect(
          host.resolveRecoveryRunConfiguration!({ ...recovery, run: oldRun }),
        ).rejects.toMatchObject({ code: 'recovery_configuration_unavailable' });
        const damaged = structuredClone(run);
        (
          (damaged.configuration as Record<string, import('@kite-ai/agent/extensions').Json>)
            .snapshot as Record<string, import('@kite-ai/agent/extensions').Json>
        ).defaultAutoReview = 'unknown-contract';
        await expect(
          host.resolveRecoveryRunConfiguration!({ ...recovery, run: damaged }),
        ).rejects.toMatchObject({ code: 'recovery_configuration_unavailable' });
        const mismatched = structuredClone(run);
        (
          (mismatched.configuration as Record<string, import('@kite-ai/agent/extensions').Json>)
            .snapshot as Record<string, import('@kite-ai/agent/extensions').Json>
        ).defaultAutoReviewDigest = '0'.repeat(64);
        await expect(
          host.resolveRecoveryRunConfiguration!({ ...recovery, run: mismatched }),
        ).rejects.toMatchObject({ code: 'recovery_configuration_changed' });
        const incomplete = structuredClone(run);
        delete (
          (incomplete.configuration as Record<string, import('@kite-ai/agent/extensions').Json>)
            .snapshot as Record<string, import('@kite-ai/agent/extensions').Json>
        ).defaultAutoReview;
        await expect(
          host.resolveRecoveryRunConfiguration!({ ...recovery, run: incomplete }),
        ).rejects.toMatchObject({ code: 'recovery_configuration_unavailable' });
      }
    } else if (kind === 'owners') {
      for (const describe of [ordinary!, planning!]) {
        owner = 'none';
        calls.length = 0;
        expect(await describe(request('shell.execute', 'model'))).toMatchObject({
          kind: 'model',
          effects: ['network'],
          revision: 'compatible-model-1',
        });
        expect(calls).toEqual([]);
        owner = 'shell';
        const shell = await describe({
          ...request('shell.execute'),
          input: { key: 'query', command: 'pwd' },
        });
        expect(shell).toMatchObject({
          effects: ['read'],
          safeRead: true,
          commandDigest: 'a'.repeat(64),
        });
        expect(calls).toEqual(['shell', 'shell']);
        for (const mismatch of [
          { kind: 'model' as const },
          { definitionId: 'different-capability' },
          { definitionVersion: 'future' },
        ]) {
          shellIdentity = mismatch;
          await expect(describe(request('shell.execute'))).rejects.toMatchObject({
            code: 'capability_metadata_invalid',
          });
        }
        shellIdentity = undefined;
        owner = 'none';
        calls.length = 0;
        expect(await describe(request('shell.execute', 'tool', 'future'))).toBeNull();
        expect(await describe(request('files.read', 'model'))).toBeNull();
        expect(calls).toEqual([]);
      }
    } else if (kind === 'task-and-static') {
      for (const task of [request('task.spawn'), request('agent/explore', 'job')]) {
        owner = 'task';
        calls.length = 0;
        const normal = await ordinary!(task);
        expect(normal).toMatchObject({ effects: ['record_write'], internalRecordOnly: true });
        expect(calls).toEqual(['task']);
        owner = 'none';
        calls.length = 0;
        const planned = await planning!(task);
        expect(planned?.internalRecordOnly).toBeUndefined();
        expect(planned?.effects).not.toEqual(['record_write']);
        expect(calls).toEqual([]);
      }
      owner = 'none';
      for (const describe of [ordinary!, planning!]) {
        expect(await describe(request('browser.snapshot'))).toMatchObject({
          hardAllowed: false,
          safeRead: true,
          effects: ['read'],
          approvalExempt: 'builtin.browser',
        });
        expect(await describe(request('web_fetch'))).toMatchObject({
          hardAllowed: false,
          effects: ['network', 'unknown'],
          revision: 'builtin.web:1',
        });
      }
      expect(calls).toEqual([]);
    } else {
      const external = join(root, 'external.txt');
      writeFileSync(external, 'Owned external input.');
      for (const describe of [ordinary!, planning!]) {
        owner = 'files';
        calls.length = 0;
        fileChain.length = 0;
        expect(
          await describe({
            ...request('files.read', 'tool', readVersion),
            input: { path: 'local.txt' },
          }),
        ).toMatchObject({ safeRead: true, effects: ['read'] });
        expect(calls).toEqual(['files']);
        expect(fileChain).toEqual(['outputs', 'plan', 'inputs', 'external']);
        expect(
          await describe({
            ...request('files.read', 'tool', readVersion),
            input: { path: external },
          }),
        ).toMatchObject({
          revision: 'builtin.files:external-read',
          safeRead: true,
          hardAllowed: true,
        });
        expect(
          await describe({
            ...request('files.read', 'tool', readVersion),
            input: { path: join(root, 'missing.txt') },
          }),
        ).toMatchObject({
          revision: 'builtin.files:external-read',
          safeRead: true,
          hardAllowed: true,
          effects: ['read'],
        });
        expect(calls).toEqual(['files', 'files', 'files']);
        owner = 'none';
        calls.length = 0;
        fallback.length = 0;
        expect(await describe(request('routing.source'))).toMatchObject({
          revision: 'source-first',
        });
        expect(fallback).toEqual(['sources']);
        fallback.length = 0;
        expect(await describe(request('routing.remote'))).toMatchObject({
          revision: 'selected-remote',
        });
        expect(fallback).toEqual(['sources', 'selected']);
        fallback.length = 0;
        expect(await describe(request('routing.unknown'))).toBeNull();
        expect(fallback).toEqual(['sources', 'selected']);
        fallback.length = 0;
        expect(await describe(request('routing.unknown', 'model'))).toBeNull();
        expect(fallback).toEqual([]);
        expect(calls).toEqual([]);
      }
    }
  } finally {
    if (runtime) await runtime.close();
    else await store?.close();
    removeTemporaryDirectory(root);
  }
}

if (process.argv[2] === '--fixture') {
  await scenario(process.argv[3]!);
  process.stdout.write('CAPABILITY_ROUTING_OK\n');
} else {
  for (const kind of [
    'owners',
    'task-and-static',
    'files-and-fallback',
    'review-contract',
    'custom-checker',
  ])
    test(`registered capability descriptions preserve ${kind} routing`, async () => {
      const child = Bun.spawn(
        [process.execPath, fileURLToPath(import.meta.url), '--fixture', kind],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
      const status = await child.exited.finally(() => clearTimeout(timer));
      expect({ status, stderr: await stderr }).toEqual({ status: 0, stderr: '' });
      expect(await stdout).toContain('CAPABILITY_ROUTING_OK');
    }, 15000);
}
