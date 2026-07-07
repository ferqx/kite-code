import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command, isInterrupted } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import type { AgentConfig } from '../src/core/config/index';
import { buildCodeAgentGraph } from '../src/core/harness/graph';

// ---------------------------------------------------------------------------
// Fake model — overrides `invoke` to return predefined AIMessage responses
// without making any real API calls.
// ---------------------------------------------------------------------------

class FakeChatModel extends ChatOpenAI {
  _retryListener: unknown = null;
  private _callCount = 0;

  get callCount() {
    return this._callCount;
  }

  private _responses: AIMessage[];
  constructor(responses: AIMessage[]) {
    super({
      apiKey: 'noop',
      model: 'fake',
      configuration: { baseURL: 'http://localhost:9999' },
      temperature: 0,
    });
    this._responses = responses;
  }

  override async invoke(_input: unknown, _options?: unknown): Promise<any> {
    const response =
      this._responses[this._callCount] ?? this._responses[this._responses.length - 1];
    this._callCount++;
    return response;
  }

  // Prevent bind from creating a new instance (which loses our invoke override)
  bind(_kwargs: unknown): this {
    return this;
  }

  override bindTools(_tools: unknown[], _kwargs?: unknown): this {
    return this;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeConfig: AgentConfig = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerName: 'fake' as any,
  providerType: 'openai-compatible',
  apiKey: 'noop',
  baseURL: 'http://localhost:9999',
  modelName: 'fake',
  sandbox: { enabled: true },
};

type GraphChunk = Record<string, unknown>;

async function collectChunks(stream: AsyncIterable<GraphChunk>): Promise<GraphChunk[]> {
  const chunks: GraphChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function findFinal(chunks: GraphChunk[]): string | null {
  for (const chunk of [...chunks].reverse()) {
    const agent = chunk.agent as Record<string, unknown> | undefined;
    if (typeof agent?.final === 'string' && agent.final.length > 0) {
      return agent.final;
    }
  }
  return null;
}

function findInterrupt(chunks: GraphChunk[]): Record<string, unknown> | null {
  for (const chunk of chunks) {
    if (isInterrupted(chunk)) {
      const raw = (chunk as Record<string, unknown>).__interrupt__;
      if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object') {
        const item = raw[0] as Record<string, unknown>;
        // LangGraph wraps interrupts as { id, value }; unwrap if present
        const value = item.value;
        if (value && typeof value === 'object') {
          return value as Record<string, unknown>;
        }
        return item;
      }
      return (raw as Record<string, unknown>) ?? null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Integration tests — full graph loop with mock model
// ---------------------------------------------------------------------------

describe('graph integration', () => {
  let workspace: string;
  let checkpointPath: string;

  function setUp() {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-code-integration-'));
    checkpointPath = path.join(workspace, 'checkpoint.db');
  }

  function tearDown() {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  // -----------------------------------------------------------------------
  // Direct answer
  // -----------------------------------------------------------------------

  test('completes task with direct answer when model returns no tool calls', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([new AIMessage({ content: '任务已完成。' })]) as any,
      });

      const chunks = await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('打个招呼')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 't1',
            workspace,
          },
          {
            configurable: { thread_id: 't1' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      const final = findFinal(chunks);
      expect(final).toBe('任务已完成。');
      expect(chunks.length).toBeGreaterThanOrEqual(2); // cleanup + agent node
    } finally {
      tearDown();
    }
  });

  // -----------------------------------------------------------------------
  // Read-file tool — no approval needed
  // -----------------------------------------------------------------------

  test('executes read_file tool and returns final answer', async () => {
    setUp();
    try {
      fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello world');

      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-r1',
                name: 'read_file',
                args: { path: 'hello.txt' },
              },
            ],
          }),
          new AIMessage({
            content: '文件内容是 hello world，任务完成。',
          }),
        ]) as any,
      });

      const chunks = await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('读取 hello.txt')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 't2',
            workspace,
          },
          {
            configurable: { thread_id: 't2' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      // agent → tools → agent
      expect(chunks.length).toBeGreaterThanOrEqual(3);

      const toolsChunk = chunks.find((c) => (c.tools as Record<string, unknown>)?.messages);
      expect(toolsChunk).toBeDefined();

      const final = findFinal(chunks);
      expect(final).toContain('hello world');
    } finally {
      tearDown();
    }
  });

  // -----------------------------------------------------------------------
  // Shell inspect — read-only command bypasses approval
  // -----------------------------------------------------------------------

  test('executes shell_execute inspect commands without approval', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-s1',
                name: 'shell_execute',
                args: { intent: 'inspect', command: 'ls' },
              },
            ],
          }),
          new AIMessage({ content: '目录查看完毕。' }),
        ]) as any,
      });

      const chunks = await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('列出文件')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 't3',
            workspace,
          },
          {
            configurable: { thread_id: 't3' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      const interrupt = findInterrupt(chunks);
      expect(interrupt).toBeNull();

      const final = findFinal(chunks);
      expect(final).toBe('目录查看完毕。');
    } finally {
      tearDown();
    }
  });

  // -----------------------------------------------------------------------
  // Write file — requires approval, then executes after resume
  // -----------------------------------------------------------------------

  test('interrupts for approval on write_file, resumes and executes', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-w1',
                name: 'write_file',
                args: { path: 'out.txt', content: 'hello' },
              },
            ],
          }),
          new AIMessage({ content: '文件已创建。' }),
        ]) as any,
      });

      const stream = await graph.stream(
        {
          messages: [new HumanMessage('创建 out.txt')],
          workspaceAccess: 'write',
          phase: 'building',
          plan: null,
          userId: 'test',
          threadId: 't4',
          workspace,
        },
        {
          configurable: { thread_id: 't4' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const preInterrupt: GraphChunk[] = [];
      for await (const chunk of stream) {
        preInterrupt.push(chunk);
      }

      const interrupt = findInterrupt(preInterrupt);
      expect(interrupt).not.toBeNull();
      expect(interrupt?.kind).toBe('tool_approval');

      // Resume with approval
      const resumeStream = await graph.stream(new Command({ resume: true }), {
        configurable: { thread_id: 't4' },
        streamMode: 'updates',
        recursionLimit: 60,
      });

      const postInterrupt = await collectChunks(resumeStream);

      checkpointer.close();

      const final = findFinal(postInterrupt);
      expect(final).toBe('文件已创建。');

      expect(fs.existsSync(path.join(workspace, 'out.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(workspace, 'out.txt'), 'utf8')).toBe('hello');
    } finally {
      tearDown();
    }
  });

  // -----------------------------------------------------------------------
  // Read-only mode — write_file is rejected without approval interrupt
  // -----------------------------------------------------------------------

  test('rejects write_file under read-only access (routes to tools for rejection)', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-rw1',
                name: 'write_file',
                args: { path: 'out.txt', content: 'should not write' },
              },
            ],
          }),
          new AIMessage({ content: '写入被拒绝，符合预期。' }),
        ]) as any,
      });

      const chunks = await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('创建 out.txt')],
            workspaceAccess: 'write',
            phase: 'planning',
            plan: null,
            userId: 'test',
            threadId: 't5',
            workspace,
          },
          {
            configurable: { thread_id: 't5' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      const interrupt = findInterrupt(chunks);
      expect(interrupt).toBeNull();

      const toolsChunk = chunks.find((c) => (c.tools as Record<string, unknown>)?.messages);
      expect(toolsChunk).toBeDefined();
      const toolsData = toolsChunk?.tools as Record<string, unknown>;
      const messages = toolsData?.messages as Array<{ content: string }>;
      expect(messages).toBeDefined();
      const toolContent = JSON.parse(messages?.[0]?.content ?? '{}');
      expect(toolContent.ok).toBe(false);
      expect(toolContent.stderr ?? toolContent.failure?.reason ?? '').toContain('planning');

      expect(fs.existsSync(path.join(workspace, 'out.txt'))).toBe(false);

      const final = findFinal(chunks);
      expect(final).toBe('写入被拒绝，符合预期。');
    } finally {
      tearDown();
    }
  });

  // -----------------------------------------------------------------------
  // Multi-step: inspect → read → final
  // -----------------------------------------------------------------------

  test('handles multi-step task with shell inspect then read_file then final', async () => {
    setUp();
    try {
      fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'src', 'app.ts'), 'export const x = 1;');

      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-m1',
                name: 'shell_execute',
                args: { intent: 'inspect', command: 'ls src' },
              },
            ],
          }),
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-m2',
                name: 'read_file',
                args: { path: 'src/app.ts' },
              },
            ],
          }),
          new AIMessage({
            content: '文件 src/app.ts 包含: export const x = 1;',
          }),
        ]) as any,
      });

      const chunks = await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('探索并读取 src 目录')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 't6',
            workspace,
          },
          {
            configurable: { thread_id: 't6' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      const interrupt = findInterrupt(chunks);
      expect(interrupt).toBeNull();

      // agent → tools → agent → tools → agent
      expect(chunks.length).toBeGreaterThanOrEqual(5);

      const final = findFinal(chunks);
      expect(final).toContain('src/app.ts');
      expect(final).toContain('export const x = 1');
    } finally {
      tearDown();
    }
  });

  // -----------------------------------------------------------------------
  // update_plan tool — always allowed, returns plan state
  // -----------------------------------------------------------------------

  test('executes update_plan and persists plan state', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-p1',
                name: 'update_plan',
                args: {
                  name: '我的计划',
                  description: '测试 update_plan',
                  status: 'in_progress',
                  steps: [
                    { step: '检查代码', status: 'completed' },
                    { step: '修改代码', status: 'in_progress' },
                  ],
                },
              },
            ],
          }),
          new AIMessage({ content: '计划已更新。' }),
        ]) as any,
      });

      const chunks = await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('创建计划')],
            workspaceAccess: 'write',
            phase: 'building',
            // 设置已有 plan 使 update_plan 走 tools 直通路径（纯进度更新），
            // 名称/描述/步骤文本完全一致，仅 status 变化 → 不触发 plan_review
            // existing plan matches model output → progress-only → tools, no plan_review interrupt
            plan: {
              name: '我的计划',
              description: '测试 update_plan',
              status: 'pending',
              steps: [
                { step: '检查代码', status: 'pending' },
                { step: '修改代码', status: 'pending' },
              ],
            },
            userId: 'test',
            threadId: 't7',
            workspace,
          },
          {
            configurable: { thread_id: 't7' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      const interrupt = findInterrupt(chunks);
      expect(interrupt).toBeNull();

      const toolsChunk = chunks.find((c) => (c.tools as Record<string, unknown>)?.plan);
      expect(toolsChunk).toBeDefined();
      const plan = (toolsChunk?.tools as Record<string, unknown>)?.plan as Record<string, unknown>;
      expect(plan?.name).toBe('我的计划');
      expect(plan?.status).toBe('in_progress');

      const final = findFinal(chunks);
      expect(final).toBe('计划已更新。');
    } finally {
      tearDown();
    }
  });

  // -----------------------------------------------------------------------
  // Rejection on destructive shell command (no full_access)
  // -----------------------------------------------------------------------

  test('rejects destructive shell_execute without full_access', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-d1',
                name: 'shell_execute',
                args: { command: 'rm -rf /tmp/foo' },
              },
            ],
          }),
          new AIMessage({ content: '命令被拒绝，无法执行。' }),
        ]) as any,
      });

      const chunks = await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('删除临时文件')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 't8',
            workspace,
          },
          {
            configurable: { thread_id: 't8' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      const interrupt = findInterrupt(chunks);
      expect(interrupt).toBeNull();

      const toolsChunk = chunks.find((c) => (c.tools as Record<string, unknown>)?.messages);
      const messages = (toolsChunk?.tools as Record<string, unknown>)?.messages as Array<{
        content: string;
      }>;
      const toolContent = JSON.parse(messages?.[0]?.content ?? '{}');
      expect(toolContent.ok).toBe(false);

      const final = findFinal(chunks);
      expect(final).toBe('命令被拒绝，无法执行。');
    } finally {
      tearDown();
    }
  });

  // -----------------------------------------------------------------------
  // ask_user tool — routes to user_input interrupt
  // -----------------------------------------------------------------------

  test('routes ask_user to user_input interrupt under write access', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-ask1',
                name: 'ask_user',
                args: {
                  question: '选哪个方案？',
                  options: [
                    { id: 'a', label: '方案 A' },
                    { id: 'b', label: '方案 B' },
                  ],
                },
              },
            ],
          }),
        ]) as any,
      });

      const chunks = await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('需要确认方案')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 't9',
            workspace,
          },
          {
            configurable: { thread_id: 't9' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      const interrupt = findInterrupt(chunks);
      expect(interrupt).not.toBeNull();
      expect(interrupt?.kind).toBe('user_input');

      const request = interrupt?.request as Record<string, unknown>;
      expect(request?.name).toBe('ask_user');
    } finally {
      tearDown();
    }
  });
});

