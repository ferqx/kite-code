import { createHash } from 'node:crypto';
import { canonicalContextDigestV3 } from '@/core/model/context-checkpoint-v3';
import type { NormalReprepareConsumptionKeyV1 } from './context-compaction';
import type { RuntimeEventEnvelopeV24 } from './runtime-event-v24';
import {
  assertCanonicalRuntimeEventEnvelopeV24,
  canonicalRuntimeEventEnvelopeAuthorityBytesV24,
} from './runtime-event-v24';

export const BRANCH_RECEIPT_MAX_BYTES_V1 = 16 * 1024;
export const BRANCH_COMPLETION_MAX_BYTES_V1 = 1024;
export const BRANCH_CLOSURE_MAX_BYTES_V1 = 768 * 1024;
export const BRANCH_CLOSURE_EVENT_MAX_BYTES_V1 = 128 * 1024;

export type BranchMutationEventManifestV1 =
  | {
      kind: 'in_flight_quartet';
      eventIds: readonly [string, string, string, string];
      eventTypes: readonly [
        'run.error',
        'resource_budget.unknown',
        'turn.aborted',
        'context.normal_reprepare_consumption_detached_v1',
      ];
    }
  | {
      kind: 'settled_detach';
      eventIds: readonly [string];
      eventTypes: readonly ['context.normal_reprepare_consumption_detached_v1'];
    };

export interface BranchMutationReceiptV1 {
  version: 1;
  receiptId: string;
  reason: 'fork' | 'rewind';
  sourceThreadId: string;
  sourceGeneration: number;
  targetThreadId: string;
  targetGeneration: number;
  selectedCutDigest: string;
  targetLedgerBaseId: string;
  manifest: BranchMutationEventManifestV1;
  baseRevision: number;
  finalRevision: number;
  postSnapshotDigest: string;
  terminalClosure: { kind: 'none' } | { kind: 'copied'; closureChecksum: string };
  receiptChecksum: string;
}

export interface BranchMutationCompletionV1 {
  version: 1;
  receiptId: string;
  targetThreadId: string;
  targetGeneration: number;
  requestDigest: string;
  candidateDigest: string;
  manifestDigest: string;
  postSnapshotDigest: string;
  completionChecksum: string;
}

export type BranchCopiedTerminalRoleV1 =
  | 'continuation_consumed'
  | 'primary_resource_reserved'
  | 'primary_resource_dispatch_started'
  | 'primary_terminal'
  | 'resource_terminal'
  | 'turn_terminal';

export interface BranchCopiedTerminalEnvelopeV1 {
  role: BranchCopiedTerminalRoleV1;
  envelope: RuntimeEventEnvelopeV24;
}

