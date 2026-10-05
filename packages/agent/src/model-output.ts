import { canonicalJson } from './json';
import { bodyReference } from './model-body';
import { AgentError, type ArtifactReference, type Json, type ToolCall } from './storage/types';

export interface ModelOutputReference {
  readonly kind: 'model_output';
  readonly version: 1;
  readonly head: ArtifactReference;
  readonly seq: string;
  readonly contentBytes: string;
  readonly reasoningBytes: string;
  readonly toolCallCount: number;
  readonly complete: boolean;
}
export interface ModelOutputScope {
  storeId: string;
  sessionId: string;
  subjectId: string;
  executionId: string;
}
const semanticDigestBytes = async (bytes: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))).toString('hex');
type Delta =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call'; index: number; part: number; text: string; last: boolean };
interface Segment {
  kind: 'model_output_segment';
  version: 1;
  executionId: string;
  seq: string;
  previous: ArtifactReference | null;
  delta: Delta;
}
function obj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function decimal(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    value.length <= 19 &&
    BigInt(value) <= 9223372036854775807n
  );
}
function artifact(value: unknown): ArtifactReference {
  const parsed = bodyReference({ kind: 'model_body', version: 1, reference: value } as Json);
  if (!parsed) throw new AgentError('model_output_invalid');
  return parsed.reference;
}
export function modelOutputReference(value: unknown): ModelOutputReference | null {
  if (!obj(value) || value.kind !== 'model_output') return null;
  if (
    !keys(value, [
      'kind',
      'version',
      'head',
      'seq',
      'contentBytes',
      'reasoningBytes',
      'toolCallCount',
      'complete',
    ]) ||
    value.version !== 1 ||
    !decimal(value.seq) ||
    value.seq === '0' ||
    !decimal(value.contentBytes) ||
    !decimal(value.reasoningBytes) ||
    !Number.isSafeInteger(value.toolCallCount) ||
    Number(value.toolCallCount) < 0 ||
    typeof value.complete !== 'boolean'
  )
    throw new AgentError('model_output_invalid');
  artifact(value.head);
  return structuredClone(value) as unknown as ModelOutputReference;
}
export function assertModelOutputScope(ref: ArtifactReference, scope: ModelOutputScope) {
  if (
    ref.storeId !== scope.storeId ||
    ref.sessionId !== scope.sessionId ||
    ref.subjectId !== scope.subjectId ||
    ref.scope.kind !== 'execution' ||
    ref.scope.id !== scope.executionId ||
    ref.mediaType !== 'application/vnd.kite.model-output+json'
  )
    throw new AgentError('model_output_scope_denied');
}
/** Exact UTF-8 length of concatenated JS deltas, including surrogate pairs split between events. */
class Bytes {
  total = 0n;
  private high = false;
  add(text: string) {
    if (!text) return;
    this.total += BigInt(Buffer.byteLength(text));
    if (this.high && text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff) this.total -= 2n;
    const last = text.charCodeAt(text.length - 1);
    this.high = last >= 0xd800 && last <= 0xdbff;
  }
}
/** One producer, awaited immutable publication, no growing Worker frame or queued output bodies. */
export class ModelOutputWriter {
  private head: ArtifactReference | undefined;
  private seq = 0n;
  private content = new Bytes();
  private reasoning = new Bytes();
  private calls = 0;
  constructor(
    privateScope: ModelOutputScope,
    publish: (value: Json) => Promise<ArtifactReference>,
    checkpoint: (ref: ModelOutputReference) => Promise<void>,
  ) {
    this.scope = structuredClone(privateScope);
    this.publish = publish;
    this.checkpoint = checkpoint;
  }
  private readonly scope: ModelOutputScope;
  private readonly publish: (value: Json) => Promise<ArtifactReference>;
  private readonly checkpoint: (ref: ModelOutputReference) => Promise<void>;
  descriptor(complete = false): ModelOutputReference | null {
    return this.head
      ? {
          kind: 'model_output',
          version: 1,
          head: structuredClone(this.head),
          seq: String(this.seq),
          contentBytes: String(this.content.total),
          reasoningBytes: String(this.reasoning.total),
          toolCallCount: this.calls,
          complete,
        }
      : null;
  }
  private async append(delta: Delta) {
    const sequence = this.seq + 1n;
    if (sequence > 9223372036854775807n) throw new AgentError('sequence_exhausted');
    const node: Segment = {
      kind: 'model_output_segment',
      version: 1,
      executionId: this.scope.executionId,
      seq: String(sequence),
      previous: this.head ?? null,
      delta,
    };
    const ref = await this.publish(node as unknown as Json);
    assertModelOutputScope(ref, this.scope);
    this.head = structuredClone(ref);
    this.seq = sequence;
    if (delta.kind === 'text') this.content.add(delta.text);
    else if (delta.kind === 'reasoning') this.reasoning.add(delta.text);
    else if (delta.last) this.calls++;
    await this.checkpoint(this.descriptor()!);
  }
  async text(kind: 'text' | 'reasoning', text: string) {
    for (let offset = 0; offset < text.length; offset += 32768)
      await this.append({ kind, text: text.slice(offset, offset + 32768) });
  }
  async call(call: ToolCall) {
    const json = canonicalJson(call as unknown as Json);
    let part = 0;
    const index = this.calls;
    for (let offset = 0; offset < json.length; offset += 32768)
      await this.append({
        kind: 'tool_call',
        index,
        part: part++,
        text: json.slice(offset, offset + 32768),
        last: offset + 32768 >= json.length,
      });
  }
}

