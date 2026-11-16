import { createHash } from 'node:crypto';
import { toolBehaviorBinding } from '../../authorization-check-output';
import { canonicalJson } from '../../json';
import { bodyReference } from '../../model-body';
import type { ToolBehaviorBinding } from '../../tool-behavior';
import { AgentError, type Json } from '../types';
import { verifyModelBody } from './model-body';
import { modelOutputOf, verifyModelOutput } from './model-output';
import type { SqliteOperations } from './operations';
import { getSessionExecutionRoot } from './session-execution-root';

type Row = Record<string, string | number | bigint | null | undefined>;
const fail = (): never => {
  throw new AgentError('execution_behavior_source_invalid');
};
function object(value: unknown): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, Json>;
}
const parse = (value: unknown) => object(JSON.parse(String(value)));
const same = (a: unknown, b: unknown) =>
  canonicalJson((a ?? null) as Json) === canonicalJson((b ?? null) as Json);
const scope = (a: Row, b: Row) =>
  [
    'session_id',
    'origin_store_id',
    'root_session_id',
    'root_work_command_id',
    'root_work_seq',
  ].every((key) => a[key] === b[key]);
function bindings(value: unknown): ToolBehaviorBinding[] {
  if (
    !Array.isArray(value) ||
    value.length > 4096 ||
    Buffer.byteLength(canonicalJson(value as Json)) > 1024 * 1024
  )
    return fail();
  const seen = new Set<string>();
  return value.map((item) => {
    const binding = toolBehaviorBinding(item);
    if (!binding) return fail();
    const key = canonicalJson(binding.capability as unknown as Json);
    if (seen.has(key)) return fail();
    seen.add(key);
    return binding;
  });
}

/** Exact original Step identities, never today's selected registry or a caller-supplied digest. */
export function executionBehaviorManifest(
  db: SqliteOperations,
  target: Row,
): {
  configuration: Record<string, Json> | null;
  bindings: ToolBehaviorBinding[];
} {
  let current = target;
  const seen = new Set<string>();
  while (!current.run_id) {
    if (!current.parent_execution_id) return { configuration: null, bindings: [] };
    if (seen.has(String(current.id)) || seen.size >= 64) return fail();
    seen.add(String(current.id));
    const parent = db.row('SELECT * FROM execution WHERE id=?', current.parent_execution_id);
    if (!parent || !scope(current, parent)) return fail();
    if (
      !same(
        parse(current.decision_source_json).executionRoot,
        parse(parent.decision_source_json).executionRoot,
      )
    )
      return fail();
    const command = db.row('SELECT * FROM command WHERE id=?', current.origin_command_id!);
    if (
      !command ||
      command.session_id !== current.session_id ||
      command.origin_store_id !== current.origin_store_id
    )
      return fail();
    if (current.origin_command_id !== parent.origin_command_id) {
      const request = parse(command.request_json);
      if (
        request.parentExecutionId !== parent.id ||
        request.definitionId !== current.adapter_id ||
        request.definitionVersion !== current.definition_version ||
        !same(request.input, JSON.parse(String(current.intent_json)))
      )
        return fail();
    }
    current = parent;
  }
  const run = db.row('SELECT * FROM run WHERE id=?', current.run_id);
  if (
    !run ||
    run.session_id !== target.session_id ||
    run.origin_store_id !== target.origin_store_id
  )
    return fail();
  const configuration = parse(run.config_json);
  const legacy = () => ({
    configuration,
    bindings:
      configuration.toolBehaviors === undefined ? [] : bindings(configuration.toolBehaviors),
  });
  const source = parse(current.decision_source_json);
  if (source.kind !== 'model_decision') return legacy();
  if (current.kind !== 'tool' || typeof source.modelExecutionId !== 'string') return fail();
  const model = db.row('SELECT * FROM execution WHERE id=?', source.modelExecutionId);
  if (
    model?.kind !== 'model' ||
    model.state !== 'succeeded' ||
    !scope(current, model) ||
    model.run_id !== current.run_id
  )
    return fail();
  const modelSource = parse(model.decision_source_json);
  if (modelSource.sourceBody !== undefined) {
    if (!bodyReference(modelSource.sourceBody)) return fail();
    verifyModelBody(db, modelSource, model);
  }
  // A missing field identifies an old Model. An explicit empty array is authoritative.
  if (modelSource.toolBehaviorBindings === undefined) {
    if (source.executionRoot !== undefined || modelSource.executionRoot !== undefined)
      return fail();
    return legacy();
  }
  const selected = bindings(modelSource.toolBehaviorBindings);
  if (modelSource.kind !== 'model_request') return fail();
  if (source.executionRoot !== undefined || modelSource.executionRoot !== undefined) {
    if (!same(source.executionRoot, modelSource.executionRoot)) return fail();
    if (!same(object(modelSource.capabilitySnapshot).executionRoot, source.executionRoot))
      return fail();
    const root = object(source.executionRoot);
    if (root.sessionId !== current.session_id || typeof root.epoch !== 'string') return fail();
    const saved = getSessionExecutionRoot(db, {
      sessionId: String(current.session_id),
      epoch: root.epoch,
    });
    if (
      root.workspaceId !== saved.workspaceId ||
      root.effectiveRootUri !== saved.effectiveRootUri ||
      (saved.identity !== null && !same(saved.identity, root.identity))
    )
      return fail();
  }
  const output = parse(model.result_json);
  const descriptor = modelOutputOf(output);
  if (descriptor !== undefined) {
    const complete = verifyModelOutput(db, descriptor, model);
    if (!complete.complete || complete.toolCallCount < 1) return fail();
    const calls = output.modelToolCalls;
    if (
      !Array.isArray(calls) ||
      calls.length !== complete.toolCallCount ||
      calls.length > 4096 ||
      Buffer.byteLength(canonicalJson(calls)) > 1024 * 1024 ||
      new Set(calls.map((item) => object(item).id)).size !== calls.length
    )
      return fail();
    for (const item of calls) {
      const call = object(item);
      if (
        Object.keys(call).sort().join(',') !== 'id,inputDigest,name' ||
        typeof call.id !== 'string' ||
        !call.id ||
        typeof call.name !== 'string' ||
        !call.name ||
        (call.inputDigest !== null &&
          (typeof call.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(call.inputDigest)))
      )
        return fail();
    }
    const matches = calls.filter((item) => object(item).id === current.call_id);
    if (matches.length !== 1) return fail();
    const call = object(matches[0]);
    const inputDigest = createHash('sha256')
      .update(canonicalJson(JSON.parse(String(current.intent_json))))
      .digest('hex');
    if (
      Object.keys(call).sort().join(',') !== 'id,inputDigest,name' ||
      call.id !== current.call_id ||
      call.name !== current.adapter_id ||
      call.inputDigest !== inputDigest
    )
      return fail();
  } else {
    const calls = Array.isArray(output.toolCalls)
      ? output.toolCalls.filter((item) => object(item).id === current.call_id)
      : [];
    if (calls.length !== 1) return fail();
    const call = object(calls[0]);
    if (
      call.name !== current.adapter_id ||
      typeof call.arguments !== 'string' ||
      !same(JSON.parse(call.arguments), JSON.parse(String(current.intent_json)))
    )
      return fail();
  }
  return { configuration, bindings: selected };
}
