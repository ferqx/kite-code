import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadApprovedProductionExecutionQualificationRegistryV1 } from '../src/core/config/execution-qualification';

interface PlanSpec {
  alias: string;
  file: string;
}

interface MatrixRow {
  plan: PlanSpec;
  taskId: string;
  dependsOn: string;
  outputs: string;
  verification: string;
  migrationAndRollback: string;
  sourceLine: string;
}

const root = process.cwd();
const planDir = join(root, 'docs', 'space', 'plans');
const plans: PlanSpec[] = [
  { alias: '0', file: '2026-07-29-agent-production-governance-decisions.md' },
  { alias: '1A', file: '2026-07-29-agent-production-local-data-privacy.md' },
  { alias: '1B', file: '2026-07-29-agent-production-execution-isolation.md' },
  { alias: '1C', file: '2026-07-29-agent-production-runtime-resilience.md' },
  { alias: '2A', file: '2026-07-29-agent-production-release-control.md' },
  { alias: '2B', file: '2026-07-29-agent-production-evaluation.md' },
  { alias: '3', file: '2026-07-29-agent-production-observability-operations.md' },
  { alias: '4', file: '2026-07-29-agent-production-compaction-qualification.md' },
  { alias: '5', file: '2026-07-29-agent-production-capability-rollout.md' },
  { alias: '6', file: '2026-07-29-agent-production-ga.md' },
];

const stableMilestoneProducers = new Map<string, string>([
  ['MS:M0', '0:0.5'],
  ['MS:1A-DONE', '1A:1A.7'],
  ['MS:1B-DONE', '1B:1B.9'],
  ['MS:1C-DONE', '1C:1C.8'],
  ['MS:2A-F', '2A:2A.7'],
  ['MS:2B-DONE', '2B:2B.10'],
  ['MS:3-OPS-READY', '3:3.9'],
  ['MS:2A-RC', '2A:2A.11'],
  ['MS:LIMITED-SLO', '3:3.10'],
  ['MS:4-INTERNAL-AUTO-FRESH', '4:4.9'],
  ['MS:4-MANUAL-STABLE', '4:4.11'],
  ['MS:5A-STABLE', '5:5A.5'],
  ['MS:5B-STABLE', '5:5B.6'],
  ['MS:5C-READONLY-STABLE', '5:5C.5'],
  ['MS:5C-EFFECTFUL-STABLE', '5:5C.8'],
  ['MS:6A-AUTO-STABLE', '6:6A.4'],
]);

const roadmapOnlyMilestones = new Set(['MS:M2-CANDIDATE', 'MS:LIM-APPROVED']);
const knownMilestones = new Set([...stableMilestoneProducers.keys(), ...roadmapOnlyMilestones]);
const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function requireReachableCommit(commit: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    fail(`${label}: evidence commit must be a full lowercase SHA-1`);
    return;
  }
  const object = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], {
    cwd: root,
    stdio: 'ignore',
  });
  if (object.status !== 0) {
    if (process.env.OPENPX_REQUIRE_EVIDENCE_HISTORY === '1') {
      fail(`${label}: evidence commit ${commit} does not exist in the checkout`);
    }
    return;
  }
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
    cwd: root,
    stdio: 'ignore',
  });
  if (ancestor.status !== 0 && process.env.OPENPX_REQUIRE_EVIDENCE_HISTORY === '1') {
    fail(`${label}: evidence commit ${commit} is not reachable from HEAD`);
  }
}

function readPlan(plan: PlanSpec): string {
  return readFileSync(join(planDir, plan.file), 'utf8');
}

function parsePipeRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function extractMatrix(plan: PlanSpec, source: string): MatrixRow[] {
  const lines = source.split('\n');
  const heading = lines.findIndex((line) => /^#{2,3} 任务执行矩阵$/.test(line));
  if (heading < 0) {
    fail(`${plan.file}: missing 任务执行矩阵 heading`);
    return [];
  }

  const headerIndex = lines.findIndex(
    (line, index) => index > heading && /^\|\s*Task\s*\|/.test(line),
  );
  if (headerIndex < 0) {
    fail(`${plan.file}: missing matrix header`);
    return [];
  }

  const header = parsePipeRow(lines[headerIndex]);
  const requiredHeader = ['Task', 'dependsOn', '文件/产出', '定向验证', '迁移与回滚'];
  if (
    header.length < requiredHeader.length ||
    requiredHeader.some((cell, index) => header[index] !== cell)
  ) {
    fail(`${plan.file}: matrix must start with columns ${requiredHeader.join(' | ')}`);
  }

  const rows: MatrixRow[] = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('|')) break;
    const cells = parsePipeRow(line);
    if (cells.length < 5) {
      fail(`${plan.file}:${index + 1}: matrix row has fewer than 5 cells`);
      continue;
    }
    const [taskId, dependsOn, outputs, verification, migrationAndRollback] = cells;
    if ([taskId, dependsOn, outputs, verification, migrationAndRollback].some((cell) => !cell)) {
      fail(`${plan.file}:${index + 1}: matrix cells must not be empty`);
    }
    for (const cell of cells) {
      if (/\b(?:N\/A|NA)\b/i.test(cell) && !/\b(?:N\/A|NA)\b[^|]*[（(].+[）)]/i.test(cell)) {
        fail(`${plan.file}:${index + 1}: N/A must include a reason in parentheses`);
      }
    }
    rows.push({
      plan,
      taskId: taskId.replaceAll('`', ''),
      dependsOn,
      outputs,
      verification,
      migrationAndRollback,
      sourceLine: `${plan.file}:${index + 1}`,
    });
  }
  return rows;
}

