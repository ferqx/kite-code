import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import {
  browserToolIds,
  type NativeBrowserTransportOptions,
  nativeBrowserUnavailableReason,
} from '@kite-ai/agent/browser';
import { createTemporaryCredentialBackend, type JsonObject } from '@kite-ai/agent/config';
import type { ReadContext } from '@kite-ai/agent/extensions';
import { createPermissionPolicy } from '@kite-ai/agent/permissions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createClient } from '@kite-ai/client';
import { createBrowserConfiguration } from '../../src/browser-configuration';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import {
  defaultConfiguration,
  ordinaryHostConfigurationDefaults,
} from '../../src/configuration-defaults';
import { startService } from '../../src/index';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

function assets(root: string): NativeBrowserTransportOptions {
  // Native binaries are never dispatched in these composition tests.
  const executable = realpathSync(process.execPath);
  return {
    executable,
    browserPath: executable,
    linux: { bubblewrapPath: executable, initExecutable: executable },
    runtimeDirectory: join(root, 'private-browser'),
  };
}
function temporary() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'kite-browser-configuration-')));
}

function expectInertView(views: readonly { payload: unknown }[]) {
  const reason = nativeBrowserUnavailableReason();
  if (reason) {
    expect(views).toHaveLength(1);
    expect(views[0]?.payload).toMatchObject({ state: 'unavailable', error: reason });
  } else expect(views).toEqual([]);
}