export interface BranchCopiedTerminalClosureV1 {
  version: 1;
  targetThreadId: string;
  targetGeneration: number;
  branchMutationReceiptId: string;
  sourceThreadId: string;
  sourceGeneration: number;
  sourceSelectedCutProofDigest: string;
  terminal:
    | { kind: 'success'; envelopes: readonly BranchCopiedTerminalEnvelopeV1[] }
    | {
        kind: 'error_terminal';
        outcome: 'provider_admission_denied' | 'unknown_external_outcome';
        envelopes: readonly BranchCopiedTerminalEnvelopeV1[];
      };
  closureChecksum: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(domain: string, bytes: string | Uint8Array): string {
  return createHash('sha256').update(`${domain}\0`).update(bytes).digest('hex');
}

function assertHexDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hex.`);
}

function u16(value: number): Buffer {
  const result = Buffer.allocUnsafe(2);
  result.writeUInt16BE(value);
  return result;
}

function u32(value: number): Buffer {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value);
  return result;
}

function u64Safe(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Generation must be positive.');
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

function framedString(value: string, maxBytes = 256): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < 1 || bytes.length > maxBytes) throw new Error('BCTC string is out of bounds.');
  return Buffer.concat([u16(bytes.length), bytes]);
}

const ROLE_CODES: Readonly<Record<BranchCopiedTerminalRoleV1, number>> = Object.freeze({
  continuation_consumed: 1,
  primary_resource_reserved: 2,
  primary_resource_dispatch_started: 3,
  primary_terminal: 4,
  resource_terminal: 5,
  turn_terminal: 6,
});

export function encodeBranchCopiedTerminalClosureV1(
  closure: Omit<BranchCopiedTerminalClosureV1, 'closureChecksum'>,
): Buffer {
  assertHexDigest(closure.branchMutationReceiptId, 'Branch receipt id');
  assertHexDigest(closure.sourceSelectedCutProofDigest, 'Selected cut proof digest');
  const expectedRoles: BranchCopiedTerminalRoleV1[] =
    closure.terminal.kind === 'success'
      ? [
          'continuation_consumed',
          'primary_resource_reserved',
          'primary_resource_dispatch_started',
          'primary_terminal',
          'resource_terminal',
        ]
      : [
          'continuation_consumed',
          'primary_resource_reserved',
          'primary_resource_dispatch_started',
          'primary_terminal',
          'resource_terminal',
          'turn_terminal',
        ];
  if (
    closure.terminal.envelopes.length !== expectedRoles.length ||
    closure.terminal.envelopes.some((entry, index) => entry.role !== expectedRoles[index])
  ) {
    throw new Error('BCTC terminal roles must use the exact five/six-role ordering.');
  }
  const expectedTypes: Readonly<Record<BranchCopiedTerminalRoleV1, readonly string[]>> = {
    continuation_consumed: ['context.normal_reprepare_consumed_v1'],
    primary_resource_reserved: ['resource_budget.reserved'],
    primary_resource_dispatch_started: ['resource_budget.dispatch_started'],
    primary_terminal: closure.terminal.kind === 'success' ? ['model.responded'] : ['run.error'],
    resource_terminal:
      closure.terminal.kind === 'success'
        ? ['resource_budget.reconciled']
        : ['resource_budget.released', 'resource_budget.unknown'],
    turn_terminal: ['turn.aborted'],
  };
  const frames = closure.terminal.envelopes.map((entry) => {
    assertCanonicalRuntimeEventEnvelopeV24(entry.envelope);
    if (
      entry.envelope.threadId !== closure.sourceThreadId ||
      entry.envelope.generation !== closure.sourceGeneration ||
      !expectedTypes[entry.role].includes(entry.envelope.payload.type)
    ) {
      throw new Error('BCTC envelope producer or role/type binding is invalid.');
    }
    const bytes = Buffer.from(canonicalRuntimeEventEnvelopeAuthorityBytesV24(entry.envelope));
    if (bytes.length > BRANCH_CLOSURE_EVENT_MAX_BYTES_V1) {
      throw new Error('BCTC envelope exceeds the per-event byte limit.');
    }
    return Buffer.concat([Buffer.from([ROLE_CODES[entry.role]]), u32(bytes.length), bytes]);
  });
  const encoded = Buffer.concat([
    Buffer.from('BCTC', 'ascii'),
    Buffer.from([
      1,
      closure.terminal.kind === 'success' ? 1 : 2,
      closure.terminal.envelopes.length,
    ]),
    framedString(closure.targetThreadId),
    framedString(closure.sourceThreadId),
    u64Safe(closure.targetGeneration),
    u64Safe(closure.sourceGeneration),
    Buffer.from(closure.branchMutationReceiptId, 'hex'),
    Buffer.from(closure.sourceSelectedCutProofDigest, 'hex'),
    ...frames,
  ]);
  if (encoded.length > BRANCH_CLOSURE_MAX_BYTES_V1) {
    throw new Error('BCTC closure exceeds the canonical byte limit.');
  }
  return encoded;
}

export function finalizeBranchCopiedTerminalClosureV1(
  closure: Omit<BranchCopiedTerminalClosureV1, 'closureChecksum'>,
): BranchCopiedTerminalClosureV1 {
  const encoded = encodeBranchCopiedTerminalClosureV1(closure);
  return {
    ...closure,
    closureChecksum: digest('branch-copied-terminal-closure:v1', encoded),
  };
}

export function encodeBranchMutationReceiptV1(receipt: BranchMutationReceiptV1): Buffer {
  const bytes = Buffer.from(canonical(receipt), 'utf8');
  if (bytes.length > BRANCH_RECEIPT_MAX_BYTES_V1) {
    throw new Error('Branch mutation receipt exceeds 16KiB.');
  }
  return bytes;
}

export function finalizeBranchMutationReceiptV1(
  receipt: Omit<BranchMutationReceiptV1, 'receiptChecksum'>,
): BranchMutationReceiptV1 {
  const finalized = {
    ...receipt,
    receiptChecksum: digest('branch-mutation-receipt:v1', canonical(receipt)),
  };
  encodeBranchMutationReceiptV1(finalized);
  return finalized;
}

export function encodeBranchMutationCompletionV1(completion: BranchMutationCompletionV1): Buffer {
  const bytes = Buffer.from(canonical(completion), 'utf8');
  if (bytes.length > BRANCH_COMPLETION_MAX_BYTES_V1) {
    throw new Error('Branch mutation completion exceeds 1KiB.');
  }
  return bytes;
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains missing or unknown fields.`);
  }
}

