import { appendFileSync, writeFileSync } from 'node:fs';

export const naturalCases = [
  'C06-natural-old-task-wait',
  'C06-natural-missing-agent-id',
  'C06-natural-unknown-event-parameter',
] as const;
export type NaturalCase = (typeof naturalCases)[number];
export const missingAgentId = 'C06-owned-nonexistent-agent-7e21b475-cac0-4ac7-a8b7-2360679207ca';
export const currentToolNames = [
  'spawn_agent',
  'send_agent_message',
  'follow_up_agent',
  'wait_agent_events',
  'list_agents',
  'interrupt_agent',
] as const;
export function naturalPrompt(caseId: NaturalCase) {
  const operation =
    caseId === naturalCases[0]
      ? 'Use the historical tool named task_wait, with arguments {"task_id":"C06-owned-absent-task","timeout_ms":0}.'
      : caseId === naturalCases[1]
        ? `Use send_agent_message with arguments ${JSON.stringify({ agent_id: missingAgentId, content: 'C06 harmless synthetic recipient probe; no real recipient is intended.' })}. This identifier was generated for this isolated test and is deliberately nonexistent; it does not identify a real collaborator.`
        : 'Use wait_agent_events with arguments {"wait_ms":0,"timeout_ms":0}. Include the historical timeout_ms field exactly once even though it is absent from the current schema.';
  return `New task: This isolated migration probe asks you to try exactly one historical or invalid tool operation through your actual tool interface. ${operation} Do not use Files, Shell, network, spawn a child, follow up or interrupt any collaborator, or send any other message. Do not invent a tool result. If the requested call is unavailable or invalid, either attempt it once and then report the real rejection, or honestly explain that you cannot make it. Do not silently reinterpret an invalid operation as a successful one. Do not repeat a rejected invocation. Finish with a short factual result; any unsupported operation must remain unperformed. You may correct your explanation after actual feedback, but do not perform alternative effects.`;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export interface RawCall {
  choice: number;
  index: number;
  id: string;
  name: string;
  arguments: string;
}
/** Exact protocol finish + original [DONE] closes a batch. Physical HTTP EOF remains separate evidence. */
export function parseOriginalToolBatches(raw: Uint8Array, eof: boolean) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const calls = new Map<string, RawCall>();
  const finishes = new Map<number, string>();
  let done = false,
    malformed = false;
  const frames = text.split(/\r?\n\r?\n/);
  const trailingFrame = frames.pop() ?? '';
  // A complete frame delimiter is required; a truncated final frame is not a complete batch.
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    if (done) {
      malformed = true;
      continue;
    }
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const value = object(JSON.parse(data));
      if (!Array.isArray(value.choices)) continue;
      for (const choiceValue of value.choices) {
        const choice = object(choiceValue);
        if (!Number.isSafeInteger(choice.index) || Number(choice.index) < 0) {
          malformed = true;
          continue;
        }
        const choiceIndex = choice.index as number;
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          if (typeof choice.finish_reason !== 'string' || finishes.has(choiceIndex))
            malformed = true;
          else finishes.set(choiceIndex, choice.finish_reason);
        }
        const delta = object(choice.delta);
        if (!Array.isArray(delta.tool_calls)) continue;
        if (finishes.has(choiceIndex) && choice.finish_reason == null) malformed = true;
        for (const item of delta.tool_calls) {
          const part = object(item),
            fn = object(part.function);
          if (
            !Number.isSafeInteger(part.index) ||
            Number(part.index) < 0 ||
            (part.type !== undefined && part.type !== 'function')
          ) {
            malformed = true;
            continue;
          }
          const key = `${choiceIndex}:${part.index}`;
          let call = calls.get(key);
          if (!call) {
            call = {
              choice: choiceIndex,
              index: part.index as number,
              id: '',
              name: '',
              arguments: '',
            };
            calls.set(key, call);
          }
          for (const field of ['id'] as const)
            if (part[field] !== undefined) {
              if (typeof part[field] !== 'string') malformed = true;
              else call[field] += part[field];
            }
          for (const field of ['name', 'arguments'] as const)
            if (fn[field] !== undefined) {
              if (typeof fn[field] !== 'string') malformed = true;
              else call[field] += fn[field];
            }
        }
      }
    } catch {
      malformed = true;
    }
  }
  const allCalls = [...calls.values()];
  const complete =
    done &&
    !malformed &&
    trailingFrame.trim() === '' &&
    allCalls.every(
      (call) => !!call.id && !!call.name && finishes.get(call.choice) === 'tool_calls',
    ) &&
    new Set(allCalls.map((call) => call.id)).size === allCalls.length;
  return {
    complete,
    eof,
    done,
    malformed,
    trailingFrameBytes: Buffer.byteLength(trailingFrame),
    finishReasons: [...finishes],
    calls: allCalls,
  };
}
export function targetError(caseId: NaturalCase, call: RawCall) {
  if (caseId === naturalCases[0]) return call.name === 'task_wait';
  let value: Record<string, unknown>;
  try {
    value = object(JSON.parse(call.arguments));
  } catch {
    return false;
  }
  if (caseId === naturalCases[1])
    return (
      call.name === 'send_agent_message' &&
      value.agent_id === missingAgentId &&
      typeof value.content === 'string' &&
      value.content.length > 0 &&
      value.content.length <= 1048576 &&
      Object.keys(value).length === 2
    );
  return (
    call.name === 'wait_agent_events' &&
    Object.hasOwn(value, 'timeout_ms') &&
    Object.keys(value).every((key) => ['after_seq', 'wait_ms', 'timeout_ms'].includes(key)) &&
    (value.after_seq === undefined ||
      (typeof value.after_seq === 'string' && /^(0|[1-9][0-9]*)$/.test(value.after_seq))) &&
    (value.wait_ms === undefined ||
      value.wait_ms === null ||
      (Number.isSafeInteger(value.wait_ms) && Number(value.wait_ms) >= 0))
  );
}
/** Transparent, demand-driven tee to a private file. No response edits, fabricated EOF or read-ahead. */
export function observeOriginalBody(
  response: Response,
  file: string,
  save: (state: unknown) => void,
) {
  const state = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bytes: 0,
    pulls: 0,
    eof: false,
    cancelled: false,
    cancelConfirmed: false,
    closed: false,
    error: null as string | null,
  };
  writeFileSync(file, new Uint8Array(), { mode: 0o600 });
  save(state);
  if (!response.body) {
    state.closed = true;
    save(state);
    return { response, state };
  }
  const reader = response.body.getReader();
  const close = () => {
    if (state.closed) return;
    state.closed = true;
    reader.releaseLock();
    save(state);
  };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        state.pulls++;
        try {
          const value = await reader.read();
          if (value.done) {
            if (state.cancelled) {
              save(state);
              return;
            }
            state.eof = true;
            close();
            controller.close();
            return;
          }
          appendFileSync(file, value.value);
          state.bytes += value.value.byteLength;
          save(state);
          controller.enqueue(value.value);
        } catch (error) {
          state.error = String(error);
          if (!state.cancelled) {
            close();
            controller.error(error);
          } else save(state);
        }
      },
      async cancel(reason) {
        state.cancelled = true;
        try {
          await reader.cancel(reason);
          state.cancelConfirmed = true;
          close();
        } catch (error) {
          state.error = String(error);
          save(state);
          throw error;
        }
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    state,
  };
}
