import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Json, ToolResult } from '@kite-ai/agent/extensions';
import { expect, mock, test } from '#kite-test';
import { spawn as spawnProcess } from '../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../scripts/tooling/test-command';

// Module/asset stand-ins live only in a child process. No Native, interpreter,
// SDK request, local HTTP server or external network is launched by this test.
async function scenario(kind: string) {
  const browser = await import('@kite-ai/agent/browser');
  const mcp = await import('@kite-ai/agent/mcp');
  mock.module('@kite-ai/agent/mcp', () => ({
    ...mcp,
    mcpStdioGuardianAsset: () => realpathSync(process.execPath),
  }));
  const executor = await import('@kite-ai/agent/browser/executor');
  const workerAvailable = kind !== 'missing-executor';
  mock.module('@kite-ai/agent/browser/executor', () => ({
    ...executor,
    browserExecutorWorkerAsset() {
      if (!workerAvailable) throw Error('browser_executor_asset_unavailable');
      return realpathSync(process.execPath);
    },
  }));
  const [
    agent,
    ai,
    configModule,
    profileModule,
    sqliteModule,
    artifactModule,
    credentialModule,
    permissionFixture,
  ] = await Promise.all([
    import('@kite-ai/agent'),
    import('@kite-ai/ai'),
    import('../../src/configuration'),
    import('@kite-ai/agent/profile'),
    import('@kite-ai/agent/sqlite'),
    import('@kite-ai/agent/artifacts'),
    import('@kite-ai/agent/config'),
    import('../fixtures/live-permission-fixture'),
  ]);
  let networkRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => {
    networkRequests++;
    throw Error('network_forbidden_in_configuration_fixture');
  }, {});
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-browser-execution-config-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = profileModule.selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const { privateDirectory } = await import('@kite-ai/agent/windows-path-security');
  privateDirectory(profile.profilePath);
  const file = join(profile.profilePath, 'config.jsonc');
  const configuration: Record<string, unknown> = {
    modelId: 'fixture',
    models: [
      {
        id: 'fixture',
        provider: 'compatible',
        model: 'fixture',
        baseURL: 'https://fixture.invalid/v1',
      },
    ],
    ...(kind === 'legacy' ? { tools: [{ id: 'browser.open' }] } : {}),
    ...(kind === 'disabled'
      ? { tools: [{ id: 'browser.execute' }, { id: 'skills.load' }, { id: 'skills.resource' }] }
      : {}),
  };
  const save = () => writeFileSync(file, JSON.stringify(configuration));
  save();
  const executable = realpathSync(process.execPath);
  const host = configModule.createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: file,
    ordinaryHostTools: true,
    credentialBackend: credentialModule.createTemporaryCredentialBackend(),
    child: [],
    desktopBrowser: { endpoint: 'http://127.0.0.1:9/kite-page', token: 'a'.repeat(72) },
    browser:
      kind === 'disabled'
        ? false
        : {
            executable,
            browserPath: executable,
            linux: { bubblewrapPath: executable, initExecutable: executable },
            darwin: { guardianPath: executable, runtimeExecutable: executable },
            runtimeDirectory: join(root, 'browser-private'),
          },
  });
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const call = (id: string, name: string, input: Json) => [
    { type: 'tool_call' as const, id, name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' as const },
  ];
  const model = ai.createFixedModel(
    kind === 'legacy'
      ? [[finish]]
      : [
          call('load', 'load_skill', {
            skill_id: 'computer-use',
          }),
          ...(kind === 'available'
            ? [
                call('resource', 'read_skill_resource', {
                  skill_id: 'computer-use',
                  path: 'references/browser-api.md',
                }),
              ]
            : []),
          call('execute', 'browser_execute', {
            code: 'Inspect only the already selected page.',
            description: '观察当前网页',
          }),
          [finish],
        ],
  );
  let currentModel = model;
  let probeDispatches = 0;
  // Replace only the external code-execution boundary. The child snapshot uses
  // the actual registered original Tool/Controller/Operations and permission gate.
  const extensions = host
    .extensions!.filter((extension) => extension.id !== 'builtin.session-title')
    .map((extension) =>
      extension.id !== 'builtin.browser'
        ? extension
        : {
            ...extension,
            tools: extension.tools!.map((tool) =>
              tool.id !== 'browser.execute'
                ? tool
                : {
                    ...tool,
                    async execute(
                      _input: Json,
                      context: Parameters<typeof tool.execute>[1],
                    ): Promise<ToolResult> {
                      probeDispatches++;
                      const ref = await context.operations.ensure({
                        key: 'controlled-internal-snapshot',
                        cancellation: 'attached',
                        request: {
                          kind: 'tool',
                          definitionId: 'browser.snapshot',
                          definitionVersion: '1',
                          input: {
                            key: 'controlled-observation',
                            browserId: 'not-owned',
                            generation: 'not-owned',
                          },
                        },
                      });
                      const result = await context.operations.wait(ref, {
                        timeoutMs: 1000,
                        signal: context.signal,
                      });
                      return {
                        outcome: 'succeeded',
                        content: JSON.stringify({ childId: result.id, childStatus: result.status }),
                      };
                    },
                  },
            ),
          },
    );
  const store = await sqliteModule.openSqliteStore({
    dataRoot: profile.dataRoot,
    profile: profile.profile,
  });
  const storeId = (await store.getMetadata()).storeId;
  const runtime = agent.createRuntime({
    ...host,
    permissions: host.permissions!,
    store,
    artifacts: artifactModule.createArtifactStore({ profile, store }),
    extensions,
    async resolveRunConfiguration(input) {
      const binding = await host.resolveRunConfiguration!(input);
      return { ...binding, model: currentModel };
    },
  });
  host.permissionManagement?.(runtime);
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      name: 'fixture',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      sessionId: 'session',
      workspaceId: 'workspace',
      commandId: 'create',
      subjectId: 'owner',
      title: 'fixture',
    });
    await permissionFixture.initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId: storeId,
      subjectId: 'owner',
      sessionId: 'session',
      workspaceId: 'workspace',
      mode: 'full',
      trusted: true,
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'session',
      commandId: 'work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Inspect the form and explain its current state.' },
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const runId = (command.receipt as { runId: string }).runId;
    const run = (await store.getRun(runId))!;
    expect({
      status: run.status,
      reason: run.reason,
      calls: (await store.listExecutions('session'))
        .filter((execution) => execution.kind === 'tool')
        .map((execution) => ({
          definition: execution.definitionId,
          status: execution.status,
          result: execution.status === 'succeeded' ? null : execution.result,
        })),
    }).toMatchObject({ status: 'completed' });
    const manifest = run.configuration as {
      tools: { id: string; version: string; extensionId: string }[];
      snapshot: {
        configuration: { tools: { id: string }[] };
        browser: { execution?: string };
        modelHiddenToolIds?: string[];
        actualCapabilities: {
          tools: { id: string; definitionVersion: string }[];
          skills: { id: string }[];
        };
      };
    };
    const snapshot = manifest.snapshot;
    const names = model.requests[0]!.tools.map((tool) => tool.id);
    const browserNames = names.filter((name) => name.startsWith('browser_'));
    if (kind === 'legacy') {
      expect(browserNames.sort()).toEqual(
        [...browser.browserToolIds].map((id) => id.replaceAll('.', '_')).sort(),
      );
      expect(names).not.toContain('browser_execute');
      expect(snapshot.browser.execution).toBeUndefined();
      expect(snapshot.modelHiddenToolIds ?? []).toEqual([]);
      expect(snapshot.actualCapabilities.skills).toEqual([]);
      // Removing the explicit legacy item leaves the old effective defaults
      // identical. Recovery must select those frozen defaults, not today's Native default.
      delete configuration.tools;
      save();
    } else {
      expect(browserNames).toEqual(['browser_execute']);
      expect(names).toContain('load_skill');
      expect(names).toContain('read_skill_resource');
      expect(snapshot.browser.execution).toBe('isolated-browser-code-1');
      expect(snapshot.modelHiddenToolIds).toEqual(
        expect.arrayContaining([...browser.browserToolIds]),
      );
      expect(snapshot.configuration.tools.some((tool) => tool.id === 'browser.snapshot')).toBe(
        false,
      );
      expect(snapshot.actualCapabilities.tools).toEqual(
        expect.arrayContaining([
          { id: 'browser.snapshot', definitionVersion: '1', extensionId: 'builtin.browser' },
        ]),
      );
      expect(manifest.tools.find((tool) => tool.id === 'browser.snapshot')).toMatchObject({
        version: '1',
        extensionId: 'builtin.browser',
      });
      const executions = await store.listExecutions('session');
      const loaded = executions.find((execution) => execution.definitionId === 'skills.load')!;
      if (kind === 'available') {
        expect({ status: loaded.status, result: loaded.result }).toMatchObject({
          status: 'succeeded',
        });
        expect(JSON.stringify(loaded.result)).toContain('Computer use');
        expect(
          executions.find((execution) => execution.definitionId === 'skills.resource')?.status,
        ).toBe('succeeded');
        expect(JSON.stringify(model.requests[2]!.messages)).toContain('Browser API');
        expect(snapshot.actualCapabilities.skills).toEqual(
          expect.arrayContaining([
            {
              id: 'computer-use',
              version: expect.any(String),
              requiredCapabilities: ['browser.execute'],
            },
          ]),
        );
        const outer = executions.find((execution) => execution.definitionId === 'browser.execute')!;
        const inner = executions.find(
          (execution) => execution.definitionId === 'browser.snapshot',
        )!;
        expect(outer.status).toBe('succeeded');
        expect(inner.parentExecutionId).toBe(outer.id);
        expect(inner.result).toMatchObject({
          outcome: 'failed',
          content: 'browser_stale_or_foreign_target',
        });
        expect(probeDispatches).toBe(1);
      } else {
        expect(loaded.status).toBe('failed');
        expect(JSON.stringify(loaded.result)).toContain('skill_capability_missing');
        expect(snapshot.actualCapabilities.skills).toEqual([]);
        expect(probeDispatches).toBe(0);
        expect(executions.some((execution) => execution.definitionId === 'browser.snapshot')).toBe(
          false,
        );
        expect(
          executions.find((execution) => execution.definitionId === 'browser.execute')?.status,
        ).toBe('failed');
      }
    }
    const preserved = JSON.stringify(run.configuration);
    const cursor = (await store.getMetadata()).lastChangeCursor;
    const rebound = await host.resolveRecoveryRunConfiguration!({
      command: (await store.getCommand(run.originCommandId))!,
      run,
      session: (await store.getSession('session'))!,
      workspace: (await store.getWorkspace('workspace'))!,
      signal: AbortSignal.timeout(5000),
    });
    try {
      expect(rebound.modelHiddenToolIds ?? []).toEqual(snapshot.modelHiddenToolIds ?? []);
      expect(rebound.toolIds).toEqual(manifest.tools.map((tool) => tool.id));
    } finally {
      await rebound.dispose?.();
    }
    expect(JSON.stringify((await store.getRun(runId))!.configuration)).toBe(preserved);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    if (kind === 'legacy') {
      currentModel = ai.createFixedModel([[finish]]);
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 'session',
        commandId: 'fresh-work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Inspect the current browser capabilities.' },
      });
      const freshCommand = await runtime.waitForCommand('fresh-work', { timeoutMs: 5000 });
      const fresh = await store.getRun((freshCommand.receipt as { runId: string }).runId);
      expect(fresh?.status).toBe('completed');
      expect(
        currentModel.requests[0]!.tools.filter((tool) => tool.id.startsWith('browser_')).map(
          (tool) => tool.id,
        ),
      ).toEqual(['browser_execute']);
      expect(JSON.stringify((await store.getRun(runId))!.configuration)).toBe(preserved);
    }
    expect(networkRequests).toBe(0);
    expect(existsSync(join(root, 'browser-private'))).toBe(false);
  } finally {
    await runtime.close();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--fixture') {
  await scenario(process.argv[3]!);
  process.stdout.write('BROWSER_EXECUTION_CONFIGURATION_OK\n');
} else {
  const nativeTest = process.platform === 'darwin' ? test : test.skip;
  for (const kind of ['available', 'legacy', 'disabled', 'missing-executor'])
    nativeTest(
      `Native configuration ${kind} keeps one accurate browser model surface and frozen recovery`,
      async () => {
        const child = spawnProcess(
          [
            process.execPath,
            ...testRuntimeFlags,
            fileURLToPath(import.meta.url),
            '--fixture',
            kind,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        const output = new Response(child.stdout).text();
        const errors = new Response(child.stderr).text();
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        const status = await child.exited.finally(() => clearTimeout(timer));
        const stderr = await errors;
        expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
        expect(await output).toContain('BROWSER_EXECUTION_CONFIGURATION_OK');
      },
      15000,
    );
}
