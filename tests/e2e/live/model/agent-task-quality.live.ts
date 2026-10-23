import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import { agentContractSource } from '@kite-ai/agent/sources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createTaskExtension, defaultTaskRoles } from '@kite-ai/agent/task';
import { createChildConfiguration } from '../../../../apps/service/src/child-configuration';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture, summarizeLiveToolCalls } from './live-model-fixture';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
type Scenario = 'search' | 'delegation';

/** Accept explanatory prose and code fences around the requested report object. */
function searchReport(text: string): Record<string, unknown> {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try {
          const candidate = object(JSON.parse(text.slice(start, end + 1)));
          if (Object.hasOwn(candidate, 'currentChain')) return candidate;
        } catch {
          /* Another prose or code fragment may precede the actual report. */
        }
        break;
      }
    }
  }
  throw Error('structured_search_report_missing');
}

/** Isolated opt-in task evaluation. Budgets abort the test, never define product completion. */
export async function runAgentTaskQualityTrial(options: {
  scenario: Scenario;
  trial: number;
  evidenceRoot: string;
}) {
  if (process.env.KITE_RUN_LIVE_TASK_QUALITY !== '1')
    throw Error('requires_KITE_RUN_LIVE_TASK_QUALITY_1');
  const started = Date.now();
  const codeBefore = liveCodeEvidence();
  const id = `${options.scenario}-${options.trial}`;
  mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(options.evidenceRoot);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const token = `channel-${crypto.randomUUID()}`;
  const expectedOutput = `accepted:${token}\n`;
  const fixture = await createLiveModelFixture({ requestLimit: 36, timeoutMs: 240000 });
  const profile = { dataRoot: join(root, 'data'), profile: 'quality' };
  const checks: Record<string, boolean> = {};
  const assert = (value: unknown, code: string) => {
    checks[code] = !!value;
    if (!value) throw Error(code);
  };
  let failure: string | undefined;
  let canonical: unknown;
  const cleanupErrors: string[] = [];
  let outcome: unknown;
  let toolErrors = 0;
  const evidenceErrors: string[] = [];
  const cleanup: {
    runtime?: () => Promise<unknown>;
    files?: () => Promise<unknown>;
    store?: () => Promise<unknown>;
  } = {};
  try {
    const store = await openSqliteStore(profile);
    cleanup.store = () => store.close();
    const files = createWorkspaceFiles({ root: workspace });
    cleanup.files = () => files.close();
    const fileTools = createFileTools(files).filter((tool) =>
      ['files.read', 'files.list', 'files.glob', 'files.search', 'files.write'].includes(tool.id),
    );
    const sources = {
      async capture() {
        return [agentContractSource(workspace)];
      },
    };
    const task = createTaskExtension({
      roles: defaultTaskRoles.map((role) => ({
        id: role.id,
        configurationId: role.id,
        description: role.description!,
      })),
      defaultRole: 'worker',
      presets: defaultTaskRoles.filter((role) => role.id !== 'worker').map((role) => role.id),
    });
    const child = createChildConfiguration({
      roles: defaultTaskRoles,
      async resolve(_input, selection) {
        return {
          model: fixture.model,
          modelId: fixture.modelId,
          toolIds: selection.role.toolIds,
          sources,
          snapshot: { ownedTaskQualityRole: selection.role.id },
        };
      },
    });
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: fixture.model,
      modelId: fixture.modelId,
      sources,
      extensions: [task, { id: 'builtin.files', version: '1', apiMajor: 1, tools: fileTools }],
      ...child,
      maxConcurrentSubagents: 1,
      modelConcurrency: 2,
      permissions: {
        authorize: async () => ({
          allowed: true,
          revision: 'owned-task-quality-not-default-policy',
        }),
      },
      afterTurn: {
        authorize: async () => ({ allowed: true, revision: 'owned-task-quality-finite-report' }),
      },
    });
    cleanup.runtime = () => runtime.close();
    try {
      let prompt: string;
      if (options.scenario === 'search') {
        for (const directory of ['src/current', 'legacy', 'dist'])
          mkdirSync(join(workspace, directory), { recursive: true });
        writeFileSync(
          join(workspace, 'package.json'),
          JSON.stringify({ scripts: { start: 'bun src/entry.ts' } }),
        );
        writeFileSync(join(workspace, '.gitignore'), 'dist/\n');
        writeFileSync(
          join(workspace, 'src/entry.ts'),
          "import { publish } from './current/publisher';\nexport const main = () => publish(); // TRACE_POINT\nmain();\n",
        );
        writeFileSync(
          join(workspace, 'src/current/publisher.ts'),
          `export const publish = () => ({ channel: '${token}' }); // TRACE_POINT\n`,
        );
        writeFileSync(
          join(workspace, 'legacy/publisher.ts'),
          "export const publish = () => ({ channel: 'obsolete-channel' }); // TRACE_POINT historical, not wired\n",
        );
        writeFileSync(
          join(workspace, 'dist/publisher.ts'),
          "export const publish = () => ({ channel: 'generated-decoy' }); // TRACE_POINT\n",
        );
        writeFileSync(join(workspace, 'notes.bin'), Buffer.from([0, 1, 2, 84, 82, 65, 67, 69]));
        writeFileSync(join(workspace, 'bad-utf8.txt'), Buffer.from([0xff, 0xfe, 0x80, 0x41]));
        prompt =
          '只读研究这个合成项目，禁止写文件或委派。请用内容搜索在仓库根目录查找 TRACE_POINT，并用内容搜索单独检查 src/entry.ts 的 TRACE_POINT，再读实际入口和关键文件。从 package.json 的 start 入口追踪当前 publish 的可达调用，找出实际 channel。说明 legacy/publisher.ts 是否属于当前路径，不能用同名符号存在代替连通证据。检查搜索回执，对 ignore、二进制或编码未检查范围如实说明。充分取证后直接结束。最终回复包含 JSON 对象，字段 currentChain 为当前路径文件名数组，channel 为实读值，legacyActive 为布尔值，coverage 为搜索未检查范围说明。';
      } else {
        writeFileSync(join(workspace, 'input.txt'), `${token}\n`);
        prompt =
          '请完成一个合成文件交付任务：委派恰好一个子 Agent，先读 input.txt 的完整一行，再创建 output.txt。文件内容必须精确等于字符串拼接 "accepted:" + 输入行原文（去掉原行终止符） + 一个真正的 LF 换行符；前缀恰好9个ASCII字符，冒号后不插入空格，不写字面反斜杠n，不增加空行。根据公开角色说明自行选择能完成必需步骤的角色。子 Agent不再委派，不改其他文件，不重复写。父 Agent不代写，负责接纳该子任务实际结果，并独立读取 output.txt 核对完整内容和任务范围。可以用现有等待与目录工具；结果到达后，只为会改变结论的疑问继续取证，核实后报告并正常结束。若子结果在父轮结束后到达，允许系统续报后完成验收。最终报告包含输入原值、output.txt 的实际内容、子 Agent完成情况及任何未完成项。';
      }
      const expectedStoreId = (await store.getMetadata()).storeId;
      const identity = { expectedStoreId, sessionId: 'root', subjectId: 'owner' };
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Synthetic task quality',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        ...identity,
        commandId: 'create',
        workspaceId: 'w',
        title: id,
      });
      await runtime.submitCommand({
        ...identity,
        commandId: 'work',
        request: { kind: 'run.start', content: prompt },
      });
      const waitStart = Date.now();
      for (;;) {
        fixture.signal.throwIfAborted();
        const parent = await store.getView('root');
        if (parent.runs.some((run) => !run.isActive && run.status !== 'completed'))
          throw Error(
            `actual_parent_run_${parent.runs.find((run) => run.status !== 'completed')!.status}`,
          );
        const agents = await store.listStableAgents({ ...identity, extensionId: task.id });
        const childViews = await Promise.all(
          agents.items.map((agent) => store.getView(agent.agentId)),
        );
        const carriers = parent.executions.filter((execution) => execution.childSessionId);
        const settled =
          parent.runs.length > 0 &&
          parent.runs.every((run) => !run.isActive) &&
          childViews.every(
            (view) => view.runs.length > 0 && view.runs.every((run) => !run.isActive),
          ) &&
          carriers.every(
            (carrier) => !['planned', 'dispatching', 'running'].includes(carrier.status),
          ) &&
          (options.scenario === 'search' ||
            (carriers.length > 0 && carriers.every((carrier) => carrier.resultAcceptance)));
        if (settled) break;
        if (Date.now() - waitStart > 230000) throw Error('test_observation_budget_exhausted');
        await Bun.sleep(100);
      }
      const parent = await store.getView('root');
      const agents = await store.listStableAgents({ ...identity, extensionId: task.id });
      const childViews = await Promise.all(
        agents.items.map((agent) => store.getView(agent.agentId)),
      );
      const allViews = [parent, ...childViews];
      const executions = allViews.flatMap((view) => view.executions);
      const parentTools = parent.executions.filter((execution) => execution.kind === 'tool');
      // Request order, rather than execution timestamps or earlier parent answers,
      // identifies the last actual successful parent response being evaluated.
      const finalRequest = [...fixture.requests]
        .reverse()
        .find((request) =>
          parent.executions.some(
            (execution) =>
              execution.id === request.requestId &&
              execution.kind === 'model' &&
              execution.status === 'succeeded' &&
              !(object(execution.result).toolCalls as unknown[] | undefined)?.length,
          ),
        );
      const finalExecution = parent.executions.find(
        (execution) => execution.id === finalRequest?.requestId,
      );
      assert(finalRequest && finalExecution, 'last_successful_parent_final_exists');
      const final = String(object(finalExecution!.result).content ?? '');
      // An observed read must belong to this exact Tool call and source. A token
      // appearing elsewhere in conversation is not evidence that the read arrived.
      const includesRead = (
        request: (typeof fixture.requests)[number],
        read: (typeof parentTools)[number],
      ) =>
        request.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.toolCallId === read.callId &&
            message.sourceIds?.includes(read.id) &&
            message.content === String(object(read.result).content ?? ''),
        );
      assert(
        allViews.every((view) =>
          view.runs.every((run) => !run.isActive && run.status === 'completed'),
        ),
        'all_actual_runs_completed',
      );
      assert(
        fixture.requests.every((request) =>
          request.messages.some((message) =>
            message.content.includes('# Task execution and evidence'),
          ),
        ),
        'original_agent_contract_in_every_actual_model_input',
      );
      if (options.scenario === 'search') {
        assert(
          agents.items.length === 0 &&
            !parentTools.some((execution) => execution.definitionId === 'files.write'),
          'read_only_no_delegation_or_mutation',
        );
        const searches = parentTools.filter(
          (execution) =>
            execution.definitionId === 'files.search' && execution.status === 'succeeded',
        );
        assert(
          searches.some(
            (execution) =>
              object(execution.input).path === 'src/entry.ts' &&
              object(execution.input).text === 'TRACE_POINT',
          ),
          'actual_single_file_content_search',
        );
        assert(
          searches.some(
            (execution) =>
              [undefined, '', '.'].includes(object(execution.input).path as string | undefined) &&
              object(execution.input).text === 'TRACE_POINT',
          ),
          'actual_mixed_root_content_search',
        );
        const rootSearch = searches.find(
          (execution) =>
            [undefined, '', '.'].includes(object(execution.input).path as string | undefined) &&
            object(execution.input).text === 'TRACE_POINT',
        )!;
        const searchBody = object(JSON.parse(String(object(rootSearch.result).content)));
        const scope = object(searchBody.scope);
        const skipped = object(scope.skipped);
        assert(
          scope.complete === false &&
            Number(skipped.binary) >= 1 &&
            Number(skipped.encoding) >= 1 &&
            Number(skipped.ignored) >= 1,
          'actual_search_reports_mixed_unsearched_scope',
        );
        const reads = parentTools.filter(
          (execution) =>
            execution.definitionId === 'files.read' && execution.status === 'succeeded',
        );
        for (const path of ['package.json', 'src/entry.ts', 'src/current/publisher.ts'])
          assert(
            reads.some((execution) => object(execution.input).path === path),
            `actual_current_chain_read_${path}`,
          );
        const report = searchReport(final);
        assert(report.channel === token, 'reported_random_current_channel');
        assert(report.legacyActive === false, 'legacy_not_current');
        assert(
          Array.isArray(report.currentChain) &&
            report.currentChain.every((path) =>
              ['package.json', 'src/entry.ts', 'src/current/publisher.ts'].includes(path),
            ) &&
            ['src/entry.ts', 'src/current/publisher.ts'].every(
              (path) => Array.isArray(report.currentChain) && report.currentChain.includes(path),
            ),
          'reported_current_chain',
        );
        assert(
          typeof report.coverage === 'string' && /binary|二进制|utf|编码/i.test(report.coverage),
          'coverage_mentions_binary_or_encoding',
        );
      } else {
        assert(
          agents.items.length === 1 &&
            parentTools.filter((execution) => execution.definitionId === 'task.spawn').length === 1,
          'one_actual_child',
        );
        const spawn = parentTools.find((execution) => execution.definitionId === 'task.spawn')!;
        assert(
          [undefined, 'worker', 'code'].includes(object(spawn.input).preset as string | undefined),
          'capable_role_selected_without_prescribed_answer',
        );
        assert(
          !parentTools.some((execution) => execution.definitionId === 'files.write'),
          'parent_did_not_write',
        );
        const writes = executions.filter(
          (execution) => execution.kind === 'tool' && execution.definitionId === 'files.write',
        );
        assert(
          writes.length === 1 &&
            writes[0]!.sessionId !== 'root' &&
            writes[0]!.status === 'succeeded' &&
            object(writes[0]!.input).path === 'output.txt',
          'one_child_write_to_required_output',
        );
        assert(
          childViews.every(
            (view) => !view.executions.some((execution) => execution.definitionId === 'task.spawn'),
          ),
          'child_did_not_delegate',
        );
        assert(
          childViews.some((view) =>
            view.executions.some(
              (execution) =>
                execution.definitionId === 'files.read' &&
                object(execution.input).path === 'input.txt' &&
                execution.status === 'succeeded',
            ),
          ),
          'child_read_actual_input',
        );
        const childInputReads = executions.filter(
          (execution) =>
            execution.kind === 'tool' &&
            execution.sessionId === writes[0]!.sessionId &&
            execution.definitionId === 'files.read' &&
            execution.status === 'succeeded' &&
            object(execution.input).path === 'input.txt',
        );
        const writeModel = executions.find(
          (execution) =>
            execution.kind === 'model' &&
            execution.sessionId === writes[0]!.sessionId &&
            (object(execution.result).toolCalls as { id: string }[] | undefined)?.some(
              (call) => call.id === writes[0]!.callId,
            ),
        );
        const writeRequest = fixture.requests.find(
          (request) => request.requestId === writeModel?.id,
        );
        assert(
          writeRequest && childInputReads.some((read) => includesRead(writeRequest, read)),
          'child_write_model_input_contains_its_actual_input_read',
        );
        assert(
          readFileSync(join(workspace, 'output.txt'), 'utf8') === expectedOutput,
          'actual_output_exact',
        );
        assert(
          readFileSync(join(workspace, 'input.txt'), 'utf8') === `${token}\n`,
          'input_unchanged',
        );
        assert(
          parentTools.some(
            (execution) =>
              execution.definitionId === 'files.read' &&
              object(execution.input).path === 'output.txt' &&
              execution.status === 'succeeded',
          ),
          'parent_independently_read_actual_output',
        );
        const carrier = parent.executions.find(
          (execution) => execution.childSessionId === agents.items[0]!.agentId,
        )!;
        assert(
          carrier.status === 'succeeded' && !!carrier.resultAcceptance,
          'child_actual_result_accepted',
        );
        const source = carrier.resultAcceptance!.sourceId;
        const originalBody = String(object(carrier.result).content ?? '');
        const receiving = fixture.requests.filter(
          (request) =>
            parent.executions.some((execution) => execution.id === request.requestId) &&
            request.messages.some((message) => message.sourceIds?.includes(source)),
        );
        assert(
          receiving.length > 0 &&
            receiving.every((request) => {
              const messages = request.messages.filter((message) =>
                message.sourceIds?.includes(source),
              );
              return (
                messages.length === 1 &&
                messages[0]!.sourceIds?.filter((id) => id === source).length === 1 &&
                originalBody.length > 0 &&
                (messages[0]!.content.includes(originalBody) ||
                  messages[0]!.content.includes(JSON.stringify(originalBody).slice(1, -1)))
              );
            }),
          'complete_child_source_once_per_actual_parent_input',
        );
        assert(
          finalRequest!.messages.some(
            (message) =>
              message.sourceIds?.includes(source) &&
              (message.content.includes(originalBody) ||
                message.content.includes(JSON.stringify(originalBody).slice(1, -1))),
          ),
          'final_model_input_contains_original_child_source',
        );
        assert(
          parentTools.some(
            (read) =>
              read.definitionId === 'files.read' &&
              read.status === 'succeeded' &&
              object(read.input).path === 'output.txt' &&
              includesRead(finalRequest!, read),
          ),
          'final_model_input_contains_independent_output_read',
        );
        assert(
          final.includes(token) && final.includes('output.txt'),
          'final_mentions_input_value_and_output_path',
        );
        assert(parent.runs.length <= 2, 'bounded_parent_report_runs');
      }
      outcome = {
        runs: allViews.map((view) => view.runs),
        tools: executions.filter((execution) => execution.kind === 'tool'),
        final,
      };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        const parent = await store.getView('root');
        if (parent) {
          const agents = await store.listStableAgents({
            expectedStoreId: (await store.getMetadata()).storeId,
            sessionId: 'root',
            subjectId: 'owner',
            extensionId: task.id,
          });
          const children = await Promise.all(
            agents.items.map((agent) => store.getView(agent.agentId)),
          );
          const views = [parent, ...children];
          toolErrors = views
            .flatMap((view) => view.executions)
            .filter(
              (execution) => execution.kind === 'tool' && execution.status !== 'succeeded',
            ).length;
          outcome ??= { views, checks, failure };
        }
        canonical = await saveLiveCanonicalModelEvidence({
          runtime,
          store,
          requests: fixture.requests,
          root,
          subjectId: 'owner',
        }).catch(() => ({ complete: false }));
        if (object(canonical).complete !== true) failure ??= 'canonical_model_evidence_incomplete';
        writeFileSync(
          join(root, 'original-requests.json'),
          JSON.stringify(fixture.requests, null, 2),
          {
            mode: 0o600,
          },
        );
        writeFileSync(join(root, 'actual-outcome.json'), JSON.stringify(outcome ?? null, null, 2), {
          mode: 0o600,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        evidenceErrors.push(message);
        failure ??= message;
      }
    }
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  } finally {
    // Evidence collection and partial setup must never skip resource settlement.
    // Close in ownership order even if an earlier close rejects or throws.
    for (const name of ['runtime', 'files', 'store'] as const) {
      try {
        await cleanup[name]?.();
      } catch (error) {
        cleanupErrors.push(`${name}: ${String(error)}`);
      }
    }
  }
  const result = {
    id,
    status: failure || cleanupErrors.length ? 'failed' : 'assertions_passed',
    manualReviewRequired: true,
    failure,
    checks,
    durationMs: Date.now() - started,
    startedAt: started,
    codeEvidence: { before: codeBefore, after: liveCodeEvidence() },
    canonical,
    cleanupErrors,
    evidenceErrors,
    scope: 'synthetic owned fixture permissions; not default Service policy qualification',
    metrics: {
      modelRequests: fixture.requests.length,
      toolCalls: fixture.calls.length,
      toolErrors,
      calls: summarizeLiveToolCalls(fixture.requests, fixture.calls),
      usage: fixture.usage,
      httpStatuses: fixture.wire.map((entry) => entry.status),
    },
    evidenceRoot: root,
  };
  writeFileSync(join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

if (import.meta.main) {
  if (process.env.KITE_RUN_LIVE_TASK_QUALITY !== '1')
    throw Error('requires_KITE_RUN_LIVE_TASK_QUALITY_1');
  const evidenceRoot = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--evidence-root='))
    ?.split('=')
    .slice(1)
    .join('=');
  if (!evidenceRoot || !isAbsolute(evidenceRoot))
    throw Error('new_absolute_evidence_root_required');
  mkdirSync(evidenceRoot, { mode: 0o700 });
  const results = [];
  const selected = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--scenario='))
    ?.slice('--scenario='.length);
  if (selected !== undefined && !['search', 'delegation'].includes(selected))
    throw Error('invalid_scenario');
  for (const scenario of selected ? [selected as Scenario] : (['search', 'delegation'] as const)) {
    for (let trial = 1; trial <= 2; trial++) {
      console.log(JSON.stringify({ event: 'trial_start', scenario, trial }));
      const result = await runAgentTaskQualityTrial({
        scenario,
        trial,
        evidenceRoot: join(evidenceRoot, `${scenario}-${trial}`),
      });
      results.push(result);
      console.log(
        JSON.stringify({
          event: 'trial_end',
          id: result.id,
          status: result.status,
          failure: result.failure,
          durationMs: result.durationMs,
        }),
      );
    }
  }
  writeFileSync(join(evidenceRoot, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`, {
    mode: 0o600,
  });
  if (results.some((result) => result.status !== 'assertions_passed')) process.exitCode = 1;
}
