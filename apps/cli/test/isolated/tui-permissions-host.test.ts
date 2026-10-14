import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { ptyDeadline } from '../fixtures/tui-pty';

const repo = resolve(import.meta.dir, '../../../..');
test('built Service and actual PTY permission controls create exact Shell grants, clear only selected Session, no default approval', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-permissions-'))),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  const evidence = join(tmpdir(), `kite-tui-permissions-evidence-${randomUUID()}`);
  mkdirSync(evidence, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  // This fixture asserts English labels independently of the host device locale.
  mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  let calls = 0,
    reviewCalls = 0;
  let passed = false;
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const review = body.messages.some((message) => {
        if (message.role !== 'user') return false;
        try {
          return JSON.parse(message.content).purpose === 'authorization_review';
        } catch {
          return false;
        }
      });
      if (review) {
        reviewCalls++;
        const delta = {
          content: JSON.stringify({
            decision: 'ask_user',
            reason: 'Confirm the exact original same-command authorization',
          }),
        };
        return new Response(
          `data: ${JSON.stringify({ id: 'review', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      calls++;
      const last = body.messages.reduce(
          (last, m, i) => (m.role === 'user' && /^owned-[123]$/.test(m.content) ? i : last),
          -1,
        ),
        key = body.messages[last]!.content,
        results = body.messages.slice(last + 1).filter((m) => m.role === 'tool');
      const call =
        results.length === 0
          ? {
              name: 'shell.launch',
              input: { key, command: "printf 'owned\\n' >> effects", cancellation: 'attached' },
            }
          : results.length === 1
            ? { name: 'shell.wait', input: { shellId: key, timeoutMs: 4000 } }
            : undefined;
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call${calls}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              },
            ],
          }
        : { content: `DONE ${key}` };
      const frame = (d: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${frame(delta, null)}${frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  try {
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        tools: ['shell.launch', 'shell.wait'].map((id) => ({ id, definitionVersion: '1' })),
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const artifactRoot = join(root, 'artifact');
    await buildOwnedDaemon(artifactRoot);
    const defaultMain = join(artifactRoot, 'node_modules/@kite-ai/service/main.js');
    const fixture = join(root, 'service.ts');
    writeFileSync(
      fixture,
      `import {runServiceProcess} from ${JSON.stringify(pathToFileURL(defaultMain).href)};await runServiceProcess();`,
    );
    const built = await Bun.build({
      entrypoints: [fixture],
      outdir: join(root, 'built'),
      target: 'bun',
      packages: 'external',
      external: [pathToFileURL(defaultMain).href],
    });
    expect(built.success).toBe(true);
    const entrypoint = built.outputs[0]!.path,
      sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
      artifact = {
        entrypoint,
        entrypointSha256: sha(readFileSync(entrypoint)),
        executable: realpathSync(process.execPath),
        executableSha256: sha(readFileSync(process.execPath)),
        buildId: 'owned-permission-host',
        apiMajor: 1,
      };
    const seed = await launchPairedService({
      profile,
      ...artifact,
      instanceId: crypto.randomUUID(),
      requiredCapabilities: ['sessions', 'permission_controls', 'permission_grants'],
    });
    try {
      const expectedStoreId = seed.bootstrap.storeId!;
      await seed.client.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'owned',
      });
      await seed.client.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 'a',
        workspaceId: 'w',
        title: 'permissions',
      });
    } finally {
      await seed.close();
    }
    const runner = join(root, 'runner.ts');
    writeFileSync(
      runner,
      `import {writeFileSync} from 'node:fs';import {runTUIHost} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};await runTUIHost({testDiagnostics:true,artifact:${JSON.stringify(artifact)},dataRoot:${JSON.stringify(profile.dataRoot)},profile:'development',thread:'a',cwd:${JSON.stringify(workspace)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(join(root, 'owned-service-pid'))},String(pid))});`,
    );
    child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        join(import.meta.dir, '../fixtures/tui-permissions-driver.ts'),
        JSON.stringify({ runner, root, databasePath: profile.databasePath, workspace, evidence }),
      ],
      { stdout: 'pipe', stderr: 'pipe', ...(process.platform === 'win32' ? { ipc() {} } : {}) },
    );
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    writeFileSync(join(evidence, 'driver.log'), out + err);
    if (exit !== 0) console.error(out, err);
    expect(exit).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('PERMISSIONS_ORIGINAL_COMPLETE');
    expect(readFileSync(join(workspace, 'effects'), 'utf8')).toBe('owned\nowned\n');
    expect(calls).toBe(7);
    expect(reviewCalls).toBe(3);
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      expect(
        db.query('SELECT count(*) AS n FROM interaction WHERE answer_json IS NOT NULL').get(),
      ).toEqual({ n: 2 });
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM host_mutation WHERE kind='permission.grants.clear' AND state='applied'",
          )
          .get(),
      ).toEqual({ n: 1 });
      writeFileSync(
        join(evidence, 'facts.json'),
        JSON.stringify({
          calls,
          reviewCalls,
          effects: readFileSync(join(workspace, 'effects'), 'utf8'),
          defaultMainSHA: sha(readFileSync(defaultMain)),
          compiledEntrypointSHA: artifact.entrypointSha256,
          executions: db
            .query('select kind,adapter_id,state,cancel_requested from execution')
            .all(),
          interactions: db
            .query(
              'select definition_id,state,accepted_decision_revision,answer_json from interaction',
            )
            .all(),
          commands: db.query('select kind,status,request_json,receipt_json from command').all(),
        }),
      );
    } finally {
      db.close();
    }
    passed = true;
  } finally {
    if (child?.exitCode === null) {
      if (process.platform === 'win32') child.send('permissions-driver-stop');
      else child.kill('SIGTERM');
      await ptyDeadline(child.exited, 3000, 'permission driver cleanup unconfirmed');
    }
    console.error(
      JSON.stringify({ evidence, calls, reviewCalls, retainedRoot: passed ? null : root }),
    );
    provider.stop(true);
    if (passed) rmSync(root, { recursive: true, force: true });
  }
}, 40000);
