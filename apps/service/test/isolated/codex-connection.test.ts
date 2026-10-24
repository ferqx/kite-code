import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { ShellConfigurationOptions } from '@kite-ai/agent/permissions/shell';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient, type ModelSettingsRequest } from '@kite-ai/client';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { CODEX_BASE_URL, createCodexLocalSource } from '../../src/codex-auth';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';
import { encodeFrames, responseFrames, type WireTurn } from '../fixtures/responses-wire';

type Body = Record<string, unknown> & {
  model: string;
  instructions: string;
  input: Record<string, unknown>[];
};
type Wire = { url: string; headers: Headers; body: Body };
const firstModel = 'fixture-codex-first';
const secondModel = 'fixture-codex-second';

function token(account: string, revision: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    iss: 'https://auth.openai.com',
    sub: `fixture-subject-${account}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: account },
    fixture_revision: revision,
  })}.${encode('fixture-signature')}`;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw Error('codex_connection_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(
  respond?: (body: Body, index: number) => WireTurn,
  hostShell = false,
  existing?: { root: string; codexHome?: string },
) {
  const root = existing?.root ?? temporaryDirectory('kite-codex-connection-');
  const codexHome = existing?.codexHome ?? join(root, 'codex');
  const workspace = join(root, 'workspace');
  const userRoot = join(root, 'user');
  for (const directory of [codexHome, workspace, userRoot]) privateDirectory(directory);
  const userFile = join(userRoot, 'kite-code.jsonc');
  const authFile = join(codexHome, 'auth.json');
  const writeAuth = (account: string, revision: string) => {
    const accessToken = token(account, revision);
    writeFileSync(
      authFile,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: accessToken,
          account_id: account,
          refresh_token: 'fixture-refresh-never-copied',
        },
      }),
      { mode: 0o600 },
    );
    return accessToken;
  };
  const originalToken = existing
    ? token('fixture-account-a', 'initial')
    : writeAuth('fixture-account-a', 'initial');
  if (!existing) {
    writeFileSync(
      join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: firstModel, visibility: 'list', context_window: 500000 },
          { slug: secondModel, visibility: 'list', context_window: 500000 },
          { slug: 'fixture-hidden', visibility: 'hide' },
        ],
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(codexHome, 'config.toml'), `model = "${secondModel}"\n`, { mode: 0o600 });
    writeFileSync(join(workspace, 'result.txt'), 'CODEX_LOCAL_TOOL_RESULT\n', { mode: 0o600 });
  }
  const records: Wire[] = [];
  const fakeFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = JSON.parse(String(init?.body)) as Body;
      const index = records.length;
      records.push({ url, headers: new Headers(init?.headers), body });
      expect(url).toBe(`${CODEX_BASE_URL}/responses`);
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit' });
      const turn = respond?.(body, index) ?? { id: `fixture-response-${index}`, text: ['done'] };
      return new Response(encodeFrames(responseFrames({ ...turn, model: body.model }, body)), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const localCodex = createCodexLocalSource({ codexHome, fetch: fakeFetch });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const supervisor =
    hostShell && process.platform === 'darwin'
      ? await Bun.build({
          entrypoints: [
            join(
              import.meta.dir,
              '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
            ),
          ],
          outdir: join(root, 'assets'),
          target: 'bun',
          naming: 'shell-supervisor.js',
        })
      : undefined;
  let shell: ShellConfigurationOptions | undefined;
  if (hostShell) {
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      throw Error('codex_host_shell_platform_unsupported');
    privateDirectory(join(root, 'assets'));
    privateDirectory(profile.coordinationPath);
    let supervisorPath: string;
    let bubblewrapPath: string | undefined;
    if (process.platform === 'linux') {
      const compiler = Bun.which('cc');
      bubblewrapPath = Bun.which('bwrap') ?? undefined;
      if (!compiler || !bubblewrapPath) throw Error('codex_linux_shell_tools_missing');
      supervisorPath = join(root, 'assets/linux-shell-init');
      const compiled = spawnSync(
        compiler,
        [
          '-std=c11',
          '-O2',
          '-Wall',
          '-Wextra',
          '-Werror',
          join(import.meta.dir, '../../../../packages/agent/native/linux-shell-init.c'),
          '-o',
          supervisorPath,
        ],
        { encoding: 'utf8', timeout: 10000 },
      );
      expect(compiled.error).toBeUndefined();
      expect(compiled.status, compiled.stderr).toBe(0);
    } else {
      if (!supervisor) throw Error('codex_shell_supervisor_missing');
      expect(supervisor.success).toBe(true);
      supervisorPath = supervisor.outputs[0]!.path;
    }
    shell = {
      platform: process.platform,
      configurationId: 'codex-default-host-shell-fixture',
      env: { PATH: '/usr/bin:/bin' },
      supervisorPath,
      bunExecutable: process.execPath,
      shellExecutable: '/bin/sh',
      ...(bubblewrapPath ? { linux: { bubblewrapPath } } : {}),
      host: {
        controlBase: profile.coordinationPath,
        protectedRoots: [profile.dataRoot, profile.coordinationPath],
        readonlyAssets: [supervisorPath],
        runtimeReadOnlyRoots: [dirname(process.execPath)],
      },
    };
  }
  let credentialWrites = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    localCodex,
    ...(shell
      ? {
          ordinaryHostTools: true,
          shell,
        }
      : {}),
    userConfigurationPath: userFile,
    hostConfiguration: {
      configuration: {
        tools: [
          ...(respond ? [{ id: 'files.read', definitionVersion: '5' }] : []),
          ...(hostShell ? [{ id: 'shell.execute', definitionVersion: '1' }] : []),
        ],
      },
    },
    credentialBackend: {
      kind: 'temporary',
      async put() {
        credentialWrites++;
        throw Error('unexpected_codex_credential_write');
      },
      resolve: async () => null,
      remove: async () => {},
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  const permissionManagement = host.permissionManagement!(runtime);
  const service = await startService({
    runtime,
    configurationManagement: host.configurationManagement!(runtime),
    subjectId: 'owner',
    buildId: 'codex-local-test',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['configuration_management', 'commands', 'model_inputs'],
    },
  });
  await client.connect();
  const storeId = (await store.getMetadata()).storeId;
  if (!existing) {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Owned Codex fixture',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Codex fixture',
    });
    const permissionScope = {
      expectedStoreId: storeId,
      subjectId: 'owner',
      workspaceId: 'w',
      sessionId: 's',
    };
    const trust = await permissionManagement.readTrust(permissionScope);
    await permissionManagement.setTrust({
      ...permissionScope,
      commandId: 'trust-owned-workspace',
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      trusted: true,
      ifRevision: trust.revision,
    });
    const mode = await permissionManagement.readMode(permissionScope);
    await permissionManagement.setMode({
      ...permissionScope,
      commandId: 'full-owned-session',
      mode: 'full',
      makeDefault: false,
      ifRevision: mode.revision,
      ifDefaultRevision: mode.defaultRevision,
    });
  }
  const models = () => client.getModelSettings('user', { storeId });
  return {
    root,
    codexHome,
    userFile,
    authFile,
    originalToken,
    writeAuth,
    records,
    client,
    storeId,
    models,
    get credentialWrites() {
      return credentialWrites;
    },
    async save(commandId: string, operation: ModelSettingsRequest['operation']) {
      return client.updateModelSettings('user', {
        expectedStoreId: storeId,
        commandId,
        expectedReadSet: (await models()).readSet!,
        operation,
      });
    },
    async run(commandId: string, modelId: string) {
      await client.startRun('s', {
        expectedStoreId: storeId,
        commandId,
        kind: 'run.start',
        content: `Owned fixture task ${commandId}`,
        modelId,
      });
      return until(
        async () => ({
          command: await client.getCommand(commandId),
          view: await client.getView('s'),
        }),
        ({ command, view }) => {
          if (command.status === 'rejected') return true;
          const receipt = command.receipt as { runId?: string } | null;
          return (
            command.status === 'applied' &&
            view.runs.some((run) => run.id === receipt?.runId && !run.isActive)
          );
        },
      );
    },
    async close(remove = true) {
      client.disposeNetwork();
      await service.close();
      if (remove) rmSync(root, { recursive: true, force: true });
    },
  };
}