function boundedJson(blob: Uint8Array, maxBytes: number, label: string): unknown {
  if (blob.byteLength < 2 || blob.byteLength > maxBytes) {
    throw new Error(`${label} length is out of bounds.`);
  }
  const stack: Array<{ kind: number; items: number }> = [];
  let inString = false;
  let escaped = false;
  let stringBytes = 0;
  for (const byte of blob) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (byte === 0x5c) {
        escaped = true;
      } else if (byte === 0x22) {
        inString = false;
        stringBytes = 0;
      } else {
        stringBytes += 1;
        if (stringBytes > 128 * 1024) throw new Error(`${label} string exceeds its bound.`);
      }
      continue;
    }
    if (byte === 0x22) {
      inString = true;
    } else if (byte === 0x7b || byte === 0x5b) {
      stack.push({ kind: byte, items: 0 });
      if (stack.length > 24) throw new Error(`${label} depth exceeds its bound.`);
    } else if (byte === 0x7d || byte === 0x5d) {
      const frame = stack.pop();
      if (!frame || (byte === 0x7d ? frame.kind !== 0x7b : frame.kind !== 0x5b)) {
        throw new Error(`${label} nesting is invalid.`);
      }
    } else if (byte === 0x2c || byte === 0x3a) {
      const frame = stack.at(-1);
      if (
        frame &&
        ((frame.kind === 0x5b && byte === 0x2c) || (frame.kind === 0x7b && byte === 0x3a))
      ) {
        frame.items += 1;
        const limit = frame.kind === 0x5b ? 4096 : 256;
        if (frame.items > limit) throw new Error(`${label} item count exceeds its bound.`);
      }
    }
  }
  if (inString || stack.length > 0) throw new Error(`${label} nesting is incomplete.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(blob).toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} is not canonical JSON.`);
  }
  return parsed;
}

/** Decode a receipt only after the caller has applied the SQLite length gate. */
export function decodeBranchMutationReceiptV1(blob: Uint8Array): BranchMutationReceiptV1 {
  const parsed = boundedJson(blob, BRANCH_RECEIPT_MAX_BYTES_V1, 'Branch receipt');
  assertExactKeys(
    parsed,
    [
      'version',
      'receiptId',
      'reason',
      'sourceThreadId',
      'sourceGeneration',
      'targetThreadId',
      'targetGeneration',
      'selectedCutDigest',
      'targetLedgerBaseId',
      'manifest',
      'baseRevision',
      'finalRevision',
      'postSnapshotDigest',
      'terminalClosure',
      'receiptChecksum',
    ],
    'Branch receipt',
  );
  const receipt = parsed as unknown as BranchMutationReceiptV1;
  assertExactKeys(receipt.manifest, ['kind', 'eventIds', 'eventTypes'], 'Branch receipt manifest');
  assertExactKeys(
    receipt.terminalClosure,
    receipt.terminalClosure?.kind === 'copied' ? ['kind', 'closureChecksum'] : ['kind'],
    'Branch receipt closure reference',
  );
  const expectedCount = receipt.manifest?.kind === 'in_flight_quartet' ? 4 : 1;
  if (
    receipt.version !== 1 ||
    !['fork', 'rewind'].includes(receipt.reason) ||
    !receipt.sourceThreadId ||
    !receipt.targetThreadId ||
    !Number.isSafeInteger(receipt.sourceGeneration) ||
    receipt.sourceGeneration < 1 ||
    !Number.isSafeInteger(receipt.targetGeneration) ||
    receipt.targetGeneration < 1 ||
    !Number.isSafeInteger(receipt.baseRevision) ||
    receipt.baseRevision < 0 ||
    receipt.finalRevision !== receipt.baseRevision + expectedCount ||
    !Array.isArray(receipt.manifest.eventIds) ||
    !Array.isArray(receipt.manifest.eventTypes) ||
    receipt.manifest.eventIds.length !== expectedCount ||
    receipt.manifest.eventTypes.length !== expectedCount
  ) {
    throw new Error('Branch receipt fields are invalid.');
  }
  for (const [value, label] of [
    [receipt.receiptId, 'receipt id'],
    [receipt.selectedCutDigest, 'selected cut digest'],
    [receipt.targetLedgerBaseId, 'target ledger base id'],
    [receipt.postSnapshotDigest, 'post snapshot digest'],
    [receipt.receiptChecksum, 'receipt checksum'],
    ...(receipt.terminalClosure.kind === 'copied'
      ? ([[receipt.terminalClosure.closureChecksum, 'closure checksum']] as const)
      : []),
    ...receipt.manifest.eventIds.map((eventId) => [eventId, 'manifest event id'] as const),
  ] as const) {
    assertHexDigest(value, label);
  }
  const { receiptChecksum, ...body } = receipt;
  if (finalizeBranchMutationReceiptV1(body).receiptChecksum !== receiptChecksum) {
    throw new Error('Branch receipt checksum mismatch.');
  }
  if (!Buffer.from(blob).equals(encodeBranchMutationReceiptV1(receipt))) {
    throw new Error('Branch receipt is not in exact canonical encoding.');
  }
  return receipt;
}

