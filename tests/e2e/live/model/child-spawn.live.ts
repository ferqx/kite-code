import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { agentBrowserExecutableAsset } from '@kite-ai/agent/browser';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { ripgrepAsset } from '@kite-ai/agent/jobs/shell';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ExecutionRecord, Json } from '@kite-ai/agent/storage';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../../../apps/service/src';
import { initializeLivePermissionFixture } from '../../../../apps/service/test/fixtures/live-permission-fixture';
import { readLiveExecutionDirectory, readLiveSessionLogPages } from './approval-execution-fixture';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture } from './live-model-fixture';

type Role = 'worker' | 'explore' | 'review';
type Mode = 'accept_edits' | 'auto' | 'full';
const object = (value: unknown): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const save = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

async function sourceConfiguration(root: string) {
  const source = resolve(import.meta.dir, '../../../../apps/service/src/configuration.ts');
  const originalMcp = resolve(import.meta.dir, '../../../../packages/agent/src/mcp/index.ts');
  const packagedMcp = resolve(import.meta.dir, '../../../../packages/agent/dist/mcp/index.js');
  const directory = join(root, 'configuration-assets');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bridge = join(directory, 'mcp-assets.js');
  writeFileSync(
    bridge,
    `export * from ${JSON.stringify(originalMcp)};\nexport { mcpStdioGuardianAsset } from ${JSON.stringify(packagedMcp)};\n`,
  );
  const built = await Bun.build({
    entrypoints: [source],
    target: 'bun',
    packages: 'external',
    external: [originalMcp, packagedMcp],
    outdir: directory,
    naming: 'configuration.js',
    plugins: [
      {
        name: 'owned-published-guardian-location',
        setup(build) {
          build.onResolve({ filter: /^@kite-ai\/agent\/mcp$/ }, () => ({
            path: bridge,
            external: true,
          }));
          build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
            const resolved = import.meta.resolve(path);
            return {
              path: resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved,
              external: true,
            };
          });
        },
      },
    ],
  });
  assert(built.success, 'child-spawn-fresh-configuration-build');
  save(join(directory, 'bridge.json'), {
    source,
    originalMcp,
    packagedMcp,
    sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    packagedMcpSha256: createHash('sha256').update(readFileSync(packagedMcp)).digest('hex'),
    replacedExport: 'mcpStdioGuardianAsset',
    capabilityOrPermissionReplacement: false,
  });
  return (await import(
    built.outputs[0]!.path
  )) as typeof import('../../../../apps/service/src/configuration');
}