/** Full verified chain only; callers derive scope from the original Execution, never renderer input. */
export async function readModelOutput(
  output: ModelOutputReference,
  scope: ModelOutputScope,
  read: (reference: ArtifactReference) => Promise<Uint8Array>,
  signal?: AbortSignal,
): Promise<{ content: string; reasoning: string; toolCalls: ToolCall[]; complete: boolean }> {
  modelOutputReference(output);
  let ref: ArtifactReference | null = output.head;
  let seq = BigInt(output.seq);
  const nodes: Segment[] = [];
  const seen = new Set<string>();
  while (ref) {
    signal?.throwIfAborted();
    assertModelOutputScope(ref, scope);
    if (seen.has(ref.id)) throw new AgentError('model_output_invalid');
    seen.add(ref.id);
    const bytes = await read(ref);
    signal?.throwIfAborted();
    if (String(bytes.byteLength) !== ref.size || (await semanticDigestBytes(bytes)) !== ref.hash)
      throw new AgentError('model_output_invalid');
    let node: unknown;
    try {
      node = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new AgentError('model_output_invalid');
    }
    if (
      !obj(node) ||
      !keys(node, ['kind', 'version', 'executionId', 'seq', 'previous', 'delta']) ||
      node.kind !== 'model_output_segment' ||
      node.version !== 1 ||
      node.executionId !== scope.executionId ||
      node.seq !== String(seq) ||
      !obj(node.delta)
    )
      throw new AgentError('model_output_invalid');
    const delta = node.delta;
    if (
      typeof delta.text !== 'string' ||
      (delta.kind === 'text' || delta.kind === 'reasoning'
        ? !keys(delta, ['kind', 'text'])
        : delta.kind !== 'tool_call' ||
          !keys(delta, ['kind', 'index', 'part', 'text', 'last']) ||
          !Number.isSafeInteger(delta.index) ||
          Number(delta.index) < 0 ||
          !Number.isSafeInteger(delta.part) ||
          Number(delta.part) < 0 ||
          typeof delta.last !== 'boolean')
    )
      throw new AgentError('model_output_invalid');
    const previous = node.previous === null ? null : artifact(node.previous);
    if ((seq === 1n) !== (previous === null)) throw new AgentError('model_output_invalid');
    nodes.push(node as unknown as Segment);
    ref = previous;
    seq--;
  }
  let content = '',
    reasoning = '',
    callText = '',
    part = 0;
  const calls: ToolCall[] = [];
  for (const { delta } of nodes.reverse()) {
    signal?.throwIfAborted();
    if (delta.kind === 'text') content += delta.text;
    else if (delta.kind === 'reasoning') reasoning += delta.text;
    else {
      if (delta.index !== calls.length || delta.part !== part++)
        throw new AgentError('model_output_invalid');
      callText += delta.text;
      if (delta.last) {
        let call: unknown;
        try {
          call = JSON.parse(callText);
        } catch {
          throw new AgentError('model_output_invalid');
        }
        if (
          !obj(call) ||
          !keys(call, ['id', 'name', 'arguments']) ||
          typeof call.id !== 'string' ||
          typeof call.name !== 'string' ||
          typeof call.arguments !== 'string'
        )
          throw new AgentError('model_output_invalid');
        calls.push(call as unknown as ToolCall);
        callText = '';
        part = 0;
      }
    }
  }
  if (
    String(Buffer.byteLength(content)) !== output.contentBytes ||
    String(Buffer.byteLength(reasoning)) !== output.reasoningBytes ||
    calls.length !== output.toolCallCount ||
    (output.complete && part !== 0)
  )
    throw new AgentError('model_output_invalid');
  return { content, reasoning, toolCalls: output.complete ? calls : [], complete: output.complete };
}
