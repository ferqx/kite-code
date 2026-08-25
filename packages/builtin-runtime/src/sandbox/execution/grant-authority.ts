import { createHash, randomUUID } from 'node:crypto';
import type {
  ApprovedShellCommand,
  PreparedSandboxExecution,
  SandboxCleanupGrant,
  SandboxPreparation,
  SandboxPreparationGrant,
  SandboxPreparationResourceSemantics,
} from '@kite-ai/runtime-spi';
import { digestCapabilityBindingValue } from '../../capability-binding';

export interface SandboxPreparationIntentRecord {
  readonly attempt: number;
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly canonicalWorkspace: string;
  readonly effectiveEffectsDigest: string;
  readonly admissionDigest: string;
  readonly preparationDigest: string;
  readonly commandDigest: string;
  readonly executionBoundaryDigest: string;
  readonly resourceSemantics: 'allocating';
  readonly intentDigest: string;
  readonly recordedAt: string;
}

function sandboxPreparationIntentDigest(
  input: Omit<SandboxPreparationIntentRecord, 'intentDigest' | 'recordedAt'>,
): string {
  return digestCapabilityBindingValue(input);
}

const GRANT_DOMAIN = 'kite.sandbox-preparation-grant.v1\0';
const COMMAND_DOMAIN = 'kite.approved-shell-command.v1\0';
const DEFAULT_TTL_MS = 60_000;

export class SandboxExecutionGrantError extends Error {
  readonly code = 'invalid_grant';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxExecutionGrantError';
  }
}

export interface SandboxExecutionGrantVerifier {
  verify(grant: SandboxPreparationGrant): Readonly<SandboxPreparationGrant>;
  verifyCleanup(grant: SandboxCleanupGrant): Readonly<SandboxCleanupGrant>;
}

export class SandboxExecutionGrantAuthority {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #consumedGrantSeals = new Set<string>();

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  issue(input: {
    preparation: SandboxPreparation;
    resourceSemantics: SandboxPreparationResourceSemantics;
    preparationIntentDigest?: string;
  }): Readonly<SandboxPreparationGrant> {
    const preparation = validatePreparation(input.preparation);
    if (input.resourceSemantics === 'allocating' && !input.preparationIntentDigest) {
      throw new SandboxExecutionGrantError(
        'Allocating sandbox preparation requires a durable intent acknowledgement.',
      );
    }
    if (
      input.resourceSemantics === 'allocating' &&
      input.preparationIntentDigest !== allocatingIntentDigest(preparation)
    ) {
      throw new SandboxExecutionGrantError(
        'Allocating sandbox preparation intent does not match the approved preparation.',
      );
    }
    if (input.resourceSemantics === 'pure' && input.preparationIntentDigest) {
      throw new SandboxExecutionGrantError(
        'Pure sandbox preparation cannot claim an allocating intent.',
      );
    }
    const issuedAtMs = this.#now();
    const expiresAtMs = issuedAtMs + this.#ttlMs;
    const commandBase = {
      schema: 'kite.approved-shell-command.v1' as const,
      invocationId: preparation.invocationId,
      attempt: preparation.attempt,
      argv: preparation.argv,
      commandDigest: preparation.commandDigest,
      grantId: randomUUID(),
      issuedAtMs,
      expiresAtMs,
    };
    const approvedCommand = freeze({
      ...commandBase,
      seal: sign(COMMAND_DOMAIN, commandBase),
    }) satisfies Readonly<ApprovedShellCommand>;
    const base = {
      schema: 'kite.sandbox-execution-provider.v1' as const,
      purpose: 'prepare' as const,
      preparation,
      approvedCommand,
      preparationDigest: sandboxPreparationDigest(preparation),
      resourceSemantics: input.resourceSemantics,
      preparationIntentDigest: input.preparationIntentDigest ?? null,
      issuedAtMs,
      expiresAtMs,
    };
    return freeze({ ...base, seal: sign(GRANT_DOMAIN, base) });
  }