// ---------------------------------------------------------------------------
// Sandbox executor integration — verify the graph passes custom shell executors
// ---------------------------------------------------------------------------

describe('sandbox executor in agent graph', () => {
  let workspace: string;
  let checkpointPath: string;

  function setUp() {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-code-sandbox-int-'));
    checkpointPath = path.join(workspace, 'checkpoint.db');
  }

  function tearDown() {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  test('uses custom shell executor for shell_execute tool', async () => {
    setUp();
    try {
      let calledWith: { command: string } | null = null;
      const spyShell = async (input: { command: string; workspace: string }) => {
        calledWith = { command: input.command };
        return {
          ok: true as const,
          command: input.command,
          exitCode: 0,
          stdout: 'sandboxed output',
          stderr: '',
        };
      };

      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        shellExecutor: spyShell,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-s1',
                name: 'shell_execute',
                args: { intent: 'inspect', command: 'ls' },
              },
            ],
          }),
          new AIMessage({ content: 'listed files via sandbox' }),
        ]) as any,
      });

      const chunks = await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('list files')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 'sbox-1',
            workspace,
          },
          {
            configurable: { thread_id: 'sbox-1' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      // 验证 spy 被调用 / Verify spy was called
      expect(calledWith).not.toBeNull();
      expect(calledWith!.command).toBe('ls');

      const final = findFinal(chunks);
      expect(final).toBe('listed files via sandbox');
    } finally {
      tearDown();
    }
  });

  test('toolResultSink preserves full timeout stdout for bounded long-running commands', async () => {
    setUp();
    try {
      const stdout = Array.from({ length: 30 }, (_, i) => `startup line ${i + 1}`).join('\n');
      const summaries: string[] = [];
      const shell = async (input: { command: string; workspace: string }) => ({
        ok: false as const,
        command: input.command,
        exitCode: 124,
        stdout,
        stderr: 'Command timed out after 5000ms.',
      });

      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        shellExecutor: shell,
        toolResultSink: (_callId, _toolName, _ok, summary) => {
          summaries.push(summary);
        },
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-timeout',
                name: 'shell_execute',
                args: { intent: 'verify', command: 'npm run tui', timeout_ms: 5000 },
              },
            ],
          }),
          new AIMessage({ content: 'tui checked' }),
        ]) as any,
      });

      await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('check tui')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 'sbox-timeout',
            workspace,
            authorization: { mode: 'full_access', commandGrants: {} },
          },
          {
            configurable: { thread_id: 'sbox-timeout' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      expect(summaries[0]).toBe(stdout);
    } finally {
      tearDown();
    }
  });
});

