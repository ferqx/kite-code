import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ExecutionRecord, ExtensionRecord } from '@kite-ai/agent/storage';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../../../apps/service/src';
import {
  createDefaultProcessConfiguration,
  createUserConfiguration,
} from '../../../../apps/service/src/configuration';
import { initializeLivePermissionFixture } from '../../../../apps/service/test/fixtures/live-permission-fixture';
import { resolveDefaultWorktreeTarget } from '../../../../packages/agent/src/tools/git-worktree/protocol';
import { verifyWorktreeExecutionEvidence } from '../../../fixtures/worktree-execution-evidence';
import { readLiveExecutionDirectory, readLiveSessionLogPages } from './approval-execution-fixture';
import {
  assertWorktreeLiveStartupHome,
  classifyWorktreeLiveVerification,
  completeJobOutput,
  finalizeWorktreeLiveAcceptance,
  newLiveOutputRoot,
  worktreeLiveShellReferenceEvidence,
} from './git-worktree-evidence';
import { runGitWorktreeNativePreflight } from './git-worktree-native-preflight';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture } from './live-model-fixture';

// Opt-in real Provider test. Only synthetic Git data is presented to the model.
// Failed/protected/replacement worktrees and all private evidence are retained.
// This runner never performs force or recursive filesystem/worktree cleanup.
type Case =
  | 'primary'
  | 'child-approval'
  | 'child-readonly'
  | 'child-auto'
  | 'child-notification'
  | 'child-default';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const save = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const append = (path: string, value: unknown) =>
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ['/usr/bin/git', '--no-replace-objects', '--no-lazy-fetch', ...args],
    {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  assert.equal(result.exitCode, 0, 'owned-fixture-git-command-failed');
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).replace(/\n$/, '');
}
function sourceSnapshot(source: string) {
  return {
    head: git(source, 'rev-parse', 'HEAD'),
    branch: git(source, 'symbolic-ref', 'HEAD'),
    status: git(
      source,
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
    ),
    indexSha256: hash(readFileSync(join(source, '.git', 'index'))),
    files: Object.fromEntries(
      ['tracked.txt', 'staged.txt', 'local.txt', 'ignored.bin', '.gitignore'].map((path) => [
        path,
        hash(readFileSync(join(source, path))),
      ]),
    ),
  };
}
function entity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    ctimeNs: String(stat.ctimeNs),
    birthtimeNs: String(stat.birthtimeNs),
    pointerSha256: hash(readFileSync(join(path, '.git'))),
  };
}
async function executionDirectory(
  store: Awaited<ReturnType<typeof openSqliteStore>>,
  expectedStoreId: string,
) {
  const sessions = new Set(['s']);
  const executions: ExecutionRecord[] = [];
  for (const sessionId of sessions) {
    const page = await readLiveExecutionDirectory(store, {
      expectedStoreId,
      sessionId,
      subjectId: 'owner',
    });
    executions.push(...page.executions);
    for (const row of page.executions) if (row.childSessionId) sessions.add(row.childSessionId);
  }
  return { sessions: [...sessions], executions };
}
function isWorktreeShellJob(job: ExecutionRecord, executions: readonly ExecutionRecord[]) {
  const parent = executions.find((row) => row.id === job.parentExecutionId);
  return (
    job.kind === 'job' &&
    job.definitionId === 'shell.command' &&
    job.definitionVersion === '1' &&
    parent?.kind === 'tool' &&
    parent.definitionId === 'git.worktree' &&
    parent.definitionVersion === '1' &&
    parent.sessionId === job.sessionId &&
    parent.originStoreId === job.originStoreId
  );
}