/** Decode a completion tombstone only after the caller has applied the SQLite length gate. */
export function decodeBranchMutationCompletionV1(blob: Uint8Array): BranchMutationCompletionV1 {
  const parsed = boundedJson(blob, BRANCH_COMPLETION_MAX_BYTES_V1, 'Branch completion');
  assertExactKeys(
    parsed,
    [
      'version',
      'receiptId',
      'targetThreadId',
      'targetGeneration',
      'requestDigest',
      'candidateDigest',
      'manifestDigest',
      'postSnapshotDigest',
      'completionChecksum',
    ],
    'Branch completion',
  );
  const completion = parsed as unknown as BranchMutationCompletionV1;
  if (
    completion.version !== 1 ||
    !completion.targetThreadId ||
    !Number.isSafeInteger(completion.targetGeneration) ||
    completion.targetGeneration < 1
  ) {
    throw new Error('Branch completion fields are invalid.');
  }
  for (const [value, label] of [
    [completion.receiptId, 'receipt id'],
    [completion.requestDigest, 'request digest'],
    [completion.candidateDigest, 'candidate digest'],
    [completion.manifestDigest, 'manifest digest'],
    [completion.postSnapshotDigest, 'post snapshot digest'],
    [completion.completionChecksum, 'completion checksum'],
  ] as const) {
    assertHexDigest(value, label);
  }
  const { completionChecksum, ...body } = completion;
  if (finalizeBranchMutationCompletionV1(body).completionChecksum !== completionChecksum) {
    throw new Error('Branch completion checksum mismatch.');
  }
  if (!Buffer.from(blob).equals(encodeBranchMutationCompletionV1(completion))) {
    throw new Error('Branch completion is not in exact canonical encoding.');
  }
  return completion;
}

function readU16(bytes: Buffer, offset: number): number {
  if (offset + 2 > bytes.length) throw new Error('BCTC frame is truncated.');
  return bytes.readUInt16BE(offset);
}

function readU32(bytes: Buffer, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error('BCTC frame is truncated.');
  return bytes.readUInt32BE(offset);
}

function readU64(bytes: Buffer, offset: number): number {
  if (offset + 8 > bytes.length) throw new Error('BCTC frame is truncated.');
  const value = bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 1n) {
    throw new Error('BCTC generation is invalid.');
  }
  return Number(value);
}