(['darwin', 'linux'].includes(process.platform) ? test : test.skip)(
  'ordinary Codex Run starts with the actual default Host Shell and private auth-file protection',
  async () => {
    const f = await fixture(undefined, true);
    try {
      const original = readFileSync(f.authFile, 'utf8');
      const result = await f.run('codex-host-shell', (await f.models()).defaultModelId!);
      expect(result.command.status).toBe('applied');
      expect(result.view.runs[0]).toMatchObject({ status: 'completed', reason: null });
      expect(f.records).toHaveLength(1);
      expect(f.records[0]!.body.tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'shell_execute' })]),
      );
      expect(readFileSync(f.authFile, 'utf8')).toBe(original);
      expect(f.credentialWrites).toBe(0);
    } finally {
      await f.close();
    }
  },
  20000,
);

(process.platform === 'linux' ? test : test.skip)(
  'actual Linux default Codex Run executes an ordinary Shell Tool while its local authentication remains private',
  async () => {
    let command = '';
    const f = await fixture(
      (_body, index) =>
        index === 0
          ? {
              id: 'codex-linux-shell',
              calls: [
                {
                  id: 'shell-linux-call',
                  name: 'shell_execute',
                  arguments: JSON.stringify({
                    key: 'linux-command',
                    command,
                    execution_timeout_ms: 4000,
                  }),
                },
              ],
            }
          : { id: 'codex-linux-result', text: ['Linux Shell finished'] },
      true,
    );
    try {
      const original = readFileSync(f.authFile, 'utf8');
      command = `if cat '${f.authFile}' 2>/dev/null; then printf leaked; else printf read-denied; fi; if (printf stolen > '${f.authFile}') 2>/dev/null; then printf wrote; else printf write-denied; fi; printf actual > effect; printf ordinary`;
      const result = await f.run('linux-codex-shell', (await f.models()).defaultModelId!);
      expect(result.command.status).toBe('applied');
      const failures = result.view.executions
        .filter(
          (execution) => execution.status === 'failed' || execution.status === 'outcome_unknown',
        )
        .map((execution) => ({
          definitionId: execution.definitionId,
          status: execution.status,
          result: execution.result,
        }));
      expect(result.view.runs[0]!.status, JSON.stringify(failures)).toBe('completed');
      expect(result.view.runs[0]!.reason).toBeNull();
      const jobs = result.view.executions.filter(
        (execution) => execution.definitionId === 'shell.command',
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.status).toBe('succeeded');
      const output = await f.client.listExecutionOutput(jobs[0]!.id, { afterSeq: '0', limit: 200 });
      expect(
        output.items
          .filter((row) => row.stream === 'stdout')
          .map((row) => row.content)
          .join(''),
      ).toBe('read-deniedwrite-deniedordinary');
      expect(readFileSync(join(f.root, 'workspace/effect'), 'utf8')).toBe('actual');
      expect(readFileSync(f.authFile, 'utf8')).toBe(original);
      expect(f.records).toHaveLength(2);
      expect(f.credentialWrites).toBe(0);
    } finally {
      await f.close();
    }
  },
  20000,
);