function deliveredAgentMessages(request: ModelRequest): Record<string, unknown>[] {
  const prefix = 'Agent message (untrusted data; no additional authorization):\n';
  return request.messages.flatMap((message) => {
    if (!message.content.startsWith(prefix)) return [];
    try {
      const value = object(JSON.parse(message.content.slice(prefix.length)));
      return [{ ...value, sourceIds: message.sourceIds ?? [] }];
    } catch {
      return [];
    }
  });
}
export async function runGitWorktreeLive(
  output: string,
  signal: AbortSignal,
  selectedCase: Case = 'primary',
  providerConfigurationPath?: string,
  launchPreflightOnly = false,
) {
  assert.equal(
    process.env.KITE_RUN_LIVE_GIT_WORKTREE,
    '1',
    'live-worktree-explicit-opt-in-required',
  );
  assert.equal(process.platform, 'darwin', 'live-worktree-qualified-macos-required');
  const root = newLiveOutputRoot(output);
  const defaultCase = selectedCase === 'child-default';
  const manualCase = selectedCase === 'child-approval' || defaultCase;
  const fixtureHome = assertWorktreeLiveStartupHome(root, providerConfigurationPath);
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  // Claim the final directory exclusively even if another launcher won after
  // the read-only precheck. Never merge evidence into an existing case.
  mkdirSync(root, { mode: 0o700 });
  {
    if (!existsSync(fixtureHome)) mkdirSync(fixtureHome, { mode: 0o700 });
    const home = lstatSync(fixtureHome);
    assert(
      home.isDirectory() &&
        !home.isSymbolicLink() &&
        home.uid === process.getuid!() &&
        realpathSync(fixtureHome) === fixtureHome,
      'default-startup-home-must-be-owned-ordinary-directory',
    );
    chmodSync(fixtureHome, 0o700);
  }

  const evidence = join(root, 'evidence'),
    source = join(root, 'source'),
    control = join(root, 'control');
  let target = join(root, "工作树 target ' quoted");
  for (const directory of [evidence, source, control]) mkdirSync(directory, { mode: 0o700 });
  const readyMarker = `consumer-ready-${randomUUID()}`;
  const canonicalSource = realpathSync(source),
    nonce = randomUUID().replaceAll('-', ''),
    branch = `live-worktree-${nonce}`,
    createKey = `create-${nonce}`,
    removeKey = `remove-${nonce}`;
  const launchReport: Record<string, unknown> = {
    status: 'running',
    fixtureHome,
    homeMatchesStartup: homedir() === fixtureHome,
    outputCreated: true,
    providerConstructed: false,
    gitCommands: 0,
    nativeSupervision: 'not_started',
  };
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [
        join(
          import.meta.dir,
          '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
        ),
      ],
      target: 'bun',
      outdir: join(root, 'assets'),
      naming: 'shell-supervisor.js',
    });
    assert(built.success, 'native-supervisor-build');
    await runGitWorktreeNativePreflight({
      root,
      source,
      control,
      supervisorPath: built.outputs[0]!.path,
      fixtureHome,
      signal,
    });
    signal.throwIfAborted();
    launchReport.nativeSupervision = 'closed_and_verified';
    launchReport.status = 'launch_preflight_passed';
  } catch (error) {
    launchReport.status = 'needs_review';
    launchReport.nativeSupervision = 'failed_or_unknown';
    launchReport.error = error instanceof Error ? error.message : 'native-preflight-failed';
  }
  save(join(root, 'launch-preflight.json'), launchReport);
  if (launchReport.status !== 'launch_preflight_passed') {
    if (!launchPreflightOnly) save(join(root, 'result.json'), launchReport);
    return launchReport;
  }
  if (launchPreflightOnly) return launchReport;
  signal.throwIfAborted();
  const codeBefore = liveCodeEvidence();
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Owned Worktree Live');
  git(source, 'config', 'user.email', 'worktree-live@example.invalid');
  writeFileSync(join(source, 'tracked.txt'), 'committed baseline\n');
  writeFileSync(join(source, 'staged.txt'), 'committed stage baseline\n');
  writeFileSync(join(source, '.gitignore'), 'ignored.bin\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'Owned synthetic baseline');
  writeFileSync(join(source, 'staged.txt'), 'source staged change\n');
  git(source, 'add', 'staged.txt');
  writeFileSync(join(source, 'tracked.txt'), 'source unstaged change\n');
  writeFileSync(join(source, 'local.txt'), 'source untracked\n');
  writeFileSync(join(source, 'ignored.bin'), 'source ignored\n');
  const before = sourceSnapshot(source),
    profile = selectProfile({ dataRoot: join(root, 'state'), profile: 'live' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const approvals: Record<string, unknown>[] = [];
  const checks: Record<string, boolean> = { nativeSupervisorPreflight: true },
    turns: Record<string, unknown>[] = [],
    bindings: Record<string, unknown>[] = [],
    failures: string[] = [],
    reviewRequirements: Record<string, unknown>[] = [],
    events: { requestId: string; event: ModelEvent }[] = [];
  const report: Record<string, unknown> = {
    selectedCase,
    approver: manualCase
      ? 'trusted test user/operator through original Client interaction answer; never the business parent/child Agent'
      : null,
    startedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    executionStack: 'default-service-http-client-sqlite-native-shell',
    transportQualification:
      'test-injected actual configured adapter; no model/protocol substitution or response edits; no installed UI qualification',
    modelSelection: 'existing configured default; no explicit model override',
    requestLimit: null,
    timeoutMs: null,
    requestTimeoutMs: null,
    codeBefore,
    checks,
    reviewRequirements,
    turns,
    status: 'running',
    semanticReviewRequired: true,
    mechanicalAssertionsOnly: true,
    evidenceDirectory: evidence,
    profilePath: profile.profilePath,
    source: canonicalSource,
    target: defaultCase ? null : target,
    branch,
    createKey,
    removeKey,
  };
  const persist = () => save(join(root, 'result.json'), report);
  const check = (value: unknown, name: string) => {
    checks[name] = !!value;
    assert(value, name);
  };
  persist();
  let live: Awaited<ReturnType<typeof createLiveModelFixture>> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let locksOwnedByService = false;
  let expectedStoreId: string | undefined;
  let canonical: unknown;
  let finalDirectory: Awaited<ReturnType<typeof executionDirectory>> | undefined;
  let replacement: ReturnType<typeof entity> | undefined;
  try {
    signal.throwIfAborted();
    live = await createLiveModelFixture({
      userConfigurationPath: providerConfigurationPath,
      signal,
      requestTimeoutMs: null,
      captureWireRequests: true,
      preserveSdkAttemptErrors: true,
      beforeWireRequest(entry) {
        append(join(evidence, 'wire-requests.ndjson'), entry);
      },
    });
    report.model = structuredClone(live.metadata);
    // The adapter reads the original document; business configuration and the
    // persistent default root live under this child process's startup HOME.
    check(homedir() === fixtureHome, 'host-home-is-isolated-fixture');
    report.fixtureHome = fixtureHome;
    if (defaultCase) {
      checks['default-host-home-is-isolated-fixture'] = true;
      report.defaultRoot = join(fixtureHome, '.kite-code', 'worktrees');
      report.target = null;
    }
    const observedModel: ModelAdapter = {
      describeRequest: live.model.describeRequest?.bind(live.model),
      async *stream(request, context) {
        append(join(evidence, 'model-requests.ndjson'), request);
        for await (const event of live!.model.stream(request, context)) {
          events.push({ requestId: request.requestId, event: structuredClone(event) });
          append(join(evidence, 'model-events.ndjson'), { requestId: request.requestId, event });
          yield event;
        }
      },
    };
    const configurationPath = defaultCase
      ? join(fixtureHome, '.kite-code', 'kite-code.jsonc')
      : join(profile.profilePath, 'config.jsonc');
    if (defaultCase) mkdirSync(dirname(configurationPath), { mode: 0o700 });
    if (defaultCase) report.userConfigurationPath = configurationPath;
    save(configurationPath, {
      modelId: live.modelId,
      models: [
        {
          id: live.modelId,
          provider: 'compatible',
          model: 'injected-live',
          baseURL: 'http://127.0.0.1:1/v1',
        },
      ],
      tools: [
        { id: 'git.worktree', definitionVersion: '1' },
        ...(defaultCase
          ? ['shell.execute', 'shell.launch', 'shell.read', 'shell.wait', 'shell.stop'].map(
              (id) => ({ id, definitionVersion: '1' }),
            )
          : []),
        ...(selectedCase === 'child-notification'
          ? ['files.read', 'files.write', 'files.edit'].map((id) => ({ id }))
          : []),
        ...(selectedCase === 'primary'
          ? []
          : [
              'task.spawn',
              'task.list',
              'task.events',
              ...(selectedCase === 'child-notification' ? ['task.message', 'task.follow_up'] : []),
            ].map((id) => ({
              id,
              definitionVersion: '1',
            }))),
      ],
    });
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: configurationPath,
      localCodex: false,
      credentialBackend: createTemporaryCredentialBackend(),
      shell: {
        platform: 'darwin',
        configurationId: 'owned-worktree-live',
        env: { PATH: '/usr/bin:/bin', HOME: fixtureHome },
        supervisorPath: built.outputs[0]!.path,
        bunExecutable: process.execPath,
        shellExecutable: '/bin/sh',
        host: {
          controlBase: control,
          protectedRoots: [profile.dataRoot, control, evidence],
          readonlyAssets: [join(root, 'assets')],
          runtimeReadOnlyRoots: [dirname(process.execPath)],
        },
      },
    });
    store = await openSqliteStore(profile);
    locks = createWorkspaceSerialLocks(profile);
    host.bindWorkspaceSerialLocks?.(locks);
    const instrument = (binding: RunConfiguration, actor: string): RunConfiguration => {
      bindings.push({
        actor,
        snapshot: binding.snapshot ?? null,
        toolIds: binding.toolIds ?? [],
        authorizationCheck: binding.authorizationCheck
          ? {
              id: binding.authorizationCheck.id,
              version: binding.authorizationCheck.version,
              timeoutMs: binding.authorizationCheck.timeoutMs ?? null,
            }
          : null,
      });
      return {
        ...binding,
        model: observedModel,
        ...(binding.authorizationCheck
          ? { authorizationCheck: { ...binding.authorizationCheck, model: observedModel } }
          : {}),
      };
    };
    runtime = createRuntime({
      ...host,
      permissions: host.permissions!,
      store,
      artifacts: createArtifactStore({ profile, store }),
      workspaceSerialLocks: locks,
      modelConcurrency: 2,
      processConcurrency: 2,
      maxConcurrentSubagents: selectedCase === 'child-notification' ? 2 : 1,
      resolveRunConfiguration: async (input) =>
        instrument(await host.resolveRunConfiguration!(input), 'root'),
      resolveChildRunConfiguration: async (input) =>
        instrument(await host.resolveChildRunConfiguration!(input), 'child'),
    });
    const permissions = host.permissionManagement!(runtime);
    expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Owned worktree live source',
      rootUri: pathToFileURL(canonicalSource).href,
    });
    service = await startService({
      runtime,
      permissionManagement: permissions,
      subjectId: 'owner',
      buildId: 'owned-git-worktree-live',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      beforeResourceClose: () => locks!.close(),
    });
    locksOwnedByService = true;
    client = createClient({
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
      commandId: 'create-session',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Owned Git worktree live',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      workspaceId: 'w',
      mode: manualCase ? 'accept_edits' : selectedCase === 'child-auto' ? 'auto' : 'full',
      trusted: true,
      nativeShellRead: true,
    });
    async function turn(id: string, assignment: string) {
      signal.throwIfAborted();
      const cursor = (await store!.getMetadata()).lastChangeCursor;
      let after = cursor;
      const prompt = `这是自有合成仓库的 Git 工作树验收。来源目录 ${JSON.stringify(canonicalSource)}，${defaultCase ? '本次创建采用工具默认持久目录，删除目标只能取同次成功创建的准确回执路径。' : `只允许操作本次准确来源和目标 ${JSON.stringify(target)}。`}${assignment} 不修改来源已有本地文件、索引、分支或配置；不迁移会话工作目录；不联网；不创建报告文件；${selectedCase === 'primary' ? '不委派。' : '只允许此次单层直接子 Agent，不得创建孙级协作者。'}工具身份与参数以实际目录为准。结果未知时只观察原操作，不换 key 重发。按真实回执报告，不把受理或准备当完成。`;
      await client!.startRun('s', {
        expectedStoreId: expectedStoreId!,
        commandId: id,
        kind: 'run.start',
        content: prompt,
      });
      const entry: Record<string, unknown> = {
        id,
        prompt,
        startedAt: new Date().toISOString(),
        afterCursor: cursor,
      };
      turns.push(entry);
      persist();
      for (;;) {
        signal.throwIfAborted();
        const page = await runtime!.getChanges({ after, limit: 200 });
        for (const event of page.events) append(join(evidence, 'changes.ndjson'), event);
        if (page.events.length) after = page.events.at(-1)!.cursor;
        const observedDirectory = await executionDirectory(store!, expectedStoreId!);
        for (const sessionId of observedDirectory.sessions) {
          const pending = await client!.listInteractions(sessionId, {
            storeId: expectedStoreId!,
            state: 'pending',
            origin: 'all',
          });
          for (const card of pending.interactions) {
            if (approvals.some((value) => object(value.card).id === card.id)) continue;
            save(join(evidence, `pending-${card.id}.json`), card);
            check(
              manualCase && card.kind === 'approval',
              'only-explicit-child-approval-case-may-answer',
            );
            const execution = await store!.getExecution(card.executionId),
              child = execution ? await store!.getSession(execution.sessionId) : null;
            check(
              execution &&
                execution.originStoreId === expectedStoreId &&
                execution.sessionId === card.sessionId &&
                execution.definitionId === card.definitionId &&
                execution.definitionVersion === card.definitionVersion &&
                execution.attempt === card.attempt &&
                execution.status === 'planned' &&
                execution.authorization?.dispatched === false,
              'operator-original-unattempted-card-binding',
            );
            check(
              child?.parentSessionId === 's' &&
                card.presentationSessionId === 's' &&
                execution!.sessionId !== 's',
              'operator-approval-belongs-to-original-direct-child',
            );
            check(execution!.kind === 'tool', 'internal-job-must-inherit-original-tool-approval');
            const ownerTool = execution;
            check(
              ownerTool?.kind === 'tool' &&
                ownerTool.definitionId === 'git.worktree' &&
                ownerTool.definitionVersion === '1' &&
                ownerTool.sessionId === execution!.sessionId,
              'operator-scope-original-worktree-owner',
            );
            const intent = object(ownerTool!.input),
              action = intent.action;
            if (defaultCase && action === 'create') {
              target = resolveDefaultWorktreeTarget({
                defaultRoot: join(fixtureHome, '.kite-code', 'worktrees'),
                sourceCwd: canonicalSource,
                sessionId: execution!.sessionId,
                key: createKey,
              });
              report.target = target;
              persist();
            }
            check(
              (action === 'create' || action === 'remove') &&
                (defaultCase && action === 'create'
                  ? !('path' in intent)
                  : intent.path === target) &&
                intent.key === (action === 'create' ? createKey : removeKey) &&
                object(intent.permissions).filesystem === 'full_access' &&
                object(intent.permissions).network === 'none',
              'operator-exact-approved-child-intent',
            );
            check(
              action !== 'create' ||
                (intent.newBranch === branch &&
                  (intent.baseRef === undefined || intent.baseRef === 'HEAD')),
              'operator-exact-create-branch-and-base',
            );
            const phase = String(action);
            const beforeApproval = {
              targetExists: existsSync(target),
              targetEntity: existsSync(target) ? entity(target) : null,
              source: sourceSnapshot(source),
              registered: git(source, 'worktree', 'list', '--porcelain', '-z'),
            };
            check(
              JSON.stringify(beforeApproval.source) === JSON.stringify(before),
              'operator-no-premature-source-change',
            );
            check(
              action === 'create' ? !beforeApproval.targetExists : beforeApproval.targetExists,
              'operator-no-premature-target-mutation',
            );
            const branchValue = git(
              source,
              'for-each-ref',
              '--format=%(objectname)',
              `refs/heads/${branch}`,
            );
            check(
              action === 'create' ? branchValue === '' : branchValue === before.head,
              'operator-no-premature-branch-mutation',
            );
            const entry = {
              sequence: approvals.length + 1,
              approver: 'trusted-test-user/operator',
              businessAgentGranted: false,
              phase,
              action,
              card,
              execution,
              ownerTool: ownerTool!.id,
              before: beforeApproval,
            };
            save(join(evidence, `approval-${card.id}.json`), entry);
            const answer = await client!.answerInteraction(card.presentationSessionId, card.id, {
              expectedStoreId: expectedStoreId!,
              commandId: `approve-${card.id}`,
              expectedRevision: card.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
            approvals.push({ ...entry, answer });
            save(join(evidence, 'approvals.json'), approvals);
            persist();
          }
        }
        const command = await store!.getCommand(id),
          runId = object(command?.receipt).runId,
          run = typeof runId === 'string' ? await store!.getRun(runId) : null;
        if (command && ['failed', 'rejected', 'outcome_unknown'].includes(command.status))
          throw Error('primary-run-command-failed');
        if (run && !run.isActive) {
          const safety = await store!.readExecutionGroupSafety({
            expectedStoreId: expectedStoreId!,
            sessionId: 's',
            subjectId: 'owner',
          });
          if (safety.activeRunIds.length === 0 && safety.pendingCommandIds.length === 0) {
            check(run.status === 'completed', `${id}-run-completed`);
            entry.run = run;
            entry.safety = safety;
            entry.completedAt = new Date().toISOString();
            break;
          }
        }
        await Bun.sleep(50);
      }
      const directory = await executionDirectory(store!, expectedStoreId!);
      const tools = directory.executions.filter(
        (row) =>
          row.kind === 'tool' &&
          row.rootWorkCommandId === id &&
          row.definitionId === 'git.worktree',
      );
      entry.toolExecutionIds = tools.map((row) => row.id);
      entry.requests = live!.requests
        .filter((request) =>
          directory.executions.some(
            (row) => row.id === request.requestId && row.rootWorkCommandId === id,
          ),
        )
        .map((request) => request.requestId);
      save(join(evidence, `turn-${id}.json`), {
        ...entry,
        executions: directory.executions.filter((row) => row.rootWorkCommandId === id),
      });
      persist();
      return tools;
    }
    const requireOne = (tools: ExecutionRecord[], action: string, key?: string) => {
      const requested = tools.filter((tool) => object(tool.input).action === action);
      check(
        action === 'list' ? requested.length >= 1 : requested.length === 1,
        `${action}-${key ?? 'snapshot'}-requested-operation-count`,
      );
      check(
        tools.every(
          (tool) => object(tool.input).action === action || object(tool.input).action === 'list',
        ),
        `${action}-${key ?? 'snapshot'}-only-additional-readonly-list`,
      );
      check(
        tools
          .filter((tool) => object(tool.input).action === 'list')
          .every(
            (tool) => tool.status === 'succeeded' && object(tool.result).outcome === 'succeeded',
          ),
        `${action}-${key ?? 'snapshot'}-verification-lists-succeeded`,
      );
      const tool = requested[0]!;
      check(
        object(tool.input).action === action &&
          (key === undefined || object(tool.input).key === key),
        `${action}-${key ?? 'snapshot'}-exact-intent`,
      );
      check(
        tool.status === 'succeeded' && object(tool.result).outcome === 'succeeded',
        `${action}-${key ?? 'snapshot'}-actual-success`,
      );
      return tool;
    };
    if (selectedCase === 'primary') {
      const listed = requireOne(
        await turn(
          'list',
          '请列出当前仓库真实登记的所有工作树，报告来源是否为当前工作树。此步只查询。',
        ),
        'list',
      );
      check(
        Array.isArray(object(object(listed.result).details).worktrees),
        'list-real-registration-array',
      );
      const created = requireOne(
        await turn(
          'create',
          `请从当前来源 checkout 的默认 HEAD 创建工作树 ${JSON.stringify(target)}，新本地分支 ${JSON.stringify(branch)}。创建意图 key 必须为 ${JSON.stringify(createKey)}，申请 filesystem=full_access、network=none。不要覆盖已有目录。确认真实完成后报告路径、HEAD、分支及会话 cwd 是否改变。`,
        ),
        'create',
        createKey,
      );
      check(existsSync(target), 'create-target-exists');
      check(git(target, 'rev-parse', 'HEAD') === before.head, 'create-frozen-source-head');
      check(
        git(target, 'symbolic-ref', 'HEAD') === `refs/heads/${branch}`,
        'create-new-local-branch',
      );
      check(
        readFileSync(join(target, 'tracked.txt'), 'utf8') === 'committed baseline\n' &&
          !existsSync(join(target, 'local.txt')) &&
          !existsSync(join(target, 'ignored.bin')),
        'create-committed-content-only',
      );
      check(
        object(object(created.result).details).cwdChanged === false,
        'create-cwd-receipt-false',
      );
      requireOne(
        await turn(
          'remove',
          `现在正常删除上一步工作树 ${JSON.stringify(target)}。删除意图 key 必须为 ${JSON.stringify(removeKey)}，申请 filesystem=full_access、network=none。遵守所有删除检查；保留新本地分支 ${JSON.stringify(branch)}、标签和来源。若拒绝或未知，如实报告并停止，不 force、不清理残留。`,
        ),
        'remove',
        removeKey,
      );
      check(!existsSync(target), 'remove-target-absent');
      check(
        git(source, 'rev-parse', `refs/heads/${branch}`) === before.head,
        'remove-branch-retained',
      );
      // Test operator creates a distinct replacement only after the prior remove is certain.
      git(source, 'worktree', 'add', '--detach', '--', target, before.head);
      replacement = entity(target);
      save(join(evidence, 'replacement-before-replay.json'), replacement);
      const replayed = requireOne(
        await turn(
          'replay',
          `测试操作员已在同一路径重建一个不同的工作树实体。请使用原删除意图的准确 key ${JSON.stringify(removeKey)} 和原路径 ${JSON.stringify(target)}、原权限 filesystem=full_access、network=none，并逐字保持此前 remove 调用的其他字段（包括省略字段与 timeoutMs），查询该意图的历史回执。不得申请新 key 或新删除，不得删新实体。明确区分旧操作成功回执与当前目录状态。`,
        ),
        'remove',
        removeKey,
      );
      check(object(object(replayed.result).details).replayed === true, 'replay-historical-receipt');
      check(
        JSON.stringify(entity(target)) === JSON.stringify(replacement),
        'replay-preserves-replacement-entity',
      );
      finalDirectory = await executionDirectory(store, expectedStoreId);
      check(
        !finalDirectory.executions.some(
          (row) => row.parentExecutionId === replayed.id && row.kind === 'job',
        ),
        'replay-no-replacement-job',
      );
      check(
        live.requests.every(
          (request) =>
            request.tools.some((tool) => tool.id === 'git_worktree') &&
            request.tools.every((tool) => ['git_worktree', 'ask_user'].includes(tool.id)) &&
            new Set(request.tools.map((tool) => tool.id)).size === request.tools.length,
        ),
        'model-only-git-worktree-and-service-question-tool',
      );
      check(
        finalDirectory.executions
          .filter((row) => row.kind === 'tool')
          .every((row) => row.definitionId === 'git.worktree'),
        'no-model-shell-or-unrelated-tool',
      );
    } else if (selectedCase === 'child-notification') {
      await turn(
        'notify-work',
        `请只协调两名直接的默认可写协作者 A 与 B，不替他们执行 Git 或文件读写。先创建 B（省略 preset）；B 的初始任务不得包含准确目标路径，连示例或模板也不得包含；只有 parent 实际收到创建成功的工具通知后才可向 B 转发准确目标路径。B 的完整任务是：你是 consumer-B；此时不知道新工作树路径，先用 send_agent_message 向 parent 发送准确就绪标记 ${JSON.stringify(readyMarker)}；工具返回 accepted:true、delivery:queued 后立即结束初轮，返回 BUSINESS_PENDING、原就绪标记、已完成的就绪通知及尚缺准确工作树路径的未完成事实。排队确认不表示 parent 已读，不再等待任何确认或调用 wait_agent_events，不得抢先读取、写入或自行猜目标。保留同一个 B 供 parent 明确 follow_up；续作收到 parent 给出的准确新工作树绝对路径后，在该路径读取 tracked.txt 的真实原文，将刚读到的完整原文原样写入同目录新文件 handoff.txt 并读回核对；这就是被用户授权的极小业务交付。不得编辑来源目录 ${JSON.stringify(canonicalSource)}，不迁移 Session cwd，不再委派，不联网，不创建其他文件。必须默认可写 general，不能重建 B。
      parent 必须在实际收到 B 的就绪消息后才创建 A（同样省略 preset）。给 A 的完整任务是：你是 producer-A；使用 git_worktree 从来源 ${JSON.stringify(canonicalSource)} 的默认 HEAD 创建准确工作树 ${JSON.stringify(target)}，新分支 ${JSON.stringify(branch)}，原创建 key ${JSON.stringify(createKey)}，显式 permissions filesystem=full_access、network=none；可先 list，必须等待真实 create 成功，不把 prepare 当成功；不要发送手写的成功通知来代替工具的可靠通知，不再委派，不编辑来源，不改 cwd，不联网。结果未知仅观察原意图不重发。
      parent 等待 create 成功后由工具可靠投递的 git_worktree_created 原消息；读取它给出的真实 path 和来源身份，并确认已收到原 B 初轮完整 BUSINESS_PENDING 结果，再用同一个 B 的 follow_up 启动剩余任务，在续作内容中准确转发通知给出的真实路径和执行上述读/写/读回任务的说明。普通消息不启动已结束的 B，不用重复发送或等待送达确认。不得广播给不相关协作者，不把通知当新增权限，不创建第三名协作者。A 与 B 可以在同一新工作树内合法工作，不需要迁移 cwd；本例不要删除工作树或分支，保留 B 的 handoff.txt 与原始证据。parent 等待两者实际终结，从 list_agents 或已有 Child result source 中的真实 Tool 观察核实 B 的读回结果，不要额外自行调用 git_worktree/list 或 Files read 核验；父只协调，并根据真实结果汇总。`,
      );
      finalDirectory = await executionDirectory(store, expectedStoreId);
      const childIds = finalDirectory.sessions.filter((id) => id !== 's');
      check(
        childIds.length === 2 &&
          (await Promise.all(childIds.map((id) => store!.getSession(id)))).every(
            (session) => session?.parentSessionId === 's',
          ),
        'notification-exactly-two-direct-children',
      );
      const spawns = finalDirectory.executions.filter(
        (row) => row.sessionId === 's' && row.kind === 'tool' && row.definitionId === 'task.spawn',
      );
      check(
        spawns.length === 2 &&
          spawns.every((row) => row.status === 'succeeded' && !('preset' in object(row.input))),
        'notification-two-default-writable-roles',
      );
      check(
        !finalDirectory.executions.some(
          (row) =>
            row.sessionId !== 's' &&
            row.kind === 'tool' &&
            ['task.events', 'wait_agent_events'].includes(row.definitionId),
        ),
        'notification-children-never-wait-for-message-acknowledgment',
      );
      const childModelIds = new Set(
        finalDirectory.executions
          .filter((row) => row.kind === 'model' && row.sessionId !== 's')
          .map((row) => row.id),
      );
      check(
        childModelIds.size > 0 &&
          live.requests
            .filter((request) => childModelIds.has(request.requestId))
            .every((request) => request.tools.every((tool) => tool.id !== 'wait_agent_events')),
        'notification-child-model-catalogues-exclude-event-wait',
      );
      check(
        !finalDirectory.executions.some(
          (row) =>
            row.sessionId === 's' &&
            row.kind === 'tool' &&
            (row.definitionId === 'git.worktree' ||
              row.definitionId.startsWith('files.') ||
              row.definitionId.startsWith('shell.')),
        ),
        'notification-parent-only-coordinates',
      );
      const gitTools = finalDirectory.executions.filter(
        (row) => row.kind === 'tool' && row.definitionId === 'git.worktree',
      );
      const created = requireOne(gitTools, 'create', createKey);
      check(
        object(created.input).path === target &&
          object(created.input).newBranch === branch &&
          object(object(created.input).permissions).filesystem === 'full_access' &&
          object(object(created.input).permissions).network === 'none',
        'notification-exact-create-intent',
      );
      const producerId = created.sessionId;
      const ready = finalDirectory.executions.find(
        (row) =>
          row.kind === 'tool' &&
          row.definitionId === 'task.message' &&
          row.sessionId !== 's' &&
          object(row.input).target === 'parent' &&
          String(object(row.input).content).includes(readyMarker) &&
          row.status === 'succeeded',
      );
      check(ready && ready.sessionId !== producerId, 'notification-distinct-consumer-readiness');
      const consumerId = ready!.sessionId;
      const producerCarrier = finalDirectory.executions.find(
        (row) =>
          row.kind === 'job' &&
          row.id === created.parentExecutionId &&
          row.childSessionId === producerId,
      )!;
      const consumerInitialCarrier = finalDirectory.executions.find(
        (row) =>
          row.kind === 'job' &&
          row.id === ready!.parentExecutionId &&
          row.childSessionId === consumerId,
      )!;
      const producerSpawn = finalDirectory.executions.find(
        (row) => row.id === producerCarrier.parentExecutionId,
      )!;
      const consumerSpawn = finalDirectory.executions.find(
        (row) => row.id === consumerInitialCarrier.parentExecutionId,
      )!;
      check(
        !String(object(consumerSpawn.input).prompt).includes(target),
        'notification-consumer-not-given-target-prematurely',
      );
      const modelForTool = (tool: ExecutionRecord) =>
        live!.requests.find(
          (request) =>
            finalDirectory!.executions.some(
              (row) => row.id === request.requestId && row.sessionId === tool.sessionId,
            ) &&
            events.some(
              (row) =>
                row.requestId === request.requestId &&
                row.event.type === 'tool_call' &&
                row.event.id === tool.callId,
            ),
        );
      const spawnModel = modelForTool(producerSpawn);
      check(
        spawnModel &&
          deliveredAgentMessages(spawnModel).some(
            (mail) =>
              mail.sourceSessionId === consumerId &&
              mail.sourceExecutionId === ready!.id &&
              String(mail.content).includes(readyMarker),
          ),
        'notification-parent-received-readiness-before-producer-spawn',
      );
      const markerPath = join(target, 'tracked.txt'),
        receiptPath = join(target, 'handoff.txt');
      const consumerReads = finalDirectory.executions.filter(
        (row) =>
          row.kind === 'tool' &&
          row.sessionId === consumerId &&
          row.definitionId === 'files.read' &&
          object(row.input).path === markerPath &&
          row.status === 'succeeded',
      );
      const consumerWrites = finalDirectory.executions.filter(
        (row) =>
          row.kind === 'tool' &&
          row.sessionId === consumerId &&
          ['files.write', 'files.edit'].includes(row.definitionId) &&
          object(row.input).path === receiptPath &&
          row.status === 'succeeded',
      );
      check(
        consumerReads.length > 0 && consumerWrites.length === 1,
        'notification-consumer-actual-shared-tree-read-and-write',
      );
      const readModel = modelForTool(consumerReads[0]!);
      check(readModel, 'notification-original-consumer-read-model');
      const consumerCarrier = finalDirectory.executions.find(
        (row) =>
          row.kind === 'job' &&
          row.id === consumerWrites[0]!.parentExecutionId &&
          row.childSessionId === consumerId,
      )!;
      check(
        producerCarrier?.status === 'succeeded' && consumerCarrier?.status === 'succeeded',
        'notification-business-carrying-child-results-complete',
      );
      check(
        producerCarrier.definitionId === 'agent/general' &&
          consumerInitialCarrier.definitionId === 'agent/general' &&
          consumerCarrier.definitionId === 'agent/general',
        'notification-original-carriers-use-current-default-general',
      );
      const consumerFollowUp = finalDirectory.executions.find(
        (row) =>
          row.id === consumerCarrier.parentExecutionId &&
          row.sessionId === 's' &&
          row.kind === 'tool' &&
          row.definitionId === 'task.follow_up' &&
          row.status === 'succeeded' &&
          object(row.input).agentId === consumerId,
      );
      check(
        consumerInitialCarrier.status === 'succeeded' &&
          String(object(consumerInitialCarrier.result).content).includes('BUSINESS_PENDING') &&
          String(object(consumerInitialCarrier.result).content).includes(readyMarker) &&
          consumerCarrier.id !== consumerInitialCarrier.id &&
          consumerFollowUp,
        'notification-original-pending-consumer-explicitly-continued-in-a-new-turn',
      );
      const controlEvents = readFileSync(join(evidence, 'changes.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => object(JSON.parse(line)))
        .filter((event) => event.type === 'agent.control_applied');
      const controls = await Promise.all(
        [...new Set(controlEvents.map((event) => String(event.objectId)))].map((id) =>
          store!.getCommand(id),
        ),
      );
      const candidates = finalDirectory.executions.filter(
        (row) =>
          row.kind === 'tool' &&
          ['task.message', 'task.follow_up'].includes(row.definitionId) &&
          row.sessionId === 's' &&
          object(row.input).agentId === consumerId &&
          String(object(row.input).content).includes(target) &&
          row.status === 'succeeded',
      );
      let forwarded: ExecutionRecord | undefined;
      let forwardDelivery: Record<string, unknown> | undefined;
      for (const candidate of candidates) {
        const body = String(object(candidate.input).content);
        if (candidate.definitionId === 'task.message') {
          const mail = deliveredAgentMessages(readModel!).find(
            (value) =>
              value.sourceSessionId === 's' &&
              value.sourceExecutionId === candidate.id &&
              value.content === body,
          );
          if (mail) {
            forwarded = candidate;
            forwardDelivery = { kind: 'message', mail };
            break;
          }
        } else {
          const control = controls.find(
            (command) =>
              command?.status === 'applied' &&
              command.originStoreId === expectedStoreId &&
              command.sessionId === 's' &&
              object(command.request).sourceExecutionId === candidate.id &&
              object(command.request).action === 'follow_up' &&
              object(command.request).agentId === consumerId &&
              object(command.request).content === body,
          );
          if (!control) continue;
          const receipt = object(control.receipt);
          if (receipt.mode === 'new_turn') {
            const ref = object(receipt.ref);
            const readCarrier = finalDirectory.executions.find(
              (row) =>
                row.kind === 'job' &&
                row.id === consumerReads[0]!.parentExecutionId &&
                row.childSessionId === consumerId,
            );
            const source = readCarrier ? await store.getCommand(readCarrier.originCommandId) : null;
            const sourceMessage = readModel!.messages.find(
              (message) =>
                message.role === 'user' &&
                message.content === body &&
                message.sourceIds?.includes(readCarrier!.id),
            );
            if (
              readCarrier &&
              readCarrier.id === ref.executionId &&
              readCarrier.parentExecutionId === candidate.id &&
              source?.originStoreId === expectedStoreId &&
              object(source.request).parentExecutionId === candidate.id &&
              sourceMessage
            ) {
              forwarded = candidate;
              forwardDelivery = {
                kind: 'follow_up_new_turn',
                control,
                readCarrier,
                sourceCommand: source,
                sourceMessage,
              };
              break;
            }
          } else if (receipt.mode === 'steer') {
            for (const message of readModel!.messages) {
              if (message.role !== 'user') continue;
              let envelope: Record<string, unknown>;
              try {
                envelope = object(JSON.parse(message.content));
              } catch {
                continue;
              }
              if (
                envelope.kind !== 'agent_message' ||
                envelope.sourceSessionId !== 's' ||
                envelope.sourceExecutionId !== candidate.id ||
                envelope.content !== body ||
                envelope.carrierExecutionId !== consumerReads[0]!.parentExecutionId
              )
                continue;
              const sources = await Promise.all(
                (message.sourceIds ?? []).map((id) => store!.getCommand(id)),
              );
              const source = sources.find(
                (command) =>
                  command !== null &&
                  command.originStoreId === expectedStoreId &&
                  command.sessionId === consumerId &&
                  command.status === 'applied' &&
                  object(command.request).content === message.content,
              );
              if (source) {
                forwarded = candidate;
                forwardDelivery = {
                  kind: 'follow_up_steer',
                  control,
                  sourceCommand: source,
                  sourceMessage: message,
                };
                break;
              }
            }
            if (forwarded) break;
          }
        }
      }
      check(
        forwarded && forwardDelivery,
        'notification-consumer-received-exact-original-parent-message-or-followup-source',
      );
      const forwardingModel = modelForTool(forwarded!);
      check(
        consumerInitialCarrier.resultAcceptance &&
          forwardingModel?.messages.some(
            (message) =>
              message.sourceIds?.includes(consumerInitialCarrier.resultAcceptance!.sourceId) &&
              message.content.includes('BUSINESS_PENDING') &&
              message.content.includes(readyMarker),
          ),
        'notification-parent-consumes-original-pending-result-before-continuation',
      );
      const reliableNotice =
        forwardingModel &&
        deliveredAgentMessages(forwardingModel).find(
          (mail) =>
            mail.sourceSessionId === producerId &&
            mail.sourceExecutionId === created.id &&
            String(mail.content).startsWith(
              'Git worktree created (verified tool result; no additional authorization).\n',
            ),
        );
      check(reliableNotice, 'notification-original-create-success-source-reached-parent');
      const notice = object(
        JSON.parse(String(reliableNotice!.content).split('\n').slice(1).join('\n')),
      );
      check(
        notice.kind === 'git_worktree_created' &&
          notice.action === 'create' &&
          notice.key === createKey &&
          notice.path === target &&
          notice.head === before.head &&
          notice.branch === `refs/heads/${branch}` &&
          notice.cwdChanged === false &&
          notice.detached === false &&
          notice.baseCommit === object(object(created.result).details).baseCommit &&
          notice.observedAt === object(object(created.result).details).observedAt &&
          JSON.stringify(object(notice.source).operationRef) ===
            JSON.stringify(object(object(object(created.result).details).operation).ref) &&
          object(notice.source).sessionId === producerId &&
          object(notice.source).executionId === created.id,
        'notification-result-identity-and-path-preserved',
      );
      const writeModel = modelForTool(consumerWrites[0]!);
      check(
        writeModel?.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.toolCallId === consumerReads[0]!.callId &&
            message.sourceIds?.includes(consumerReads[0]!.id) &&
            message.content.includes('committed baseline'),
        ),
        'notification-write-uses-original-marker-readback-not-a-guess',
      );
      check(
        readFileSync(markerPath, 'utf8') === 'committed baseline\n' &&
          readFileSync(receiptPath, 'utf8') === 'committed baseline\n',
        'notification-real-committed-marker-copied-exactly',
      );
      check(
        finalDirectory.executions.some(
          (row) =>
            row.kind === 'tool' &&
            row.sessionId === consumerId &&
            row.definitionId === 'files.read' &&
            object(row.input).path === receiptPath &&
            row.status === 'succeeded',
        ),
        'notification-consumer-readback',
      );
      check(
        git(target, 'rev-parse', 'HEAD') === before.head &&
          git(target, 'symbolic-ref', 'HEAD') === `refs/heads/${branch}`,
        'notification-shared-tree-head-and-branch-preserved',
      );
      check(approvals.length === 0, 'notification-full-no-human-approvals');
      const parentContext = await store.getModelContext({ expectedStoreId, sessionId: 's' });
      const consumerResultSources = parentContext.resultSources.filter(
        (source) =>
          source.executionId === consumerCarrier.id &&
          source.resultRevision === consumerCarrier.resultRevision,
      );
      check(
        live.requests.some(
          (request) =>
            finalDirectory!.executions.some(
              (row) => row.id === request.requestId && row.sessionId === 's',
            ) &&
            request.messages.some(
              (message) =>
                message.content.startsWith('Child result source') &&
                message.sourceIds?.some((id) =>
                  consumerResultSources.some((source) => source.id === id),
                ),
            ),
        ),
        'notification-parent-consumes-original-consumer-completion',
      );
      const mails = [];
      for (const sessionId of finalDirectory.sessions) {
        let afterSeq: string | undefined;
        let upperSeq: string | undefined;
        for (;;) {
          const page = await store.listAgentMessages({
            expectedStoreId,
            sessionId,
            subjectId: 'owner',
            limit: 100,
            ...(afterSeq ? { afterSeq } : {}),
            ...(upperSeq ? { upperSeq } : {}),
          });
          mails.push(page);
          upperSeq ??= page.upperSeq;
          if (page.nextAfterSeq === null) break;
          afterSeq = page.nextAfterSeq;
        }
      }
      const successfulNoticeMail = mails
        .flatMap((page) => page.items)
        .filter(
          (mail) =>
            mail.kind === 'message' &&
            mail.sourceExecutionId === created.id &&
            mail.targetSessionId === 's',
        );
      check(
        successfulNoticeMail.length === 1 &&
          successfulNoticeMail[0]!.state === 'received' &&
          successfulNoticeMail[0]!.sourceSessionId === producerId &&
          successfulNoticeMail[0]!.id === reliableNotice!.messageId,
        'notification-exact-durable-original-mail-delivered-once',
      );
      save(join(evidence, 'notification-causality.json'), {
        producerId,
        consumerId,
        createTool: created.id,
        readyTool: ready!.id,
        producerSpawn: producerSpawn.id,
        consumerSpawn: consumerSpawn.id,
        parentForward: forwarded!.id,
        parentForwardDefinition: forwarded!.definitionId,
        forwardDelivery,
        consumerInitialCarrier: consumerInitialCarrier.id,
        consumerBusinessCarrier: consumerCarrier.id,
        spawnModel: spawnModel!.requestId,
        forwardingModel: forwardingModel!.requestId,
        consumerReadModel: readModel!.requestId,
        consumerWriteModel: writeModel!.requestId,
        reliableNotice,
        notice,
        consumerReadTools: consumerReads.map((row) => row.id),
        consumerWriteTools: consumerWrites.map((row) => row.id),
        mails,
        markerSha256: hash(readFileSync(markerPath)),
        receiptSha256: hash(readFileSync(receiptPath)),
        targetRetained: true,
      });
    } else {
      const readonly = selectedCase === 'child-readonly';
      const childAssignment = readonly
        ? `让唯一一名 explore 只读探索协作者使用实际工作树工具列出仓库登记，核对来源路径 ${JSON.stringify(canonicalSource)}，并解释在这个只读角色中创建或删除工作树需要什么角色与权限。不得创建或删除工作树，不尝试变更；不改文件、不联网。自然说明不能变更的边界，不把只读角色当作用户批准。`
        : defaultCase
          ? `让唯一一名默认可写协作者完成以下准确任务。task.spawn 必须省略 preset，使用当前默认 general，不指定其他角色。传给它的完整任务必须包含：来源 ${JSON.stringify(canonicalSource)}；先实际列出工作树；从默认 HEAD 创建一棵工作树，创建参数必须省略 path，由工具选择默认持久目录，新本地分支 ${JSON.stringify(branch)}，原创建 key ${JSON.stringify(createKey)}，显式权限 filesystem=full_access、network=none；等待真实 create 成功，读取其完整回执，取真实准确 path 正常删除同一目标，原删除 key ${JSON.stringify(removeKey)}，显式同样权限；保留新分支、标签与来源所有 staged/unstaged/untracked/ignored 内容和索引，不改变会话 cwd，不联网、不造报告文件、不再委派。Tool 如需审批由本测试的真实用户/操作员通过原审批卡回答，父子业务 Agent 均不能自行授权，不更换 key 或请求范围绕过。等待真实成功或明确失败再报告。`
          : `让唯一一名默认可写协作者完成以下准确任务。task.spawn 必须省略 preset，使用当前默认 general，不指定其他角色。传给它的完整任务必须包含：来源 ${JSON.stringify(canonicalSource)}；先实际列出工作树；从默认 HEAD 创建准确目标 ${JSON.stringify(target)}，新本地分支 ${JSON.stringify(branch)}，原创建 key ${JSON.stringify(createKey)}，显式权限 filesystem=full_access、network=none；成功后正常删除同一目标，原删除 key ${JSON.stringify(removeKey)}，显式同样权限；保留新分支、标签与来源所有 staged/unstaged/untracked/ignored 内容和索引，不改变会话 cwd，不使用 Shell、不联网、不造报告文件、不再委派。Tool 和内部 Job 如需审批，由本测试的真实用户/操作员通过原审批卡回答，父子业务 Agent 均不能自行授权，不更换 key 或请求范围绕过。等待真实成功或明确失败再报告。`;
      await turn(
        'child-work',
        `请${childAssignment}父 Agent 只负责委派、等待准确子任务的实际完成和汇总，不得代执行 git_worktree 调用，不要因仅受理就收尾。若子任务失败如实解释，不换角色、不重复创建子任务。`,
      );
      finalDirectory = await executionDirectory(store, expectedStoreId);
      const spawns = finalDirectory.executions.filter(
        (row) => row.sessionId === 's' && row.kind === 'tool' && row.definitionId === 'task.spawn',
      );
      check(
        spawns.length === 1 && spawns[0]!.status === 'succeeded',
        'exactly-one-real-child-delegation',
      );
      check(
        readonly
          ? object(spawns[0]!.input).preset === 'explore'
          : !('preset' in object(spawns[0]!.input)),
        'actual-requested-default-or-explore-role',
      );
      const childSessions = finalDirectory.sessions.filter((id) => id !== 's');
      check(childSessions.length === 1, 'exactly-one-direct-child-session');
      const childId = childSessions[0]!;
      check(
        (await store.getSession(childId))?.parentSessionId === 's',
        'actual-single-level-child',
      );
      check(
        !finalDirectory.executions.some(
          (row) => row.sessionId === 's' && row.definitionId === 'git.worktree',
        ),
        'parent-never-substitutes-worktree-operation',
      );
      const childTools = finalDirectory.executions.filter(
        (row) =>
          row.sessionId === childId && row.kind === 'tool' && row.definitionId === 'git.worktree',
      );
      if (readonly) {
        check(
          childTools.length >= 1 &&
            childTools.every(
              (row) =>
                object(row.input).action === 'list' &&
                row.status === 'succeeded' &&
                object(row.result).outcome === 'succeeded',
            ),
          'readonly-real-list-only',
        );
        check(
          !existsSync(target) &&
            git(source, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) === '',
          'readonly-zero-target-or-branch-mutation',
        );
        check(approvals.length === 0, 'readonly-no-mutation-approvals');
      } else {
        requireOne(
          childTools.filter((row) => object(row.input).action === 'list'),
          'list',
        );
        const created = requireOne(
          childTools.filter((row) => object(row.input).action === 'create'),
          'create',
          createKey,
        );
        const removed = requireOne(
          childTools.filter((row) => object(row.input).action === 'remove'),
          'remove',
          removeKey,
        );
        if (defaultCase) {
          const expectedTarget = resolveDefaultWorktreeTarget({
            defaultRoot: join(fixtureHome, '.kite-code', 'worktrees'),
            sourceCwd: canonicalSource,
            sessionId: childId,
            key: createKey,
          });
          const receipt = object(object(created.result).details);
          check(!('path' in object(created.input)), 'default-create-omits-path');
          check(
            target === expectedTarget && receipt.path === expectedTarget,
            'default-persistent-path-exact-source-session-key-resolver',
          );
          check(
            object(removed.input).path === receipt.path &&
              object(object(removed.result).details).path === receipt.path,
            'default-remove-uses-accurate-create-receipt-path',
          );
          check(
            live.requests.some(
              (request) =>
                finalDirectory!.executions.some(
                  (row) => row.id === request.requestId && row.sessionId === childId,
                ) &&
                request.tools.some((tool) => tool.id === 'git_worktree') &&
                request.tools.some((tool) => tool.id === 'shell_execute'),
            ),
            'default-real-child-has-worktree-and-ordinary-shell-tools',
          );
          const shellVerifications = await Promise.all(
            finalDirectory.executions
              .filter(
                (row) =>
                  row.kind === 'tool' &&
                  ['shell.execute', 'shell.launch'].includes(row.definitionId),
              )
              .map(async (tool) => ({
                toolExecutionId: tool.id,
                sessionId: tool.sessionId,
                ...(await classifyWorktreeLiveVerification(
                  String(object(tool.input).command),
                  canonicalSource,
                )),
              })),
          );
          save(join(evidence, 'readonly-shell-verifications.json'), shellVerifications);
          for (const verification of shellVerifications.filter((entry) => !entry.allowed))
            reviewRequirements.push({
              kind: 'shell_requires_semantic_review',
              toolExecutionId: verification.toolExecutionId,
              sessionId: verification.sessionId,
              evidenceFile: 'readonly-shell-verifications.json',
            });
          save(join(evidence, 'default-path-evidence.json'), {
            fixtureHome,
            defaultRoot: join(fixtureHome, '.kite-code', 'worktrees'),
            configurationPath,
            sourceCwd: canonicalSource,
            sessionId: childId,
            createKey,
            expectedTarget,
            createExecutionId: created.id,
            createInput: created.input,
            createReceipt: created.result,
            removeExecutionId: removed.id,
            removeInput: removed.input,
            removeReceipt: removed.result,
          });
        }
        check(!existsSync(target), 'child-normal-delete-completed');
        check(
          git(source, 'rev-parse', `refs/heads/${branch}`) === before.head,
          'child-new-branch-retained',
        );
        if (manualCase) check(approvals.length === 2, 'two-original-outer-tool-approvals');
        else check(approvals.length === 0, 'auto-no-human-approval-fallback');
        for (const action of ['create', 'remove']) {
          const rows = approvals.filter((entry) => entry.action === action);
          if (manualCase)
            check(
              rows.length === 1 &&
                object(rows[0]!.execution).kind === 'tool' &&
                rows[0]!.phase === action,
              `${action}-one-outer-user-approval-no-internal-card`,
            );
        }
        check(
          approvals.every(
            (entry) =>
              object(entry.card).sessionId === childId &&
              object(entry.card).presentationSessionId === 's' &&
              entry.businessAgentGranted === false,
          ),
          'original-child-approval-root-presentation-user-approver',
        );
      }
      if (manualCase || selectedCase === 'child-auto') {
        const mutationTools = childTools.filter((row) =>
          ['create', 'remove'].includes(String(object(row.input).action)),
        );
        const authorityEvidence = [];
        for (const owner of mutationTools) {
          const internalJobs = finalDirectory.executions.filter(
            (row) =>
              row.kind === 'job' &&
              row.definitionId === 'shell.command' &&
              row.parentExecutionId === owner.id,
          );
          check(
            internalJobs.length === 2,
            `${object(owner.input).action}-two-original-managed-worker-jobs`,
          );
          for (const job of internalJobs) {
            const policy = job.authorization?.policy;
            const evidenceCommand = policy ? await store.getCommand(policy.evidenceId) : null;
            authorityEvidence.push({
              ownerToolExecutionId: owner.id,
              jobExecutionId: job.id,
              policy,
              evidenceCommand,
              jobAuthorization: job.authorization,
              ownerAuthorization: owner.authorization,
            });
            save(join(evidence, 'internal-authorization-evidence.json'), authorityEvidence);
            check(
              policy?.reason === 'parent_review' &&
                policy.sourceExecutionId === owner.id &&
                evidenceCommand?.originStoreId === expectedStoreId &&
                evidenceCommand.sessionId === childId &&
                evidenceCommand.subjectId === 'owner' &&
                evidenceCommand.status === 'applied' &&
                job.interactionBinding === null,
              `${object(owner.input).action}-internal-job-derived-original-tool-evidence`,
            );
            if (selectedCase === 'child-auto')
              check(
                owner.authorization?.check?.decision === 'approve_once' &&
                  policy!.checkExecutionId === owner.authorization.check.executionId,
                `${object(owner.input).action}-internal-job-reuses-exact-original-generic-check`,
              );
            else
              check(
                owner.authorization?.human?.accepted === true &&
                  owner.authorization.human.grant === 'approve_once' &&
                  policy!.checkExecutionId === undefined,
                `${object(owner.input).action}-internal-job-reuses-exact-user-tool-approval`,
              );
          }
        }
        save(join(evidence, 'internal-authorization-evidence.json'), authorityEvidence);
        if (selectedCase === 'child-auto') {
          const modelsWithCommands = await Promise.all(
            finalDirectory.executions
              .filter((row) => row.kind === 'model')
              .map(async (row) => ({
                execution: row,
                command: await store!.getCommand(row.originCommandId),
              })),
          );
          const checksPerformed = modelsWithCommands.filter(
            (row) => row.command?.kind === 'authorization.check',
          );
          const expectedCheckIds = new Set(
            mutationTools.map((row) => row.authorization?.check?.executionId),
          );
          save(join(evidence, 'generic-authorization-checks.json'), checksPerformed);
          check(
            checksPerformed.length === 2 &&
              expectedCheckIds.size === 2 &&
              !expectedCheckIds.has(undefined) &&
              checksPerformed.every(
                (row) =>
                  expectedCheckIds.has(row.execution.id) &&
                  mutationTools.some((owner) => owner.id === row.execution.parentExecutionId) &&
                  row.execution.status === 'succeeded',
              ),
            'auto-exactly-two-original-generic-checks-not-six',
          );
          save(join(evidence, 'generic-authorization-checks.json'), checksPerformed);
        }
      }
      const carrier = finalDirectory.executions.find(
        (row) => row.kind === 'job' && row.childSessionId === childId,
      );
      check(carrier?.status === 'succeeded', 'original-child-carrier-completed');
      check(
        carrier!.definitionId === `agent/${readonly ? 'explore' : 'general'}`,
        'original-child-carrier-preserves-current-requested-role',
      );
      const parentContext = await store.getModelContext({ expectedStoreId, sessionId: 's' });
      const originalSources = parentContext.resultSources.filter(
        (source) =>
          source.executionId === carrier!.id && source.resultRevision === carrier!.resultRevision,
      );
      check(
        originalSources.length > 0 &&
          live.requests.some(
            (request) =>
              finalDirectory!.executions.some(
                (row) => row.id === request.requestId && row.sessionId === 's',
              ) &&
              request.messages.some(
                (message) =>
                  message.content.startsWith('Child result source') &&
                  message.sourceIds?.some((id) =>
                    originalSources.some((source) => source.id === id),
                  ),
              ),
          ),
        'original-child-result-source-consumed-by-parent',
      );
    }
    check(
      finalDirectory.executions.every(
        (row) =>
          row.kind !== 'job' ||
          (row.definitionId === 'shell.command' && row.cancelWithParent) ||
          (selectedCase !== 'primary' && row.definitionId.startsWith('agent/')),
      ),
      'existing-attached-shell-jobs-only',
    );
    const delivered = finalDirectory.executions
      .filter((row) => row.definitionId === 'git.worktree')
      .map((tool) => {
        const consumer = live!.requests.find(
          (request) =>
            finalDirectory!.executions.some(
              (row) =>
                row.id === request.requestId &&
                row.sessionId === tool.sessionId &&
                row.runId === tool.runId,
            ) &&
            request.messages.some(
              (message) =>
                message.role === 'tool' &&
                message.toolCallId === tool.callId &&
                message.sourceIds?.includes(tool.id) &&
                message.content.includes(String(object(tool.result).content)),
            ),
        );
        return {
          toolExecutionId: tool.id,
          resultRevision: tool.resultRevision,
          consumerModelExecutionId: consumer?.requestId ?? null,
          exactCompleteResultConsumed: !!consumer,
        };
      });
    save(join(evidence, 'result-consumption.json'), delivered);
    check(
      delivered.length > 0 && delivered.every((row) => row.exactCompleteResultConsumed),
      'complete-original-results-consumed-by-later-real-model',
    );
    const workspace = await runtime.getWorkspace('w');
    check(workspace?.rootUri === pathToFileURL(canonicalSource).href, 'workspace-cwd-unchanged');
    check(
      JSON.stringify(sourceSnapshot(source)) === JSON.stringify(before),
      'source-head-branch-local-content-index-status-preserved',
    );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'live-worktree-failed');
  } finally {
    if (store && runtime && expectedStoreId) {
      try {
        finalDirectory = await executionDirectory(store, expectedStoreId);
        save(join(evidence, 'executions.json'), finalDirectory);
        save(join(evidence, 'bindings.json'), bindings);
        if (live) {
          canonical = await saveLiveCanonicalModelEvidence({
            runtime,
            store,
            requests: live.requests,
            root: evidence,
            subjectId: 'owner',
            verifyRequests: true,
          });
          save(join(evidence, 'canonical-summary.json'), canonical);
          checks.canonicalOriginalsComplete =
            object(canonical).complete === true &&
            object(object(canonical).requestIdentity).matches === true;
        }
        const outputs: Awaited<ReturnType<typeof completeJobOutput>>[] = [];
        for (const job of finalDirectory.executions.filter((row) => row.kind === 'job')) {
          try {
            outputs.push(
              await completeJobOutput(
                store,
                job.id,
                isWorktreeShellJob(job, finalDirectory.executions)
                  ? 'worktree'
                  : job.definitionId === 'shell.command'
                    ? 'shell'
                    : 'agent',
              ),
            );
          } catch (error) {
            failures.push(
              `job-output:${job.id}:${error instanceof Error ? error.message : 'unknown'}`,
            );
            const page = await store.listExecutionOutput({
              executionId: job.id,
              afterSeq: '0',
              limit: 200,
            });
            save(join(evidence, `incomplete-job-output-${job.id}.json`), {
              job,
              page,
              complete: false,
            });
          }
        }
        save(join(evidence, 'job-output.json'), outputs);
        const ordinaryShellRecords: ExtensionRecord[] = [];
        for (const sessionId of finalDirectory.sessions) {
          let afterKey: string | undefined;
          for (;;) {
            const page = await store.listExtensionRecords({
              extensionId: 'builtin.shell',
              sessionId,
              contentType: 'application/vnd.kite.shell-reference+json',
              limit: 200,
              ...(afterKey ? { afterKey } : {}),
            });
            ordinaryShellRecords.push(...page);
            if (page.length < 200) break;
            afterKey = page.at(-1)!.key;
          }
        }
        save(join(evidence, 'ordinary-shell-records.json'), ordinaryShellRecords);
        const ordinaryShellEvidence = await Promise.all(
          finalDirectory.executions
            .filter(
              (job) =>
                job.kind === 'job' &&
                job.definitionId === 'shell.command' &&
                !isWorktreeShellJob(job, finalDirectory!.executions),
            )
            .map(async (job) => {
              const parent = finalDirectory!.executions.find(
                (row) => row.id === job.parentExecutionId,
              );
              const output = outputs.find((row) => row.executionId === job.id);
              const details = object(object(job.result).details);
              const owned = object(details.ownedProcesses);
              const root = object(owned.root);
              const broker = object(owned.broker);
              const coalition = object(owned.coalition);
              const verification = await classifyWorktreeLiveVerification(
                String(object(job.input).command),
                canonicalSource,
              );
              return {
                jobExecutionId: job.id,
                parentExecutionId: parent?.id,
                sessionId: job.sessionId,
                verification,
                reference: worktreeLiveShellReferenceEvidence(
                  job,
                  parent,
                  ordinaryShellRecords,
                  await store!.getCommand(job.originCommandId),
                ),
                completeOutput: output?.complete === true,
                exactParent:
                  parent?.kind === 'tool' &&
                  parent.definitionVersion === '1' &&
                  ['shell.execute', 'shell.launch'].includes(parent.definitionId) &&
                  parent.sessionId === job.sessionId &&
                  parent.originStoreId === job.originStoreId &&
                  parent.rootWorkCommandId === job.rootWorkCommandId &&
                  parent.rootWorkSeq === job.rootWorkSeq &&
                  object(parent.input).command === object(job.input).command,
                stopped:
                  job.status === 'succeeded' &&
                  job.cancelWithParent === true &&
                  object(job.result).outcome === 'succeeded' &&
                  details.processTreeStopped === true &&
                  details.groupStopped === true &&
                  object(owned.binding).executionId === job.id &&
                  object(owned.binding).sessionId === job.sessionId &&
                  root.reaped === true &&
                  object(root.waitpid).statusMatched === true &&
                  broker.kernelState === 'absent' &&
                  object(broker.exit).reaped === true &&
                  object(owned.guardian).kernelState === 'absent' &&
                  coalition.processTreeStopped === true &&
                  coalition.registrationRemoved === true,
              };
            }),
        );
        save(join(evidence, 'ordinary-shell-evidence.json'), ordinaryShellEvidence);
        checks.fullOrdinaryShellOutputParentAndStop = ordinaryShellEvidence.every(
          (entry) =>
            defaultCase &&
            entry.completeOutput &&
            entry.exactParent &&
            entry.reference.exactOriginalCommand &&
            entry.reference.uniqueOriginalRecordAndReceipt &&
            entry.stopped,
        );
        const ordinaryReferencedIds = ordinaryShellRecords.map(
          (record) => object(object(record.value).ref).executionId,
        );
        checks.exactOriginalOrdinaryShellReferenceJobs =
          ordinaryReferencedIds.length === new Set(ordinaryReferencedIds).size &&
          JSON.stringify([...ordinaryReferencedIds].sort()) ===
            JSON.stringify(ordinaryShellEvidence.map((entry) => entry.jobExecutionId).sort());
        const records = [];
        for (const sessionId of finalDirectory.sessions) {
          let afterKey: string | undefined;
          for (;;) {
            const page = await store.listExtensionRecords({
              extensionId: 'builtin.shell',
              sessionId,
              contentType: 'application/vnd.kite.git-worktree-operation+json',
              limit: 200,
              ...(afterKey ? { afterKey } : {}),
            });
            records.push(...page);
            if (page.length < 200) break;
            afterKey = page.at(-1)!.key;
          }
        }
        save(join(evidence, 'operation-records.json'), records);
        const originalWorktreeEvidence = [];
        for (const sessionId of finalDirectory.sessions)
          originalWorktreeEvidence.push({
            sessionId,
            evidence: await verifyWorktreeExecutionEvidence(
              store,
              sessionId,
              undefined,
              finalDirectory.executions.filter((row) => row.sessionId === sessionId),
            ),
          });
        save(join(evidence, 'original-worktree-evidence.json'), originalWorktreeEvidence);
        checks.originalWorktreeRecordCommandRefAndFullOutput = true;
        if (defaultCase) {
          const creates = records.filter((record) => record.key === `git-worktree/${createKey}`);
          const removes = records.filter((record) => record.key === `git-worktree/${removeKey}`);
          const created = object(creates[0]?.value);
          const removed = object(removes[0]?.value);
          checks.defaultOriginalFrozenTargetAndPlan =
            creates.length === 1 &&
            removes.length === 1 &&
            !('path' in object(created.request)) &&
            object(created.resolvedTarget).defaultRoot ===
              join(fixtureHome, '.kite-code', 'worktrees') &&
            object(created.resolvedTarget).path === target &&
            object(created.plan).targetPath === target &&
            object(removed.request).path === target &&
            object(removed.plan).targetPath === target;
        }
        for (const sessionId of finalDirectory.sessions) {
          const pages = [];
          for await (const page of readLiveSessionLogPages(store, {
            expectedStoreId,
            sessionId,
            subjectId: 'owner',
          }))
            pages.push(page);
          save(join(evidence, `session-logs-${sessionId}.json`), pages);
        }
        const phaseEvidence = records.map((record) => {
          const value = object(record.value),
            steps = object(value.steps);
          return {
            key: record.key,
            phase: value.phase,
            ownerExecutionId: value.ownerExecutionId,
            originStoreId: record.originStoreId,
            steps: Object.entries(steps).map(([name, stepValue]) => {
              const step = object(stepValue),
                ref = object(step.ref),
                job = finalDirectory!.executions.find((row) => row.id === ref.executionId),
                output = outputs.find((row) => row.executionId === ref.executionId);
              return {
                name,
                phase: object(step.request).phase,
                jobId: ref.executionId,
                originalParent: job?.parentExecutionId,
                ownerMatches: job?.parentExecutionId === value.ownerExecutionId,
                jobStatus: job?.status,
                completeOutput: output?.complete === true,
                businessOutcome: object(output?.frame).businessOutcome,
              };
            }),
          };
        });
        save(join(evidence, 'phase-evidence.json'), phaseEvidence);
        const savedJobIds = phaseEvidence.flatMap((record) =>
          record.steps.map((step) => step.jobId),
        );
        const actualJobIds = finalDirectory.executions
          .filter((row) => isWorktreeShellJob(row, finalDirectory!.executions))
          .map((row) => row.id);
        const observedPhases = phaseEvidence
          .flatMap((record) => record.steps.map((step) => step.phase))
          .sort();
        checks.exactOriginalJobsNoDuplicateMutation =
          savedJobIds.length === new Set(savedJobIds).size &&
          JSON.stringify([...savedJobIds].sort()) === JSON.stringify(actualJobIds.sort()) &&
          (selectedCase === 'child-readonly'
            ? observedPhases.length > 0 && observedPhases.every((phase) => phase === 'list')
            : (selectedCase === 'child-notification' ||
                observedPhases.filter((phase) => phase === 'list').length >= 1) &&
              JSON.stringify(observedPhases.filter((phase) => phase !== 'list')) ===
                JSON.stringify(
                  (selectedCase === 'child-notification'
                    ? ['prepare_create', 'create']
                    : ['prepare_create', 'create', 'prepare_remove', 'remove']
                  ).sort(),
                ));

        checks.fullPrepareMutationShellEvidence =
          phaseEvidence.every(
            (record) =>
              record.originStoreId === expectedStoreId &&
              record.steps.every(
                (step) =>
                  step.ownerMatches && step.jobStatus === 'succeeded' && step.completeOutput,
              ),
          ) &&
          (selectedCase === 'child-readonly' ||
            (phaseEvidence.some(
              (record) =>
                record.key === `git-worktree/${createKey}` &&
                record.steps.some((step) => step.phase === 'prepare_create') &&
                record.steps.some((step) => step.phase === 'create'),
            ) &&
              (selectedCase === 'child-notification' ||
                phaseEvidence.some(
                  (record) =>
                    record.key === `git-worktree/${removeKey}` &&
                    record.steps.some((step) => step.phase === 'prepare_remove') &&
                    record.steps.some((step) => step.phase === 'remove'),
                ))));
      } catch (error) {
        failures.push(`evidence:${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    if (live)
      save(join(evidence, 'models.json'), {
        requests: live.requests,
        events,
        wire: live.wire,
        wireRequests: live.wireRequests,
        usage: live.usage,
        attemptFailures: live.attemptFailures,
        metadata: live.metadata,
      });
    try {
      client?.disposeNetwork();
      if (service) {
        await service.close();
        service = undefined;
        runtime = undefined;
        store = undefined;
      } else if (runtime) {
        await runtime.close();
        runtime = undefined;
        store = undefined;
      } else if (store) {
        await store.close();
        store = undefined;
      }
      if (!locksOwnedByService && runtime === undefined && store === undefined)
        await locks?.close();
    } catch (error) {
      failures.push(`close:${error instanceof Error ? error.message : 'unknown'}`);
    }
    if (store === undefined && runtime === undefined && expectedStoreId) {
      try {
        const cold = await openSqliteStore(profile);
        try {
          const requestCount = live?.requests.length ?? 0;
          const coldRows = await executionDirectory(cold, expectedStoreId);
          save(join(evidence, 'cold-executions.json'), coldRows);
          checks.coldReadNoNewModel = (live?.requests.length ?? 0) === requestCount;
          const safety = await cold.readExecutionGroupSafety({
            expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
          });
          save(join(evidence, 'cold-safety.json'), safety);
          checks.executionGroupQuiescent = safety.quiescent;
          checks.sessionOwnersReleased = (
            await Promise.all(coldRows.sessions.map((id) => cold.getSession(id)))
          ).every((session) => session?.ownerInstanceId === null);
        } finally {
          await cold.close();
        }
      } catch (error) {
        failures.push(`cold-read:${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    try {
      const after = sourceSnapshot(source);
      save(join(evidence, 'source-before-after.json'), { before, after });
      checks.sourcePreserved = JSON.stringify(before) === JSON.stringify(after);
    } catch (error) {
      checks.sourcePreserved = false;
      failures.push(`source-inspection:${error instanceof Error ? error.message : 'unknown'}`);
    }
    const codeAfter = liveCodeEvidence();
    checks.codeUnchanged = codeBefore.workingTreeSha256 === codeAfter.workingTreeSha256;
    Object.assign(report, {
      finishedAt: new Date().toISOString(),
      codeAfter,
      failures,
      model: live?.metadata ?? null,
      requests: live?.requests.length ?? 0,
      physicalRequests: live?.wire.length ?? 0,
      wireStatuses: live?.wire.map((entry) => entry.status) ?? [],
      canonical,
      evidenceRetained: true,
      replacementRetained: replacement ? existsSync(target) : null,
      semanticReview: {
        finalReports: 'pending independent original canonical review',
        replayedHistoricalVsCurrentEntity: 'pending independent original canonical review',
        modelUnderstanding:
          'receipt delivery and mechanical checks do not establish semantic understanding',
      },
    });
    checks.startupHomeRemainsIsolated =
      homedir() === fixtureHome &&
      process.env.HOME === fixtureHome &&
      process.env.USERPROFILE === fixtureHome;
    if (defaultCase) checks.defaultStartupHomeRemainsIsolated = checks.startupHomeRemainsIsolated;
    report.status = finalizeWorktreeLiveAcceptance({
      checks,
      failures,
      reviewRequirements,
      signal,
    });
    persist();
  }
  return report;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const outputArgs = args.filter((value) => value.startsWith('--output=')),
    caseArgs = args.filter((value) => value.startsWith('--case=')),
    providerArgs = args.filter((value) => value.startsWith('--provider-configuration=')),
    preflightArgs = args.filter((value) => value === '--launch-preflight');
  const selectedCase = (caseArgs[0]?.slice('--case='.length) ?? 'primary') as Case;
  const launchPreflightOnly = preflightArgs.length === 1;
  assert(
    outputArgs.length === 1 &&
      caseArgs.length <= 1 &&
      providerArgs.length <= 1 &&
      preflightArgs.length <= 1 &&
      args.length ===
        outputArgs.length + caseArgs.length + providerArgs.length + preflightArgs.length &&
      [
        'primary',
        'child-approval',
        'child-readonly',
        'child-auto',
        'child-notification',
        'child-default',
      ].includes(selectedCase),
    'live-worktree-arguments',
  );
  const output = outputArgs[0]!.slice('--output='.length);
  const providerConfigurationPath = providerArgs[0]?.slice('--provider-configuration='.length);
  if (providerConfigurationPath === undefined) {
    // No credentials are copied. The child resolves the same original user
    // document through the normal fixture after its isolated HOME is selected.
    const outputRoot = newLiveOutputRoot(output);
    const startupHome = `${outputRoot}.home`;
    newLiveOutputRoot(startupHome);
    const originalConfigurationPath = resolve(createUserConfiguration().path);
    const child = Bun.spawn(
      [
        process.execPath,
        import.meta.path,
        ...args,
        `--provider-configuration=${originalConfigurationPath}`,
      ],
      {
        env: { ...process.env, HOME: startupHome, USERPROFILE: startupHome },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    const forwardInterrupt = () => {
      if (child.exitCode === null) child.kill('SIGINT');
    };
    const forwardTerminate = () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    };
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTerminate);
    try {
      process.exitCode = await child.exited;
    } finally {
      process.removeListener('SIGINT', forwardInterrupt);
      process.removeListener('SIGTERM', forwardTerminate);
    }
  } else {
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort(new Error('live-worktree-operator-interrupted'));
    // Terminal delivery and parent forwarding may both arrive. Keep cancellation
    // idempotent while the original Runtime performs its supervised shutdown.
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      const report = await runGitWorktreeLive(
        output,
        cancellation.signal,
        selectedCase,
        providerConfigurationPath,
        launchPreflightOnly,
      );
      console.log(
        JSON.stringify({
          status: report.status,
          result: join(output, launchPreflightOnly ? 'launch-preflight.json' : 'result.json'),
        }),
      );
      if (report.status !== (launchPreflightOnly ? 'launch_preflight_passed' : 'assertions_passed'))
        process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}
