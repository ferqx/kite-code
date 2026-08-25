import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const root = process.cwd();
const planDirectory = join(root, 'docs', 'space', 'plans');
const plans = [
  '2026-07-29-agent-production-governance-decisions.md',
  '2026-07-29-agent-production-local-data-privacy.md',
  '2026-07-29-agent-production-execution-isolation.md',
  '2026-07-29-agent-production-runtime-resilience.md',
  '2026-07-29-agent-production-release-control.md',
  '2026-07-29-agent-production-evaluation.md',
  '2026-07-29-agent-production-observability-operations.md',
  '2026-07-29-agent-production-compaction-qualification.md',
  '2026-07-29-agent-production-capability-rollout.md',
  '2026-07-29-agent-production-ga.md',
] as const;

const categorySchema = z
  .object({
    status: z.enum(['completed', 'superseded']),
    taskIds: z.array(z.string().min(1)),
  })
  .strict();
const registrySchema = z
  .object({
    schema: z.literal('OpenSourceFirstReleaseTaskStatusV2'),
    version: z.literal(2),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    authority: z.literal('ADR-0069'),
    categories: z
      .object({
        first_release_required: categorySchema,
        superseded: categorySchema,
      })
      .strict(),
    summary: z
      .object({
        total: z.number().int(),
        completed: z.number().int(),
        superseded: z.number().int(),
      })
      .strict(),
    unsupportedProductShapes: z.array(z.string().min(1)).min(1),
  })
  .strict();

const failures: string[] = [];
const allTaskIds: string[] = [];

for (const plan of plans) {
  const source = readFileSync(join(planDirectory, plan), 'utf8');
  if (!source.includes('状态：superseded'))
    failures.push(`${plan}: must remain a superseded historical plan`);
  if (!source.includes('ADR-0069')) failures.push(`${plan}: missing ADR-0069 terminal-scope note`);
  if (!source.includes('release/oss-first-release/task-status.json')) {
    failures.push(`${plan}: missing current Task status authority`);
  }
  const headingIds = [...source.matchAll(/^### Task ([^：:\n]+)[：:]/gm)].map((match) => match[1]);
  const matrixIds = extractMatrixTaskIds(source, plan);
  if ([...headingIds].sort().join('\0') !== [...matrixIds].sort().join('\0')) {
    failures.push(`${plan}: Task headings and execution matrix IDs differ`);
  }
  allTaskIds.push(...headingIds);
}

if (allTaskIds.length !== 108)
  failures.push(`expected 108 historical Task IDs, found ${allTaskIds.length}`);
if (new Set(allTaskIds).size !== allTaskIds.length)
  failures.push('historical Task IDs are not unique');

const registry = registrySchema.parse(
  JSON.parse(readFileSync(join(root, 'release', 'oss-first-release', 'task-status.json'), 'utf8')),
);
const categories = registry.categories;
if (categories.first_release_required.status !== 'completed') {
  failures.push('first_release_required must use completed status');
}
if (categories.superseded.status !== 'superseded') {
  failures.push('superseded category must use superseded status');
}

const classified = [...categories.first_release_required.taskIds, ...categories.superseded.taskIds];
const classifiedSet = new Set(classified);
const historicalSet = new Set(allTaskIds);
if (classified.length !== classifiedSet.size)
  failures.push('Task status registry repeats Task IDs');
for (const taskId of historicalSet) {
  if (!classifiedSet.has(taskId)) failures.push(`Task status registry is missing ${taskId}`);
}
for (const taskId of classifiedSet) {
  if (!historicalSet.has(taskId)) failures.push(`Task status registry has unknown Task ${taskId}`);
}

const computed = {
  total: classified.length,
  completed: categories.first_release_required.taskIds.length,
  superseded: categories.superseded.taskIds.length,
};
if (JSON.stringify(computed) !== JSON.stringify(registry.summary)) {
  failures.push(`Task summary does not match categories: ${JSON.stringify(computed)}`);
}
if (computed.total !== 108 || computed.completed !== 83 || computed.superseded !== 25) {
  failures.push(`unexpected first-release Task classification: ${JSON.stringify(computed)}`);
}

requireText('docs/adr/0069-first-release-terminal-scope.md', [
  '状态：accepted',
  'G0',
  'G1',
  '83 `completed`、25 `superseded`、0 optional',
]);
requireText('docs/active/open-source-first-release.md', [
  '状态：active',
  '读取时机：',
  '验证：',
  'ADR-0069',
  'G0',
  'G1',
  'release:build',
  'release:smoke',
  '83',
  '25',
  '0 optional',
]);
requireText('docs/space/plans/2026-07-29-agent-production-readiness-roadmap.md', [
  '状态：archived',
  'ADR-0069',
  '`completed` | 83',
  '`superseded` | 25',
  '0 optional',
  '2026-08-04-single-maintainer-open-source-first-release.md',
]);
requireText('docs/space/plans/README.md', [
  '2026-07-29-agent-production-readiness-roadmap.md` 已完成并归档',
]);
requireText('docs/space/plans/index.md', [
  '2026-07-29-agent-production-readiness-roadmap.md',
  '| archived | P0 | ADR-0069 |',
  '2026-08-04-single-maintainer-open-source-first-release.md',
]);
requireText('docs/space/index.md', ['[`plans/index.md`](plans/index.md)', '唯一全局注册表']);
requireText(
  'docs/space/execution/completed/2026-08-04-single-maintainer-open-source-first-release.md',
  ['状态：completed', '83 completed / 25 superseded / 0 optional', '30915426607', '30915426783'],
);
const maintainerChecklist = readFileSync(
  join(root, 'release', 'oss-first-release', 'MAINTAINER_CHECKLIST.md'),
  'utf8',
);
if (maintainerChecklist.includes('- [ ]')) {
  failures.push('first-release maintainer checklist still has unchecked items');
}
requireText('docs/space/plans/2026-07-29-agent-production-decision-register.md', [
  'ADR-0069',
  '| 45 | 2026-08-04 |',
  '83 completed、25 superseded、0 optional',
]);
requireText('docs/documentation-map.json', [
  'docs/active/open-source-first-release.md',
  'docs/adr/0069-first-release-terminal-scope.md',
]);

if (failures.length > 0) {
  console.error('Open-source first-release plan governance check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Open-source first-release plan governance passed: ${computed.completed} completed, ${computed.superseded} superseded, 0 optional.`,
  );
}

function extractMatrixTaskIds(source: string, plan: string): string[] {
  const lines = source.split('\n');
  const header = lines.findIndex((line) => /^\| Task \| dependsOn \|/.test(line));
  if (header < 0) {
    failures.push(`${plan}: missing Task execution matrix`);
    return [];
  }
  const taskIds: string[] = [];
  for (let index = header + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('|')) break;
    const taskId = line.split('|')[1]?.trim().replaceAll('`', '');
    if (taskId) taskIds.push(taskId);
  }
  return taskIds;
}

function requireText(path: string, snippets: readonly string[]): void {
  const source = readFileSync(join(root, path), 'utf8');
  for (const snippet of snippets) {
    if (!source.includes(snippet)) failures.push(`${path}: missing ${JSON.stringify(snippet)}`);
  }
}
