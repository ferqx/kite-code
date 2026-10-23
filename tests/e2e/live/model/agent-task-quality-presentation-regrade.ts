import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { runAgentTaskQualityTrial } from './agent-task-quality.live';
import { createTaskQualityResearchFixture } from './agent-task-quality-fixture';
import {
  comparisonDigest,
  comparisonWorkspaceManifest,
  presentationComparisonPlan,
} from './agent-task-quality-presentation-ab-fixture';

/** Reuse the live grader with original requests and copied Stores; no Model execution. */
export async function regradeTaskQualityPresentation(evidenceRoot: string, outputRoot?: string) {
  if (!isAbsolute(evidenceRoot)) throw Error('absolute_original_evidence_root_required');
  const root = realpathSync(evidenceRoot);
  const plan = JSON.parse(readFileSync(join(root, 'fixed-plan.json'), 'utf8'));
  if (comparisonDigest(plan.trials) !== comparisonDigest(presentationComparisonPlan))
    throw Error('regrade_fixed_plan_mismatch');
  const output = outputRoot ? resolve(outputRoot) : join(root, 'regrade');
  if (dirname(output) !== root || !basename(output).startsWith('regrade'))
    throw Error('regrade_output_must_be_new_owned_evidence_child');
  mkdirSync(output, { mode: 0o700 });
  mkdirSync(join(output, 'trials'));
  mkdirSync(join(output, 'copied-stores'));
  const originalTop = {
    plan: readFileSync(join(root, 'fixed-plan.json'), 'utf8'),
    summary: readFileSync(join(root, 'summary.json'), 'utf8'),
  };
  const originalTrees = new Map<string, string>();
  for (const [index, [scenario, trial, variant]] of presentationComparisonPlan.entries()) {
    const id = `${String(index + 1).padStart(2, '0')}-${scenario}-${trial}-${variant}`;
    const original = join(root, 'trials', id);
    originalTrees.set(original, comparisonWorkspaceManifest(original).sha256);
  }
  for (const pair of plan.pairs) {
    const manifest = comparisonWorkspaceManifest(pair.workspace);
    if (manifest.sha256 !== pair.manifest.sha256) throw Error('regrade_original_workspace_changed');
    originalTrees.set(pair.workspace, manifest.sha256);
  }
  const results = [];
  let failure: string | undefined;
  try {
    for (const [index, [scenario, trial, variant]] of presentationComparisonPlan.entries()) {
      const id = `${String(index + 1).padStart(2, '0')}-${scenario}-${trial}-${variant}`;
      const original = join(root, 'trials', id);
      const pair = plan.pairs.find((pair: { id: string }) => pair.id === `${scenario}-${trial}`);
      if (!pair) throw Error('regrade_pair_missing');
      const channel = readFileSync(
        join(pair.workspace, 'packages/runtime-core/channel.ts'),
        'utf8',
      );
      const match = /^export const channel = 'route-runtime-core-([a-f0-9-]+)';\n$/.exec(channel);
      if (!match) throw Error('regrade_original_nonce_unavailable');
      const research = createTaskQualityResearchFixture({ trial, nonce: match[1]! });
      for (const [path, content] of Object.entries(research.files))
        if (readFileSync(join(pair.workspace, path), 'utf8') !== content)
          throw Error(`regrade_synthetic_file_mismatch:${path}`);
      const dataRoot = join(output, 'copied-stores', id, 'data');
      cpSync(join(original, 'data'), dataRoot, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      console.log(JSON.stringify({ event: 'offline_regrade_start', id }));
      const result = await runAgentTaskQualityTrial({
        scenario,
        trial,
        evidenceRoot: join(output, 'trials', id),
        offlineReplay: { originalEvidenceRoot: original, dataRoot },
        isolatedComparison: { variant, workspace: pair.workspace, research },
      });
      results.push({
        id,
        originalEvidenceRoot: original,
        originalTreeSha256: originalTrees.get(original),
        result,
      });
      console.log(
        JSON.stringify({
          event: 'offline_regrade_end',
          id,
          status: result.status,
          failure: result.failure,
          qualitySignals: result.qualitySignals,
        }),
      );
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const originalsUnchanged =
    originalTop.plan === readFileSync(join(root, 'fixed-plan.json'), 'utf8') &&
    originalTop.summary === readFileSync(join(root, 'summary.json'), 'utf8') &&
    [...originalTrees].every(([path, hash]) => comparisonWorkspaceManifest(path).sha256 === hash);
  if (!originalsUnchanged) failure ??= 'regrade_original_evidence_changed';
  const summary = {
    executionMode: 'offline_original_evidence_regrade',
    providerCalls: 0,
    status:
      failure ||
      results.length !== 8 ||
      results.some(({ result }) => result.status !== 'assertions_passed')
        ? 'failed'
        : 'assertions_passed',
    manualReviewRequired: true,
    plannedTrials: 8,
    completedTrials: results.length,
    originalsUnchanged,
    failure,
    results,
  };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  return summary;
}

if (import.meta.main) {
  const root = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--evidence-root='))
    ?.slice('--evidence-root='.length);
  if (!root) throw Error('absolute_original_evidence_root_required');
  const output = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--output='))
    ?.slice('--output='.length);
  const result = await regradeTaskQualityPresentation(root, output);
  if (result.status !== 'assertions_passed') process.exitCode = 1;
}
