import { Database } from 'bun:sqlite';
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
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, join } from 'node:path';
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
import { selectWorkflowActivations } from '../../host/workflow-activations';
import { run } from '../../src';
import { parseCLIArguments } from '../../src/arguments';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { workflowManifest } from '../fixtures/workflow-manifest';

const nativeTest = process.platform === 'darwin' ? test : test.skip;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let root: string, entry: string;
const cleanups = new Set<() => Promise<void>>();
beforeAll(async () => {
  root = realpathSync(mkdtempSync('/private/tmp/kite-shared-skills-'));
  const built = await buildOwnedDaemon(join(root, 'artifact'));
  const result = await Bun.build({
    entrypoints: [new URL('../fixtures/shared-skills-daemon-child.ts', import.meta.url).pathname],
    target: 'bun',
    packages: 'external',
    outdir: dirname(built),
  });
  expect(result.success).toBe(true);
  entry = join(dirname(built), 'shared-skills-daemon-child.js');
}, 60000);
afterAll(async () => {
  await Promise.all([...cleanups].map((close) => close()));
  if (root) rmSync(root, { recursive: true, force: true });
});
async function until<T>(read: () => Promise<T>, condition: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (condition(value)) return value;
    if (Date.now() >= end) throw Error('shared_skills_deadline');
    await Bun.sleep(5);
  }
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(workflow?: 'enabled' | 'disabled' | 'structured') {
  const base = join(root, randomUUID());
  mkdirSync(base, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(base, 'data'), profile: 'owned' });
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.profileAccessKey,
    explicitSocket: join(base, 's.sock'),
  });
  let stopDaemon: (() => Promise<unknown>) | undefined;
  const entered = gate(),
    release = gate();
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      const text = JSON.stringify(body.messages);
      const toolReply = body.messages.at(-1)?.role === 'tool';
      const chosen = text.includes('BetaSkill') && !text.includes('AlphaSkill') ? 'beta' : 'alpha';
      const delta = toolReply
        ? { content: 'done' }
        : {
            tool_calls: [
              {
                index: 0,
                id: `load-${requests.length}`,
                type: 'function',
                function:
                  workflow && text.includes('SHARED_WORKFLOW_INLINE_ORIGINAL_BODY')
                    ? {
                        name: 'complete_skill',
                        arguments: JSON.stringify({ activation_id: 'manual-1', output: {} }),
                      }
                    : { name: 'skills.load', arguments: JSON.stringify({ id: chosen }) },
              },
            ],
          };
      const held = !toolReply && text.includes('HOLD_ALPHA');
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (value: unknown, finish: string | null) =>
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`,
                ),
              );
            try {
              send(delta, null);
              if (held) {
                entered.resolve();
                await release.promise;
              }
              send({}, toolReply ? 'stop' : 'tool_calls');
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              controller.close();
            } catch {
              /* Owned request may be cancelled during cleanup. */
            }
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const clients: ReturnType<typeof createClient>[] = [];
  let owner: ReturnType<typeof readDaemonReservation>;
  let completion: Promise<void> | undefined;
  function close(): Promise<void> {
    if (!completion)
      completion = (async () => {
        release.resolve();
        for (const value of clients) value.disposeNetwork();
        try {
          if (owner) {
            const current = readDaemonReservation(endpoint);
            if (
              current?.instanceId !== owner.instanceId ||
              current.pid !== owner.pid ||
              current.processStartIdentity !== owner.processStartIdentity
            )
              throw Error('fixture_cleanup_owner_changed');
            await stopDaemon!();
            await until(
              async () => inspectProcess(owner!.pid, owner!.processStartIdentity),
              (value) => value === 'dead',
            );
          }
        } finally {
          provider.stop(true);
        }
        cleanups.delete(close);
      })();
    return completion;
  }
  cleanups.add(close);
  try {
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    const skills = ['alpha', 'beta', 'ambiguous-a', 'ambiguous-b'];
    for (const id of skills) {
      const directory = join(base, 'skills', id);
      mkdirSync(join(directory, 'scripts'), { recursive: true });
      const name = id.startsWith('ambiguous')
        ? 'SharedName'
        : id === 'alpha'
          ? 'AlphaSkill'
          : 'BetaSkill';
      writeFileSync(
        join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: summary ${id}\n---\n${id.toUpperCase()}_FULL_BODY_${'正文'.repeat(5000)}_TAIL\n[helper](scripts/helper.sh)\n`,
      );
      writeFileSync(
        join(directory, 'scripts/helper.sh'),
        `echo unexpected > ${join(base, 'script-effect')}\n`,
      );
    }
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'configured',
        models: [
          {
            id: 'configured',
            provider: 'compatible',
            model: 'fixture',
            baseURL: `${provider.url.href}v1`,
            credentialRef: 'credential:11111111-1111-4111-8111-111111111111',
          },
        ],
        tools: [{ id: 'skills.load' }],
        skills: skills.map((id) => ({ id, path: `skills/${id}` })),
      }),
      { mode: 0o600 },
    );
    if (workflow) {
      writeFileSync(
        join(base, 'skills/alpha/SKILL.md'),
        `---\n${JSON.stringify(workflowManifest('alpha-skill', workflow === 'structured'))}\n---\nSHARED_WORKFLOW_INLINE_ORIGINAL_BODY\n`,
      );
      if (workflow !== 'disabled')
        writeFileSync(
          join(profile.profilePath, 'skill-workflow.jsonc'),
          JSON.stringify({
            version: 1,
            features: { skillActivation: true, skillWorkflow: true, verification: false },
          }),
          { mode: 0o600 },
        );
    }
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
      buildId: 'shared-skills-owned',
      daemon: {
        entrypoint: entry,
        entrypointSha256: hash(readFileSync(entry)),
        web: { directory: web, manifestSha256: hash(raw) },
      },
    };
    const daemon = (action: 'start' | 'stop') =>
      runSelectedDaemon({
        arguments: {
          kind: 'server',
          action,
          server: endpoint.socket,
          cancel: action === 'stop',
          json: false,
        },
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        cwd: base,
        artifact,
        write() {},
      });
    stopDaemon = () => daemon('stop');
    await daemon('start');
    owner = readDaemonReservation(endpoint);
    if (!owner) throw Error('fixture_original_owner_missing');
    const bootstrap = await requestDaemonBootstrap(endpoint, {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    });
    async function client(endpoint = bootstrap.httpEndpoint) {
      const value = createClient({
        endpoint,
        token: bootstrap.token,
        expected: {
          profile: bootstrap.profile,
          instanceId: bootstrap.instanceId,
          apiMajor: 1,
          requiredCapabilities: ['run_skill_selection'],
        },
      });
      clients.push(value);
      await value.connect();
      return value;
    }
    const a = await client(),
      b = await client(),
      storeId = a.serverInfo!.storeId!;
    await a.createWorkspace({
      expectedStoreId: storeId,
      id: 'workspace',
      rootUri: `file://${base}`,
      name: 'Owned',
    });
    async function session(id: string) {
      await a.createSession({
        expectedStoreId: storeId,
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: 'workspace',
        title: id,
      });
    }
    async function trust() {
      const value = await a.getWorkspaceTrust('workspace', { storeId });
      await a.setWorkspaceTrust('workspace', {
        expectedStoreId: storeId,
        commandId: 'trust',
        ifRevision: value.revision,
        trusted: true,
        canonicalIdentity: value.canonicalIdentity,
        externalReadScopeDigest: value.externalReadScopeDigest,
      });
    }
    async function finished(id: string, commandId: string) {
      return until(
        () => a.getView(id),
        (view) => view.runs.some((value) => value.originCommandId === commandId && !value.isActive),
      );
    }
    function intent(commandId: string, selectedSkills?: readonly string[], content = 'ordinary') {
      return {
        kind: 'run.start' as const,
        expectedStoreId: storeId,
        commandId,
        content,
        ...(selectedSkills === undefined ? {} : { selectedSkills: [...selectedSkills] }),
      };
    }
    async function argv(values: string[]) {
      const driver = join(base, 'workflow-cli-driver.ts');
      writeFileSync(
        driver,
        `import {runCLIProcess} from ${JSON.stringify(join(import.meta.dir, '../../host/main.ts'))}; try { process.exitCode=await runCLIProcess({dataRoot:${JSON.stringify(profile.dataRoot)},profile:${JSON.stringify(profile.profile)},cwd:${JSON.stringify(base)},resolveArtifact(){throw Error('shared_must_not_launch');}}); } catch(error) { process.stderr.write(String(error?.code ?? 'driver_failed')+'\\n');process.exitCode=1; }`,
      );
      const child = Bun.spawn([process.execPath, driver, ...values], {
        cwd: base,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      }
    }
    function countVault() {
      const path = join(base, 'vault-reads');
      return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0;
    }
    function sql<T>(query: string, ...params: string[]) {
      const db = new Database(profile.databasePath, { readonly: true });
      try {
        return db.query(query).all(...params) as T[];
      } finally {
        db.close();
      }
    }
    return {
      base,
      profile,
      endpoint,
      bootstrap,
      a,
      b,
      client,
      storeId,
      requests,
      entered,
      release,
      session,
      trust,
      finished,
      intent,
      countVault,
      argv,
      sql,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

nativeTest(
  'actual shared daemon seals two independent per-command Skill selections; bad selectors precede vault and Provider; CLI defaults remain configured',
  async () => {
    const f = await fixture();
    try {
      for (const id of ['a', 'b', 'bad', 'untrusted']) await f.session(id);
      for (const [id, choice, reason] of [
        ['unknown', '../outside/SKILL.md', 'skill_not_discovered'],
        ['ambiguous', 'SharedName', 'skill_selection_ambiguous'],
      ]) {
        await f.a.startRun('bad', f.intent(id!, [choice!]));
        const saved = await until(
          () => f.a.getCommand(id!),
          (value) => value.status === 'rejected',
        );
        expect(saved.receipt).toMatchObject({ reason });
        expect(f.countVault()).toBe(0);
        expect(f.requests).toHaveLength(0);
      }
      expect(f.sql('SELECT id FROM run')).toHaveLength(0);
      expect(f.sql('SELECT id FROM execution')).toHaveLength(0);
      await f.a.startRun('untrusted', f.intent('untrusted', ['alpha']));
      const denied = await f.finished('untrusted', 'untrusted');
      expect(
        denied.executions.some((value) => value.kind === 'tool' && value.status === 'failed'),
      ).toBe(true);
      expect(
        f.sql<{ dispatched: number; state: string }>(
          "SELECT dispatched,state FROM execution WHERE kind='tool' AND adapter_id='skills.load'",
        ),
      ).toEqual([{ dispatched: 0, state: 'failed' }]);
      expect(JSON.stringify(f.requests)).not.toContain('ALPHA_FULL_BODY_');
      expect((await f.a.getWorkspaceTrust('workspace', { storeId: f.storeId })).trusted).toBe(
        false,
      );
      expect(existsSync(join(f.base, 'script-effect'))).toBe(false);
      await f.trust();
      const startA = f.a.startRun('a', f.intent('alpha', ['AlphaSkill', 'alpha'], 'HOLD_ALPHA'));
      await until(
        async () =>
          f.requests.some((request) => JSON.stringify(request.messages).includes('HOLD_ALPHA')),
        Boolean,
      );
      await f.b.startRun('b', f.intent('beta', ['beta']));
      await f.finished('b', 'beta');
      const original = f.sql<{ config_json: string }>(
        'SELECT config_json FROM run WHERE origin_command_id=?',
        'alpha',
      )[0]!.config_json;
      f.release.resolve();
      await startA;
      await f.finished('a', 'alpha');
      const alpha = f.sql<{ config_json: string }>(
        'SELECT config_json FROM run WHERE origin_command_id=?',
        'alpha',
      )[0]!.config_json;
      const beta = f.sql<{ config_json: string }>(
        'SELECT config_json FROM run WHERE origin_command_id=?',
        'beta',
      )[0]!.config_json;
      expect(alpha).toBe(original);
      const facts = (config: string) => JSON.parse(config).snapshot.actualCapabilities.skills;
      expect(facts(alpha)).toEqual([
        {
          id: 'alpha',
          version: hash(readFileSync(join(f.base, 'skills/alpha/SKILL.md'))),
          requiredCapabilities: [],
        },
      ]);
      expect(facts(beta)).toEqual([
        {
          id: 'beta',
          version: hash(readFileSync(join(f.base, 'skills/beta/SKILL.md'))),
          requiredCapabilities: [],
        },
      ]);
      for (const id of ['alpha', 'beta']) {
        const body = readFileSync(join(f.base, `skills/${id}/SKILL.md`), 'utf8');
        expect(
          f.requests.some((request) =>
            JSON.stringify(request.messages).includes(JSON.stringify(body).slice(1, -1)),
          ),
        ).toBe(true);
      }
      const sources = f.sql<{ decision_source_json: string }>(
        "SELECT decision_source_json FROM execution WHERE kind='model'",
      );
      expect(sources.some((value) => value.decision_source_json.includes('skill.body:alpha'))).toBe(
        true,
      );
      expect(sources.some((value) => value.decision_source_json.includes('skill.body:beta'))).toBe(
        true,
      );
      expect(alpha).not.toContain('BetaSkill');
      expect(beta).not.toContain('AlphaSkill');
      const lines: string[] = [];
      for (const [kind, skills] of [
        ['run', ['alpha']],
        ['resume', ['beta']],
        ['resume', []],
      ] as const) {
        expect(
          await runSelectedCLI({
            arguments: {
              kind,
              task: 'CLI ordinary',
              thread: 'cli',
              server: f.endpoint.socket,
              skills: [...skills],
              trustWorkspace: false,
            },
            dataRoot: f.profile.dataRoot,
            profile: f.profile.profile,
            cwd: '/missing-local-cwd',
            write(line) {
              lines.push(line);
            },
            prompt() {},
            resolveArtifact() {
              throw Error('shared_must_not_resolve');
            },
            onLaunched() {
              throw Error('shared_must_not_launch');
            },
          }),
        ).toBe(0);
      }
      const configs = f.sql<{ config_json: string }>(
        "SELECT config_json FROM run WHERE session_id='cli' ORDER BY rowid",
      );
      expect(configs).toHaveLength(3);
      expect(facts(configs[0]!.config_json).map((item: { id: string }) => item.id)).toEqual([
        'alpha',
      ]);
      expect(facts(configs[1]!.config_json).map((item: { id: string }) => item.id)).toEqual([
        'beta',
      ]);
      expect(facts(configs[2]!.config_json)).toHaveLength(4);
      expect(inspectProcess(f.bootstrap.pid, f.bootstrap.processStartIdentity)).toBe('alive');
      expect(existsSync(join(f.base, 'script-effect'))).toBe(false);
    } finally {
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'shared Skills original command is immutable and a physically lost response performs one POST then original GET only',
  async () => {
    const f = await fixture();
    const sockets = new Set<Socket>();
    const requests: { method: string; path: string; body: unknown }[] = [];
    let lost = true;
    const relay = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const body = bytes.length ? JSON.parse(bytes.toString()) : undefined;
      requests.push({ method: request.method!, path: request.url!, body });
      const result = await fetch(`${f.bootstrap.httpEndpoint}${request.url}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${f.bootstrap.token}`,
          'content-type': 'application/json',
        },
        ...(bytes.length ? { body: bytes } : {}),
      });
      const output = Buffer.from(await result.arrayBuffer());
      if (request.method === 'POST' && body?.commandId === 'lost' && lost) {
        lost = false;
        request.socket.destroy();
        return;
      }
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(output);
    });
    relay.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    try {
      await f.session('original');
      await f.trust();
      const input = f.intent('same', ['alpha']);
      await f.a.startRun('original', input);
      await f.finished('original', 'same');
      const before = f.requests.length,
        reads = f.countVault();
      expect((await f.b.startRun('original', input)).id).toBe('same');
      await expect(
        f.b.startRun('original', { ...input, selectedSkills: ['beta'] }),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.requests).toHaveLength(before);
      expect(f.countVault()).toBe(reads);
      expect(f.sql('SELECT id FROM run')).toHaveLength(1);
      await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
      const client = await f.client(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
      const original = f.intent('lost', ['beta']);
      expect(
        (await run('original', original, { client, write() {}, timeoutMs: 5000 })).exitCode,
      ).toBe(0);
      const posts = requests.filter((value) => value.method === 'POST');
      expect(posts.map((value) => value.body)).toEqual([original]);
      expect(
        requests.some((value) => value.method === 'GET' && value.path.includes('/commands/lost')),
      ).toBe(true);
      expect(f.sql('SELECT id FROM run')).toHaveLength(2);
      expect(
        JSON.parse(
          f.sql<{ request_json: string }>('SELECT request_json FROM command WHERE id=?', 'lost')[0]!
            .request_json,
        ),
      ).toMatchObject({ selectedSkills: ['beta'] });
      expect(existsSync(join(f.base, 'script-effect'))).toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await f.close();
    }
  },
  30000,
);

nativeTest(
  'shared CLI explicit Workflow activation uses remote metadata and preserves selected guidance in one original request',
  async () => {
    const f = await fixture('enabled');
    try {
      await f.trust();
      const reply = await f.argv([
        'run',
        '--thread',
        'workflow',
        '--task',
        'shared original task',
        '--server',
        f.endpoint.socket,
        '--skill',
        'beta',
        '--activate-skill',
        'alpha-skill',
        '--full',
      ]);
      expect({ code: reply.code, stdout: reply.stdout, stderr: reply.stderr }).toMatchObject({
        code: 0,
        stderr: '',
      });
      expect(reply.stderr).toBe('');
      expect(f.requests.length).toBe(2);
      expect(JSON.stringify(f.requests[0]!.messages)).toContain(
        'SHARED_WORKFLOW_INLINE_ORIGINAL_BODY',
      );
      const rows = f.sql<{ request_json: string }>(
        "SELECT request_json FROM command WHERE kind='run.start'",
      );
      expect(rows.length).toBe(1);
      const request = JSON.parse(rows[0]!.request_json);
      expect(request.selectedSkills).toEqual(['beta']);
      expect(request.content).toBe('shared original task');
      expect(request.extensionInputs[0].input.activations).toEqual([
        { key: 'manual-1', skillId: 'skill:alpha-skill', input: {} },
      ]);
    } finally {
      await f.close();
    }
  },
  60000,
);

nativeTest(
  'shared CLI default-off or structured Workflow refuses without Provider or Run',
  async () => {
    for (const mode of ['disabled', 'structured'] as const) {
      const f = await fixture(mode);
      try {
        await f.trust();
        await expect(
          runSelectedCLI({
            arguments: parseCLIArguments([
              'run',
              '--task',
              'original task',
              '--server',
              f.endpoint.socket,
              '--activate-skill',
              mode === 'disabled' ? 'alpha' : 'alpha-skill',
              '--full',
            ]),
            dataRoot: f.profile.dataRoot,
            profile: f.profile.profile,
            cwd: f.base,
            write() {},
            prompt() {},
          }),
        ).rejects.toThrow(mode === 'disabled' ? 'workflow_disabled' : 'workflow_input_required');
        expect(f.requests.length).toBe(0);
        expect(f.sql('SELECT id FROM run').length).toBe(0);
        expect(f.sql("SELECT id FROM command WHERE kind='run.start'").length).toBe(0);
      } finally {
        await f.close();
      }
    }
  },
  60000,
);

nativeTest(
  'Workflow CLI original intent physically loses one response then only looks up its original command',
  async () => {
    const f = await fixture('enabled');
    const sockets = new Set<Socket>();
    const seen: { method: string; path: string; body: unknown }[] = [];
    let lost = false;
    const relay = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const body = bytes.length ? JSON.parse(bytes.toString()) : undefined;
      seen.push({ method: request.method!, path: request.url!, body });
      const result = await fetch(`${f.bootstrap.httpEndpoint}${request.url}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${f.bootstrap.token}`,
          'content-type': 'application/json',
        },
        ...(bytes.length ? { body: bytes } : {}),
      });
      const output = Buffer.from(await result.arrayBuffer());
      if (request.method === 'POST' && body?.commandId === 'workflow-lost' && !lost) {
        lost = true;
        request.socket.destroy();
        return;
      }
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(output);
    });
    relay.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    try {
      await f.session('original');
      await f.trust();
      const mode = await f.a.getPermissionMode('original', { storeId: f.storeId });
      await f.a.setPermissionMode('original', {
        expectedStoreId: f.storeId,
        commandId: 'full',
        ifRevision: mode.revision,
        ifDefaultRevision: mode.defaultRevision,
        makeDefault: false,
        mode: 'full',
      });
      await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
      const client = await f.client(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
      const page = await client.listAllSkills('workspace', {
        storeId: f.storeId,
        workflow: 'manual',
      });
      const original = Object.freeze({
        ...f.intent('workflow-lost', ['beta'], 'original task'),
        extensionInputs: [
          {
            extensionId: 'builtin.skill-workflow',
            definitionVersion: '1',
            input: { activations: selectWorkflowActivations(page, ['alpha-skill']) },
          },
        ],
      });
      expect(
        (await run('original', original, { client, write() {}, timeoutMs: 5000 })).exitCode,
      ).toBe(0);
      expect(lost).toBe(true);
      expect(seen.filter((value) => value.method === 'POST').map((value) => value.body)).toEqual([
        original,
      ]);
      expect(
        seen.some(
          (value) => value.method === 'GET' && value.path.includes('/commands/workflow-lost'),
        ),
      ).toBe(true);
      expect(f.sql('SELECT id FROM run').length).toBe(1);
      expect(f.requests.length).toBe(2);
      const saved = JSON.parse(
        f.sql<{ request_json: string }>(
          'SELECT request_json FROM command WHERE id=?',
          'workflow-lost',
        )[0]!.request_json,
      );
      expect(saved.extensionInputs).toEqual(original.extensionInputs);
      expect(saved.selectedSkills).toEqual(['beta']);
    } finally {
      for (const socket of sockets) socket.destroy();
      if (relay.listening) await new Promise<void>((resolve) => relay.close(() => resolve()));
      await f.close();
    }
  },
  60000,
);

