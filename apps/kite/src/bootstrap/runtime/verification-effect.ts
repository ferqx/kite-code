import {
  type CapabilityArtifactReaderV1,
  readBoundCapabilityArtifactV1,
} from '@kite/builtin-runtime';
import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import { assertInsideWorkspace, type ShellExecutor } from '@kite/builtin-runtime/sandbox';
import type { VerificationReviewerInput, VerificationReviewerResult } from '@kite/runtime-spi';
import { ProviderDataAdmissionError } from '#app/config/provider-data-admission';
import {
  BuiltinVerificationDispatchErrorV1,
  type BuiltinVerificationReceiptViewV1,
  executeDeterministicVerificationChecksV1,
} from '#builtin-runtime';
import type { RuntimeEffect, RuntimeEvent, RuntimeState } from './state-runtime';

export type VerificationReviewer = (
  input: VerificationReviewerInput,
) => Promise<VerificationReviewerResult>;

export interface VerificationExecutorDependencies {
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  artifactStore?: CapabilityArtifactReaderV1;
  reviewer?: VerificationReviewer;
  signal?: AbortSignal;
}

export async function executeVerificationEffect(
  effect: Extract<
    RuntimeEffect,
    { type: 'run_verification' | 'repair_verification' | 'run_verification_compensation' }
  >,
  state: Readonly<RuntimeState>,
  dependencies: VerificationExecutorDependencies = {},
): Promise<RuntimeEvent[]> {
  const record = state.verification.records[effect.verificationId];
  if (!record) return [];
  if (effect.type === 'repair_verification') {
    if (!['failed', 'inconclusive'].includes(record.status)) return [];
    const failures = Object.values(record.checkResults)
      .filter((result) => result.outcome !== 'passed')
      .map((result) => `${result.checkId}: ${result.summary}`)
      .join('\n');
    return [
      {
        type: 'verification.repair_requested',
        verificationId: record.verificationId,
        repairAttempt: record.repairAttempts + 1,
        instruction: [
          `Required verification failed for: ${record.spec.subject}`,
          failures || 'The verifier could not establish the required outcome.',
          'Repair the implementation or evidence, then produce a new final response. Do not waive verification.',
        ].join('\n\n'),
        requestedAt: new Date().toISOString(),
      },
    ];
  }
  if (effect.type === 'run_verification_compensation') {
    if (record.status !== 'compensating' || !record.spec.compensation) return [];
    const compensation = record.spec.compensation;
    if (!dependencies.shellExecutor) {
      return [
        {
          type: 'verification.compensation_completed',
          verificationId: record.verificationId,
          outcome: 'inconclusive',
          summary: 'A governed Shell executor is unavailable; compensation was not executed.',
          completedAt: new Date().toISOString(),
        },
      ];
    }
    const workspace = compensation.cwd
      ? assertInsideWorkspace(state.session.workspace, compensation.cwd)
      : state.session.workspace;
    const result = await dependencies.shellExecutor({
      workspace,
      command: compensation.command,
      timeoutMs: compensation.timeoutMs,
      signal: dependencies.signal,
      networkMode: 'disabled',
    });
    return [
      {
        type: 'verification.compensation_completed',
        verificationId: record.verificationId,
        outcome: result.exitCode === 0 ? 'passed' : 'failed',
        summary:
          result.exitCode === 0
            ? 'Compensation completed successfully.'
            : `Compensation exited with code ${result.exitCode}: ${result.stderr}`.slice(0, 2_000),
        completedAt: new Date().toISOString(),
      },
    ];
  }
  if (!['pending', 'running', 'repair_pending'].includes(record.status)) return [];

  const events: RuntimeEvent[] = [
    {
      type: 'verification.started',
      verificationId: record.verificationId,
      attempt: record.attempts + 1,
      startedAt: new Date().toISOString(),
    },
  ];
  try {
    const execution = await executeDeterministicVerificationChecksV1({
      checks: record.spec.checks,
      state: {
        workspace: state.session.workspace,
        receipts: state.capabilities.invocations,
        skillOutputs: collectSkillOutputsV1(state),
      },
      dependencies: {
        ...(dependencies.shellExecutor
          ? {
              shell: {
                execute: async (input) => {
                  const result = await dependencies.shellExecutor!({
                    workspace: input.workspace,
                    command: input.command,
                    timeoutMs: input.timeoutMs,
                    signal: input.signal,
                    networkMode: 'disabled',
                  });
                  return {
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                  };
                },
              },
            }
          : {}),
        ...(dependencies.mcpManager ? { mcp: dependencies.mcpManager } : {}),
        ...(dependencies.artifactStore
          ? {
              readArtifact: (receipt: BuiltinVerificationReceiptViewV1) => {
                const source = state.capabilities.invocations[receipt.invocationId];
                if (!source?.artifact || !source.resultDigest || !source.evidenceDigest) {
                  throw new Error('A bound capability Artifact is unavailable.');
                }
                return readBoundCapabilityArtifactV1(dependencies.artifactStore!, source.artifact, {
                  invocationId: source.invocationId,
                  resultDigest: source.resultDigest,
                  evidenceDigest: source.evidenceDigest,
                  ...(source.filesystemObservation
                    ? { filesystemObservation: source.filesystemObservation }
                    : {}),
                });
              },
            }
          : {}),
        ...(dependencies.reviewer ? { reviewer: dependencies.reviewer } : {}),
        isFatalError: (error) => error instanceof ProviderDataAdmissionError,
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      },
    });
    for (const result of execution.results) {
      events.push({
        type: 'verification.check_completed',
        verificationId: record.verificationId,
        result,
      });
    }
    events.push({
      type: 'verification.completed',
      verificationId: record.verificationId,
      outcome: execution.outcome,
      completedAt: new Date().toISOString(),
    });
    return events;
  } catch (error) {
    if (!(error instanceof BuiltinVerificationDispatchErrorV1)) throw error;
    const cause = error.causeValue;
    if (cause instanceof ProviderDataAdmissionError && error.externalEffectsMayHaveOccurred) {
      throw new ProviderDataAdmissionError(cause.decision, { knownExternalEffects: 'unknown' });
    }
    throw cause;
  }
}

function collectSkillOutputsV1(
  state: Readonly<RuntimeState>,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const outputs: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [activationId, frame] of Object.entries(state.skills.frames)) {
    if (frame.output) outputs[activationId] = frame.output;
  }
  return outputs;
}
