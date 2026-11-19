import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFixedModel,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import { createArtifactStore } from '../../../../src/artifacts';
import type {
  JobDefinition,
  JobEvent,
  Json,
  OperationRef,
  ToolContext,
} from '../../../../src/extensions';
import { createModelToolSurface } from '../../../../src/model-tools';
import { formatShellResult } from '../../../../src/shell-result-presentation';
import { openSqliteStore } from '../../../../src/sqlite';
import type { ToolCall } from '../../../../src/storage/types';
import { createShellExtension } from '../../../../src/tools/shell';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const permissionsSchema = {
  type: 'object',
  properties: {
    filesystem: { enum: ['workspace_write', 'full_access'] },
    network: { enum: ['none', 'internet'] },
  },
  required: ['filesystem', 'network'],
  additionalProperties: false,
};
function calls(...items: [string, Record<string, unknown>][]): ModelEvent[] {
  return [
    ...items.map(([name, input], index) => ({
      type: 'tool_call' as const,
      id: `call-${index}`,
      name,
      arguments: JSON.stringify(input),
    })),
    { ...finish, reason: 'tool_calls' },
  ];
}
function observedShellId(request: ModelRequest): string {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== 'tool') continue;
    const publicHandle = /shell_id:\s*("(?:[^"\\]|\\.)*")/.exec(message.content);
    if (publicHandle) return JSON.parse(publicHandle[1]!);
    try {
      const result = JSON.parse(message.content);
      const shellId = result.shell_id ?? result.shellId;
      if (typeof shellId === 'string') return shellId;
    } catch {}
  }
  throw Error('original_shell_handle_not_present_in_model_feedback');
}
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > deadline) throw Error('unified_shell_fixture_deadline');
    await Bun.sleep(5);
  }
}
async function fixture(
  responses: ModelEvent[][],
  hold = false,
  reenter = false,
  output: readonly JobEvent[] = [
    { type: 'output', stream: 'stdout', content: 'original durable output\n' },
  ],
  contextWindowTokens?: number,
  terminal?: { details: Json; outcome: 'succeeded' | 'failed'; confinement?: Json },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell-unified-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const requests: ModelRequest[] = [];
  const model: ModelAdapter & { requests: ModelRequest[] } = {
    requests,
    async *stream(request, { signal }) {
      signal.throwIfAborted();
      const events = responses[requests.length];
      requests.push(structuredClone(request));
      if (!events) throw Error('unified_shell_model_responses_exhausted');
      for (const original of events) {
        signal.throwIfAborted();
        const event = structuredClone(original);
        if (event.type === 'tool_call') {
          const input = JSON.parse(event.arguments);
          if (input.shell_id === 'original') input.shell_id = observedShellId(request);
          yield { ...event, arguments: JSON.stringify(input) };
        } else {
          yield event;
        }
      }
    },
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals = new WeakMap<object, AbortSignal>();
  const inputs: Json[] = [];
  const started: string[] = [];
  const cancelled: string[] = [];
  let probes = 0;
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Controlled original Shell effect',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' }, permissions: permissionsSchema },
      required: ['command'],
      additionalProperties: false,
    },
    async start(input, context) {
      inputs.push(input);
      started.push(context.executionId);
      appendFileSync(join(root, 'effects'), `${context.executionId}\n`);
      const handle = {
        reference: {
          executionId: context.executionId,
          ...(terminal?.confinement ? { confinement: terminal.confinement } : {}),
        },
      };
      signals.set(handle, context.signal);
      return handle;
    },
    async *observe(handle): AsyncIterable<JobEvent> {
      yield* output;
      if (hold) await gate;
      const cancelled = signals.get(handle)!.aborted;
      const details = terminal?.details ?? (cancelled ? undefined : { exitCode: 0 });
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: cancelled ? 'cancelled' : (terminal?.outcome ?? 'succeeded'),
          content: 'original Shell ended',
          ...(details ? { details } : {}),
        },
      };
    },
    async cancel(handle) {
      cancelled.push(String((handle.reference as Record<string, Json>).executionId));
      release();
      return { status: 'stopped' };
    },
    async dispose() {},
  };
  const registered = createShellExtension({ job, permissionsSchema });
  const extension = reenter
    ? {
        ...registered,
        tools: registered.tools!.map((tool) =>
          tool.id === 'shell.execute'
            ? {
                ...tool,
                async execute(input: Json, context: Parameters<typeof tool.execute>[1]) {
                  await tool.execute(input, context);
                  return tool.execute(
                    { ...(input as Record<string, Json>), description: 'Updated display only' },
                    context,
                  );
                },
              }
            : tool,
        ),
      }
    : registered;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: join(root, 'data'), profile: 'test' },
      store,
    }),
    model,
    modelId: 'fixed',
    ...(contextWindowTokens === undefined
      ? {}
      : {
          async resolveRunConfiguration() {
            return {
              model,
              modelId: 'fixed',
              snapshot: {
                configuration: {
                  models: [
                    {
                      id: 'fixed',
                      modelCapabilities: { contextWindowTokens, maxOutputTokens: 512 },
                    },
                  ],
                },
              },
            };
          },
        }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture-allow' };
      },
    },
    extensions: [
      extension,
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.probe',
            version: '1',
            description: 'Independent ordinary operation',
            inputSchema: { type: 'object' },
            async execute() {
              probes++;
              return { outcome: 'succeeded', content: 'independent probe completed' };
            },
          },
          {
            id: 'fixture.block',
            version: '1',
            description: 'Hold the parent until its actual cancellation',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              await new Promise<void>((resolve) => {
                if (context.signal.aborted) resolve();
                else context.signal.addEventListener('abort', () => resolve(), { once: true });
              });
              context.signal.throwIfAborted();
              return { outcome: 'succeeded', content: 'unreachable' };
            },
          },
          {
            id: 'fixture.legacy',
            version: '1',
            description: 'Isolated trusted caller of the preserved internal legacy Shell entry',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const original = await context.operations.ensure({
                key: 'legacy-carrier',
                request: {
                  kind: 'tool',
                  definitionId: 'shell.launch',
                  definitionVersion: '1',
                  input: {
                    key: 'legacy-shell',
                    command: 'historical command',
                    permissions: { filesystem: 'workspace_write', network: 'none' },
                    cancellation: 'attached',
                  },
                },
              });
              const execution = await context.operations.wait(original, { signal: context.signal });
              return {
                outcome: 'succeeded',
                content: JSON.stringify(execution.result),
                details: { ref: original as unknown as Json },
              };
            },
          },
        ],
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'test',
  });
  await runtime.createSession({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'test',
  });
  return {
    root,
    store,
    model,
    runtime,
    expectedStoreId,
    extension,
    job,
    inputs,
    started,
    cancelled,
    probes: () => probes,
    async run() {
      await runtime.submitCommand({
        expectedStoreId,
        subjectId: 'owner',
        commandId: 'work',
        sessionId: 's',
        request: { kind: 'run.start', content: 'Execute the exact owned Shell operation.' },
      });
      await runtime.waitForCommand('work');
      return runtime.getView('s');
    },
    async close() {
      release();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('confirmed Windows Shell cleanup presents the actual scope and recovery without changing the original receipt', async () => {
  for (const cleanupConfirmed of [false, true]) {
    const details = {
      exitCode: 1,
      cleanupConfirmed,
      processTreeStopped: true,
    };
    const f = await fixture(
      [calls(['shell_execute', { command: 'start and use a local helper' }]), [finish]],
      false,
      false,
      undefined,
      undefined,
      {
        details,
        outcome: 'failed',
        confinement: {
          backend: 'windows-restricted-token-job',
          filesystem: 'workspace_write',
          network: 'none',
        },
      },
    );
    try {
      await f.run();
      const feedback = f.model.requests[1]!.messages.find((message) => message.role === 'tool')!;
      expect(feedback.content.includes('Any state held only in those processes')).toBe(
        cleanupConfirmed,
      );
      expect(feedback.content.includes('The command ran with filesystem:"workspace_write"')).toBe(
        cleanupConfirmed,
      );
      expect(f.started).toHaveLength(1);
      const original = (await f.store.listExecutions('s')).find(
        (execution) => execution.definitionId === 'shell.command',
      )!;
      expect(original.result).toMatchObject({ details });
      expect(JSON.stringify(original.result)).not.toContain('explicitly requesting filesystem');
      expect(JSON.stringify(original.result)).not.toContain('Any state held only');
    } finally {
      await f.close();
    }
  }
});

test('the current Shell model surface has four tools and rejects hidden legacy parameters before execution', async () => {
  const f = await fixture([[finish]]);
  try {
    const tools = f.extension.tools!;
    const historical: ToolCall[] = [
      {
        id: 'historical-launch',
        name: 'shell.launch',
        arguments: JSON.stringify({
          key: 'old-background',
          command: 'historical command',
          permissions: { filesystem: 'full_access', network: 'none' },
          cancellation: 'detached',
        }),
        model: { name: 'shell_launch' },
      },
      {
        id: 'historical-execute',
        name: 'shell.execute',
        arguments: JSON.stringify({
          key: 'old-foreground',
          command: 'historical command',
          timeoutMs: 100,
          permissions: { filesystem: 'workspace_write', network: 'internet' },
        }),
        model: {
          name: 'shell_execute',
          parameters: [{ path: ['timeoutMs'], name: 'execution_timeout_ms' }],
        },
      },
    ];
    const surface = createModelToolSurface(
      {
        modelId: 'fixed',
        requestId: 'surface',
        messages: [{ role: 'assistant', content: '', toolCalls: historical }],
        tools: tools.map((tool) => ({
          id: tool.id,
          definitionVersion: tool.version,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
      new Map(tools.map((tool) => [tool.id, tool])),
    );
    expect(surface.tools.map((tool) => tool.id)).toEqual([
      'shell_execute',
      'shell_read',
      'shell_wait',
      'shell_stop',
    ]);
    const lifecycle = 'Kite stops remaining child processes when the command exits';
    expect(surface.tools[0]!.description).not.toContain(lifecycle);
    for (const dialect of ['powershell', 'git-bash'] as const) {
      const windows = createShellExtension({
        job: f.job,
        permissionsSchema,
        dialect,
        powerShellVersion: '7.6.9',
        gitBashVersion: '5.3.15(2)-release',
        windowsUserLocale: 'zh-CN',
      });
      const tool = windows.tools!.find((tool) => tool.id === 'shell.execute')!;
      const { description } = tool;
      const version = dialect === 'powershell' ? 'PowerShell 7.6.9' : 'Git Bash 5.3.15(2)-release';
      expect(description).toContain(version);
      expect(description).toContain('Windows user locale is zh-CN.');
      expect(description).toContain('Kite reads stdout and stderr as UTF-8.');
      expect(tool.inputSchema.properties).toMatchObject({
        command: { description: expect.stringContaining(version) },
        filesystem: {
          description: expect.stringContaining('startup or bidirectional local named pipe'),
        },
        network: {
          description: expect.stringContaining(
            'Set "none" for local file work and local named-pipe IPC, including when requesting full_access.',
          ),
        },
      });
      expect(description).toContain(`${lifecycle}, including with background:true.`);
      expect(description).toContain('flush their changes and close them before it exits');
      expect(description).toContain(
        'Default local named pipes can deny bidirectional access under workspace_write',
      );
      expect(description).toContain(
        'supported single-process or standalone batch mode before execution',
      );
    }
    expect(surface.request.messages[0]!.toolCalls).toEqual([
      {
        id: historical[0]!.id,
        name: 'shell_launch',
        arguments: historical[0]!.arguments,
      },
      {
        id: historical[1]!.id,
        name: 'shell_execute',
        arguments: JSON.stringify({
          key: 'old-foreground',
          command: 'historical command',
          permissions: { filesystem: 'workspace_write', network: 'internet' },
          execution_timeout_ms: 100,
        }),
      },
    ]);
    expect(Object.keys(surface.tools[0]!.inputSchema.properties!).sort()).toEqual(
      [
        'command',
        'description',
        'background',
        'execution_timeout_ms',
        'filesystem',
        'network',
        'workdir',
        'max_output_tokens',
      ].sort(),
    );
    const decode = (input: Record<string, unknown>) =>
      surface.decode({
        id: 'call',
        name: 'shell_execute',
        arguments: JSON.stringify({ command: 'read', ...input }),
      });
    const valid = decode({ background: false, execution_timeout_ms: 3600000, network: 'internet' });
    expect(valid.model?.error).toBeUndefined();
    expect(JSON.parse(valid.arguments)).toEqual({
      command: 'read',
      background: false,
      execution_timeout_ms: 3600000,
      network: 'internet',
    });
    for (const input of [
      { permissions: { filesystem: 'workspace_write', network: 'none' } },
      { key: 'not-a-model-parameter' },
      { cancellation: 'detached' },
      { timeoutMs: 1 },
      { background: true, execution_timeout_ms: 1 },
      { execution_timeout_ms: 0 },
      { execution_timeout_ms: 3600001 },
      { execution_timeout_ms: 1.5 },
      { filesystem: 'outside' },
      { network: 'localhost' },
      { max_output_tokens: 0 },
      { max_output_tokens: 1.5 },
    ])
      expect(decode(input).model?.error).toBe('invalid_tool_arguments');
    expect(
      surface.decode({ id: 'old', name: 'shell_launch', arguments: '{"key":"x","command":"x"}' })
        .model?.error,
    ).toBe('tool_not_available');
    expect(f.started).toEqual([]);
  } finally {
    await f.close();
  }
});

test('default foreground execution waits for one original Job and preserves its reference and durable output', async () => {
  const f = await fixture([
    calls(['shell_execute', { command: 'one read' }]),
    calls(['shell_read', { shell_id: 'original' }], ['shell_wait', { shell_id: 'original' }]),
    [finish],
  ]);
  try {
    const view = await f.run();
    const shell = f.model.requests[0]!.tools!.find((tool) => tool.id === 'shell_execute')!;
    expect(shell.description).toContain(
      'Prefer rg for text search and rg --files for file discovery',
    );
    expect(shell.description).toStartWith(
      'Execute one supervised command. Choose the filesystem request before composing the command.',
    );
    expect(shell.inputSchema.properties).toMatchObject({
      filesystem: {
        description: expect.stringContaining(
          'Set "full_access" explicitly for commands required by the active skill, including its validation and delivery steps',
        ),
      },
      network: {
        description: expect.stringContaining(
          'including localhost, 127.0.0.1, ::1, LAN and the Internet',
        ),
      },
    });
    const jobs = view.executions.filter((execution) => execution.kind === 'job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('succeeded');
    expect(f.started).toEqual([jobs[0]!.id]);
    expect(f.inputs).toEqual([{ command: 'one read' }]);
    const result = view.executions.find(
      (execution) => execution.definitionId === 'shell.execute',
    )!.result;
    expect(result).toMatchObject({
      outcome: 'succeeded',
      content: 'original durable output\n',
      details: { ref: { executionId: jobs[0]!.id }, outputFormat: 'model-preview' },
    });
    expect(
      f.model.requests[1]!.messages.some(
        (message) => message.role === 'tool' && message.content.includes('original durable output'),
      ),
    ).toBe(true);
    expect(
      f.model.requests[2]!.messages.filter((message) => message.role === 'tool').some((message) =>
        message.content.includes(observedShellId(f.model.requests[1]!)),
      ),
    ).toBe(true);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe(`${jobs[0]!.id}\n`);
    const page = await f.store.listBackgroundExecutions({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      rootSessionId: 's',
      includeSourceTool: true,
    });
    const original = page.items.find((item) => item.execution.id === jobs[0]!.id)!;
    expect(original.sourceTool).toMatchObject({
      definitionId: 'shell.execute',
      definitionVersion: '1',
    });
    expect(original.sourceTool).not.toHaveProperty('background');
  } finally {
    await f.close();
  }
});

test('foreground and original Shell read preserve interleaved output bytes across the row limit', async () => {
  const output: JobEvent[] = [
    { type: 'output', stream: 'stdout', content: '  A: par' },
    { type: 'output', stream: 'stdout', content: 'tial  \r' },
    { type: 'output', stream: 'stdout', content: '\n' },
    { type: 'output', stream: 'stderr', content: '\tB: warning \r\n' },
    { type: 'output', stream: 'stdout', content: ' C: back' },
    ...Array.from(
      { length: 194 },
      (): JobEvent => ({ type: 'output', stream: 'stdout', content: 'x' }),
    ),
    { type: 'output', stream: 'stdout', content: ' end\t' },
    { type: 'output', stream: 'stdout', content: ' of line \r\n' },
    { type: 'output', stream: 'stdout', content: '\n  ' },
  ];
  const expectedPage = `  A: partial  \r\n\tB: warning \r\n C: back${'x'.repeat(194)} end\t`;
  const expectedOutput = `${expectedPage} of line \r\n\n  `;
  const f = await fixture(
    [
      calls(['shell_execute', { command: 'emit interleaved output' }]),
      calls(['shell_read', { shell_id: 'original', limit: 200 }]),
      [finish],
    ],
    false,
    false,
    output,
  );
  try {
    const view = await f.run();
    const job = view.executions.find((entry) => entry.definitionId === 'shell.command')!;
    expect(job.result).toMatchObject({ outcome: 'succeeded', details: { exitCode: 0 } });
    expect(f.started).toEqual([job.id]);
    expect(f.inputs).toEqual([{ command: 'emit interleaved output' }]);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe(`${job.id}\n`);
    for (const [name, modelRequest, expected] of [
      ['shell.execute', 1, expectedOutput],
      ['shell.read', 2, expectedPage],
    ] as const) {
      const stored = view.executions.find((entry) => entry.definitionId === name)!.result!;
      expect(stored).toMatchObject({
        outcome: 'succeeded',
        content: expected,
        details: {
          ref: { executionId: job.id },
          outputFormat: 'model-preview',
          outputLimited: false,
        },
      });
      expect(stored).not.toHaveProperty('details.stdout');
      expect(stored).not.toHaveProperty('details.stderr');
      expect(stored).not.toHaveProperty('details.output');
      const feedback = f.model.requests[modelRequest]!.messages.filter(
        (message) => message.role === 'tool',
      ).at(-1)!.content;
      const bodyStart = feedback.indexOf('\n\n');
      expect(bodyStart).toBeGreaterThan(0);
      expect(feedback.slice(0, bodyStart)).toContain('Exit code: 0.');
      const body = feedback.slice(bodyStart + 2);
      if (name === 'shell.read') {
        const cursorPrefix = '\nOutput cursor: ';
        const cursorStart = body.lastIndexOf(cursorPrefix);
        expect(cursorStart).toBeGreaterThan(0);
        expect(body.slice(0, cursorStart)).toBe(expected);
        expect(JSON.parse(body.slice(cursorStart + cursorPrefix.length))).toMatchObject({
          caught_up: false,
          terminal: true,
        });
      } else expect(body).toBe(expected);
    }
  } finally {
    await f.close();
  }
});

test('large Shell output keeps the supervised cursor and saves only the output section received by the model', async () => {
  const chunks = Array.from({ length: 180 }, (_, index) => {
    const prefix = `chunk-${String(index).padStart(3, '0')}: `;
    return `${prefix}${'x'.repeat(16384 - prefix.length - 1)}\n`;
  });
  const f = await fixture(
    [
      calls(['shell_execute', { command: 'emit output', max_output_tokens: 50000 }]),
      calls(['shell_read', { shell_id: 'original', limit: 200, max_output_tokens: 64 }]),
      [finish],
    ],
    false,
    false,
    chunks.map((content) => ({ type: 'output', stream: 'stdout', content })),
    2000,
  );
  try {
    const view = await f.run();
    const job = view.executions.find((entry) => entry.definitionId === 'shell.command')!;
    const tool = view.executions.find((entry) => entry.definitionId === 'shell.execute')!;
    expect(f.started).toEqual([job.id]);
    expect(f.inputs).toEqual([{ command: 'emit output' }]);
    expect(job.status).toBe('succeeded');
    const saved = await f.store.listExecutionOutput({ executionId: job.id, limit: 200 });
    const retained = saved.items.map((item) => item.content).join('');
    const omitted = saved.items.filter((item) => item.droppedBytes !== '0');
    expect(retained).toStartWith(chunks[0]!);
    expect(retained).toEndWith(chunks.at(-1)!);
    expect(retained).not.toContain('chunk-090');
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(1024 * 1024);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.droppedBytes).toBe(String(chunks.length * 16384 - retained.length));
    expect(tool.result).toMatchObject({
      details: { outputFormat: 'model-preview', outputLimited: true, truncated: true },
    });
    const stored = tool.result as { content: string; details: Record<string, Json> };
    expect(stored.details).not.toHaveProperty('stdout');
    expect(stored.details).not.toHaveProperty('stderr');
    expect(Buffer.byteLength(stored.content)).toBeLessThanOrEqual(2000);
    expect(view.runs.map((run) => ({ status: run.status, reason: run.reason }))).toEqual([
      { status: 'completed', reason: null },
    ]);
    const started = f.model.requests[1]!.messages.filter((message) => message.role === 'tool').at(
      -1,
    )!.content;
    expect(started).toContain('chunk-000');
    expect(started).toContain(stored.content);
    expect(started).toContain('Model output preview omitted');
    expect(started).toContain(`Collection omitted ${omitted[0]!.droppedBytes} output bytes`);
    expect(Buffer.byteLength(started)).toBeLessThan(2500);
    const read = f.model.requests[2]!.messages.filter((message) => message.role === 'tool').at(
      -1,
    )!.content;
    const storedRead = view.executions.find((entry) => entry.definitionId === 'shell.read')!
      .result as { content: string; details: Record<string, Json> };
    expect(storedRead.details).not.toHaveProperty('output');
    expect(storedRead.details.outputGaps).toEqual([
      { stream: 'stdout', droppedBytes: omitted[0]!.droppedBytes },
    ]);
    expect(storedRead.details).toMatchObject({
      outputFormat: 'model-preview',
      outputLimited: true,
    });
    const smaller = formatShellResult({
      execution: view.executions.find((entry) => entry.definitionId === 'shell.read')!,
      result: storedRead,
      operation: job,
      starter: tool,
      modelTokenLimit: 32,
    });
    expect(smaller).toContain(`Output bytes unavailable: ${omitted[0]!.droppedBytes} (stdout).`);
    expect(smaller).toContain('Model output preview omitted');
    expect(read).toContain(storedRead.content);
    expect(Buffer.byteLength(storedRead.content)).toBeLessThanOrEqual(256);
    expect(read).toContain('Output cursor:');
    expect(read).toContain('Model output preview omitted');
    expect(Buffer.byteLength(read)).toBeLessThan(1000);
  } finally {
    await f.close();
  }
});

test('background output keeps its live cursor and publishes both stream gaps before the cancelled Job settles', async () => {
  const first = 'first\n';
  const middle = 'x'.repeat(32768);
  const last = 'last stderr\n';
  const f = await fixture(
    [calls(['shell_execute', { command: 'emit background output', background: true }]), [finish]],
    true,
    false,
    [
      { type: 'output', stream: 'stdout', content: first },
      ...Array.from(
        { length: 48 },
        (): JobEvent => ({
          type: 'output',
          stream: 'stdout',
          content: middle,
        }),
      ),
      { type: 'output_dropped', stream: 'stderr', bytes: '31' },
      { type: 'output', stream: 'stderr', content: last },
    ],
  );
  try {
    const view = await f.run();
    const job = await until(
      async () =>
        (await f.store.listExecutions('s')).find((entry) => entry.definitionId === 'shell.command'),
      (entry) => entry?.status === 'running',
    );
    const live = await until(
      () => f.store.listExecutionOutput({ executionId: job!.id }),
      (page) => page.items.length === 16,
    );
    expect(live.items[0]!.content).toBe(first);
    expect(live.items.every((item) => item.droppedBytes === '0')).toBeTrue();
    expect(live.items.some((item) => item.content === last)).toBeFalse();
    expect(view.executions.find((entry) => entry.definitionId === 'shell.execute')?.status).toBe(
      'succeeded',
    );
    await f.store.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      commandId: 'stop-exact-job',
      targetCommandId: job!.originCommandId,
      subjectId: 'owner',
    });
    await until(
      () => f.store.getExecution(job!.id),
      (entry) => entry?.status === 'cancelled',
    );
    const next = await f.store.listExecutionOutput({
      executionId: job!.id,
      afterSeq: live.highWaterSeq,
    });
    expect(next.items.at(-1)!.content).toBe(last);
    const gaps = next.items.filter((item) => item.droppedBytes !== '0');
    expect(gaps).toEqual([
      expect.objectContaining({
        stream: 'stdout',
        droppedBytes: String(48 * middle.length - live.items.slice(1).length * middle.length),
      }),
      expect.objectContaining({ stream: 'stderr', droppedBytes: '31' }),
    ]);
    expect(
      (
        await f.store.listExecutionOutput({
          executionId: job!.id,
          upperSeq: live.highWaterSeq,
        })
      ).items,
    ).toEqual(live.items);
    expect(f.started).toEqual([job!.id]);
  } finally {
    await f.close();
  }
});

test('background execution accepts one original Job and read/wait/stop keep that exact execution', async () => {
  const f = await fixture(
    [
      calls(['shell_execute', { command: 'held read', background: true }]),
      calls(['shell_wait', { shell_id: 'original', wait_ms: 50 }]),
      calls(['shell_read', { shell_id: 'original' }]),
      calls(['shell_stop', { shell_id: 'original' }]),
      calls(['shell_wait', { shell_id: 'original' }], ['shell_read', { shell_id: 'original' }]),
      [finish],
    ],
    true,
  );
  try {
    const view = await f.run();
    const jobs = view.executions.filter((execution) => execution.kind === 'job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('cancelled');
    expect(f.started).toEqual([jobs[0]!.id]);
    expect(f.cancelled).toEqual([jobs[0]!.id]);
    expect(
      view.executions.find((execution) => execution.definitionId === 'shell.execute')!.result,
    ).toMatchObject({
      outcome: 'succeeded',
      details: { accepted: true, ref: { executionId: jobs[0]!.id } },
    });
    const accepted = f.model.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(accepted.content).toContain('accepted for background execution');
    expect(accepted.content).not.toContain('original Shell ended');
    expect(
      f.model.requests[3]!.messages.some(
        (message) => message.role === 'tool' && message.content.includes('original durable output'),
      ),
    ).toBe(true);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe(`${jobs[0]!.id}\n`);
    const scope = { expectedStoreId: f.expectedStoreId, subjectId: 'owner', rootSessionId: 's' };
    const page = await f.store.listBackgroundExecutions({ ...scope, includeSourceTool: true });
    expect(page.items.find((item) => item.execution.id === jobs[0]!.id)!.sourceTool).toMatchObject({
      definitionId: 'shell.execute',
      definitionVersion: '1',
      background: true,
    });
    const plain = await f.store.listBackgroundExecutions(scope);
    expect(plain.items.find((item) => item.execution.id === jobs[0]!.id)).not.toHaveProperty(
      'sourceTool',
    );
  } finally {
    await f.close();
  }
});

test('flat permission dimensions normalize independently and description is excluded from original Job input', async () => {
  const inputs = [
    { command: 'read' },
    { command: 'read', filesystem: 'full_access', description: 'First purpose' },
    { command: 'read', network: 'internet', description: 'Second purpose' },
    { command: 'read', filesystem: 'full_access', network: 'internet' },
    { command: 'read', filesystem: 'workspace_write', network: 'none' },
  ];
  const f = await fixture([...inputs.map((input) => calls(['shell_execute', input])), [finish]]);
  try {
    const view = await f.run();
    expect(view.executions.filter((execution) => execution.kind === 'job')).toHaveLength(
      inputs.length,
    );
    expect(f.inputs).toEqual([
      { command: 'read' },
      { command: 'read', permissions: { filesystem: 'full_access', network: 'none' } },
      { command: 'read', permissions: { filesystem: 'workspace_write', network: 'internet' } },
      { command: 'read', permissions: { filesystem: 'full_access', network: 'internet' } },
      { command: 'read', permissions: { filesystem: 'workspace_write', network: 'none' } },
    ]);
    expect(f.started).toHaveLength(inputs.length);
  } finally {
    await f.close();
  }
});

test('reentering one persisted Tool identity reuses its original Job even when display description changes', async () => {
  const f = await fixture(
    [
      calls(['shell_execute', { command: 'one original effect', description: 'Initial display' }]),
      calls(['shell_read', { shell_id: 'original' }]),
      [finish],
    ],
    false,
    true,
  );
  try {
    const view = await f.run();
    const jobs = view.executions.filter((execution) => execution.kind === 'job');
    expect(jobs).toHaveLength(1);
    expect(f.started).toEqual([jobs[0]!.id]);
    expect(f.inputs).toEqual([{ command: 'one original effect' }]);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe(`${jobs[0]!.id}\n`);
    expect(
      view.executions.filter((execution) => execution.definitionId === 'shell.execute'),
    ).toHaveLength(1);
    expect(observedShellId(f.model.requests[1]!)).toHaveLength(26);
    expect(
      f.model.requests[2]!.messages.some(
        (message) =>
          message.role === 'tool' &&
          message.content.includes(observedShellId(f.model.requests[1]!)),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('invalid new model arguments create no Job and preserve ordinary independent batch execution', async () => {
  const invalid = [
    { background: true, execution_timeout_ms: 1 },
    { filesystem: 'unknown' },
    { network: 'unknown' },
    { cancellation: 'detached' },
    { permissions: { filesystem: 'full_access', network: 'internet' } },
    { key: 'not-a-model-parameter' },
    { execution_timeout_ms: 3600001 },
  ];
  const f = await fixture([
    calls(
      ...invalid.map((input): [string, Record<string, unknown>] => [
        'shell_execute',
        { command: 'must not execute', ...input },
      ]),
      ['fixture.probe', {}],
    ),
    [finish],
  ]);
  try {
    const view = await f.run();
    expect(view.runs[0]!.status).toBe('completed');
    expect(view.executions.filter((execution) => execution.kind === 'job')).toEqual([]);
    expect(f.started).toEqual([]);
    expect(f.probes()).toBe(1);
    const tools = view.executions.filter((execution) => execution.definitionId === 'shell.execute');
    expect(tools).toHaveLength(invalid.length);
    expect(tools.every((execution) => execution.status === 'failed')).toBe(true);
    expect(f.model.requests).toHaveLength(2);
    expect(
      f.model.requests[1]!.messages.filter(
        (message) =>
          message.role === 'tool' &&
          message.content.includes('arguments do not match the tool schema'),
      ),
    ).toHaveLength(invalid.length);
  } finally {
    await f.close();
  }
});

test('background work remains attached when its active parent Run is cancelled', async () => {
  const f = await fixture(
    [
      calls(['shell_execute', { command: 'held read', background: true }]),
      calls(['fixture.block', {}]),
      [finish],
    ],
    true,
  );
  try {
    const work = f.run();
    const rows = await until(
      () => f.store.listExecutions('s'),
      (executions) =>
        executions.some(
          (execution) =>
            execution.definitionId === 'fixture.block' &&
            ['dispatching', 'running'].includes(execution.status),
        ) &&
        executions.some((execution) => execution.kind === 'job' && execution.status === 'running'),
    );
    const parent = rows.find((execution) => execution.definitionId === 'fixture.block')!;
    const job = rows.find((execution) => execution.kind === 'job')!;
    await f.runtime.cancelRun({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: 'cancel-parent',
      runId: parent.runId!,
    });
    await work;
    const stopped = await until(
      () => f.store.getExecution(job.id),
      (execution) => execution?.status === 'cancelled',
    );
    expect(stopped!.id).toBe(job.id);
    expect(f.started).toEqual([job.id]);
    expect(f.cancelled).toEqual([job.id]);
    expect(
      (await f.store.listExecutions('s')).filter((execution) => execution.kind === 'job'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('a legacy launch reference survives closing and reopening the same Store without replaying its Job', async () => {
  const f = await fixture([calls(['fixture.legacy', {}]), [finish]]);
  let reopened: ReturnType<typeof createRuntime> | undefined;
  let coldStore: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await f.run();
    const jobs = await until(
      () => f.store.listExecutions('s'),
      (executions) =>
        executions.some(
          (execution) => execution.kind === 'job' && execution.status === 'succeeded',
        ),
    );
    const original = jobs.find((execution) => execution.kind === 'job')!;
    expect(f.started).toEqual([original.id]);
    expect(jobs.find((execution) => execution.definitionId === 'shell.launch')!.status).toBe(
      'succeeded',
    );
    await f.runtime.close();
    coldStore = await openSqliteStore({ dataRoot: join(f.root, 'data'), profile: 'test' });
    const model = createFixedModel([
      calls(
        ['shell_read', { shell_id: 'legacy-shell' }],
        ['shell_wait', { shell_id: 'legacy-shell' }],
      ),
      [finish],
    ]);
    reopened = createRuntime({
      store: coldStore,
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture-allow' };
        },
      },
      extensions: [createShellExtension({ job: f.job, permissionsSchema })],
    });
    await reopened.submitCommand({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: 'cold-read',
      request: {
        kind: 'run.start',
        content: 'Read and wait on the original historical Shell without executing it again.',
      },
    });
    await reopened.waitForCommand('cold-read');
    const rows = await coldStore.listExecutions('s');
    expect(
      rows.filter((execution) => execution.kind === 'job').map((execution) => execution.id),
    ).toEqual([original.id]);
    expect(f.started).toEqual([original.id]);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe(`${original.id}\n`);
    const readers = rows.filter((execution) =>
      ['shell.read', 'shell.wait'].includes(execution.definitionId),
    );
    expect(readers).toHaveLength(2);
    expect(readers.every((execution) => execution.status === 'succeeded')).toBe(true);
    expect(
      model.requests[1]!.messages.some(
        (message) => message.role === 'tool' && message.content.includes('original durable output'),
      ),
    ).toBe(true);
    expect(
      model.requests[1]!.messages.filter(
        (message) => message.role === 'tool' && message.content.includes(original.id),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  } finally {
    if (reopened) await reopened.close();
    else if (coldStore) await coldStore.close();
    await f.close();
  }
});

test('the unified execute wrapper preserves an unconfirmed cancellation reason and its actual Shell handle', async () => {
  const f = await fixture([[finish]]);
  const controller = new AbortController();
  let ensured = 0;
  let original: OperationRef | undefined;
  const context = {
    executionId: 'original-persisted-tool',
    signal: controller.signal,
    records: {
      async get() {
        return null;
      },
      async write() {},
    },
    operations: {
      async ensure(input: { key: string }) {
        ensured++;
        original = {
          originStoreId: f.expectedStoreId,
          sessionId: 's',
          extensionId: 'builtin.shell',
          commandId: 'original-operation',
          executionId: 'original-job',
          key: input.key,
        };
        return original;
      },
      async wait(ref: OperationRef) {
        expect(ref).toEqual(original!);
        controller.abort(Error('cancel_requested'));
        throw controller.signal.reason;
      },
      async get(ref: OperationRef) {
        expect(ref).toEqual(original!);
        throw Error('stop_receipt_unavailable');
      },
      async cancel() {
        throw Error('must_not_request_a_second_cancellation');
      },
    },
  } as unknown as ToolContext;
  try {
    const result = await f.extension
      .tools!.find((tool) => tool.id === 'shell.execute')!
      .execute({ command: 'original command' }, context);
    expect(ensured).toBe(1);
    expect(result.outcome).toBe('outcome_unknown');
    expect(result.content).toContain('Stopping the command could not be confirmed');
    expect(result.content).toContain(original!.key);
    expect(result.details).toMatchObject({
      code: 'shell_cancellation_unconfirmed',
      ref: original!,
      shell_id: original!.key,
      cancellationObserved: false,
    });
    expect(f.started).toEqual([]);
  } finally {
    await f.close();
  }
});
