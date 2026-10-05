import { ClientError, decodeResponse, validateRequest } from './decode';
import type {
  Command,
  ExtensionCommandRequest,
  FileCheckpoint,
  ForkSessionRequest,
} from './generated/api';
import { canonicalModelBody } from './model-input';
import { parseCursorSequence } from './sse';

export type FileRecoveryPhase =
  | 'not_started'
  | 'prepared'
  | 'submitting'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'unknown';
export type FileRecoveryLeg = 'code' | 'fork';
export interface FileRecoveryIdentity {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  subjectId: string;
}
export interface FileRecoveryPreparationScope extends FileRecoveryIdentity {
  contextSelectionId: string;
}
export interface FileRecoveryBoundary {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  contextSelectionId: string;
  checkpoint: FileCheckpoint;
  boundary: null | { messageId: string; seq: string };
  trigger: { messageId: string; seq: string };
}
export interface FileRecoveryIntent extends FileRecoveryIdentity {
  version: 1;
  scope: 'session' | 'code' | 'both';
  contextSelectionId: string;
  checkpoint: FileCheckpoint;
  boundary: FileRecoveryBoundary['boundary'];
  trigger: FileRecoveryBoundary['trigger'];
  code: null | {
    request: ExtensionCommandRequest;
    requestDigest: string;
    phase: FileRecoveryPhase;
  };
  fork: null | {
    request: ForkSessionRequest & { boundary: FileRecoveryBoundary['boundary'] };
    requestDigest: string;
    phase: FileRecoveryPhase;
  };
}
export interface FileRecoveryCodeProof {
  command: unknown;
  restoreStatus: unknown;
}
const validatedIntents = new WeakSet<object>();
const phases = new Set<FileRecoveryPhase>([
  'not_started',
  'prepared',
  'submitting',
  'pending',
  'succeeded',
  'failed',
  'unknown',
]);
function invalid(): never {
  throw new ClientError('file_recovery_intent_invalid');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) invalid();
  return record;
}
function text(value: unknown, max = 128): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    [...value].length > max ||
    new TextEncoder().encode(value).length > max * 4
  )
    invalid();
}
function id(value: unknown): asserts value is string {
  text(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid();
}
function decimal(value: unknown) {
  if (typeof value !== 'string') invalid();
  parseCursorSequence(value);
}
function boundary(value: unknown, nullable: boolean) {
  if (value === null && nullable) return;
  const b = object(value, ['messageId', 'seq']);
  id(b.messageId);
  decimal(b.seq);
  if (b.seq === '0') invalid();
}
function checkpoint(value: unknown) {
  const p = object(value, ['id', 'boundary', 'workspace']);
  if (typeof p.id !== 'string' || !/^[a-f0-9]{64}$/.test(p.id)) invalid();
  const b = object(p.boundary, [
    'storeId',
    'workspaceId',
    'sessionId',
    'runId',
    'contextSelectionId',
    'messageId',
    'messageSeq',
    'triggerMessageId',
    'triggerSeq',
  ]);
  for (const key of [
    'storeId',
    'workspaceId',
    'sessionId',
    'runId',
    'contextSelectionId',
    'triggerMessageId',
  ])
    id(b[key]);
  decimal(b.messageSeq);
  decimal(b.triggerSeq);
  if (b.messageId === null) {
    if (b.messageSeq !== '0') invalid();
  } else {
    id(b.messageId);
    if (b.messageSeq === '0') invalid();
  }
  if (BigInt(b.triggerSeq as string) <= BigInt(b.messageSeq as string)) invalid();
  const w = object(p.workspace, ['device', 'inode']);
  for (const v of Object.values(w))
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) invalid();
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function canonicalFileRecoveryCodeRequest(request: ExtensionCommandRequest): string {
  validateRequest('ExtensionCommandRequest', request);
  object(request, [
    'expectedStoreId',
    'commandId',
    'kind',
    'extensionId',
    'actionId',
    'definitionVersion',
    'input',
  ]);
  if (
    request.extensionId !== 'builtin.files' ||
    request.actionId !== 'files.checkpoint.restore' ||
    request.definitionVersion !== '1'
  )
    invalid();
  const input = object(request.input, ['checkpointId', 'restoreId']);
  if (typeof input.checkpointId !== 'string' || !/^[a-f0-9]{64}$/.test(input.checkpointId))
    invalid();
  if (typeof input.restoreId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.restoreId))
    invalid();
  // Service passes actionId unchanged to Store; definitionId belongs to the execution, not request digest.
  return canonicalModelBody({
    kind: request.kind,
    extensionId: request.extensionId,
    actionId: request.actionId,
    definitionVersion: request.definitionVersion,
    input: request.input,
  });
}
export function canonicalFileRecoveryForkRequest(
  sourceSessionId: string,
  request: ForkSessionRequest,
): string {
  id(sourceSessionId);
  validateRequest('ForkSessionRequest', request);
  object(request, [
    'expectedStoreId',
    'commandId',
    'expectedContextSelectionId',
    'boundary',
    'newSessionId',
    'title',
  ]);
  boundary(request.boundary, true);
  if (new TextEncoder().encode(request.title).length > 4096) invalid();
  return canonicalModelBody({
    kind: 'session.create',
    title: request.title,
    fork: {
      sourceSessionId,
      expectedContextSelectionId: request.expectedContextSelectionId,
      boundary: request.boundary,
    },
  });
}
/** Phase is local observation; immutable request identity never changes with its progress. */
export function canonicalFileRecoveryIntent(intent: FileRecoveryIntent): string {
  const { code, fork, ...rest } = intent;
  return canonicalModelBody({
    ...rest,
    code: code ? { request: code.request, requestDigest: code.requestDigest } : null,
    fork: fork ? { request: fork.request, requestDigest: fork.requestDigest } : null,
  });
}
export async function parseFileRecoveryIntent(value: unknown): Promise<FileRecoveryIntent> {
  const copy = structuredClone(value);
  const i = object(copy, [
    'version',
    'scope',
    'storeId',
    'sessionId',
    'workspaceId',
    'subjectId',
    'contextSelectionId',
    'checkpoint',
    'boundary',
    'trigger',
    'code',
    'fork',
  ]);
  if (i.version !== 1 || !['session', 'code', 'both'].includes(i.scope as string)) invalid();
  for (const key of ['storeId', 'sessionId', 'workspaceId', 'contextSelectionId']) id(i[key]);
  text(i.subjectId, 256);
  checkpoint(i.checkpoint);
  boundary(i.boundary, true);
  boundary(i.trigger, false);
  if (
    i.boundary &&
    BigInt((i.boundary as { seq: string }).seq) >= BigInt((i.trigger as { seq: string }).seq)
  )
    invalid();
  if ((i.code === null) !== (i.scope === 'session') || (i.fork === null) !== (i.scope === 'code'))
    invalid();
  for (const name of ['code', 'fork'] as const) {
    if (i[name] === null) continue;
    const leg = object(i[name], ['request', 'requestDigest', 'phase']);
    if (
      !phases.has(leg.phase as FileRecoveryPhase) ||
      typeof leg.requestDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(leg.requestDigest)
    )
      invalid();
    const r = leg.request as ExtensionCommandRequest & ForkSessionRequest;
    const canonical =
      name === 'code'
        ? canonicalFileRecoveryCodeRequest(r)
        : canonicalFileRecoveryForkRequest(i.sessionId as string, r);
    if (r.expectedStoreId !== i.storeId || (await digest(canonical)) !== leg.requestDigest)
      invalid();
    if (
      name === 'code' &&
      (r.input as { checkpointId: string }).checkpointId !== (i.checkpoint as FileCheckpoint).id
    )
      invalid();
    if (
      name === 'fork' &&
      (r.expectedContextSelectionId !== i.contextSelectionId ||
        canonicalModelBody(r.boundary) !== canonicalModelBody(i.boundary) ||
        r.newSessionId === i.sessionId)
    )
      invalid();
  }
  const intent = copy as FileRecoveryIntent;
  if (intent.code && intent.fork && intent.code.request.commandId === intent.fork.request.commandId)
    invalid();
  if (
    intent.scope === 'both' &&
    intent.fork!.phase !== 'not_started' &&
    intent.code!.phase !== 'succeeded'
  )
    invalid();
  validatedIntents.add(intent);
  return frozen(intent);
}
export async function planFileRecoveryIntent(input: {
  scope: FileRecoveryIntent['scope'];
  observation: FileRecoveryBoundary;
  subjectId: string;
  code?: { commandId: string; restoreId: string };
  fork?: { commandId: string; newSessionId: string; title: string };
}): Promise<FileRecoveryIntent> {
  object(input, [
    'scope',
    'observation',
    'subjectId',
    ...(input.code ? ['code'] : []),
    ...(input.fork ? ['fork'] : []),
  ]);
  object(input.observation, [
    'storeId',
    'sessionId',
    'workspaceId',
    'contextSelectionId',
    'checkpoint',
    'boundary',
    'trigger',
  ]);
  if (input.code) object(input.code, ['commandId', 'restoreId']);
  if (input.fork) object(input.fork, ['commandId', 'newSessionId', 'title']);
  const o = structuredClone(input.observation);
  const code: FileRecoveryIntent['code'] = input.code
    ? {
        request: {
          expectedStoreId: o.storeId,
          commandId: input.code.commandId,
          kind: 'extension.invoke',
          extensionId: 'builtin.files',
          actionId: 'files.checkpoint.restore',
          definitionVersion: '1',
          input: { checkpointId: o.checkpoint.id, restoreId: input.code.restoreId },
        },
        requestDigest: '',
        phase: 'not_started',
      }
    : null;
  const fork: FileRecoveryIntent['fork'] = input.fork
    ? {
        request: {
          expectedStoreId: o.storeId,
          commandId: input.fork.commandId,
          expectedContextSelectionId: o.contextSelectionId,
          boundary: o.boundary,
          newSessionId: input.fork.newSessionId,
          title: input.fork.title,
        },
        requestDigest: '',
        phase: 'not_started',
      }
    : null;
  if (code) code.requestDigest = await digest(canonicalFileRecoveryCodeRequest(code.request));
  if (fork)
    fork.requestDigest = await digest(canonicalFileRecoveryForkRequest(o.sessionId, fork.request));
  return parseFileRecoveryIntent({
    version: 1,
    scope: input.scope,
    ...o,
    subjectId: input.subjectId,
    code,
    fork,
  });
}
export function canTransitionFileRecoveryPhase(
  from: FileRecoveryPhase,
  to: FileRecoveryPhase,
): boolean {
  if (from === to) return true;
  if (from === 'succeeded' || from === 'failed') return false;
  if (to === 'not_started') return false;
  if (to === 'prepared') return from === 'not_started';
  if (to === 'submitting') return from === 'prepared';
  return ['pending', 'succeeded', 'failed', 'unknown'].includes(to);
}
function phase(
  intent: FileRecoveryIntent,
  leg: FileRecoveryLeg,
  next: FileRecoveryPhase,
): FileRecoveryIntent {
  const current = intent[leg];
  if (!current) invalid();
  if (!canTransitionFileRecoveryPhase(current.phase, next)) return intent;
  const result = frozen({ ...intent, [leg]: { ...current, phase: next } });
  validatedIntents.add(result);
  return result;
}
export function isFileRecoveryIdentity(intent: FileRecoveryIntent, actual: FileRecoveryIdentity) {
  return (
    intent.storeId === actual.storeId &&
    intent.sessionId === actual.sessionId &&
    intent.workspaceId === actual.workspaceId &&
    intent.subjectId === actual.subjectId
  );
}
function command(intent: FileRecoveryIntent, leg: FileRecoveryLeg, value: unknown): Command {
  const c = decodeResponse('Command', structuredClone(value)),
    r = intent[leg];
  if (!r) invalid();
  if (
    c.id !== r.request.commandId ||
    c.originStoreId !== intent.storeId ||
    c.subjectId !== intent.subjectId ||
    c.requestDigest !== r.requestDigest ||
    c.sessionId !== (leg === 'code' ? intent.sessionId : intent.fork!.request.newSessionId) ||
    c.kind !== (leg === 'code' ? 'extension.invoke' : 'session.create')
  )
    invalid();
  return c;
}
function codeState(intent: FileRecoveryIntent, proof: FileRecoveryCodeProof): FileRecoveryPhase {
  const c = command(intent, 'code', proof.command);
  if (c.status === 'rejected') return 'failed';
  if (c.status !== 'applied') return c.status === 'accepted' ? 'pending' : 'unknown';
  const receipt = c.receipt;
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    typeof receipt.executionId !== 'string' ||
    receipt.preparingNextAttempt !== false
  )
    return 'unknown';
  const s = decodeResponse('FileRestoreStatus', structuredClone(proof.restoreStatus)),
    j = s.payload.journal,
    e = s.payload.execution;
  if (
    s.storeId !== intent.storeId ||
    s.sessionId !== intent.sessionId ||
    s.workspaceId !== intent.workspaceId ||
    !j ||
    !('executionId' in j) ||
    j.id !== (intent.code!.request.input as { restoreId: string }).restoreId ||
    j.checkpointId !== intent.checkpoint.id ||
    j.executionId !== receipt.executionId ||
    e?.id !== receipt.executionId
  )
    return 'unknown';
  if (j.phase === 'outcome_unknown' || e.status === 'outcome_unknown') return 'unknown';
  if (e.status === 'failed' || e.status === 'cancelled') return 'failed';
  if (e.status !== 'succeeded') return 'pending';
  if (
    j.phase !== 'restored' ||
    !('rootWorkSeq' in j) ||
    !j.files.every(
      (f) =>
        'confirmedPost' in f &&
        f.confirmedPost !== null &&
        ((f.operation === 'remove' && f.state === 'removed' && f.confirmedPost.baseline === null) ||
          (f.operation === 'restore' &&
            f.state === 'restored' &&
            f.original !== null &&
            f.confirmedPost.baseline?.hash === f.original.hash &&
            f.confirmedPost.baseline.size === f.original.size) ||
          (f.operation === 'unchanged' &&
            f.state === 'unchanged' &&
            (f.original === null
              ? f.confirmedPost.baseline === null
              : f.confirmedPost.baseline?.hash === f.original.hash &&
                f.confirmedPost.baseline.size === f.original.size))),
    )
  )
    return 'unknown';
  return 'succeeded';
}
function forkState(intent: FileRecoveryIntent, value: unknown): FileRecoveryPhase {
  const c = command(intent, 'fork', value);
  if (c.status === 'rejected') return 'failed';
  if (c.status !== 'applied') return c.status === 'accepted' ? 'pending' : 'unknown';
  const r = c.receipt;
  if (
    !r ||
    typeof r !== 'object' ||
    Array.isArray(r) ||
    r.sessionId !== intent.fork!.request.newSessionId ||
    r.sourceSessionId !== intent.sessionId ||
    r.sourceSelectionId !== intent.contextSelectionId ||
    r.sourceUpperSeq !== (intent.boundary?.seq ?? '0') ||
    typeof r.selectionId !== 'string' ||
    typeof r.omittedExtensionState !== 'boolean' ||
    !Array.isArray(r.namespaceReport)
  )
    return 'unknown';
  id(r.selectionId);
  const seen = new Set<string>();
  let omitted = false;
  for (const entry of r.namespaceReport) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'unknown';
    const report = object(entry, [
      'extensionId',
      'contentType',
      'contentVersion',
      'mode',
      'ruleVersion',
      'copied',
      'rebuilt',
      'omitted',
    ]);
    for (const field of ['extensionId', 'contentType']) text(report[field], 256);
    if (
      !Number.isSafeInteger(report.contentVersion) ||
      (report.contentVersion as number) < 1 ||
      !['copy', 'rebuild', 'omit'].includes(report.mode as string)
    )
      return 'unknown';
    if (report.ruleVersion !== null) text(report.ruleVersion, 128);
    for (const field of ['copied', 'rebuilt', 'omitted'])
      if (!Number.isSafeInteger(report[field]) || (report[field] as number) < 0) return 'unknown';
    if (
      (report.mode !== 'copy' && report.copied !== 0) ||
      (report.mode !== 'rebuild' && report.rebuilt !== 0) ||
      (report.mode !== 'omit' && report.omitted !== 0)
    )
      return 'unknown';
    const key = canonicalModelBody([report.extensionId, report.contentType, report.contentVersion]);
    if (seen.has(key)) return 'unknown';
    seen.add(key);
    omitted ||= (report.omitted as number) > 0;
  }
  if (r.omittedExtensionState !== omitted) return 'unknown';
  return 'succeeded';
}
/** Missing, malformed or foreign receipts remain unknown; known terminal facts never regress. */
export function observeFileRecoveryLeg(
  intent: FileRecoveryIntent,
  leg: FileRecoveryLeg,
  actual: FileRecoveryIdentity,
  proof: unknown,
): FileRecoveryIntent {
  if (!validatedIntents.has(intent) || !isFileRecoveryIdentity(intent, actual)) return intent;
  if (leg === 'fork' && intent.scope === 'both' && intent.code!.phase !== 'succeeded')
    return intent;
  try {
    return phase(
      intent,
      leg,
      leg === 'code' ? codeState(intent, proof as FileRecoveryCodeProof) : forkState(intent, proof),
    );
  } catch {
    return phase(intent, leg, 'unknown');
  }
}
function currentCodeDetail(
  intent: FileRecoveryIntent,
  actual: FileRecoveryPreparationScope,
  value: unknown,
  proof: FileRecoveryCodeProof,
): void {
  const detail = decodeResponse('FileCheckpointDetail', structuredClone(value));
  object(detail, ['storeId', 'sessionId', 'workspaceId', 'payload']);
  object(detail.payload, ['checkpoint', 'files']);
  checkpoint(detail.payload.checkpoint);
  if (
    detail.storeId !== actual.storeId ||
    detail.sessionId !== actual.sessionId ||
    detail.workspaceId !== actual.workspaceId ||
    canonicalModelBody(detail.payload.checkpoint) !== canonicalModelBody(intent.checkpoint)
  )
    invalid();
  const paths = new Set<string>();
  for (const file of detail.payload.files) {
    if (paths.has(file.path)) invalid();
    paths.add(file.path);
    object(file, [
      'path',
      'recordRevision',
      'status',
      'reason',
      'preimage',
      'original',
      'expected',
    ]);
    if (file.status !== 'unchanged') invalid();
    for (const baseline of [file.original, file.expected])
      if (baseline !== null) object(baseline, ['hash', 'size', 'device', 'inode']);
    if (file.preimage !== null) {
      object(file.preimage, ['id', 'mediaType', 'size', 'scope']);
      object(file.preimage.scope, ['kind', 'id']);
    }
  }
  const status = decodeResponse('FileRestoreStatus', structuredClone(proof.restoreStatus));
  const journal = status.payload.journal;
  if (!journal || !('files' in journal) || !journal.files.every((file) => paths.has(file.path)))
    invalid();
}

