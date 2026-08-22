import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  VerificationCapabilityResultV1,
  VerificationCheck,
  VerificationCheckResult,
  VerificationExecutionReceiptV1,
  VerificationOutcome,
  VerificationReviewerInput,
  VerificationReviewerResult,
} from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from '../capability-binding';
import { validateCapabilityArgumentsV1 } from '../skills/capability-domain';

export interface BuiltinVerificationReceiptViewV1 extends VerificationExecutionReceiptV1 {
  readonly resultDigest?: string;
  readonly evidenceDigest?: string;
  readonly artifact?: unknown;
  readonly filesystemObservation?: unknown;
  readonly externalReferences?: readonly string[];
}

export interface BuiltinVerificationStateViewV1 {
  readonly workspace: string;
  readonly receipts: Readonly<Record<string, BuiltinVerificationReceiptViewV1>>;
  readonly skillOutputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface BuiltinVerificationShellPortV1 {
  execute(input: {
    readonly workspace: string;
    readonly command: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
}

export interface BuiltinVerificationMcpPortV1 {
  findCapability(capabilityId: string):
    | Readonly<{
        revision: string;
        availability: string;
        effectiveEffects: Readonly<{
          filesystem: string;
          network: string;
          externalState: string;
        }>;
      }>
    | undefined;
  callCapability(input: {
    capabilityId: string;
    expectedRevision: string;
    arguments: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

export interface BuiltinDeterministicVerificationDependenciesV1 {
  readonly shell?: BuiltinVerificationShellPortV1;
  readonly mcp?: BuiltinVerificationMcpPortV1;
  readonly readArtifact?: (
    receipt: BuiltinVerificationReceiptViewV1,
  ) => VerificationCapabilityResultV1;
  readonly reviewer?: (input: VerificationReviewerInput) => Promise<VerificationReviewerResult>;
  /** Host-classified dispatch failures that must not be reduced to an inconclusive check. */
  readonly isFatalError?: (error: unknown) => boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export class BuiltinVerificationDispatchErrorV1 extends Error {
  readonly causeValue: unknown;
  readonly externalEffectsMayHaveOccurred: boolean;

  constructor(causeValue: unknown, externalEffectsMayHaveOccurred: boolean) {
    super(causeValue instanceof Error ? causeValue.message : String(causeValue));
    this.name = 'BuiltinVerificationDispatchErrorV1';
    this.causeValue = causeValue;
    this.externalEffectsMayHaveOccurred = externalEffectsMayHaveOccurred;
  }
}

export async function executeDeterministicVerificationChecksV1(input: {
  readonly checks: readonly VerificationCheck[];
  readonly state: BuiltinVerificationStateViewV1;
  readonly dependencies?: BuiltinDeterministicVerificationDependenciesV1;
}): Promise<
  Readonly<{ results: readonly VerificationCheckResult[]; outcome: VerificationOutcome }>
> {
  const dependencies = input.dependencies ?? {};
  const results: VerificationCheckResult[] = [];
  let externalEffectsMayHaveOccurred = false;
  try {
    for (const check of input.checks) {
      results.push(await executeCheckV1(check, input.state, dependencies));
      externalEffectsMayHaveOccurred ||= checkMayDispatchExternalEffectV1(check, dependencies);
    }
  } catch (error) {
    throw new BuiltinVerificationDispatchErrorV1(error, externalEffectsMayHaveOccurred);
  }
  return Object.freeze({ results: Object.freeze(results), outcome: aggregateOutcomeV1(results) });
}

function checkMayDispatchExternalEffectV1(
  check: VerificationCheck,
  dependencies: BuiltinDeterministicVerificationDependenciesV1,
): boolean {
  return (
    (check.type === 'command' && Boolean(dependencies.shell)) ||
    (check.type === 'mcp_read_after_write' && Boolean(dependencies.mcp)) ||
    (check.type === 'reviewer' && Boolean(dependencies.reviewer))
  );
}

async function executeCheckV1(
  check: VerificationCheck,
  state: BuiltinVerificationStateViewV1,
  dependencies: BuiltinDeterministicVerificationDependenciesV1,
): Promise<VerificationCheckResult> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  try {
    const observation = await observeCheckV1(check, state, dependencies);
    return {
      checkId: check.checkId,
      ...('modelInvocationId' in observation && typeof observation.modelInvocationId === 'string'
        ? { modelInvocationId: observation.modelInvocationId }
        : {}),
      outcome: observation.outcome,
      summary: observation.summary.slice(0, 2_000),
      evidenceDigest: digestCapabilityBindingValueV1(observation.evidence),
      startedAt,
      finishedAt: now().toISOString(),
    };
  } catch (error) {
    if (dependencies.isFatalError?.(error)) throw error;
    return {
      checkId: check.checkId,
      outcome: 'inconclusive',
      summary: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      startedAt,
      finishedAt: now().toISOString(),
    };
  }
}

async function observeCheckV1(
  check: VerificationCheck,
  state: BuiltinVerificationStateViewV1,
  dependencies: BuiltinDeterministicVerificationDependenciesV1,
): Promise<{
  outcome: VerificationOutcome;
  summary: string;
  evidence: unknown;
  modelInvocationId?: string;
}> {
  if (check.type === 'file_assertion') {
    const path = insideWorkspaceV1(state.workspace, check.path);
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
    if (!dependencies.shell) {
      return {
        outcome: 'inconclusive',
        summary: 'A governed Shell executor is unavailable; the command was not executed.',
        evidence: null,
      };
    }
    const workspace = check.cwd ? insideWorkspaceV1(state.workspace, check.cwd) : state.workspace;
    const result = await dependencies.shell.execute({
      workspace,
      command: check.command,
      timeoutMs: check.timeoutMs,
      signal: dependencies.signal,
    });
    const expected = check.expectedExitCode ?? 0;
    return {
      outcome: result.exitCode === expected ? 'passed' : 'failed',
      summary:
        result.exitCode === expected
          ? `Command exited with expected code ${expected}.`
          : `Command exited with code ${result.exitCode}; expected ${expected}. ${result.stderr}`,
      evidence: { command: check.command, ...result },
    };
  }
  if (check.type === 'schema') {
    const value = resolveSchemaSubjectV1(check.subject, state, dependencies);
    if (value === undefined) {
      return { outcome: 'inconclusive', summary: 'Schema subject is unavailable.', evidence: null };
    }
    const error = validateSchemaV1(check.schema, value);
    return {
      outcome: error ? 'failed' : 'passed',
      summary: error ?? 'Value matches the required schema.',
      evidence: value,
    };
  }
  if (check.type === 'mcp_read_after_write') {
    const receipt = state.receipts[check.invocationId];
    if (receipt?.status !== 'succeeded') {
      return {
        outcome: 'inconclusive',
        summary: 'Source invocation receipt is unavailable.',
        evidence: receipt,
      };
    }
    const descriptor = dependencies.mcp?.findCapability(check.capabilityId);
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
    if (requiresVerificationV1(descriptor.effectiveEffects)) {
      return {
        outcome: 'inconclusive',
        summary: 'Read-after-write verification requires a read-only capability.',
        evidence: descriptor.effectiveEffects,
      };
    }
    if (!dependencies.mcp) {
      return {
        outcome: 'inconclusive',
        summary: 'MCP read-after-write provider is unavailable.',
        evidence: null,
      };
    }
    const result = await dependencies.mcp.callCapability({
      capabilityId: check.capabilityId,
      expectedRevision: check.capabilityRevision,
      arguments: check.arguments,
    });
    const value = asRecord(result)?.structuredContent ?? result;
    const schemaError = check.outputSchema ? validateSchemaV1(check.outputSchema, value) : null;
    return {
      outcome: schemaError ? 'failed' : 'passed',
      summary: schemaError ?? 'Read-after-write completed against the bound capability revision.',
      evidence: result,
    };
  }
  if (check.type === 'external_reference') {
    const receipt = state.receipts[check.invocationId];
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
  const resolved = reviewerInputV1(check, state, dependencies);
  if (!resolved.ok) {
    return { outcome: 'inconclusive', summary: resolved.summary, evidence: null };
  }
  const result = await dependencies.reviewer(resolved.input);
  return { ...result, evidence: resolved.input };
}

function resolveSchemaSubjectV1(
  subject: Extract<VerificationCheck, { type: 'schema' }>['subject'],
  state: BuiltinVerificationStateViewV1,
  dependencies: BuiltinDeterministicVerificationDependenciesV1,
): unknown {
  if (subject.kind === 'literal') return subject.value;
  if (subject.kind === 'skill_output') return state.skillOutputs[subject.activationId];
  const receipt = state.receipts[subject.invocationId];
  if (!receipt || !dependencies.readArtifact) return undefined;
  try {
    return dependencies.readArtifact(receipt).structuredContent;
  } catch {
    return undefined;
  }
}

function reviewerInputV1(
  check: Extract<VerificationCheck, { type: 'reviewer' }>,
  state: BuiltinVerificationStateViewV1,
  dependencies: BuiltinDeterministicVerificationDependenciesV1,
): { ok: true; input: VerificationReviewerInput } | { ok: false; summary: string } {
  const invocationIds = check.invocationIds ?? [];
  const receipts = invocationIds
    .map((id) => state.receipts[id])
    .filter((receipt): receipt is BuiltinVerificationReceiptViewV1 => Boolean(receipt));
  if (receipts.length !== invocationIds.length) {
    return { ok: false, summary: 'A referenced capability receipt is unavailable.' };
  }
  if (
    receipts.some(
      (receipt) =>
        receipt.status !== 'succeeded' ||
        !receipt.artifact ||
        !receipt.resultDigest ||
        !receipt.evidenceDigest,
    )
  ) {
    return { ok: false, summary: 'A successful capability receipt Artifact is unavailable.' };
  }
  if (receipts.length > 0 && !dependencies.readArtifact) {
    return { ok: false, summary: 'The capability Artifact reader is unavailable.' };
  }
  const artifacts: VerificationReviewerInput['artifacts'] = [];
  for (const receipt of receipts) {
    try {
      artifacts.push({
        invocationId: receipt.invocationId,
        result: dependencies.readArtifact!(receipt),
      });
    } catch {
      return { ok: false, summary: 'A capability receipt Artifact could not be verified.' };
    }
  }
  const skillOutputs = (check.activationIds ?? []).flatMap((activationId) => {
    const output = state.skillOutputs[activationId];
    return output ? [{ activationId, output: { ...output } }] : [];
  });
  return {
    ok: true,
    input: { instructions: check.instructions, receipts, artifacts, skillOutputs },
  };
}

function insideWorkspaceV1(workspace: string, candidate: string): string {
  const root = resolve(workspace);
  const target = resolve(root, candidate.replace(/[\\/]+/g, '/'));
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot &&
    (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot))
  ) {
    throw new Error(`Refusing path outside workspace: ${candidate}`);
  }
  return target;
}

function validateSchemaV1(schema: Record<string, unknown>, value: unknown): string | null {
  return validateCapabilityArgumentsV1(schema, value as Record<string, unknown>);
}

function requiresVerificationV1(effects: {
  readonly filesystem: string;
  readonly network: string;
  readonly externalState: string;
}): boolean {
  return [effects.filesystem, effects.network, effects.externalState].some(
    (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
  );
}

function aggregateOutcomeV1(results: readonly VerificationCheckResult[]): VerificationOutcome {
  if (results.some((result) => result.outcome === 'failed')) return 'failed';
  if (results.some((result) => result.outcome === 'inconclusive')) return 'inconclusive';
  return 'passed';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
