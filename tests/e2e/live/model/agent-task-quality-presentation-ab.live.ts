import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { ModelRequest } from '@kite-ai/ai';
import { runAgentTaskQualityTrial } from './agent-task-quality.live';
import { createTaskQualityResearchFixture } from './agent-task-quality-fixture';
import {
  comparisonDigest,
  comparisonPairInvariant,
  comparisonStableJson,
  comparisonWireParameters,
  comparisonWireRequestMatches,
  comparisonWorkspaceManifest,
  presentationComparisonPlan,
} from './agent-task-quality-presentation-ab-fixture';

/** Eight precommitted synthetic trials. No configurable variant order or extra sampling. */
export async function runTaskQualityPresentationComparison(evidenceRoot: string) {
  if (process.env.KITE_RUN_LIVE_TASK_QUALITY !== '1')
    throw Error('requires_KITE_RUN_LIVE_TASK_QUALITY_1');
  if (!isAbsolute(evidenceRoot)) throw Error('new_absolute_evidence_root_required');
  mkdirSync(evidenceRoot, { mode: 0o700 });
  const root = realpathSync(evidenceRoot);
  mkdirSync(join(root, 'trials'));
  const pairs = new Map<
    string,
    {
      workspace: string;
      research: ReturnType<typeof createTaskQualityResearchFixture>;
      manifest: ReturnType<typeof comparisonWorkspaceManifest>;
      invariant?: ReturnType<typeof comparisonPairInvariant>;
    }
  >();
  for (const [scenario, trial] of presentationComparisonPlan) {
    const pairId = `${scenario}-${trial}`;
    if (pairs.has(pairId)) continue;
    const workspace = join(root, 'pairs', pairId, 'workspace');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const research = createTaskQualityResearchFixture({ trial, nonce: crypto.randomUUID() });
    for (const [path, content] of Object.entries(research.files)) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content);
    }
    pairs.set(pairId, { workspace, research, manifest: comparisonWorkspaceManifest(workspace) });
  }
  writeFileSync(
    join(root, 'fixed-plan.json'),
    JSON.stringify(
      {
        baseline: '495373291 raw format through isolated Runtime instance override',
        manualReviewRequired: true,
        trials: presentationComparisonPlan,
        pairs: [...pairs].map(([id, pair]) => ({
          id,
          workspace: pair.workspace,
          manifest: pair.manifest,
        })),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const results: unknown[] = [];
  let failure: string | undefined;
  let binding: string | undefined;
  let wireParameters: string | undefined;
  try {
    for (const [index, [scenario, trial, variant]] of presentationComparisonPlan.entries()) {
      const pair = pairs.get(`${scenario}-${trial}`)!;
      if (comparisonWorkspaceManifest(pair.workspace).sha256 !== pair.manifest.sha256)
        throw Error('comparison_workspace_changed_before_trial');
      const id = `${String(index + 1).padStart(2, '0')}-${scenario}-${trial}-${variant}`;
      let firstModel = true;
      const dispatchedRequests = new Map<string, ModelRequest>();
      let protocol: unknown;
      let preflightFailure: string | undefined;
      const reject = (reason: string): never => {
        preflightFailure = reason;
        throw Error(reason);
      };
      console.log(JSON.stringify({ event: 'comparison_trial_start', id }));
      const result = await runAgentTaskQualityTrial({
        scenario,
        trial,
        evidenceRoot: join(root, 'trials', id),
        isolatedComparison: {
          variant,
          workspace: pair.workspace,
          research: pair.research,
          beforeModelRequest(request, metadata) {
            dispatchedRequests.set(request.requestId, structuredClone(request));
            protocol = metadata.protocol;
            const fingerprint = comparisonDigest(metadata);
            if (binding && binding !== fingerprint)
              reject('comparison_model_binding_changed_before_dispatch');
            binding = fingerprint;
            if (
              firstModel &&
              pair.invariant &&
              comparisonStableJson({
                modelId: request.modelId,
                initialMessages: request.messages,
                tools: request.tools,
              }) !==
                comparisonStableJson({
                  modelId: pair.invariant.modelId,
                  initialMessages: pair.invariant.initialMessages,
                  tools: pair.invariant.tools,
                })
            )
              reject('comparison_pair_inputs_changed_before_dispatch');
            firstModel = false;
          },
          beforeWireRequest(entry) {
            const request = entry.requestId && dispatchedRequests.get(entry.requestId);
            if (!request || !comparisonWireRequestMatches(request, entry.body, protocol))
              reject('comparison_wire_body_does_not_match_sealed_model_input');
            const fingerprint = comparisonDigest(comparisonWireParameters(entry.body));
            if (wireParameters && wireParameters !== fingerprint)
              reject('comparison_wire_parameters_changed_before_dispatch');
            wireParameters = fingerprint;
            if (
              entry.physicalIndex === 0 &&
              pair.invariant &&
              comparisonStableJson(JSON.parse(entry.body)) !==
                comparisonStableJson(pair.invariant.initialWire)
            )
              reject('comparison_initial_wire_changed_before_dispatch');
          },
        },
      });
      results.push(result);
      console.log(
        JSON.stringify({
          event: 'comparison_trial_end',
          id,
          status: result.status,
          failure: result.failure,
        }),
      );
      if (comparisonWorkspaceManifest(pair.workspace).sha256 !== pair.manifest.sha256)
        throw Error('comparison_workspace_changed_after_trial');
      // A quality assertion failure is a prespecified observation, not grounds
      // to drop the other arm. Stop only when further comparison is invalid.
      if (preflightFailure) throw Error(preflightFailure);
      if (
        result.cleanupErrors.length ||
        result.evidenceErrors.length ||
        (result.canonical as { complete?: boolean } | undefined)?.complete !== true ||
        result.metrics.httpStatuses.some((status) => status === 0 || status >= 400)
      )
        throw Error(`comparison_infrastructure_failed:${id}`);
      const requests = JSON.parse(
        readFileSync(join(result.evidenceRoot, 'original-requests.json'), 'utf8'),
      ) as ModelRequest[];
      const wire = JSON.parse(
        readFileSync(join(result.evidenceRoot, 'wire-requests.json'), 'utf8'),
      ) as { body: string; requestId: string | null }[];
      if (wire.some((entry) => !requests.some((request) => request.requestId === entry.requestId)))
        throw Error('comparison_wire_request_unpaired');
      if (
        wire.some(
          (entry) =>
            !comparisonWireRequestMatches(
              requests.find((request) => request.requestId === entry.requestId)!,
              entry.body,
              result.comparison!.modelBinding.protocol,
            ),
        )
      )
        throw Error('comparison_saved_wire_body_does_not_match_model_input');
      const invariant = comparisonPairInvariant({
        binding: result.comparison!.modelBinding,
        firstRequest: requests[0]!,
        wire,
      });
      if (
        pair.invariant &&
        comparisonStableJson(pair.invariant) !== comparisonStableJson(invariant)
      )
        throw Error('comparison_pair_inputs_changed');
      pair.invariant = invariant;
      writeFileSync(
        join(result.evidenceRoot, 'pair-invariant.json'),
        JSON.stringify(
          {
            sha256: comparisonDigest(invariant),
            invariant,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const summary = {
    status:
      failure ||
      results.some((result) => (result as { status: string }).status !== 'assertions_passed')
        ? 'failed'
        : 'assertions_passed',
    manualReviewRequired: true,
    plannedTrials: 8,
    completedTrials: results.length,
    failure,
    results,
  };
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  return summary;
}

if (import.meta.main) {
  const root = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--evidence-root='))
    ?.slice('--evidence-root='.length);
  if (!root) throw Error('new_absolute_evidence_root_required');
  const result = await runTaskQualityPresentationComparison(root);
  if (result.status !== 'assertions_passed') process.exitCode = 1;
}