function taskHeadings(source: string): string[] {
  return [...source.matchAll(/^### Task ([^：:\n]+)[：:]/gm)].map((match) => match[1].trim());
}

function normalizeDependency(value: string): string {
  return value.replaceAll('`', '').trim();
}

function expandLocalRange(token: string, taskIds: ReadonlySet<string>): string[] | undefined {
  const match = token.match(/^([0-9]+[A-Z]?\.)?([0-9]+)–([0-9]+[A-Z]?\.)?([0-9]+)$/);
  if (!match) return undefined;
  const leftPrefix = match[1] ?? '';
  const rightPrefix = match[3] ?? leftPrefix;
  if (leftPrefix !== rightPrefix) return undefined;
  const start = Number(match[2]);
  const end = Number(match[4]);
  if (start > end) return undefined;
  const ids = Array.from(
    { length: end - start + 1 },
    (_, index) => `${leftPrefix}${start + index}`,
  );
  return ids.every((id) => taskIds.has(id)) ? ids : undefined;
}

function detectCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(node: string): string[] | undefined {
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      return [...path.slice(start), node];
    }
    if (visited.has(node)) return undefined;
    visiting.add(node);
    path.push(node);
    for (const dependency of graph.get(node) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(node);
    visited.add(node);
    return undefined;
  }

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

const sources = new Map(plans.map((plan) => [plan.alias, readPlan(plan)]));
const rows = plans.flatMap((plan) => extractMatrix(plan, sources.get(plan.alias) ?? ''));
const rowsByPlan = new Map<string, MatrixRow[]>();
for (const plan of plans)
  rowsByPlan.set(
    plan.alias,
    rows.filter((row) => row.plan === plan),
  );

for (const plan of plans) {
  const planRows = rowsByPlan.get(plan.alias) ?? [];
  const matrixIds = planRows.map((row) => row.taskId);
  const headings = taskHeadings(sources.get(plan.alias) ?? '');
  const duplicateIds = matrixIds.filter((id, index) => matrixIds.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    fail(`${plan.file}: duplicate matrix Task IDs: ${[...new Set(duplicateIds)].join(', ')}`);
  }
  const sortedMatrixIds = [...matrixIds].sort();
  const sortedHeadings = [...headings].sort();
  if (sortedMatrixIds.join('\0') !== sortedHeadings.join('\0')) {
    fail(
      `${plan.file}: matrix/body Task mismatch\n  matrix: ${matrixIds.join(', ')}\n  body: ${headings.join(', ')}`,
    );
  }
  if (
    !/docs\/space\/execution\/completed\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[^`\s]+\.md/.test(
      sources.get(plan.alias) ?? '',
    )
  ) {
    fail(`${plan.file}: missing concrete completionRecordPath`);
  }
}

const taskKeys = new Set(rows.map((row) => `${row.plan.alias}:${row.taskId}`));
const graph = new Map<string, string[]>();
for (const row of rows) {
  const key = `${row.plan.alias}:${row.taskId}`;
  const planTaskIds = new Set((rowsByPlan.get(row.plan.alias) ?? []).map((item) => item.taskId));
  const dependencies: string[] = [];
  const tokens = normalizeDependency(row.dependsOn)
    .split('、')
    .map((token) => token.trim());
  if (tokens.length === 1 && tokens[0] === '—') {
    graph.set(key, []);
    continue;
  }

  for (const token of tokens) {
    if (!token || token === '—') {
      fail(`${row.sourceLine}: em dash may only be the sole dependsOn value`);
      continue;
    }
    const crossTask = token.match(/^T:([0-9]+[A-Z]?):([0-9]+[A-Z]?\.[0-9]+[A-Z]?)$/);
    if (crossTask) {
      const dependency = `${crossTask[1]}:${crossTask[2]}`;
      if (!taskKeys.has(dependency)) fail(`${row.sourceLine}: unknown dependency ${token}`);
      else dependencies.push(dependency);
      continue;
    }
    if (/^D-(?:0[1-9]|1[0-4]):CLOSED$/.test(token)) continue;
    if (/^MS:/.test(token)) {
      if (!knownMilestones.has(token)) fail(`${row.sourceLine}: unknown milestone ${token}`);
      continue;
    }
    if (planTaskIds.has(token)) {
      dependencies.push(`${row.plan.alias}:${token}`);
      continue;
    }
    const range = expandLocalRange(token, planTaskIds);
    if (range) {
      dependencies.push(...range.map((taskId) => `${row.plan.alias}:${taskId}`));
      continue;
    }
    fail(`${row.sourceLine}: invalid or natural-language dependsOn token "${token}"`);
  }
  graph.set(key, dependencies);
}

const cycle = detectCycle(graph);
if (cycle) fail(`task dependency cycle: ${cycle.join(' -> ')}`);

for (const [milestone, producer] of stableMilestoneProducers) {
  const [alias, taskId] = producer.split(':', 2);
  const matchingRows = rows.filter(
    (row) =>
      `${row.outputs} ${row.migrationAndRollback}`.includes(milestone) &&
      /唯一产生/.test(`${row.outputs} ${row.migrationAndRollback}`),
  );
  if (matchingRows.length !== 1) {
    fail(`${milestone}: expected one matrix producer, found ${matchingRows.length}`);
    continue;
  }
  const actual = `${matchingRows[0].plan.alias}:${matchingRows[0].taskId}`;
  if (actual !== `${alias}:${taskId}`) {
    fail(`${milestone}: expected producer ${producer}, found ${actual}`);
  }
}

const roadmap = readFileSync(
  join(planDir, '2026-07-29-agent-production-readiness-roadmap.md'),
  'utf8',
);
const plansIndex = readFileSync(join(planDir, 'index.md'), 'utf8');
for (const milestone of knownMilestones) {
  const tableRows = roadmap
    .split('\n')
    .filter((line) => line.startsWith('|') && line.includes(`\`${milestone}\``));
  if (tableRows.length !== 1) {
    fail(
      `roadmap stable milestone table must contain ${milestone} exactly once; found ${tableRows.length}`,
    );
  } else if (
    parsePipeRow(tableRows[0])
      .slice(1)
      .every((cell) => !cell)
  ) {
    fail(`roadmap ${milestone} producer is empty`);
  }
}

const decisionRegister = readFileSync(
  join(planDir, '2026-07-29-agent-production-decision-register.md'),
  'utf8',
);
const decisionSections = [
  ...decisionRegister.matchAll(
    /^### (D-(?:0[1-9]|1[0-4]))\n([\s\S]*?)(?=^### D-|^## |(?![\s\S]))/gm,
  ),
];
const decisionIds = decisionSections.map((match) => match[1]);
const expectedDecisionIds = Array.from(
  { length: 14 },
  (_, index) => `D-${String(index + 1).padStart(2, '0')}`,
);
if (decisionIds.join('\0') !== expectedDecisionIds.join('\0')) {
  fail(`decision register IDs must be D-01..D-14 exactly once; found ${decisionIds.join(', ')}`);
}
const requiredDecisionFields = [
  'status',
  'owner',
  'backup',
  'dueMilestone',
  'blockingPhase',
  'default',
  'decision',
  'evidence',
  'approvedAt',
];
for (const match of decisionSections) {
  const [, id, body] = match;
  for (const field of requiredDecisionFields) {
    if (!new RegExp(`^- ${field}: .+`, 'm').test(body)) fail(`${id}: missing ${field}`);
  }
  const status = body.match(/^- status: `([^`]+)`/m)?.[1];
  const approvedAt = body.match(/^- approvedAt: `([^`]+)`/m)?.[1];
  if (status !== 'open' && status !== 'closed')
    fail(`${id}: invalid status ${status ?? '(missing)'}`);
  if (status === 'closed' && (!approvedAt || approvedAt === 'null')) {
    fail(`${id}: closed decision requires approvedAt`);
  }
}
if (/TBD owner/i.test(decisionRegister)) fail('decision register contains TBD owner');

if (decisionRegister.includes('single-maintainer')) {
  for (const match of decisionSections) {
    const [id, body] = [match[1], match[2]];
    if (!/^- owner: `github:@ferqx`/m.test(body)) {
      fail(`${id}: single-maintainer owner must be github:@ferqx`);
    }
    if (!/^- backup: `none \(single-maintainer\)`$/m.test(body)) {
      fail(`${id}: single-maintainer backup must explicitly be none`);
    }
  }
  const d13 = decisionSections.find((match) => match[1] === 'D-13')?.[2] ?? '';
  if (!/^- status: `closed`$/m.test(d13)) {
    fail('D-13 must be closed after single-maintainer governance is accepted');
  }
  const governanceAdr = readFileSync(
    join(root, 'docs', 'adr', '0060-single-maintainer-release-governance.md'),
    'utf8',
  );
  if (!/^状态：accepted$/m.test(governanceAdr)) {
    fail('ADR-0060 must be accepted for single-maintainer governance');
  }
  const limitedApprovalRow = roadmap
    .split('\n')
    .find((line) => line.startsWith('|') && line.includes('`MS:LIM-APPROVED`'));
  if (!limitedApprovalRow?.includes('第三方安全评审')) {
    fail('MS:LIM-APPROVED must require third-party security review');
  }
}

for (const decisionId of ['D-02', 'D-08', 'D-09', 'D-11', 'D-12', 'D-13', 'D-14']) {
  const body = decisionSections.find((match) => match[1] === decisionId)?.[2] ?? '';
  if (!/^- status: `closed`$/m.test(body)) {
    fail(`${decisionId}: Phase 0 blocking decision must be closed`);
  }
}

for (let number = 51; number <= 60; number += 1) {
  const prefix = String(number).padStart(4, '0');
  const adrFile = [
    '0051-release-profile-monotonic-composition.md',
    '0052-release-evidence-and-behavior-identity.md',
    '0053-local-single-user-first-topology.md',
    '0054-production-execution-isolation.md',
    '0055-cumulative-runtime-resource-governance.md',
    '0056-metadata-first-data-boundaries.md',
    '0057-compaction-release-qualification.md',
    '0058-agent-task-product-acceptance.md',
    '0059-optional-disable-only-signed-rollout.md',
    '0060-single-maintainer-release-governance.md',
  ].find((file) => file.startsWith(prefix));
  if (!adrFile) {
    fail(`ADR-${prefix}: missing governance ADR path`);
    continue;
  }
  const source = readFileSync(join(root, 'docs', 'adr', adrFile), 'utf8');
  if (!/^状态：accepted$/m.test(source)) fail(`ADR-${prefix}: must be accepted`);
}

const phase0ArtifactCommit = '4be8735b29ec0fe3951bf7a0876f7b5e722c846a';
const phase1SchemaCommit = '4b8eec058df0af545675fc0e1c4135ee855848fd';
const phase1AdmissionCommit = '1e21055eb8b2579d710eb566728294f2ad8b2621';
const phase1OperationalCommit = 'd0bd571e6a937aac55850bcc09df6f41bf95ac99';
const phase1CompositionCommit = '2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee';
const phase1NativeEvidenceCommit = '1063e879933f3e1b0cf8c0958363c999bb2696ab';
const phase1BoundaryCommit = '3ada4246b149444ce27ed713cd5425090367c1fc';
const phase1PlatformExclusionCommit = 'c9e0dccdaad4cc6a6db57b54d80e0074e3bf8aa4';
const phase1PlatformExclusionCompletionPath =
  'docs/space/execution/completed/2026-08-01-agent-production-platform-exclusions.md';
const phase1ProtectedPathInitialCommit = '138fee19d7ce9f9622f1e32ea1d7cfdd2076bf8c';
const phase1ProtectedPathCommit = '512e2c3582bdd2bea2e7f670213f7616f545084c';
const phase1ProtectedPathSeatbeltCommit = '77db1830771aaf65116fb8802892d74c4bcbd7dc';
const phase1ProtectedPathQualification = 'e6e0ffb51115c3380a1dcc340dd1627b3bdd0970';
const phase1ProtectedPathCompletionPath =
  'docs/space/execution/completed/2026-08-01-agent-production-protected-path.md';
const phase1NetworkCommit = 'bc03f77a3dac2962cd3158d3413f292b8388a0d8';
const phase1NetworkReviewBaseline = '9bc626a1996261545c94e1e5950274029152bf1e';
const phase1RemoteMcpCommit = '545161a7103365038989c6a935a216c5bd5fc7e8';
const phase1PrivacyClosureEvidenceCommit = '389a0cc45c36e59d961c659ab4df4015a722f7de';
const phase1FailureConformanceBaseline = '4a64837855b76c8c71e956b19d04ad67d77b18c9';
const phase1FailureConformanceCommit = 'aa66e872f3206df9718493adbfef7445fb582a4f';
const phase1FailureConformanceQualification = 'dfd8f209f89b4980b9c3905d3e73c166b33bea2b';
const phase1RuntimeQualificationCommit = '23f8fe8427fc9c6bc3fa6c55cf0eef4892d915e3';
const phase1RuntimeQualificationHardening = 'ff683b12cbe78f478a5a6b31be7627412e3ed372';
const phase1RuntimeQualificationHead = 'e23b81b1087a7cdea5f4d9c5d419f5d040b67702';
const phase1RuntimeQualificationRun = '30710906064';
const phase1RuntimeQualificationArtifact = 'runtime-resilience-qualification-30710906064';
const phase1RuntimeQualificationArtifactId = '8822010140';
const phase1RuntimeQualificationDigest =
  'sha256:5b6146bd7fe0aff44595791c83307aa09fb15e40a09ca2fcdef7f8c7e3b34694';
const phase1RuntimeCompletionPath =
  'docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md';
const phase1PrivacyPlan = sources.get('1A') ?? '';
const phase1ExecutionPlan = sources.get('1B') ?? '';
const phase1RuntimePlan = sources.get('1C') ?? '';
const phase1RuntimeCompletion = readFileSync(join(root, phase1RuntimeCompletionPath), 'utf8');
const expectedPlanStates = new Map([
  ['2026-07-29-agent-production-readiness-roadmap.md', 'active'],
  ['2026-07-29-agent-production-governance-decisions.md', 'archived'],
  ['2026-07-29-agent-production-local-data-privacy.md', 'completed'],
  ['2026-07-29-agent-production-execution-isolation.md', 'active'],
  ['2026-07-29-agent-production-runtime-resilience.md', 'completed'],
]);
for (const [file, expectedState] of expectedPlanStates) {
  const source = readFileSync(join(planDir, file), 'utf8');
  if (!new RegExp(`^状态：${expectedState}$`, 'm').test(source)) {
    fail(`${file}: expected lifecycle state ${expectedState} after MS:M0`);
  }
}

const phase1PrivacyAcceptance =
  phase1PrivacyPlan.match(/^## 验收条件\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
const checkedPhase1PrivacyAcceptance = phase1PrivacyAcceptance.match(/^- \[x\] /gm) ?? [];
if (checkedPhase1PrivacyAcceptance.length !== 11 || /^- \[ \] /m.test(phase1PrivacyAcceptance)) {
  fail(
    '1A: completed plan must retain all 11 checked acceptance criteria and no unchecked criteria',
  );
}

const phase0CompletionPath = join(
  root,
  'docs',
  'space',
  'execution',
  'completed',
  '2026-07-30-agent-production-governance.md',
);
const phase0Completion = readFileSync(phase0CompletionPath, 'utf8');
if (!/^状态：completed$/m.test(phase0Completion)) {
  fail('Phase 0 completion record must be completed');
}
if (!phase0Completion.includes(`实现提交：\`${phase0ArtifactCommit}\``)) {
  fail('Phase 0 completion record must identify the reviewed artifact commit');
}
if (!phase0Completion.includes('唯一产生 `MS:M0`')) {
  fail('Phase 0 completion record must be the unique MS:M0 producer');
}
if (!phase0Completion.includes('结论：`approved_for_internal_implementation`')) {
  fail('Phase 0 completion record must limit M0 approval to internal implementation');
}

for (const taskId of ['1A.1', '1C.1']) {
  const bindingRow = decisionRegister.split('\n').find((line) => line.startsWith(`| ${taskId} |`));
  if (!bindingRow) {
    fail(`${taskId}: missing post-M0 execution binding`);
    continue;
  }
  if (!bindingRow.includes(`| \`${phase0ArtifactCommit}\` |`)) {
    fail(`${taskId}: binding must use the Phase 0 artifact baseline`);
  }
  if (!/\| `(ready|in_progress|completed)` \|/.test(bindingRow)) {
    fail(`${taskId}: post-M0 execution binding must be ready, in_progress, or completed`);
  }
}

for (const taskId of ['1A.5', '1C.2', '1C.4']) {
  const bindingRow = decisionRegister.split('\n').find((line) => line.startsWith(`| ${taskId} |`));
  if (!bindingRow) {
    fail(`${taskId}: missing post-schema execution binding`);
    continue;
  }
  if (!bindingRow.includes(`| \`${phase1SchemaCommit}\` |`)) {
    fail(`${taskId}: binding must use the completed schema implementation baseline`);
  }
  if (!bindingRow.includes('| `completed` |')) {
    fail(`${taskId}: admission/taxonomy execution binding must be completed`);
  }
}

for (const taskId of ['1A.2', '1C.3']) {
  const bindingRow = decisionRegister.split('\n').find((line) => line.startsWith(`| ${taskId} |`));
  if (!bindingRow) {
    fail(`${taskId}: missing post-admission execution binding`);
    continue;
  }
  if (!bindingRow.includes(`| \`${phase1AdmissionCommit}\` |`)) {
    fail(`${taskId}: binding must use the completed admission/taxonomy implementation baseline`);
  }
  if (!bindingRow.includes('| `completed` |')) {
    fail(`${taskId}: operational execution binding must be completed`);
  }
}

for (const taskId of ['1A.3', '1C.6']) {
  const bindingRow = decisionRegister.split('\n').find((line) => line.startsWith(`| ${taskId} |`));
  if (!bindingRow) {
    fail(`${taskId}: missing post-operational execution binding`);
    continue;
  }
  if (!bindingRow.includes(`| \`${phase1CompositionCommit}\` |`)) {
    fail(`${taskId}: binding must use the completed composition/stability implementation`);
  }
  if (!bindingRow.includes('| `completed` |')) {
    fail(`${taskId}: composition/stability execution binding must be completed`);
  }
}

for (const taskId of ['1A.4', '1B.0']) {
  const bindingRow = decisionRegister.split('\n').find((line) => line.startsWith(`| ${taskId} |`));
  if (!bindingRow) {
    fail(`${taskId}: missing next execution binding`);
    continue;
  }
  if (!bindingRow.includes(`| \`${phase1CompositionCommit}\` |`)) {
    fail(`${taskId}: binding must use the completed composition/stability baseline`);
  }
  if (!bindingRow.includes('| `completed` |')) {
    fail(`${taskId}: native-evidence execution binding must be completed`);
  }
}

const phase1BoundaryBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 1B.1 |'));
if (!phase1BoundaryBinding) {
  fail('1B.1: missing execution-boundary schema binding');
} else {
  if (!phase1BoundaryBinding.includes(`| \`${phase1NativeEvidenceCommit}\` |`)) {
    fail('1B.1: binding must use the completed native-evidence baseline');
  }
  if (!phase1BoundaryBinding.includes('| `completed` |')) {
    fail('1B.1: execution-boundary schema binding must be completed');
  }
  const cells = parsePipeRow(phase1BoundaryBinding);
  const expectedCompletionPath =
    'docs/space/execution/completed/2026-07-31-agent-production-execution-boundary.md';
  if (cells[6]?.replaceAll('`', '') !== expectedCompletionPath) {
    fail(`1B.1: completionRecordPath must be ${expectedCompletionPath}`);
  }
}

for (const taskId of ['1B.2', '1B.3']) {
  const bindingRow = decisionRegister.split('\n').find((line) => line.startsWith(`| ${taskId} |`));
  if (!bindingRow) {
    fail(`${taskId}: missing post-boundary execution binding`);
    continue;
  }
  const cells = parsePipeRow(bindingRow);
  if (cells[2]?.replaceAll('`', '') !== phase1BoundaryCommit) {
    fail(`${taskId}: binding must use the completed execution-boundary baseline`);
  }
  if (cells[4]?.replaceAll('`', '') !== 'completed') {
    fail(`${taskId}: platform-exclusion execution binding must be completed`);
  }
  if (cells[6]?.replaceAll('`', '') !== phase1PlatformExclusionCompletionPath) {
    fail(`${taskId}: completionRecordPath must be ${phase1PlatformExclusionCompletionPath}`);
  }
}

const phase1ProtectedPathBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 1B.5 |'));
if (!phase1ProtectedPathBinding) {
  fail('1B.5: missing protected-path execution binding');
} else {
  const cells = parsePipeRow(phase1ProtectedPathBinding);
  if (cells[2]?.replaceAll('`', '') !== phase1PlatformExclusionCommit) {
    fail('1B.5: binding must use the completed platform-exclusion baseline');
  }
  if (cells[4]?.replaceAll('`', '') !== 'completed') {
    fail('1B.5: protected-path execution binding must be completed');
  }
  if (cells[6]?.replaceAll('`', '') !== phase1ProtectedPathCompletionPath) {
    fail(`1B.5: completionRecordPath must be ${phase1ProtectedPathCompletionPath}`);
  }
}
for (const taskId of ['1B.6', '1B.7', '1B.8']) {
  const binding = decisionRegister.split('\n').find((line) => line.startsWith(`| ${taskId} |`));
  if (!binding) {
    fail(`${taskId}: locally converged Task must have an execution binding`);
    continue;
  }
  const cells = parsePipeRow(binding);
  if (cells[2]?.replaceAll('`', '') !== phase1RuntimeQualificationHead) {
    fail(`${taskId}: binding must use the post-1C qualification baseline`);
  }
  if (cells[4]?.replaceAll('`', '') !== 'in_progress') {
    fail(`${taskId}: binding must remain in_progress until the final whole-diff review`);
  }
  if (cells[6]?.replaceAll('`', '') !== '—') {
    fail(`${taskId}: completionRecordPath must remain empty before final review`);
  }
}

const phase1NetworkBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 1B.4 |'));
if (!phase1NetworkBinding) {
  fail('1B.4: missing network-boundary execution binding');
} else {
  if (!phase1NetworkBinding.includes(`| \`${phase1BoundaryCommit}\` |`)) {
    fail('1B.4: binding must use the completed execution-boundary baseline');
  }
  if (!phase1NetworkBinding.includes('| `completed` |')) {
    fail('1B.4: network-boundary execution binding must be completed');
  }
  const cells = parsePipeRow(phase1NetworkBinding);
  const expectedCompletionPath =
    'docs/space/execution/completed/2026-08-01-agent-production-network-boundary.md';
  if (cells[6]?.replaceAll('`', '') !== expectedCompletionPath) {
    fail(`1B.4: completionRecordPath must be ${expectedCompletionPath}`);
  }
}

const phase1RemoteMcpBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 1A.6 |'));
if (!phase1RemoteMcpBinding) {
  fail('1A.6: missing post-network execution binding');
} else {
  if (!phase1RemoteMcpBinding.includes(`| \`${phase1NetworkReviewBaseline}\` |`)) {
    fail('1A.6: binding must use the reviewed network-boundary baseline');
  }
  if (!phase1RemoteMcpBinding.includes('| `completed` |')) {
    fail('1A.6: remote MCP egress execution binding must be completed');
  }
  const cells = parsePipeRow(phase1RemoteMcpBinding);
  const expectedCompletionPath =
    'docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md';
  if (cells[6]?.replaceAll('`', '') !== expectedCompletionPath) {
    fail(`1A.6: completionRecordPath must be ${expectedCompletionPath}`);
  }
}

const phase1PrivacyClosureBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 1A.7 |'));
if (!phase1PrivacyClosureBinding) {
  fail('1A.7: missing post-egress execution binding');
} else {
  if (!phase1PrivacyClosureBinding.includes(`| \`${phase1RemoteMcpCommit}\` |`)) {
    fail('1A.7: binding must use the completed remote MCP egress baseline');
  }
  if (!phase1PrivacyClosureBinding.includes('| `completed` |')) {
    fail('1A.7: documentation closure execution binding must be completed');
  }
  const cells = parsePipeRow(phase1PrivacyClosureBinding);
  const expectedCompletionPath =
    'docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md';
  if (cells[6]?.replaceAll('`', '') !== expectedCompletionPath) {
    fail(`1A.7: completionRecordPath must be ${expectedCompletionPath}`);
  }
}

const phase1PrivacyPlanIndexRow = plansIndex
  .split('\n')
  .find((line) =>
    line.startsWith(
      '| [`2026-07-29-agent-production-local-data-privacy.md`](2026-07-29-agent-production-local-data-privacy.md) |',
    ),
  );
if (!phase1PrivacyPlanIndexRow) {
  fail('plans/index.md: missing Phase 1A local-data-privacy row');
} else {
  const cells = parsePipeRow(phase1PrivacyPlanIndexRow);
  if (cells[1] !== 'completed') {
    fail('plans/index.md: Phase 1A local-data-privacy plan must be completed');
  }
  if (!cells[5]?.includes('Task 1A.1–1A.7 completed')) {
    fail('plans/index.md: Phase 1A row must record Task 1A.1–1A.7 completed');
  }
  if (!cells[5]?.includes('`MS:1A-DONE` 已产生')) {
    fail('plans/index.md: Phase 1A row must record MS:1A-DONE production');
  }
  if (
    !cells[5]?.includes('../execution/completed/2026-07-30-agent-production-local-data-privacy.md')
  ) {
    fail('plans/index.md: Phase 1A row must link the completion record');
  }
}

const phase1ExecutionPlanIndexRow = plansIndex
  .split('\n')
  .find((line) =>
    line.startsWith(
      '| [`2026-07-29-agent-production-execution-isolation.md`](2026-07-29-agent-production-execution-isolation.md) |',
    ),
  );
if (
  !phase1ExecutionPlanIndexRow?.includes('Task 1B.0–1B.5 completed') ||
  !phase1ExecutionPlanIndexRow.includes('1B.6–1B.9 本地实现/定向验证收敛') ||
  !phase1ExecutionPlanIndexRow.includes('保持 `in_progress`，等待最终整体 Review') ||
  !phase1ExecutionPlanIndexRow.includes('1B.9 另等默认分支三平台 artifact') ||
  !phase1ExecutionPlanIndexRow.includes(
    '../execution/completed/2026-08-01-agent-production-protected-path.md',
  )
) {
  fail('plans/index.md: Phase 1B row must record current local convergence and pending gates');
}

const phase1FailureConformanceBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 1C.5 |'));
if (!phase1FailureConformanceBinding) {
  fail('1C.5: missing failure-mode conformance execution binding');
} else {
  if (!phase1FailureConformanceBinding.includes(`| \`${phase1FailureConformanceBaseline}\` |`)) {
    fail('1C.5: binding must use the reviewed Phase 1A closure baseline');
  }
  if (!phase1FailureConformanceBinding.includes('| `completed` |')) {
    fail('1C.5: failure-mode conformance binding must be completed');
  }
  const cells = parsePipeRow(phase1FailureConformanceBinding);
  if (cells[6]?.replaceAll('`', '') !== phase1RuntimeCompletionPath) {
    fail(`1C.5: completionRecordPath must be ${phase1RuntimeCompletionPath}`);
  }
}
if (
  !phase1RuntimePlan.includes(`Task 1C.5 已由\n\`${phase1FailureConformanceCommit}\` 实现`) ||
  !phase1RuntimePlan.includes(
    `\`${phase1FailureConformanceQualification}\` 的全绿 Required qualification 完成`,
  )
) {
  fail('1C.5: runtime plan must record implementation and qualification completion');
}
const phase1RuntimePlanIndexRow = plansIndex
  .split('\n')
  .find((line) =>
    line.startsWith(
      '| [`2026-07-29-agent-production-runtime-resilience.md`](2026-07-29-agent-production-runtime-resilience.md) |',
    ),
  );
if (
  !phase1RuntimePlanIndexRow?.includes('Task 1C.1–1C.8 completed') ||
  !phase1RuntimePlanIndexRow.includes('`MS:1C-DONE` 已产生') ||
  !phase1RuntimePlanIndexRow.includes(
    '../execution/completed/2026-07-30-agent-production-runtime-resilience.md',
  )
) {
  fail('plans/index.md: Phase 1C row must record 1C.1–1C.8 completion, milestone, and record');
}
if (
  !/1C\.1–1C\.8 已完成/.test(roadmap) ||
  !/1B\.2\/1B\.3 的完成结论是\s+三平台候选均明确 `excluded`/.test(roadmap) ||
  !/1B\.0–1B\.5 与 1C\.1–1C\.8 已完成/.test(roadmap) ||
  !/1B\.6–1B\.8 已完成本地实现和\s+定向验证并保持 `in_progress`/.test(roadmap) ||
  !/1B\.9 已完成本地 negative\s+conformance，仍等待默认分支三平台 workflow artifact 与最终整体 Review/.test(
    roadmap,
  ) ||
  !/Task 1C\.8 唯一产生 `MS:1C-DONE`/.test(roadmap) ||
  !/该 milestone 不生成\s+production artifact/.test(roadmap)
) {
  fail(
    'roadmap must record current Phase 1B convergence and completed Phase 1C without a production artifact claim',
  );
}
const phase1FailureConformanceRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 15 |'));
if (phase1FailureConformanceRevision.length !== 1) {
  fail(
    `decision register must contain Revision 15 exactly once; found ${phase1FailureConformanceRevision.length}`,
  );
} else {
  for (const evidence of [
    '激活 1C.5 failure-mode conformance',
    phase1FailureConformanceBaseline,
    'Required run 30671609567',
    '五个 job 全部通过',
    '同 head 三个原生 workflow 全部通过',
  ]) {
    if (!phase1FailureConformanceRevision[0]?.includes(evidence)) {
      fail(`decision register Revision 15 must identify ${evidence}`);
    }
  }
}
requireReachableCommit(phase1FailureConformanceBaseline, '1C.5');

const phase1FailureConformanceCompletionRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 16 |'));
if (phase1FailureConformanceCompletionRevision.length !== 1) {
  fail(
    `decision register must contain Revision 16 exactly once; found ${phase1FailureConformanceCompletionRevision.length}`,
  );
} else {
  for (const evidence of [
    '完成 1C.5 failure-mode conformance',
    '激活 1C.7 soak/fault evidence',
    phase1FailureConformanceCommit,
    phase1FailureConformanceQualification,
    'Required run 30676359548',
    '五个 job 全部通过',
    '同 head 三个原生 workflow 全部通过',
    'P0/P1/P2 均为 0',
    '不产生 `MS:1C-DONE`',
    '保持 1C.8 pending',
  ]) {
    if (!phase1FailureConformanceCompletionRevision[0]?.includes(evidence)) {
      fail(`decision register Revision 16 must identify ${evidence}`);
    }
  }
}

for (const evidence of [
  phase1FailureConformanceCommit,
  phase1FailureConformanceQualification,
  'Required run 30676359548',
  'Task 1C.5 独立复核最终 GO，P0/P1/P2 均为 0',
  phase1RuntimeQualificationCommit,
  phase1RuntimeQualificationHardening,
  phase1RuntimeQualificationHead,
  `run ${phase1RuntimeQualificationRun}`,
  phase1RuntimeQualificationArtifact,
  phase1RuntimeQualificationArtifactId,
  phase1RuntimeQualificationDigest,
  '7 case、56/56 probe',
  '72 条 `actual_runtime_ledger` receipts',
  '`MS:1C-DONE` 已由 Task 1C.8 产生',
]) {
  if (!phase1RuntimeCompletion.includes(evidence)) {
    fail(`1C completion record must identify ${evidence}`);
  }
}
requireReachableCommit(phase1FailureConformanceCommit, '1C.5 implementation');
requireReachableCommit(phase1FailureConformanceQualification, '1C.5 qualification');

const phase1SoakBinding = decisionRegister.split('\n').find((line) => line.startsWith('| 1C.7 |'));
if (!phase1SoakBinding) {
  fail('1C.7: missing soak/fault evidence execution binding');
} else {
  if (!phase1SoakBinding.includes(`| \`${phase1FailureConformanceQualification}\` |`)) {
    fail('1C.7: binding must use the completed 1C.5 qualification head');
  }
  if (!phase1SoakBinding.includes('| `completed` |')) {
    fail('1C.7: soak/fault evidence binding must be completed');
  }
  const cells = parsePipeRow(phase1SoakBinding);
  if (cells[6]?.replaceAll('`', '') !== phase1RuntimeCompletionPath) {
    fail(`1C.7: completionRecordPath must be ${phase1RuntimeCompletionPath}`);
  }
}
if (
  !phase1RuntimePlan.includes(
    'Task 1C.7 的 runner、workflow、report/verifier 与 Ubuntu 稳定性加固已由',
  )
) {
  fail('1C.7: runtime plan must record formal qualification completion');
}
const phase1RuntimeClosureBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 1C.8 |'));
if (!phase1RuntimeClosureBinding) {
  fail('1C.8: missing completed documentation closure execution binding');
} else {
  if (!phase1RuntimeClosureBinding.includes(`| \`${phase1RuntimeQualificationHead}\` |`)) {
    fail('1C.8: binding must use the formal default-branch qualification head');
  }
  if (!phase1RuntimeClosureBinding.includes('| `completed` |')) {
    fail('1C.8: documentation closure binding must be completed');
  }
  const cells = parsePipeRow(phase1RuntimeClosureBinding);
  if (cells[6]?.replaceAll('`', '') !== phase1RuntimeCompletionPath) {
    fail(`1C.8: completionRecordPath must be ${phase1RuntimeCompletionPath}`);
  }
}
const phase1RuntimeAcceptance =
  phase1RuntimePlan.match(/^## 验收条件\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
const checkedPhase1RuntimeAcceptance = phase1RuntimeAcceptance.match(/^- \[x\] /gm) ?? [];
if (checkedPhase1RuntimeAcceptance.length !== 15 || /^- \[ \] /m.test(phase1RuntimeAcceptance)) {
  fail(
    '1C: completed plan must retain all 15 checked acceptance criteria and no unchecked criteria',
  );
}

const phase1RuntimeClosureRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 19 |'));
if (phase1RuntimeClosureRevision.length !== 1) {
  fail(
    `decision register must contain Revision 19 exactly once; found ${phase1RuntimeClosureRevision.length}`,
  );
} else {
  for (const evidence of [
    '完成 1C.7 正式 Ubuntu qualification 与 1C.8 文档/迁移收口',
    '唯一产生 `MS:1C-DONE`',
    '不生成 production artifact',
    phase1RuntimeQualificationHead,
    `run ${phase1RuntimeQualificationRun}`,
    'attempt 1',
    phase1RuntimeQualificationArtifact,
    phase1RuntimeQualificationArtifactId,
    phase1RuntimeQualificationDigest,
    '7 case/56 probe/72 actual Runtime ledger receipts',
    '独立 verifier 通过',
  ]) {
    if (!phase1RuntimeClosureRevision[0]?.includes(evidence)) {
      fail(`decision register Revision 19 must identify ${evidence}`);
    }
  }
}
requireReachableCommit(phase1RuntimeQualificationCommit, '1C.7 qualification implementation');
requireReachableCommit(phase1RuntimeQualificationHardening, '1C.7 qualification hardening');
requireReachableCommit(phase1RuntimeQualificationHead, '1C.7 formal qualification head');

for (const [description, pattern] of [
  ['Phase 1A completion', /Phase 1A（Task 1A\.1–1A\.7）已完成/],
  ['unique MS:1A-DONE producer', /唯一产生 `MS:1A-DONE`/],
  ['no qualified route or artifact', /不产生 production-qualified route 或\s+production artifact/],
  ['empty ProviderDataPolicy bundle', /ProviderDataPolicy approved bundle 仍为空/],
  ['empty D-14 MCP route set', /D-14 批准的 MCP\s+route 集合也为空/],
] as const) {
  if (!pattern.test(roadmap)) {
    fail(`roadmap must preserve Phase 1A closure: ${description}`);
  }
}
if (
  !new RegExp(`^当前执行复核基线：\`${phase1RuntimeQualificationHead}\`（2026-08-02）$`, 'm').test(
    roadmap,
  )
) {
  fail(
    'roadmap must bind the current execution review baseline to the Phase 1C qualification head',
  );
}

const phase1PrivacyRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 14 |'));
if (phase1PrivacyRevision.length !== 1) {
  fail(
    `decision register must contain Revision 14 exactly once; found ${phase1PrivacyRevision.length}`,
  );
} else {
  for (const evidence of [
    '完成 1A.7 文档与迁移总收敛；唯一产生 `MS:1A-DONE`',
    phase1PrivacyClosureEvidenceCommit,
    'Required run 30670346726',
    '../execution/completed/2026-07-30-agent-production-local-data-privacy.md',
    '独立复核最终 GO 且无 P0/P1/P2',
  ]) {
    if (!phase1PrivacyRevision[0]?.includes(evidence)) {
      fail(`decision register Revision 14 must identify ${evidence}`);
    }
  }
}

const phase1CompletionRecords = [
  resolve(
    root,
    'docs',
    'space',
    'execution',
    'completed',
    '2026-07-30-agent-production-local-data-privacy.md',
  ),
  resolve(
    root,
    'docs',
    'space',
    'execution',
    'completed',
    '2026-07-30-agent-production-runtime-resilience.md',
  ),
];
for (const completionPath of phase1CompletionRecords) {
  const completion = readFileSync(completionPath, 'utf8');
  if (!/^状态：completed$/m.test(completion)) {
    fail(`${relative(root, completionPath)} must be completed`);
  }
  if (!completion.includes(phase1AdmissionCommit)) {
    fail(`${relative(root, completionPath)} must identify the admission/taxonomy implementation`);
  }
  if (!completion.includes(phase1OperationalCommit)) {
    fail(`${relative(root, completionPath)} must identify the operational implementation`);
  }
  if (!completion.includes(phase1CompositionCommit)) {
    fail(
      `${relative(root, completionPath)} must identify the composition/stability implementation`,
    );
  }
}

const phase1IsolationCompletionPath = resolve(
  root,
  'docs',
  'space',
  'execution',
  'completed',
  '2026-07-31-agent-production-execution-isolation-spike.md',
);
const phase1IsolationCompletion = readFileSync(phase1IsolationCompletionPath, 'utf8');
if (!/^状态：completed$/m.test(phase1IsolationCompletion)) {
  fail(`${relative(root, phase1IsolationCompletionPath)} must be completed`);
}
for (const evidence of ['30579701659', 'ADR-0061', 'D-04']) {
  if (!phase1IsolationCompletion.includes(evidence)) {
    fail(`${relative(root, phase1IsolationCompletionPath)} must identify ${evidence}`);
  }
}

const phase1BoundaryCompletionPath = resolve(
  root,
  'docs',
  'space',
  'execution',
  'completed',
  '2026-07-31-agent-production-execution-boundary.md',
);
const phase1BoundaryCompletion = readFileSync(phase1BoundaryCompletionPath, 'utf8');
if (!/^状态：completed$/m.test(phase1BoundaryCompletion)) {
  fail(`${relative(root, phase1BoundaryCompletionPath)} must be completed`);
}
for (const evidence of [phase1BoundaryCommit, 'accepted_empty_support_set']) {
  if (!phase1BoundaryCompletion.includes(evidence)) {
    fail(`${relative(root, phase1BoundaryCompletionPath)} must identify ${evidence}`);
  }
}
for (const heading of [
  'Gate 决策',
  '实际 commit / artifact',
  '验证命令与结果',
  '未运行项',
  '风险与限制',
  '与计划偏差',
  'Active 文档与 ADR 收敛',
]) {
  if (!new RegExp(`^## ${heading}$`, 'm').test(phase1BoundaryCompletion)) {
    fail(`${relative(root, phase1BoundaryCompletionPath)} must include ## ${heading}`);
  }
}
if (!/最终 GO，未发现剩余\s*P0\/P1\/P2/.test(phase1BoundaryCompletion)) {
  fail(
    `${relative(root, phase1BoundaryCompletionPath)} must record final GO with no remaining P0/P1/P2`,
  );
}
if (!/没有未运行的 1B\.1 必需验证/.test(phase1BoundaryCompletion)) {
  fail(
    `${relative(root, phase1BoundaryCompletionPath)} must explicitly account for required unrun items`,
  );
}
for (const command of [
  'bun test tests/sandbox/execution-boundary.test.ts tests/config/features.test.ts',
  'bun run test:tui:system',
  'bun run test',
  'bun run check:docs-impact',
  'bun run check:docs',
  'bun run check:core-boundary',
  'bun run typecheck',
  'git diff --check',
]) {
  if (!phase1BoundaryCompletion.includes(`\`${command}\``)) {
    fail(`${relative(root, phase1BoundaryCompletionPath)} must record command: ${command}`);
  }
}
for (const commit of [
  'cd2bd8819c86f4585cdf45fd6c6d785152cdba98',
  'e4ed8a05106e3a49f110dbcc0066efa874d4c382',
  phase1BoundaryCommit,
]) {
  if (!phase1BoundaryCompletion.includes(commit)) {
    fail(`${relative(root, phase1BoundaryCompletionPath)} must identify evidence commit ${commit}`);
  }
  requireReachableCommit(commit, '1B.1');
}

const phase1SupportMatrix = JSON.parse(
  readFileSync(join(root, 'release', 'platform-capabilities', 'support-matrix-v1.json'), 'utf8'),
) as {
  version?: unknown;
  decisionId?: unknown;
  status?: unknown;
  selectedNetworkMode?: unknown;
  productionSupportedPlatforms?: unknown;
  targets?: unknown;
};
if (
  phase1SupportMatrix.version !== 1 ||
  phase1SupportMatrix.decisionId !== 'D-04' ||
  phase1SupportMatrix.status !== 'accepted_empty_support_set' ||
  phase1SupportMatrix.selectedNetworkMode !== 'off' ||
  !Array.isArray(phase1SupportMatrix.productionSupportedPlatforms) ||
  phase1SupportMatrix.productionSupportedPlatforms.length !== 0
) {
  fail('D-04 support matrix must retain the accepted empty production support set');
}
const phase1SupportTargets = Array.isArray(phase1SupportMatrix.targets)
  ? phase1SupportMatrix.targets
  : [];
const expectedExcludedRunners = new Set(['macos-15', 'ubuntu-24.04', 'windows-2025']);
const actualExcludedRunners = phase1SupportTargets.flatMap((target) => {
  if (
    typeof target !== 'object' ||
    target === null ||
    typeof (target as { runner?: unknown }).runner !== 'string' ||
    (target as { currentOutcome?: unknown }).currentOutcome !== 'excluded'
  ) {
    return [];
  }
  return [(target as { runner: string }).runner];
});
if (
  phase1SupportTargets.length !== expectedExcludedRunners.size ||
  actualExcludedRunners.length !== expectedExcludedRunners.size ||
  new Set(actualExcludedRunners).size !== expectedExcludedRunners.size ||
  actualExcludedRunners.some((runner) => !expectedExcludedRunners.has(runner))
) {
  fail('D-04 support matrix must retain exactly three explicitly excluded candidate runners');
}

const phase1ApprovedRegistry = loadApprovedProductionExecutionQualificationRegistryV1();
if (
  phase1ApprovedRegistry.decisionId !== 'D-04' ||
  phase1ApprovedRegistry.status !== 'accepted_empty_support_set' ||
  phase1ApprovedRegistry.selectedNetworkMode !== 'off' ||
  phase1ApprovedRegistry.qualifications.length !== 0
) {
  fail('D-04 approved qualification registry must retain its pinned empty qualification set');
}

const phase1PlatformExclusionCompletion = readFileSync(
  join(root, phase1PlatformExclusionCompletionPath),
  'utf8',
);
if (!/^状态：completed$/m.test(phase1PlatformExclusionCompletion)) {
  fail(`${phase1PlatformExclusionCompletionPath} must be completed`);
}
for (const evidence of [
  phase1PlatformExclusionCommit,
  'accepted_empty_support_set',
  'Platform Capability Probe run 30693651821',
  'Required run 30693651834',
  'sha256:439b29a506a43d8ff684a289a0ee083fffff2ac08849798a2082299f78029590',
  'sha256:88e9de9a7480dc27bd651a477d5befd2ca3b3bdb1413b30b8d07cfdf24dcf176',
  'sha256:7dfd1390fae758ac64d74476231e53dd4f5233bef6a5e8832fc324dcb6a82f7d',
  '不产生 `MS:1B-DONE`',
]) {
  if (!phase1PlatformExclusionCompletion.includes(evidence)) {
    fail(`${phase1PlatformExclusionCompletionPath} must identify ${evidence}`);
  }
}
const normalizedPlatformExclusionCompletion = phase1PlatformExclusionCompletion.replace(
  /\s+/g,
  ' ',
);
for (const artifact of [
  {
    name: 'platform-capability-macos-15',
    id: '8816525761',
    digest: 'sha256:439b29a506a43d8ff684a289a0ee083fffff2ac08849798a2082299f78029590',
  },
  {
    name: 'platform-capability-ubuntu-24.04',
    id: '8816527325',
    digest: 'sha256:88e9de9a7480dc27bd651a477d5befd2ca3b3bdb1413b30b8d07cfdf24dcf176',
  },
  {
    name: 'platform-capability-windows-2025',
    id: '8816532433',
    digest: 'sha256:7dfd1390fae758ac64d74476231e53dd4f5233bef6a5e8832fc324dcb6a82f7d',
  },
]) {
  const mapping = `artifact \`${artifact.name}\`，artifact id \`${artifact.id}\`，evidence digest \`${artifact.digest}\``;
  if (!normalizedPlatformExclusionCompletion.includes(mapping)) {
    fail(
      `${phase1PlatformExclusionCompletionPath} must bind ${artifact.name} to its id and digest`,
    );
  }
}
const milestoneMentions = [...phase1PlatformExclusionCompletion.matchAll(/`MS:1B-DONE`/g)].length;
const negativeMilestoneMentions = [
  ...phase1PlatformExclusionCompletion.matchAll(/不产生 `MS:1B-DONE`/g),
].length;
if (milestoneMentions !== 1 || negativeMilestoneMentions !== 1) {
  fail(`${phase1PlatformExclusionCompletionPath} must only mention MS:1B-DONE as not produced`);
}
if (
  /productionSupported\s*[:=]\s*true/.test(phase1PlatformExclusionCompletion) ||
  phase1PlatformExclusionCompletion.includes('accepted_non_empty_support_set')
) {
  fail(`${phase1PlatformExclusionCompletionPath} must not claim positive production qualification`);
}
for (const heading of [
  'Gate 决策',
  '实际 commit / artifact',
  'Task 1B.2 结论：macOS',
  'Task 1B.3 结论：Linux/Windows',
  '验证命令与结果',
  '未运行项',
  '风险、限制与 rollback',
  '与计划偏差',
  'Active 文档与 ADR 收敛',
]) {
  if (!new RegExp(`^## ${heading}$`, 'm').test(phase1PlatformExclusionCompletion)) {
    fail(`${phase1PlatformExclusionCompletionPath} must include ## ${heading}`);
  }
}
if (!/两路独立复核最终均为 GO，P0\/P1\/P2 各为 0/.test(phase1PlatformExclusionCompletion)) {
  fail(`${phase1PlatformExclusionCompletionPath} must record final GO with no P0/P1/P2`);
}
requireReachableCommit(phase1PlatformExclusionCommit, '1B.2/1B.3 implementation');

const phase1PlatformExclusionRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 17 |'));
if (phase1PlatformExclusionRevision.length !== 1) {
  fail(
    `decision register must contain Revision 17 exactly once; found ${phase1PlatformExclusionRevision.length}`,
  );
} else {
  for (const evidence of [
    '负向完成 1B.2/1B.3',
    '激活 1B.5',
    phase1PlatformExclusionCommit,
    'Platform Capability Probe run 30693651821',
    'Required run 30693651834',
    '六个 job 全部通过',
    '../execution/completed/2026-08-01-agent-production-platform-exclusions.md',
    '无剩余 P0/P1/P2',
    '不产生 `MS:1B-DONE`',
  ]) {
    if (!phase1PlatformExclusionRevision[0]?.includes(evidence)) {
      fail(`decision register Revision 17 must identify ${evidence}`);
    }
  }
}

const phase1ProtectedPathCompletion = readFileSync(
  join(root, phase1ProtectedPathCompletionPath),
  'utf8',
);
if (!/^状态：completed$/m.test(phase1ProtectedPathCompletion)) {
  fail(`${phase1ProtectedPathCompletionPath} must be completed`);
}
for (const evidence of [
  phase1PlatformExclusionCommit,
  phase1ProtectedPathInitialCommit,
  phase1ProtectedPathCommit,
  phase1ProtectedPathSeatbeltCommit,
  phase1ProtectedPathQualification,
  'accepted_empty_support_set',
  'Required run 30705493952',
  'Platform Capability Probe run 30705493919',
  'artifact id `8820200695`',
  'sha256:6bc8332393bd10da97170cc4d314d66e21e0f005b751da16cd9a649361ee2559',
  'sha256:48a304768ae04b501c8609f3ee3f7e5b1de7ad9cbd7c71a4fe733c654d2bcde3',
]) {
  if (!phase1ProtectedPathCompletion.includes(evidence)) {
    fail(`${phase1ProtectedPathCompletionPath} must identify ${evidence}`);
  }
}
for (const heading of [
  'Gate 决策',
  '实际 commit / artifact',
  '结论',
  '验证命令与结果',
  '未运行项',
  '风险与限制',
  '与计划偏差',
  'Active 文档与 ADR 收敛',
]) {
  if (!new RegExp(`^## ${heading}$`, 'm').test(phase1ProtectedPathCompletion)) {
    fail(`${phase1ProtectedPathCompletionPath} must include ## ${heading}`);
  }
}
for (const command of [
  'bun test tests/policies/protected-path.test.ts tests/sandbox.test.ts tests/sandbox-executor.test.ts tests/subagent-runner.test.ts tests/mcp-manager.test.ts',
  'bun test tests/tool-definitions.test.ts tests/tools.test.ts tests/shell-exec.test.ts',
  'bun run test:tui:harness',
  'CI=true bun run scripts/run-tui-system-tests.ts long-message input compact-persistence',
  'bun run typecheck',
  'bun run check:core-boundary',
  'bun run check:docs-impact',
  'bun run check:docs',
  'git diff --check',
]) {
  if (!phase1ProtectedPathCompletion.includes(`\`${command}\``)) {
    fail(`${phase1ProtectedPathCompletionPath} must record command: ${command}`);
  }
}
if (!/最终独立只读复核结论为 GO，P0\/P1\/P2 均为 0/.test(phase1ProtectedPathCompletion)) {
  fail(`${phase1ProtectedPathCompletionPath} must record final GO with no P0/P1/P2`);
}
if (
  /productionSupported\s*[:=]\s*true/.test(phase1ProtectedPathCompletion) ||
  phase1ProtectedPathCompletion.includes('accepted_non_empty_support_set')
) {
  fail(`${phase1ProtectedPathCompletionPath} must not claim positive production qualification`);
}
const protectedPathMilestoneMentions = [...phase1ProtectedPathCompletion.matchAll(/`MS:1B-DONE`/g)]
  .length;
const protectedPathNegativeMilestoneMentions = [
  ...phase1ProtectedPathCompletion.matchAll(/不产生\s+`MS:1B-DONE`/g),
].length;
if (protectedPathMilestoneMentions !== 1 || protectedPathNegativeMilestoneMentions !== 1) {
  fail(`${phase1ProtectedPathCompletionPath} must only mention MS:1B-DONE as not produced`);
}
if (
  !phase1ExecutionPlan.includes(
    `Task 1B.5 已以 \`${phase1ProtectedPathQualification}\` 的全绿 Required/Platform`,
  ) ||
  !phase1ExecutionPlan.includes(
    '[Task 1B.5 完成记录](../execution/completed/2026-08-01-agent-production-protected-path.md)',
  )
) {
  fail('1B.5: execution-isolation plan must record completion and completion record');
}
if (!phase1ExecutionPlan.includes('- [ ] protected path 在所有本地执行路径统一生效；')) {
  fail('1B: phase-level all-local-paths acceptance must remain open until later Tasks complete');
}
if (!roadmap.includes(`当前执行复核基线：\`${phase1RuntimeQualificationHead}\``)) {
  fail('roadmap must advance the reviewed execution baseline to the Phase 1C qualification head');
}
const phase1ProtectedPathRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 18 |'));
if (phase1ProtectedPathRevision.length !== 1) {
  fail(
    `decision register must contain Revision 18 exactly once; found ${phase1ProtectedPathRevision.length}`,
  );
} else {
  for (const evidence of [
    '完成 1B.5 shared protected-path policy',
    '1B.6/1B.8 变为 ready 但保持未绑定',
    phase1ProtectedPathInitialCommit,
    phase1ProtectedPathCommit,
    phase1ProtectedPathQualification,
    'Required run 30705493952',
    '六个 job 全部通过',
    'Platform Capability Probe run 30705493919',
    '三平台全绿',
    '../execution/completed/2026-08-01-agent-production-protected-path.md',
    '无剩余 P0/P1/P2',
    '不产生 `MS:1B-DONE`',
  ]) {
    if (!phase1ProtectedPathRevision[0]?.includes(evidence)) {
      fail(`decision register Revision 18 must identify ${evidence}`);
    }
  }
}

const phase1ExecutionFoundationRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 20 |'));
if (phase1ExecutionFoundationRevision.length !== 1) {
  fail(
    `decision register must contain Revision 20 exactly once; found ${phase1ExecutionFoundationRevision.length}`,
  );
} else {
  for (const evidence of [
    '激活 1B.6–1B.8',
    '保持 `in_progress`',
    phase1RuntimeQualificationHead,
    'worktree controller 14 pass',
    'MCP/边界组合 84 pass',
    'status/config/CLI 22 pass',
    'TUI sandbox-mode 2 pass',
    'D-09 foreground Headless CLI writer 保持只读',
    'local stdio 与无 App receipt controller 的 production TUI 保持关闭',
    '不产生 `MS:1B-DONE`',
  ]) {
    if (!phase1ExecutionFoundationRevision[0]?.includes(evidence)) {
      fail(`decision register Revision 20 must identify ${evidence}`);
    }
  }
}
for (const checkedCriterion of [
  '- [x] 后台/并发/委派 writer 强制 worktree；',
  '- [x] worktree 创建失败不触碰共享 checkout；',
  '- [x] TUI/CLI 显示实际边界；',
]) {
  if (!phase1ExecutionPlan.includes(checkedCriterion)) {
    fail(`1B: locally converged acceptance criterion missing: ${checkedCriterion}`);
  }
}
for (const pendingCriterion of [
  '- [ ] allowlist 无 DNS/redirect/child bypass；',
  '- [ ] local stdio/remote HTTP MCP transport 使用同一有效 boundary revision；',
]) {
  if (!phase1ExecutionPlan.includes(pendingCriterion)) {
    fail(`1B: conformance-dependent criterion must remain open: ${pendingCriterion}`);
  }
}
for (const commit of [
  phase1ProtectedPathInitialCommit,
  phase1ProtectedPathCommit,
  phase1ProtectedPathSeatbeltCommit,
  phase1ProtectedPathQualification,
]) {
  requireReachableCommit(commit, '1B.5');
}

const phase1NetworkCompletionPath = resolve(
  root,
  'docs',
  'space',
  'execution',
  'completed',
  '2026-08-01-agent-production-network-boundary.md',
);
const phase1NetworkCompletion = readFileSync(phase1NetworkCompletionPath, 'utf8');
if (!/^状态：completed$/m.test(phase1NetworkCompletion)) {
  fail(`${relative(root, phase1NetworkCompletionPath)} must be completed`);
}
for (const evidence of [
  phase1NetworkCommit,
  phase1NetworkReviewBaseline,
  'accepted_empty_support_set',
]) {
  if (!phase1NetworkCompletion.includes(evidence)) {
    fail(`${relative(root, phase1NetworkCompletionPath)} must identify ${evidence}`);
  }
}
for (const heading of [
  'Gate 决策',
  '实际 commit / artifact',
  '验证命令与结果',
  '未运行项',
  '风险与限制',
  '与计划偏差',
  'Active 文档与 ADR 收敛',
]) {
  if (!new RegExp(`^## ${heading}$`, 'm').test(phase1NetworkCompletion)) {
    fail(`${relative(root, phase1NetworkCompletionPath)} must include ## ${heading}`);
  }
}
if (!/最终 GO，无剩余\s*P0\/P1\/P2/.test(phase1NetworkCompletion)) {
  fail(
    `${relative(root, phase1NetworkCompletionPath)} must record final GO with no remaining P0/P1/P2`,
  );
}
for (const command of [
  'bun test tests/sandbox/network-boundary.test.ts tests/sandbox/network-boundary-concurrency.test.ts',
  'bun run test:tui:system',
  'bun run test',
  'bun run check:docs-impact',
  'bun run check:docs',
  'bun run check:core-boundary',
  'bun run typecheck',
  'git diff --check',
]) {
  if (!phase1NetworkCompletion.includes(`\`${command}\``)) {
    fail(`${relative(root, phase1NetworkCompletionPath)} must record command: ${command}`);
  }
}
for (const commit of [phase1NetworkCommit, phase1NetworkReviewBaseline]) {
  requireReachableCommit(commit, '1B.4');
}

const phase1AdmissionCompletionPath = phase1CompletionRecords[0]!;
const phase1AdmissionCompletion = readFileSync(phase1AdmissionCompletionPath, 'utf8');
if (!phase1AdmissionCompletion.includes(phase1RemoteMcpCommit)) {
  fail(
    `${relative(root, phase1AdmissionCompletionPath)} must identify the remote MCP egress implementation`,
  );
}
if (!/^## Task 1A\.6$/m.test(phase1AdmissionCompletion)) {
  fail(`${relative(root, phase1AdmissionCompletionPath)} must include ## Task 1A.6`);
}
if (!/第五轮最终 GO，无剩余 P0\/P1\/P2/.test(phase1AdmissionCompletion)) {
  fail(`${relative(root, phase1AdmissionCompletionPath)} must record final 1A.6 independent GO`);
}
requireReachableCommit(phase1RemoteMcpCommit, '1A.6');
if (!/^## Task 1A\.7$/m.test(phase1AdmissionCompletion)) {
  fail(`${relative(root, phase1AdmissionCompletionPath)} must include ## Task 1A.7`);
}
for (const evidence of [
  phase1PrivacyClosureEvidenceCommit,
  '30670346726',
  '唯一产生 `MS:1A-DONE`',
  '2179 pass/7 skip/0 fail',
  '5 个 harness 文件和 36 个 scenario',
  'RSS 44→44 MiB、active 0→0、fd 12→12',
]) {
  if (!phase1AdmissionCompletion.includes(evidence)) {
    fail(`${relative(root, phase1AdmissionCompletionPath)} must identify ${evidence}`);
  }
}
for (const [description, pattern] of [
  [
    'empty ProviderDataPolicy bundle and zero model routes',
    /ProviderDataPolicy approved bundle 的 `policies=\[\]`，所以 production-qualified model\s+route 为 0/,
  ],
  [
    'D-14 zero MCP routes without an independent revision',
    /D-14 同时冻结空的 model\/MCP route 集合，且仓库没有独立批准的 remote MCP\s+route revision，所以 production-qualified MCP route 也为 0/,
  ],
  [
    'internal-only milestone',
    /`MS:1A-DONE` 只表示 Phase 1A 实现与文档收敛，不表示存在可发布 route/,
  ],
  [
    'no qualified route from empty Provider and MCP sets',
    /ProviderDataPolicy approved bundle 与 D-14 MCP route 集合都为空，因此本记录不产生\s+production-qualified route/,
  ],
  [
    'no release artifact, external qualification, or signing',
    /不产生 production\s+artifact、external qualification 或 Release\/Security 签署/,
  ],
] as const) {
  if (!pattern.test(phase1AdmissionCompletion)) {
    fail(
      `${relative(root, phase1AdmissionCompletionPath)} must preserve Phase 1A limitation: ${description}`,
    );
  }
}
if (
  !/- 1A\.7 独立只读复核：[^\n]*(?:\n {2}[^\n]*)*最终 GO 且无 P0\/P1\/P2/.test(
    phase1AdmissionCompletion,
  )
) {
  fail(`${relative(root, phase1AdmissionCompletionPath)} must record final 1A.7 independent GO`);
}
requireReachableCommit(phase1PrivacyClosureEvidenceCommit, '1A.7');

const releaseFoundationCommit = '2e98681c800a2f1f745bc18e41ac682d9c09e84b';
const releaseFoundationBaseline = 'd07d6d01f822e7afa95f1c98bd90f8780c6ca1d0';
const releaseFoundationCompletionPath =
  'docs/space/execution/completed/2026-07-30-agent-production-release-control.md';
const releaseFoundationCompletion = readFileSync(
  join(root, releaseFoundationCompletionPath),
  'utf8',
);
const releasePlan = sources.get('2A') ?? '';
const d06Body = decisionSections.find((match) => match[1] === 'D-06')?.[2] ?? '';
const adr0062 = readFileSync(
  join(root, 'docs/adr/0062-keyless-release-signing-and-github-hosting.md'),
  'utf8',
);

if (!/^- status: `closed`$/m.test(d06Body) || !/^- approvedAt: `2026-08-02`$/m.test(d06Body)) {
  fail('D-06: Release Foundation completion requires the approved closed decision');
}
if (!/^状态：accepted$/m.test(adr0062)) {
  fail('ADR-0062: keyless release signing and GitHub hosting decision must be accepted');
}

for (let task = 0; task <= 7; task += 1) {
  const taskId = `2A.${task}`;
  const bindingRow = decisionRegister.split('\n').find((line) => line.startsWith(`| ${taskId} |`));
  if (!bindingRow) {
    fail(`${taskId}: missing Release Foundation execution binding`);
    continue;
  }
  const cells = parsePipeRow(bindingRow);
  if (cells[2]?.replaceAll('`', '') !== releaseFoundationBaseline) {
    fail(`${taskId}: binding must preserve the Release Foundation activation baseline`);
  }
  if (cells[4]?.replaceAll('`', '') !== 'completed') {
    fail(`${taskId}: Release Foundation binding must be completed after MS:2A-F`);
  }
  if (cells[5]?.replaceAll('`', '') !== '—') {
    fail(`${taskId}: completed Release Foundation binding must have no blocked reason`);
  }
  if (cells[6]?.replaceAll('`', '') !== releaseFoundationCompletionPath) {
    fail(`${taskId}: completionRecordPath must be ${releaseFoundationCompletionPath}`);
  }
  if (
    !new RegExp(`^## Task ${taskId.replace('.', '\\.')}(?:[:：]|$)`, 'm').test(
      releaseFoundationCompletion,
    )
  ) {
    fail(`${releaseFoundationCompletionPath} must include ## Task ${taskId}`);
  }
}

for (const evidence of [
  '状态：completed',
  `实现提交：\`${releaseFoundationCommit}\``,
  '结论：`approved_to_complete_2A.0–2A.7`',
  '唯一产生 `MS:2A-F`',
  '53 pass、0 fail、401 expect',
  'sha256:24c58f186316d11dbd17889776bf1ff040d80333ba3ee3915746d8032d09c7f0',
  'sha256:406882b0be2a5814ae3cf13cd72971f6873d11d981ed3d0ac3b956a85d24be35',
  'sha256:ca24e4cebceacb0832078cefff5028fa0d5083251fe0c19d66abc3d8dca4ac23',
  'G2–G5 均为 `not_applicable`',
  '真实 signing/release disabled',
  '所有 production capability 仍 off/excluded',
]) {
  if (!releaseFoundationCompletion.includes(evidence)) {
    fail(`${releaseFoundationCompletionPath} must identify ${evidence}`);
  }
}
for (const command of [
  'bun run typecheck',
  'bun test tests/release',
  'bun run release:build',
  'bun run release:verify',
  'bun run release:smoke',
  'bun run release:gate:foundation',
  'bun run release:smoke:execution',
  'bun run check:core-boundary',
  'bun run check:docs-impact',
  'bun run check:docs',
  'git diff --check',
]) {
  if (!releaseFoundationCompletion.includes(`\`${command}\``)) {
    fail(`${releaseFoundationCompletionPath} must record command: ${command}`);
  }
}

if (
  !releasePlan.includes(`\`${releaseFoundationCommit}\` 收口`) ||
  !releasePlan.includes('Task 2A.7 唯一产生\n`MS:2A-F`') ||
  !releasePlan.includes(releaseFoundationCompletionPath.replace('docs/space/', '../'))
) {
  fail('Phase 2A plan must record Release Foundation completion, milestone, and completion record');
}
const releasePlanIndexRow = plansIndex
  .split('\n')
  .find((line) =>
    line.startsWith(
      '| [`2026-07-29-agent-production-release-control.md`](2026-07-29-agent-production-release-control.md) |',
    ),
  );
if (
  !releasePlanIndexRow?.includes('2A.0–2A.7 completed') ||
  !releasePlanIndexRow.includes('`MS:2A-F` 已产生') ||
  !releasePlanIndexRow.includes(
    '../execution/completed/2026-07-30-agent-production-release-control.md',
  ) ||
  !releasePlanIndexRow.includes('真实 release disabled')
) {
  fail('plans/index.md: Phase 2A row must record Foundation completion and release limitations');
}
if (
  !roadmap.includes(releaseFoundationCommit) ||
  !/Task 2A\.7\s+唯一产生 `MS:2A-F`/.test(roadmap) ||
  !/不包含 G2–G5、真实 signing\/attestation、production platform、RC\s+或 external release 结论/.test(
    roadmap,
  )
) {
  fail('roadmap must record MS:2A-F without a production release claim');
}
const releaseFoundationRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 23 |'));
if (
  releaseFoundationRevision.length !== 1 ||
  !releaseFoundationRevision[0]?.includes(releaseFoundationCommit) ||
  !releaseFoundationRevision[0]?.includes('Task 2A.7 唯一产生 `MS:2A-F`') ||
  !releaseFoundationRevision[0]?.includes('真实 signing/release disabled')
) {
  fail('decision register must contain the exact Revision 23 Release Foundation ratchet');
}

const releaseSupplyChainBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 2A.8 |'));
if (!releaseSupplyChainBinding) {
  fail('2A.8: local supply-chain contract must have an execution binding');
} else {
  const cells = parsePipeRow(releaseSupplyChainBinding);
  if (cells[2]?.replaceAll('`', '') !== releaseFoundationCommit) {
    fail('2A.8: binding must use the completed Release Foundation baseline');
  }
  if (cells[4]?.replaceAll('`', '') !== 'in_progress') {
    fail('2A.8: binding must remain in_progress until real supply-chain/platform evidence exists');
  }
  if (cells[6]?.replaceAll('`', '') !== '—') {
    fail('2A.8: completionRecordPath must remain empty before real evidence');
  }
}

const evaluationPlan = sources.get('2B') ?? '';
const operationsPlan = sources.get('3') ?? '';
for (const [label, source, expected] of [
  ['2B', evaluationPlan, '状态：active'],
  ['3', operationsPlan, '状态：active'],
] as const) {
  if (!source.includes(expected)) fail(`${label}: local contract plan must be active`);
}
for (const evidence of [
  'D-07 已按 single-maintainer-first 推荐方案关闭',
  'Evidence adapter 仍只有 `blocked/not_green`',
  '不产生 `MS:2B-DONE`',
]) {
  if (!evaluationPlan.includes(evidence))
    fail(`2B local-contract boundary must identify ${evidence}`);
}
for (const evidence of ['2B 正式证据依赖', 'D-03', '`MS:3-OPS-READY`', '`MS:LIMITED-SLO`']) {
  if (!operationsPlan.includes(evidence))
    fail(`Phase 3 local-contract boundary must identify ${evidence}`);
}
const localContractRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 24 |'));
if (
  localContractRevision.length !== 1 ||
  !localContractRevision[0]?.includes('本地 fail-closed contract') ||
  !localContractRevision[0]?.includes('D-03/D-07 open') ||
  !localContractRevision[0]?.includes(
    'formal platform/adversarial/human/incident/SLO/signing evidence 均未伪造',
  )
) {
  fail('decision register must contain exact Revision 24 local-contract/evidence-waiting ratchet');
}

const d10 = decisionSections.find((match) => match[1] === 'D-10')?.[2] ?? '';
for (const expected of [
  '- status: `closed`',
  'none|read',
  'write、destructive、unknown',
  'dependency/revision drift',
  '[ADR-0064]',
  '- approvedAt: `2026-08-02`',
]) {
  if (!d10.includes(expected))
    fail(`D-10 conservative classifier decision must contain ${expected}`);
}

const phase5Plan = sources.get('5') ?? '';
for (const expected of [
  '状态：active',
  'schema/conformance/evidence adapter 已提前实现',
  '`under_development/off`',
  '不产生任何',
]) {
  if (!phase5Plan.includes(expected))
    fail(`Phase 5 local-contract boundary must contain ${expected}`);
}

const capabilityProfileBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 5.1 |'));
if (!capabilityProfileBinding) {
  fail('5.1: dependency-ready Capability Profile contract must have an execution binding');
} else {
  const cells = parsePipeRow(capabilityProfileBinding);
  if (cells[2]?.replaceAll('`', '') !== releaseFoundationCommit) {
    fail('5.1: binding must use the completed Release Foundation baseline');
  }
  if (cells[4]?.replaceAll('`', '') !== 'in_progress') {
    fail('5.1: binding must remain in_progress until final whole-diff review');
  }
  if (!cells[5]?.includes('所有 capability 仍 off')) {
    fail('5.1: binding must preserve the all-capabilities-off boundary');
  }
  if (cells[6]?.replaceAll('`', '') !== '—') {
    fail('5.1: completionRecordPath must remain empty before final whole-diff review');
  }
}

const laterLocalContractRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 25 |'));
if (
  laterLocalContractRevision.length !== 1 ||
  !laterLocalContractRevision[0]?.includes('关闭 D-10') ||
  !laterLocalContractRevision[0]?.includes('Phase 4/5/6 本地 fail-closed contract') ||
  !laterLocalContractRevision[0]?.includes('5.1 绑定 `in_progress`') ||
  !laterLocalContractRevision[0]?.includes(
    'formal task/live/canary/maturity/GA/第三方评审 evidence 均未产生',
  )
) {
  fail('decision register must contain exact Revision 25 Phase 4/5/6 evidence boundary ratchet');
}

const d07 = decisionSections.find((match) => match[1] === 'D-07')?.[2] ?? '';
for (const expected of [
  '- status: `closed`',
  '12 个 case',
  '4 simple/6 medium/2 complex',
  '3 read-only/9 workspace-write',
  '4 TUI/8 Headless CLI',
  '运行 8 次',
  '运行 20 次',
  '总成功率至少 90%',
  '每个 case 至少 80%',
  '只算 internal',
  '至少 3 名不同的 opt-in 用户',
  '回归上限为 25%',
  '- approvedAt: `2026-08-02`',
]) {
  if (!d07.includes(expected)) fail(`D-07 approved product scope must contain ${expected}`);
}

const evaluationScopeBinding = decisionRegister
  .split('\n')
  .find((line) => line.startsWith('| 2B.1 |'));
if (!evaluationScopeBinding) {
  fail('2B.1: approved D-07 scope must have an execution binding');
} else {
  const cells = parsePipeRow(evaluationScopeBinding);
  if (cells[2]?.replaceAll('`', '') !== '494858769bfb8436d721e1d0d8cd0426454a601d') {
    fail('2B.1: binding must use the D-07 approval recovery-point baseline');
  }
  if (cells[4]?.replaceAll('`', '') !== 'in_progress') {
    fail('2B.1: binding must remain in_progress until targeted validation and whole-diff review');
  }
  if (!cells[5]?.includes('12-case suite')) {
    fail('2B.1: binding must identify the approved 12-case suite contract');
  }
  if (cells[6]?.replaceAll('`', '') !== '—') {
    fail('2B.1: completionRecordPath must remain empty before completion');
  }
}

const evaluationScopeRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 26 |'));
if (
  evaluationScopeRevision.length !== 1 ||
  !evaluationScopeRevision[0]?.includes('关闭 D-07') ||
  !evaluationScopeRevision[0]?.includes('激活 2B.1') ||
  !evaluationScopeRevision[0]?.includes('非确定性 PR=禁止/route-change=8/RC=20、确定性=1') ||
  !evaluationScopeRevision[0]?.includes('维护者 dogfood 仅 internal') ||
  !evaluationScopeRevision[0]?.includes('第三方安全评审边界不变')
) {
  fail('decision register must contain exact Revision 26 D-07 approval ratchet');
}
const wholeReviewRepairRevision = decisionRegister
  .split('\n')
  .filter((line) => line.startsWith('| 27 |'));
if (
  wholeReviewRepairRevision.length !== 1 ||
  !wholeReviewRepairRevision[0]?.includes('首轮整体 Review 为 NO-GO') ||
  !wholeReviewRepairRevision[0]?.includes('第三方评审 Gate') ||
  !wholeReviewRepairRevision[0]?.includes('Limited SLO') ||
  !wholeReviewRepairRevision[0]?.includes('GA/Auto') ||
  !wholeReviewRepairRevision[0]?.includes('worktree handoff/Git 环境') ||
  !wholeReviewRepairRevision[0]?.includes('evidenceEligible=false') ||
  !wholeReviewRepairRevision[0]?.includes('等待两路最终 GO')
) {
  fail('decision register must contain exact Revision 27 whole-review repair ratchet');
}
requireReachableCommit(releaseFoundationCommit, '2A.0–2A.7');

if (failures.length > 0) {
  console.error('Plan execution matrix checks failed:');
  for (const message of failures) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log(
    `Plan execution matrix checks passed (${plans.length} plans, ${rows.length} tasks, 14 decisions).`,
  );
}