export interface FileRecoveryHotPermit {
  readonly kind: 'file_recovery_hot_permit';
}
const permits = new WeakMap<
  FileRecoveryHotPermit,
  { identity: string; leg: FileRecoveryLeg; used: boolean }
>();
const issued = new Set<string>();
export function prepareFileRecoveryLeg(
  intent: FileRecoveryIntent,
  leg: FileRecoveryLeg,
  actual: FileRecoveryPreparationScope,
  input: { explicitContinue: true; codeProof?: FileRecoveryCodeProof; currentDetail?: unknown },
): { intent: FileRecoveryIntent; permit: FileRecoveryHotPermit } {
  if (
    !validatedIntents.has(intent) ||
    !isFileRecoveryIdentity(intent, actual) ||
    actual.contextSelectionId !== intent.contextSelectionId ||
    input.explicitContinue !== true ||
    intent[leg]?.phase !== 'not_started'
  )
    throw new ClientError('file_recovery_readonly');
  if (leg === 'fork' && intent.scope === 'both') {
    try {
      if (!input.codeProof || codeState(intent, input.codeProof) !== 'succeeded') invalid();
      currentCodeDetail(intent, actual, input.currentDetail, input.codeProof);
    } catch {
      throw new ClientError('file_recovery_code_unconfirmed');
    }
  }
  const key = canonicalModelBody({
    storeId: intent.storeId,
    commandId: intent[leg]!.request.commandId,
  });
  if (issued.has(key)) throw new ClientError('file_recovery_readonly');
  issued.add(key);
  const base =
    leg === 'fork' && intent.scope === 'both' ? phase(intent, 'code', 'succeeded') : intent;
  if (leg === 'fork' && base.scope === 'both' && base.code!.phase !== 'succeeded')
    throw new ClientError('file_recovery_code_unconfirmed');
  const next = phase(base, leg, 'prepared'),
    permit = Object.freeze({ kind: 'file_recovery_hot_permit' as const });
  permits.set(permit, { identity: canonicalFileRecoveryIntent(next), leg, used: false });
  return { intent: next, permit };
}
/** The sole mutation hook: one hot permit, durable submitting acknowledgement, then one original POST. */
export async function submitFileRecoveryLeg(
  intent: FileRecoveryIntent,
  leg: FileRecoveryLeg,
  permit: FileRecoveryHotPermit,
  port: {
    currentScope: () => FileRecoveryPreparationScope;
    persist: (intent: FileRecoveryIntent) => Promise<void>;
    post: (request: ExtensionCommandRequest | ForkSessionRequest) => Promise<unknown>;
  },
): Promise<{ intent: FileRecoveryIntent; response?: unknown }> {
  const hot = permits.get(permit);
  if (
    !hot ||
    hot.used ||
    hot.leg !== leg ||
    hot.identity !== canonicalFileRecoveryIntent(intent) ||
    intent[leg]?.phase !== 'prepared'
  )
    throw new ClientError('file_recovery_readonly');
  hot.used = true;
  const submitting = phase(intent, leg, 'submitting');
  // A failed persistence never permits POST or a second attempt; the caller keeps the original identity.
  await port.persist(submitting);
  try {
    const current = port.currentScope();
    if (
      !isFileRecoveryIdentity(intent, current) ||
      current.contextSelectionId !== intent.contextSelectionId
    )
      return { intent: phase(submitting, leg, 'unknown') };
    return { intent: submitting, response: await port.post(structuredClone(intent[leg]!.request)) };
  } catch {
    return { intent: phase(submitting, leg, 'unknown') };
  }
}

