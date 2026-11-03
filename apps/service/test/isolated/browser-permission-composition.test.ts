import { expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { JobDefinition, Json, ToolContext } from '@kite-ai/agent/extensions';
import {
  NativeBrowserPageHost,
  serializeBrowserPageFailure,
} from '../../../desktop/electron/browser-page-host';

// Separate processes keep asset substitutes away from other configuration tests.
// Only the interpreter/transport effect boundaries are replaced. Configuration,
// final permission decisions, Operations, records and SQLite remain real.
async function scenario(kind: string) {
  let releasedIdentity = { pageId: 'retained-page', incarnation: 'previous-incarnation' };
  const existing = kind.startsWith('existing-');
  const existingFailure = ['existing-missing', 'existing-mismatch'].includes(kind);
  const requireExisting = existing && kind !== 'existing-new-url';
  if (existing) {
    const browser = await import('@kite-ai/agent/browser');
    const createController = browser.createBrowserController;
    mock.module('@kite-ai/agent/browser', () => ({
      ...browser,
      createBrowserController(input: Parameters<typeof browser.createBrowserController>[0]) {
        const controller = createController(input);
        // Only this trusted read fixture is supplied; the actual Service factory
        // must connect it lazily to its own original authorization adapter.
        controller.releasedPage = (sessionId) =>
          sessionId === 'session'
            ? {
                url:
                  kind === 'existing-new-url'
                    ? 'https://example.test/old'
                    : 'https://example.test/',
                title: 'Released local page',
                identity: releasedIdentity,
              }
            : null;
        return controller;
      },
    }));
  }
  const executor = await import('@kite-ai/agent/browser/executor');
  const mcp = await import('@kite-ai/agent/mcp');
  const executable = realpathSync(process.execPath);
  mock.module('@kite-ai/agent/browser/executor', () => ({
    ...executor,
    browserExecutorWorkerAsset: () => executable,
  }));
  mock.module('@kite-ai/agent/mcp', () => ({ ...mcp, mcpStdioGuardianAsset: () => executable }));
  const [
    { createRuntime },
    { createFixedModel },
    { createDefaultProcessConfiguration },
    { selectProfile },
    { openSqliteStore },
    { createTemporaryCredentialBackend },
    { privateDirectory },
    { initializeLivePermissionFixture },
  ] = await Promise.all([
    import('@kite-ai/agent'),
    import('@kite-ai/ai'),
    import('../../src/configuration'),
    import('@kite-ai/agent/profile'),
    import('@kite-ai/agent/sqlite'),
    import('@kite-ai/agent/config'),
    import('@kite-ai/agent/windows-path-security'),
    import('../fixtures/live-permission-fixture'),
  ]);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-browser-policy-composition-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  privateDirectory(profile.profilePath);
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    configurationPath,
    JSON.stringify({
      modelId: 'fixture',
      models: [
        {
          id: 'fixture',
          provider: 'compatible',
          model: 'fixture',
          baseURL: 'https://never-network.invalid/v1',
        },
      ],
    }),
  );
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'execute',
        name: 'browser_execute',
        arguments: JSON.stringify({
          code: 'await browser.open("https://example.test/")',
          description: '打开任务网页',
        }),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const checker = createFixedModel([
    [
      {
        type: 'text_delta',
        text: JSON.stringify({
          decision: 'reject',
          reason: 'Exact requested local page',
        }),
      },
      finish,
    ],
  ]);
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: configurationPath,
    ordinaryHostTools: true,
    child: [],
    credentialBackend: createTemporaryCredentialBackend(),
    authorizationCheck: {
      id: 'controlled-review',
      version: '1',
      modelId: 'fixture',
      model: checker,
    },
    desktopBrowser: { endpoint: 'http://127.0.0.1:9/kite-page', token: 'a'.repeat(72) },
    browser: {
      executable,
      browserPath: executable,
      darwin: { guardianPath: executable, bunExecutable: executable },
      linux: { bubblewrapPath: executable, initExecutable: executable },
      runtimeDirectory: join(root, 'browser-private'),
    },
  });
  const nativeExtension = host.extensions!.find((extension) => extension.id === 'builtin.browser')!;
  expect(nativeExtension.tools?.some((tool) => tool.id === 'browser.request_human')).toBe(false);
  expect(nativeExtension.jobs?.some((job) => job.id === 'browser.human_wait')).toBe(false);
  expect(
    nativeExtension.actions?.some((action) =>
      ['browser.resume', 'browser.respond_human'].includes(action.id),
    ),
  ).toBe(false);
  expect(nativeExtension.actions?.some((action) => action.id === 'browser.handoff')).toBe(true);
  expect(nativeExtension.actions?.some((action) => action.id === 'browser.close')).toBe(true);
  expect(nativeExtension.conditions).toBeUndefined();
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const storeId = (await store.getMetadata()).storeId;
  const main = existing ? new NativeBrowserPageHost() : undefined;
  let mainCreates = 0,
    mainSends = 0;
  const cleanupMain: (() => void)[] = [];
  if (main) {
    const scope = { storeId, sessionId: 'session' };
    const url = ['existing-mismatch', 'existing-new-url'].includes(kind)
      ? 'https://example.test/changed'
      : 'https://example.test/';
    cleanupMain.push(
      main.configureGrantContext({
        selectedScope: () => ({ ...scope, generation: 1, viewSelection: 1 }),
        create(pageId, input) {
          mainCreates++;
          expect(kind).toBe('existing-new-url');
          expect(input).toEqual(scope);
          cleanupMain.push(
            main.add({
              id: pageId,
              scope,
              alive: () => true,
              attach() {},
              detach: () => true,
              async send() {
                mainSends++;
                return {};
              },
              typingCursor: async () => null,
              onEvent: () => () => {},
              decorate() {},
              changed() {},
              capture: async () => ({}),
              captureMeta: () => null,
            }),
          );
        },
        describe: (pageId) => ({
          title: 'Retained local page',
          url: pageId === 'retained-page' ? url : '',
        }),
        close() {},
      }),
    );
    if (kind !== 'existing-missing')
      cleanupMain.push(
        main.add({
          id: 'retained-page',
          scope,
          alive: () => true,
          attach() {},
          detach: () => true,
          async send() {
            mainSends++;
            return {};
          },
          typingCursor: async () => null,
          onEvent: () => () => {},
          decorate() {},
          changed() {},
          capture: async () => ({}),
          captureMeta: () => null,
        }),
      );
    const incarnation = main.state('retained-page')?.incarnation;
    if (incarnation) releasedIdentity = { pageId: 'retained-page', incarnation };
  }
  let runtime!: ReturnType<typeof createRuntime>;
  let sessionStarts = 0,
    codeStarts = 0;
  const requests: Record<string, unknown>[] = [];
  let proposal: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, input?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:9/kite-page');
      const request = JSON.parse(String(input?.body)) as Record<string, unknown>;
      requests.push(request);
      if (request.op === 'prepareGrant') {
        expect(request.requireExisting).toBe(requireExisting ? true : undefined);
        expect(request.existingPage).toEqual(requireExisting ? releasedIdentity : undefined);
      }
      if (main) {
        try {
          return Response.json({ ok: true, value: await main.request(request) });
        } catch (error) {
          return Response.json(
            {
              ok: false,
              error: (error as Error).message,
              failure: serializeBrowserPageFailure(error, request),
            },
            { status: 400 },
          );
        }
      }
      if (request.op === 'prepareGrant') {
        proposal = {
          requestId: request.requestId,
          url: request.url,
          state: 'question',
          ...(request.requireExisting ? { requireExisting: true } : {}),
          page: {
            kind: 'existing',
            id: 'page',
            title: 'Local page',
            url: requireExisting ? 'https://example.test/' : 'https://example.test/current',
          },
        };
      } else if (request.op === 'commitGrant') {
        proposal!.state = 'committed';
      } else if (request.op === 'cancelGrant') proposal!.state = 'cancelled';
      else if (request.op !== 'inspectGrant') throw Error('unexpected_private_rpc');
      return Response.json({ ok: true, value: proposal });
    },
    { preconnect: originalFetch.preconnect },
  );
  const wait = async (context: ToolContext, definitionId: string, input: Json) => {
    const ref = await context.operations.ensure({
      key: definitionId,
      cancellation: 'attached',
      request: {
        kind: definitionId === 'browser.open' ? 'tool' : 'job',
        definitionId,
        definitionVersion: '1',
        input,
      },
    });
    return context.operations.wait(ref, { timeoutMs: 5000, signal: context.signal });
  };
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
                    async execute(_input: Json, context: ToolContext) {
                      await wait(context, 'browser.code_session', { runId: context.runId });
                      const opened = await wait(context, 'browser.open', {
                        key: 'exact-open',
                        url: 'https://example.test/',
                      });
                      if (existingFailure) {
                        expect(opened.result).toMatchObject({ outcome: 'failed' });
                        return { outcome: 'failed' as const, content: 'Existing page unavailable' };
                      }
                      {
                        const limit = Date.now() + 5000;
                        while (sessionStarts === 0) {
                          if (Date.now() > limit) throw Error('session_dispatch_timeout');
                          await Bun.sleep(5);
                        }
                      }
                      return {
                        outcome: 'succeeded' as const,
                        content: 'Controlled dispatch observed',
                      };
                    },
                  },
            ),
            jobs: extension.jobs!.map(
              (job): JobDefinition =>
                !['browser.code_session', 'browser.session'].includes(job.id)
                  ? job
                  : {
                      ...job,
                      async start() {
                        if (job.id === 'browser.session') sessionStarts++;
                        else codeStarts++;
                        return { reference: {} };
                      },
                      async *observe() {
                        yield {
                          type: 'terminal',
                          supervision: 'ended',
                          result: { outcome: 'succeeded', content: 'Controlled effect boundary' },
                        };
                      },
                      async cancel() {
                        return { status: 'stopped' };
                      },
                      async dispose() {},
                    },
            ),
          },
    );
  runtime = createRuntime({
    ...host,
    permissions: host.permissions!,
    store,
    extensions,
    async resolveRunConfiguration(input) {
      return { ...(await host.resolveRunConfiguration!(input)), model };
    },
  });
  host.permissionManagement?.(runtime);
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      name: 'Local page',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      sessionId: 'session',
      workspaceId: 'workspace',
      commandId: 'create',
      subjectId: 'owner',
      title: 'Local page',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId: storeId,
      subjectId: 'owner',
      sessionId: 'session',
      workspaceId: 'workspace',
      mode: existing ? 'auto' : (kind as 'auto' | 'full' | 'accept_edits'),
      trusted: true,
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'session',
      commandId: 'work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'Inspect the local page.' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    expect(checker.requests).toHaveLength(0);
    expect(codeStarts).toBe(1);
    expect(sessionStarts).toBe(existingFailure ? 0 : 1);
    expect(requests.map((request) => request.op)).toEqual(
      existingFailure ? ['prepareGrant'] : ['prepareGrant', 'commitGrant'],
    );
    const saved = await store.listExtensionRecords({
      sessionId: 'session',
      extensionId: 'builtin.browser',
      contentType: 'application/vnd.kite.browser-grant+json',
    });
    expect(saved).toHaveLength(1);
    expect((saved[0]!.value as { requireExisting?: unknown }).requireExisting).toBe(
      requireExisting ? true : undefined,
    );
    if (existingFailure)
      expect(
        (await store.listExecutions('session')).filter(
          (execution) => execution.definitionId === 'browser.session',
        ),
      ).toHaveLength(0);
    if (existing) {
      expect(mainCreates).toBe(kind === 'existing-new-url' ? 1 : 0);
      expect(mainSends).toBe(0);
    }
    const interactions = (
      await runtime.listInteractions({ expectedStoreId: storeId, sessionId: 'session' })
    ).interactions;
    expect(interactions.filter((interaction) => interaction.kind === 'question')).toEqual([]);
    expect(interactions).toHaveLength(0);
    const executions = await store.listExecutions('session');
    expect(
      executions.find((execution) => execution.definitionId === 'browser.execute')?.authorization
        ?.dispatched,
    ).toBe(true);
    expect(
      executions.find((execution) => execution.definitionId === 'browser.code_session')
        ?.authorization?.dispatched,
    ).toBe(true);
    expect(
      executions.find((execution) => execution.definitionId === 'browser.open')?.authorization
        ?.dispatched,
    ).toBe(true);
  } finally {
    await runtime.close();
    for (const cleanup of cleanupMain.reverse()) cleanup();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.env.KITE_BROWSER_PERMISSION_COMPOSITION) {
  await scenario(process.env.KITE_BROWSER_PERMISSION_COMPOSITION);
  process.stdout.write('browser_permission_composition_ok\n');
} else
  for (const kind of [
    'accept_edits',
    'auto',
    'full',
    'existing-match',
    'existing-missing',
    'existing-mismatch',
    'existing-new-url',
  ])
    test(`ordinary Native configuration ${kind} dispatches browser control with no checker or approval`, async () => {
      const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
        env: { ...process.env, KITE_BROWSER_PERMISSION_COMPOSITION: kind },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
      expect(stdout).toContain('browser_permission_composition_ok');
    }, 20000);
