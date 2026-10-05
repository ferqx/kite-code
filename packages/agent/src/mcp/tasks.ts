import { isDeepStrictEqual } from 'node:util';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  GetTaskResultSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  JobDefinition,
  JobHandle,
  Json,
  StopConfirmation,
  ToolDefinition,
  ToolResult,
} from '../extensions';

/** Private live adapter: no cold restoration and no I/O until the ordinary Job starts. */
export function createTaskBinding(options: {
  descriptor: Tool;
  tool: Pick<ToolDefinition, 'id' | 'version' | 'description' | 'inputSchema'>;
  identity: Json;
  client: Client;
  timeout: number;
  validateInput(input: Json): boolean;
  validateOutput(input: unknown): boolean;
  beforeStart(signal: AbortSignal): Promise<void>;
  retain(): () => Promise<void>;
  request<T>(work: () => Promise<T>): Promise<T>;
}) {
  const tickets = new Map<string, { input: Json; sessionId: string; originStoreId: string }>();
  const states = new WeakMap<
    JobHandle,
    {
      taskId: string;
      signal: AbortSignal;
      release: () => Promise<void>;
      terminal?: ToolResult;
      ended: boolean;
      cancellation?: Promise<StopConfirmation>;
    }
  >();
  const jobId = `${options.tool.id}.task`;
  const wire = <T>(
    method: string,
    params: Record<string, unknown>,
    schema: Parameters<Client['request']>[1],
    signal?: AbortSignal,
  ) =>
    options.request(() =>
      options.client.request({ method, params }, schema, {
        timeout: options.timeout,
        ...(signal ? { signal } : {}),
      }),
    ) as Promise<T>;
  const unknown = (code: string): ToolResult => ({
    outcome: 'outcome_unknown',
    content: code,
    details: { remoteStopConfirmed: false },
  });
  function state(handle: JobHandle) {
    const value = states.get(handle);
    if (!value) throw new Error('mcp_task_live_handle_unavailable');
    return value;
  }
  const job: JobDefinition = {
    id: jobId,
    version: options.tool.version,
    description:
      'Execute one immutable remote MCP Task; transport authentication does not grant this Job',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ticket', 'arguments', 'binding'],
      properties: {
        ticket: { type: 'string' },
        arguments: options.tool.inputSchema,
        binding: { const: options.identity },
      },
    },
    async start(input, context) {
      const ticket =
        input && typeof input === 'object' && !Array.isArray(input) ? input.ticket : undefined;
      const admitted = typeof ticket === 'string' ? tickets.get(ticket) : undefined;
      if (
        !admitted ||
        admitted.sessionId !== context.sessionId ||
        JSON.stringify((input as Record<string, Json>).arguments) !==
          JSON.stringify(admitted.input) ||
        !isDeepStrictEqual((input as Record<string, Json>).binding, options.identity)
      )
        throw new Error('mcp_task_binding_unavailable');
      tickets.delete(ticket as string);
      await options.beforeStart(context.signal);
      const release = options.retain();
      try {
        const created = await options.request(() =>
          options.client.request(
            {
              method: 'tools/call',
              params: { name: options.descriptor.name, arguments: admitted.input },
            },
            CreateTaskResultSchema,
            { task: {}, timeout: options.timeout, signal: context.signal },
          ),
        );
        const handle: JobHandle = {
          reference: {
            adapter: 'mcp.task',
            adapterVersion: 1,
            binding: options.identity,
            originalStoreId: admitted.originStoreId,
            sessionId: context.sessionId,
            executionId: context.executionId,
            taskId: created.task.taskId,
          },
        };
        states.set(handle, {
          taskId: created.task.taskId,
          signal: context.signal,
          release,
          ended: false,
        });
        return handle;
      } catch (error) {
        await release();
        throw error; // Generic Job host preserves dispatched-but-unconfirmed effects.
      }
    },
    async *observe(handle) {
      const active = state(handle);
      let result: ToolResult;
      try {
        for (;;) {
          if (active.terminal) {
            result = active.terminal;
            break;
          }
          active.signal.throwIfAborted();
          const task = await wire<{ taskId: string; status: string; pollInterval?: number }>(
            'tasks/get',
            { taskId: active.taskId },
            GetTaskResultSchema,
            active.signal,
          );
          if (task.taskId !== active.taskId) throw new Error('mcp_task_identity_invalid');
          if (task.status === 'completed') {
            const value = await wire<{
              content: unknown;
              structuredContent?: unknown;
              isError?: boolean;
            }>('tasks/result', { taskId: active.taskId }, CallToolResultSchema, active.signal);
            active.ended = true;
            result =
              !value.isError && !options.validateOutput(value.structuredContent)
                ? unknown('mcp_task_output_invalid')
                : {
                    outcome: value.isError ? 'failed' : 'succeeded',
                    content: JSON.stringify(value.content),
                    details: JSON.parse(JSON.stringify(value)) as Json,
                  };
            break;
          }
          if (task.status === 'failed' || task.status === 'cancelled') {
            active.ended = true;
            result = {
              outcome: task.status === 'cancelled' ? 'cancelled' : 'failed',
              content: `mcp_task_${task.status}`,
            };
            break;
          }
          if (task.status === 'input_required') {
            result = unknown('mcp_task_input_required_unsupported');
            break;
          }
          yield { type: 'progress', value: { taskId: active.taskId, status: task.status } };
          // Remote poll hints cannot delay cancellation or install an unbounded timer.
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              active.signal.removeEventListener('abort', onAbort);
              reject(new Error('mcp_task_cancelled'));
            };
            const timer = setTimeout(
              () => {
                active.signal.removeEventListener('abort', onAbort);
                resolve();
              },
              Math.max(1, Math.min(250, task.pollInterval ?? 100)),
            );
            active.signal.addEventListener('abort', onAbort, { once: true });
            if (active.signal.aborted) onAbort();
          });
        }
      } catch {
        if (active.cancellation) await active.cancellation;
        result = active.terminal ?? unknown('mcp_task_unconfirmed');
      }
      active.terminal = result;
      yield { type: 'terminal', result, supervision: active.ended ? 'ended' : 'unknown' };
    },
    cancel(handle) {
      const active = state(handle);
      if (active.ended) return Promise.resolve({ status: 'already_finished' as const });
      if (active.cancellation) return active.cancellation;
      active.cancellation = (async (): Promise<StopConfirmation> => {
        try {
          const value = await wire<{ taskId: string; status: string }>(
            'tasks/cancel',
            { taskId: active.taskId },
            CancelTaskResultSchema,
          );
          if (value.taskId !== active.taskId) return { status: 'unknown' };
          if (value.status === 'cancelled') {
            active.ended = true;
            active.terminal = { outcome: 'cancelled', content: 'mcp_task_cancelled' };
            return { status: 'stopped' };
          }
          if (value.status === 'completed' || value.status === 'failed') {
            active.ended = true;
            return { status: 'already_finished' };
          }
          return { status: 'requested' };
        } catch {
          return { status: 'unknown' };
        }
      })();
      return active.cancellation;
    },
    async dispose(handle) {
      const active = state(handle);
      if (active.ended) await active.release();
    },
  };
  const tool: ToolDefinition = {
    ...options.tool,
    async execute(input, context) {
      const captured = structuredClone(input);
      try {
        if (!options.validateInput(captured))
          return { outcome: 'failed', content: 'mcp_arguments_invalid' };
      } catch {
        return { outcome: 'failed', content: 'mcp_payload_limit' };
      }
      context.signal.throwIfAborted();
      const own = await context.getExecution(context.executionId);
      if (!own?.originStoreId)
        return { outcome: 'failed', content: 'mcp_task_binding_unavailable' };
      if (tickets.size >= 512) return { outcome: 'failed', content: 'mcp_task_capacity' };
      const ticket = context.executionId;
      if (!tickets.has(ticket))
        tickets.set(ticket, {
          input: captured,
          sessionId: context.sessionId,
          originStoreId: own.originStoreId,
        });
      try {
        const ref = await context.operations.ensure({
          key: 'remote-task',
          cancellation: 'detached',
          request: {
            kind: 'job',
            definitionId: job.id,
            definitionVersion: job.version,
            input: { ticket, arguments: captured, binding: options.identity },
          },
        });
        return {
          outcome: 'succeeded',
          content: 'MCP Task scheduled; this receipt is not remote completion',
          details: { operationRef: ref as unknown as Json, remoteCompleted: false },
        };
      } catch (error) {
        tickets.delete(ticket);
        throw error;
      }
    },
  };
  return { tool, job };
}
