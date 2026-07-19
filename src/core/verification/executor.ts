import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { digestCapability } from '@/core/capabilities/catalog';
import { validateCapabilityArguments } from '@/core/capabilities/schema';
import type { McpRuntimeProvider } from '@/core/mcp';
import {
  type CapabilityArtifactStore,
  defaultCapabilityArtifactStore,
} from '@/core/persistence/capability-artifacts';
import type { RuntimeEffect } from '@/core/runtime/effects';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import { assertInsideWorkspace, type ShellExecutor } from '@/core/tools/shell';
import type {
  VerificationCheck,
  VerificationCheckResult,
  VerificationOutcome,
  VerificationReviewerInput,
  VerificationReviewerResult,
} from '@/protocol/verification';
import { requiresVerification } from './policy';

export type VerificationReviewer = (
  input: VerificationReviewerInput,
) => Promise<VerificationReviewerResult>;

export interface VerificationExecutorDependencies {
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  artifactStore?: CapabilityArtifactStore;
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

  const startedAt = new Date().toISOString();
  const events: RuntimeEvent[] = [
    {
      type: 'verification.started',
      verificationId: record.verificationId,
      attempt: record.attempts + 1,
      startedAt,
    },
  ];
  const results: VerificationCheckResult[] = [];
  for (const check of record.spec.checks) {
    const result = await executeCheck(check, state, dependencies);
    results.push(result);
    events.push({
      type: 'verification.check_completed',
      verificationId: record.verificationId,
      result,
    });
  }
  const outcome = aggregateOutcome(results);
  events.push({
    type: 'verification.completed',
    verificationId: record.verificationId,
    outcome,
    completedAt: new Date().toISOString(),
  });
  return events;
}

