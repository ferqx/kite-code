import { isDeepStrictEqual } from 'node:util';
import type { ModelMessage } from '@kite-ai/ai';
import { parseShellCommandInput, shellOperationKey } from './shell-input';
import type { ExecutionAuthorizationObservation, ExecutionRecord, Json } from './storage/types';

/** Tool-owned observations are evidence data, never permission or a completion predicate. */
export interface ToolObservation {
  kind: 'lookup' | 'inspection';
  scope: string;
  query?: string;
  sources: { path: string; version: string; fromLine?: number; toLine?: number }[];
  matchCount?: number;
  /** Counted result unit; legacy lookups without this field counted matching lines. */
  matchUnit?: 'files' | 'lines';
  complete: boolean;
  coverage: 'file' | 'window' | 'page';
  next?: string | null;
  windowComplete?: boolean;
  excerpt?: { text: string; truncated: boolean };
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

export function toolObservation(content: string): ToolObservation | undefined {
  let value: Record<string, unknown> | undefined;
  try {
    value = object(object(JSON.parse(content))?.observation);
  } catch {
    return;
  }
  if (
    !value ||
    !['lookup', 'inspection'].includes(String(value.kind)) ||
    typeof value.scope !== 'string' ||
    typeof value.complete !== 'boolean' ||
    !['file', 'window', 'page'].includes(String(value.coverage)) ||
    (value.query !== undefined && typeof value.query !== 'string') ||
    (value.matchCount !== undefined &&
      (!Number.isSafeInteger(value.matchCount) || Number(value.matchCount) < 0)) ||
    (value.matchUnit !== undefined && !['files', 'lines'].includes(String(value.matchUnit))) ||
    (value.next !== undefined && value.next !== null && typeof value.next !== 'string') ||
    (value.windowComplete !== undefined && typeof value.windowComplete !== 'boolean') ||
    !Array.isArray(value.sources)
  )
    return;
  const sources: ToolObservation['sources'] = [];
  const excerpt = value.excerpt === undefined ? undefined : object(value.excerpt);
  if (
    value.excerpt !== undefined &&
    (!excerpt || typeof excerpt.text !== 'string' || typeof excerpt.truncated !== 'boolean')
  )
    return;
  for (const item of value.sources) {
    const source = object(item);
    if (
      !source ||
      typeof source.path !== 'string' ||
      typeof source.version !== 'string' ||
      !source.version ||
      (source.fromLine !== undefined && !positive(source.fromLine)) ||
      (source.toLine !== undefined && !positive(source.toLine)) ||
      (source.fromLine !== undefined &&
        source.toLine !== undefined &&
        Number(source.toLine) < Number(source.fromLine))
    )
      return;
    sources.push({
      path: source.path,
      version: source.version,
      ...(source.fromLine === undefined ? {} : { fromLine: Number(source.fromLine) }),
      ...(source.toLine === undefined ? {} : { toLine: Number(source.toLine) }),
    });
  }
  return {
    kind: value.kind as ToolObservation['kind'],
    scope: value.scope,
    sources,
    complete: value.complete,
    coverage: value.coverage as ToolObservation['coverage'],
    ...(value.query === undefined ? {} : { query: String(value.query) }),
    ...(value.matchCount === undefined ? {} : { matchCount: Number(value.matchCount) }),
    ...(value.matchUnit === undefined
      ? {}
      : { matchUnit: value.matchUnit as ToolObservation['matchUnit'] }),
    ...(value.next === undefined ? {} : { next: value.next as string | null }),
    ...(value.windowComplete === undefined ? {} : { windowComplete: value.windowComplete }),
    ...(excerpt
      ? { excerpt: { text: String(excerpt.text), truncated: excerpt.truncated as boolean } }
      : {}),
  };
}

/** Public, bounded original Shell receipt data; it does not certify task success. */
type ShellAuthorization = {
  check?: Pick<
    NonNullable<ExecutionAuthorizationObservation['check']>,
    'status' | 'decision' | 'requireApproval'
  >;
  human?: Pick<NonNullable<ExecutionAuthorizationObservation['human']>, 'accepted' | 'decision'>;
  policy?: Pick<NonNullable<ExecutionAuthorizationObservation['policy']>, 'reason'>;
};
export interface ShellReceipt {
  executionId: string;
  callId: string;
  tool: string;
  definitionVersion: string;
  command: { text: string; bytes: number; truncated: boolean };
  requestedPermissions: Json;
  /** Saved observations from the identified original Tool and Job; never a new grant. */
  authorization?: { tool?: ShellAuthorization; job?: ShellAuthorization };
  job: {
    executionId: string;
    definitionVersion: string;
    status: string;
    dispatched: boolean | null;
    effectiveScope: Json;
    exitCode: number | null;
  };
  stdout: { text: string; bytes: string | null; truncated: boolean; omitted: boolean };
  stderr: { text: string; bytes: string | null; truncated: boolean; omitted: boolean };
}
const terminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'];
const allowedKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const scope = (value: unknown) => {
  const data = object(value);
  return (
    !!data &&
    allowedKeys(data, ['filesystem', 'network']) &&
    ['workspace_write', 'full_access'].includes(String(data.filesystem)) &&
    ['none', 'internet'].includes(String(data.network))
  );
};
/** Exact known presentation only; unknown fields fall back to the retained raw Source. */
export function isShellReceipt(value: unknown): value is ShellReceipt {
  const data = object(value),
    command = object(data?.command),
    job = object(data?.job);
  if (
    !data ||
    !allowedKeys(data, [
      'executionId',
      'callId',
      'tool',
      'definitionVersion',
      'command',
      'requestedPermissions',
      'authorization',
      'job',
      'stdout',
      'stderr',
    ]) ||
    !['executionId', 'callId', 'definitionVersion'].every(
      (key) => typeof data[key] === 'string' && data[key],
    ) ||
    !['shell.execute', 'shell.launch'].includes(String(data.tool)) ||
    !command ||
    !allowedKeys(command, ['text', 'bytes', 'truncated']) ||
    typeof command.text !== 'string' ||
    !Number.isSafeInteger(command.bytes) ||
    Number(command.bytes) < Buffer.byteLength(command.text) ||
    typeof command.truncated !== 'boolean' ||
    !(data.requestedPermissions === null || scope(data.requestedPermissions)) ||
    !job ||
    !allowedKeys(job, [
      'executionId',
      'definitionVersion',
      'status',
      'dispatched',
      'effectiveScope',
      'exitCode',
    ]) ||
    typeof job.executionId !== 'string' ||
    !job.executionId ||
    typeof job.definitionVersion !== 'string' ||
    !job.definitionVersion ||
    !['planned', 'dispatching', 'running', ...terminal].includes(String(job.status)) ||
    !(job.dispatched === null || typeof job.dispatched === 'boolean') ||
    !(job.effectiveScope === null || scope(job.effectiveScope)) ||
    !(job.exitCode === null || Number.isSafeInteger(job.exitCode))
  )
    return false;
  if (data.authorization !== undefined) {
    const authorization = object(data.authorization);
    if (
      !authorization ||
      !Object.keys(authorization).length ||
      !allowedKeys(authorization, ['tool', 'job']) ||
      !Object.values(authorization).every(isShellAuthorization)
    )
      return false;
  }
  return ['stdout', 'stderr'].every((key) => {
    const stream = object(data[key]);
    return (
      !!stream &&
      allowedKeys(stream, ['text', 'bytes', 'truncated', 'omitted']) &&
      typeof stream.text === 'string' &&
      typeof stream.truncated === 'boolean' &&
      typeof stream.omitted === 'boolean' &&
      (stream.bytes === null ||
        (typeof stream.bytes === 'string' && /^(0|[1-9][0-9]*)$/.test(stream.bytes)))
    );
  });
}
function isShellAuthorization(value: unknown): boolean {
  const data = object(value);
  if (!data || !Object.keys(data).length || !allowedKeys(data, ['check', 'human', 'policy']))
    return false;
  if (data.check !== undefined) {
    const check = object(data.check);
    if (
      !check ||
      !allowedKeys(check, ['status', 'decision', 'requireApproval']) ||
      !['planned', 'dispatching', 'running', ...terminal].includes(String(check.status)) ||
      !['approve_once', 'reject', 'ask_user', 'unavailable'].includes(String(check.decision)) ||
      typeof check.requireApproval !== 'boolean'
    )
      return false;
  }
  if (data.human !== undefined) {
    const human = object(data.human);
    if (
      !human ||
      !allowedKeys(human, ['accepted', 'decision']) ||
      typeof human.accepted !== 'boolean' ||
      !(human.decision === null || ['approve', 'deny'].includes(String(human.decision)))
    )
      return false;
  }
  if (data.policy !== undefined) {
    const policy = object(data.policy);
    if (
      !policy ||
      !allowedKeys(policy, ['reason']) ||
      !['reused_approval', 'parent_review', 'timeout_continue'].includes(String(policy.reason))
    )
      return false;
  }
  return true;
}
function shellAuthorization(
  observation: ExecutionAuthorizationObservation | undefined,
): ShellAuthorization | undefined {
  if (!observation) return;
  const { check, human, policy } = observation;
  const result = {
    ...(check
      ? {
          check: {
            status: check.status,
            decision: check.decision,
            requireApproval: check.requireApproval,
          },
        }
      : {}),
    ...(human ? { human: { accepted: human.accepted, decision: human.decision } } : {}),
    ...(policy ? { policy: { reason: policy.reason } } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}
function preview(text: string, limit: number) {
  // Never split a Unicode code point and inflate the preview with replacement characters.
  let result = '';
  let usedBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (usedBytes + bytes > limit) break;
    result += character;
    usedBytes += bytes;
  }
  return result;
}
async function recordedShellReceipt(
  execution: ExecutionRecord,
  getExecution: (id: string) => Promise<ExecutionRecord | null>,
  isRegisteredShell: (tool: ExecutionRecord, job: ExecutionRecord) => boolean,
): Promise<ShellReceipt | undefined> {
  if (!['shell.execute', 'shell.launch'].includes(execution.definitionId)) return;
  const input = object(execution.input),
    result = object(execution.result),
    details = object(result?.details);
  const ref = object(details?.ref),
    jobId = ref?.executionId;
  if (
    !input ||
    typeof input.command !== 'string' ||
    !ref ||
    typeof jobId !== 'string' ||
    ref.extensionId !== 'builtin.shell' ||
    ref.key !== shellOperationKey(input.key as Json | undefined, execution.id) ||
    ref.sessionId !== execution.sessionId ||
    ref.originStoreId !== execution.originStoreId
  )
    return;
  const toolCommand = parseShellCommandInput(
    execution.input,
    execution.definitionId === 'shell.execute' ? 'execute' : 'launch',
    true,
  );
  if (!toolCommand) return;
  const job = await getExecution(jobId);
  if (
    job?.kind !== 'job' ||
    job.id !== jobId ||
    job.definitionId !== 'shell.command' ||
    job.sessionId !== execution.sessionId ||
    job.originStoreId !== execution.originStoreId ||
    job.parentExecutionId !== execution.id ||
    job.originCommandId !== ref.commandId ||
    job.rootWorkCommandId !== execution.rootWorkCommandId ||
    job.rootWorkSeq !== execution.rootWorkSeq ||
    !isRegisteredShell(execution, job)
  )
    return;
  const jobInput = parseShellCommandInput(job.input, 'job', true);
  if (
    jobInput?.command !== input.command ||
    !isDeepStrictEqual(jobInput.permissions ?? null, toolCommand.permissions ?? null)
  )
    return;
  const requestedPermissions = toolCommand.permissions ?? null;
  if (requestedPermissions !== null && !scope(requestedPermissions)) return;
  const jobDetails = object(object(job.result)?.details);
  const effectiveScope = job.authorization?.policy?.effectiveScope ?? null;
  const toolAuthorization = shellAuthorization(execution.authorization);
  const jobAuthorization = shellAuthorization(job.authorization);
  const stream = (key: 'stdout' | 'stderr') => {
    const original = typeof details?.[key] === 'string' ? (details[key] as string) : undefined;
    const text = original === undefined ? '' : preview(original, 4096);
    const count = details?.[`${key}Bytes`];
    const bytes = typeof count === 'string' && /^(0|[1-9][0-9]*)$/.test(count) ? count : null;
    return {
      text,
      bytes,
      omitted: original === undefined,
      truncated:
        original !== undefined &&
        (text !== original ||
          details?.truncated === true ||
          (bytes !== null && BigInt(bytes) > BigInt(Buffer.byteLength(text))) ||
          (typeof details?.droppedBytes === 'string' &&
            /^[0-9]+$/.test(details.droppedBytes) &&
            BigInt(details.droppedBytes) > 0n)),
    };
  };
  const receipt: ShellReceipt = {
    executionId: execution.id,
    callId: execution.callId,
    tool: execution.definitionId,
    definitionVersion: execution.definitionVersion,
    command: {
      text: preview(input.command, 8192),
      bytes: Buffer.byteLength(input.command),
      truncated: Buffer.byteLength(input.command) > 8192,
    },
    requestedPermissions: requestedPermissions as Json,
    ...(toolAuthorization || jobAuthorization
      ? {
          authorization: {
            ...(toolAuthorization ? { tool: toolAuthorization } : {}),
            ...(jobAuthorization ? { job: jobAuthorization } : {}),
          },
        }
      : {}),
    job: {
      executionId: job.id,
      definitionVersion: job.definitionVersion,
      status: job.status,
      dispatched: job.authorization?.dispatched ?? null,
      effectiveScope: effectiveScope as Json,
      exitCode: Number.isSafeInteger(jobDetails?.exitCode) ? Number(jobDetails!.exitCode) : null,
    },
    stdout: stream('stdout'),
    stderr: stream('stderr'),
  };
  return isShellReceipt(receipt) ? receipt : undefined;
}

/** Original execution identity is Host evidence; observations remain attributed Tool data.
 * The selected-history boundary is explicit: omitted/compacted work is not proved absent. */
export async function childToolEvidence(
  history: readonly ModelMessage[],
  identity: { sessionId: string; runId: string; storeId: string },
  getExecution: (id: string) => Promise<ExecutionRecord | null>,
  isRegisteredShell?: (tool: ExecutionRecord, job: ExecutionRecord) => boolean,
) {
  const calls = new Map<string, string>();
  const seen = new Set<string>();
  // This is a bounded preview of independently retained original receipts. It must never
  // make an otherwise valid child result exceed the Store's transport boundary.
  let observationBytes = 0;
  let observationsOmitted = 0;
  let toolCallsOmitted = 0;
  const shellReceipts: ShellReceipt[] = [];
  let shellReceiptsOmitted = 0;
  const observations: {
    executionId: string;
    tool: string;
    definitionVersion: string;
    observation: ToolObservation;
  }[] = [];
  const tools = new Map<
    string,
    { tool: string; definitionVersion: string; outcomes: Record<string, number> }
  >();
  for (const message of history) {
    for (const call of message.toolCalls ?? []) calls.set(call.id, call.name);
    if (message.role !== 'tool' || !message.toolCallId) continue;
    for (const id of message.sourceIds ?? []) {
      if (seen.has(id)) continue;
      const execution = await getExecution(id);
      if (
        execution?.kind !== 'tool' ||
        execution.sessionId !== identity.sessionId ||
        execution.runId !== identity.runId ||
        execution.originStoreId !== identity.storeId ||
        execution.callId !== message.toolCallId ||
        execution.definitionId !== calls.get(message.toolCallId) ||
        !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)
      )
        continue;
      seen.add(id);
      const key = JSON.stringify([execution.definitionId, execution.definitionVersion]);
      const summary = tools.get(key) ?? {
        tool: execution.definitionId,
        definitionVersion: execution.definitionVersion,
        outcomes: {},
      };
      summary.outcomes[execution.status] = (summary.outcomes[execution.status] ?? 0) + 1;
      if (tools.has(key) || tools.size < 64) tools.set(key, summary);
      else toolCallsOmitted++;
      if (isRegisteredShell) {
        const receipt = await recordedShellReceipt(execution, getExecution, isRegisteredShell);
        if (receipt) {
          const bytes = Buffer.byteLength(JSON.stringify(receipt));
          if (observationBytes + bytes <= 32 * 1024) {
            shellReceipts.push(receipt);
            observationBytes += bytes;
          } else shellReceiptsOmitted++;
        }
      }
      const result = object(execution.result);
      const observation =
        execution.status === 'succeeded' && typeof result?.content === 'string'
          ? toolObservation(result.content)
          : undefined;
      if (observation) {
        const item = {
          executionId: execution.id,
          tool: execution.definitionId,
          definitionVersion: execution.definitionVersion,
          observation,
        };
        const bytes = Buffer.byteLength(JSON.stringify(item));
        // Reserve most of the preview for source inspections rather than candidate searches.
        const budget = observation.kind === 'lookup' ? 8 * 1024 : 32 * 1024;
        if (observationBytes + bytes <= budget) {
          observations.push(item);
          observationBytes += bytes;
        } else observationsOmitted++;
      }
    }
  }
  if (!seen.size) return;
  return {
    kind: 'recorded_tool_evidence',
    ...identity,
    coverage: 'selected_history',
    reportVerification: 'not_verified',
    limitation:
      'This is a bounded preview of original Tool receipts retained in selected history; compacted or omitted work is not proved absent. Full original receipts remain in the child execution history. Compare child assertions with the original source excerpts; resolve discrepancies before repeating them. Tool-reported observations establish inspected sources, not semantic correctness, call reachability or authorization. Independently verify the connections that determine the answer before adopting a child conclusion.',
    observationsOmitted,
    toolCallsOmitted,
    tools: [...tools.values()],
    observations,
    ...(isRegisteredShell ? { shellReceipts, shellReceiptsOmitted } : {}),
  };
}
