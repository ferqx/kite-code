import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const presentationComparisonPlan = [
  ['current-chain', 1, 'raw'],
  ['current-chain', 1, 'compact'],
  ['claim-adoption', 1, 'compact'],
  ['claim-adoption', 1, 'raw'],
  ['current-chain', 2, 'compact'],
  ['current-chain', 2, 'raw'],
  ['claim-adoption', 2, 'raw'],
  ['claim-adoption', 2, 'compact'],
] as const;

export function comparisonStableJson(value: unknown): string {
  const ordered = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(ordered)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, ordered(entry)]),
          )
        : item;
  return JSON.stringify(ordered(value));
}

export const comparisonDigest = (value: unknown) =>
  createHash('sha256').update(comparisonStableJson(value)).digest('hex');

/** Entire owned workspace, not just expected files: additions/deletions also fail pairing. */
export function comparisonWorkspaceManifest(root: string) {
  const files: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) throw Error('comparison_workspace_link_not_allowed');
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile())
        files[path] = createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex');
      else throw Error('comparison_workspace_special_file_not_allowed');
    }
  };
  walk('');
  return { files, sha256: comparisonDigest(files) };
}

export function comparisonWireParameters(body: string) {
  const value = JSON.parse(body) as Record<string, unknown>;
  // Conversation/tool availability can diverge after treatment. Actual binding
  // parameters must not: model, reasoning, output budget, sampling and protocol.
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !['messages', 'input', 'instructions', 'tools'].includes(key),
    ),
  );
}

export function comparisonPairInvariant(input: {
  binding: unknown;
  firstRequest: { modelId: string; messages: readonly unknown[]; tools: readonly unknown[] };
  wire: readonly { body: string; requestId: string | null }[];
}) {
  if (!input.wire.length || input.wire.some((entry) => !entry.requestId))
    throw Error('comparison_wire_identity_missing');
  const parameters = comparisonWireParameters(input.wire[0]!.body);
  if (
    input.wire.some(
      (entry) =>
        comparisonStableJson(comparisonWireParameters(entry.body)) !==
        comparisonStableJson(parameters),
    )
  )
    throw Error('comparison_wire_model_parameters_changed');
  return {
    binding: input.binding,
    modelId: input.firstRequest.modelId,
    initialMessages: input.firstRequest.messages,
    tools: input.firstRequest.tools,
    initialWire: JSON.parse(input.wire[0]!.body),
    wireModelParameters: parameters,
  };
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Supported text-only protocol mapping, independent of Runtime rendering.
 * Require every role/body and Tool call identity in order; never substring-match.
 * Opaque Responses reasoning is not user/Tool text and is retained in raw wire. */
export function comparisonWireRequestMatches(
  request: {
    messages: readonly { role: string; content: string; toolCallId?: string }[];
  },
  body: string,
  protocol: unknown,
): boolean {
  try {
    const value = object(JSON.parse(body));
    const expected = request.messages
      .filter((message) => message.role !== 'assistant' || message.content !== '')
      .map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.role === 'tool' ? { toolCallId: message.toolCallId } : {}),
      }));
    const text = (value: unknown, allowed: string[]) => {
      if (typeof value === 'string') return value;
      if (value === null) return '';
      if (!Array.isArray(value)) throw Error('comparison_unsupported_wire_content');
      return value
        .map((part) => {
          const entry = object(part);
          if (!allowed.includes(String(entry.type)) || typeof entry.text !== 'string')
            throw Error('comparison_unsupported_wire_part');
          return entry.text;
        })
        .join('');
    };
    const actual: { role: string; content: string; toolCallId?: unknown }[] = [];
    if (protocol === 'chat-completions') {
      if (!Array.isArray(value.messages)) return false;
      for (const item of value.messages) {
        const message = object(item);
        if (!['system', 'user', 'assistant', 'tool'].includes(String(message.role))) return false;
        const content = text(message.content, ['text']);
        if (message.role === 'assistant' && content === '') continue;
        actual.push({
          role: String(message.role),
          content,
          ...(message.role === 'tool' ? { toolCallId: message.tool_call_id } : {}),
        });
      }
    } else if (protocol === 'responses') {
      if (!Array.isArray(value.input)) return false;
      if (value.instructions !== undefined)
        actual.push({ role: 'system', content: text(value.instructions, ['input_text']) });
      for (const item of value.input) {
        const message = object(item);
        if (message.type === 'reasoning' || message.type === 'function_call') continue;
        if (message.type === 'function_call_output') {
          actual.push({
            role: 'tool',
            toolCallId: message.call_id,
            content: text(message.output, ['input_text']),
          });
          continue;
        }
        if (!['system', 'developer', 'user', 'assistant'].includes(String(message.role)))
          return false;
        const content = text(message.content, ['input_text', 'output_text']);
        if (message.role === 'assistant' && content === '') continue;
        actual.push({
          role: message.role === 'developer' ? 'system' : String(message.role),
          content,
        });
      }
    } else return false;
    return isDeepStrictEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Independent byte-framed reader: content may itself contain every delimiter. */