test('local Codex appears without config writes; ordinary model preferences never materialize its provider or copy credentials', async () => {
  const f = await fixture();
  try {
    const authBefore = readFileSync(f.authFile, 'utf8');
    const providers = await f.client.getProviderSettings({ storeId: f.storeId });
    const codex = providers.providers.find((provider) => provider.id === 'codex')!;
    expect(codex.connections).toMatchObject([
      {
        canWrite: false,
        hasCredential: true,
        protocol: 'responses',
        modelNames: [firstModel, secondModel],
      },
    ]);
    const initial = await f.models();
    expect(initial.errors).toEqual([]);
    expect(initial.models.map((model) => model.model)).toEqual([firstModel, secondModel]);
    expect(initial.models.every((model) => model.enabled && model.configured)).toBe(true);
    const first = initial.models.find((model) => model.model === firstModel)!;
    const second = initial.models.find((model) => model.model === secondModel)!;
    expect(initial.defaultModelId).toBe(second.id);
    expect(existsSync(f.userFile)).toBe(false);
    expect(f.records).toHaveLength(0);
    expect(f.credentialWrites).toBe(0);

    await f.save('effort', { kind: 'effort', modelId: second.id, reasoningEffort: 'high' });
    await f.save('default-first', { kind: 'default', modelId: first.id });
    await f.save('default-second', { kind: 'default', modelId: second.id });
    await f.save('disable-first', { kind: 'enabled', modelId: first.id, enabled: false });
    const savedText = readFileSync(f.userFile, 'utf8');
    const saved = JSON.parse(savedText);
    expect(Object.keys(saved).sort()).toEqual(['disabledModels', 'model', 'modelOptions']);
    expect(saved.modelOptions[second.id]).toEqual({ reasoningEffort: 'high' });
    expect(saved.disabledModels).toHaveLength(1);
    const after = await f.models();
    expect(after.defaultModelId).toBe(second.id);
    expect(after.models.find((model) => model.id === second.id)?.reasoningEffort).toBe('high');
    expect(after.models.find((model) => model.id === first.id)?.enabled).toBe(false);
    await f.save('enable-first', { kind: 'enabled', modelId: first.id, enabled: true });
    expect((await f.models()).models.find((model) => model.id === first.id)?.enabled).toBe(true);
    for (const privateValue of [f.originalToken, 'fixture-refresh-never-copied']) {
      expect(savedText).not.toContain(privateValue);
      expect(JSON.stringify({ providers, initial, after })).not.toContain(privateValue);
    }
    const originalConfig = readFileSync(f.userFile, 'utf8');
    expect(
      await f.client.updateProviderSettings({
        expectedStoreId: f.storeId,
        commandId: 'manual-codex-rejected',
        expectedReadSet: (await f.models()).readSet!,
        operation: {
          provider: 'codex',
          protocol: 'responses',
          connectionId: codex.connections[0]!.id,
          baseURL: CODEX_BASE_URL,
          modelNames: [],
          credential: 'replace',
        },
        secret: 'fixture-manual-key-never-stored',
      }),
    ).toMatchObject({ state: 'failed', receipt: { code: 'provider_settings_override' } });
    expect(readFileSync(f.userFile, 'utf8')).toBe(originalConfig);
    expect(readFileSync(f.authFile, 'utf8')).toBe(authBefore);
    expect(f.records).toHaveLength(0);
    expect(f.credentialWrites).toBe(0);
  } finally {
    await f.close();
  }
});