nativeTest(
  'shared CLI activation on a held Run seals follow-up without changing the original Run',
  async () => {
    const f = await fixture('enabled');
    try {
      await f.trust();
      await f.session('active');
      await f.a.setPermissionMode('active', {
        expectedStoreId: f.storeId,
        commandId: 'active-full',
        ifRevision: '0',
        ifDefaultRevision: '0',
        makeDefault: false,
        mode: 'full',
      });
      await f.a.startRun('active', f.intent('held-original', ['beta'], 'HOLD_ALPHA'));
      await until(
        async () => f.requests.length,
        (value) => value === 1,
      );
      const before = await f.a.getView('active');
      const held = before.runs.find((r) => r.isActive)!;
      const pending = f.argv([
        'resume',
        '--thread',
        'active',
        '--task',
        'activation after held',
        '--server',
        f.endpoint.socket,
        '--activate-skill',
        'alpha-skill',
        '--skill',
        'beta',
      ]);
      await until(
        async () =>
          f.sql<{ request_json: string }>(
            "SELECT request_json FROM command WHERE kind='input.follow_up'",
          ),
        (rows) => rows.length === 1,
      );
      const request = JSON.parse(
        f.sql<{ request_json: string }>(
          "SELECT request_json FROM command WHERE kind='input.follow_up'",
        )[0]!.request_json,
      );
      expect(request.afterRunId).toBe(held.id);
      expect(request.contextSelectionId).toBe(before.session.contextSelectionId);
      expect(request.selectedSkills).toEqual(['beta']);
      expect(request.content).toBe('activation after held');
      expect(request.extensionInputs[0].input.activations).toEqual([
        { key: 'manual-1', skillId: 'skill:alpha-skill', input: {} },
      ]);
      expect(await f.a.getRun(held.id)).toEqual(held);
      expect(f.requests.length).toBe(1);
      f.release.resolve();
      const reply = await pending;
      expect({ code: reply.code, stdout: reply.stdout, stderr: reply.stderr }).toMatchObject({
        code: 0,
        stderr: '',
      });
      const after = await f.a.getView('active');
      expect(after.runs.length).toBe(2);
      const original = f.sql<{ request_json: string }>(
        "SELECT request_json FROM command WHERE id='held-original'",
      );
      expect(JSON.parse(original[0]!.request_json).extensionInputs).toBeUndefined();
      expect(
        f.requests.some((r) =>
          JSON.stringify(r.messages).includes('SHARED_WORKFLOW_INLINE_ORIGINAL_BODY'),
        ),
      ).toBe(true);
      expect(f.sql("SELECT id FROM command WHERE kind='input.follow_up'").length).toBe(1);
    } finally {
      await f.close();
    }
  },
  60000,
);