/** Exact BCTC decoder with bounded frames, role ordering and byte-for-byte re-encoding. */
export function decodeBranchCopiedTerminalClosureV1(
  blob: Uint8Array,
  closureChecksum: string,
): BranchCopiedTerminalClosureV1 {
  const bytes = Buffer.from(blob);
  if (bytes.length < 7 || bytes.length > BRANCH_CLOSURE_MAX_BYTES_V1) {
    throw new Error('BCTC closure length is out of bounds.');
  }
  if (!bytes.subarray(0, 4).equals(Buffer.from('BCTC')) || bytes[4] !== 1) {
    throw new Error('BCTC magic or version is invalid.');
  }
  const kind = bytes[5] === 1 ? 'success' : bytes[5] === 2 ? 'error_terminal' : undefined;
  const count = bytes[6]!;
  if (!kind || count !== (kind === 'success' ? 5 : 6)) {
    throw new Error('BCTC kind/count is invalid.');
  }
  let offset = 7;
  const readString = (): string => {
    const length = readU16(bytes, offset);
    offset += 2;
    if (length < 1 || length > 256 || offset + length > bytes.length) {
      throw new Error('BCTC string is out of bounds.');
    }
    const value = bytes.subarray(offset, offset + length).toString('utf8');
    offset += length;
    if (Buffer.byteLength(value, 'utf8') !== length)
      throw new Error('BCTC string is invalid UTF-8.');
    return value;
  };
  const targetThreadId = readString();
  const sourceThreadId = readString();
  const targetGeneration = readU64(bytes, offset);
  offset += 8;
  const sourceGeneration = readU64(bytes, offset);
  offset += 8;
  if (offset + 64 > bytes.length) throw new Error('BCTC proof fields are truncated.');
  const branchMutationReceiptId = bytes.subarray(offset, offset + 32).toString('hex');
  offset += 32;
  const sourceSelectedCutProofDigest = bytes.subarray(offset, offset + 32).toString('hex');
  offset += 32;
  const roles: BranchCopiedTerminalRoleV1[] =
    kind === 'success'
      ? [
          'continuation_consumed',
          'primary_resource_reserved',
          'primary_resource_dispatch_started',
          'primary_terminal',
          'resource_terminal',
        ]
      : [
          'continuation_consumed',
          'primary_resource_reserved',
          'primary_resource_dispatch_started',
          'primary_terminal',
          'resource_terminal',
          'turn_terminal',
        ];
  const envelopes: BranchCopiedTerminalEnvelopeV1[] = [];
  for (const role of roles) {
    const roleCode = bytes[offset++];
    if (roleCode !== ROLE_CODES[role]) throw new Error('BCTC role ordering is invalid.');
    const length = readU32(bytes, offset);
    offset += 4;
    if (
      length < 2 ||
      length > BRANCH_CLOSURE_EVENT_MAX_BYTES_V1 ||
      offset + length > bytes.length
    ) {
      throw new Error('BCTC envelope frame length is out of bounds.');
    }
    const parsed = boundedJson(
      bytes.subarray(offset, offset + length),
      BRANCH_CLOSURE_EVENT_MAX_BYTES_V1,
      'BCTC envelope',
    );
    offset += length;
    assertExactKeys(
      parsed,
      [
        'schemaVersion',
        'threadId',
        'generation',
        'eventId',
        'revision',
        'causationId',
        'occurredAt',
        'event',
      ],
      'BCTC envelope',
    );
    const record = parsed as Record<string, unknown>;
    const envelope = {
      schemaVersion: record.schemaVersion,
      threadId: record.threadId,
      generation: record.generation,
      eventId: record.eventId,
      revision: record.revision,
      causationId: record.causationId,
      occurredAt: record.occurredAt,
      payload: record.event,
    } as RuntimeEventEnvelopeV24;
    envelopes.push({ role, envelope });
  }
  if (offset !== bytes.length) throw new Error('BCTC closure has trailing bytes.');
  const body: Omit<BranchCopiedTerminalClosureV1, 'closureChecksum'> = {
    version: 1,
    targetThreadId,
    targetGeneration,
    branchMutationReceiptId,
    sourceThreadId,
    sourceGeneration,
    sourceSelectedCutProofDigest,
    terminal:
      kind === 'success'
        ? { kind, envelopes }
        : {
            kind,
            outcome:
              envelopes[4]?.envelope.payload.type === 'resource_budget.released'
                ? 'provider_admission_denied'
                : 'unknown_external_outcome',
            envelopes,
          },
  };
  const finalized = finalizeBranchCopiedTerminalClosureV1(body);
  assertHexDigest(closureChecksum, 'closure checksum');
  if (
    finalized.closureChecksum !== closureChecksum ||
    !bytes.equals(encodeBranchCopiedTerminalClosureV1(body))
  ) {
    throw new Error('BCTC checksum or canonical re-encoding mismatch.');
  }
  return finalized;
}

export function finalizeBranchMutationCompletionV1(
  completion: Omit<BranchMutationCompletionV1, 'completionChecksum'>,
): BranchMutationCompletionV1 {
  const finalized = {
    ...completion,
    completionChecksum: digest('branch-mutation-completion:v1', canonical(completion)),
  };
  encodeBranchMutationCompletionV1(finalized);
  return finalized;
}

export function manifestDigestV1(input: {
  manifest:
    | BranchMutationEventManifestV1
    | { kind: 'none'; eventIds: string[]; eventTypes: string[] };
  baseRevision: number;
  finalRevision: number;
  payloadDigests: readonly string[];
}): string {
  return canonicalContextDigestV3('branch-mutation-manifest:v1', input);
}

export function sameConsumptionKeyV1(
  left: NormalReprepareConsumptionKeyV1 | undefined,
  right: NormalReprepareConsumptionKeyV1,
): boolean {
  return canonical(left) === canonical(right);
}