/** Real default host/roles/Skill catalogue; the loopback browser is never needed by this task. */
export async function createChildSpawnFixture(input: {
  root: string;
  mode: Mode;
  model: ModelAdapter;
}) {
  const workspace = join(input.root, 'project');
  const evidence = join(input.root, 'evidence');
  const control = join(input.root, 'control');
  for (const path of [workspace, evidence, control])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const token = `source-${crypto.randomUUID()}`;
  const originals = {
    'source.txt': `${token}\n`,
    'entry.py':
      'from pricing import invoice_total\n\ndef total(prices):\n    return invoice_total(prices)\n',
    'pricing.py': 'def invoice_total(prices):\n    return sum(prices[:-1])\n',
    'README.md':
      'Owned synthetic project. entry.total calls pricing.invoice_total; the required result is the sum of every price. source.txt is the exact task marker.\n',
  };
  for (const [path, body] of Object.entries(originals)) writeFileSync(join(workspace, path), body);
  const browserRequests: string[] = [];
  const browserEndpoint = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      browserRequests.push(new URL(request.url).pathname);
      return new Response('Browser use is outside this synthetic task.', { status: 403 });
    },
  });
  let disposeOwned = async () => {};
  let disposeLocks = async () => {};
  try {
    const profile = selectProfile({ dataRoot: join(input.root, 'state'), profile: 'live' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    const configurationPath = join(profile.profilePath, 'config.jsonc');
    save(configurationPath, {
      modelId: 'live',
      models: [
        {
          id: 'live',
          provider: 'compatible',
          model: 'test-injected-live',
          baseURL: 'http://127.0.0.1:1/v1',
        },
      ],
    });
    const built = await Bun.build({
      entrypoints: [
        join(
          import.meta.dir,
          '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
        ),
      ],
      target: 'bun',
      outdir: join(input.root, 'assets'),
      naming: 'shell-supervisor.js',
    });
    assert(built.success, 'child-spawn-supervisor-build');
    const rg = ripgrepAsset();
    // Only source-tree asset location is bridged; these are real published native assets.
    const nativeBrowser = agentBrowserExecutableAsset();
    const browserAssets = {
      executable: nativeBrowser,
      browserPath: nativeBrowser,
      guardianPath: join(import.meta.dir, '../../../../packages/agent/dist/mcp/stdio-guardian.js'),
      bunExecutable: process.execPath,
    };
    const browserAssetEvidence = Object.fromEntries(
      Object.entries(browserAssets).map(([key, path]) => [
        key,
        { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') },
      ]),
    );
    const { createDefaultProcessConfiguration } = await sourceConfiguration(input.root);
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: configurationPath,
      ordinaryHostTools: true,
      localCodex: false,
      credentialBackend: createTemporaryCredentialBackend(),
      desktopBrowser: {
        endpoint: new URL('/kite-page', browserEndpoint.url).href,
        token: 'a'.repeat(72),
      },
      browser: {
        executable: browserAssets.executable,
        browserPath: browserAssets.browserPath,
        darwin: {
          guardianPath: browserAssets.guardianPath,
          bunExecutable: browserAssets.bunExecutable,
        },
      },
      shell: {
        platform: 'darwin',
        configurationId: 'owned-child-spawn-live',
        env: { PATH: `${dirname(rg)}:/usr/bin:/bin` },
        supervisorPath: built.outputs[0]!.path,
        bunExecutable: process.execPath,
        shellExecutable: '/bin/sh',
        host: {
          controlBase: control,
          protectedRoots: [profile.dataRoot, evidence, control],
          readonlyAssets: [join(input.root, 'assets'), join(input.root, 'configuration-assets')],
          runtimeReadOnlyRoots: [dirname(process.execPath), dirname(rg)],
        },
      },
    });
    const store = await openSqliteStore(profile);
    disposeOwned = () => store.close();
    const locks = createWorkspaceSerialLocks(profile);
    disposeLocks = () => locks.close();
    host.bindWorkspaceSerialLocks?.(locks);
    const bindings: {
      actor: string;
      snapshot: Json;
      toolIds: readonly string[];
      checkerTimeout: number | null;
    }[] = [];
    const requests: ModelRequest[] = [];
    const observedModel: ModelAdapter = {
      describeRequest: input.model.describeRequest?.bind(input.model),
      async *stream(request, context) {
        requests.push(structuredClone(request));
        appendFileSync(join(evidence, 'model-requests.ndjson'), `${JSON.stringify(request)}\n`, {
          mode: 0o600,
        });
        for await (const event of input.model.stream(request, context)) {
          appendFileSync(
            join(evidence, 'model-events.ndjson'),
            `${JSON.stringify({ requestId: request.requestId, event })}\n`,
            { mode: 0o600 },
          );
          yield event;
        }
      },
    };
    const instrument = (binding: RunConfiguration, actor: string): RunConfiguration => {
      bindings.push({
        actor,
        snapshot: binding.snapshot ?? null,
        toolIds: binding.toolIds ?? [],
        checkerTimeout: binding.authorizationCheck?.timeoutMs ?? null,
      });
      assert(
        binding.authorizationCheck?.timeoutMs === 10000,
        'child-spawn-original-review-deadline',
      );
      return {
        ...binding,
        model: observedModel,
        authorizationCheck: { ...binding.authorizationCheck!, model: observedModel },
      };
    };
    const runtime = createRuntime({
      ...host,
      permissions: host.permissions!,
      store,
      artifacts: createArtifactStore({ profile, store }),
      workspaceSerialLocks: locks,
      modelConcurrency: 2,
      processConcurrency: 2,
      maxConcurrentSubagents: 2,
      resolveRunConfiguration: async (request) =>
        instrument(await host.resolveRunConfiguration!(request), 'root'),
      resolveChildRunConfiguration: async (request) =>
        instrument(await host.resolveChildRunConfiguration!(request), 'child'),
    });
    disposeOwned = () => runtime.close();
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned child spawn task',
      rootUri: pathToFileURL(workspace).href,
    });
    const service = await startService({
      runtime,
      permissionManagement: host.permissionManagement!(runtime),
      subjectId: 'owner',
      buildId: 'owned-child-spawn-live',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      beforeResourceClose: () => locks.close(),
    });
    disposeOwned = () => service.close();
    disposeLocks = async () => {};
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'interactions', 'sessions'],
      },
    });
    await client.connect();
    await client.createSession({
      expectedStoreId,
      commandId: 'create-s',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Synthetic child spawn',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      workspaceId: 'w',
      mode: input.mode,
      trusted: true,
      nativeShellRead: true,
    });
    return {
      workspace,
      evidence,
      store,
      runtime,
      client,
      expectedStoreId,
      token,
      originals,
      bindings,
      requests,
      browserRequests,
      browserAssetEvidence,
      browserEndpoint: new URL('/kite-page', browserEndpoint.url).href,
      async directory() {
        const sessions = new Set(['s']);
        const executions: ExecutionRecord[] = [];
        for (const sessionId of sessions) {
          const page = await readLiveExecutionDirectory(store, {
            expectedStoreId,
            sessionId,
            subjectId: 'owner',
          });
          executions.push(...page.executions);
          for (const row of page.executions)
            if (row.childSessionId) sessions.add(row.childSessionId);
        }
        return { sessions: [...sessions], executions };
      },
      async close() {
        client.disposeNetwork();
        try {
          await service.close();
        } finally {
          browserEndpoint.stop(true);
        }
      },
    };
  } catch (error) {
    const failures = [error];
    for (const close of [disposeOwned, disposeLocks]) {
      try {
        await close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    browserEndpoint.stop(true);
    if (failures.length > 1)
      throw new AggregateError(failures, 'child-spawn-setup-cleanup-failed', { cause: error });
    throw error;
  }
}

function task(role: Role) {
  const assignment =
    role === 'worker'
      ? '委派给一名默认 worker 协作者：读取 source.txt，把其完整原文写入工作区 result.txt 并核对。只创建这一业务文件；不修改其他资料。父 Agent 只负责委派、等待、独立核对 result.txt 和汇总，不代写。'
      : role === 'explore'
        ? '委派给一名 explore 只读探索协作者：追踪 entry.total 到最终计算函数，报告准确文件、函数以及 source.txt 的完整随机值。父 Agent 只负责委派、等待、核对原结果并汇总，不代做调查。'
        : '委派给一名 review 只读审阅协作者：核对 entry.py/pricing.py 是否满足 README 的求和约定，给出真实缺陷的文件、行、最小触发输入和错误结果，同时报告 source.txt 的完整随机值。父 Agent 只负责委派、等待、核对原结果并汇总，不代做审查。';
  return `这是自有合成项目的真实委派验收。${assignment} 仅一名协作者，不再委派。工具、命令及参数由你们根据实际工具目录自行决定，不访问网络或用户目录；必要临时探索脚本可以在继承权限内使用，只读任务不得改业务源码、配置和数据。不要为了加载与本任务无关的技能扩权；不要调用浏览器。受理不代表完成，等实际结果再报告；如委派失败如实解释，不要换角色或重复创建来掩盖失败。`;
}

/** Summary coverage only; successful writing and independent readback need original effect evidence. */
export function childSpawnReportChecks(
  role: Role,
  report: string,
  token: string,
): Record<string, boolean> {
  if (role === 'worker') return {};
  return {
    'child-reported-actual-random-source': report.includes(token),
    'child-reported-real-source-location':
      report.includes('pricing.py') && (role !== 'explore' || report.includes('invoice_total')),
    ...(role === 'review'
      ? { 'review-reported-actual-omission': /\[:-1\]|最后|末尾|last|omit|exclud/i.test(report) }
      : {}),
  };
}

export async function runChildSpawnCase(root: string, role: Role, mode: Mode, signal: AbortSignal) {
  assert(process.env.KITE_RUN_LIVE_CHILD_SPAWN === '1', 'child-spawn-live-opt-in-required');
  assert(process.platform === 'darwin', 'child-spawn-live-native-macos-required');
  assert(
    isAbsolute(root) && root.startsWith(`${resolve('dist/acceptance')}/`) && !existsSync(root),
    'child-spawn-new-owned-case-required',
  );
  const codeBefore = liveCodeEvidence();
  mkdirSync(join(root, 'evidence'), { recursive: true, mode: 0o700 });
  const live = await createLiveModelFixture({
    model: 'gpt-6.1-terra',
    reasoningEffort: 'low',
    requestTimeoutMs: null,
    signal,
    captureWireRequests: true,
    preserveSdkAttemptErrors: true,
    beforeWireRequest(entry) {
      appendFileSync(join(root, 'evidence', 'wire-requests.ndjson'), `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
      });
    },
  });
  const f = await createChildSpawnFixture({ root, mode, model: live.model });
  const checks: Record<string, boolean> = {};
  const approvals: unknown[] = [];
  const semanticChecks: Record<string, string> = {
    childReportAndFinalParentReport: 'pending independent canonical full-text review',
    readonlyTemporaryAndNetworkEffects:
      'pending actual command/output review; no command-name inference',
    ...(role === 'worker'
      ? {
          childOnlyDeliveryWrite: 'pending actual Files/Shell effect attribution review',
          parentIndependentReadback: 'pending actual Files/Shell readback review',
        }
      : {}),
  };
  const check = (condition: unknown, name: string) => {
    checks[name] = !!condition;
    assert(condition, name);
  };
  let failure: string | null = null;
  const errors: string[] = [];
  const answered = new Set<string>();
  try {
    await f.client.startRun('s', {
      expectedStoreId: f.expectedStoreId,
      commandId: 'work',
      kind: 'run.start',
      content: task(role),
    });
    for (;;) {
      signal.throwIfAborted();
      const directory = await f.directory();
      for (const sessionId of directory.sessions) {
        const cards = await f.client.listInteractions(sessionId, {
          storeId: f.expectedStoreId,
          state: 'pending',
          origin: 'all',
        });
        for (const card of cards.interactions) {
          if (answered.has(card.id)) continue;
          assert(card.kind === 'approval', 'unexpected-child-spawn-interaction');
          const pending = await f.store.getExecution(card.executionId);
          assert(
            pending &&
              pending.sessionId === card.sessionId &&
              pending.definitionId === card.definitionId &&
              pending.definitionVersion === card.definitionVersion &&
              pending.attempt === card.attempt &&
              pending.originStoreId === f.expectedStoreId,
            'child-spawn-original-card-binding',
          );
          const path = join(f.evidence, `approval-${card.id}.json`);
          save(path, { role, mode, card, pending, workspace: f.workspace });
          console.log(JSON.stringify({ event: 'operator-review', path }));
          while (!existsSync(`${path}.answer.json`)) {
            signal.throwIfAborted();
            await Bun.sleep(80);
          }
          const answer = object(JSON.parse(readFileSync(`${path}.answer.json`, 'utf8')));
          assert(
            ['approve', 'deny'].includes(String(answer.decision)) &&
              typeof answer.reason === 'string' &&
              answer.reason.length > 0,
            'child-spawn-explicit-operator-answer',
          );
          await f.client.answerInteraction(card.presentationSessionId, card.id, {
            expectedStoreId: f.expectedStoreId,
            commandId: `answer-${card.id}`,
            expectedRevision: card.revision,
            answer: {
              kind: 'approval',
              decision: answer.decision as 'approve' | 'deny',
              ...(answer.decision === 'approve' ? { grant: 'approve_once' as const } : {}),
            },
          });
          answered.add(card.id);
          approvals.push({ card, answer });
        }
      }
      const work = await f.store.getCommand('work');
      const runId = object(work?.receipt).runId;
      const run = typeof runId === 'string' ? await f.store.getRun(runId) : null;
      if (run && !run.isActive) {
        const safety = await f.store.readExecutionGroupSafety({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
        });
        if (safety.activeRunIds.length === 0 && safety.pendingCommandIds.length === 0) break;
      } else if (work && ['failed', 'rejected', 'outcome_unknown'].includes(work.status))
        throw Error('child-spawn-work-command-failed');
      await Bun.sleep(40);
    }
    const { executions } = await f.directory();
    save(join(f.evidence, 'business-effect-review.json'), {
      task: task(role),
      workspace: f.workspace,
      token: f.token,
      semanticChecks,
      operations: executions
        .filter((row) => row.kind === 'tool' || row.kind === 'job')
        .map((row) => ({
          id: row.id,
          sessionId: row.sessionId,
          runId: row.runId,
          callId: row.callId,
          parentExecutionId: row.parentExecutionId,
          definitionId: row.definitionId,
          definitionVersion: row.definitionVersion,
          kind: row.kind,
          input: row.input,
          status: row.status,
          authorization: row.authorization,
          result: row.result,
        })),
      instruction:
        'Review original child write and original parent independent readback. Shell command names or echoed tokens do not prove either. Source summaries alone do not qualify an independent readback.',
    });
    const carriers = executions.filter((row) => row.childSessionId);
    check(carriers.length === 1, 'one-original-child-carrier');
    const carrier = carriers[0]!;
    check(carrier.status === 'succeeded', 'child-carrier-succeeded');
    const childBinding = f.bindings.find((binding) => binding.actor === 'child');
    const parentBinding = f.bindings.find((binding) => binding.actor === 'root')!;
    const parent = object(parentBinding.snapshot);
    const child = object(childBinding?.snapshot);
    const childHost = object(child.configuration);
    check(
      Array.isArray(object(parent.actualCapabilities).skills) &&
        JSON.stringify(object(parent.actualCapabilities).skills).includes('browser.execute'),
      'real-parent-required-skill-capability',
    );
    check(child.roleId === role, 'actual-requested-default-role');
    check(parentBinding.toolIds.includes('browser.execute'), 'real-parent-browser-capability');
    check(
      JSON.stringify(parent.skillSelection) ===
        JSON.stringify({ requested: null, resolvedIds: ['computer-use'] }),
      'original-parent-automatic-skill-selection',
    );
    const skills = object(child.skillSelection);
    check(
      skills.requested === null &&
        JSON.stringify(skills.resolvedIds) ===
          JSON.stringify(role === 'worker' ? ['computer-use'] : []),
      'child-compatible-automatic-skill-selection',
    );
    check(
      childBinding?.toolIds.includes('browser.execute') === (role === 'worker'),
      'child-original-tool-intersection',
    );
    check(
      Array.isArray(object(childHost.actualCapabilities).skills) &&
        (object(childHost.actualCapabilities).skills as Json[]).length ===
          (role === 'worker' ? 1 : 0),
      'child-actual-skill-manifest',
    );
    const childModels = executions.filter(
      (row) =>
        row.sessionId === carrier.childSessionId && row.kind === 'model' && row.runId !== null,
    );
    check(
      childModels.some((row) =>
        live.wireRequests.some(
          (request) =>
            request.requestId === row.id && live.wire[request.physicalIndex]?.status === 200,
        ),
      ),
      'child-actual-physical-model-request',
    );
    check(
      executions.some(
        (row) =>
          row.sessionId === carrier.childSessionId &&
          row.kind === 'tool' &&
          row.status === 'succeeded',
      ),
      'child-actual-successful-tool',
    );
    const parentRequests = f.requests.filter(
      (request) =>
        executions.some((row) => row.id === request.requestId && row.sessionId === 's') &&
        live.wireRequests.some(
          (wire) =>
            wire.requestId === request.requestId && live.wire[wire.physicalIndex]?.status === 200,
        ),
    );
    const parentMessages = parentRequests.flatMap((request) => request.messages);
    const context = await f.store.getModelContext({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
    });
    const originalSources = context.resultSources.filter(
      (source) =>
        source.executionId === carrier.id && source.resultRevision === carrier.resultRevision,
    );
    check(
      parentMessages.some(
        (message) =>
          message.content.startsWith('Child result source') &&
          message.sourceIds?.some((id) => originalSources.some((source) => source.id === id)),
      ),
      'original-child-result-reached-parent-model',
    );
    const childReport = String(object(carrier.result).content ?? '');
    for (const [name, accepted] of Object.entries(
      childSpawnReportChecks(role, childReport, f.token),
    ))
      check(accepted, name);
    const safety = await f.store.readExecutionGroupSafety({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
    });
    check(safety.quiescent, 'original-execution-group-quiescent');
    const rootRuns = (await f.store.getView('s')).runs.filter(
      (run) => run.rootWorkCommandId === 'work',
    );
    check(
      rootRuns.length > 0 && rootRuns.every((run) => run.status === 'completed' && !run.isActive),
      'original-parent-task-completed',
    );
    for (const [path, body] of Object.entries(f.originals))
      check(
        readFileSync(join(f.workspace, path), 'utf8') === body,
        `original-business-bytes-${path}`,
      );
    check(f.browserRequests.length === 0, 'no-unrequested-browser-call');
    if (role === 'worker')
      check(
        readFileSync(join(f.workspace, 'result.txt'), 'utf8') === f.originals['source.txt'],
        'exact-worker-delivery',
      );
    else check(!existsSync(join(f.workspace, 'result.txt')), 'readonly-no-business-delivery');
    if (mode === 'full') check(approvals.length === 0, 'full-no-approval-card');
    check(
      !executions.some(
        (row) =>
          row.sessionId === 's' &&
          row.kind === 'tool' &&
          ['files.write', 'files.edit'].includes(row.definitionId),
      ),
      'parent-no-file-mutation-tool',
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : 'child-spawn-failed';
  } finally {
    try {
      const directory = await f.directory();
      save(join(f.evidence, 'executions.json'), directory);
      save(join(f.evidence, 'bindings.json'), f.bindings);
      save(join(f.evidence, 'browser-assets.json'), {
        assets: f.browserAssetEvidence,
        endpoint: f.browserEndpoint,
        browserActionsQualified: false,
        sourceAssetLocationBridgeOnly: true,
      });
      save(join(f.evidence, 'models.json'), {
        requests: live.requests,
        wire: live.wire,
        wireRequests: live.wireRequests,
        usage: live.usage,
        metadata: live.metadata,
        attemptFailures: live.attemptFailures,
      });
      const canonical = await saveLiveCanonicalModelEvidence({
        runtime: f.runtime,
        store: f.store,
        requests: f.requests,
        root: f.evidence,
        subjectId: 'owner',
        verifyRequests: true,
      });
      checks.canonicalOriginalsComplete =
        canonical.complete && canonical.requestIdentity?.matches === true;
      for (const sessionId of directory.sessions) {
        const logs = [];
        for await (const page of readLiveSessionLogPages(f.store, {
          expectedStoreId: f.expectedStoreId,
          sessionId,
          subjectId: 'owner',
        }))
          logs.push(page);
        save(join(f.evidence, `logs-${sessionId}.json`), logs);
      }
      const outputs: Record<string, unknown> = {};
      for (const job of directory.executions.filter((row) => row.kind === 'job')) {
        const items = [];
        let afterSeq = '0';
        for (;;) {
          const page = await f.store.listExecutionOutput({
            executionId: job.id,
            afterSeq,
            limit: 200,
          });
          items.push(...page.items);
          if (!page.items.length || page.items.at(-1)!.throughSeq === page.highWaterSeq) break;
          afterSeq = page.items.at(-1)!.throughSeq;
        }
        outputs[job.id] = items;
      }
      save(join(f.evidence, 'job-output.json'), outputs);
    } catch (error) {
      errors.push(`evidence:${error instanceof Error ? error.message : 'unknown'}`);
    }
    try {
      await f.close();
    } catch (error) {
      errors.push(`close:${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  const codeAfter = liveCodeEvidence();
  checks.codeUnchanged = codeBefore.workingTreeSha256 === codeAfter.workingTreeSha256;
  const result = {
    role,
    mode,
    status:
      !failure && !errors.length && Object.values(checks).every(Boolean)
        ? 'assertions_passed'
        : 'needs_review',
    failure,
    errors,
    checks,
    approvals,
    requests: live.requests.length,
    model: 'gpt-6.1-terra',
    reasoningEffort: 'low',
    requestLimit: null,
    timeoutMs: null,
    requestTimeoutMs: null,
    preserveSdkAttemptErrors: true,
    codeBefore,
    codeAfter,
    codeUnchanged: codeBefore.workingTreeSha256 === codeAfter.workingTreeSha256,
    semanticReviewRequired: true,
    mechanicalAssertionsOnly: true,
    semanticChecks,
    qualification:
      'Test-injected actual model with default Service policy; no Browser task qualification.',
  };
  save(join(root, 'result.json'), result);
  return result;
}

if (import.meta.main) {
  assert(process.env.KITE_RUN_LIVE_CHILD_SPAWN === '1', 'child-spawn-live-opt-in-required');
  assert(process.platform === 'darwin', 'child-spawn-live-native-macos-required');
  const output = resolve(process.argv[2] ?? '');
  assert(
    isAbsolute(process.argv[2] ?? '') &&
      output.startsWith(`${resolve('dist/acceptance')}/`) &&
      !existsSync(output),
    'child-spawn-new-owned-output-required',
  );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(Error('operator-interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const results = [];
  try {
    for (const mode of ['accept_edits', 'auto', 'full'] as const)
      for (const role of ['worker', 'explore', 'review'] as const) {
        if (cancellation.signal.aborted) break;
        const result = await runChildSpawnCase(
          join(output, `${role}-${mode}`),
          role,
          mode,
          cancellation.signal,
        );
        results.push(result);
        save(join(output, 'report.json'), results);
        console.log(
          JSON.stringify({
            role,
            mode,
            status: result.status,
            failure: result.failure,
            requests: result.requests,
          }),
        );
      }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  process.exitCode =
    results.length === 9 &&
    results.every((row) => row.status === 'assertions_passed' && row.codeUnchanged)
      ? 0
      : 1;
}
