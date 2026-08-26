import { createHash } from 'node:crypto';
import type { RuntimeCommand, RuntimeCommandReceipt } from '@kite-ai/runtime-contract';
import { runtimeCommandSessionId } from '../kernel-adapter/input';
import type {
  RuntimeAppliedCommandReceipt,
  RuntimeCommandCommitEvidence,
  RuntimeStoredCommandReceipt,
} from '../storage';

const APPLIED_RECEIPT_KEYS = ['commandId', 'revision', 'sessionId', 'status'] as const;

/**
 * Canonical request identity for a command that has already passed Contract
 * validation. It never persists the command body.
 */
export function digestRuntimeCommand(command: RuntimeCommand): string {
  return createHash('sha256').update(canonicalizeRuntimeCommand(command)).digest('hex');
}

/** The Host constructs transaction evidence; bridges never infer receipt scope. */
export function createRuntimeCommandCommitEvidence(input: {
  readonly command: RuntimeCommand;
  readonly targetSessionId: string;
  readonly committedAt: number;
}): RuntimeCommandCommitEvidence {
  return Object.freeze({
    scopeSessionId: runtimeCommandSessionId(input.command),
    commandId: input.command.commandId,
    requestDigest: digestRuntimeCommand(input.command),
    targetSessionId: input.targetSessionId,
    committedAt: input.committedAt,
  });
}

/**
 * Validates the persisted applied receipt before Host replay logic reads it.
 * A record is deliberately rejected rather than repaired or normalized.
 */
export function parseRuntimeStoredCommandReceipt(
  record: RuntimeStoredCommandReceipt,
): RuntimeAppliedCommandReceipt {
  assertReceiptRecord(record);
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.originalReceiptJson);
  } catch {
    throw new Error('Runtime command receipt JSON is malformed.');
  }
  if (!isExactAppliedReceipt(parsed, record)) {
    throw new Error('Runtime command receipt JSON does not match its record.');
  }
  const expected = canonicalAppliedReceipt(record);
  if (record.originalReceiptJson !== expected) {
    throw new Error('Runtime command receipt JSON is not canonical.');
  }
  return Object.freeze({
    status: 'applied',
    commandId: record.commandId,
    sessionId: record.targetSessionId,
    revision: record.committedRevision,
  });
}

/**
 * Maps a validated Store record for this exact command to a typed replay or a
 * fail-closed invalid-command result. Callers must invoke this before bridge
 * preparation and never schedule from either outcome.
 */
export function resolveRuntimeCommandReceipt(
  command: RuntimeCommand,
  record: RuntimeStoredCommandReceipt,
): RuntimeCommandReceipt {
  const applied = parseRuntimeStoredCommandReceipt(record);
  if (
    record.scopeSessionId !== runtimeCommandSessionId(command) ||
    record.commandId !== command.commandId
  ) {
    throw new Error('Runtime command receipt identity does not match the command scope.');
  }
  if (record.requestDigest !== digestRuntimeCommand(command)) {
    return Object.freeze({
      status: 'rejected',
      commandId: command.commandId,
      code: 'invalid_command',
    });
  }
  return Object.freeze({
    status: 'idempotent_replay',
    commandId: applied.commandId,
    sessionId: applied.sessionId,
    originalRevision: applied.revision,
  });
}

function canonicalizeRuntimeCommand(command: RuntimeCommand): string {
  return canonicalizeJson(command, new Set<object>());
}

function canonicalizeJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Runtime command is not JSON-safe.');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error('Runtime command is not JSON-safe.');
  }
  if (ancestors.has(value)) throw new Error('Runtime command contains a cycle.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return canonicalizeArray(value, ancestors);
    return canonicalizeObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeArray(value: readonly unknown[], ancestors: Set<object>): string {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new Error('Runtime command has an unsafe array prototype.');
  }
  const ownNames = Object.getOwnPropertyNames(value);
  const expectedNames = [...value.keys()].map(String).concat('length');
  if (
    ownNames.length !== expectedNames.length ||
    ownNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error('Runtime command has an unsafe array shape.');
  }
  return `[${value.map((item) => canonicalizeJson(item, ancestors)).join(',')}]`;
}

function canonicalizeObject(value: object, ancestors: Set<object>): string {
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new Error('Runtime command has an unsafe object prototype.');
  }
  const keys = Object.keys(value).sort();
  if (Object.getOwnPropertyNames(value).length !== keys.length) {
    throw new Error('Runtime command has an unsafe object shape.');
  }
  const record = value as Record<string, unknown>;
  return `{${keys
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error('Runtime command has an unsafe object property.');
      }
      return `${JSON.stringify(key)}:${canonicalizeJson(descriptor.value, ancestors)}`;
    })
    .join(',')}}`;
}

function assertReceiptRecord(record: RuntimeStoredCommandReceipt): void {
  assertReceiptText(record.scopeSessionId, 'scope session identity');
  assertReceiptText(record.commandId, 'command identity');
  assertReceiptText(record.targetSessionId, 'target session identity');
  if (!/^[a-f0-9]{64}$/u.test(record.requestDigest)) {
    throw new Error('Runtime command receipt digest is invalid.');
  }
  if (!Number.isSafeInteger(record.committedRevision) || record.committedRevision < 0) {
    throw new Error('Runtime command receipt revision is invalid.');
  }
  if (!Number.isSafeInteger(record.committedAt) || record.committedAt < 0) {
    throw new Error('Runtime command receipt committed time is invalid.');
  }
}

function isExactAppliedReceipt(
  value: unknown,
  record: RuntimeStoredCommandReceipt,
): value is RuntimeAppliedCommandReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  return (
    keys.length === APPLIED_RECEIPT_KEYS.length &&
    keys.every((key, index) => key === APPLIED_RECEIPT_KEYS[index]) &&
    candidate.status === 'applied' &&
    candidate.commandId === record.commandId &&
    candidate.sessionId === record.targetSessionId &&
    candidate.revision === record.committedRevision &&
    Number.isSafeInteger(candidate.revision) &&
    (candidate.revision as number) >= 0
  );
}

function canonicalAppliedReceipt(record: RuntimeStoredCommandReceipt): string {
  return JSON.stringify({
    status: 'applied',
    commandId: record.commandId,
    sessionId: record.targetSessionId,
    revision: record.committedRevision,
  });
}

function assertReceiptText(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    throw new Error(`Runtime command receipt ${field} is invalid.`);
  }
}
