import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as fixtureDelay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../../../apps/service/src';
import { createSummaryCompressor } from '../../../../apps/service/src/compression-configuration';
import { createDefaultProcessConfiguration } from '../../../../apps/service/src/configuration';
import { initializeLivePermissionFixture } from '../../../../apps/service/test/fixtures/live-permission-fixture';
import { runtimeBuildOptions } from '../../../../packages/agent/scripts/runtime-build-options';
import { build as buildFixture } from '../../../../scripts/tooling/build';
import { which as findFixtureExecutable } from '../../../../scripts/tooling/process';
import { privateDirectory } from '../../../fixtures/test-filesystem';
import { readLiveExecutionDirectory, readLiveSessionLogPages } from './approval-execution-fixture';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';
import { liveCodeEvidence } from './live-code-evidence';
import { createLiveModelFixture } from './live-model-fixture';

if (process.env.KITE_RUN_LIVE_LOOP_CONTINUITY !== '1')
  throw Error('live_loop_continuity_opt_in_required');
const output = resolve(process.argv[2] ?? join('dist/acceptance', `loop-continuity-${Date.now()}`));
if (!output.startsWith(resolve('dist/acceptance') + sep))
  throw Error('live_output_outside_acceptance');
if (existsSync(output)) throw Error('live_output_must_be_new');
mkdirSync(output, { recursive: true, mode: 0o700 });
const codeBefore = liveCodeEvidence();
const workspace = join(output, 'project'),
  evidence = join(output, 'evidence'),
  control = join(output, 'control');