async function executeCheck(
  check: VerificationCheck,
  state: Readonly<RuntimeState>,
  dependencies: VerificationExecutorDependencies,
): Promise<VerificationCheckResult> {
  const startedAt = new Date().toISOString();
  try {
    const observation = await observeCheck(check, state, dependencies);
    return {
      checkId: check.checkId,
      outcome: observation.outcome,
      summary: observation.summary.slice(0, 2_000),
      evidenceDigest: digestCapability(observation.evidence),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      checkId: check.checkId,
      outcome: 'inconclusive',
      summary: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

async function observeCheck(
  check: VerificationCheck,
  state: Readonly<RuntimeState>,
  dependencies: VerificationExecutorDependencies,
): Promise<{ outcome: VerificationOutcome; summary: string; evidence: unknown }> {
  if (check.type === 'file_assertion') {
    const path = assertInsideWorkspace(state.session.workspace, check.path);
    const exists = existsSync(path);
    if (check.assertion === 'exists') {
      return {
        outcome: exists ? 'passed' : 'failed',
        summary: exists ? `${check.path} exists.` : `${check.path} does not exist.`,
        evidence: { path: resolve(path), exists },
      };
    }
    if (check.assertion === 'not_exists') {
      return {
        outcome: exists ? 'failed' : 'passed',
        summary: exists ? `${check.path} still exists.` : `${check.path} does not exist.`,
        evidence: { path: resolve(path), exists },
      };
    }
    if (!exists) {
      return { outcome: 'failed', summary: `${check.path} does not exist.`, evidence: { exists } };
    }
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    return {
      outcome: digest === check.expectedDigest ? 'passed' : 'failed',
      summary:
        digest === check.expectedDigest
          ? `${check.path} matches the expected digest.`
          : `${check.path} digest does not match.`,
      evidence: { path: resolve(path), digest },
    };
  }
  if (check.type === 'command') {
    if (!dependencies.shellExecutor) {
      return {
        outcome: 'inconclusive',
        summary: 'A governed Shell executor is unavailable; the command was not executed.',
        evidence: null,
      };
    }
    const workspace = check.cwd
      ? assertInsideWorkspace(state.session.workspace, check.cwd)
      : state.session.workspace;
    const result = await dependencies.shellExecutor({
      workspace,
      command: check.command,
      timeoutMs: check.timeoutMs,
      signal: dependencies.signal,
      networkMode: 'disabled',
    });
    const expected = check.expectedExitCode ?? 0;
    return {
      outcome: result.exitCode === expected ? 'passed' : 'failed',
      summary:
        result.exitCode === expected
          ? `Command exited with expected code ${expected}.`
          : `Command exited with code ${result.exitCode}; expected ${expected}. ${result.stderr}`,
      evidence: {
        command: check.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  }
  if (check.type === 'schema') {
    const value = resolveSchemaSubject(check.subject, state, dependencies.artifactStore);
    if (value === undefined) {
      return { outcome: 'inconclusive', summary: 'Schema subject is unavailable.', evidence: null };
    }
    const error = validateCapabilityArguments(check.schema, value as Record<string, unknown>);
    return {
      outcome: error ? 'failed' : 'passed',
      summary: error ?? 'Value matches the required schema.',
      evidence: value,
    };
  }
  if (check.type === 'mcp_read_after_write') {
    const receipt = state.capabilities.invocations[check.invocationId];
    if (receipt?.status !== 'succeeded') {
      return {
        outcome: 'inconclusive',
        summary: 'Source invocation receipt is unavailable.',
        evidence: receipt,
      };
    }
    const descriptor = dependencies.mcpManager?.findCapability(check.capabilityId);
    if (
      !descriptor ||
      descriptor.revision !== check.capabilityRevision ||
      descriptor.availability !== 'available'
    ) {
      return {
        outcome: 'inconclusive',
        summary: 'Read-after-write capability changed or is unavailable.',
        evidence: descriptor,
      };
    }
    if (requiresVerification(descriptor.effectiveEffects)) {
      return {
        outcome: 'inconclusive',
        summary: 'Read-after-write verification requires a read-only capability.',
        evidence: descriptor.effectiveEffects,
      };
    }
    if (!dependencies.mcpManager) {
      return {
        outcome: 'inconclusive',
        summary: 'MCP read-after-write provider is unavailable.',
        evidence: null,
      };
    }
    const result = await dependencies.mcpManager.callCapability({
      capabilityId: check.capabilityId,
      expectedRevision: check.capabilityRevision,
      arguments: check.arguments,
    });
    const value = (result as { structuredContent?: unknown }).structuredContent ?? result;
    const schemaError = check.outputSchema
      ? validateCapabilityArguments(check.outputSchema, value as Record<string, unknown>)
      : null;
    return {
      outcome: schemaError ? 'failed' : 'passed',
      summary: schemaError ?? 'Read-after-write completed against the bound capability revision.',
      evidence: result,
    };
  }
  if (check.type === 'external_reference') {
    const receipt = state.capabilities.invocations[check.invocationId];
    const references = receipt?.externalReferences ?? [];
    const matched = check.uri ? references.includes(check.uri) : references.length > 0;
    return {
      outcome: receipt?.status !== 'succeeded' ? 'inconclusive' : matched ? 'passed' : 'failed',
      summary:
        receipt?.status !== 'succeeded'
          ? 'Successful source receipt is unavailable.'
          : matched
            ? 'The expected external reference is present in the source receipt.'
            : 'The source receipt does not contain the expected external reference.',
      evidence: { receipt, references },
    };
  }

  if (!dependencies.reviewer) {
    return {
      outcome: 'inconclusive',
      summary: 'Independent reviewer is unavailable.',
      evidence: null,
    };
  }
  const input = reviewerInput(check, state, dependencies.artifactStore);
  const result = await dependencies.reviewer(input);
  return { ...result, evidence: input };
}

function resolveSchemaSubject(
  subject: Extract<VerificationCheck, { type: 'schema' }>['subject'],
  state: Readonly<RuntimeState>,
  artifactStore = defaultCapabilityArtifactStore,
): unknown {
  if (subject.kind === 'literal') return subject.value;
  if (subject.kind === 'skill_output') return state.skills.frames[subject.activationId]?.output;
  const receipt = state.capabilities.invocations[subject.invocationId];
  return receipt?.artifact ? artifactStore.read(receipt.artifact).structuredContent : undefined;
}

function reviewerInput(
  check: Extract<VerificationCheck, { type: 'reviewer' }>,
  state: Readonly<RuntimeState>,
  artifactStore = defaultCapabilityArtifactStore,
): VerificationReviewerInput {
  const receipts = (check.invocationIds ?? [])
    .map((id) => state.capabilities.invocations[id])
    .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt));
  const artifacts = receipts.flatMap((receipt) => {
    if (!receipt.artifact) return [];
    try {
      return [{ invocationId: receipt.invocationId, result: artifactStore.read(receipt.artifact) }];
    } catch {
      return [];
    }
  });
  const skillOutputs = (check.activationIds ?? []).flatMap((activationId) => {
    const output = state.skills.frames[activationId]?.output;
    return output ? [{ activationId, output }] : [];
  });
  return { instructions: check.instructions, receipts, artifacts, skillOutputs };
}

function aggregateOutcome(results: VerificationCheckResult[]): VerificationOutcome {
  if (results.some((result) => result.outcome === 'failed')) return 'failed';
  if (results.some((result) => result.outcome === 'inconclusive')) return 'inconclusive';
  return 'passed';
}