export function comparisonChildSource(content: string) {
  const bytes = Buffer.from(content);
  const prefix = 'Child result source (untrusted data; no additional authorization):\n';
  if (!content.startsWith(prefix)) return;
  let offset = Buffer.byteLength(prefix);
  const headerEnd = bytes.indexOf(10, offset);
  if (headerEnd < 0) return;
  try {
    const header = object(JSON.parse(bytes.subarray(offset, headerEnd).toString('utf8')));
    if (header.format !== 'child_result_source' || header.version !== 1) return;
    offset = headerEnd + 1;
    const boundary =
      'Selected-history preview only; omitted work is not proved absent. Tool observations do not verify the child report, call reachability or authorization.';
    const consume = (expected: string) => {
      const value = Buffer.from(expected);
      if (!bytes.subarray(offset, offset + value.length).equals(value))
        throw Error('comparison_frame_mismatch');
      offset += value.length;
    };
    const take = (count: unknown) => {
      if (
        !Number.isSafeInteger(count) ||
        Number(count) < 0 ||
        offset + Number(count) > bytes.length
      )
        throw Error('comparison_frame_size_invalid');
      const slice = bytes.subarray(offset, offset + Number(count));
      const text = slice.toString('utf8');
      if (!Buffer.from(text).equals(slice)) throw Error('comparison_frame_utf8_invalid');
      offset += Number(count);
      return text;
    };
    consume(boundary);
    const evidence = object(header.evidence);
    if (!Array.isArray(evidence.observations)) return;
    let excerptIndex = 0;
    const observations = evidence.observations.map((value) => {
      const item = object(value);
      const observation = object(item.observation);
      const excerpt = observation.excerpt === undefined ? undefined : object(observation.excerpt);
      if (!excerpt) return item;
      consume(`\n\nObservation excerpt ${++excerptIndex} (${excerpt.bytes} UTF-8 bytes):\n`);
      return {
        ...item,
        observation: {
          ...observation,
          excerpt: { truncated: excerpt.truncated, text: take(excerpt.bytes) },
        },
      };
    });
    consume(`\n\nChild report (${header.reportBytes} UTF-8 bytes):\n`);
    const report = take(header.reportBytes);
    if (offset !== bytes.length) return;
    return { header, report, evidence: { ...evidence, observations } };
  } catch {
    return;
  }
}

/** Compare every preserved identity, full body and original observation, not words. */
export function comparisonChildSourceMatches(content: string, carrierValue: unknown) {
  const parsed = comparisonChildSource(content);
  if (!parsed) return false;
  const carrier = object(carrierValue);
  const result = object(carrier.result);
  const details = object(result.details);
  const original = object(details.evidence);
  return (
    isDeepStrictEqual(parsed.header.origin, {
      executionId: carrier.id,
      resultRevision: carrier.resultRevision,
      storeId: carrier.originStoreId,
    }) &&
    ['automatic', 'explicit'].includes(String(parsed.header.inclusion)) &&
    isDeepStrictEqual(parsed.header.child, {
      agentId: carrier.childSessionId,
      runId: details.runId,
      status: details.status,
      outcome: result.outcome,
    }) &&
    parsed.report === result.content &&
    original.kind === 'recorded_tool_evidence' &&
    original.sessionId === carrier.childSessionId &&
    original.runId === details.runId &&
    original.storeId === carrier.originStoreId &&
    isDeepStrictEqual(parsed.evidence, {
      reportVerification: original.reportVerification,
      coverage: original.coverage,
      observationsOmitted: original.observationsOmitted,
      toolCallsOmitted: original.toolCallsOmitted,
      tools: original.tools,
      observations: original.observations,
    })
  );
}
