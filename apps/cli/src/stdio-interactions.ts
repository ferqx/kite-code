import type { Interaction } from '@kite-ai/client';
import type { CLIOptions } from './index';

/** A finite input port; native stdin is chosen only by this CLI adapter. */
export interface StdioInput {
  readonly readableEnded: boolean;
  readonly destroyed: boolean;
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  once(event: 'end' | 'error', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: unknown) => void): unknown;
  off(event: 'end' | 'error', listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface StdioInteractionOptions {
  /** Explicit opt-in. The adapter never opens stdin merely by importing CLI. */
  readonly input?: StdioInput;
  /** Diagnostic/prompt destination; defaults to stderr, separate from command output. */
  readonly write?: (text: string) => void;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Deliberately finite form subset; unsupported schemas retain the pending card. */
function matchesQuestion(schema: unknown, value: unknown, depth = 0): boolean {
  if (
    !record(schema) ||
    depth > 16 ||
    Object.keys(schema).some(
      (key) =>
        ![
          'type',
          'title',
          'description',
          'enum',
          'properties',
          'required',
          'additionalProperties',
          'items',
          'minLength',
          'maxLength',
          'minimum',
          'maximum',
          'minItems',
          'maxItems',
        ].includes(key),
    )
  )
    return false;
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value)))
  )
    return false;
  if (schema.type === 'object') {
    if (
      !record(value) ||
      !record(schema.properties) ||
      Object.keys(schema.properties).length > 64 ||
      (schema.additionalProperties !== undefined &&
        typeof schema.additionalProperties !== 'boolean')
    )
      return false;
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(value, key)))
    )
      return false;
    const properties = schema.properties;
    return Object.entries(value).every(([key, item]) =>
      Object.hasOwn(properties, key)
        ? matchesQuestion(properties[key], item, depth + 1)
        : schema.additionalProperties === true,
    );
  }
  if (schema.type === 'array')
    return (
      Array.isArray(value) &&
      value.every((item) => matchesQuestion(schema.items, item, depth + 1)) &&
      (schema.minItems === undefined ||
        (typeof schema.minItems === 'number' && value.length >= schema.minItems)) &&
      (schema.maxItems === undefined ||
        (typeof schema.maxItems === 'number' && value.length <= schema.maxItems))
    );
  if (schema.type === 'string')
    return (
      typeof value === 'string' &&
      (schema.minLength === undefined ||
        (typeof schema.minLength === 'number' && [...value].length >= schema.minLength)) &&
      (schema.maxLength === undefined ||
        (typeof schema.maxLength === 'number' && [...value].length <= schema.maxLength))
    );
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'null') return value === null;
  if (schema.type === 'number' || schema.type === 'integer')
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isInteger(value)) &&
      (schema.minimum === undefined ||
        (typeof schema.minimum === 'number' && value >= schema.minimum)) &&
      (schema.maximum === undefined ||
        (typeof schema.maximum === 'number' && value <= schema.maximum))
    );
  return false;
}
function answer(
  interaction: Interaction,
  line: string,
): NonNullable<Interaction['answer']> | undefined {
  const text = line.trim();
  if (!text) return undefined;
  if (interaction.kind === 'approval') {
    if (text === 'deny') return { kind: 'approval', decision: 'deny' };
    if (text === 'approve' || text === 'approve approve_once')
      return { kind: 'approval', decision: 'approve', grant: 'approve_once' };
    if (
      text === 'approve same_command' &&
      record(interaction.request) &&
      Array.isArray(interaction.request.grants) &&
      interaction.request.grants.includes('same_command')
    )
      return { kind: 'approval', decision: 'approve', grant: 'same_command' };
    return undefined;
  }
  if (interaction.kind === 'question') {
    if (!record(interaction.request) || !record(interaction.request.schema)) return undefined;
    try {
      const answers: unknown = JSON.parse(text);
      return matchesQuestion(interaction.request.schema, answers)
        ? { kind: 'question', answers: JSON.parse(text) }
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (!record(interaction.request) || !Array.isArray(interaction.request.allowedModes))
    return undefined;
  if (text === 'deny') return { kind: 'plan_review', decision: 'deny' };
  if (text === 'revise') return { kind: 'plan_review', decision: 'revise' };
  if (text.startsWith('revise ') && text.slice(7).length <= 8192)
    return { kind: 'plan_review', decision: 'revise', feedback: text.slice(7) };
  const mode = text.startsWith('approve ') ? text.slice(8) : undefined;
  return (mode === 'auto' || mode === 'accept_edits') &&
    interaction.request.allowedModes.includes(mode)
    ? { kind: 'plan_review', decision: 'approve', mode }
    : undefined;
}

/** One foreground human input consumer, not an execution or Service lifecycle owner. */
export function createStdioInteractionHandler(options: StdioInteractionOptions = {}) {
  const input = options.input ?? process.stdin;
  const write =
    options.write ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: string[] = [];
  let partial = '',
    bytes = 0,
    ended = false,
    started = false,
    busy = false;
  let wake: (() => void) | undefined;
  function finish() {
    ended = true;
    wake?.();
  }
  function receive(chunk: unknown) {
    try {
      if (!(chunk instanceof Uint8Array) && typeof chunk !== 'string') {
        finish();
        return;
      }
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      for (const piece of text.split(/(?<=\n)/)) {
        partial += piece;
        bytes += new TextEncoder().encode(piece).byteLength;
        // Explicit unsupported input, never a truncated answer or an unbounded queue.
        if (bytes > 64 * 1024 || lines.length >= 16) {
          lines.length = 0;
          partial = '';
          finish();
          return;
        }
        if (partial.endsWith('\n')) {
          lines.push(partial.replace(/\r?\n$/, ''));
          partial = '';
          bytes = 0;
        }
      }
      wake?.();
    } catch {
      finish();
    }
  }
  function dispose() {
    finish();
    lines.length = 0;
    partial = '';
    if (started) {
      input.off('data', receive);
      input.off('end', finish);
      input.off('error', finish);
      input.pause();
    }
  }
  const answerInteraction: NonNullable<CLIOptions['answerInteraction']> = async (
    interaction,
    context,
  ) => {
    if (busy || (ended && !lines.length) || context.signal.aborted) return undefined;
    busy = true;
    try {
      // JSON escapes terminal controls while preserving complete diagnostic text.
      write(
        `${JSON.stringify({ interactionId: interaction.id, originStoreId: interaction.originStoreId, sessionId: interaction.sessionId, presentationSessionId: interaction.presentationSessionId, runId: interaction.runId, executionId: interaction.executionId, attempt: interaction.attempt, revision: interaction.revision, kind: interaction.kind, request: interaction.request })}\n`,
      );
      if (context.completeAttachment)
        write(`Complete verified attachment: ${JSON.stringify(context.completeAttachment.text)}\n`);
      write(
        interaction.kind === 'approval'
          ? `Answer approve (once)${record(interaction.request) && Array.isArray(interaction.request.grants) && interaction.request.grants.includes('same_command') ? ', approve same_command (本 Session 相同命令)' : ''}, or deny; empty/EOF keeps waiting.\n`
          : interaction.kind === 'question'
            ? 'Answer JSON matching the original schema; preserve internal choice IDs. Empty/EOF keeps waiting.\n'
            : 'Answer approve <offered auto|accept_edits>, deny, or revise <feedback>; plan review grants no Tool permission.\n',
      );
      if (!started) {
        if (input.readableEnded || input.destroyed) return undefined;
        started = true;
        input.on('data', receive);
        input.once('end', finish);
        input.once('error', finish);
        input.resume();
      }
      while (!lines.length && !ended && !context.signal.aborted) {
        await new Promise<void>((resolve) => {
          wake = () => resolve();
          context.signal.addEventListener('abort', wake, { once: true });
        }).finally(() => {
          if (wake) context.signal.removeEventListener('abort', wake);
          wake = undefined;
        });
      }
      if (context.signal.aborted) return undefined;
      const line = lines.shift();
      if (line === undefined) return undefined;
      return answer(interaction, line);
    } finally {
      busy = false;
    }
  };
  return { answerInteraction, dispose };
}