/** Cold observation owns no permit: only the original Command and, if bound, original status GET. */
export async function lookupFileRecoveryLeg(
  intent: FileRecoveryIntent,
  leg: FileRecoveryLeg,
  actual: FileRecoveryIdentity,
  port: {
    getCommand: (commandId: string) => Promise<unknown>;
    getRestoreStatus: (sessionId: string, pointId: string, restoreId: string) => Promise<unknown>;
  },
): Promise<FileRecoveryIntent> {
  if (!validatedIntents.has(intent) || !isFileRecoveryIdentity(intent, actual) || !intent[leg])
    return intent;
  if (leg === 'fork' && intent.scope === 'both' && intent.code!.phase !== 'succeeded')
    return intent;
  try {
    const original = await port.getCommand(intent[leg]!.request.commandId);
    const c = command(intent, leg, original);
    if (leg === 'fork') return observeFileRecoveryLeg(intent, leg, actual, c);
    let restoreStatus: unknown;
    if (c.status === 'applied')
      restoreStatus = await port.getRestoreStatus(
        intent.sessionId,
        intent.checkpoint.id,
        (intent.code!.request.input as { restoreId: string }).restoreId,
      );
    return observeFileRecoveryLeg(intent, leg, actual, { command: c, restoreStatus });
  } catch {
    return phase(intent, leg, 'unknown');
  }
}
