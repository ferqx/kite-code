import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Store } from '@kite-ai/agent/storage';
import { launchPairedService, type PairedServiceChild } from '../../src/paired';

type ProviderBody = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string; parameters: unknown } }[];
};

test('one ordinary Run retains complete project sources across 257 distinct Files reads and cold history does not replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-long-run-sources-'))),
    workspace = join(root, 'workspace'),
    ownedHome = join(root, 'home'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const lines = Array.from({ length: 260 }, (_, index) => `Original instruction ${index + 1} 雪🙂`),
    agents = `${lines.join('\n')}\n`,
    finalBody = 'LONG_RUN_ORIGINAL_COMPLETE 雪🙂\nAll 257 original read results retained.\nEND';
  const requests: ProviderBody[] = [],
    ownedChildren: PairedServiceChild[] = [],
    failures: unknown[] = [];
  let provider: ReturnType<typeof Bun.serve> | undefined,
    child: Awaited<ReturnType<typeof launchPairedService>> | undefined,
    reader: Store | undefined;
  const deadline = Date.now() + 45000;
  const bounded = async <T>(
    operation: Promise<T>,
    label: string,
    remaining = deadline - Date.now(),
  ) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error(label)), Math.max(1, remaining));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const until = async <T>(read: () => Promise<T>, matches: (value: T) => boolean) => {
    for (;;) {
      const value = await bounded(read(), 'long_run_sources_deadline');
      if (matches(value)) return value;
      if (Date.now() >= deadline) throw Error('long_run_sources_deadline');
      await Bun.sleep(5);
    }
  };
  const readColdMessages = async (store: Store, upperSeq: string) => {
    const result: Awaited<ReturnType<Store['listMessages']>> = [];
    let afterSeq = '0';
    for (;;) {
      const page = await store.listMessages('s', { afterSeq, upperSeq, limit: 200 });
      result.push(...page);
      if (page.length < 200) return result;
      afterSeq = page.at(-1)!.seq;
    }
  };
  try {
    mkdirSync(workspace);
    mkdirSync(ownedHome);
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(join(workspace, 'AGENTS.md'), agents);
    provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as ProviderBody;
        const step = requests.length;
        requests.push(body);
        const start = step * 16,
          count = Math.max(0, Math.min(16, 257 - start));
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: `long-sources-${step}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame(
            count
              ? {
                  tool_calls: Array.from({ length: count }, (_, index) => ({
                    index,
                    id: `read-${start + index + 1}`,
                    type: 'function',
                    function: {
                      name: 'files.read',
                      arguments: JSON.stringify({
                        path: 'AGENTS.md',
                        offset: start + index + 1,
                        limit: 1,
                      }),
                    },
                  })),
                }
              : { content: finalBody },
            null,
          ) +
            frame({}, count ? 'tool_calls' : 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
        tools: [
          { id: 'ask_user', enabled: false },
          { id: 'files.read', definitionVersion: '3' },
        ],
      }),
    );
    child = await bounded(
      launchPairedService({
        entrypoint: join(import.meta.dir, '../../src/main.ts'),
        spawnChild: (command, { env }) => {
          const process = Bun.spawn([...command], {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...env, HOME: ownedHome },
          });
          ownedChildren.push(process);
          return process;
        },
        profile,
        instanceId: 'long-run-sources',
        buildId: 'default-long-run-sources',
        apiMajor: 1,
        requiredCapabilities: ['model_inputs', 'model_outputs'],
      }),
      'long_run_launch_deadline',
    );
    const client = child.client,
      storeId = child.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(workspace).href,
      name: 'Long ordinary Run',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Complete project instructions',
    });
    const mode = await client.getPermissionMode('s', { storeId });
    expect(
      (
        await client.setPermissionMode('s', {
          expectedStoreId: storeId,
          commandId: 'mode',
          mode: 'full',
          ifRevision: mode.revision,
          makeDefault: false,
          ifDefaultRevision: mode.defaultRevision,
        })
      ).state,
    ).toBe('applied');
    const trust = await client.getWorkspaceTrust('w', { storeId });
    expect(
      (
        await client.setWorkspaceTrust('w', {
          expectedStoreId: storeId,
          commandId: 'trust',
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
          ifRevision: trust.revision,
        })
      ).state,
    ).toBe('applied');
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Read 257 original instruction lines, then report completion once.',
    });
    const command = await until(
      () => client.getCommand('work'),
      (value) => value.status === 'applied',
    );
    const runId = (command.receipt as { runId: string }).runId;
    const run = await until(
      () => client.getRun(runId),
      (value) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status),
    );
    if (run.status !== 'completed')
      console.error(
        'long_run_sources_actual_failure',
        JSON.stringify({ run, providerRequests: requests.length, diagnostics: child.diagnostics }),
      );
    expect(run.status).toBe('completed');
    const view = await client.getView('s');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]!.id).toBe(runId);
    // View is a recent activity window. Read the complete fixed history and Model directory.
    const allMessages: Awaited<ReturnType<typeof client.listMessages>> = [];
    const upperSeq = view.session.nextSeq;
    let afterSeq = '0';
    for (;;) {
      const page = await client.listMessages('s', { afterSeq, upperSeq, limit: 200 });
      allMessages.push(...page);
      if (page.length < 200) break;
      afterSeq = page.at(-1)!.seq;
    }
    const tools = [];
    for (const message of allMessages.filter((value) => value.role === 'tool')) {
      expect(message.sourceIds).toHaveLength(1);
      tools.push(await client.getExecution(message.sourceIds![0]!));
    }
    const models = [];
    let modelAfterSeq = '0',
      modelUpperSeq: string | undefined;
    for (;;) {
      const page = await client.listModelInputs('s', {
        afterSeq: modelAfterSeq,
        ...(modelUpperSeq ? { upperSeq: modelUpperSeq } : {}),
        limit: 200,
      });
      modelUpperSeq ??= page.upperSeq;
      for (const item of page.items) models.push(await client.getExecution(item.executionId));
      if (page.nextAfterSeq === null) break;
      modelAfterSeq = page.nextAfterSeq;
    }
    expect(tools).toHaveLength(257);
    expect(models).toHaveLength(18);
    expect(requests).toHaveLength(18);
    const originalHash = createHash('sha256').update(agents).digest('hex');
    for (const execution of tools) {
      expect(execution.status).toBe('succeeded');
      expect(execution.sessionId).toBe('s');
      expect(execution.runId).toBe(runId);
      expect(execution.definitionId).toBe('files.read');
      expect(execution.definitionVersion).toBe('3');
      const result = execution.result as { outcome: string; content: string };
      expect(result.outcome).toBe('succeeded');
      const saved = JSON.parse(result.content) as {
        content: string;
        path: string;
        baseline: { hash: string };
        selection: { fromLine: number; toLine: number };
      };
      expect(saved.path).toBe('AGENTS.md');
      expect(saved.baseline.hash).toBe(originalHash);
      expect(saved.selection.toLine).toBe(saved.selection.fromLine);
      expect(saved.content).toBe(`${lines[saved.selection.fromLine - 1]}\n`);
    }
    const offsets = tools
      .map(
        (execution) =>
          JSON.parse((execution.result as { content: string }).content).selection.fromLine,
      )
      .sort((a: number, b: number) => a - b);
    expect(offsets).toEqual(Array.from({ length: 257 }, (_, index) => index + 1));
    for (const request of requests) {
      expect(
        request.messages.some((message) => message.role === 'system' && message.content === agents),
      ).toBe(true);
      expect(request.tools.map((tool) => tool.function.name)).toEqual(['files.read']);
    }
    for (const execution of models) {
      expect(execution.status).toBe('succeeded');
      const input = await client.getModelInput('s', execution.id);
      expect(
        input.request.messages.some(
          (message) => message.role === 'system' && message.content === agents,
        ),
      ).toBe(true);
      expect(input.runId).toBe(runId);
    }
    expect(allMessages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(allMessages.filter((message) => message.role === 'tool')).toHaveLength(257);
    const final = allMessages.find(
      (message) => message.role === 'assistant' && message.content === finalBody,
    )!;
    expect(final).toBeDefined();
    expect(final.sourceIds).toEqual([models.at(-1)!.id]);
    const originalOutput = await client.getModelOutput('s', final.sourceIds![0]!);
    expect(originalOutput.output.content).toBe(finalBody);
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf8')).toBe(agents);
    await bounded(child.close(), 'long_run_close_deadline');
    expect(await child.exited).toBe(0);
    child = undefined;
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    const metadata = await reader.getMetadata(),
      coldView = await reader.getView('s'),
      coldMessages = await readColdMessages(reader, upperSeq);
    expect(coldView.runs).toHaveLength(1);
    expect(coldView.runs[0]!.id).toBe(runId);
    expect(coldView.runs[0]!.status).toBe('completed');
    const messageFacts = (message: (typeof allMessages)[number]) => ({
      id: message.id,
      seq: message.seq,
      sessionId: message.sessionId,
      runId: message.runId,
      role: message.role,
      status: message.status,
      content: message.content,
      sourceIds: message.sourceIds,
      toolCallId: message.toolCallId,
    });
    expect(coldMessages.map(messageFacts)).toEqual(allMessages.map(messageFacts));
    const executionIds = [...tools, ...models].map((execution) => execution.id),
      coldExecutions = [];
    expect(new Set(executionIds).size).toBe(275);
    for (const id of executionIds) coldExecutions.push(await reader.getExecution(id));
    await reader.close();
    reader = undefined;
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    expect(await reader.getMetadata()).toEqual(metadata);
    expect(await reader.getView('s')).toEqual(coldView);
    expect(await readColdMessages(reader, upperSeq)).toEqual(coldMessages);
    const reopenedExecutions = [];
    for (const id of executionIds) reopenedExecutions.push(await reader.getExecution(id));
    expect(reopenedExecutions).toEqual(coldExecutions);
    expect(requests).toHaveLength(18);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const close of [async () => reader?.close(), async () => child?.close()]) {
      try {
        await bounded(close(), 'long_run_cleanup_deadline', 5000);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const process of ownedChildren) {
      try {
        let exited = false;
        void process.exited.then(() => {
          exited = true;
        });
        await Promise.resolve();
        if (!exited) process.kill('SIGKILL');
        await bounded(process.exited, 'long_run_owned_exit_deadline', 2000);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await provider?.stop(true);
    } catch (error) {
      failures.push(error);
    }
    if (!failures.length) rmSync(root, { recursive: true, force: true });
    else console.error('LONG_RUN_SOURCES_FAILURE_ROOT', root);
  }
  if (failures.length) throw new AggregateError(failures, 'long_run_sources_failed');
}, 60000);
