import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { generateText } from 'ai';
import {
  encodeLiveIsolatedTransportFrameV1,
  LIVE_ISOLATED_TRANSPORT_MAX_RESPONSE_TEXT_BYTES_V1,
  LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1,
  LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1,
  type LiveIsolatedTransportDispatchFrameV1,
  type LiveIsolatedTransportParentFrameV1,
  type LiveIsolatedTransportResultFrameV1,
  parseLiveIsolatedTransportFrameLineV1,
  parseLiveIsolatedTransportParentFrameV1,
} from './live-isolated-transport-protocol-v1';

/**
 * Fixed child entrypoint for AQ-8/AQ-9B. It accepts only the private protocol
 * below, owns no config/workspace/capability surface, and has no inherited
 * stdout/stderr. The parent owns reports, evidence, and governance records.
 */

let nonce: string | undefined;
let cutoffAtMs: number | undefined;
let dispatched = false;
let terminal = false;
let abortController: AbortController | undefined;
let hardCutoffTimer: ReturnType<typeof setTimeout> | undefined;

function withinDeadline(): boolean {
  return cutoffAtMs !== undefined && Date.now() < cutoffAtMs;
}

function usageBucket(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function wasCancelled(error: unknown): boolean {
  return (
    abortController?.signal.aborted === true ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

function terminalWasAborted(result: {
  readonly finishReason: { readonly unified: string };
}): boolean {
  return (
    abortController?.signal.aborted === true ||
    result.finishReason.unified === 'abort' ||
    result.finishReason.unified === 'cancelled'
  );
}

function resultFrame(
  frame: LiveIsolatedTransportDispatchFrameV1,
  input: Omit<
    LiveIsolatedTransportResultFrameV1,
    'schema' | 'version' | 'kind' | 'nonce' | 'phase' | 'promptDigest'
  >,
): LiveIsolatedTransportResultFrameV1 | undefined {
  if (!nonce) return undefined;
  return {
    schema: LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1,
    version: LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1,
    kind: 'result',
    nonce,
    phase: frame.request.phase,
    promptDigest: frame.request.promptDigest,
    ...input,
  };
}

function emitAndExit(frame: LiveIsolatedTransportResultFrameV1): void {
  if (terminal) return;
  terminal = true;
  const encoded = encodeLiveIsolatedTransportFrameV1(frame);
  if (!encoded) {
    process.exitCode = 1;
    process.exit();
    return;
  }
  process.stdout.write(`${encoded}\n`, () => process.exit(0));
}

function sanitizedAq9bResult(
  result: LanguageModelV4GenerateResult,
  phase: 'summary' | 'primary',
  maxInputTokens: number,
  maxOutputTokens: number,
): LiveIsolatedTransportResultFrameV1['generation'] {
  if (
    result.content.some(
      (part) => part.type === 'tool-call' || part.type === 'tool-approval-request',
    )
  ) {
    return { kind: 'tool_marker' };
  }
  // Do not let arbitrary provider text drive the parent Runtime or cross the
  // process boundary. The parent may inject a fixed source-owned response
  // only when this closed classifier accepts an all-text bounded terminal.
  if (!result.content.every((part) => part.type === 'text')) return { kind: 'empty' };
  if (
    usageBucket(result.usage.inputTokens.total) === null ||
    usageBucket(result.usage.outputTokens.total) === null ||
    result.usage.inputTokens.total > maxInputTokens ||
    result.usage.outputTokens.total > maxOutputTokens
  ) {
    return { kind: 'empty' };
  }
  const byteLength = result.content.reduce(
    (total, part) => total + new TextEncoder().encode(part.text).byteLength,
    0,
  );
  if (byteLength === 0 || byteLength > LIVE_ISOLATED_TRANSPORT_MAX_RESPONSE_TEXT_BYTES_V1) {
    return { kind: 'empty' };
  }
  return phase === 'summary' ? { kind: 'accepted_summary' } : { kind: 'accepted_primary' };
}

function aq9bPrompt(
  frame: LiveIsolatedTransportDispatchFrameV1,
): LanguageModelV4CallOptions['prompt'] {
  const messages = frame.request.promptMessages;
  if (!messages) throw new Error('isolated_transport_prompt_missing');
  return messages.map((message) =>
    message.role === 'system'
      ? { role: 'system' as const, content: message.content }
      : {
          role: message.role,
          content: [{ type: 'text' as const, text: message.content }],
        },
  );
}

async function runFixedTestMode(
  frame: LiveIsolatedTransportDispatchFrameV1,
): Promise<LiveIsolatedTransportResultFrameV1> {
  const mode = frame.request.testMode;
  if (!mode) throw new Error('isolated_transport_test_mode_missing');
  if (mode === 'hang_after_ready' || mode === 'hang_after_dispatch') {
    await new Promise<never>(() => undefined);
  }
  if (mode === 'spawn_fixed_descendant_then_hang') {
    // This mode is remapped by the parent to a dedicated test fixture entry;
    // the production child never has a spawn capability.
    await new Promise<never>(() => undefined);
  }
  if (mode === 'late_result' || mode === 'late_summary_after_cancel') {
    await new Promise((resolve) =>
      setTimeout(resolve, mode === 'late_summary_after_cancel' ? 200 : 50),
    );
  }
  const generation =
    mode === 'return_summary' || mode === 'late_summary_after_cancel'
      ? { kind: 'accepted_summary' as const }
      : mode === 'return_primary'
        ? { kind: 'accepted_primary' as const }
        : undefined;
  const outcome = mode === 'return_cancelled' ? ('cancelled' as const) : ('success' as const);
  const result = resultFrame(frame, {
    outcome,
    providerDispatchCount: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    ...(generation ? { generation } : {}),
  });
  if (!result) throw new Error('isolated_transport_result_nonce_missing');
  return result;
}

async function execute(frame: LiveIsolatedTransportDispatchFrameV1): Promise<void> {
  if (terminal || !withinDeadline()) {
    process.exitCode = 1;
    process.exit();
    return;
  }
  dispatched = true;
  abortController = new AbortController();
  const untilCutoff = Math.max(0, (cutoffAtMs ?? Date.now()) - Date.now());
  const cutoff = setTimeout(() => abortController?.abort(), untilCutoff);
  try {
    if (frame.request.operation === 'test') {
      const testResult = await runFixedTestMode(frame);
      if (
        abortController.signal.aborted &&
        frame.request.testMode !== 'late_summary_after_cancel'
      ) {
        const cancelled = resultFrame(frame, {
          outcome: 'cancelled',
          providerDispatchCount: 1,
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        });
        if (cancelled && withinDeadline()) emitAndExit(cancelled);
        return;
      }
      if (withinDeadline()) emitAndExit(testResult);
      return;
    }
    const lease = frame.lease;
    if (!lease || !withinDeadline()) throw new Error('isolated_transport_lease_missing');
    // Raw endpoint/key exist only in this lexical transport scope. They are
    // never copied into env, argv, a file, stdout, or the returned frame.
    const provider = createOpenAICompatible({
      name: 'qualification-l3-isolated-transport',
      apiKey: lease.apiKey,
      baseURL: lease.baseURL,
    });
    if (frame.request.operation === 'aq8') {
      const result = await generateText({
        model: provider(frame.request.model),
        prompt: frame.request.prompt!,
        temperature: 0,
        maxOutputTokens: frame.request.maxOutputTokens,
        maxRetries: 0,
        abortSignal: abortController.signal,
      });
      if (!withinDeadline()) return;
      if (terminalWasAborted(result)) {
        const cancelled = resultFrame(frame, {
          outcome: 'cancelled',
          providerDispatchCount: 1,
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        });
        if (cancelled) emitAndExit(cancelled);
        return;
      }
      const response = resultFrame(frame, {
        outcome: result.text.trim() ? 'success' : 'not_observed',
        providerDispatchCount: 1,
        usage: {
          inputTokens: usageBucket(result.usage.inputTokens),
          outputTokens: usageBucket(result.usage.outputTokens),
          totalTokens: usageBucket(result.usage.totalTokens),
        },
      });
      if (!response) throw new Error('isolated_transport_result_nonce_missing');
      emitAndExit(response);
      return;
    }
    const result = await provider(frame.request.model).doGenerate({
      prompt: aq9bPrompt(frame),
      maxOutputTokens: frame.request.maxOutputTokens,
      temperature: 0,
      abortSignal: abortController.signal,
    });
    if (!withinDeadline()) return;
    if (terminalWasAborted(result)) {
      const cancelled = resultFrame(frame, {
        outcome: 'cancelled',
        providerDispatchCount: 1,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      });
      if (cancelled) emitAndExit(cancelled);
      return;
    }
    const generation = sanitizedAq9bResult(
      result,
      frame.request.phase as 'summary' | 'primary',
      frame.request.maxInputTokens,
      frame.request.maxOutputTokens,
    );
    const response = resultFrame(frame, {
      // A tool/non-text terminal is deliberately not a model success. Its
      // closed marker lets the parent reject it before a product executor can
      // observe a model-originated tool call; raw provider content never
      // crosses the private pipe.
      outcome:
        generation.kind === 'accepted_summary' || generation.kind === 'accepted_primary'
          ? 'success'
          : 'not_observed',
      providerDispatchCount: 1,
      usage: {
        inputTokens: usageBucket(result.usage.inputTokens.total),
        outputTokens: usageBucket(result.usage.outputTokens.total),
        totalTokens: usageBucket(result.usage.inputTokens.total + result.usage.outputTokens.total),
      },
      generation,
    });
    if (!response) throw new Error('isolated_transport_result_nonce_missing');
    emitAndExit(response);
  } catch (error) {
    if (!withinDeadline()) return;
    const response = resultFrame(frame, {
      outcome: wasCancelled(error) ? 'cancelled' : 'not_observed',
      providerDispatchCount: dispatched ? 1 : 0,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      ...(frame.request.operation === 'aq9b' ? { generation: { kind: 'empty' as const } } : {}),
    });
    if (response) emitAndExit(response);
  } finally {
    clearTimeout(cutoff);
  }
}

function acceptFrame(frame: LiveIsolatedTransportParentFrameV1): void {
  if (terminal) return;
  if (frame.kind === 'init') {
    if (nonce !== undefined || !withinDeadlineForInit(frame.cutoffAtMs)) {
      process.exitCode = 1;
      process.exit();
      return;
    }
    nonce = frame.nonce;
    cutoffAtMs = frame.cutoffAtMs;
    hardCutoffTimer = setTimeout(
      () => {
        abortController?.abort();
        terminal = true;
        process.exitCode = 1;
        process.exit();
      },
      Math.max(0, cutoffAtMs - Date.now()),
    );
    if (frame.testMode === 'hang_before_ready') return;
    if (!withinDeadline()) {
      process.exitCode = 1;
      process.exit();
      return;
    }
    const ready = encodeLiveIsolatedTransportFrameV1({
      schema: LIVE_ISOLATED_TRANSPORT_PROTOCOL_SCHEMA_V1,
      version: LIVE_ISOLATED_TRANSPORT_PROTOCOL_VERSION_V1,
      kind: 'ready',
      nonce,
    });
    if (!ready) {
      process.exitCode = 1;
      process.exit();
      return;
    }
    process.stdout.write(`${ready}\n`);
    return;
  }
  if (!nonce || frame.nonce !== nonce || !withinDeadline()) {
    process.exitCode = 1;
    process.exit();
    return;
  }
  if (frame.kind === 'cancel') {
    if (!dispatched) {
      terminal = true;
      process.exitCode = 1;
      process.exit();
      return;
    }
    abortController?.abort();
    return;
  }
  if (dispatched) {
    process.exitCode = 1;
    process.exit();
    return;
  }
  void execute(frame);
}

function withinDeadlineForInit(value: number): boolean {
  return Number.isSafeInteger(value) && value > Date.now();
}

async function readProtocol(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (!terminal) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      if (new TextEncoder().encode(pending).byteLength > 96 * 1024) {
        process.exitCode = 1;
        process.exit();
        return;
      }
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const raw = parseLiveIsolatedTransportFrameLineV1(line);
        const frame = parseLiveIsolatedTransportParentFrameV1(raw);
        if (!frame) {
          process.exitCode = 1;
          process.exit();
          return;
        }
        acceptFrame(frame);
        newline = pending.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

void readProtocol().catch(() => {
  if (hardCutoffTimer) clearTimeout(hardCutoffTimer);
  process.exitCode = 1;
  process.exit();
});