// ---------------------------------------------------------------------------
// Checkpoint recovery tests
// ---------------------------------------------------------------------------

describe('checkpoint recovery', () => {
  let workspace: string;
  let checkpointPath: string;

  function setUp() {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-code-ckpt-'));
    checkpointPath = path.join(workspace, 'checkpoint.db');
  }

  function tearDown() {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  test('preserves state across interrupt and resume', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-w1',
                name: 'write_file',
                args: { path: 'a.txt', content: 'first' },
              },
            ],
          }),
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-w2',
                name: 'write_file',
                args: { path: 'b.txt', content: 'second' },
              },
            ],
          }),
          new AIMessage({ content: '两个文件已创建。' }),
        ]),
      });

      // First interrupt — write_file a.txt
      const stream1 = await graph.stream(
        {
          messages: [new HumanMessage('创建两个文件')],
          workspaceAccess: 'write',
          phase: 'building',
          plan: null,
          userId: 'test',
          threadId: 'ck1',
          workspace,
        },
        {
          configurable: { thread_id: 'ck1' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const pre1: GraphChunk[] = [];
      for await (const chunk of stream1) {
        pre1.push(chunk);
      }
      expect(findInterrupt(pre1)).not.toBeNull();

      // Resume with approval
      const stream2 = await graph.stream(new Command({ resume: true }), {
        configurable: { thread_id: 'ck1' },
        streamMode: 'updates',
        recursionLimit: 60,
      });

      // Second interrupt — write_file b.txt
      const pre2: GraphChunk[] = [];
      for await (const chunk of stream2) {
        pre2.push(chunk);
      }
      expect(findInterrupt(pre2)).not.toBeNull();

      // Resume again
      const stream3 = await graph.stream(new Command({ resume: true }), {
        configurable: { thread_id: 'ck1' },
        streamMode: 'updates',
        recursionLimit: 60,
      });

      const finalChunks = await collectChunks(stream3);
      checkpointer.close();

      expect(findFinal(finalChunks)).toBe('两个文件已创建。');
      expect(fs.existsSync(path.join(workspace, 'a.txt'))).toBe(true);
      expect(fs.existsSync(path.join(workspace, 'b.txt'))).toBe(true);
    } finally {
      tearDown();
    }
  });

  test('full_access grant persists across checkpoints and skips subsequent shell approvals', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          // First: shell_execute that will be approved with full_access
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-f1',
                name: 'shell_execute',
                args: { command: 'echo first > x.txt' },
              },
            ],
          }),
          // Second: shell_execute that should skip approval under full_access
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-f2',
                name: 'shell_execute',
                args: { command: 'echo second > y.txt' },
              },
            ],
          }),
          new AIMessage({ content: '完成。' }),
        ]),
      });

      // First interrupt — shell_execute with write redirect needs approval
      const stream1 = await graph.stream(
        {
          messages: [new HumanMessage('创建两个文件，授予 full_access')],
          workspaceAccess: 'write',
          phase: 'building',
          plan: null,
          userId: 'test',
          threadId: 'ck2',
          workspace,
        },
        {
          configurable: { thread_id: 'ck2' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const pre1: GraphChunk[] = [];
      for await (const chunk of stream1) {
        pre1.push(chunk);
      }
      expect(findInterrupt(pre1)).not.toBeNull();

      // Resume with full_access grant
      const stream2 = await graph.stream(new Command({ resume: { grant: 'full_access' } }), {
        configurable: { thread_id: 'ck2' },
        streamMode: 'updates',
        recursionLimit: 60,
      });

      // Under full_access, subsequent shell_execute calls skip approval
      const allChunks = await collectChunks(stream2);
      const interrupts = allChunks.filter((c) => isInterrupted(c));
      expect(interrupts).toHaveLength(0);

      checkpointer.close();

      expect(findFinal(allChunks)).toBe('完成。');
    } finally {
      tearDown();
    }
  });

  // 验证 TUI 实际使用的 resume 格式 { approved: true, grant: "full_access" } 也能正确持久化
  test('full_access grant with approved=true persists and skips subsequent shell approvals', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-f1b',
                name: 'shell_execute',
                args: { command: 'echo first > x.txt' },
              },
            ],
          }),
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-f2b',
                name: 'shell_execute',
                args: { command: 'echo second > y.txt' },
              },
            ],
          }),
          new AIMessage({ content: '完成。' }),
        ]),
      });

      const stream1 = await graph.stream(
        {
          messages: [new HumanMessage('创建两个文件，授予 full_access')],
          workspaceAccess: 'write',
          phase: 'building',
          plan: null,
          userId: 'test',
          threadId: 'ck2b',
          workspace,
        },
        {
          configurable: { thread_id: 'ck2b' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const pre1: GraphChunk[] = [];
      for await (const chunk of stream1) {
        pre1.push(chunk);
      }
      expect(findInterrupt(pre1)).not.toBeNull();

      // Use the EXACT resume format that mapActionToResumeValue produces in the TUI flow
      const stream2 = await graph.stream(
        new Command({ resume: { approved: true, grant: 'full_access' } }),
        {
          configurable: { thread_id: 'ck2b' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const allChunks = await collectChunks(stream2);
      const interrupts = allChunks.filter((c) => isInterrupted(c));
      expect(interrupts).toHaveLength(0);

      checkpointer.close();

      expect(findFinal(allChunks)).toBe('完成。');
    } finally {
      tearDown();
    }
  });

  test('plan state persists across interrupt and resume', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          // Step 1: create plan
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-plan1',
                name: 'update_plan',
                args: {
                  name: '多步任务',
                  description: '创建计划后执行写入',
                  status: 'in_progress',
                  steps: [
                    { step: '创建计划', status: 'completed' },
                    { step: '写入文件', status: 'in_progress' },
                  ],
                },
              },
            ],
          }),
          // Step 2: write file (will interrupt)
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-write1',
                name: 'write_file',
                args: { path: 'result.txt', content: 'done' },
              },
            ],
          }),
          // Step 3: final
          new AIMessage({ content: '计划完成，文件已创建。' }),
        ]),
      });

      const stream1 = await graph.stream(
        {
          messages: [new HumanMessage('执行多步任务')],
          workspaceAccess: 'write',
          phase: 'building',
          // 设置已有 plan 使 update_plan 走 tools 直通路径（纯进度更新），
          // 名称/描述/步骤文本完全一致 → 不触发 plan_review 中断
          plan: {
            name: '多步任务',
            description: '创建计划后执行写入',
            status: 'pending',
            steps: [
              { step: '创建计划', status: 'pending' },
              { step: '写入文件', status: 'pending' },
            ],
          },
          userId: 'test',
          threadId: 'ck3',
          workspace,
        },
        {
          configurable: { thread_id: 'ck3' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const preInterrupt: GraphChunk[] = [];
      for await (const chunk of stream1) {
        preInterrupt.push(chunk);
      }

      // Should have hit interrupt on write_file
      const interrupt = findInterrupt(preInterrupt);
      expect(interrupt).not.toBeNull();

      // Resume with approval
      const stream2 = await graph.stream(new Command({ resume: true }), {
        configurable: { thread_id: 'ck3' },
        streamMode: 'updates',
        recursionLimit: 60,
      });

      const postResume = await collectChunks(stream2);
      checkpointer.close();

      // Verify plan was preserved
      // The final answer should exist
      expect(findFinal(postResume)).toBe('计划完成，文件已创建。');
      expect(fs.existsSync(path.join(workspace, 'result.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(workspace, 'result.txt'), 'utf8')).toBe('done');
    } finally {
      tearDown();
    }
  });

  // ── Pre-plan clarification → Plan Review chain ──

  test('pre-plan ask_user clarification then update_plan triggers plan_review', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          // Step 1: ask_user for clarification before creating plan
          new AIMessage({
            content: 'Let me clarify the scope first.',
            tool_calls: [
              {
                id: 'call-ask1',
                name: 'ask_user',
                args: {
                  question: 'Which approach do you prefer?',
                  options: [
                    { id: 'a', label: 'Minimal', description: 'Smallest change' },
                    { id: 'b', label: 'Full', description: 'Complete rewrite' },
                  ],
                  recommended: 'a',
                  allow_free_text: true,
                },
              },
            ],
          }),
          // Step 2: update_plan after receiving user answer (no existing plan → structural → plan_review)
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-plan2',
                name: 'update_plan',
                args: {
                  name: 'Clarified Plan',
                  description: 'Plan after clarifying user preference.',
                  status: 'in_progress',
                  steps: [
                    { step: 'Research', status: 'pending' },
                    { step: 'Implement minimal version', status: 'pending' },
                  ],
                },
              },
            ],
          }),
          // Step 3: final confirmation after plan approval
          new AIMessage({ content: 'Plan approved. Starting implementation.' }),
        ]),
      });

      // ── Stream 1: agent calls ask_user → user_input interrupt ──
      const stream1 = await graph.stream(
        {
          messages: [new HumanMessage('Improve the project structure')],
          workspaceAccess: 'write',
          phase: 'planning',
          plan: null,
          planReviewed: false,
          userId: 'test',
          threadId: 'clarify1',
          workspace,
        },
        {
          configurable: { thread_id: 'clarify1' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const chunks1: GraphChunk[] = [];
      for await (const chunk of stream1) {
        chunks1.push(chunk);
      }

      const interrupt1 = findInterrupt(chunks1);
      expect(interrupt1).not.toBeNull();
      // First interrupt should be ask_user → user_input
      expect(interrupt1!.kind).toBe('user_input');

      // ── Stream 2: answer clarification → agent calls update_plan → plan_review interrupt ──
      const stream2 = await graph.stream(new Command({ resume: { answer: 'Minimal' } }), {
        configurable: { thread_id: 'clarify1' },
        streamMode: 'updates',
        recursionLimit: 60,
      });

      const chunks2: GraphChunk[] = [];
      for await (const chunk of stream2) {
        chunks2.push(chunk);
      }

      const interrupt2 = findInterrupt(chunks2);
      expect(interrupt2).not.toBeNull();
      // Second interrupt should be update_plan → plan_review
      expect(interrupt2!.kind).toBe('plan_review');

      // ── Stream 3: approve plan → agent continues → final ──
      const stream3 = await graph.stream(
        new Command({ resume: { planApproved: true, executionMode: 'auto' } }),
        {
          configurable: { thread_id: 'clarify1' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const postApprove = await collectChunks(stream3);
      checkpointer.close();

      // Verify plan was approved and agent's final response is present
      const final = findFinal(postApprove);
      expect(final).toBe('Plan approved. Starting implementation.');
    } finally {
      tearDown();
    }
  });

  // ── Plan revision preserves existing authorization ──

  test('plan revision preserves full_access authorization instead of resetting to default', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          // Step 1: update_plan with structural change (description changed → not progress-only)
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-revise1',
                name: 'update_plan',
                args: {
                  name: 'Existing Plan',
                  description: 'Revised: add security review step.',
                  status: 'in_progress',
                  steps: [
                    { step: 'Research', status: 'completed' },
                    { step: 'Security review', status: 'pending' },
                    { step: 'Implement', status: 'pending' },
                  ],
                },
              },
            ],
          }),
          // Step 2: final response after plan revision approval
          new AIMessage({ content: 'Plan revised. Continuing with full_access.' }),
        ]),
      });

      // Start with an already-approved plan and full_access authorization,
      // simulating a mid-execution plan revision.
      const existingPlan = {
        name: 'Existing Plan',
        description: 'Original plan description.',
        status: 'in_progress' as const,
        steps: [
          { step: 'Research', status: 'completed' as const },
          { step: 'Implement', status: 'pending' as const },
        ],
      };

      // ── Stream 1: agent revises plan → plan_review interrupt ──
      const stream1 = await graph.stream(
        {
          messages: [new HumanMessage('Revise the plan to add a security review step')],
          workspaceAccess: 'write',
          phase: 'building',
          plan: existingPlan,
          planReviewed: true,
          authorization: { mode: 'full_access', commandGrants: {} },
          userId: 'test',
          threadId: 'revise1',
          workspace,
        },
        {
          configurable: { thread_id: 'revise1' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const chunks1: GraphChunk[] = [];
      for await (const chunk of stream1) {
        chunks1.push(chunk);
      }

      // Verify plan_review interrupt fired (structural change detected)
      const interrupt = findInterrupt(chunks1);
      expect(interrupt).not.toBeNull();
      expect(interrupt!.kind).toBe('plan_review');

      // ── Stream 2: approve plan revision → check authorization preserved ──
      const stream2 = await graph.stream(
        new Command({ resume: { planApproved: true, executionMode: 'auto' } }),
        {
          configurable: { thread_id: 'revise1' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const chunks2: GraphChunk[] = [];
      for await (const chunk of stream2) {
        chunks2.push(chunk);
      }

      checkpointer.close();

      // Extract the plan_review node's output from the stream
      const planReviewChunk = chunks2.find(
        (c) => (c as Record<string, unknown>).plan_review !== undefined,
      );
      expect(planReviewChunk).toBeDefined();

      const planReviewOutput = (planReviewChunk as Record<string, unknown>).plan_review as Record<
        string,
        unknown
      >;
      // Plan revision must preserve the existing full_access authorization
      expect(planReviewOutput.authorization).toEqual({
        mode: 'full_access',
        commandGrants: {},
      });

      // Final response should be present (agent continued after plan approval)
      const final = findFinal(chunks2);
      expect(final).toBe('Plan revised. Continuing with full_access.');
    } finally {
      tearDown();
    }
  });

  // ── auto mode preserves interactionMode across agent→tools→agent cycles ──

  test('interactionMode survives agent→tools cycles so auto-approval works after plan approval', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          // Step 1: shell_execute tool call (triggered after plan approval)
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-exec1',
                name: 'shell_execute',
                args: { command: 'mkdir -p /tmp/test-auto-mode' },
              },
            ],
          }),
          // Step 2: auto-review response — consumed by reviewToolApproval.
          // Must be valid JSON parseable by parseAutoReviewSuggestion.
          new AIMessage({
            content: '{"approved":true,"grant":"approve_once","reason":"safe directory creation"}',
          }),
          // Step 3: agent final response after successful tool execution
          new AIMessage({ content: 'Command executed successfully.' }),
          // Spare responses
          new AIMessage({ content: 'auto spare 1' }),
          new AIMessage({ content: 'auto spare 2' }),
        ]),
      });

      // Start in the state AFTER plan approval: interactionMode='auto', planReviewed=true
      const stream = await graph.stream(
        {
          messages: [new HumanMessage('Execute echo hello')],
          workspaceAccess: 'write',
          phase: 'building',
          plan: {
            name: 'Test Plan',
            description: 'A test plan.',
            status: 'in_progress',
            steps: [{ step: 'Echo hello', status: 'in_progress' }],
          },
          planReviewed: true,
          interactionMode: 'auto' as const,
          authorization: { mode: 'default', commandGrants: {} },
          userId: 'test',
          threadId: 'auto-mode-1',
          workspace,
        },
        {
          configurable: { thread_id: 'auto-mode-1' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const chunks = await collectChunks(stream);
      checkpointer.close();

      // Should complete without any interrupt (auto-review approved the tool)
      const interrupt = findInterrupt(chunks);
      expect(interrupt).toBeNull();

      // Final response should be present
      const final = findFinal(chunks);
      expect(final).toBe('Command executed successfully.');
    } finally {
      tearDown();
    }
  });

  // ── auto-review failure: model returns non-JSON → auto-approve + warning ──

  test('auto-review failure (non-JSON) auto-approves tool and records warning', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          // Step 1: shell_execute tool call
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-exec-fail1',
                name: 'shell_execute',
                args: { command: 'mkdir -p /tmp/test-fail' },
              },
            ],
          }),
          // Step 2: auto-review response — plain text, not JSON → parse fails
          new AIMessage({
            content: 'I think this command looks fine, go ahead.',
          }),
          // Step 3: agent final response (tool was auto-approved despite review failure)
          new AIMessage({ content: 'Directory created with auto-approval.' }),
          new AIMessage({ content: 'spare 1' }),
          new AIMessage({ content: 'spare 2' }),
        ]),
      });

      const stream = await graph.stream(
        {
          messages: [new HumanMessage('Create test directory')],
          workspaceAccess: 'write',
          phase: 'building',
          plan: {
            name: 'Test Plan',
            description: 'A test plan.',
            status: 'in_progress',
            steps: [{ step: 'Create dir', status: 'in_progress' }],
          },
          planReviewed: true,
          interactionMode: 'auto' as const,
          authorization: { mode: 'default', commandGrants: {} },
          userId: 'test',
          threadId: 'auto-fail-1',
          workspace,
        },
        {
          configurable: { thread_id: 'auto-fail-1' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const chunks = await collectChunks(stream);
      checkpointer.close();

      // No interrupt — tool was auto-approved
      expect(findInterrupt(chunks)).toBeNull();

      // autoReviewWarnings recorded in approval node's return
      const approvalChunk = chunks.find(
        (c) => (c as Record<string, unknown>).approval !== undefined,
      );
      expect(approvalChunk).toBeDefined();
      const approvalState = (approvalChunk as Record<string, unknown>).approval as Record<
        string,
        unknown
      >;
      const warnings = approvalState.autoReviewWarnings as Record<string, string> | undefined;
      expect(warnings).toBeDefined();
      expect(warnings!['call-exec-fail1']).toContain('auto review did not return JSON');

      // Tool executed, agent continued
      expect(findFinal(chunks)).toBe('Directory created with auto-approval.');
    } finally {
      tearDown();
    }
  });

  // ── auto-review rejection: model says approved=false → tool NOT executed, agent sees reason ──

  test('auto-review rejection (approved=false) does not execute tool and sends reason to agent', async () => {
    setUp();
    try {
      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        model: new FakeChatModel([
          // Step 1: write_file tool call
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'call-write-reject2',
                name: 'write_file',
                args: { path: 'test.txt', content: 'hello' },
              },
            ],
          }),
          // Step 2: auto-review response — model says not approved
          new AIMessage({
            content:
              '{"approved":false,"grant":"approve_once","reason":"unexpected file modification"}',
          }),
          // Step 3: agent sees rejection and responds to user
          new AIMessage({
            content:
              'The auto-review rejected the file write. The modification was unexpected. Let me try a different approach.',
          }),
          new AIMessage({ content: 'spare 1' }),
          new AIMessage({ content: 'spare 2' }),
        ]),
      });

      const stream = await graph.stream(
        {
          messages: [new HumanMessage('Write test file')],
          workspaceAccess: 'write',
          phase: 'building',
          plan: {
            name: 'Test Plan',
            description: 'A test plan.',
            status: 'in_progress',
            steps: [{ step: 'Write file', status: 'in_progress' }],
          },
          planReviewed: true,
          interactionMode: 'auto' as const,
          authorization: { mode: 'default', commandGrants: {} },
          userId: 'test',
          threadId: 'auto-reject-1',
          workspace,
        },
        {
          configurable: { thread_id: 'auto-reject-1' },
          streamMode: 'updates',
          recursionLimit: 60,
        },
      );

      const chunks = await collectChunks(stream);
      checkpointer.close();

      // No interrupt — rejection was handled programmatically
      expect(findInterrupt(chunks)).toBeNull();

      // Agent saw the rejection and explained it to the user
      const final = findFinal(chunks);
      expect(final).toContain('auto-review rejected');

      // Verify the rejection ToolMessage was injected into messages
      const toolMsgs = chunks
        .flatMap((c) => {
          const toolsChunk = (c as Record<string, unknown>).tools as
            | Record<string, unknown>
            | undefined;
          const approvalChunk = (c as Record<string, unknown>).approval as
            | Record<string, unknown>
            | undefined;
          const msgs = (toolsChunk?.messages ?? approvalChunk?.messages ?? []) as Array<{
            content: string;
          }>;
          return msgs;
        })
        .filter(Boolean);
      const rejectionMsg = toolMsgs.find((m) => {
        try {
          const p = JSON.parse(m.content);
          return p.ok === false && p.reason === 'unexpected file modification';
        } catch {
          return false;
        }
      });
      expect(rejectionMsg).toBeDefined();
    } finally {
      tearDown();
    }
  });
});
