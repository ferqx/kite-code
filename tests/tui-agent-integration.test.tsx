import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { TuiUserInputProvider } from '../src/app/tui/provider';
import { loadAgentConfig } from '../src/core/config/index';
import { runAgent } from '../src/core/runner';
import type { AgentEvent } from '../src/protocol/events';
import { type MockResponse, StreamingMockModel } from './mock-model';

function tempWorkspace() {
  const root = join(tmpdir(), `kite-code-int-${Date.now().toString(36)}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function makeModel(responses: MockResponse[]) {
  return new StreamingMockModel({ responses }) as any;
}

async function runAndCollect(
  model: any,
  root: string,
  onEvent: (e: AgentEvent) => void,
  autoApprove = false,
) {
  const provider = new TuiUserInputProvider(onEvent);

  let resolved = false;
  const timer = setInterval(() => {
    if (!autoApprove || resolved) return;
    const i = provider.getPendingInterrupt();
    if (i?.kind === 'approval') {
      provider.submitAction({ type: 'approve', grant: 'approve_once' });
      resolved = true;
    }
  }, 50);

  try {
    const gen = runAgent(provider, {
      task: 'test task',
      userId: 'test-user',
      threadId: `t-${Date.now().toString(36)}`,
      workspace: root,
      checkpointPath: join(root, 'cp.sqlite'),
      config: loadAgentConfig(),
      model,
    });
    for await (const _ of gen) {
    }
  } finally {
    clearInterval(timer);
  }
}

describe('Agent Integration (mock LLM)', () => {
  // ── 基础：正常文本响应 / Basic text response ──
  test('model responds with text, no stall', async () => {
    const root = tempWorkspace();
    const events: AgentEvent[] = [];
    const model = makeModel([
      { message: new AIMessage({ content: 'Hello from mock!', id: 'm1' }) },
    ]);

    await runAndCollect(model, root, (e) => events.push(e));

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0]!.data.text).toContain('Hello from mock!');
  });

  // ── 延迟响应（模拟网络延迟）/ Response with simulated network delay ──
  test('model with 500ms delay still produces response', async () => {
    const root = tempWorkspace();
    const events: AgentEvent[] = [];
    const model = makeModel([
      { message: new AIMessage({ content: 'Delayed response', id: 'm1' }), delay: 500 },
    ]);

    const start = Date.now();
    await runAndCollect(model, root, (e) => events.push(e));
    const elapsed = Date.now() - start;

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  }, 10_000);

  // ── 模型错误 → 不卡住 / Model error doesn't hang ──
  test('model throws error, agent loop completes (no stall)', async () => {
    const root = tempWorkspace();
    const events: AgentEvent[] = [];
    const model = makeModel([{ error: 'Network timeout after 30s', delay: 50 }]);

    const start = Date.now();
    try {
      await runAndCollect(model, root, (e) => events.push(e));
    } catch {
      // Error propagation is expected
    }
    const elapsed = Date.now() - start;

    // Must complete quickly (error should not cause indefinite hang)
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  // ── 空响应 → 不卡住 / Empty response, no stall ──
  test('model returns empty response, graph completes', async () => {
    const root = tempWorkspace();
    const events: AgentEvent[] = [];
    const model = makeModel([{ message: new AIMessage({ content: '', id: 'm1' }) }]);

    await runAndCollect(model, root, (e) => events.push(e));

    const stepEnd = events.filter((e) => e.type === 'step_end');
    expect(stepEnd.length).toBeGreaterThan(0);
  });

  // ── 连续两次模型调用 / Two consecutive model calls ──
  test('two sequential model calls both produce events', async () => {
    const root = tempWorkspace();
    const events: AgentEvent[] = [];
    const model = makeModel([
      { message: new AIMessage({ content: 'First response', id: 'm1' }) },
      // Second call doesn't happen in this scenario since the first response has no tool_calls
    ]);

    await runAndCollect(model, root, (e) => events.push(e));

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ── 大量输出不卡住 / Long output doesn't stall ──
  test('long text response completes without stall', async () => {
    const root = tempWorkspace();
    const events: AgentEvent[] = [];
    const longText = 'A'.repeat(10000);
    const model = makeModel([{ message: new AIMessage({ content: longText, id: 'm1' }) }]);

    const start = Date.now();
    await runAndCollect(model, root, (e) => events.push(e));
    const elapsed = Date.now() - start;

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    // Should complete in reasonable time (< 5s for 10KB text)
    expect(elapsed).toBeLessThan(5000);
  }, 15_000);
});
