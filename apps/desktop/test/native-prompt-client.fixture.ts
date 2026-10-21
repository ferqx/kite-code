// Explicit standalone client verification. All data and transport barriers belong to this fixture.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { buildDevelopmentService } from '../../../scripts/development/desktop-reload';
import { initializeDesktopBuildEnvironment } from '../../../scripts/development/windows-desktop-environment';
import { createPermissionManagement } from '../../service/src/permission-management';
import { ownedUserConfiguration } from '../../service/test/fixtures/user-configuration-fixture';
import { buildNativeDesktop } from '../scripts/build-native';

if (process.platform !== 'win32') throw Error('manual_prompt_client_fixture_windows_only');
const repository = resolve(import.meta.dir, '../../..');
const root = join(repository, '.cache', `native-prompt-client-${randomUUID()}`);
privateDirectory(root);
const home = join(root, 'home'),
  workspace = join(root, 'workspace'),
  outdir = join(root, 'app');
for (const path of [home, workspace, outdir]) privateDirectory(path);
const configuration = ownedUserConfiguration(home);
const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'prompt-check' });
const events: unknown[] = [];
const holds: { method: string; sessionId?: string }[] = [];
const blocked = new Set<() => void>();
const token = randomUUID();
let quitting = false,
  restarting = false,
  requests = 0;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v1/')) {
      const body = (await request.json()) as { messages?: { role: string; content: unknown }[] };
      requests++;
      events.push({
        kind: 'model',
        users: body.messages?.filter((m) => m.role === 'user'),
        requests,
      });
      const chunk = (content: string, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'prompt-check', object: 'chat.completion.chunk', model: 'local-prompt-check', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
      return new Response(
        `${chunk('PROMPT_CLIENT_OK', null)}${chunk('', 'stop')}data: [DONE]\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    }
    if (request.headers.get('authorization') !== `Bearer ${token}`)
      return new Response(null, { status: 403 });
    if (url.pathname === '/status')
      return Response.json({ root, requests, blocked: blocked.size, holds, quitting, events });
    if (url.pathname === '/hold') {
      const value = (await request.json()) as { method: string; sessionId?: string };
      if (!['draft.read', 'submit'].includes(value.method))
        return new Response(null, { status: 400 });
      holds.push(value);
      return new Response('armed');
    }
    if (['/release', '/quit', '/restart'].includes(url.pathname)) {
      for (const release of blocked) release();
      blocked.clear();
      holds.length = 0;
      if (url.pathname === '/quit' || url.pathname === '/restart') {
        quitting = true;
        restarting = url.pathname === '/restart';
      }
      return new Response('released');
    }
    if (url.pathname === '/quitting') return Response.json({ quitting });
    if (url.pathname === '/ipc') {
      const value = (await request.json()) as { method: string; sessionId?: string };
      events.push(value);
      const index = holds.findIndex(
        (h) => h.method === value.method && (!h.sessionId || h.sessionId === value.sessionId),
      );
      if (index >= 0) {
        holds.splice(index, 1);
        await new Promise<void>((resolve) => blocked.add(resolve));
      }
      return new Response('ok');
    }
    return new Response(null, { status: 404 });
  },
});
const control = server.url.toString().replace(/\/$/, '');
await Bun.write(
  configuration.path,
  JSON.stringify({
    modelId: 'prompt-check',
    models: [
      {
        id: 'prompt-check',
        provider: 'compatible',
        model: 'local-prompt-check',
        baseURL: `${control}/v1`,
      },
    ],
  }),
);
const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
const storeId = (await store.getMetadata()).storeId;
const setupRuntime = createRuntime({
  store,
  permissions: {
    authorize: async () => ({ allowed: false, revision: 'fixture-setup-no-execution' }),
  },
});
try {
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'prompt-workspace',
    name: '提示词隔离验证',
    rootUri: pathToFileURL(workspace).href,
  });
  for (const [id, title] of [
    ['prompt-a', '提示词验证 A'],
    ['prompt-b', '提示词验证 B'],
    ['prompt-c', '提示词验证 C'],
  ])
    await store.createSession({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      commandId: `create-${id}`,
      sessionId: id!,
      workspaceId: 'prompt-workspace',
      title: title!,
    });
  const management = createPermissionManagement({ runtime: setupRuntime, profile });
  const identity = {
    expectedStoreId: storeId,
    subjectId: 'local-user',
    workspaceId: 'prompt-workspace',
  };
  const trust = await management.readTrust(identity);
  await management.setTrust({
    ...identity,
    commandId: 'fixture-initial-project',
    canonicalIdentity: trust.canonicalIdentity,
    externalReadScopeDigest: trust.externalReadScopeDigest,
    ifRevision: trust.revision,
    trusted: true,
  });
} finally {
  await setupRuntime.close();
}
console.log(JSON.stringify({ phase: 'building', root }));
initializeDesktopBuildEnvironment();
const service = await buildDevelopmentService(repository, outdir);
const bunExecutable = realpathSync(process.execPath);
await buildNativeDesktop(
  {
    kind: 'development',
    serviceEntrypoint: join(outdir, 'services', service.id, 'main.js'),
    serviceSha256: service.sha256,
    bunExecutable,
    bunSha256: createHash('sha256').update(readFileSync(bunExecutable)).digest('hex'),
    buildId: `prompt-client-${service.sha256}`,
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
    profile: { dataRoot: profile.dataRoot, profile: profile.profile },
  },
  outdir,
  { testDiagnostics: false },
);

// Only the fixture's Main entry can delay an already validated IPC reply. The product is unchanged.
await Bun.write(
  join(outdir, 'prompt-check-main.cjs'),
  `
const {app, ipcMain} = require('electron');
const control = ${JSON.stringify(control)}, token = ${JSON.stringify(token)};
const headers = {authorization: 'Bearer ' + token, 'content-type': 'application/json'};
const seeded = new Set();
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (event, input) => {
  let result = await listener(event, input);
  if (channel === 'kite:native:request' && input?.method === 'draft.read' && ['prompt-b', 'prompt-c'].includes(input.sessionId) && result.ok && result.value.revision === 0 && !seeded.has(input.sessionId)) {
    seeded.add(input.sessionId);
    await listener(event, {...input, method: 'draft.write', revision: result.value.revision, content: '保存的原草稿-' + input.sessionId});
    result = await listener(event, input);
  }
  if (channel === 'kite:native:request' && ['select', 'draft.read', 'submit', 'conversation.send', 'conversation.lookup'].includes(input?.method))
    await fetch(control + '/ipc', {method: 'POST', headers, body: JSON.stringify({method: input.method, sessionId: input.sessionId, content: input.intent?.content, reply: result})});
  return result;
});
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('page-title-updated', event => event.preventDefault());
  window.webContents.once('did-finish-load', () => window.setTitle('Kite 提示词隔离验证'));
});
const timer = setInterval(async () => {
  try { if ((await (await fetch(control + '/quitting', {headers})).json()).quitting) { clearInterval(timer); app.quit(); } } catch {}
}, 500);
timer.unref();
require('./main.cjs');
`,
);
await Bun.write(
  join(outdir, 'package.json'),
  JSON.stringify({
    name: 'kite-prompt-client-fixture',
    version: '0.1.0',
    main: 'prompt-check-main.cjs',
  }),
);
const electron = realpathSync(createRequire(import.meta.url)('electron') as string);
const env: NodeJS.ProcessEnv = { ...process.env, ...configuration.homeEnvironment };
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'ELECTRON_RUN_AS_NODE'])
  delete env[name];
let round = 0;
try {
  do {
    quitting = false;
    restarting = false;
    round++;
    const child = Bun.spawn([electron, outdir, `--user-data-dir=${join(root, 'electron-data')}`], {
      cwd: outdir,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    await Bun.write(
      join(root, 'control.json'),
      JSON.stringify({
        control,
        token,
        root,
        pid: child.pid,
        storeId,
        profile: profile.profilePath,
        round,
      }),
    );
    console.log(JSON.stringify({ phase: 'launched', root, pid: child.pid }));
    const exitCode = await child.exited;
    await Bun.write(join(root, `stdout-${round}.log`), await stdout);
    await Bun.write(join(root, `stderr-${round}.log`), await stderr);
    events.push({ kind: 'exit', round, pid: child.pid, exitCode });
    await Bun.write(
      join(root, 'events.json'),
      JSON.stringify({ exitCode, storeId, requests, events }, null, 2),
    );
    console.log(JSON.stringify({ phase: 'closed', root, exitCode, requests }));
  } while (restarting);
} finally {
  for (const release of blocked) release();
  server.stop(true);
}
