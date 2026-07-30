import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
const expectedPlanStates = new Map([
  ['2026-07-29-agent-production-readiness-roadmap.md', 'active'],
  ['2026-07-29-agent-production-governance-decisions.md', 'archived'],
  ['2026-07-29-agent-production-local-data-privacy.md', 'active'],
  ['2026-07-29-agent-production-runtime-resilience.md', 'active'],
]);
for (const [file, expectedState] of expectedPlanStates) {
  const source = readFileSync(join(planDir, file), 'utf8');
  if (!new RegExp(`^状态：${expectedState}$`, 'm').test(source)) {
    fail(`${file}: expected lifecycle state ${expectedState} after MS:M0`);
  }
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

if (failures.length > 0) {
  console.error('Plan execution matrix checks failed:');
  for (const message of failures) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log(
    `Plan execution matrix checks passed (${plans.length} plans, ${rows.length} tasks, 14 decisions).`,
  );
}