test('ordinary clients select Browser tools, embedding remains minimal, and a host ceiling cannot be raised by selection', async () => {
  expect(defaultConfiguration.tools).toEqual([{ id: 'ask_user' }]);
  expect(ordinaryHostConfigurationDefaults(false, false).tools.map((tool) => tool.id)).toEqual(
    expect.arrayContaining([...browserToolIds]),
  );
  expect(
    ordinaryHostConfigurationDefaults(false, false, false).tools.some((tool) =>
      tool.id.startsWith('browser.'),
    ),
  ).toBe(false);
  const root = temporary();
  try {
    const browser = createBrowserConfiguration({
      configuration: false,
      privateDirectory: join(root, 'private'),
    });
    const policy = createPermissionPolicy({
      readPolicy: () => ({
        mode: 'full',
        workspaceTrust: true,
        revision: 'full-host',
        allowed: browser.capabilities,
      }),
      describeCapability: (request) =>
        browser.capabilities.find(
          (capability) =>
            capability.kind === request.kind && capability.definitionId === request.definitionId,
        ) ?? null,
    });
    for (const capability of browser.capabilities) {
      expect(
        await policy.authorize({
          ...capability,
          sessionId: 's',
          runId: 'r',
          executionId: 'e',
          input: {},
          signal: AbortSignal.timeout(1000),
        }),
      ).toMatchObject({ allowed: false });
    }
    const views = await browser.extension.queries![0]!.execute({}, {
      sessionId: 's',
    } as ReadContext);
    expect(views[0]?.payload).toMatchObject({
      state: 'unavailable',
      error: 'browser_disabled_by_host',
    });
    expect(existsSync(join(root, 'private'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host factory and repeated Query are inert; missing assets produce a finite unavailable view', async () => {
  const root = temporary();
  try {
    const options = assets(root);
    const browser = createBrowserConfiguration({
      configuration: options,
      privateDirectory: options.runtimeDirectory!,
    });
    expect(browser.runtimeAssets).toEqual([realpathSync(process.execPath)]);
    const reason = nativeBrowserUnavailableReason();
    expect(browser.available).toBe(reason === undefined);
    expect(browser.snapshot.unavailableReason).toBe(reason);
    expect(
      browser.capabilities.every((capability) => capability.hardAllowed === (reason === undefined)),
    ).toBe(true);
    expect(JSON.stringify(browser.snapshot)).not.toContain(root);
    for (let index = 0; index < 3; index++)
      expectInertView(
        await browser.extension.queries![0]!.execute({}, { sessionId: 's' } as ReadContext),
      );
    expect(existsSync(options.runtimeDirectory!)).toBe(false);
    // A synthetic negative host condition only: never bypass the native guard or dispatch.
    const originalCI = process.env.CI;
    try {
      process.env.CI = 'browser-configuration-guard';
      const denied = createBrowserConfiguration({
        configuration: options,
        privateDirectory: options.runtimeDirectory!,
      });
      const deniedReason = nativeBrowserUnavailableReason();
      expect(deniedReason).toBeDefined();
      expect(denied.available).toBe(false);
      expect(
        denied.capabilities.every(
          (capability) => !capability.hardAllowed && capability.denialReason === deniedReason,
        ),
      ).toBe(true);
      expect(
        ordinaryHostConfigurationDefaults(false, false, denied.available).tools.some((tool) =>
          tool.id.startsWith('browser.'),
        ),
      ).toBe(false);
      expect(
        (await denied.extension.queries![0]!.execute({}, { sessionId: 's' } as ReadContext))[0]
          ?.payload,
      ).toMatchObject({ state: 'unavailable', error: deniedReason });
      expect(existsSync(options.runtimeDirectory!)).toBe(false);
    } finally {
      if (originalCI === undefined) delete process.env.CI;
      else process.env.CI = originalCI;
    }
    const unavailable = createBrowserConfiguration({
      configuration: { ...options, executable: join(root, 'missing-native') },
      privateDirectory: options.runtimeDirectory!,
    });
    expect(unavailable.snapshot).toHaveProperty('unavailableReason', 'browser_runtime_unavailable');
    expect(
      (await unavailable.extension.queries![0]!.execute({}, { sessionId: 's' } as ReadContext))[0]
        ?.payload,
    ).toMatchObject({ state: 'unavailable', error: 'browser_runtime_unavailable' });
    expect(existsSync(options.runtimeDirectory!)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(browserEnabled: boolean | 'missing' = true) {
  const root = temporary(),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  privateDirectory(profile.profilePath);
  const file = join(profile.profilePath, 'config.jsonc');
  const requests: Record<string, unknown>[] = [];
  let toolCall: { name: string; input: JsonObject } | undefined;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const call = Array.isArray(body.tools) ? toolCall : undefined;
      if (call) toolCall = undefined;
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'fixture-tool',
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'Finished without opening a browser.' },
          null,
        ) +
          chunk({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configuration: JsonObject = {
    modelId: 'local',
    models: [
      { id: 'local', provider: 'compatible', model: 'local', baseURL: `${provider.url.href}v1` },
    ],
  };
  const save = () => writeFileSync(file, JSON.stringify(configuration));
  save();
  const browser = assets(root);
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: file,
    ordinaryHostTools: true,
    credentialBackend: createTemporaryCredentialBackend(),
    child: [],
    browser:
      browserEnabled === false
        ? false
        : browserEnabled === 'missing'
          ? { ...browser, executable: join(root, 'missing-native') }
          : browser,
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({ ...host, store, permissions: host.permissions! });
  host.permissionManagement?.(runtime);
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: serverProfile,
    subjectId: 'owner',
    buildId: 'browser-configuration',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: serverProfile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'sessions'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'browser',
    rootUri: pathToFileURL(workspace).href,
  });
  await client.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Browser configuration',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    expectedStoreId,
    subjectId: 'owner',
    sessionId: 's',
    workspaceId: 'w',
    mode: 'full',
    trusted: true,
  });
  let serial = 0;
  return {
    root,
    workspace,
    profile,
    file,
    host,
    runtime,
    store,
    client,
    browser,
    configuration,
    requests,
    save,
    emit(call: { name: string; input: JsonObject }) {
      toolCall = call;
    },
    async run() {
      const commandId = `work-${++serial}`;
      await client.startRun('s', {
        expectedStoreId,
        commandId,
        kind: 'run.start',
        content: 'Inspect the selected tool catalogue only.',
      });
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      const runId = (command.receipt as { runId?: string } | null)?.runId;
      return { command, run: runId ? await store.getRun(runId) : null };
    },
    async close() {
      await service.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('default Service exposes one global Browser extension and selected native tools without launching, and honors disable/version checks', async () => {
  const f = await fixture();
  try {
    expect(
      (await f.client.listExtensions()).filter(
        (extension) => extension.extensionId === 'builtin.browser',
      ),
    ).toHaveLength(1);
    expectInertView(await f.client.queryExtension('s', 'builtin.browser', 'browser.view', {}));
    const first = await f.run();
    expect(first.command).toMatchObject({
      status: 'applied',
      receipt: { runId: expect.any(String) },
    });
    expect(first.run?.status).toBe('completed');
    const request = f.requests.find((body) => Array.isArray(body.tools))!;
    const names = (request.tools as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    );
    const selectedBrowserIds = nativeBrowserUnavailableReason() ? [] : [...browserToolIds];
    expect(names.filter((name) => name.startsWith('browser_')).sort()).toEqual(
      selectedBrowserIds.map((id) => id.replace('.', '_')).sort(),
    );
    const snapshot = (
      first.run!.configuration as {
        snapshot: {
          browser: unknown;
          actualCapabilities: { tools: { id: string; extensionId: string }[] };
        };
      }
    ).snapshot;
    if (selectedBrowserIds.length)
      expect(snapshot.browser).toMatchObject({
        enabled: true,
        available: true,
        ownership: 'browser.session-job',
      });
    else expect(snapshot.browser).toBeNull();
    expect(
      snapshot.actualCapabilities.tools
        .filter((tool) => tool.extensionId === 'builtin.browser')
        .map((tool) => tool.id),
    ).toEqual(selectedBrowserIds);
    expect(existsSync(f.browser.runtimeDirectory!)).toBe(false);
    f.configuration.tools = browserToolIds.map((id) => ({ id, enabled: false }));
    f.save();
    const before = f.requests.length;
    expect((await f.run()).run?.status).toBe('completed');
    const disabled = f.requests.slice(before).find((body) => Array.isArray(body.tools))!;
    expect(
      (disabled.tools as { function: { name: string } }[]).some((tool) =>
        tool.function.name.startsWith('browser_'),
      ),
    ).toBe(false);
    // Query registration outlives Run disposal; it never creates the browser Job.
    expectInertView(await f.client.queryExtension('s', 'builtin.browser', 'browser.view', {}));
    f.configuration.tools = [{ id: 'browser.open', enabled: true, definitionVersion: '99' }];
    f.save();
    const invalid = await f.run();
    expect(invalid.command.status).toBe('rejected');
    expect(JSON.stringify(invalid.command.receipt)).toContain(
      'tool_definition_version_unavailable',
    );
    expect(existsSync(f.browser.runtimeDirectory!)).toBe(false);
  } finally {
    await f.close();
  }
}, 20000);

test('raw user/workspace browser controls and Tool options never enter trusted host construction', async () => {
  const f = await fixture();
  try {
    const unsafe = {
      executable: '/bin/sh',
      args: ['-c', 'unsafe'],
      cdpPort: 9222,
      profile: '/home/user/normal-profile',
    };
    f.configuration.browser = unsafe;
    f.save();
    const user = await f.run();
    expect(user.command.status).toBe('rejected');
    expect(JSON.stringify(user.command.receipt)).toContain('browser_configuration_host_owned');
    delete f.configuration.browser;
    f.save();
    const project = join(f.workspace, 'kite-agent.jsonc');
    writeFileSync(project, JSON.stringify({ browser: unsafe }));
    expect(JSON.stringify((await f.run()).command.receipt)).toContain(
      'browser_configuration_host_owned',
    );
    rmSync(project);
    f.configuration.tools = [{ id: 'browser.open', options: unsafe }];
    f.save();
    expect(JSON.stringify((await f.run()).command.receipt)).toContain('unsupported_tool_options');
    expect(f.requests).toHaveLength(0);
    expect(existsSync(f.browser.runtimeDirectory!)).toBe(false);
  } finally {
    await f.close();
  }
}, 20000);

test('Browser host fingerprint is preserved by recovery and a changed trusted limit refuses rebind without effects', async () => {
  const f = await fixture();
  try {
    // Explicit selection preserves its host fingerprint even when this OS cannot launch.
    f.configuration.tools = [{ id: 'browser.open' }];
    f.save();
    const { run } = await f.run();
    expect(run?.status).toBe('completed');
    const command = (await f.store.getCommand(run!.originCommandId))!;
    const session = (await f.store.getSession('s'))!;
    const workspace = (await f.store.getWorkspace('w'))!;
    const input = { command, run: run!, session, workspace, signal: AbortSignal.timeout(5000) };
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const requests = f.requests.length;
    const rebound = await f.host.resolveRecoveryRunConfiguration!(input);
    await rebound.dispose?.();
    const changedHost = createDefaultProcessConfiguration({
      profile: f.profile,
      userConfigurationPath: f.file,
      ordinaryHostTools: true,
      credentialBackend: createTemporaryCredentialBackend(),
      child: [],
      browser: { ...f.browser, requestTimeoutMs: 5000 },
    });
    changedHost.permissionManagement?.(f.runtime);
    let rejection: unknown;
    try {
      const unexpected = await changedHost.resolveRecoveryRunConfiguration!(input);
      await unexpected.dispose?.();
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ code: 'recovery_configuration_changed' });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.requests).toHaveLength(requests);
    expect(existsSync(f.browser.runtimeDirectory!)).toBe(false);
  } finally {
    await f.close();
  }
}, 20000);

test('private Browser roots are protected from ordinary external file reads even when created after host construction', async () => {
  const f = await fixture();
  try {
    const file = join(f.browser.runtimeDirectory!, 'private-profile.txt');
    mkdirSync(f.browser.runtimeDirectory!, { mode: 0o700 });
    const contents = 'BROWSER_PRIVATE_PROFILE_SENTINEL';
    writeFileSync(file, contents);
    f.emit({ name: 'read_user_file', input: { path: file } });
    const result = await f.run();
    expect(result.run?.status).toBe('completed');
    const tool = (await f.store.listExecutions('s', 100)).find(
      (execution) => execution.definitionId === 'files.read_path',
    );
    expect(tool?.status).toBe('failed');
    expect(JSON.stringify(tool?.result)).toContain('protected');
    expect(JSON.stringify(f.requests)).not.toContain(contents);
    expectInertView(await f.client.queryExtension('s', 'builtin.browser', 'browser.view', {}));
  } finally {
    await f.close();
  }
}, 20000);

test('actual Full-mode dispatch cannot lift a disabled host Browser capability through user tool selection', async () => {
  const f = await fixture(false);
  try {
    f.configuration.tools = [{ id: 'browser.open', enabled: true }];
    f.save();
    f.emit({ name: 'browser_open', input: { key: 'open-denied', url: 'https://example.test/' } });
    const result = await f.run();
    expect(result.run?.status).toBe('completed');
    const executions = await f.store.listExecutions('s', 100);
    const tool = executions.find((execution) => execution.definitionId === 'browser.open');
    expect(tool?.status).toBe('failed');
    expect(JSON.stringify(tool?.result)).toContain('browser_disabled_by_host');
    expect(executions.some((execution) => execution.definitionId === 'browser.session')).toBe(
      false,
    );
    expect(
      (await f.client.queryExtension('s', 'builtin.browser', 'browser.view', {}))[0]?.payload,
    ).toMatchObject({ state: 'unavailable', error: 'browser_disabled_by_host' });
    expect(existsSync(f.browser.runtimeDirectory!)).toBe(false);
  } finally {
    await f.close();
  }
}, 20000);

test('missing Browser assets are absent from defaults while explicit selection fails with the actual unavailable reason', async () => {
  const f = await fixture('missing');
  try {
    expect((await f.run()).run?.status).toBe('completed');
    const first = f.requests.find((body) => Array.isArray(body.tools))!;
    expect(
      (first.tools as { function: { name: string } }[]).some((tool) =>
        tool.function.name.startsWith('browser_'),
      ),
    ).toBe(false);
    f.configuration.tools = [{ id: 'browser.open', enabled: true }];
    f.save();
    f.emit({ name: 'browser_open', input: { key: 'missing-open', url: 'https://example.test/' } });
    expect((await f.run()).run?.status).toBe('completed');
    const executions = await f.store.listExecutions('s', 100);
    const tool = executions.find((execution) => execution.definitionId === 'browser.open');
    expect(tool?.status).toBe('failed');
    expect(JSON.stringify(tool?.result)).toContain('browser_runtime_unavailable');
    expect(executions.some((execution) => execution.definitionId === 'browser.session')).toBe(
      false,
    );
    expect(
      (await f.client.queryExtension('s', 'builtin.browser', 'browser.view', {}))[0]?.payload,
    ).toMatchObject({ state: 'unavailable', error: 'browser_runtime_unavailable' });
    expect(existsSync(f.browser.runtimeDirectory!)).toBe(false);
  } finally {
    await f.close();
  }
}, 20000);
