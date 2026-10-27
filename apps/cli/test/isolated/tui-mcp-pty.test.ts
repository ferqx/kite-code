import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import {
  createClient,
  readOrdinaryCommandApplication,
  requiresInteractionAttachment,
} from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import type { CLIServiceArtifact } from '../../host';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import { openTuiDraftFile } from '../../host/tui-drafts';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw Error('owned_mcp_pty_deadline');
    await Bun.sleep(20);
  }
}

test('80x24 source-free MCP selection and clear preserve original pending work and complete history', async () => {
  const root = temporaryDirectory('kite-tui-mcp-pty-');
  const evidenceRoot = join(tmpdir(), `kite-tui-mcp-pty-evidence-${randomUUID()}`);
  privateDirectory(evidenceRoot);
  const workspace = join(root, 'workspace');
  privateDirectory(join(root, 'build'));
  privateDirectory(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  let reviewCalls = 0;
  let calls = 0,
    rpc = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; content: string | null }[];
      };
      const review = body.messages.some((message) => {
        if (message.role !== 'user' || !message.content) return false;
        try {
          return JSON.parse(message.content).purpose === 'authorization_check';
        } catch {
          return false;
        }
      });
      if (review) {
        reviewCalls++;
        const delta = {
          content: JSON.stringify({
            decision: 'ask_user',
            reason: 'explicit original operation approval',
          }),
        };
        return new Response(
          `data: ${JSON.stringify({ id: 'review', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      calls++;
      const delta =
        calls === 1 || calls === 3
          ? { content: 'ORIGINAL_COMPLETE_HISTORY_TAIL' }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: 'original-write',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({
                      path: calls === 2 ? 'effect.txt' : 'effect-next.txt',
                      base: null,
                      content: 'owned authorized file effect',
                    }),
                  },
                },
              ],
            };
      return new Response(
        `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: calls === 1 || calls === 3 ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      rpc++;
      return new Response('must not connect', { status: 500 });
    },
  });
  let observer: ReturnType<typeof createClient> | undefined;
  let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let stdout = '',
    stderr = '';
  let control: ReturnType<typeof Bun.serve> | undefined;
  const receipts: Record<string, unknown>[] = [];
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        join(repo, 'scripts/release/terminal.ts'),
        'build',
        '--directory',
        join(root, 'build/candidate'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [buildOut, buildErr, buildExit] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    writeFileSync(join(evidenceRoot, 'candidate-build.log'), buildOut + buildErr);
    if (buildExit !== 0) throw Error('source_free_candidate_build_failed');
    const candidate = verifyTerminalBundle(join(root, 'build/candidate'));
    symlinkSync(
      join(candidate.root, 'node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const built = await Bun.build({
      entrypoints: [join(repo, 'apps/cli/test/fixtures/tui-mcp-pty.ts')],
      target: 'bun',
      packages: 'external',
      outdir: root,
    });
    expect(built.success).toBe(true);
    const entrypoint = join(root, 'tui-mcp-pty.js');
    const artifact: CLIServiceArtifact = {
      executable: candidate.artifact.executable,
      executableSha256: candidate.artifact.executableSha256,
      apiMajor: 1,
      entrypoint,
      entrypointSha256: sha(readFileSync(entrypoint)),
      buildId: `mcp-pty-${sha(readFileSync(entrypoint))}`,
    };
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        root,
        workspace,
        dataRoot: profile.dataRoot,
        mcpUrl: remote.url.href,
        artifact,
      }),
      { mode: 0o600 },
    );
    privateDirectory(join(profile.profilePath, 'ui'));
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    const configPath = join(profile.profilePath, 'config.jsonc'),
      projectPath = join(workspace, 'kite-agent.jsonc');
    writeFileSync(
      configPath,
      `// USER COMMENT\n${JSON.stringify({ unknown: { keep: true }, modelId: 'fixed', tools: [{ id: 'files.write', definitionVersion: '3' }], models: [{ id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` }], mcp: [{ id: 'owned-server', enabled: false }] })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(projectPath, '// PROJECT COMMENT\n{"unknown":42}\n', { mode: 0o600 });
    const seed = await launchPairedService({
      profile,
      ...artifact,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands', 'permission_controls'],
    });
    let storeId = '',
      historyIds: string[] = [];
    try {
      if (!seed.bootstrap.storeId) throw Error('seed_store_unavailable');
      storeId = seed.bootstrap.storeId;
      await seed.client.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'owned',
      });
      for (const id of ['a', 'b'])
        await seed.client.createSession({
          expectedStoreId: storeId,
          commandId: `create-${id}`,
          sessionId: id,
          workspaceId: 'w',
          title: id,
        });
      const trust = await seed.client.getWorkspaceTrust('w', { storeId });
      await seed.client.setWorkspaceTrust('w', {
        expectedStoreId: storeId,
        commandId: 'trust',
        trusted: true,
        ifRevision: trust.revision,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
      });
      const mode = await seed.client.getPermissionMode('a', { storeId });
      await seed.client.setPermissionMode('a', {
        expectedStoreId: storeId,
        commandId: 'ask',
        ifRevision: mode.revision,
        mode: 'auto',
        makeDefault: false,
        ifDefaultRevision: mode.defaultRevision,
      });
      await seed.client.startRun('a', {
        expectedStoreId: storeId,
        commandId: 'original-history',
        kind: 'run.start',
        content: 'complete original history',
      });
      await until(async () => {
        const view = await seed.client.getView('a');
        return view.runs.length === 1 && view.runs[0]!.status === 'completed' ? view : undefined;
      });
      historyIds = (await seed.client.getView('a')).messages.map((message) => message.id);
    } finally {
      await seed.close();
    }
    const access = acquireProfileAccess(profile);
    try {
      const draft = openTuiDraftFile({
        access,
        acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
      });
      try {
        draft.save({ storeId, workspaceId: 'w', sessionId: 'b' }, '0', 'PRESERVED_PRIVATE_DRAFT');
      } finally {
        draft.close();
      }
    } finally {
      access.lock.release();
    }
    const initialConfig = readFileSync(configPath, 'utf8');
    let originalCompleted = false;
    let expectedCalls = 2;
    let clearMessages = '';
    let originalRun = '',
      originalCard = '',
      originalRevision = '',
      originalCommand = '';
    async function connected() {
      if (observer) return observer;
      const privateRow = JSON.parse(readFileSync(join(root, 'observer-private.json'), 'utf8')) as {
        endpoint: string;
        token: string;
      };
      observer = createClient({
        ...privateRow,
        expected: {
          profile: {
            dataRoot: profile.dataRoot,
            name: profile.profile,
            accessKey: profile.profileAccessKey,
          },
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands', 'interactions'],
        },
      });
      await observer.connect();
      return observer;
    }
    async function preserved() {
      const client = await connected(),
        view = await client.getView('a');
      const active = view.runs.find((run) => run.id === originalRun);
      if (
        !active ||
        (originalCompleted
          ? active.status !== 'completed'
          : !active.isActive || active.status !== 'waiting_interaction')
      )
        throw Error('original_run_changed');
      const cards = await client.listInteractions('a', {
        storeId,
        state: originalCompleted ? 'answered' : 'pending',
        limit: 20,
      });
      const card = cards.interactions.find((row) => row.id === originalCard);
      if (!card || card.revision !== originalRevision) throw Error('original_interaction_changed');
      if (!historyIds.every((id) => view.messages.some((message) => message.id === id)))
        throw Error('original_history_removed');
      if ((await client.getCommand(originalCommand)).cancelRequestedAt !== null)
        throw Error('original_command_cancelled');
      if (
        calls !== expectedCalls ||
        rpc !== 0 ||
        existsSync(join(root, 'credential-io')) ||
        existsSync(join(root, 'mcp-admit')) ||
        existsSync(join(workspace, 'effect-next.txt'))
      )
        throw Error(
          `read_caused_effect:${JSON.stringify({
            calls,
            expectedCalls,
            rpc,
            credentialIo: existsSync(join(root, 'credential-io')),
            mcpAdmit: existsSync(join(root, 'mcp-admit')),
            nextEffect: existsSync(join(workspace, 'effect-next.txt')),
          })}`,
        );
      const drafts = JSON.parse(readFileSync(join(profile.profilePath, 'ui/tui.json'), 'utf8')) as {
        drafts: { sessionId: string; text: string }[];
      };
      if (
        !drafts.drafts.some(
          (row) => row.sessionId === 'b' && row.text === 'PRESERVED_PRIVATE_DRAFT',
        )
      )
        throw Error('private_draft_removed');
      return view;
    }
    control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        try {
          const path = new URL(request.url).pathname,
            client = await connected();
          if (path === '/baseline') {
            const view = await client.getView('a'),
              run = view.runs.find((row) => row.isActive)!;
            originalRun = run.id;
            originalCommand = run.originCommandId;
            const cards = await client.listInteractions('a', {
              storeId,
              state: 'pending',
              limit: 20,
            });
            const card = cards.interactions.find((row) => row.runId === originalRun)!;
            originalCard = card.id;
            originalRevision = card.revision;
          } else if (path === '/before-confirm') {
            if (readFileSync(configPath, 'utf8') !== initialConfig)
              throw Error('confirmation_wrote_early');
          } else if (path === '/approve-job') {
            const ledger = readFileSync(join(root, 'http-ledger.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .map((row) => JSON.parse(row)) as {
              method: string;
              body?: { commandId?: string; kind?: string };
            }[];
            const posts = ledger.filter(
              (row) => row.method === 'POST' && row.body?.kind === 'extension.invoke',
            );
            if (posts.length !== 1) throw Error('mcp_post_count');
            const queued = await client.getCommand(posts[0]!.body!.commandId!);
            receipts.push({ stage: 'queued_original_mcp_observed', command: queued });
            if (queued.status !== 'accepted' || readFileSync(configPath, 'utf8') !== initialConfig)
              throw Error('queued_mcp_misreported');
            await preserved();
            receipts.push({
              stage: 'accepted_before_original_completion',
              commandId: queued.id,
              status: queued.status,
              receipt: queued.receipt,
            });
            const original = (
              await client.listInteractions('a', { storeId, state: 'pending', limit: 20 })
            ).interactions.find((row) => row.id === originalCard)!;
            if (requiresInteractionAttachment(original))
              await client.readInteractionAttachment(original);
            await client.answerInteraction('a', original.id, {
              expectedStoreId: storeId,
              commandId: 'approve-owned-original-file',
              expectedRevision: original.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
            await until(async () => {
              const run = await client.getRun(originalRun);
              return run.status === 'completed' ? run : undefined;
            });
            const answeredOriginal = (
              await client.listInteractions('a', { storeId, state: 'answered', limit: 20 })
            ).interactions.find((row) => row.id === originalCard);
            if (!answeredOriginal) throw Error('original_answer_unconfirmed');
            originalRevision = answeredOriginal.revision;
            originalCompleted = true;
            expectedCalls = 3;
            const command = await until(async () => {
              const row = await client.getCommand(posts[0]!.body!.commandId!);
              return row.status === 'applied' ? row : undefined;
            });
            const executionId = (command.receipt as { executionId: string }).executionId;
            const card = await until(async () =>
              (
                await client.listInteractions('a', { storeId, state: 'pending', limit: 20 })
              ).interactions.find((row) => row.executionId === executionId),
            );
            if (requiresInteractionAttachment(card)) await client.readInteractionAttachment(card);
            await client.answerInteraction('a', card.id, {
              expectedStoreId: storeId,
              commandId: 'approve-original-mcp-job',
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
            const execution = await until(async () => {
              const row = await client.getExecution(executionId);
              return row.status === 'succeeded' ? row : undefined;
            });
            receipts.push({
              commandId: command.id,
              executionId: execution.id,
              result: execution.result,
            });
          } else if (path === '/new-pending') {
            const commandId = 'second-pending-work';
            await client.startRun('a', {
              expectedStoreId: storeId,
              commandId,
              kind: 'run.start',
              content: 'New task: second owned pending task',
            });
            const { view, application, command } = await until(async () => {
              const command = await client.getCommand(commandId);
              if (command.status !== 'applied') return undefined;
              const application = await readOrdinaryCommandApplication(client, command);
              if (!application?.run || application.observation)
                throw Error('second_pending_work_has_no_business_run');
              if (application.run.status !== 'waiting_interaction') return undefined;
              return { view: await client.getView('a'), application, command };
            });
            const run = application.run!;
            expect(run.originCommandId).toBe(application.sourceCommandId);
            expect(run.rootWorkCommandId).toBe(commandId);
            expect(command.id).toBe(commandId);
            expect(command.kind).toBe('run.start');
            expect(application.sourceCommandId).toBe(commandId);
            expect(command.receipt).toEqual({ runId: run.id });
            originalRun = run.id;
            originalCommand = application.sourceCommandId;
            receipts.push({
              stage: 'second_pending_business_bound',
              commandId: command.id,
              businessCommandId: application.sourceCommandId,
              runId: run.id,
            });
            originalCompleted = false;
            expectedCalls = 4;
            const card = (
              await client.listInteractions('a', { storeId, state: 'pending', limit: 20 })
            ).interactions.find((row) => row.runId === originalRun)!;
            originalCard = card.id;
            originalRevision = card.revision;
            clearMessages = JSON.stringify(view.messages);
          }
          const view = await preserved();
          if (
            (path === '/clear' || path === '/draft-clear') &&
            JSON.stringify(view.messages) !== clearMessages
          )
            throw Error('clear_changed_complete_history');
          receipts.push({
            stage: path,
            storeId,
            originalRun,
            originalCommand,
            originalCard,
            originalRevision,
            calls,
            rpc,
          });
          return Response.json({ passed: true });
        } catch (error) {
          writeFileSync(
            join(evidenceRoot, 'control-error.json'),
            JSON.stringify({
              path: new URL(request.url).pathname,
              code: error instanceof Error ? error.message : 'unknown',
            }),
          );
          return new Response(error instanceof Error ? error.message : 'control_failed', {
            status: 500,
          });
        }
      },
    });
    driver = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        join(import.meta.dir, '../fixtures/tui-mcp-selection-driver.ts'),
        JSON.stringify({
          executable: artifact.executable,
          entrypoint,
          root,
          evidence: evidenceRoot,
          controlUrl: control.url.href,
        }),
      ],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: root,
        ...(process.platform === 'win32' ? { ipc() {} } : {}),
      },
    );
    const outputs = await Promise.all([
      new Response(driver.stdout).text(),
      new Response(driver.stderr).text(),
      driver.exited,
    ]);
    stdout = outputs[0];
    stderr = outputs[1];
    expect(outputs[2]).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ pty: true, columns: 80, rows: 24, exit: 0 });
    expect(receipts.some((row) => row.stage === '/clear')).toBe(true);
    expect(receipts.some((row) => row.stage === '/draft-clear')).toBe(true);
    expect(calls).toBe(4);
    expect(reviewCalls).toBe(2);
    expect(rpc).toBe(0);
    expect(readFileSync(join(workspace, 'effect.txt'), 'utf8')).toBe(
      'owned authorized file effect',
    );
    expect(existsSync(join(workspace, 'effect-next.txt'))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toContain('// USER COMMENT');
    expect(readFileSync(configPath, 'utf8')).toContain('"keep":true');
    expect(readFileSync(configPath, 'utf8')).toContain('"enabled":true');
    expect(readFileSync(projectPath, 'utf8')).toBe('// PROJECT COMMENT\n{"unknown":42}\n');
    const pid = Number(readFileSync(join(root, 'owned-pid'), 'utf8'));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    const uiRequests = readFileSync(join(root, 'http-ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row)) as {
      method: string;
      path: string;
      body?: { kind?: string };
    }[];
    expect(
      uiRequests.filter((row) => row.method === 'POST' && row.body?.kind === 'extension.invoke'),
    ).toHaveLength(1);
    expect(
      uiRequests.filter(
        (row) =>
          row.method === 'POST' &&
          (row.path.endsWith('/cancel') ||
            ['run.cancel', 'command.cancel'].includes(row.body?.kind ?? '')),
      ),
    ).toHaveLength(0);
    const reopened = await launchPairedService({
      profile,
      ...artifact,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands'],
    });
    try {
      expect(reopened.bootstrap.storeId).toBe(storeId);
      expect((await reopened.client.getView('a')).messages.map((row) => row.id)).toEqual(
        expect.arrayContaining(historyIds),
      );
      expect(calls).toBe(4);
      expect(reviewCalls).toBe(2);
    } finally {
      await reopened.close();
    }
    writeFileSync(join(evidenceRoot, 'helper.js'), readFileSync(entrypoint));
    writeFileSync(join(evidenceRoot, 'user-config.jsonc'), readFileSync(configPath));
    writeFileSync(join(evidenceRoot, 'project-config.jsonc'), readFileSync(projectPath));
    writeFileSync(
      join(evidenceRoot, 'receipts.json'),
      JSON.stringify(
        {
          candidateId: candidate.candidateId,
          helperSha256: artifact.entrypointSha256,
          storeId,
          historyIds,
          ownedServicePid: pid,
          tui: JSON.parse(stdout),
          uiMcpPostCount: uiRequests.filter(
            (row) => row.method === 'POST' && row.body?.kind === 'extension.invoke',
          ).length,
          receipts,
          calls,
          rpc,
          cleanupConfirmed: true,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        case: 'actual_mcp_pty_clear',
        evidenceRoot,
        storeId,
        originalRun,
        originalCommand,
        originalCard,
        calls,
        rpc,
        helperSha256: artifact.entrypointSha256,
      }),
    );
  } finally {
    writeFileSync(join(evidenceRoot, 'stage-receipts.json'), JSON.stringify(receipts, null, 2));
    writeFileSync(join(evidenceRoot, 'stdout.log'), stdout);
    writeFileSync(join(evidenceRoot, 'stderr.log'), stderr);
    if (existsSync(join(root, 'startup-ledger')))
      writeFileSync(
        join(evidenceRoot, 'startup-ledger'),
        readFileSync(join(root, 'startup-ledger')),
      );
    if (existsSync(join(root, 'http-ledger.jsonl')))
      writeFileSync(
        join(evidenceRoot, 'http-ledger.jsonl'),
        readFileSync(join(root, 'http-ledger.jsonl')),
      );
    if (driver?.exitCode === null) {
      if (process.platform === 'win32') driver.send('mcp-selection-driver-stop');
      else driver.kill('SIGINT');
      const { ptyDeadline } = await import('../fixtures/tui-pty');
      await ptyDeadline(driver.exited, 5000, 'owned_mcp_selection_driver_cleanup_unconfirmed');
    }
    observer?.disposeNetwork();
    await control?.stop(true);
    await provider.stop(true);
    await remote.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 180000);