test('the local reasoning preference reaches the SDK wire and an explicit model preference replaces it', async () => {
  const f = await fixture();
  try {
    const config = `model = "${secondModel}"\nmodel_reasoning_effort = "high"\n`;
    writeFileSync(join(dirname(f.authFile), 'config.toml'), config, { mode: 0o600 });
    const initial = await f.models();
    const route = initial.defaultModelId!;
    expect(initial.models.find((model) => model.id === route)?.reasoningEffort).toBe('high');
    expect((await f.run('local-effort', route)).view.runs.at(-1)?.status).toBe('completed');
    expect(f.records[0]!.body.reasoning).toMatchObject({ effort: 'high' });
    await f.save('override-local-effort', {
      kind: 'effort',
      modelId: route,
      reasoningEffort: 'low',
    });
    expect((await f.run('manual-effort', route)).view.runs.at(-1)?.status).toBe('completed');
    expect(f.records[1]!.body.reasoning).toMatchObject({ effort: 'low' });
    expect(readFileSync(join(dirname(f.authFile), 'config.toml'), 'utf8')).toBe(config);
    expect(f.credentialWrites).toBe(0);
  } finally {
    await f.close();
  }
});

test('real Codex SDK Responses loop preserves the tool result, rereads rotated tokens and rejects old account routes before transport', async () => {
  const f = await fixture((_body, index) =>
    index === 0
      ? {
          id: 'codex-tool',
          encrypted: 'fixture-encrypted-state',
          calls: [
            {
              id: 'read-local',
              name: 'read_file',
              arguments: JSON.stringify({ path: 'result.txt' }),
            },
          ],
        }
      : { id: `codex-final-${index}`, text: ['Owned Codex final result'] },
  );
  try {
    const initial = await f.models();
    const route = initial.defaultModelId!;
    const result = await f.run('tool-round', route);
    expect(result.command).toMatchObject({ status: 'applied' });
    expect(result.view.runs[0]?.reason).toBeNull();
    expect(result.view.runs[0]?.status).toBe('completed');
    expect(f.records).toHaveLength(2);
    for (const wire of f.records) {
      expect(wire.body).toMatchObject({ model: secondModel, store: false, stream: true });
      expect(wire.body.instructions.length).toBeGreaterThan(0);
      expect(wire.body.max_output_tokens).toBeUndefined();
      expect(
        wire.body.input.some((item) => item.role === 'system' || item.role === 'developer'),
      ).toBe(false);
      expect(wire.headers.get('authorization')).toBe(`Bearer ${f.originalToken}`);
      expect(wire.headers.get('chatgpt-account-id')).toBe('fixture-account-a');
      expect(wire.headers.get('originator')).toBe('kite-code');
      expect(wire.headers.get('openai-beta')).toBe('responses=experimental');
    }
    const outputs = f.records[1]!.body.input.filter((item) => item.type === 'function_call_output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ call_id: 'read-local' });
    expect(String(outputs[0]!.output)).toContain('CODEX_LOCAL_TOOL_RESULT');
    expect(f.records[1]!.body.input.filter((item) => item.type === 'function_call')).toMatchObject([
      {
        call_id: 'read-local',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'result.txt' }),
      },
    ]);
    expect(f.records[1]!.body.input.filter((item) => item.type === 'reasoning')).toMatchObject([
      { encrypted_content: 'fixture-encrypted-state' },
    ]);
    const toolExecutions = result.view.executions.filter((execution) => execution.kind === 'tool');
    expect(toolExecutions).toHaveLength(1);
    expect(toolExecutions[0]?.status).toBe('succeeded');
    const modelExecutions = result.view.executions.filter(
      (execution) => execution.kind === 'model',
    );
    const historical = await f.client.getModelInput('s', modelExecutions[0]!.id, {
      expectedStoreId: f.storeId,
    });
    const systems = historical.request.messages.filter((message) => message.role === 'system');
    expect(f.records[0]!.body.instructions).toBe(
      systems.map((message) => message.content).join('\n\n'),
    );
    expect(JSON.stringify({ historical, view: result.view })).not.toContain(f.originalToken);
    expect(JSON.stringify({ historical, view: result.view })).not.toContain(
      'fixture-encrypted-state',
    );

    const rotated = f.writeAuth('fixture-account-a', 'rotated');
    const sameAccount = await f.models();
    expect(sameAccount.readSet).toEqual(initial.readSet);
    expect(sameAccount.defaultModelId).toBe(route);
    expect((await f.run('rotated-token', route)).view.runs.at(-1)?.status).toBe('completed');
    expect(f.records).toHaveLength(3);
    expect(f.records[2]!.headers.get('authorization')).toBe(`Bearer ${rotated}`);
    expect(f.records[2]!.headers.get('chatgpt-account-id')).toBe('fixture-account-a');
    expect(f.records[2]!.body.input.filter((item) => item.type === 'reasoning')).toMatchObject([
      { encrypted_content: 'fixture-encrypted-state' },
    ]);

    f.writeAuth('fixture-account-b', 'replacement-account');
    const otherAccount = await f.models();
    expect(otherAccount.models.some((model) => model.id === route)).toBe(false);
    expect(otherAccount.defaultModelId).not.toBe(route);
    await expect(
      f.client.updateModelSettings('user', {
        expectedStoreId: f.storeId,
        commandId: 'stale-account-preference',
        expectedReadSet: sameAccount.readSet!,
        operation: { kind: 'default', modelId: route },
      }),
    ).rejects.toMatchObject({ code: 'configuration_read_set_conflict' });
    const rejected = await f.run('old-account-route', route);
    expect(rejected.command).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'model_unavailable' },
    });
    expect(f.records).toHaveLength(3);
    expect(
      f.records.every((wire) => wire.headers.get('chatgpt-account-id') === 'fixture-account-a'),
    ).toBe(true);
    expect(f.credentialWrites).toBe(0);
    expect(existsSync(f.userFile)).toBe(false);
  } finally {
    await f.close();
  }
});

