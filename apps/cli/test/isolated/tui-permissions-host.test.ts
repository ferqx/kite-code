import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { launchPairedService } from '@kite-ai/service/paired';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';
import { ptyDeadline } from '../fixtures/tui-pty';

const repo = resolve(import.meta.dir, '../../../..');
test('built Service and actual PTY permission controls create exact Shell grants, clear only selected Session, no default approval', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-permissions-'))),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  const userConfiguration = ownedUserConfiguration(root);
  const evidence = join(tmpdir(), `kite-tui-permissions-evidence-${randomUUID()}`);
  privateDirectory(evidence);
  privateDirectory(workspace);
  privateDirectory(profile.profilePath);
  // This fixture asserts English labels independently of the host device locale.
  privateDirectory(join(profile.profilePath, 'ui'));
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
          (last, m, i) =>
            m.role === 'user' && /^(?:New task: )?owned-[123]$/.test(m.content) ? i : last,
          -1,
        ),
        key = body.messages[last]!.content.replace(/^New task: /, ''),
        results = body.messages.slice(last + 1).filter((m) => m.role === 'tool');
      const call =
        results.length === 0
          ? {
              name: 'shell_launch',
              input: { key, command: "printf 'owned\\n' >> effects", cancellation: 'attached' },
            }
          : results.length === 1
            ? { name: 'shell_wait', input: { shell_id: key, wait_timeout_ms: 4000 } }
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
      userConfiguration.path,
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
      spawnChild: userConfiguration.spawnChild,
      profile,
      ...artifact,
      instanceId: crypto.randomUUID(),
      requiredCapabilities: ['sessions', 'permission_controls', 'permission_grants'],
    });
    const expectedStoreId = seed.bootstrap.storeId!;
    try {
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
        JSON.stringify({
          runner,
          root,
          storeId: expectedStoreId,
          databasePath: profile.databasePath,
          workspace,
          evidence,
        }),
      ],
      {
        env: { ...process.env, ...userConfiguration.homeEnvironment },
        stdout: 'pipe',
        stderr: 'pipe',
        ...(process.platform === 'win32' ? { ipc() {} } : {}),
      },
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
    const proofStore = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    const proofRuntime = createRuntime({
      store: proofStore,
      permissions: { authorize: async () => ({ allowed: false, revision: 'readonly-proof' }) },
    });
    const proofDb = new Database(profile.databasePath, { readonly: true });
    try {
      const before = (await proofStore.getMetadata()).lastChangeCursor;
      for (const expected of [
        { content: 'owned-1', models: 3 },
        { content: 'New task: owned-2', models: 3 },
        { content: 'New task: owned-3', models: 1 },
      ]) {
        const originals = proofDb
          .query(
            "SELECT id FROM command WHERE kind='run.start' AND root_work_command_id=id AND json_extract(request_json,'$.content')=?",
          )
          .all(expected.content) as { id: string }[];
        expect(originals).toHaveLength(1);
        const original = (await proofStore.getCommand(originals[0]!.id))!;
        const receipt = original.receipt as {
          businessCommandId?: string;
          humanInputCommandId?: string;
          runId: string;
        };
        const businessId = receipt.businessCommandId ?? original.id;
        expect(original.status).toBe('applied');
        const run = (await proofStore.getRun(receipt.runId))!;
        expect(run).toMatchObject({ originCommandId: businessId, rootWorkCommandId: original.id });
        if (expected.content.startsWith('New task:')) {
          expect(receipt.businessCommandId).toBeString();
          expect(businessId).not.toBe(original.id);
          expect(await proofStore.getCommand(receipt.humanInputCommandId!)).toMatchObject({
            request: {
              publicCommandId: original.id,
              content: expected.content,
              originalRequest: original.request,
            },
            receipt: { businessCommandId: businessId, state: 'decided' },
          });
          expect(await proofStore.getCommand(businessId)).toMatchObject({
            status: 'applied',
            receipt: { runId: run.id },
          });
        }
        const models = (await proofStore.listExecutions(original.sessionId)).filter(
          (execution) => execution.kind === 'model' && execution.runId === run.id,
        );
        expect(models).toHaveLength(expected.models);
        const input = await proofRuntime.readModelInput({
          expectedStoreId: original.originStoreId,
          sessionId: original.sessionId,
          subjectId: original.subjectId,
          executionId: models[0]!.id,
        });
        expect(input.confirmation).toBe('succeeded');
        expect(
          input.request.messages.find((message) => message.sourceIds?.includes(businessId)),
        ).toMatchObject({ content: expected.content, sourceIds: [businessId] });
        expect(run.status).toBe(expected.content.endsWith('owned-3') ? 'cancelled' : 'completed');
        if (expected.content.endsWith('owned-3')) {
          const cancel = proofDb
            .query(
              "SELECT request_json FROM command WHERE kind='command.cancel' AND json_extract(request_json,'$.targetCommandId')=?",
            )
            .all(businessId);
          expect(cancel).toHaveLength(1);
        }
      }
      expect((await proofStore.getMetadata()).lastChangeCursor).toBe(before);
    } finally {
      proofDb.close();
      await proofRuntime.close();
    }

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
