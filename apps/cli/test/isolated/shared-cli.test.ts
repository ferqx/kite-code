import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import {
  inspectProcess,
  readDaemonReservation,
  requestDaemonBootstrap,
  selectDaemonEndpoint,
} from '@kite-ai/service/daemon';
import { runSelectedCLI } from '../../host';
import { runSelectedDaemon } from '../../host/daemon';
import type { RunCLIArguments } from '../../src/arguments';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';

let root: string, entry: string, driver: string;
const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
beforeAll(async () => {
  root = mkdtempSync('/private/tmp/kite-shared-cli-');
  const old = await buildOwnedDaemon(join(root, 'artifact'));
  const result = await Bun.build({
    entrypoints: [
      new URL('../fixtures/shared-cli-daemon-child.ts', import.meta.url).pathname,
      new URL('../fixtures/shared-cli-driver.ts', import.meta.url).pathname,
    ],
    target: 'bun',
    packages: 'external',
    outdir: dirname(old),
  });
  expect(result.success).toBe(true);
  entry = join(dirname(old), 'shared-cli-daemon-child.js');
  driver = join(dirname(old), 'shared-cli-driver.js');
}, 60000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error('shared_fixture_timeout');
    await Bun.sleep(5);
  }
}
async function limit<T>(value: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('shared_fixture_deadline')), 10000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fixture() {
  const base = join(root, randomUUID());
  mkdirSync(base, { mode: 0o700 });
  const dataRoot = join(base, 'data');
  const profile = selectProfile({ dataRoot, profile: 'owned' });
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.profileAccessKey,
    explicitSocket: join(base, 's.sock'),
  });
  const web = join(base, 'web');
  mkdirSync(web);
  const manifest = [
    ['/index.html', 'text/html; charset=utf-8', '<title>Owned</title>'],
    ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
    ['/app.css', 'text/css; charset=utf-8', 'body{}'],
  ].map(([path, mediaType, content]) => {
    writeFileSync(join(web, path!.slice(1)), content!);
    return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
  });
  const raw = JSON.stringify(manifest);
  writeFileSync(join(web, 'manifest.json'), raw);
  const executable = realpathSync(process.execPath);
  const artifact = {
    entrypoint: entry,
    entrypointSha256: hash(readFileSync(entry)),
    executable,
    executableSha256: hash(readFileSync(executable)),
    apiMajor: 1 as const,
    buildId: 'running-older-build',
    daemon: {
      entrypoint: entry,
      entrypointSha256: hash(readFileSync(entry)),
      web: { directory: web, manifestSha256: hash(raw) },
    },
  };
  const daemon = (action: 'start' | 'stop') =>
    runSelectedDaemon({
      arguments: { kind: 'server', action, server: endpoint.socket, cancel: false, json: false },
      dataRoot,
      profile: 'owned',
      cwd: base,
      artifact,
      write() {},
    });
  await daemon('start');
  const bootstrap = await requestDaemonBootstrap(endpoint, {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  });
  const client = createClient({
    endpoint: bootstrap.httpEndpoint,
    token: bootstrap.token,
    expected: {
      profile: bootstrap.profile,
      instanceId: bootstrap.instanceId,
      apiMajor: 1,
      requiredCapabilities: [],
    },
  });
  const info = await client.connect();
  const storeId = info.storeId!;
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'workspace',
    rootUri: `file://${base}`,
    name: 'Owned',
  });
  const session = (id: string, workspaceId = 'workspace') =>
    client.createSession({
      expectedStoreId: storeId,
      commandId: `create-${id}`,
      sessionId: id,
      workspaceId,
      title: id,
    });
  const args = (task: string, thread?: string): RunCLIArguments => ({
    kind: 'run',
    task,
    ...(thread ? { thread } : {}),
    server: endpoint.socket,
    trustWorkspace: false,
    skills: [],
  });
  const lines: string[] = [];
  let assetReads = 0;
  const run = (
    arguments_: RunCLIArguments,
    extra: Partial<Parameters<typeof runSelectedCLI>[0]> = {},
  ) =>
    runSelectedCLI({
      arguments: arguments_,
      dataRoot,
      profile: 'owned',
      cwd: '/missing-local-cwd',
      write: (line) => lines.push(line),
      prompt() {},
      resolveArtifact() {
        assetReads++;
        throw Error('paired_asset_must_not_resolve');
      },
      onLaunched() {
        throw Error('shared_must_not_launch');
      },
      ...extra,
    });
  const alive = async () => {
    expect(inspectProcess(bootstrap.pid, bootstrap.processStartIdentity)).toBe('alive');
    expect((await requestDaemonBootstrap(endpoint, bootstrap.profile)).instanceId).toBe(
      bootstrap.instanceId,
    );
  };
  return {
    base,
    dataRoot,
    profile,
    endpoint,
    bootstrap,
    client,
    storeId,
    session,
    args,
    lines,
    run,
    alive,
    reads: () => assetReads,
    async close() {
      client.disposeNetwork();
      await daemon('stop');
      expect(readDaemonReservation(endpoint)).toBeUndefined();
    },
  };
}
nativeTest(
  'shared missing paired assets and differing target build run/resume full output while other client held work remains alive',
  async () => {
    const f = await fixture();
    try {
      await f.session('other');
      await f.client.startRun('other', {
        expectedStoreId: f.storeId,
        commandId: 'other-held',
        kind: 'run.start',
        content: 'hold external',
      });
      await until(() => existsSync(join(f.base, 'entered-other')));
      expect(await limit(f.run(f.args('ordinary complete answer', 'cli')))).toBe(0);
      expect(
        f.lines.some((line) => line.includes('complete-owned-answer:') && line.includes(':TAIL')),
      ).toBe(true);
      expect(f.lines.join('\n').length).toBeGreaterThan(84 * 1024);
      expect(
        await limit(
          f.run({ ...f.args('resume complete answer', 'cli'), kind: 'resume' } as RunCLIArguments, {
            artifact: {
              entrypoint: '/missing-installed/main.js',
              entrypointSha256: '0'.repeat(64),
              executable: '/missing-installed/bun',
              executableSha256: '0'.repeat(64),
              buildId: 'different-newer-installed-build',
              apiMajor: 1,
            },
          }),
        ),
      ).toBe(0);
      await f.alive();
      expect((await f.client.getView('other')).runs.some((run) => run.isActive)).toBe(true);
      expect(existsSync(join(f.base, 'cancelled-other'))).toBe(false);
      expect(f.reads()).toBe(0);
    } finally {
      await f.close();
    }
  },
  30000,
);
nativeTest(
  'shared explicit workspace, foreign thread and missing Skill capability reject before work without asset resolution',
  async () => {
    const f = await fixture();
    try {
      const elsewhere = join(f.base, 'elsewhere');
      mkdirSync(elsewhere);
      await f.client.createWorkspace({
        expectedStoreId: f.storeId,
        id: 'foreign-workspace',
        rootUri: `file://${elsewhere}`,
        name: 'Foreign',
      });
      await f.session('foreign', 'foreign-workspace');
      await expect(f.run({ ...f.args('x'), workspace: elsewhere })).rejects.toMatchObject({
        code: 'shared_workspace_mismatch',
      });
      await expect(f.run(f.args('x', 'foreign'))).rejects.toMatchObject({
        code: 'workspace_identity_mismatch',
      });
      await expect(
        f.run({ ...f.args('x'), skills: ['configured-guidance'] }),
      ).rejects.toMatchObject({
        code: 'shared_connection_failed',
      });
      expect(f.reads()).toBe(0);
      expect(existsSync(join(f.base, 'models'))).toBe(false);
      await f.alive();
    } finally {
      await f.close();
    }
  },
  30000,
);
nativeTest(
  'shared EOF preserves original waiting intent, actual stdin answer completes, explicit Ctrl+C only cancels original command',
  async () => {
    const f = await fixture();
    try {
      expect(
        await limit(f.run(f.args('question shared', 'unanswered'), { stdin: Readable.from([]) })),
      ).toBe(3);
      const intent = f.lines.find((line) => line.startsWith('work intent '))!;
      expect(intent).toContain('unanswered');
      const pending = await f.client.listInteractions('unanswered', {
        storeId: f.storeId,
        state: 'pending',
      });
      expect(pending.interactions).toHaveLength(1);
      expect(existsSync(join(f.base, 'answer-unanswered'))).toBe(false);
      await f.alive();
      expect(
        await limit(
          f.run(f.args('question shared', 'answered'), {
            stdin: Readable.from(['{"reply":"yes"}\n']),
          }),
        ),
      ).toBe(0);
      expect(readFileSync(join(f.base, 'answer-answered'), 'utf8')).toContain('yes');
      await f.session('other');
      await f.client.startRun('other', {
        expectedStoreId: f.storeId,
        commandId: 'other-held',
        kind: 'run.start',
        content: 'hold external',
      });
      await until(() => existsSync(join(f.base, 'entered-other')));
      const cancel = new AbortController();
      const running = f.run(f.args('hold external', 'cancel-own'), { signal: cancel.signal });
      await until(() => existsSync(join(f.base, 'entered-cancel-own')));
      cancel.abort();
      expect(await limit(running)).toBe(130);
      expect(existsSync(join(f.base, 'cancelled-cancel-own'))).toBe(true);
      expect(existsSync(join(f.base, 'cancelled-other'))).toBe(false);
      expect((await f.client.getView('other')).runs.some((run) => run.isActive)).toBe(true);
      await f.alive();
    } finally {
      await f.close();
    }
  },
  30000,
);
function spawnDriver(
  dataRoot: string,
  socket: string,
  task = 'hold external',
  thread = 'terminated',
) {
  return Bun.spawn(
    [process.execPath, driver, 'run', '--task', task, '--thread', thread, '--server', socket],
    {
      cwd: dirname(driver),
      env: { PATH: process.env.PATH ?? '', OWNED_DATA_ROOT: dataRoot },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}
nativeTest(
  'compiled shared CLI SIGTERM detaches without cancelling daemon work; later daemon loss ends original observation without replay',
  async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawnDriver> | undefined;
    try {
      child = spawnDriver(f.dataRoot, f.endpoint.socket);
      const output = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      child.stdin.end();
      await until(() => existsSync(join(f.base, 'entered-terminated')));
      child.kill('SIGTERM');
      expect(await limit(child.exited)).toBe(2);
      expect(await output).toContain('work intent');
      expect(await errors).not.toContain(f.bootstrap.token);
      expect(existsSync(join(f.base, 'cancelled-terminated'))).toBe(false);
      expect((await f.client.getView('terminated')).runs.some((run) => run.isActive)).toBe(true);
      await f.alive();
      const running = f.run(f.args('hold external', 'network-lost'));
      await until(() => existsSync(join(f.base, 'entered-network-lost')));
      const calls = readFileSync(join(f.base, 'models'), 'utf8');
      process.kill(f.bootstrap.pid, 'SIGKILL');
      expect(await limit(running)).toBe(2);
      expect(
        f.lines.some((line) => line.includes('network-lost') && line.startsWith('work intent ')),
      ).toBe(true);
      expect(readFileSync(join(f.base, 'models'), 'utf8')).toBe(calls);
      expect(f.reads()).toBe(0);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'compiled shared CLI SIGTERM while awaiting stdin question stops local reader without answering or cancelling original work',
  async () => {
    const f = await fixture();
    const child = spawnDriver(f.dataRoot, f.endpoint.socket, 'question shared', 'question-exit');
    let prompt = '';
    const errors = (async () => {
      const reader = child.stderr.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return prompt;
          prompt += new TextDecoder().decode(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    })();
    const output = new Response(child.stdout).text();
    try {
      // Keep stdin open and wait for the actual prompt; this is not an EOF fixture.
      await until(() => prompt.includes('Answer JSON matching the original schema'));
      child.kill('SIGTERM');
      expect(await limit(child.exited)).toBe(3);
      expect(await output).toContain('work intent');
      expect(await errors).not.toContain(f.bootstrap.token);
      const pending = await f.client.listInteractions('question-exit', {
        storeId: f.storeId,
        state: 'pending',
      });
      expect(pending.interactions).toHaveLength(1);
      expect(existsSync(join(f.base, 'answer-question-exit'))).toBe(false);
      expect((await f.client.getView('question-exit')).runs.some((run) => run.isActive)).toBe(true);
      await f.alive();
    } finally {
      child.stdin.end();
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await errors;
      await f.close();
    }
  },
  30000,
);
