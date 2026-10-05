import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function until<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 45000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline)
      throw Error(`packaged_task_deadline:${label}:${JSON.stringify(value)}`);
    await Bun.sleep(15);
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

test('source-free default Task preserves full child result and emits exactly one after-turn report, with required/background controls', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-packaged-task-'));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  mkdirSync(workspace);
  mkdirSync(home);
  const { buildTerminalBundle, verifyTerminalBundle } = await import(
    '../../../../scripts/release/terminal-bundle'
  );
  const built = await buildTerminalBundle({
    destination: join(root, 'bundle'),
    repositoryRoot: resolve(import.meta.dir, '../../../..'),
    bunExecutable: process.execPath,
  });
  expect(verifyTerminalBundle(built.root).digest).toBe(built.digest);
  for (const path of [
    built.manifest.entries.service,
    built.manifest.entries.runtime,
    'node_modules/@kite-ai/agent/storage/worker/main.js',
    'node_modules/@kite-ai/agent/platform/process/shell-supervisor.js',
    'node_modules/@kite-ai/agent/mcp/stdio-guardian.js',
    'node_modules/@kite-ai/agent/tools/web-fetch/extractor-worker.js',
  ])
    expect(built.manifest.files.some((file) => file.path === path)).toBe(true);
  expect(built.manifest.entries.service.endsWith('.js')).toBe(true);
  // Dependency archives may include source/type files; the launched entry and every Kite runtime leaf are compiled JS.
  expect(
    built.manifest.files
      .filter((file) => file.path.startsWith('node_modules/@kite-ai/'))
      .some((file) => file.path.endsWith('.ts') && !file.path.endsWith('.d.ts')),
  ).toBe(false);
  const { selectProfile } = (await import(
    join(built.root, 'node_modules/@kite-ai/agent/profile.js')
  )) as typeof import('@kite-ai/agent/profile');
  const { launchPairedService } = (await import(
    join(built.root, 'node_modules/@kite-ai/service/paired.js')
  )) as typeof import('../../src/paired');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  let disposition: 'after_turn' | 'required' | 'background' = 'after_turn';
  let parentCalls = 0,
    childCalls = 0,
    reports = 0,
    reviews = 0;
  let release!: () => void;
  let gate = Promise.resolve();
  let reportActive = () => false;
  const fullResult = `PACKAGED_RESULT_START\n${'中文é👋'.repeat(9000)}\nPACKAGED_RESULT_END`;
  expect(Buffer.byteLength(fullResult)).toBeGreaterThan(65536);
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        model: string;
        messages: { role: string; content: string | null }[];
      };
      const review = body.messages.some((message) => {
        if (message.role !== 'user' || !message.content) return false;
        try {
          return JSON.parse(message.content).purpose === 'authorization_review';
        } catch {
          return false;
        }
      });
      const child =
        !review &&
        body.messages.some((message) => message.content?.includes('PACKAGED_CHILD_INPUT'));
      const report = !review && !child && reportActive();
      let selected: unknown = null;
      let content: string;
      if (review) {
        reviews++;
        content = JSON.stringify({ decision: 'ask_user', reason: 'owned independent review' });
      } else if (child) {
        childCalls++;
        await gate;
        content = fullResult;
      } else if (report) {
        reports++;
        content = 'PACKAGED_REPORT_DONE';
      } else {
        const index = parentCalls++;
        if (index === 0)
          selected = {
            key: 'original',
            role: 'worker',
            input: { content: 'PACKAGED_CHILD_INPUT' },
            cancellation: 'detached',
            resultDisposition: disposition,
          };
        content = 'PACKAGED_PARENT_DONE';
      }
      const delta = selected
        ? {
            tool_calls: [
              {
                index: 0,
                id: `task-${disposition}`,
                type: 'function',
                function: { name: 'task', arguments: JSON.stringify(selected) },
              },
            ],
          }
        : { content };
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, selected ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [{ id: 'task', definitionVersion: '1' }],
    }),
  );
  let paired: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let database: Database | undefined;
  try {
    paired = await launchPairedService({
      entrypoint: join(built.root, built.manifest.entries.service),
      executable: join(built.root, built.manifest.entries.runtime),
      profile,
      instanceId: 'packaged-task',
      buildId: built.buildId,
      apiMajor: 1,
      requiredCapabilities: [
        'commands',
        'interactions',
        'model_inputs',
        'model_outputs',
        'context',
      ],
      spawnChild: (argv, options) =>
        Bun.spawn([...argv], {
          cwd: workspace,
          env: { ...options.env, HOME: home },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        }),
    });
    const client = paired.client,
      expectedStoreId = paired.bootstrap.storeId!;
    const subjectId = client.serverInfo!.subjectId!;
    expect(subjectId.length).toBeGreaterThan(0);
    database = new Database(profile.databasePath, { readonly: true });
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    const trust = await client.getWorkspaceTrust('w', { storeId: expectedStoreId });
    expect(
      (
        await client.setWorkspaceTrust('w', {
          expectedStoreId,
          commandId: 'trust',
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
          ifRevision: trust.revision,
        })
      ).state,
    ).toBe('applied');
    for (const scenario of ['after_turn', 'required', 'background'] as const) {
      disposition = scenario;
      parentCalls = 0;
      childCalls = 0;
      reports = 0;
      reviews = 0;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sessionId = `s-${scenario}`,
        work = `work-${scenario}`;
      reportActive = () =>
        Boolean(
          database!
            .query(
              "SELECT id FROM run WHERE session_id=? AND is_active=1 AND origin_command_id LIKE 'report-%'",
            )
            .get(sessionId),
        );
      await client.createSession({
        expectedStoreId,
        commandId: `create-${scenario}`,
        sessionId,
        workspaceId: 'w',
        title: scenario,
      });
      const mode = await client.getPermissionMode(sessionId, { storeId: expectedStoreId });
      expect(
        (
          await client.setPermissionMode(sessionId, {
            expectedStoreId,
            commandId: `ask-${scenario}`,
            mode: 'ask',
            ifRevision: mode.revision,
            ifDefaultRevision: mode.defaultRevision,
            makeDefault: false,
          })
        ).state,
      ).toBe('applied');
      await client.startRun(sessionId, {
        kind: 'run.start',
        expectedStoreId,
        commandId: work,
        content: `PACKAGED_PARENT_${scenario}`,
      });
      const cards = [];
      for (const definitionId of ['task', 'agent/worker']) {
        const card = await until(
          `approval-${scenario}-${definitionId}`,
          () => client.listInteractions(sessionId, { storeId: expectedStoreId, state: 'pending' }),
          (page) => page.interactions.some((card) => card.definitionId === definitionId),
        );
        const actual = card.interactions.find((card) => card.definitionId === definitionId)!;
        cards.push(actual);
        expect(actual.kind).toBe('approval');
        expect(actual.definitionVersion).toBe('1');
        expect(actual.originStoreId).toBe(expectedStoreId);
        expect(actual.sessionId).toBe(sessionId);
        expect(actual.presentationSessionId).toBe(sessionId);
        if (definitionId === 'task') expect(actual.runId).toBeTruthy();
        else expect(actual.runId).toBeNull();
        expect(childCalls).toBe(0);
        expect(
          (
            await client.answerInteraction(sessionId, actual.id, {
              expectedStoreId,
              commandId: `answer-${actual.id}`,
              expectedRevision: actual.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            })
          ).status,
        ).toBe('applied');
      }
      expect(cards[0]!.executionId).not.toBe(cards[1]!.executionId);
      await until(
        `child-entered-${scenario}`,
        async () => childCalls,
        (calls) => calls === 1,
      );
      expect(reports).toBe(0);
      const held = await client.getView(sessionId);
      const heldParent = held.runs.find((run) => run.originCommandId === work)!;
      expect(heldParent).toBeDefined();
      console.log(
        'packaged-task-single-slot-window',
        JSON.stringify({
          scenario,
          parentStatus: heldParent.status,
          parentActive: heldParent.isActive,
          childCalls,
          reports,
        }),
      );
      const carrier = held.executions.find(
        (execution) => execution.definitionId === 'agent/worker',
      )!;
      expect(carrier.childSessionId).toBeTruthy();
      expect(carrier.runId).toBeNull();
      expect(carrier.parentExecutionId).toBe(cards[0]!.executionId);
      expect(
        held.executions.find((execution) => execution.id === carrier.parentExecutionId)!.runId,
      ).toBe(heldParent.id);
      release();
      const view = await until(
        `completed-${scenario}`,
        () => client.getView(sessionId),
        (view) =>
          view.runs.filter((run) => run.status === 'completed').length ===
            (scenario === 'after_turn' ? 2 : 1) &&
          view.executions.some(
            (execution) => execution.id === carrier.id && execution.status === 'succeeded',
          ),
      );
      // Required result delivery adds the post-delivery completion step; the earlier completion proposal cannot finish the parent.
      expect(parentCalls).toBe(scenario === 'required' ? 3 : 2);
      expect(childCalls).toBe(1);
      // Persisted Ask/minimum-user approval dispatches no reviewer Model; both cards are actual SDK approvals.
      expect(reviews).toBe(0);
      expect(reports).toBe(scenario === 'after_turn' ? 1 : 0);
      const parent = view.runs.find((run) => run.originCommandId === work)!;
      const childView = await client.getView(carrier.childSessionId!);
      expect(childView.runs).toHaveLength(1);
      expect(childView.runs[0]!.status).toBe('completed');
      const childModel = childView.executions.find((execution) => execution.kind === 'model')!;
      const output = await client.getModelOutput(carrier.childSessionId!, childModel.id, {
        expectedStoreId,
      });
      expect(output.output.content).toBe(fullResult);
      expect(output.output.complete).toBe(true);
      expect(output.rootSessionId).toBe(sessionId);
      expect(output.rootWorkCommandId).toBe(work);
      expect(Number(output.contentBytes)).toBe(Buffer.byteLength(fullResult));
      expect(output.bodyHash).toBe(hash(canonical(output.output)));
      expect(output.bodyBytes).toBe(String(Buffer.byteLength(canonical(output.output))));
      const childInput = await client.getModelInput(carrier.childSessionId!, childModel.id, {
        expectedStoreId,
      });
      expect(childInput.runId).toBe(childView.runs[0]!.id);
      expect(childInput.request.modelId).toBe('fixed');
      expect(childInput.request.tools.map((tool) => tool.id)).toContain('task');
      if (scenario === 'after_turn') {
        const reportRun = view.runs.find((run) => run.originCommandId !== work)!;
        const reportCommand = await client.getCommand(reportRun.originCommandId);
        expect(reportCommand.status).toBe('applied');
        const model = view.executions.find(
          (execution) => execution.kind === 'model' && execution.runId === reportRun.id,
        )!;
        const input = await client.getModelInput(sessionId, model.id, { expectedStoreId });
        expect(input.rootWorkCommandId).toBe(work);
        expect(input.rootSessionId).toBe(sessionId);
        expect(input.request.messages.some((message) => message.content.includes(fullResult))).toBe(
          true,
        );
        expect(
          input.request.messages.filter((message) => message.sourceIds?.length),
        ).not.toHaveLength(0);
        const commands = database
          .query("SELECT * FROM command WHERE session_id=? AND kind='job.report'")
          .all(sessionId) as Record<string, unknown>[];
        expect(commands).toHaveLength(1);
        expect(commands[0]!.subject_id).toBe(subjectId);
        expect(commands[0]!.origin_store_id).toBe(expectedStoreId);
        const request = JSON.parse(String(commands[0]!.request_json));
        expect(request.executionId).toBe(carrier.id);
        expect(request.parentRunId).toBe(parent.id);
        const terminalCarrier = view.executions.find((execution) => execution.id === carrier.id)!;
        expect(request.resultRevision).toBe(terminalCarrier.resultRevision);
        expect(terminalCarrier.delivery).toBe('consumed');
        expect(reportCommand.receipt).toMatchObject({
          runId: reportRun.id,
          executionId: carrier.id,
        });
        const context = await client.getContext(sessionId, {
          storeId: expectedStoreId,
          byteLimit: 1048576,
        });
        const source = context.resultSources.find((source) => source.executionId === carrier.id)!;
        expect(source).toBeDefined();
        expect(source.originStoreId).toBe(expectedStoreId);
        expect(source.resultRevision).toBe(request.resultRevision);
        expect(source.inclusion).toBe('automatic');
        expect(
          input.request.messages.some((message) => message.sourceIds?.includes(source.id)),
        ).toBe(true);
        // Context metadata.sources describes contributed host/extension sources, while this is a persisted result Source.
        expect(input.metadata.context?.sourceOrder).toBe('request.messages[].sourceIds');
        const sourceMessage = input.request.messages.find((message) =>
          message.sourceIds?.includes(source.id),
        )!;
        const begin = sourceMessage.content.indexOf('PACKAGED_RESULT_START');
        const end =
          sourceMessage.content.indexOf('PACKAGED_RESULT_END', begin) +
          'PACKAGED_RESULT_END'.length;
        expect(begin).toBeGreaterThanOrEqual(0);
        expect(hash(sourceMessage.content.slice(begin, end))).toBe(hash(fullResult));
        expect(view.executions.filter((execution) => execution.kind === 'job')).toHaveLength(1);
        const reportBinding = database
          .query('SELECT after_turn_json FROM execution WHERE run_id=?')
          .all(reportRun.id) as { after_turn_json: string | null }[];
        expect(reportBinding.every((row) => row.after_turn_json === null)).toBe(true);
        const scopes = database
          .query('SELECT root_work_command_id FROM run WHERE id IN (?,?)')
          .all(reportRun.id, parent.id) as { root_work_command_id: string }[];
        expect(scopes.map((row) => row.root_work_command_id)).toEqual([work, work]);
      } else
        expect(
          database
            .query("SELECT id FROM command WHERE session_id=? AND kind='job.report'")
            .all(sessionId),
        ).toHaveLength(0);
      const before = { parentCalls, childCalls, reports, reviews, runs: view.runs.length };
      for (let n = 0; n < 3; n++) {
        await client.getView(sessionId);
        await client.getModelOutput(carrier.childSessionId!, childModel.id, { expectedStoreId });
      }
      await Bun.sleep(100);
      expect({
        parentCalls,
        childCalls,
        reports,
        reviews,
        runs: (await client.getView(sessionId)).runs.length,
      }).toEqual(before);
      console.log(
        'packaged-task-qualified',
        JSON.stringify({
          scenario,
          storeId: expectedStoreId,
          subjectId,
          parentRun: parent.id,
          childRun: childView.runs[0]!.id,
          carrier: carrier.id,
          resultBytes: Buffer.byteLength(fullResult),
          resultSha256: hash(fullResult),
          ...before,
        }),
      );
    }
    console.log(
      'packaged-task-bundle',
      JSON.stringify({
        root: built.root,
        digest: built.digest,
        buildId: built.buildId,
        sourceFreeCwd: workspace,
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
        servicePid: paired.pid,
        independentHome: home,
      }),
    );
    await paired.close();
    expect(await paired.exited).toBe(0);
    expect(() => process.kill(paired!.pid, 0)).toThrow();
    expect(verifyTerminalBundle(built.root).digest).toBe(built.digest);
  } catch (error) {
    console.error('packaged-task-failure', String(error), paired?.diagnostics);
    if (database)
      console.error(
        'packaged-task-persistent-facts',
        JSON.stringify({
          runs: database.query('SELECT * FROM run').all(),
          executions: database
            .query(
              'SELECT id,session_id,run_id,kind,adapter_id,state,child_session_id,parent_execution_id,result_json FROM execution',
            )
            .all(),
          interactions: database
            .query('SELECT id,definition_id,state,accepted_decision_revision FROM interaction')
            .all(),
        }),
      );
    throw error;
  } finally {
    release?.();
    database?.close();
    await paired?.close().catch(() => {});
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 180000);