  verifier(): SandboxExecutionGrantVerifier {
    return Object.freeze({
      verify: (grant: SandboxPreparationGrant) => this.verify(grant),
      verifyCleanup: (grant: SandboxCleanupGrant) => this.verifyCleanup(grant),
    });
  }

  verify(grant: SandboxPreparationGrant): Readonly<SandboxPreparationGrant> {
    const copy = structuredClone(grant);
    if (
      !hasExactKeys(copy as unknown as Record<string, unknown>, [
        'schema',
        'purpose',
        'preparation',
        'approvedCommand',
        'preparationDigest',
        'resourceSemantics',
        'preparationIntentDigest',
        'issuedAtMs',
        'expiresAtMs',
        'seal',
      ]) ||
      !hasExactKeys(copy.approvedCommand as unknown as Record<string, unknown>, [
        'schema',
        'invocationId',
        'attempt',
        'argv',
        'commandDigest',
        'grantId',
        'issuedAtMs',
        'expiresAtMs',
        'seal',
      ])
    ) {
      invalid('Sandbox grant shape mismatch.');
    }
    const preparation = validatePreparation(copy.preparation);
    const { seal, ...base } = copy;
    if (!safeEqual(seal, sign(GRANT_DOMAIN, base))) invalid('Sandbox grant seal mismatch.');
    if (this.#consumedGrantSeals.has(seal)) invalid('Sandbox grant was already consumed.');
    const { seal: commandSeal, ...commandBase } = copy.approvedCommand;
    if (!safeEqual(commandSeal, sign(COMMAND_DOMAIN, commandBase))) {
      invalid('Approved command seal mismatch.');
    }
    if (
      copy.schema !== 'kite.sandbox-execution-provider.v1' ||
      copy.purpose !== 'prepare' ||
      copy.preparationDigest !== sandboxPreparationDigest(preparation) ||
      copy.approvedCommand.invocationId !== preparation.invocationId ||
      copy.approvedCommand.attempt !== preparation.attempt ||
      copy.approvedCommand.commandDigest !== preparation.commandDigest ||
      JSON.stringify(copy.approvedCommand.argv) !== JSON.stringify(preparation.argv)
    ) {
      invalid('Sandbox grant identity mismatch.');
    }
    if (copy.expiresAtMs <= this.#now() || copy.approvedCommand.expiresAtMs <= this.#now()) {
      invalid('Sandbox grant expired.');
    }
    if (copy.resourceSemantics === 'allocating' && !copy.preparationIntentDigest) {
      invalid('Allocating sandbox grant lacks durable intent.');
    }
    if (
      copy.resourceSemantics === 'allocating' &&
      copy.preparationIntentDigest !== allocatingIntentDigest(preparation)
    ) {
      invalid('Allocating sandbox grant intent mismatch.');
    }
    if (copy.resourceSemantics === 'pure' && copy.preparationIntentDigest !== null) {
      invalid('Pure sandbox grant carries allocating intent.');
    }
    this.#consumedGrantSeals.add(seal);
    return freeze(copy);
  }

  issueCleanup(input: {
    purpose: SandboxCleanupGrant['purpose'];
    prepared?: Readonly<PreparedSandboxExecution>;
    intent?: Readonly<SandboxPreparationIntentRecord>;
    invocationId?: string;
    lifecycleIntentDigest: string;
    cleanupAttempt: number;
    cleanupConfirmed: boolean;
  }): Readonly<SandboxCleanupGrant> {
    const source = input.prepared ?? input.intent;
    if (!source || !input.lifecycleIntentDigest) {
      invalid('Sandbox cleanup grant requires durable lifecycle identity.');
    }
    if (input.purpose === 'reconcile_preparation_intent' && !input.intent) {
      invalid('Sandbox abandonment cleanup requires preparation intent evidence.');
    }
    if (input.purpose !== 'reconcile_preparation_intent' && !input.prepared) {
      invalid('Sandbox prepared cleanup requires the exact prepared plan.');
    }
    const issuedAtMs = this.#now();
    const base = {
      schema: 'kite.sandbox-execution-provider.v1' as const,
      purpose: input.purpose,
      toolCallId: source.toolCallId,
      capabilityId: source.capabilityId,
      capabilityRevision: source.capabilityRevision,
      invocationId: input.prepared?.invocationId ?? input.invocationId ?? '',
      attempt: source.attempt,
      canonicalWorkspace: source.canonicalWorkspace,
      effectiveEffectsDigest: source.effectiveEffectsDigest,
      admissionDigest: source.admissionDigest,
      preparationDigest: source.preparationDigest,
      preparedPlanDigest: input.prepared ? sandboxPreparedPlanDigest(input.prepared) : null,
      cleanupDigest: input.prepared ? sandboxCleanupDigest(input.prepared.cleanup) : null,
      lifecycleIntentDigest: input.lifecycleIntentDigest,
      cleanupGrantId: randomUUID(),
      cleanupAttempt: input.cleanupAttempt,
      cleanupConfirmed: input.cleanupConfirmed,
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.#ttlMs,
    };
    return freeze({ ...base, seal: sign(GRANT_DOMAIN, base) });
  }

  verifyCleanup(grant: SandboxCleanupGrant): Readonly<SandboxCleanupGrant> {
    const copy = structuredClone(grant);
    if (
      !hasExactKeys(copy as unknown as Record<string, unknown>, [
        'schema',
        'purpose',
        'toolCallId',
        'capabilityId',
        'capabilityRevision',
        'invocationId',
        'attempt',
        'canonicalWorkspace',
        'effectiveEffectsDigest',
        'admissionDigest',
        'preparationDigest',
        'preparedPlanDigest',
        'cleanupDigest',
        'lifecycleIntentDigest',
        'cleanupGrantId',
        'cleanupAttempt',
        'cleanupConfirmed',
        'issuedAtMs',
        'expiresAtMs',
        'seal',
      ])
    ) {
      invalid('Sandbox cleanup grant shape mismatch.');
    }
    const { seal, ...base } = copy;
    if (!safeEqual(seal, sign(GRANT_DOMAIN, base))) {
      invalid('Sandbox cleanup grant seal mismatch.');
    }
    if (this.#consumedGrantSeals.has(seal)) invalid('Sandbox cleanup grant was already consumed.');
    if (
      copy.schema !== 'kite.sandbox-execution-provider.v1' ||
      !['dispose', 'reconcile', 'reconcile_preparation_intent'].includes(copy.purpose) ||
      !copy.toolCallId ||
      copy.capabilityId !== 'builtin:shell_execute' ||
      !copy.capabilityRevision ||
      !copy.invocationId ||
      !Number.isSafeInteger(copy.attempt) ||
      copy.attempt < 1 ||
      !copy.canonicalWorkspace ||
      !copy.effectiveEffectsDigest ||
      !copy.admissionDigest ||
      !copy.preparationDigest ||
      !copy.lifecycleIntentDigest ||
      !copy.cleanupGrantId ||
      !Number.isSafeInteger(copy.cleanupAttempt) ||
      copy.cleanupAttempt < 1 ||
      typeof copy.cleanupConfirmed !== 'boolean' ||
      (copy.purpose === 'reconcile_preparation_intent'
        ? copy.preparedPlanDigest !== null || copy.cleanupDigest !== null
        : !copy.preparedPlanDigest || !copy.cleanupDigest) ||
      copy.expiresAtMs <= this.#now()
    ) {
      invalid('Sandbox cleanup grant identity mismatch.');
    }
    this.#consumedGrantSeals.add(seal);
    return freeze(copy);
  }
}

export function sandboxPreparedPlanDigest(prepared: Readonly<PreparedSandboxExecution>): string {
  return digest(prepared);
}

export function sandboxCleanupDigest(
  cleanup: Readonly<PreparedSandboxExecution['cleanup']>,
): string {
  return digest(cleanup);
}

function allocatingIntentDigest(preparation: Readonly<SandboxPreparation>): string {
  return sandboxPreparationIntentDigest({
    attempt: preparation.attempt,
    toolCallId: preparation.toolCallId,
    capabilityId: preparation.capabilityId,
    capabilityRevision: preparation.capabilityRevision,
    canonicalWorkspace: preparation.canonicalWorkspace,
    effectiveEffectsDigest: preparation.effectiveEffectsDigest,
    admissionDigest: preparation.admissionDigest,
    preparationDigest: sandboxPreparationDigest(preparation as SandboxPreparation),
    commandDigest: preparation.commandDigest,
    executionBoundaryDigest: preparation.executionBoundaryDigest,
    resourceSemantics: 'allocating',
  });
}

export function sandboxCommandDigest(argv: readonly string[]): string {
  if (!Array.isArray(argv) || argv.length < 1 || argv.some((part) => typeof part !== 'string')) {
    throw new Error('Sandbox command argv is invalid.');
  }
  return digest({ argv: [...argv] });
}

export function sandboxPreparationDigest(preparation: SandboxPreparation): string {
  return digest(preparation);
}

function validatePreparation(value: SandboxPreparation): Readonly<SandboxPreparation> {
  const copy = structuredClone(value);
  if (
    !hasExactKeys(copy as unknown as Record<string, unknown>, [
      'schema',
      'toolCallId',
      'capabilityId',
      'capabilityRevision',
      'invocationId',
      'attempt',
      'effectiveEffectsDigest',
      'admissionDigest',
      'canonicalWorkspace',
      'argv',
      'commandDigest',
      'executionBoundaryDigest',
      'protectedPathRevision',
      'filesystemMode',
      'networkMode',
      'executionTrust',
      'resourceLimits',
      'timeoutMs',
      'cancellationCorrelation',
    ]) ||
    !hasExactKeys(copy.resourceLimits as unknown as Record<string, unknown>, [
      'cpuTime',
      'virtualMemory',
      'fileSize',
      'fileDescriptors',
      'processes',
      'maxProcessTreeTasks',
    ]) ||
    copy.schema !== 'kite.sandbox-execution-provider.v1' ||
    copy.capabilityId !== 'builtin:shell_execute' ||
    !copy.toolCallId ||
    !copy.capabilityRevision ||
    !copy.invocationId ||
    !Number.isSafeInteger(copy.attempt) ||
    copy.attempt < 1 ||
    !copy.effectiveEffectsDigest ||
    !copy.admissionDigest ||
    !copy.canonicalWorkspace ||
    !['workspace_only', 'allow_all'].includes(copy.filesystemMode) ||
    !['disabled', 'allow_all'].includes(copy.networkMode) ||
    ![null, 'policy_proven_read_only'].includes(copy.executionTrust) ||
    !Number.isSafeInteger(copy.timeoutMs) ||
    copy.timeoutMs < 1 ||
    !validResourceLimits(copy.resourceLimits) ||
    copy.commandDigest !== sandboxCommandDigest(copy.argv) ||
    !copy.executionBoundaryDigest ||
    !copy.protectedPathRevision ||
    !copy.cancellationCorrelation
  ) {
    invalid('Sandbox preparation is invalid.');
  }
  return freeze(copy);
}

function validResourceLimits(value: SandboxPreparation['resourceLimits']): boolean {
  return (
    [
      value.cpuTime,
      value.virtualMemory,
      value.fileSize,
      value.fileDescriptors,
      value.processes,
    ].every((entry) => Number.isSafeInteger(entry)) &&
    (value.maxProcessTreeTasks === null ||
      (Number.isSafeInteger(value.maxProcessTreeTasks) && value.maxProcessTreeTasks > 0))
  );
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sign(domain: string, value: unknown): string {
  return createHash('sha256').update(domain).update(canonical(value)).digest('hex');
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Sandbox grant contains a non-canonical value.');
}

function safeEqual(left: unknown, right: string): boolean {
  return typeof left === 'string' && left === right;
}

function invalid(message: string): never {
  throw new SandboxExecutionGrantError(message);
}

function freeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
    return Object.freeze(value);
  }
  return value;
}