for (const path of [
  workspace,
  evidence,
  control,
  join(workspace, 'src'),
  join(workspace, 'tests'),
  join(workspace, 'scratch'),
])
  mkdirSync(path, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFileSync(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const nonce = randomUUID();
type Contract = {
  name: string;
  body: string;
  cases: { args: unknown[]; expected?: unknown; raises?: string }[];
};
const contracts: Contract[] = [
  {
    name: 'normalize_name',
    body: 'def normalize_name(value):\n    return value.upper()\n',
    cases: [
      { args: ['  Alice  '], expected: 'alice' },
      { args: [' BOB'], expected: 'bob' },
      { args: [''], expected: '' },
    ],
  },
  {
    name: 'clamp',
    body: 'def clamp(value, low, high):\n    return min(low, max(high, value))\n',
    cases: [
      { args: [5, 0, 10], expected: 5 },
      { args: [-2, 0, 10], expected: 0 },
      { args: [20, 0, 10], expected: 10 },
    ],
  },
  {
    name: 'is_leap',
    body: 'def is_leap(year):\n    return year % 4 == 0\n',
    cases: [
      { args: [2000], expected: true },
      { args: [1900], expected: false },
      { args: [2024], expected: true },
      { args: [2023], expected: false },
    ],
  },
  {
    name: 'median',
    body: 'def median(values):\n    values = sorted(values)\n    return values[len(values) // 2]\n',
    cases: [
      { args: [[3, 1, 2]], expected: 2 },
      { args: [[4, 1, 3, 2]], expected: 2.5 },
      { args: [[]], raises: 'ValueError' },
    ],
  },
  {
    name: 'unique_ordered',
    body: 'def unique_ordered(values):\n    return sorted(set(values))\n',
    cases: [
      { args: [[3, 1, 3, 2, 1]], expected: [3, 1, 2] },
      { args: [['b', 'a', 'b']], expected: ['b', 'a'] },
      { args: [[]], expected: [] },
    ],
  },
  {
    name: 'safe_divide',
    body: 'def safe_divide(left, right):\n    return left // right\n',
    cases: [
      { args: [5, 2], expected: 2.5 },
      { args: [7, 0], expected: null },
      { args: [-3, 2], expected: -1.5 },
    ],
  },
  {
    name: 'slugify',
    body: 'def slugify(value):\n    return value.lower().replace(" ", "-")\n',
    cases: [
      { args: [' Hello,  World! '], expected: 'hello-world' },
      { args: ['A___B'], expected: 'a-b' },
      { args: ['---'], expected: '' },
    ],
  },
  {
    name: 'total_cents',
    body: 'def total_cents(value):\n    return int(float(value) * 100)\n',
    cases: [
      { args: ['10.005'], expected: 1001 },
      { args: ['1.999'], expected: 200 },
      { args: ['0.29'], expected: 29 },
    ],
  },
];
const loader = [
  'import importlib.util, json, os, pathlib, sys, time',
  'sys.dont_write_bytecode = True',
  'def load(root, name):',
  '    spec = importlib.util.spec_from_file_location(name, pathlib.Path(root) / "src" / (name + ".py"))',
  '    module = importlib.util.module_from_spec(spec)',
  '    spec.loader.exec_module(module)',
  '    return getattr(module, name)',
].join('\n');
for (const contract of contracts) {
  writeFileSync(join(workspace, 'src', `${contract.name}.py`), contract.body);
  writeFileSync(
    join(workspace, 'tests', `test_${contract.name}.py`),
    `${[
      loader,
      'import unittest',
      'class ContractTest(unittest.TestCase):',
      '    def test_contract(self):',
      '        root = pathlib.Path(__file__).resolve().parents[1]',
      `        name = ${JSON.stringify(contract.name)}`,
      '        fn = load(root, name)',
      `        cases = json.loads(${JSON.stringify(JSON.stringify(contract.cases))})`,
      '        for case in cases:',
      '            with self.subTest(case=case):',
      '                if "raises" in case:',
      '                    with self.assertRaises(getattr(__import__("builtins"), case["raises"])):',
      '                        fn(*case["args"])',
      '                else:',
      '                    self.assertEqual(fn(*case["args"]), case["expected"])',
      '        with (root / ".test-runs.jsonl").open("a") as log:',
      '            log.write(json.dumps({"name": name, "checks": len(cases), "nonce": os.environ.get("KITE_CONTINUITY_NONCE"), "at": time.time()}) + "\\n")',
      'if __name__ == "__main__":',
      '    unittest.main()',
    ].join('\n')}\n`,
  );
}
writeFileSync(
  join(workspace, 'README.md'),
  `${[
    '# Small Python contract repairs',
    '',
    'There are eight independent modules under src. Each exports the function matching its filename.',
    'The tests under tests are the exact acceptance contract. Repair source functions; do not change tests.',
    'normalize_name strips surrounding whitespace and lowercases; clamp respects inclusive bounds;',
    'is_leap follows Gregorian century rules; median averages an even pair and rejects empty input;',
    'unique_ordered retains first-occurrence order; safe_divide uses ordinary division and returns None for zero;',
    'slugify lowercases ASCII letters/digits and replaces runs of other characters with one trimmed dash;',
    'total_cents uses exact decimal half-up rounding to the nearest cent.',
    'Use Python standard-library unittest. Each test file can run independently; unittest discovery runs all.',
    'Passing tests append .test-runs.jsonl automatically. Do not edit that test log manually.',
  ].join('\n')}\n`,
);
writeFileSync(join(workspace, 'scratch', 'user-notes.txt'), 'Existing user notes.\n');
execFileSync('git', ['init', '-q'], { cwd: workspace });
execFileSync('git', ['add', 'src', 'tests', 'README.md', 'scratch/user-notes.txt'], {
  cwd: workspace,
});
execFileSync(
  'git',
  [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgSign=false',
    '-c',
    'user.name=Continuity Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Synthetic baseline',
  ],
  { cwd: workspace },
);
const dirtyText = `Existing user notes.\nUncommitted user edit: ${nonce}\n`;
writeFileSync(join(workspace, 'scratch', 'user-notes.txt'), dirtyText);
const baselineHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: workspace,
  encoding: 'utf8',
}).trim();
function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile())
        files[relative(workspace, absolute)] = readFileSync(absolute).toString('base64');
    }
  }
  walk(workspace);
  return files;
}
const beforeFiles = snapshot();
const oracle = [
  loader,
  'root, contracts = sys.argv[1], json.loads(sys.argv[2])',
  'results = []',
  'for contract in contracts:',
  '    try:',
  '        fn = load(root, contract["name"])',
  '        for case in contract["cases"]:',
  '            if "raises" in case:',
  '                try: fn(*case["args"])',
  '                except Exception as error: assert type(error).__name__ == case["raises"]',
  '                else: raise AssertionError("expected exception")',
  '            else: assert fn(*case["args"]) == case["expected"]',
  '        results.append({"name": contract["name"], "passed": True, "checks": len(contract["cases"])})',
  '    except Exception as error:',
  '        results.append({"name": contract["name"], "passed": False, "cause": type(error).__name__})',
  'print(json.dumps(results))',
].join('\n');
function independentlyVerify() {
  return JSON.parse(
    execFileSync(
      '/usr/bin/python3',
      [
        '-I',
        '-c',
        oracle,
        workspace,
        JSON.stringify(contracts.map(({ name, cases }) => ({ name, cases }))),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    ),
  ) as { name: string; passed: boolean; checks?: number; cause?: string }[];
}
const baselineVerification = independentlyVerify();
assert.equal(baselineVerification.filter((row) => row.passed).length, 0);
save('baseline.json', {
  files: beforeFiles,
  gitStatus: execFileSync('git', ['status', '--porcelain=v1'], {
    cwd: workspace,
    encoding: 'utf8',
  }),
  verification: baselineVerification,
});
const task =
  'TASK-' +
  nonce +
  '\n请独立修复这个Python小项目中src下的8个函数，准确需求和测试在README及tests。按模块逐项排查；一次只修复一个函数，运行其单项真实测试并确认结果，然后再开始下一函数，不要先批量修改多个函数再验证，最后运行一次完整回归；只修改这8个源码文件，保留已有用户未提交改动，不修改测试、README或手动伪造测试日志，不提交Git，不创建报告。不要委派、联网或读取合成工作区外的路径及凭据。工具和命令自行选择。最后用中文列出你实际修改过的源码路径、实际验证结果及任何未完成项，不能把初始dirty归因给自己。';
const correction =
  'CORRECTION-' +
  nonce +
  '\n补充纠正：scratch/user-notes.txt是我在你开始前已修改的文件，保持其完整原文；最终“你的源码改动”只列这次确实改过的src路径，不把该用户文件或自动测试日志算作你的源码改动。其余8项修复及完整回归目标不变。';
const timeline: Record<string, unknown>[] = [],
  events: { requestId: string; event: ModelEvent }[] = [];
const requestFacts: Record<string, unknown>[] = [],
  compressionTriggers: Record<string, unknown>[] = [];
const checks: Record<string, boolean> = {},
  evidenceErrors: string[] = [],
  cleanupErrors: string[] = [];
const requireCheck = (condition: unknown, point: string) => {
  checks[point] = !!condition;
  if (!condition) throw Error(point);
};
let live: Awaited<ReturnType<typeof createLiveModelFixture>> | undefined;
let runtime: ReturnType<typeof createRuntime> | undefined;
let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
let service: Awaited<ReturnType<typeof startService>> | undefined;
let client: ReturnType<typeof createClient> | undefined;
let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
let expectedStoreId = '',
  ordinaryFinished = 0,
  summariesFinished = 0,
  lastTrigger = 0;
const compressedVerifiedModules = new Set<string>();
let lastCompressedSources = { ...beforeFiles };
let firstOrdinary = false,
  releaseFirst!: () => void,
  correctionAccepted = false;
const firstGate = new Promise<void>((resolveGate) => {
  releaseFirst = resolveGate;
});
const isSummary = (request: ModelRequest) =>
  request.tools.length === 0 &&
  request.messages.some((message) =>
    message.content.startsWith('Summarize the preceding recorded conversation'),
  );
let status = 'failed',
  failure: string | null = null,
  result: Record<string, unknown> = {};
function safeError(error: unknown) {
  const candidate =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : 'unknown_failure';
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(candidate) ? candidate : 'unclassified_failure';
}
try {
  live = await createLiveModelFixture({
    model: 'gpt-6-luna',
    reasoningEffort: 'low',
    requestLimit: 80,
    timeoutMs: 600_000,
    captureWireRequests: true,
    preserveSdkAttemptErrors: true,
  });
  const model: ModelAdapter = {
    describeRequest: live.model.describeRequest?.bind(live.model),
    async *stream(request, context) {
      if (live!.requests.length >= 80)
        timeline.push({
          at: Date.now(),
          phase: 'fixture_request_budget_reject',
          requestId: request.requestId,
        });
      const summary = isSummary(request),
        ordinary = request.tools.length > 0;
      if (ordinary && !firstOrdinary) {
        firstOrdinary = true;
        await new Promise<void>((resolveGate, reject) => {
          const aborted = () => reject(context.signal.reason);
          context.signal.addEventListener('abort', aborted, { once: true });
          firstGate.then(() => {
            context.signal.removeEventListener('abort', aborted);
            resolveGate();
          }, reject);
          if (context.signal.aborted) aborted();
        });
      }
      if (summary) {
        const trigger = compressionTriggers.at(-1);
        if (trigger && !trigger.summaryExecutionId) trigger.summaryExecutionId = request.requestId;
      }
      const current =
        ordinary && store
          ? await store.getModelContext({
              expectedStoreId,
              sessionId: 's',
              messageLimit: 1,
              sourceLimit: 1,
            })
          : null;
      requestFacts.push({
        requestId: request.requestId,
        at: Date.now(),
        kind: summary ? 'summary' : ordinary ? 'ordinary' : 'internal',
        compression: current?.compression ?? null,
        originalUserCount: request.messages.filter(
          (message) =>
            message.role === 'user' &&
            message.sourceIds?.includes('work') &&
            message.content === task,
        ).length,
        correctionCount: request.messages.filter(
          (message) =>
            message.role === 'user' &&
            message.sourceIds?.includes('correction') &&
            message.content === correction,
        ).length,
        toolCallIds: request.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.toolCallId),
      });
      for await (const event of live!.model.stream(request, context)) {
        events.push({ requestId: request.requestId, event: structuredClone(event) });
        if (event.type === 'finish') {
          if (summary) summariesFinished++;
          if (ordinary) ordinaryFinished++;
        }
        yield event;
      }
    },
  };
  const compressor = createSummaryCompressor({
    async shouldCompress(input) {
      if (
        summariesFinished >= 3 ||
        ordinaryFinished <= lastTrigger ||
        !input.messages.some((message) => message.role === 'tool' || message.role === 'assistant')
      )
        return false;
      // Trigger only after new business progress, never after inspection-only turns.
      const observed = snapshot();
      if (
        contracts.some(
          ({ name }) => observed[`tests/test_${name}.py`] !== beforeFiles[`tests/test_${name}.py`],
        )
      )
        return false;
      const logPath = join(workspace, '.test-runs.jsonl');
      const records = existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { name: string; nonce: string })
        : [];
      const verified = independentlyVerify();
      const newVerifiedModules = contracts
        .filter(
          ({ name }) =>
            !compressedVerifiedModules.has(name) &&
            records.some((row) => row.nonce === nonce && row.name === name) &&
            observed[`src/${name}.py`] !== lastCompressedSources[`src/${name}.py`] &&
            verified.some((row) => row.name === name && row.passed),
        )
        .map(({ name }) => name);
      if (!newVerifiedModules.length) return false;
      const changedPaths = contracts
        .map(({ name }) => `src/${name}.py`)
        .filter((path) => observed[path] !== lastCompressedSources[path]);
      const completedExecutions = (
        await readLiveExecutionDirectory(store!, {
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
        })
      ).executions
        .filter(
          (execution) =>
            ['tool', 'job'].includes(execution.kind) && execution.status === 'succeeded',
        )
        .map((execution) => ({
          executionId: execution.id,
          kind: execution.kind,
          parentExecutionId: execution.parentExecutionId,
        }));
      lastTrigger = ordinaryFinished;
      compressionTriggers.push({
        at: Date.now(),
        ordinaryFinished,
        summariesFinished,
        runId: input.run.id,
        trigger: input.trigger,
        messageCount: input.messages.length,
        newVerifiedModules,
        changedPaths,
        sourceDigests: Object.fromEntries(
          changedPaths.map((path) => [
            path,
            createHash('sha256').update(Buffer.from(observed[path]!, 'base64')).digest('hex'),
          ]),
        ),
        completedExecutions,
      });
      for (const name of newVerifiedModules) compressedVerifiedModules.add(name);
      lastCompressedSources = observed;
      return true;
    },
  });
  const profile = selectProfile({ dataRoot: join(output, 'state'), profile: 'live' });
  privateDirectory(profile.profilePath);
  const configurationPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    configurationPath,
    JSON.stringify({
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
        'execution_evidence.read',
        'files.read',
        'files.write',
        'files.edit',
        'shell.execute',
        'shell.launch',
        'shell.read',
        'shell.wait',
        'shell.stop',
      ].map((id) => ({ id })),
    }),
    { mode: 0o600 },
  );
  const rg = findFixtureExecutable('rg');
  assert.ok(rg, 'rg_asset_required');
  const built = await buildFixture({
    entrypoints: [
      join(
        import.meta.dirname,
        '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
      ),
    ],
    ...runtimeBuildOptions(
      join(output, 'assets'),
      resolve(import.meta.dirname, '../../../../packages/agent/dist'),
    ),
    outdir: join(output, 'assets'),
    naming: 'shell-supervisor.js',
  });
  assert.ok(built.success, 'supervisor_build_failed');
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: configurationPath,
    localCodex: false,
    credentialBackend: createTemporaryCredentialBackend(),
    compressor,
    authorizationCheck: { id: 'live-continuity-check', version: '1', modelId: live.modelId, model },
    shell: {
      platform: 'darwin',
      configurationId: 'owned-live-loop-continuity',
      env: {
        PATH: `${dirname(rg)}:${dirname(process.execPath)}:/usr/bin:/bin`,
        PYTHONDONTWRITEBYTECODE: '1',
        KITE_CONTINUITY_NONCE: nonce,
      },
      supervisorPath: built.outputs[0]!.path,
      runtimeExecutable: process.execPath,
      shellExecutable: '/bin/sh',
      host: {
        controlBase: control,
        protectedRoots: [profile.dataRoot, control, evidence],
        readonlyAssets: [join(output, 'assets')],
        runtimeReadOnlyRoots: [dirname(process.execPath), dirname(rg)],
      },
    },
  });
  store = await openSqliteStore(profile);
  locks = createWorkspaceSerialLocks(profile);
  host.bindWorkspaceSerialLocks?.(locks);
  const instrument = (binding: RunConfiguration): RunConfiguration => ({
    ...binding,
    model,
    compressor,
  });
  runtime = createRuntime({
    ...host,
    store,
    artifacts: createArtifactStore({ profile, store }),
    workspaceSerialLocks: locks,
    permissions: host.permissions!,
    async resolveRunConfiguration(input) {
      return instrument(await host.resolveRunConfiguration!(input));
    },
  });
  const controls = host.permissionManagement!(runtime);
  expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'Isolated continuity project',
    rootUri: pathToFileURL(workspace).href,
  });
  service = await startService({
    runtime,
    permissionManagement: controls,
    subjectId: 'owner',
    buildId: 'owned-live-loop-continuity',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    beforeResourceClose: () => locks!.close(),
  });
  client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'inputs', 'interactions', 'sessions'],
    },
  });
  await client.connect();
  await client.createSession({
    expectedStoreId,
    commandId: 'create-s',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Repeated automatic compression continuity',
  });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    expectedStoreId,
    subjectId: 'owner',
    sessionId: 's',
    workspaceId: 'w',
    mode: 'full',
    trusted: true,
    nativeShellRead: true,
  });
  await client.startRun('s', {
    expectedStoreId,
    commandId: 'work',
    kind: 'run.start',
    content: task,
  });
  for (;;) {
    live.signal.throwIfAborted();
    const command = await store.getCommand('work');
    const runId =
      command?.receipt && typeof command.receipt === 'object' && !Array.isArray(command.receipt)
        ? command.receipt.runId
        : null;
    const run = typeof runId === 'string' ? await store.getRun(runId) : null;
    if (firstOrdinary && run && !correctionAccepted) {
      const session = (await store.getSession('s'))!;
      await client.steer('s', {
        expectedStoreId,
        commandId: 'correction',
        kind: 'input.steer',
        targetRunId: run.id,
        contextSelectionId: session.contextSelectionId,
        content: correction,
      });
      correctionAccepted = true;
      timeline.push({
        at: Date.now(),
        phase: 'correction_accepted',
        runId: run.id,
        commandId: 'correction',
      });
      releaseFirst();
    }
    const cards = await store.listInteractions({
      expectedStoreId,
      sessionId: 's',
      state: 'pending',
    });
    if (cards.interactions.length) {
      save('pending-interactions.json', cards);
      throw Error('unexpected_user_interaction');
    }
    if (run && !run.isActive) {
      result.run = run;
      break;
    }
    await fixtureDelay(30);
  }
  const { executions } = await readLiveExecutionDirectory(store, {
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
  });
  const facts = requestFacts.filter((fact) => fact.kind === 'ordinary');
  const compressions = [
    ...new Set(
      facts
        .map((fact) => (fact.compression as { modelExecutionId?: string } | null)?.modelExecutionId)
        .filter(Boolean),
    ),
  ];
  const postCompression = facts.filter((fact) => !!fact.compression);
  const finalVerification = independentlyVerify();
  const afterFiles = snapshot();
  const newPaths = Object.keys(afterFiles).filter((path) => !Object.hasOwn(beforeFiles, path));
  const unexpectedNewPaths = newPaths.filter(
    (path) => path !== '.test-runs.jsonl' && !path.includes('__pycache__/'),
  );
  const groupSafety = await store.readExecutionGroupSafety({
    expectedStoreId,
    subjectId: 'owner',
    sessionId: 's',
  });
  const changedExisting = Object.keys(beforeFiles)
    .filter((path) => beforeFiles[path] !== afterFiles[path])
    .sort();
  const expectedPaths = contracts.map((contract) => `src/${contract.name}.py`).sort();
  const logPath = join(workspace, '.test-runs.jsonl');
  const testRuns = existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          (line) => JSON.parse(line) as { name: string; nonce: string; checks: number; at: number },
        )
    : [];
  const passedModules = [
    ...new Set(testRuns.filter((row) => row.nonce === nonce).map((row) => row.name)),
  ].sort();
  const messages = await runtime.listMessages('s');
  const finalMessage =
    messages
      .filter((message) => message.role === 'assistant' && message.status === 'complete')
      .at(-1)?.content ?? '';
  const evidenceCalls = executions.filter(
    (execution) => execution.definitionId === 'execution_evidence.read',
  );
  const actualRequests = live.requests;
  const missingOriginals = executions.filter((execution) => {
    if (execution.kind !== 'tool' || execution.definitionId === 'execution_evidence.read')
      return false;
    const firstSeen = actualRequests.findIndex((request) =>
      request.messages.some(
        (message) => message.role === 'tool' && message.toolCallId === execution.callId,
      ),
    );
    return (
      firstSeen >= 0 &&
      actualRequests.slice(firstSeen + 1).some((request) => {
        const fact = facts.find((fact) => fact.requestId === request.requestId);
        return (
          fact?.compression &&
          !request.messages.some(
            (message) => message.role === 'tool' && message.toolCallId === execution.callId,
          )
        );
      })
    );
  });
  const recoveredIds = new Set<string>();
  for (const call of evidenceCalls.filter((call) => call.status === 'succeeded')) {
    try {
      const page = JSON.parse((call.result as { content: string }).content) as {
        items?: { execution: { id: string } }[];
      };
      for (const item of page.items ?? [])
        if (missingOriginals.some((row) => row.id === item.execution.id))
          recoveredIds.add(item.execution.id);
    } catch {
      /* A preview is insufficient to claim complete recovery; keep original evidence for review. */
    }
  }
  result = {
    ...result,
    finalVerification,
    groupSafety,
    newPaths,
    unexpectedNewPaths,
    changedExisting,
    expectedPaths,
    userDirtyPreserved:
      readFileSync(join(workspace, 'scratch/user-notes.txt'), 'utf8') === dirtyText,
    initialDirty: 'scratch/user-notes.txt',
    baselineHead,
    finalHead: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
    }).trim(),
    currentGitStatus: execFileSync('git', ['status', '--porcelain=v1'], {
      cwd: workspace,
      encoding: 'utf8',
    }),
    gitDiff: execFileSync('git', ['diff', '--binary', 'HEAD', '--'], {
      cwd: workspace,
      encoding: 'utf8',
    }),
    testRuns,
    passedModules,
    publishedCompressions: compressions,
    qualifiedCompressionProgress: compressionTriggers.filter((trigger) =>
      compressions.includes(String(trigger.summaryExecutionId)),
    ),
    finalMessage,
    finalMentionsAllPaths: expectedPaths.every((path) => finalMessage.includes(path)),
    evidenceRecovery: {
      observed: evidenceCalls.length > 0,
      originalToolsOutsideLaterWindow: missingOriginals.map((execution) => ({
        executionId: execution.id,
        callId: execution.callId,
      })),
      calls: evidenceCalls,
      recoveredMissingExecutionIds: [...recoveredIds],
      qualification: evidenceCalls.length
        ? 'Inspect exact original results and post-compaction call windows; a tool call alone does not prove recovery of a missing receipt.'
        : 'No natural execution-evidence call occurred; recovery use is not covered.',
    },
  };
  save('verification.json', result);
  requireCheck((result.run as { status: string }).status === 'completed', 'original_run_completed');
  requireCheck(correctionAccepted, 'real_user_correction_accepted');
  requireCheck(
    finalVerification.every((row) => row.passed),
    'all_eight_independent_contracts_pass',
  );
  requireCheck(
    isDeepStrictEqual(changedExisting, expectedPaths),
    'exact_eight_source_changes_and_user_dirty_preserved',
  );
  requireCheck(result.userDirtyPreserved, 'preexisting_user_dirty_unchanged');
  requireCheck(result.finalMentionsAllPaths, 'final_report_lists_all_eight_changed_source_paths');
  requireCheck(!unexpectedNewPaths.length, 'no_unrequested_new_project_files');
  requireCheck(result.finalHead === baselineHead, 'fixture_baseline_not_committed_or_reset');
  requireCheck(
    isDeepStrictEqual(passedModules, contracts.map((contract) => contract.name).sort()),
    'actual_unchanged_test_modules_logged_all_eight',
  );
  requireCheck(
    compressions.length >= 3,
    'at_least_three_published_automatic_compressions_after_verified_source_changes',
  );
  requireCheck(
    compressionTriggers.filter((trigger) =>
      compressions.includes(String(trigger.summaryExecutionId)),
    ).length >= 3 &&
      compressionTriggers.every(
        (trigger) =>
          Array.isArray(trigger.newVerifiedModules) &&
          trigger.newVerifiedModules.length > 0 &&
          Array.isArray(trigger.changedPaths) &&
          trigger.changedPaths.length > 0,
      ),
    'each_checkpoint_follows_new_source_changes_and_real_module_test_success',
  );
  requireCheck(
    compressions.every((id) => {
      const execution = executions.find((row) => row.id === id);
      const request = live!.requests.find((request) => request.requestId === id);
      return (
        execution?.kind === 'model' &&
        execution.status === 'succeeded' &&
        execution.runId === (result.run as { id: string }).id &&
        request &&
        isSummary(request)
      );
    }) &&
      postCompression.every(
        (fact) => (fact.compression as { trigger: string }).trigger === 'automatic',
      ),
    'each_published_checkpoint_has_its_actual_same_run_summary_model',
  );
  requireCheck(
    postCompression.every((fact) => fact.originalUserCount === 1 && fact.correctionCount === 1),
    'every_postcompression_request_keeps_exact_original_goal_and_correction_once',
  );
  requireCheck(
    live.wire.every((wire) => wire.status === 200),
    'all_actual_selected_model_requests_http200',
  );
  requireCheck(
    groupSafety.activeRunIds.length === 0 && groupSafety.pendingCommandIds.length === 0,
    'no_active_run_or_pending_command_at_completion',
  );
  requireCheck(groupSafety.quiescent, 'no_unconfirmed_execution_results_at_completion');
  status = 'assertions_passed';
} catch (error) {
  failure = safeError(error);
} finally {
  releaseFirst?.();
  if (store && runtime && live) {
    try {
      const { executions } = await readLiveExecutionDirectory(store, {
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
      });
      save('executions.json', executions);
      save('messages.json', await runtime.listMessages('s'));
      const canonicalProof = await saveLiveCanonicalModelEvidence({
        runtime,
        store,
        requests: live.requests,
        root: evidence,
        subjectId: 'owner',
        verifyRequests: true,
      });
      save('canonical-proof.json', canonicalProof);
      checks.canonicalModelEvidenceComplete =
        canonicalProof.complete && canonicalProof.requestIdentity?.matches === true;
      if (!checks.canonicalModelEvidenceComplete)
        evidenceErrors.push('canonical_model_evidence_mismatch');
      const jobs: Record<string, unknown> = {};
      for (const job of executions.filter((row) => row.kind === 'job')) {
        const items = [];
        let afterSeq = '0';
        for (;;) {
          const page = await store.listExecutionOutput({
            executionId: job.id,
            afterSeq,
            limit: 200,
          });
          items.push(...page.items);
          if (!page.items.length || page.items.at(-1)!.seq === page.highWaterSeq) break;
          afterSeq = page.items.at(-1)!.seq;
        }
        jobs[job.id] = items;
      }
      save('job-output.json', jobs);
      const logs = [];
      for await (const page of readLiveSessionLogPages(store, {
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
      }))
        logs.push(page);
      save('session-logs.json', logs);
    } catch (error) {
      evidenceErrors.push(safeError(error));
    }
  }
  if (live)
    save('models.json', {
      metadata: live.metadata,
      requests: live.requests,
      modelEvents: events,
      requestFacts,
      compressionTriggers,
      usage: live.usage,
      wire: live.wire,
      wireRequests: live.wireRequests,
      attemptFailures: live.attemptFailures,
    });
  save('timeline.json', timeline);
  for (const [name, close] of [
    ['client', () => client?.disposeNetwork()],
    ['service', () => service?.close()],
    ['runtime', () => runtime?.close()],
    ['store', () => store?.close()],
    ['locks', () => locks?.close()],
  ] as const) {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push(`${name}:${safeError(error)}`);
    }
  }
  const codeAfter = liveCodeEvidence();
  checks.codeUnchanged = isDeepStrictEqual(codeBefore, codeAfter);
  if (!checks.codeUnchanged || cleanupErrors.length || evidenceErrors.length) {
    status = 'failed';
    failure ??= 'evidence_or_cleanup_or_code_drift';
  }
  writeFileSync(
    join(output, 'report.json'),
    `${JSON.stringify(
      {
        status,
        failure,
        checks,
        codeBefore,
        codeAfter,
        metadata: live?.metadata ?? null,
        modelRequests: live?.requests.length ?? 0,
        providerRequests: live?.wire.length ?? 0,
        requestLimit: 80,
        timeoutMs: 600000,
        mode: 'full',
        task,
        correction,
        result,
        evidenceErrors,
        cleanupErrors,
        manualReviewRequired: true,
        qualification:
          'Real default Service Files/Shell/evidence catalogue in an isolated macOS project. Three automatic compaction triggers are fixture scheduling, not production token-waterline qualification. Actual summaries use the same real selected model. Existing user dirty is independently recorded. Final semantic claims and receipt recovery require review of complete original traces.',
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ status, failure, output, requests: live?.requests.length ?? 0, checks }),
  );
  if (status !== 'assertions_passed') process.exitCode = 1;
}
