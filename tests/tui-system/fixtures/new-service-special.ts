import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { JobDefinition, JobEvent, JobHandle, ToolResult } from '@kite-ai/agent/extensions';
import type { ModelAdapter } from '@kite-ai/ai';
import type { ProcessHostConfiguration } from '../../../apps/service/src/bootstrap';
import { createMcpOAuthBrowser } from '../../../apps/service/src/mcp-oauth-browser';
import type { ProcessServiceOptions } from '../../../apps/service/src/process-service';

const base = process.env.KITE_TUI_FIXTURE_BASE_SERVICE;
const expected = process.env.KITE_TUI_FIXTURE_BASE_SHA;
const mode = process.env.KITE_TUI_SPECIAL_FIXTURE;
if (
  !base ||
  !expected ||
  createHash('sha256').update(readFileSync(base)).digest('hex') !== expected
)
  throw Error('special_fixture_service_source_changed');
const { runServiceProcess } = await import(pathToFileURL(base).href);
const delay = (ms: number) => Bun.sleep(ms);
const waitAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
const deferred = new AbortController();
let invocation = 0;
const owned = new WeakMap<
  JobHandle,
  {
    index: number;
    signal: AbortSignal;
    markers: string[];
    stop?: ReturnType<JobDefinition['cancel']>;
  }