test('Codex token rotation and cold Service reconstruction retain private Artifact history while another auth source is isolated', async () => {
  let f = await fixture(() => ({
    id: 'codex-cold-original',
    encrypted: 'fixture-cold-encrypted-state',
    text: ['Original reply'],
  }));
  try {
    const route = (await f.models()).defaultModelId!;
    expect((await f.run('before-cold', route)).view.runs.at(-1)?.status).toBe('completed');
    expect(f.records).toHaveLength(1);
    const rotated = f.writeAuth('fixture-account-a', 'cold-rotated');
    const root = f.root;
    await f.close(false);

    f = await fixture(undefined, false, { root });
    expect((await f.models()).defaultModelId).toBe(route);
    const cold = await f.run('after-cold', route);
    expect(cold.view.runs.at(-1)?.status).toBe('completed');
    expect(f.records).toHaveLength(1);
    expect(f.records[0]!.headers.get('authorization')).toBe(`Bearer ${rotated}`);
    expect(f.records[0]!.body.input.filter((item) => item.type === 'reasoning')).toMatchObject([
      { encrypted_content: 'fixture-cold-encrypted-state' },
    ]);
    expect(JSON.stringify(cold.view)).not.toContain('fixture-cold-encrypted-state');
    expect(JSON.stringify(cold.view)).not.toContain(rotated);

    const otherSource = join(root, 'other-codex-source');
    privateDirectory(otherSource);
    for (const name of ['auth.json', 'models_cache.json', 'config.toml'])
      writeFileSync(join(otherSource, name), readFileSync(join(f.codexHome, name)), {
        mode: 0o600,
      });
    await f.close(false);
    f = await fixture(undefined, false, { root, codexHome: otherSource });
    expect((await f.models()).defaultModelId).toBe(route);
    expect((await f.run('different-source', route)).view.runs.at(-1)?.status).toBe('completed');
    expect(f.records).toHaveLength(1);
    expect(f.records[0]!.headers.get('authorization')).toBe(`Bearer ${rotated}`);
    expect(f.records[0]!.body.input.some((item) => item.type === 'reasoning')).toBe(false);
    expect(f.credentialWrites).toBe(0);
    expect(existsSync(f.userFile)).toBe(false);
  } finally {
    await f.close();
  }
});
