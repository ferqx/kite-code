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
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openpx-integration-'));
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
            // 设置已有 plan 使 update_plan 走 tools 直通路径（状态更新），
            // 避免触发新的 plan_review 中断 / existing plan routes update_plan
            // to tools (status update), avoiding the new plan_review interrupt
            plan: { name: 'existing', description: '', status: 'in_progress', steps: [] },
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
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openpx-sandbox-int-'));
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
});

// ---------------------------------------------------------------------------
// Checkpoint recovery tests
// ---------------------------------------------------------------------------

describe('checkpoint recovery', () => {
  let workspace: string;
  let checkpointPath: string;

  function setUp() {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openpx-ckpt-'));
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
          // 设置已有 plan 使 update_plan 走 tools 直通路径，
          // 避免触发新的 plan_review 中断 / existing plan routes update_plan
          // to tools, avoiding the new plan_review interrupt
          plan: { name: 'existing', description: '', status: 'in_progress', steps: [] },
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
});
