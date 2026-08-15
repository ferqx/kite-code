import { z } from 'zod';
import { isGitRevisionV1 } from '@/core/git/broker';
import { GIT_INSPECT_CONTRACT } from '@/core/tools/tool-contracts';
import type { GitBrokerResultV1 } from '@/protocol/git';
import { defineExecutableTool } from '../spec';

const boundedPath = z.string().min(1).max(512);
const timeout = z.number().int().min(100).max(60_000).optional();

const outputBound = z.number().int().min(1).max(262_144).optional();
const recordBound = z.number().int().min(1).max(200).optional();
const paths = z.array(boundedPath).min(1).max(128);

export const gitInspectInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('status'),
      paths: paths.optional(),
      max_records: recordBound,
      max_output_bytes: outputBound,
      timeout_ms: timeout,
    })
    .strict(),
  z
    .object({
      operation: z.literal('diff'),
      paths,
      max_output_bytes: outputBound,
      timeout_ms: timeout,
    })
    .strict(),
  z
    .object({
      operation: z.literal('log'),
      paths,
      revision: z.string().min(1).max(128).refine(isGitRevisionV1).optional(),
      max_records: recordBound,
      max_output_bytes: outputBound,
      timeout_ms: timeout,
    })
    .strict(),
  z
    .object({
      operation: z.literal('branch_list'),
      max_records: recordBound,
      max_output_bytes: outputBound,
      timeout_ms: timeout,
    })
    .strict(),
]);

function available(context: {
  featureFlags?: { brokeredGitV1?: boolean };
  hasGitBroker?: boolean;
  brokeredGitFeatureRevision?: string | null;
}) {
  return (
    context.featureFlags?.brokeredGitV1 === true &&
    context.hasGitBroker === true &&
    context.brokeredGitFeatureRevision === 'brokered-git-r1'
  );
}

function projection(output: GitBrokerResultV1) {
  return {
    ok: output.ok,
    modelContent: JSON.stringify({
      ok: output.ok,
      output: output.output,
      ...(output.failureCode ? { failure_code: output.failureCode } : {}),
      ...(output.nextCapability ? { next_capability: output.nextCapability } : {}),
      ...(output.receipt ? { receipt: output.receipt } : {}),
    }),
    resultMeta: {
      ...(output.failureCode ? { gitFailureCode: output.failureCode } : {}),
      ...(output.nextCapability ? { nextCapability: output.nextCapability } : {}),
      ...(output.receipt
        ? {
            invocationId: output.receipt.invocationId,
            capabilityRevision: output.receipt.featureRevision,
            gitReceipt: output.receipt,
          }
        : {}),
    },
    ...(output.failureCode === 'timed_out'
      ? { terminationReason: 'timed_out' as const }
      : output.failureCode === 'cancelled'
        ? { terminationReason: 'cancelled' as const }
        : {}),
  };
}

const DETAIL_BY_FAILURE = {
  sandbox_capability_missing: 'sandbox_capability_missing',
  protected_path_denied: 'protected_path_denied',
  git_operation_unsupported: 'git_operation_unsupported',
  managed_network_setup_required: 'managed_network_setup_required',
  repository_invalid: 'repository_invalid',
  repository_hostile: 'repository_hostile',
  binary_untrusted: 'binary_untrusted',
  lock: 'repository_lock',
  cancelled: 'cancelled_by_user',
  timed_out: 'timed_out',
  process_failed: 'tool_reported_failure',
  receipt_invalid: 'receipt_invalid',
} as const satisfies Record<
  import('@/protocol/git').GitBrokerFailureCodeV1,
  import('@/core/runtime/tool-outcome').ToolOutcomeDetailCodeV1
>;

function classify(output: GitBrokerResultV1) {
  if (output.ok || !output.failureCode) return {};
  return {
    detailCode: DETAIL_BY_FAILURE[output.failureCode],
    disposition: 'never' as const,
    maximumAdditionalCalls: 0 as const,
    safeAutomaticRetry: false,
    ...(output.nextCapability ? { capabilityIntent: output.nextCapability } : {}),
  };
}

export const gitInspectSpec = defineExecutableTool({
  name: 'git_inspect',
  kind: 'computer',
  contract: GIT_INSPECT_CONTRACT.sections,
  inputSchema: gitInspectInputSchema,
  availability: available,
  governanceRevision: 'git-inspect-v1',
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'Typed Git inspect is read-only and broker-bound.',
  }),
  execute: async (request, context) => {
    if (!context.gitBroker) {
      return {
        ok: false,
        output: 'Typed Git inspect broker is unavailable.',
        failureCode: 'sandbox_capability_missing',
      } satisfies GitBrokerResultV1;
    }
    switch (request.operation) {
      case 'status':
        return context.gitBroker.inspect(
          {
            operation: 'status',
            paths: request.paths,
            maxRecords: request.max_records,
            maxOutputBytes: request.max_output_bytes,
            timeoutMs: request.timeout_ms,
          },
          context.signal,
        );
      case 'diff':
        return context.gitBroker.inspect(
          {
            operation: 'diff',
            paths: request.paths,
            maxOutputBytes: request.max_output_bytes,
            timeoutMs: request.timeout_ms,
          },
          context.signal,
        );
      case 'log':
        return context.gitBroker.inspect(
          {
            operation: 'log',
            paths: request.paths,
            revision: request.revision,
            maxRecords: request.max_records,
            maxOutputBytes: request.max_output_bytes,
            timeoutMs: request.timeout_ms,
          },
          context.signal,
        );
      case 'branch_list':
        return context.gitBroker.inspect(
          {
            operation: 'branch_list',
            maxRecords: request.max_records,
            maxOutputBytes: request.max_output_bytes,
            timeoutMs: request.timeout_ms,
          },
          context.signal,
        );
    }
  },
  projectResult: projection,
  classifyOutcomeV1: classify,
});
