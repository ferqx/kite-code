import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelRequest } from '@kite-ai/ai';
import { runAgentTaskQualityTrial } from './agent-task-quality.live';
import { createTaskQualityResearchFixture } from './agent-task-quality-fixture';
import {
  comparisonDigest,
  comparisonStableJson,
  comparisonWireParameters,
  comparisonWireRequestMatches,
  comparisonWorkspaceManifest,
  presentationComparisonPlan,
} from './agent-task-quality-presentation-ab-fixture';

type Arm = 'baseline' | 'candidate';
type Scenario = 'current-chain' | 'claim-adoption';
const entry = 'tests/e2e/live/model/agent-task-quality-checkout-ab.live.ts';
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function assertCheckoutModelBinding(binding: Readonly<Record<string, unknown>>) {
  const settings = binding.settings as Record<string, unknown> | undefined;
  if (
    binding.model !== 'deepseek-v4-flash' ||
    binding.provider !== 'deepseek' ||
    binding.protocol !== 'chat-completions' ||
    settings?.reasoningEffort !== 'medium' ||
    settings.maxOutputTokens !== 4096
  )
    throw Error('prespecified_model_binding_required');
}
/** Exact initial Files+Task surface. Schema/description and search version are treatment, extra tools are not. */
export function assertCheckoutToolCatalog(tools: ModelRequest['tools']) {
  const expected = [
    'glob_files',
    'list_directory',
    'read_file',
    'search_content',
    'write_file',
    'wait_agent_events',
    'follow_up_agent',
    'interrupt_agent',
    'list_agents',
    'send_agent_message',
    'spawn_agent',
  ].sort();
  if (comparisonStableJson(tools.map((tool) => tool.id).sort()) !== comparisonStableJson(expected))
    throw Error('unexpected_production_tool_catalog');
}
export function checkoutControls(request: ModelRequest, binding: unknown) {
  return { binding, modelId: request.modelId, messages: request.messages };
}
export function assertCheckoutIdentity(root: string, resolved: Record<string, string>) {
  for (const [name, path] of Object.entries(resolved))
    if (relative(root, realpathSync(path)).startsWith('..'))
      throw Error(`cross_checkout_resolution:${name}`);
}
/** Hash actual local production inputs, including Service child configuration; never configuration or credentials. */
export function checkoutProvenance(root: string) {
  const resolved = Object.fromEntries(
    [
      '@kite-ai/agent',
      '@kite-ai/agent/files',
      '@kite-ai/agent/task',
      '@kite-ai/agent/sqlite',
      '@kite-ai/ai',
      '@kite-ai/ai/sdk',
      '@kite-ai/service/configuration',
    ].map((id) => [id, realpathSync(import.meta.resolve(id).replace(/^file:\/\//, ''))]),
  );
  resolved.serviceChild = realpathSync(join(root, 'apps/service/src/child-configuration.ts'));
  assertCheckoutIdentity(root, resolved);
  const paths: string[] = [];
  function visit(path: string) {
    for (const item of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isSymbolicLink()) throw Error(`production_source_symlink:${child}`);
      if (item.isDirectory()) visit(child);
      else if (item.isFile()) paths.push(child);
    }
  }
  for (const path of ['packages/agent/src', 'packages/ai/src', 'apps/service/src']) visit(path);
  for (const path of [
    'bun.lock',
    'package.json',
    'packages/agent/package.json',
    'packages/ai/package.json',
    'apps/service/package.json',
  ])
    if (existsSync(join(root, path))) paths.push(path);
  const sources = paths.sort().map((path) => ({ path, sha256: hash(join(root, path)) }));
  return {
    root,
    resolved,
    entries: Object.fromEntries(
      Object.entries(resolved).map(([id, path]) => [id, { path, sha256: hash(path) }]),
    ),
    sources,
    sha256: comparisonDigest(sources),
  };
}
/** Controls include all live harness TypeScript and root compiler configuration. Per-arm snapshots may differ in tsconfig, but cannot drift. */
export function checkoutHarnessProvenance(root: string) {
  const paths = readdirSync(join(root, dirname(entry)))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dirname(entry), name));
  paths.push('tsconfig.json');
  const files = paths.sort().map((path) => ({ path, sha256: hash(join(root, path)) }));
  return { files, sha256: comparisonDigest(files) };
}
type Spec = {
  arm: Arm;
  checkout: string;
  expectedProductionSha: string;
  expectedHarnessSha: string;
  scenario: Scenario;
  trial: number;
  workspace: string;
  research: ReturnType<typeof createTaskQualityResearchFixture>;
  evidenceRoot: string;
  controls?: unknown;
  binding?: unknown;
  parameters?: unknown;
  armTools?: unknown;
};
export async function runCheckoutChild(spec: Spec) {
  const root = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
  if (root !== realpathSync(spec.checkout)) throw Error('wrong_checkout_child');
  const harnessBefore = checkoutHarnessProvenance(root);
  if (harnessBefore.sha256 !== spec.expectedHarnessSha)
    throw Error('harness_changed_since_frozen_probe');
  const before = checkoutProvenance(root);
  if (before.sha256 !== spec.expectedProductionSha)
    throw Error('production_changed_since_frozen_probe');
  // A uses its real committed implementation. Neither arm overrides Runtime presentation.
  let controls: unknown;
  let binding: unknown;
  let parameters: unknown;
  let tools: unknown;
  let failure: string | undefined;
  let protocol: unknown;
  const dispatched = new Map<string, ModelRequest>();
  const reject = (reason: string): never => {
    failure = reason;
    throw Error(reason);
  };
  const result = await runAgentTaskQualityTrial({
    scenario: spec.scenario,
    trial: spec.trial,
    evidenceRoot: spec.evidenceRoot,
    isolatedComparison: {
      variant: 'production',
      workspace: spec.workspace,
      research: spec.research,
      beforeModelRequest(request, metadata) {
        try {
          assertCheckoutModelBinding(metadata);
        } catch {
          reject('prespecified_model_binding_required');
        }
        protocol = metadata.protocol;
        dispatched.set(request.requestId, structuredClone(request));
        binding ??= metadata;
        if (comparisonStableJson(metadata) !== comparisonStableJson(spec.binding ?? binding))
          reject('model_binding_drift');
        if (!controls) {
          try {
            assertCheckoutToolCatalog(request.tools);
          } catch {
            reject('unexpected_production_tool_catalog');
          }
          controls = checkoutControls(request, metadata);
          tools = request.tools;
          if (
            spec.controls &&
            comparisonStableJson(controls) !== comparisonStableJson(spec.controls)
          )
            reject('fixed_system_task_controls_drift');
          if (spec.armTools && comparisonStableJson(tools) !== comparisonStableJson(spec.armTools))
            reject('within_arm_tool_declarations_drift');
        }
      },
      beforeWireRequest(wire) {
        const request = wire.requestId && dispatched.get(wire.requestId);
        if (!request || !comparisonWireRequestMatches(request, wire.body, protocol))
          reject('wire_full_body_identity_mismatch');
        const current = comparisonWireParameters(wire.body);
        parameters ??= current;
        if (comparisonStableJson(current) !== comparisonStableJson(spec.parameters ?? parameters))
          reject('wire_model_parameters_drift');
      },
    },
  });
  const after = checkoutProvenance(root);
  const harnessAfter = checkoutHarnessProvenance(root);
  if (harnessAfter.sha256 !== spec.expectedHarnessSha) failure = 'harness_changed_during_trial';
  if (before.sha256 !== after.sha256) failure = 'production_changed_during_trial';
  if (
    (result.canonical as { requestIdentity?: { matches?: boolean } })?.requestIdentity?.matches !==
      true ||
    result.cleanupErrors.length ||
    result.evidenceErrors.length ||
    (result.canonical as { complete?: boolean })?.complete !== true ||
    result.metrics.httpStatuses.some((status: number) => status === 0 || status >= 400)
  )
    failure ??= 'trial_infrastructure_failure';
  const report = {
    arm: spec.arm,
    failure,
    controls,
    binding,
    parameters,
    tools,
    before,
    after,
    harnessBefore,
    harnessAfter,
    result,
  };
  writeFileSync(join(spec.evidenceRoot, 'checkout-trial.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  return report;
}

export async function runCheckoutComparison(options: {
  evidenceRoot: string;
  baseline: string;
  candidate: string;
}) {
  if (process.env.KITE_RUN_LIVE_TASK_QUALITY !== '1')
    throw Error('requires_KITE_RUN_LIVE_TASK_QUALITY_1');
  if (!isAbsolute(options.evidenceRoot)) throw Error('new_absolute_evidence_root_required');
  mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(options.evidenceRoot);
  const checkouts = {
    baseline: realpathSync(options.baseline),
    candidate: realpathSync(options.candidate),
  };
  if (checkouts.baseline === checkouts.candidate) throw Error('distinct_checkouts_required');
  // Identical test code in both processes; each resolves its own production imports.
  const harnessFiles = readdirSync(dirname(fileURLToPath(import.meta.url))).filter((name) =>
    name.endsWith('.ts'),
  );
  for (const name of harnessFiles)
    if (
      hash(join(checkouts.baseline, dirname(entry), name)) !==
      hash(join(checkouts.candidate, dirname(entry), name))
    )
      throw Error(`harness_not_identical:${name}`);
  const pairs = new Map<
    string,
    {
      workspace: string;
      research: ReturnType<typeof createTaskQualityResearchFixture>;
      manifest: ReturnType<typeof comparisonWorkspaceManifest>;
      controls?: unknown;
    }
  >();
  for (const [scenario, trial] of presentationComparisonPlan) {
    const id = `${scenario}-${trial}`;
    if (pairs.has(id)) continue;
    const workspace = join(root, 'pairs', id, 'workspace');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const research = createTaskQualityResearchFixture({ trial, nonce: crypto.randomUUID() });
    for (const [path, content] of Object.entries(research.files)) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content);
    }
    pairs.set(id, { workspace, research, manifest: comparisonWorkspaceManifest(workspace) });
  }
  const frozen: Partial<
    Record<
      Arm,
      {
        provenance: ReturnType<typeof checkoutProvenance>;
        source: unknown;
        harness: ReturnType<typeof checkoutHarnessProvenance>;
      }
    >
  > = {};
  for (const arm of ['baseline', 'candidate'] as const) {
    const probe = Bun.spawn(
      [
        process.execPath,
        join(checkouts[arm], entry),
        `--probe=${[...pairs.values()][0]!.workspace}`,
      ],
      { cwd: checkouts[arm], stdout: 'pipe', stderr: 'pipe', env: process.env },
    );
    const budget = setTimeout(() => {
      if (probe.exitCode === null) probe.kill('SIGKILL');
    }, 30_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
        probe.exited,
      ]);
      if (code !== 0) throw Error(`production_probe_failed:${arm}:${code}:${stderr}`);
      frozen[arm] = JSON.parse(stdout);
      writeFileSync(join(root, `${arm}-frozen-probe.json`), stdout, { mode: 0o600 });
    } finally {
      clearTimeout(budget);
      if (probe.exitCode === null) probe.kill('SIGKILL');
      await probe.exited;
    }
  }
  if (
    comparisonStableJson(frozen.baseline!.source) !== comparisonStableJson(frozen.candidate!.source)
  )
    throw Error('global_system_source_changed_between_arms');
  const plan = presentationComparisonPlan.map(([scenario, trial, variant]) => ({
    scenario,
    trial,
    arm: (variant === 'raw' ? 'baseline' : 'candidate') as Arm,
  }));
  writeFileSync(
    join(root, 'fixed-plan.json'),
    JSON.stringify(
      {
        checkouts,
        plan,
        manualReviewRequired: true,
        fixed: [
          'provider/model/reasoning/global system/task bytes/pair workspace/file bytes/nonce/budgets/permissions',
        ],
        treatment: [
          'production tool declarations and schemas',
          'search version/default granularity/result presentation',
        ],
        baselineCommit: 'a10b781e2',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const reports: Awaited<ReturnType<typeof runCheckoutChild>>[] = [];
  const armTools: Partial<Record<Arm, unknown>> = {};
  let binding: unknown;
  let parameters: unknown;
  let failure: string | undefined;
  try {
    for (const [index, item] of plan.entries()) {
      for (const arm of ['baseline', 'candidate'] as const)
        if (checkoutHarnessProvenance(checkouts[arm]).sha256 !== frozen[arm]!.harness.sha256)
          throw Error(`harness_changed_before_trial:${arm}`);
      const pair = pairs.get(`${item.scenario}-${item.trial}`)!;
      if (comparisonWorkspaceManifest(pair.workspace).sha256 !== pair.manifest.sha256)
        throw Error('workspace_mutated_before_trial');
      const id = `${String(index + 1).padStart(2, '0')}-${item.scenario}-${item.trial}-${item.arm}`;
      const evidenceRoot = join(root, 'trials', id);
      mkdirSync(dirname(evidenceRoot), { recursive: true });
      const specPath = join(root, `${id}.spec.json`);
      const spec: Spec = {
        ...item,
        checkout: checkouts[item.arm],
        expectedProductionSha: frozen[item.arm]!.provenance.sha256,
        expectedHarnessSha: frozen[item.arm]!.harness.sha256,
        workspace: pair.workspace,
        research: pair.research,
        evidenceRoot,
        controls: pair.controls,
        binding,
        parameters,
        armTools: armTools[item.arm],
      };
      writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
      console.log(JSON.stringify({ event: 'checkout_trial_start', id }));
      const child = Bun.spawn(
        [process.execPath, join(spec.checkout, entry), `--child-spec=${specPath}`],
        { cwd: spec.checkout, stdout: 'inherit', stderr: 'inherit', env: process.env },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('checkout_child_test_budget_exceeded')), 600_000);
          }),
        ]);
        if (code !== 0) throw Error(`checkout_child_failed:${code}`);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
      if (!existsSync(join(evidenceRoot, 'checkout-trial.json')))
        throw Error('checkout_evidence_missing');
      const report = JSON.parse(
        readFileSync(join(evidenceRoot, 'checkout-trial.json'), 'utf8'),
      ) as Awaited<ReturnType<typeof runCheckoutChild>>;
      reports.push(report);
      for (const arm of ['baseline', 'candidate'] as const)
        if (checkoutHarnessProvenance(checkouts[arm]).sha256 !== frozen[arm]!.harness.sha256)
          throw Error(`harness_changed_after_trial:${arm}`);
      console.log(
        JSON.stringify({
          event: 'checkout_trial_end',
          id,
          status: report.result.status,
          failure: report.result.failure,
        }),
      );
      if (report.failure) throw Error(report.failure);
      if (comparisonWorkspaceManifest(pair.workspace).sha256 !== pair.manifest.sha256)
        throw Error('workspace_mutated_after_trial');
      pair.controls ??= report.controls;
      binding ??= report.binding;
      parameters ??= report.parameters;
      armTools[item.arm] ??= report.tools;
      // Quality failures remain in the fixed matrix; no replacement samples.
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const summary = {
    status:
      failure ||
      reports.length !== 8 ||
      reports.some((report) => report.result.status !== 'assertions_passed')
        ? 'failed'
        : 'assertions_passed',
    failure,
    manualReviewRequired: true,
    plannedTrials: 8,
    completedTrials: reports.length,
    reports,
  };
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  return summary;
}
if (import.meta.main) {
  const value = (name: string) =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const probe = value('probe');
  const spec = value('child-spec');
  if (probe) {
    const root = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
    const { createWorkspaceFiles, createFileTools } = await import('@kite-ai/agent/files');
    const { defaultTaskRoles, createTaskExtension } = await import('@kite-ai/agent/task');
    const { agentContractSource } = await import('@kite-ai/agent/sources');
    const files = createWorkspaceFiles({ root: probe });
    try {
      const task = createTaskExtension({
        roles: defaultTaskRoles.map((role) => ({
          id: role.id,
          configurationId: role.id,
          description: role.description!,
        })),
        defaultRole: 'worker',
        presets: defaultTaskRoles.filter((role) => role.id !== 'worker').map((role) => role.id),
      });
      console.log(
        JSON.stringify({
          provenance: checkoutProvenance(root),
          harness: checkoutHarnessProvenance(root),
          source: agentContractSource(probe),
          fileTools: createFileTools(files).filter((tool) =>
            ['files.read', 'files.list', 'files.glob', 'files.search', 'files.write'].includes(
              tool.id,
            ),
          ),
          taskTools: task.tools,
          roles: defaultTaskRoles,
        }),
      );
    } finally {
      await files.close();
    }
  } else if (spec) await runCheckoutChild(JSON.parse(readFileSync(spec, 'utf8')));
  else {
    const evidenceRoot = value('evidence-root');
    const baseline = value('baseline');
    const candidate = value('candidate');
    if (!evidenceRoot || !baseline || !candidate)
      throw Error('evidence-root_baseline_candidate_required');
    const summary = await runCheckoutComparison({ evidenceRoot, baseline, candidate });
    if (summary.status !== 'assertions_passed') process.exitCode = 1;
  }
}