>();
function append(result: ToolResult, markers: string[]): ToolResult {
  const extra = markers.join('');
  const details =
    result.details && typeof result.details === 'object' && !Array.isArray(result.details)
      ? result.details
      : undefined;
  return {
    ...result,
    content: `${result.content}\n${extra}`,
    ...(details && typeof details.stdout === 'string'
      ? { details: { ...details, stdout: `${details.stdout}${extra}` } }
      : {}),
  };
}
function decorateJob(job: JobDefinition): JobDefinition {
  return {
    ...job,
    async start(input, context) {
      if (mode === 'unavailable-sandbox') {
        // A real missing backend mechanism. No fallback process is executed.
        Bun.spawn([`${process.cwd()}/.test-owned-missing-shell-backend`], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });
        throw Error('missing_shell_backend_unexpectedly_started');
      }
      const handle = await job.start(input, context);
      owned.set(handle, { index: ++invocation, signal: context.signal, markers: [] });
      return handle;
    },
    async *observe(handle): AsyncIterable<JobEvent> {
      const state = owned.get(handle)!;
      if (mode === 'cancel-successor' && state.index === 1) {
        state.markers.push('OLD_SHELL_RUNNING\n');
        yield { type: 'output', stream: 'stdout', content: state.markers[0]! };
        await waitAbort(state.signal);
      } else if (mode === 'cancel-successor' && state.index === 2) {
        state.markers.push('SUCCESSOR_LINE_ONE\n');
        yield { type: 'output', stream: 'stdout', content: state.markers[0]! };
        await delay(500);
        state.markers.push('SUCCESSOR_LINE_TWO\n');
        yield { type: 'output', stream: 'stdout', content: state.markers[1]! };
        await delay(1200);
      } else if (mode === 'presentation-race') {
        state.markers.push(
          'LATE_EPHEMERAL_TOOL_PROGRESS_MARKER\n',
          'LATE_DURABLE_TOOL_LIFECYCLE_MARKER\n',
        );
        for (const content of state.markers) yield { type: 'output', stream: 'stdout', content };
      }
      // Terminal outcome and supervision always come from the actual default Job.
      for await (const event of job.observe(handle))
        yield event.type === 'terminal'
          ? { ...event, result: append(event.result, state.markers) }
          : event;
    },
    async cancel(handle) {
      const state = owned.get(handle);
      if (mode !== 'cancel-successor' || state?.index !== 1) return job.cancel(handle);
      // Keep the original stop outcome authoritative. The bounded adapter
      // confirmation remains pending, so Core cannot publish a terminal yet.
      state.stop ??= (async () => {
        const confirmation = await job.cancel(handle);
        await delay(5000);
        return confirmation;
      })();
      return state.stop;
    },
    async dispose(handle) {
      try {
        await job.dispose(handle);
      } finally {
        owned.delete(handle);
      }
    },
  };
}
const options: ProcessServiceOptions = {
  ...(mode === 'mcp-auth' || mode === 'mcp-management' || mode === 'mcp-project'
    ? {
        credentialBackend: createTemporaryCredentialBackend(),
        mcpSources: {
          ...(mode === 'mcp-project'
            ? {
                variables: () => ({ MCP_STARTUP_MARKER: process.env.KITE_TUI_PROJECT_MCP_MARKER! }),
              }
            : {}),
          http: { allowLoopbackForTests: true },
          oauth: {
            network: { allowLoopbackForTests: true },
            openBrowser: createMcpOAuthBrowser((_argv, options) =>
              Bun.spawn([`${process.cwd()}/.test-owned-missing-oauth-opener`], options),
            ),
          },
        },
      }
    : {}),
  beforeResourceClose: async () => {
    deferred.abort();
  },
  decorateConfiguration(configuration: ProcessHostConfiguration) {
    if (mode === 'four-subagents') {
      // A real adapter cleanup boundary keeps this cancellation journey's
      // pre-terminal observation meaningful. Never delay a production Run or
      // manufacture a terminal: the original stream still owns every event,
      // error and result, and Core must await its actual finally completion.
      const wrap = (model: ModelAdapter): ModelAdapter => ({
        ...(model.describeRequest ? { describeRequest: model.describeRequest.bind(model) } : {}),
        async *stream(request, options) {
          try {
            yield* model.stream(request, options);
          } finally {
            if (options.signal.aborted) await delay(150);
          }
        },
      });
      const resolveChild = configuration.resolveChildRunConfiguration;
      return {
        ...configuration,
        maxConcurrentSubagents: 4,
        childConfigurations: configuration.childConfigurations?.map((child) => ({
          ...child,
          model: wrap(child.model),
        })),
        ...(resolveChild
          ? {
              async resolveChildRunConfiguration(input) {
                const child = await resolveChild(input);
                return child.model ? { ...child, model: wrap(child.model) } : child;
              },
            }
          : {}),
      };
    }
    const resolve = configuration.resolveRunConfiguration;
    if (!resolve) return configuration;
    return {
      ...configuration,
      ...(mode === 'deferred-sandbox'
        ? {
            diagnosticSource: {
              snapshot: async () =>
                new Promise<never>((_, reject) => {
                  const abort = () => reject(Error('fixture_sandbox_preparation_aborted'));
                  if (deferred.signal.aborted) abort();
                  else deferred.signal.addEventListener('abort', abort, { once: true });
                }),
            },
          }
        : {}),
      async resolveRunConfiguration(...args) {
        const selected = await resolve(...args);
        const controlled = new Map<string, { runId: string; sessionId: string }>();
        const resourceScopes = new Map<string, { runId: string; sessionId: string }>();
        const originalStep = selected.readStepCapabilities;
        const decorateExtensions = (extensions: typeof selected.extensions) =>
          extensions?.map((extension) =>
            extension.id === 'builtin.shell'
              ? { ...extension, jobs: extension.jobs?.map(decorateJob) }
              : extension,
          );
        const readStep = originalStep
          ? async (input: Parameters<typeof originalStep>[0]) => {
              const step = await originalStep(input);
              return { ...step, extensions: decorateExtensions(step.extensions) };
            }
          : undefined;
        const permission = selected.permissions;
        const controlledUrl = process.env.KITE_TUI_CONTROLLED_MCP_URL;
        return {
          ...selected,
          ...(readStep ? { readStepCapabilities: readStep } : {}),
          ...(controlledUrl && readStep && permission
            ? {
                async readStepCapabilities(input: Parameters<NonNullable<typeof readStep>>[0]) {
                  const step = await readStep(input);
                  const facts =
                    step.snapshot &&
                    typeof step.snapshot === 'object' &&
                    !Array.isArray(step.snapshot)
                      ? (step.snapshot.cached ?? step.snapshot.mcp)
                      : undefined;
                  controlled.clear();
                  resourceScopes.clear();
                  if (Array.isArray(facts))
                    for (const value of facts) {
                      if (
                        !value ||
                        typeof value !== 'object' ||
                        Array.isArray(value) ||
                        typeof value.serverId !== 'string'
                      )
                        continue;
                      const expected = createHash('sha256')
                        .update(
                          JSON.stringify({
                            id: value.serverId,
                            configuration: { type: 'http', url: controlledUrl },
                          }),
                        )
                        .digest('hex');
                      if (
                        value.configDigest !== expected ||
                        value.originalStoreId !== input.command.originStoreId
                      )
                        continue;
                      if (
                        process.env.KITE_TUI_CONTROLLED_MCP_TOOL === 'search documentation / latest'
                      )
                        resourceScopes.set(value.serverId, {
                          runId: input.run.id,
                          sessionId: input.session.id,
                        });
                      const extension = step.extensions?.find(
                        (extension) => extension.id === `builtin.mcp.remote.${value.serverId}`,
                      );
                      for (const tool of extension?.tools ?? []) {
                        const schema = tool.inputSchema as {
                          type?: string;
                          properties?: { message?: { type?: string } };
                          required?: string[];
                        };
                        const remoteName = process.env.KITE_TUI_CONTROLLED_MCP_TOOL;
                        const field =
                          remoteName === 'search documentation / latest' ? 'query' : 'message';
                        if (
                          remoteName &&
                          tool.id ===
                            `mcp.${value.serverId}.${createHash('sha256').update(JSON.stringify(remoteName)).digest('hex').slice(0, 32)}` &&
                          schema.type === 'object' &&
                          Object.keys(schema.properties ?? {}).length === 1 &&
                          (schema.properties as Record<string, { type?: string }> | undefined)?.[
                            field
                          ]?.type === 'string' &&
                          schema.required?.length === 1 &&
                          schema.required[0] === field
                        )
                          controlled.set(`${tool.id}@${tool.version}`, {
                            runId: input.run.id,
                            sessionId: input.session.id,
                          });
                      }
                    }
                  return step;
                },
                permissions: {
                  toolDispatchOrder: permission.toolDispatchOrder,
                  async authorize(request: Parameters<typeof permission.authorize>[0]) {
                    const decision = await permission.authorize(request);
                    const target =
                      controlled.get(`${request.definitionId}@${request.definitionVersion}`) ??
                      (['mcp.resources.list', 'mcp.resources.read'].includes(
                        request.definitionId,
                      ) &&
                      request.definitionVersion === '1' &&
                      request.input &&
                      typeof request.input === 'object' &&
                      !Array.isArray(request.input) &&
                      typeof request.input.serverId === 'string'
                        ? resourceScopes.get(request.input.serverId)
                        : undefined);
                    if (
                      request.kind === 'tool' &&
                      target?.runId === request.runId &&
                      target.sessionId === request.sessionId &&
                      (decision.approval || decision.check)
                    ) {
                      const { approval: _approval, check: _check, ...original } = decision;
                      return {
                        ...original,
                        allowed: true,
                        reason: 'controlled_fixture_readonly_echo',
                      };
                    }
                    return decision;
                  },
                },
              }
            : {}),
          extensions: decorateExtensions(selected.extensions),
        };
      },
    };
  },
};
await runServiceProcess(options);
