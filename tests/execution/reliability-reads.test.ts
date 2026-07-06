import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import type { AgentConfig } from '../../src/core/config/index';
import { buildCodeAgentGraph } from '../../src/core/harness/graph';

// ── Fake model ──
class FakeChatModel extends ChatOpenAI {
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
  bind(_kwargs: unknown): this {
    return this;
  }
  override bindTools(_tools: unknown[], _kwargs?: unknown): this {
    return this;
  }
}

const fakeConfig: AgentConfig = {
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
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('read-path exhaustion detection (10 concurrent reads)', () => {
  test('detects exhaustion on 5th concurrent read and fires toolResultSink with status:exhausted', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-reliability-reads-'));
    const checkpointPath = join(workspace, 'checkpoint.db');
    try {
      const catStderr = 'cat: /nonexistent_file_12345: No such file or directory';
      const toolResultSinkCalls: Array<{
        callId: string;
        toolName: string;
        ok: boolean;
        status?: string;
      }> = [];

      const shell = async (_input: { command: string; workspace: string }) => ({
        ok: false as const,
        command: _input.command,
        exitCode: 1,
        stdout: '',
        stderr: catStderr,
      });

      // Generate 10 cat tool calls in a single AIMessage
      const toolCalls = Array.from({ length: 10 }, (_, i) => ({
        id: `call-cat-${i}`,
        name: 'shell_execute',
        args: { intent: 'inspect', command: `cat /nonexistent_file_${i}` },
      }));

      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        shellExecutor: shell,
        toolResultSink: (
          callId,
          toolName,
          ok,
          _summary,
          _totalLines,
          _toolTokenCount,
          _exitCode,
          status,
        ) => {
          toolResultSinkCalls.push({ callId, toolName, ok, status });
        },
        model: new FakeChatModel([
          new AIMessage({ content: '', tool_calls: toolCalls }),
          new AIMessage({ content: '任务完成，所有猫检查完毕' }),
        ]) as any,
      });

      await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('cat 10 nonexistent files')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 'reads-exhaustion',
            workspace,
            authorization: { mode: 'full_access', commandGrants: {} },
          },
          {
            configurable: { thread_id: 'reads-exhaustion' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      // All 10 tools should have at least one toolResultSink call (Path A from executeOneTool)
      expect(toolResultSinkCalls.length).toBeGreaterThanOrEqual(10);

      // At least one call should have status: 'exhausted' (from for-loop override)
      const exhaustedCalls = toolResultSinkCalls.filter((c) => c.status === 'exhausted');
      expect(exhaustedCalls.length).toBeGreaterThanOrEqual(1);

      // Reads are now sequential and exhaustion blocks mid-batch.
      // With EXIT_NONZERO error code, maxFailures=5: the first 5 tools execute and
      // fail (Path A: ok=false, no status), then the 6th triggers exhaustion via
      // recordJournalForMessage, and reads 6-10 are blocked with status:'exhausted'.
      const pathACalls = toolResultSinkCalls.filter((c) => !c.ok && c.status === undefined);
      expect(pathACalls.length).toBe(5);
    } finally {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* EBUSY on win32 */
      }
    }
  });

  test('each exhausted tool gets overridden toolResultSink call', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-reliability-reads2-'));
    const checkpointPath = join(workspace, 'checkpoint.db');
    try {
      const catStderr = 'cat: /nonexistent_file_12345: No such file or directory';
      const toolResultSinkCalls: Array<{
        callId: string;
        toolName: string;
        ok: boolean;
        status?: string;
      }> = [];

      const shell = async (_input: { command: string; workspace: string }) => ({
        ok: false as const,
        command: _input.command,
        exitCode: 1,
        stdout: '',
        stderr: catStderr,
      });

      const toolCalls = Array.from({ length: 10 }, (_, i) => ({
        id: `call-cat-${i}`,
        name: 'shell_execute',
        args: { intent: 'inspect', command: `cat /nonexistent_file_${i}` },
      }));

      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        shellExecutor: shell,
        toolResultSink: (
          callId,
          toolName,
          ok,
          _summary,
          _totalLines,
          _toolTokenCount,
          _exitCode,
          status,
        ) => {
          toolResultSinkCalls.push({ callId, toolName, ok, status });
        },
        model: new FakeChatModel([
          new AIMessage({ content: '', tool_calls: toolCalls }),
          new AIMessage({ content: 'done' }),
        ]) as any,
      });

      await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('cat 10 nonexistent files')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 'reads-exhaustion2',
            workspace,
            authorization: { mode: 'full_access', commandGrants: {} },
          },
          {
            configurable: { thread_id: 'reads-exhaustion2' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      // Reads are sequential now; exhaustion blocks mid-batch after maxFailures (5 for EXIT_NONZERO).
      // First 5 tools execute and fail (Path A: ok=false, no status), then reads 6-10 are blocked.
      const pathACalls = toolResultSinkCalls.filter(
        (c) => c.status === undefined && c.ok === false,
      );
      expect(pathACalls.length).toBe(5);

      // The override calls have status: 'exhausted'
      const exhaustedCalls = toolResultSinkCalls.filter((c) => c.status === 'exhausted');
      // At least the 5th tool in for-loop order gets the override
      expect(exhaustedCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* EBUSY on win32 */
      }
    }
  });

  test('exhausted fingerprint persists across agent→tools cycles and blocks second batch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-reliability-cross-'));
    const checkpointPath = join(workspace, 'checkpoint.db');
    try {
      const catStderr = 'cat: /nonexistent_file_12345: No such file or directory';
      const toolResultSinkCalls: Array<{
        callId: string;
        status?: string;
        stage: string;
      }> = [];

      const shell = async (_input: { command: string; workspace: string }) => ({
        ok: false as const,
        command: _input.command,
        exitCode: 1,
        stdout: '',
        stderr: catStderr,
      });

      // Batch 1: 10 cats (enough to trigger exhaustion on the 5th)
      const batch1 = Array.from({ length: 10 }, (_, i) => ({
        id: `b1-cat-${i}`,
        name: 'shell_execute',
        args: { intent: 'inspect' as const, command: `cat /nonexistent_file_${i}` },
      }));

      // Batch 2: 5 more cats (should be preflight-blocked for the same fingerprint)
      const batch2 = Array.from({ length: 5 }, (_, i) => ({
        id: `b2-cat-${i}`,
        name: 'shell_execute',
        args: { intent: 'inspect' as const, command: `cat /nonexistent_file_${i}` },
      }));

      const { graph, checkpointer } = buildCodeAgentGraph({
        config: fakeConfig,
        checkpointPath,
        shellExecutor: shell,
        toolResultSink: (
          callId,
          _toolName,
          _ok,
          _summary,
          _totalLines,
          _toolTokenCount,
          _exitCode,
          status,
        ) => {
          const stage = callId.startsWith('b2-') ? 'batch2' : 'batch1';
          toolResultSinkCalls.push({ callId, status, stage });
        },
        model: new FakeChatModel([
          // First response: 10 cats
          new AIMessage({ content: '', tool_calls: batch1 }),
          // Second response: 5 more cats (should hit preflight)
          new AIMessage({ content: '', tool_calls: batch2 }),
          // Third response: done
          new AIMessage({ content: '任务完成' }),
        ]) as any,
      });

      await collectChunks(
        await graph.stream(
          {
            messages: [new HumanMessage('cat many nonexistent files')],
            workspaceAccess: 'write',
            phase: 'building',
            plan: null,
            userId: 'test',
            threadId: 'reads-cross-cycle',
            workspace,
            authorization: { mode: 'full_access', commandGrants: {} },
          },
          {
            configurable: { thread_id: 'reads-cross-cycle' },
            streamMode: 'updates',
            recursionLimit: 60,
          },
        ),
      );

      checkpointer.close();

      // Batch 1 should have 10 Path A error calls + 1 exhausted override
      const batch1Exhausted = toolResultSinkCalls.filter(
        (c) => c.stage === 'batch1' && c.status === 'exhausted',
      );
      expect(batch1Exhausted.length).toBeGreaterThanOrEqual(1);

      // Batch 2 should have SOME preflight-blocked calls (status: 'exhausted' without execution)
      const batch2Exhausted = toolResultSinkCalls.filter(
        (c) => c.stage === 'batch2' && c.status === 'exhausted',
      );
      // All 5 in batch 2 should be preflight-blocked (fingerprint already exhausted)
      expect(batch2Exhausted.length).toBe(5);
    } finally {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* EBUSY on win32 */
      }
    }
  });
});
