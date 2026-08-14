import { describe, expect, test } from 'bun:test';
import type { Action } from '../src/app/tui/App';
import { eventReducer as canonicalEventReducer, createInitialState } from '../src/app/tui/App';
import {
  projectToolCancelled,
  projectUserCancelledTurn,
} from '../src/app/tui/reducers/cancellation-projection';
import { buildToolSummaryLine } from '../src/app/tui/reducers/consolidateTools';
import {
  handleRuntimeEventAction as handleCanonicalRuntimeEventAction,
  handleEventAction,
  type RenderEvent,
} from '../src/app/tui/reducers/handleEvent';
import type { InterruptState, OutputBlock, SessionSnapshot, TuiState } from '../src/app/tui/types';
import type { RuntimeEvent } from '../src/core/runtime/events';
import { decodeHistoricalToolOutcomeEventV1 } from '../src/core/runtime/tool-outcome-events';
import type { ToolApprovalPayload, UserInputPayload } from '../src/protocol/events';

function fresh(): TuiState {
  return createInitialState();
}

function handleRuntimeEventAction(state: TuiState, event: RuntimeEvent): TuiState {
  return handleCanonicalRuntimeEventAction(state, decodeHistoricalToolOutcomeEventV1(event));
}

function eventReducer(state: TuiState, action: Action): TuiState {
  return canonicalEventReducer(
    state,
    action.type === 'RUNTIME_EVENT'
      ? { ...action, event: decodeHistoricalToolOutcomeEventV1(action.event) }
      : action,
  );
}
type LegacyRenderAction = { type: 'EVENT'; event: RenderEvent };
type TestAction = Action | LegacyRenderAction;

function dispatch(s: TuiState, a: TestAction): TuiState {
  if (a.type === 'EVENT') return handleEventAction(s, a.event);
  return eventReducer(s, a);
}
function flatBlocks(s: TuiState) {
  return s.turns.flatMap((t) => t.blocks);
}

function textEvt(text: string): LegacyRenderAction {
  return { type: 'EVENT', event: { type: 'text', data: { text } } };
}
function reasonEvt(text: string): LegacyRenderAction {
  return { type: 'EVENT', event: { type: 'reason', data: { text } } };
}
function tcEvt(
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
  status?: 'queued' | 'running',
): LegacyRenderAction {
  return {
    type: 'EVENT',
    event: { type: 'tool_call', data: { call_id: callId, name, args, status } },
  };
}
function tsEvt(callId: string): LegacyRenderAction {
  return {
    type: 'EVENT',
    event: { type: 'tool_started', data: { call_id: callId } },
  };
}
function tdEvt(callId: string, name: string, ok: boolean, summary: string): LegacyRenderAction {
  return {
    type: 'EVENT',
    event: { type: 'tool_done', data: { call_id: callId, name, ok, summary } },
  };
}
function tdExhausted(callId: string, name: string, summary: string): LegacyRenderAction {
  return {
    type: 'EVENT',
    event: {
      type: 'tool_done',
      data: { call_id: callId, name, ok: false, summary, status: 'exhausted' as const },
    },
  };
}
function approval(data: Partial<ToolApprovalPayload> = {}): ToolApprovalPayload {
  return {
    scope: 'once',
    cwd: '/tmp',
    threadId: 't1',
    tool: 'shell_execute',
    command: 'echo hi',
    risk: 'execute_code',
    approvalHash: 'abc',
    summary: 'run',
    reason: 'test',
    expectedEffects: [],
    grantOptions: ['approve_once'],
    recommendedGrant: 'approve_once',
    ...data,
  };
}
function question(data: Partial<UserInputPayload> = {}): UserInputPayload {
  return { question: 'What?', options: [], allow_free_text: true, ...data };
}

describe('eventReducer (blocks model)', () => {
  describe('tool summary text', () => {
    test('preserves the complete bounded capability search result for tree rendering', () => {
      const candidates = Array.from({ length: 4 }, (_, index) => ({
        kind: 'mcp_tool',
        name: `search_tool_${index}`,
        provider: `provider_${index}`,
      }));
      const stdout = JSON.stringify({ ok: true, candidate_count: candidates.length, candidates });
      let s = fresh();
      s = dispatch(s, tcEvt('search-1', 'tool_search', { query: 'search docs' }));
      s = eventReducer(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.finished',
          toolCallId: 'search-1',
          name: 'tool_search',
          result: {
            ok: true,
            command: 'tool_search',
            exitCode: 0,
            stdout,
            stderr: '',
          },
        },
      });

      const card = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(card.summary).toBe(stdout);
      expect(card.summary.length).toBeGreaterThan(200);
    });

    test('describes search_files as file pattern searches, not found results', () => {
      const line = buildToolSummaryLine([
        {
          callId: 'c1',
          name: 'search_files',
          args: { pattern: 'package.json' },
          ok: false,
          summary: 'no matches',
          status: 'error',
        },
        {
          callId: 'c2',
          name: 'search_files',
          args: { pattern: '*.md' },
          ok: false,
          summary: 'no matches',
          status: 'error',
        },
      ]);

      expect(line).toBe('searched 2 file patterns');
    });
  });

  describe('EVENT.text', () => {
    test('LOCAL_TEXT appends a local UI notification without an AgentEvent', () => {
      const s = dispatch(fresh(), { type: 'LOCAL_TEXT', text: 'Theme set to teal' });
      expect(flatBlocks(s)[0]).toMatchObject({ kind: 'text', content: 'Theme set to teal' });
    });

    test('appends text block', () => {
      const s = dispatch(fresh(), textEvt('hello'));
      expect(flatBlocks(s)).toHaveLength(1);
      expect(flatBlocks(s)[0]!.kind).toBe('text');
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe('hello');
    });
    test('assigns unique incrementing ids to blocks', () => {
      let s = fresh();
      s = dispatch(s, textEvt('a'));
      s = dispatch(s, textEvt('b'));
      s = dispatch(s, textEvt('c'));
      const ids = flatBlocks(s).map((b) => b.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids[0]!).toBeLessThan(ids[1]!);
      expect(ids[1]!).toBeLessThan(ids[2]!);
    });
  });

  describe('EVENT.reason', () => {
    test('appends reason block with folded=true', () => {
      const s = dispatch(fresh(), reasonEvt('thinking...'));
      expect(flatBlocks(s)[0]!.kind).toBe('reason');
      const r = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'reason' }>;
      expect(r.folded).toBe(true);
    });

    test('switches the active Thought window between reasoning and tool activity', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('first thought'));
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'a'));
      s = dispatch(s, reasonEvt('second thought'));
      s = dispatch(s, tcEvt('c2', 'search_files', { pattern: '*.ts' }));

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tools.map((t) => t.callId)).toEqual(['c1', 'c2']);
      expect(summaries[0]!.active).toBe(true);
      expect(summaries[0]!.latestActivity).toEqual({
        kind: 'tool',
        callId: 'c2',
      });
    });

    test('creates a running Thought preview for thinking before any tool call', () => {
      const s = dispatch(fresh(), reasonEvt('checking the repo shape'));

      const summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary).toBeDefined();
      expect(summary!.active).toBe(true);
      expect(summary!.latestActivity).toEqual({
        kind: 'thinking',
        text: 'checking the repo shape',
      });
    });

    test('pure-thinking phase merges into the answer header when the final closes it (ADR-0026 via ADR-0030)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'thinking before answering', durationMs: 2093 } },
      });
      // 非流式模型：文本先吸收为 pendingCaption（阶段块保持活跃）
      // Non-streaming: text is absorbed pending confirmation; the block stays active
      s = dispatch(s, textEvt('Here is the answer.'));
      let summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.active).toBe(true);
      expect(summaries[0]!.pendingCaption).toBe('Here is the answer.');

      // final 关闭阶段：纯思考块的 pendingCaption 即最终回答 → 并入题头
      // final closes the phase: the pure block's caption IS the answer → header merge
      s = dispatch(s, { type: 'EVENT', event: { type: 'final', data: 'Here is the answer.' } });

      summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(0);
      const text = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'text' }> => b.kind === 'text',
      );
      expect(text).toBeDefined();
      expect(text!.content).toBe('Here is the answer.');
      expect(text!.thoughtElapsedMs).toBe(2093);
      expect(s.currentThoughtSummaryId).toBeUndefined();
    });

    test('reason → text → exploration tools: text becomes a confirmed caption inside one phase block (ADR-0030)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'let me look', durationMs: 2000 } },
      });
      s = dispatch(s, textEvt('Let me read the core files.'));
      // 文本吸收进同一个阶段块，不创建独立文本块
      expect(flatBlocks(s).some((b) => b.kind === 'text')).toBe(false);
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.ts' }));
      s = dispatch(s, tcEvt('c2', 'read_file', { path: 'b.ts' }));

      const blocks = flatBlocks(s);
      // 只有一个阶段块：思考 + 旁白 + 工具同块，无独立文本块
      expect(blocks.some((b) => b.kind === 'text')).toBe(false);
      const summaries = blocks.filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(1);
      const summary = summaries[0]!;
      expect(summary.tools.map((t) => t.callId)).toEqual(['c1', 'c2']);
      expect(summary.hasThinking).toBe(true);
      expect(summary.modelMs).toBe(2000);
      expect(summary.summaryLine).toBe('read 2 files');
      // 只读工具确认旁白为正式块顶字幕
      expect(summary.captions).toEqual(['Let me read the core files.']);
      expect(summary.pendingCaption).toBeUndefined();
      expect(summary.active).toBe(true);
    });

    test('pure thought closed by non-exploration tool keeps bare line even when text follows (ADR-0026 boundary)', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('thinking before writing'));
      s = dispatch(s, tcEvt('c1', 'write_file', { path: 'a.txt' }));
      s = dispatch(s, textEvt('Done writing.'));

      const blocks = flatBlocks(s);
      const summaries = blocks.filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      // 被非探索工具关闭的纯思考块与后续文本隔着 tool_card，永不并入
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tools).toHaveLength(0);
      expect(summaries[0]!.active).toBe(false);
      const text = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'text' }> => b.kind === 'text',
      );
      expect(text?.thoughtElapsedMs).toBeUndefined();
    });

    test('whitespace text is ignored entirely — the phase block keeps accumulating (ADR-0030)', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('thinking'));
      s = dispatch(s, textEvt('   \n  '));
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.ts' }));

      const blocks = flatBlocks(s);
      expect(blocks.some((b) => b.kind === 'text')).toBe(false);
      const summaries = blocks.filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      // 空白文本不关闭 Thought：思考与工具仍是同一个活跃阶段块
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tools).toHaveLength(1);
      expect(summaries[0]!.active).toBe(true);
      expect(summaries[0]!.hasThinking).toBe(true);
    });

    test('multi-round pure-thinking chain accumulates modelMs into the merged header (rules 19/24)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'round one', durationMs: 1000 } },
      });
      // model.requested 不关闭 Thought（ADR-0030），思考链跨调用延续
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.requested', requestId: 'r1' },
      });
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'round two', durationMs: 1500 } },
      });
      s = dispatch(s, textEvt('The answer.'));
      s = dispatch(s, { type: 'EVENT', event: { type: 'final', data: 'The answer.' } });

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(0);
      const text = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'text' }> => b.kind === 'text',
      );
      // 1000 + 1500 = 2500ms 累加后并入题头
      expect(text?.thoughtElapsedMs).toBe(2500);
    });

    test('thinking is not repeated after a task boundary within the same batch (ADR-0047)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'exploring the module', durationMs: 3000 } },
      });
      s = dispatch(s, tcEvt('c1', 'search_files', { pattern: 'reducer*' }));
      s = dispatch(s, tcEvt('c2', 'task', { description: 'deep exploration' }));
      s = dispatch(s, tcEvt('c3', 'read_file', { path: 'a.ts' }));
      s = dispatch(s, tcEvt('c4', 'read_file', { path: 'b.ts' }));

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(2);
      // 边界前：search 块带思考标记
      expect(summaries[0]!.tools.map((t) => t.callId)).toEqual(['c1']);
      expect(summaries[0]!.hasThinking).toBe(true);
      expect(summaries[0]!.modelMs).toBe(3000);
      // 边界后：read 聚合保留工具过程，但不重复已经展示过的 Thought 标签
      expect(summaries[1]!.tools.map((t) => t.callId)).toEqual(['c3', 'c4']);
      expect(summaries[1]!.hasThinking).toBeUndefined();
      expect(summaries[1]!.hasThought).toBe(false);
      expect(summaries[1]!.modelMs).toBeUndefined();
      expect(summaries[1]!.summaryLine).toBe('read 2 files');
    });

    test('thinking is not repeated after a write-tool boundary (ADR-0047)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'read, note, keep reading', durationMs: 2000 } },
      });
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.ts' }));
      s = dispatch(s, tcEvt('w1', 'write_file', { path: 'notes.md' }));
      s = dispatch(s, tcEvt('c2', 'read_file', { path: 'b.ts' }));

      const blocks = flatBlocks(s);
      const summaries = blocks.filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(2);
      expect(summaries[0]!.summaryLine).toBe('read 1 file');
      expect(summaries[1]!.hasThinking).toBeUndefined();
      expect(summaries[1]!.hasThought).toBe(false);
      expect(summaries[1]!.modelMs).toBeUndefined();
      expect(summaries[1]!.summaryLine).toBe('read 1 file');
      // 写入卡片位于两个聚合块之间
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'w1')).toBe(true);
    });

    test('new reasoning joins the active exploration aggregate after a Bash boundary (ADR-0047)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'run tests first', durationMs: 2840 } },
      });
      s = dispatch(s, tcEvt('bash-1', 'shell_execute', { command: 'bun test' }));
      s = dispatch(s, tcEvt('read-1', 'read_file', { path: 'README.md' }));
      s = dispatch(s, tcEvt('search-1', 'search_files', { pattern: '*.ts' }));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.requested', requestId: 'next-model-call' },
      });
      s = dispatch(s, {
        type: 'EVENT',
        event: {
          type: 'reason',
          data: { text: 'the exploration results need follow-up', durationMs: 2891 },
        },
      });

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(2);
      expect(summaries[0]!.tools).toHaveLength(0);
      expect(summaries[0]!.modelMs).toBe(2840);

      const exploration = summaries[1]!;
      expect(exploration.tools.map((tool) => tool.callId)).toEqual(['read-1', 'search-1']);
      expect(exploration.hasThought).toBe(true);
      expect(exploration.hasThinking).toBe(true);
      expect(exploration.modelMs).toBe(2891);
      expect(exploration.latestActivity).toEqual({
        kind: 'thinking',
        text: 'the exploration results need follow-up',
      });
    });

    test('a new call without reasoning remains non-thinking after a task boundary (ADR-0047)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'thinking', durationMs: 1000 } },
      });
      s = dispatch(s, tcEvt('c1', 'task', {}));
      // 新一轮模型调用 = 新决策，延续清除
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.requested', requestId: 'r1' },
      });
      s = dispatch(s, tcEvt('c2', 'read_file', { path: 'a.ts' }));

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(2);
      expect(summaries[0]!.hasThinking).toBe(true);
      // 新调用无 reasoning → 非思考聚合，不继承
      expect(summaries[1]!.hasThinking).toBeUndefined();
      expect(summaries[1]!.hasThought).toBe(false);
      expect(summaries[1]!.modelMs).toBeUndefined();
    });

    test('pure-thinking Thought persists when a non-exploration tool follows', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('thinking before writing'));
      s = dispatch(s, tcEvt('c1', 'write_file', { path: 'a.txt' }));

      const blocks = flatBlocks(s);
      const summaries = blocks.filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tools).toHaveLength(0);
      expect(summaries[0]!.active).toBe(false);
      expect(summaries[0]!.result).toBe('done');
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c1')).toBe(true);
      expect(s.currentThoughtSummaryId).toBeUndefined();
    });

    test('SET_IDLE settles and keeps a pure-thinking Thought', () => {
      let s = fresh();
      s = dispatch(s, { type: 'SET_RUNNING' });
      s = dispatch(s, reasonEvt('thinking at interruption'));
      s = dispatch(s, { type: 'SET_IDLE' });

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(s.running).toBe(false);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tools).toHaveLength(0);
      expect(summaries[0]!.active).toBe(false);
    });

    test('model.requested keeps an active tool-backed Thought alive across calls (ADR-0030 phase block)', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('thinking'));
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'ok'));
      // 新一轮模型调用 = kernel 分批实现细节，不是阶段边界：块保持活跃
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.requested', requestId: 'req-1' },
      });

      const summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary).toBeDefined();
      expect(summary!.tools.map((t) => t.callId)).toEqual(['c1']);
      // 阶段块跨调用存活：圆点持续闪烁，等待后续思考/工具继续流入
      // （result 由工具状态推导，工具全完成即为 done，不影响活跃态渲染）
      expect(summary!.active).toBe(true);
      expect(s.currentThoughtSummaryId).toBe(summary!.id);
    });

    test('model.requested keeps a pure-thinking Thought active (chain continues until text)', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('still thinking'));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.requested', requestId: 'req-2' },
      });

      const summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary).toBeDefined();
      expect(summary!.tools).toHaveLength(0);
      // 规则 1/19：思考链只被 text 等边界打断，不被新一轮模型调用打断
      expect(summary!.active).toBe(true);
      expect(s.currentThoughtSummaryId).toBe(summary!.id);
    });

    test('model.responded durationMs freezes Thought elapsed to model-call duration (CC parity)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'model.responded',
          messageId: 'm1',
          reasoningText: 'thinking hard',
          durationMs: 3210,
        },
      });
      // 工具执行期间 elapsed 不增长（对齐 Claude Code：Thought 计时不含工具执行）
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'ok'));

      let summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary).toBeDefined();
      expect(summary!.totalElapsedMs).toBe(3210);

      // 阶段边界关闭后仍以模型调用时长冻结
      s = dispatch(s, { type: 'EVENT', event: { type: 'final', data: 'done' } });
      summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary!.active).toBe(false);
      expect(summary!.result).toBe('done');
      expect(summary!.totalElapsedMs).toBe(3210);
    });

    test('multi-round exploration stays ONE phase block across model.requested (ADR-0030)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'round one', durationMs: 3000 } },
      });
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'ok'));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.requested', requestId: 'req-3' },
      });
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'round two', durationMs: 3000 } },
      });
      s = dispatch(s, tcEvt('c2', 'read_file', { path: 'b.txt' }));

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      // 不切分：两轮工具同块，时长跨调用累加（3000 + 3000）
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.active).toBe(true);
      expect(summaries[0]!.tools.map((t) => t.callId)).toEqual(['c1', 'c2']);
      expect(summaries[0]!.modelMs).toBe(6000);
      expect(summaries[0]!.totalElapsedMs).toBe(6000);
      expect(summaries[0]!.summaryLine).toBe('read 2 files');
    });

    test('a model call without reasoning still adds its duration to the phase (ADR-0030 rule 24)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'model.responded',
          messageId: 'm1',
          reasoningText: 'think',
          durationMs: 1000,
        },
      });
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.requested', requestId: 'req-x' },
      });
      // 第二次调用无 reasoning：时长仍计入阶段 Σ
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.responded', messageId: 'm2', durationMs: 800 },
      });

      const summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary!.modelMs).toBe(1800);
      expect(summary!.totalElapsedMs).toBe(1800);
      expect(summary!.hasThinking).toBe(true);
    });
  });

  describe('EVENT.tool_call / tool_done', () => {
    test('queued tool_call creates a queued tool_card then tool_started marks it running', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute', { command: 'bun test' }, 'queued'));

      let t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.kind).toBe('tool_card');
      expect(t.status).toBe('queued');

      s = dispatch(s, tsEvt('c1'));
      t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('running');
      expect(t.startedAt).toBeNumber();
    });

    test('queued exploration tool_call creates a queued summary entry then tool_started marks it running', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }, 'queued'));

      let summary = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_summary' }>;
      expect(summary.kind).toBe('tool_summary');
      expect(summary.tools[0]!.status).toBe('queued');

      s = dispatch(s, tsEvt('c1'));
      summary = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_summary' }>;
      expect(summary.tools[0]!.status).toBe('running');
    });

    test('escape cancels both queued and running tool blocks', () => {
      let s = dispatch(fresh(), { type: 'SET_RUNNING' });
      s = dispatch(s, tcEvt('queued-1', 'shell_execute', { command: 'npm i' }, 'queued'));
      s = dispatch(s, tcEvt('running-1', 'write_file', { path: 'a.txt' }));

      s = dispatch(s, { type: 'ESCAPE' });

      const blocks = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_card' }> => b.kind === 'tool_card',
      );
      expect(s.running).toBe(false);
      expect(blocks.map((b) => b.status)).toEqual(['cancelled', 'cancelled']);
    });

    test('escape preserves the cancelled Bash command and drops never-started read statistics', () => {
      let s = dispatch(fresh(), { type: 'SET_RUNNING' });
      s = dispatch(
        s,
        tcEvt('shell-1', 'shell_execute', {
          command: 'bun test --dry-run 2>&1 | tail -20',
        }),
      );
      s = dispatch(
        s,
        tcEvt('read-1', 'read_file', { path: 'src/core/runtime/runner.ts' }, 'queued'),
      );
      s = dispatch(
        s,
        tcEvt('read-2', 'read_file', { path: 'src/core/runtime/reducer.ts' }, 'queued'),
      );

      s = dispatch(s, { type: 'ESCAPE' });

      const blocks = flatBlocks(s);
      const shell = blocks.find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'shell-1',
      );
      expect(shell).toMatchObject({
        status: 'cancelled',
        detail: 'Ran: bun test --dry-run 2>&1 | tail -20',
      });
      expect(shell?.expanded).not.toBe(true);
      expect(blocks.some((block) => block.kind === 'tool_summary')).toBe(false);
    });

    test('live and durable cancellation share one visual projection', () => {
      const realNow = Date.now;
      Date.now = () => 10_000;
      try {
        let active = dispatch(fresh(), { type: 'SET_RUNNING' });
        active = dispatch(
          active,
          tcEvt('shell-1', 'shell_execute', { command: 'curl https://example.test' }),
        );
        active = dispatch(active, tcEvt('read-running', 'read_file', { path: 'src/runtime.ts' }));
        active = dispatch(
          active,
          tcEvt('read-queued', 'read_file', { path: 'src/queued.ts' }, 'queued'),
        );

        const live = dispatch(active, { type: 'ESCAPE' });
        let replay = dispatch(active, {
          type: 'RUNTIME_EVENT',
          event: {
            type: 'tool.cancelled',
            toolCallId: 'shell-1',
            reason: 'Cancelled by user.',
          },
        });
        replay = dispatch(replay, {
          type: 'RUNTIME_EVENT',
          event: {
            type: 'tool.cancelled',
            toolCallId: 'read-running',
            reason: 'Cancelled by user.',
          },
        });
        replay = dispatch(replay, {
          type: 'RUNTIME_EVENT',
          event: {
            type: 'tool.cancelled',
            toolCallId: 'read-queued',
            reason: 'Cancelled by user.',
          },
        });
        replay = dispatch(replay, {
          type: 'RUNTIME_EVENT',
          event: {
            type: 'turn.aborted',
            turnId: 'turn-1',
            reason: 'Cancelled by user.',
            cause: 'user',
          },
        });

        expect(flatBlocks(replay)).toEqual(flatBlocks(live));
        expect(replay.pendingToolCalls).toEqual(live.pendingToolCalls);
        expect(replay.currentThoughtSummaryId).toBe(live.currentThoughtSummaryId);
        expect(replay.thoughtPhaseStatus).toBe(live.thoughtPhaseStatus);
      } finally {
        Date.now = realNow;
      }
    });

    test('whole-turn cancellation projection is idempotent', () => {
      let active = dispatch(fresh(), { type: 'SET_RUNNING' });
      active = dispatch(active, tcEvt('shell-1', 'shell_execute', { command: 'bun test' }));

      const once = projectUserCancelledTurn(active, { now: 20_000 });
      const twice = projectUserCancelledTurn(once, { now: 30_000 });

      expect(twice).toBe(once);
    });

    test('durable tool cancellation marks a running exploration entry cancelled, not error', () => {
      let active = dispatch(fresh(), { type: 'SET_RUNNING' });
      active = dispatch(active, tcEvt('read-1', 'read_file', { path: 'src/runtime.ts' }));

      const cancelled = projectToolCancelled(active, 'read-1', { now: 20_000 });
      const summary = flatBlocks(cancelled).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
          block.kind === 'tool_summary',
      );

      expect(summary?.tools[0]).toMatchObject({
        callId: 'read-1',
        status: 'cancelled',
        summary: 'Cancelled',
      });
      expect(summary?.result).toBe('cancelled');
    });

    test('late cancellation never overwrites an existing terminal tool result', () => {
      let state = dispatch(fresh(), tcEvt('shell-1', 'shell_execute', { command: 'echo done' }));
      state = dispatch(state, tdEvt('shell-1', 'shell_execute', true, 'done'));

      const cancelled = projectToolCancelled(state, 'shell-1', { now: 20_000 });
      const card = flatBlocks(cancelled).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'shell-1',
      );

      expect(card).toMatchObject({ status: 'done', summary: 'done' });
    });
    test('replayed user cancellation matches live cleanup without a turn notice', () => {
      let s = dispatch(fresh(), { type: 'SET_RUNNING' });
      s = dispatch(
        s,
        tcEvt('shell-1', 'shell_execute', {
          command: 'bun test --dry-run 2>&1 | tail -20',
        }),
      );
      s = dispatch(
        s,
        tcEvt('read-1', 'read_file', { path: 'src/core/runtime/runner.ts' }, 'queued'),
      );
      s = dispatch(
        s,
        tcEvt('read-2', 'read_file', { path: 'src/core/runtime/reducer.ts' }, 'queued'),
      );

      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'turn.aborted',
          turnId: 'turn-1',
          reason: 'Cancelled by user.',
          cause: 'user',
        },
      });
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'turn.aborted',
          turnId: 'turn-1',
          reason: 'Cancelled by user.',
          cause: 'user',
        },
      });

      const blocks = flatBlocks(s);
      expect(blocks).toContainEqual(
        expect.objectContaining({
          kind: 'tool_card',
          callId: 'shell-1',
          status: 'cancelled',
          detail: 'Ran: bun test --dry-run 2>&1 | tail -20',
        }),
      );
      expect(blocks.some((block) => block.kind === 'tool_summary')).toBe(false);
      expect(
        blocks.some((block) => block.kind === 'text' && block.content.includes('Run cancelled')),
      ).toBe(false);
    });

    test('appends tool_card block with running status', () => {
      // read_file is an exploration tool → pre-consolidated to tool_summary
      const s = dispatch(fresh(), tcEvt('c1', 'read_file', { path: 'a.txt' }));
      const t = flatBlocks(s)[0]!;
      expect(t.kind).toBe('tool_summary');
      const ts = t as Extract<OutputBlock, { kind: 'tool_summary' }>;
      expect(ts.tools[0]!.callId).toBe('c1');
      expect(ts.tools[0]!.status).toBe('running');
    });
    test('tool_done updates to done and records elapsed', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file'));
      s = dispatch(s, tdEvt('c1', 'read_file', true, '150 lines'));
      // read_file is an exploration tool → consolidated into tool_summary
      const t = flatBlocks(s)[0]!;
      expect(t.kind === 'tool_card' || t.kind === 'tool_summary').toBe(true);
      if (t.kind === 'tool_card') {
        const tc = t as Extract<OutputBlock, { kind: 'tool_card' }>;
        expect(tc.status).toBe('done');
        expect(tc.summary).toBe('150 lines');
        expect(tc.elapsedMs).toBeNumber();
      } else {
        const ts = t as Extract<OutputBlock, { kind: 'tool_summary' }>;
        expect(ts.summaryLine).toContain('read 1 file');
        expect(ts.totalElapsedMs).toBeGreaterThanOrEqual(0);
      }
    });
    test('write_plan displays the saved Artifact path instead of raw JSON', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('plan-1', 'write_plan', { title: 'Login page' }));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.finished',
          toolCallId: 'plan-1',
          name: 'write_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              status: 'draft_saved',
              artifact: { path: '/Users/test/.kite-code/plans/task/plan/v1.md' },
            }),
            stderr: '',
          },
        },
      });

      const card = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'plan-1',
      );
      expect(card?.summary).toBe('— ~/.kite-code/plans/task/plan/v1.md');
    });
    test('write_plan truncates a long Artifact path to one line', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('long-plan-1', 'write_plan', { title: 'Login page' }));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.finished',
          toolCallId: 'long-plan-1',
          name: 'write_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              status: 'draft_saved',
              artifact: {
                path: `/Users/test/.kite-code/plans/${'eb9e8ecf-12345678/'.repeat(4)}v1.md`,
              },
            }),
            stderr: '',
          },
        },
      });

      const card = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'long-plan-1',
      );
      expect(card?.summary).toBe('— ~/.kite-code/plans/eb9e8ecf…/…/eb9e8ecf…/v1.md');
      expect(card?.summary).not.toContain('\n');
      expect(card?.summary?.length).toBeLessThan(70);
    });
    test('approved write_plan keeps the reviewed plan document instead of approval JSON', () => {
      const plan = {
        name: 'Login page',
        description: 'Full reviewed plan body',
        status: 'pending' as const,
        steps: [{ step: 'Build entry point', id: 'entry-point', status: 'pending' as const }],
      };
      let s = fresh();
      s = dispatch(s, tcEvt('reviewed-plan', 'write_plan', { title: plan.name }));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'plan.review_requested',
          interactionId: 'review-1',
          toolCallId: 'reviewed-plan',
          plan,
          planSummary: plan.description,
        },
      });
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'plan.approved',
          interactionId: 'review-1',
          toolCallId: 'reviewed-plan',
          executionMode: 'auto',
        },
      });
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.finished',
          toolCallId: 'reviewed-plan',
          name: 'write_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({ ok: true, status: 'approved', plan_id: 'plan-1' }),
            stderr: '',
          },
        },
      });

      const card = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'reviewed-plan',
      );
      expect(card?.summary).toContain('Full reviewed plan body');
      expect(card?.summary).toContain('Steps:');
      expect(card?.summary).not.toContain('"status":"approved"');
    });
    test('tool_done updates pre-consolidated summary even when the lookup map is stale', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = { ...s, explorationSummaryIds: {} };

      s = dispatch(s, tdEvt('c1', 'read_file', true, '150 lines'));

      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_summary' }>;
      expect(t.kind).toBe('tool_summary');
      expect(t.tools[0]!.status).toBe('done');
      expect(t.tools[0]!.summary).toBe('150 lines');
    });
    test('tool_done updates to error when ok=false', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute'));
      s = dispatch(s, tdEvt('c1', 'shell_execute', false, 'exit 1'));
      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('error');
    });
    test('tool_done recognizes a user-rejected approval when a legacy result omits status', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute'));
      s = dispatch(s, tdEvt('c1', 'shell_execute', false, 'Tool approval cancelled by user.'));
      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('cancelled');
    });
    test('tool_done marks intentional shell timeout separately from errors', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute'));
      s = dispatch(s, tdEvt('c1', 'shell_execute', false, 'Command timed out after 10000ms.'));
      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('timeout');
      expect(t.timeoutMs).toBe(10000);
    });
    test('tool_done preserves live shell output when command times out', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute', { command: 'npm run tui', timeout_ms: 5000 }));
      s = dispatch(s, {
        type: 'EVENT',
        event: {
          type: 'tool_progress',
          data: {
            call_id: 'c1',
            name: 'shell_execute',
            chunk: 'Kite Code ready',
            stream: 'stdout',
          },
        },
      });
      s = dispatch(s, tdEvt('c1', 'shell_execute', false, 'Command timed out after 5000ms.'));

      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('timeout');
      expect(t.summary).toBe('Kite Code ready');
      expect(t.timeoutMs).toBe(5000);
    });
    test('tool_done recovers the default timeout after preceding stderr output', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute', { command: 'npm run test' }));
      s = dispatch(
        s,
        tdEvt('c1', 'shell_execute', false, 'watcher warning\nCommand timed out after 600000ms.'),
      );

      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('timeout');
      expect(t.timeoutMs).toBe(600000);
    });
    test('tool_done preserves full timeout stdout summary when exitCode is available', () => {
      let s = fresh();
      const output = Array.from({ length: 8 }, (_, i) => `startup line ${i + 1}`).join('\n');
      s = dispatch(s, tcEvt('c1', 'shell_execute', { command: 'npm run tui', timeout_ms: 5000 }));
      s = dispatch(s, {
        type: 'EVENT',
        event: {
          type: 'tool_done',
          data: {
            call_id: 'c1',
            name: 'shell_execute',
            ok: false,
            summary: output,
            exitCode: 124,
          },
        },
      });

      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('timeout');
      expect(t.summary).toBe(output);
      expect(t.timeoutMs).toBe(5000);
    });
    test('tool_done with status: exhausted updates tool_card to exhausted state', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute'));
      s = dispatch(s, tdExhausted('c1', 'shell_execute', 'repeated failure'));
      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('exhausted');
    });
    test('tool_done exhausted does NOT inject extra notification text block (rendered by tool_card footer)', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute', { command: 'npm test' }));
      s = dispatch(s, tdExhausted('c1', 'shell_execute', 'repeated failure'));
      const blocks = flatBlocks(s);
      // Only the tool_card — no separate notification text block
      expect(blocks.length).toBe(1);
      expect(blocks[0]!.kind).toBe('tool_card');
    });
    test('tool_done exhausted with no prior tool_card creates just the card (no notification)', () => {
      let s = fresh();
      s = dispatch(
        s,
        tdExhausted('c1', 'shell_execute', 'Execution blocked: too many repeated failures'),
      );
      const blocks = flatBlocks(s);
      expect(blocks.length).toBe(1);
      expect(blocks[0]!.kind).toBe('tool_card');
      expect((blocks[0] as Extract<OutputBlock, { kind: 'tool_card' }>).status).toBe('exhausted');
    });
    test('tool_done exhausted overrides earlier error tool_done for same callId', () => {
      // Real flow: Path A (executeOneTool) sends ok=false first, then
      // the for-loop sends status:'exhausted' as an override. Both events
      // arrive for the same callId before Path B (processStream/chunkToEvents).
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute', { command: 'cat /x' }));
      s = dispatch(s, tdEvt('c1', 'shell_execute', false, 'cat: /x: No such file or directory'));
      // Verify it's error before the override
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>).status).toBe(
        'error',
      );
      // Now the override
      s = dispatch(
        s,
        tdExhausted('c1', 'shell_execute', 'Execution blocked: too many repeated failures'),
      );
      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('exhausted');
    });
    test('tool_done only updates matching callId', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'a'));
      s = dispatch(s, tcEvt('c2', 'b'));
      s = dispatch(s, tdEvt('c1', 'a', true, 'ok'));
      const t1 = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      const t2 = flatBlocks(s)[1] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t1.status).toBe('done');
      expect(t2.status).toBe('running');
    });

    test('visible assistant text is absorbed into the phase block and confirmed by the next exploration tool (ADR-0030)', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'a'));
      s = dispatch(s, textEvt('I checked that file.'));
      // 文本被吸收：不关闭 Thought、不建文本块
      expect(flatBlocks(s).some((b) => b.kind === 'text')).toBe(false);
      s = dispatch(s, tcEvt('c2', 'read_file', { path: 'b.txt' }));

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      // 同一个阶段块：两批工具 + 块顶旁白
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tools.map((t) => t.callId)).toEqual(['c1', 'c2']);
      expect(summaries[0]!.active).toBe(true);
      expect(summaries[0]!.captions).toEqual(['I checked that file.']);
      expect(summaries[0]!.pendingCaption).toBeUndefined();
    });

    test('non-exploration tool settles the phase and detaches the unconfirmed caption (ADR-0030)', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('checking files'));
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }, 'queued'));
      s = dispatch(s, textEvt('I checked that file.'));
      s = dispatch(s, tsEvt('c1'));
      s = dispatch(s, tcEvt('c2', 'shell_execute', { command: 'npm test' }));

      const blocks = flatBlocks(s);
      const summaries = blocks.filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.active).toBe(false);
      expect(summaries[0]!.latestActivity).toBeUndefined();
      expect(summaries[0]!.tools[0]!.status).toBe('running');
      expect(summaries[0]!.pendingCaption).toBeUndefined();
      // 未被只读工具确认的旁白脱离为独立文本块（无题头：思考时长留在块里）
      const text = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'text' }> => b.kind === 'text',
      );
      expect(text?.content).toBe('I checked that file.');
      expect(text?.thoughtElapsedMs).toBeUndefined();
      expect(s.currentThoughtSummaryId).toBeUndefined();
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(true);
    });

    test('final answer detaches from a tool phase block as standalone text without header (ADR-0030)', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'explore', durationMs: 2000 } },
      });
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'ok'));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.requested', requestId: 'req-f' },
      });
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'reason', data: { text: 'synthesize', durationMs: 1500 } },
      });
      s = dispatch(s, textEvt('The analysis follows.'));
      s = dispatch(s, { type: 'EVENT', event: { type: 'final', data: 'The analysis follows.' } });

      const blocks = flatBlocks(s);
      const summary = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      // 阶段块 settle：两次调用时长累加，最终回答前的思考已计入
      expect(summary!.active).toBe(false);
      expect(summary!.result).toBe('done');
      expect(summary!.modelMs).toBe(3500);
      expect(summary!.totalElapsedMs).toBe(3500);
      // 最终回答脱离为独立文本块，无 Thought 题头（时长已在块内）
      const text = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'text' }> => b.kind === 'text',
      );
      expect(text?.content).toBe('The analysis follows.');
      expect(text?.thoughtElapsedMs).toBeUndefined();
    });

    test('non-exploration tool call closes the current Thought before later exploration tools', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'a'));
      s = dispatch(s, tcEvt('c2', 'shell_execute', { command: 'npm test' }));
      s = dispatch(s, tcEvt('c3', 'read_file', { path: 'b.txt' }));

      const blocks = flatBlocks(s);
      const summaries = blocks.filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(2);
      expect(summaries[0]!.tools.map((t) => t.callId)).toEqual(['c1']);
      expect(summaries[0]!.active).toBe(false);
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(true);
      expect(summaries[1]!.tools.map((t) => t.callId)).toEqual(['c3']);
      expect(s.currentThoughtSummaryId).toBe(summaries[1]!.id);
    });

    test('read-only shell search remains an independent tool card', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'ROADMAP.md' }));
      s = dispatch(
        s,
        tcEvt('c2', 'shell_execute', {
          command: 'find /Users/chenchao/Code/ai/openpx-new/src -type f | sort',
        }),
      );

      const blocks = flatBlocks(s);
      const summary = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );

      // read_file is exploration; shell_execute remains governed as a separate card.
      expect(summary).toBeDefined();
      expect(summary!.tools.map((t) => t.callId)).toEqual(['c1']);
      expect(summary!.active).toBe(false);
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(true);
      expect(s.currentThoughtSummaryId).toBeUndefined();
    });

    test('simple inspect ls is consolidated into Thought as a directory listing', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'ROADMAP.md' }));
      s = dispatch(
        s,
        tcEvt('c2', 'shell_execute', {
          intent: 'inspect',
          command: '  ls -la src/app/tui  ',
        }),
      );

      const blocks = flatBlocks(s);
      const summary = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );

      expect(summary).toBeDefined();
      expect(summary!.tools.map((t) => t.callId)).toEqual(['c1', 'c2']);
      expect(summary!.summaryLine).toBe('read 1 file, listed 1 directory');
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(false);
    });

    test.each([
      ['ls -la | tee listing.txt', 'pipeline'],
      ['ls -la > listing.txt', 'redirection'],
      ['ls -la && rm -rf output', 'command chain'],
      ['ls -la $(touch marker)', 'command substitution'],
    ])('inspect ls with %s remains a barrier tool_card (%s)', (command) => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'ROADMAP.md' }));
      s = dispatch(s, tcEvt('c2', 'shell_execute', { intent: 'inspect', command }));

      const blocks = flatBlocks(s);
      const summary = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );

      expect(summary!.tools.map((t) => t.callId)).toEqual(['c1']);
      expect(summary!.active).toBe(false);
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(true);
    });

    test('ls without inspect intent remains a barrier tool_card', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'ROADMAP.md' }));
      s = dispatch(
        s,
        tcEvt('c2', 'shell_execute', {
          intent: 'execute',
          command: 'ls -la',
        }),
      );

      const blocks = flatBlocks(s);
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(true);
    });

    test('inspect shell search without search prefix is a barrier tool_card', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'ROADMAP.md' }));
      s = dispatch(
        s,
        tcEvt('c2', 'shell_execute', {
          intent: 'inspect',
          command: 'npm test', // not a search prefix
        }),
      );

      const blocks = flatBlocks(s);
      const summary = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );

      // c1 is exploration → tool_summary; c2 is NOT (npm test is not search) → tool_card
      expect(summary).toBeDefined();
      expect(summary!.tools.map((t) => t.callId)).toEqual(['c1']);
      expect(summary!.active).toBe(false);
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(true);
      expect(s.currentThoughtSummaryId).toBeUndefined();
    });

    test('non-read shell command is also a barrier tool_card', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'ROADMAP.md' }));
      s = dispatch(
        s,
        tcEvt('c2', 'shell_execute', {
          command: 'npm test', // not a search prefix
        }),
      );

      const blocks = flatBlocks(s);
      const summary = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );

      // c1 is exploration → tool_summary; c2 is NOT (npm test is not search) → tool_card
      expect(summary).toBeDefined();
      expect(summary!.tools.map((t) => t.callId)).toEqual(['c1']);
      expect(summary!.active).toBe(false);
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(true);
      expect(s.currentThoughtSummaryId).toBeUndefined();
    });
  });

  describe('EVENT.state_change', () => {
    test('updates phase', () => {
      const s = dispatch(fresh(), {
        type: 'EVENT',
        event: { type: 'state_change', data: { phase: 'planning' } },
      });
      expect(s.status.phase).toBe('planning');
    });
    test('updates plan and clears to null', () => {
      let s = fresh();
      const plan = { name: 'P', description: 'd', status: 'in_progress' as const, steps: [] };
      s = dispatch(s, { type: 'EVENT', event: { type: 'state_change', data: { plan } } });
      expect(s.status.plan).toEqual(plan);
      s = dispatch(s, { type: 'EVENT', event: { type: 'state_change', data: { plan: null } } });
      expect(s.status.plan).toBeNull();
    });
  });

  describe('EVENT.model_retry', () => {
    test('sets retry status without appending output or closing the live stream', () => {
      const s = dispatch(fresh(), {
        type: 'EVENT',
        event: {
          type: 'model_retry',
          data: { attempt: 2, maxAttempts: 5, error: 'rate limit', delayMs: 1000 },
        },
      });
      expect(flatBlocks(s)).toEqual([]);
      expect(s.status.retryState).toEqual({
        attempt: 2,
        maxAttempts: 5,
        error: 'rate limit',
        delayMs: 1000,
      });
    });
  });

  describe('EVENT.step_begin / step_end', () => {
    test('step_begin sets currentNode', () => {
      const s = dispatch(fresh(), {
        type: 'EVENT',
        event: { type: 'step_begin', data: { node: 'agent', spanId: '0000111122223333' } },
      });
      expect(s.status.currentNode).toBe('agent');
    });
    test('step_end clears currentNode', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'step_begin', data: { node: 'tools', spanId: '1111222233334444' } },
      });
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'step_end', data: { node: 'tools', spanId: '1111222233334444' } },
      });
      expect(s.status.currentNode).toBeNull();
    });
  });

  describe('EVENT.cache_metrics', () => {
    test('accumulates totalTokens manually: first call input+output, later calls output+toolCount', () => {
      let s = fresh();
      // 1st call (totalTokens===0): use inputTokens + outputTokens as baseline
      // 100 input + 30 output = 130
      s = dispatch(s, {
        type: 'EVENT',
        event: {
          type: 'cache_metrics',
          data: {
            workspaceAccess: 'write' as const,
            cacheHitTokens: 50,
            cacheMissTokens: 50,
            cacheWriteTokens: 0,
            inputTokens: 100,
            outputTokens: 30,
            hitRate: 0.5,
            standard: {} as import('@/protocol/events').PromptCacheStandardEvaluation,
          },
        },
      });
      expect(s.status.totalTokens).toBe(130);
      // 2nd call: only add outputTokens (80), cacheMiss (200) is excluded
      // hit=1800 tokens are cached prefix reuse, also excluded
      s = dispatch(s, {
        type: 'EVENT',
        event: {
          type: 'cache_metrics',
          data: {
            workspaceAccess: 'write' as const,
            cacheHitTokens: 1800,
            cacheMissTokens: 200,
            cacheWriteTokens: 0,
            inputTokens: 2000,
            outputTokens: 80,
            hitRate: 0.9,
            standard: {} as import('@/protocol/events').PromptCacheStandardEvaluation,
          },
        },
      });
      expect(s.status.totalTokens).toBe(210);
      // 3rd: tool_done with toolTokenCount adds to total (needs prior tool_call block)
      s = dispatch(s, tcEvt('c1', 'shell_execute'));
      s = dispatch(s, {
        type: 'EVENT',
        event: {
          type: 'tool_done',
          data: {
            call_id: 'c1',
            name: 'shell_execute',
            ok: true,
            summary: 'ok',
            toolTokenCount: 500,
          },
        },
      });
      expect(s.status.totalTokens).toBe(710);
    });
  });

  describe('EVENT.final', () => {
    test('appends text block when non-empty', () => {
      const s = dispatch(fresh(), { type: 'EVENT', event: { type: 'final', data: 'done' } });
      expect(flatBlocks(s)).toHaveLength(1);
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe('done');
    });
    test('no-ops when empty', () => {
      const s = dispatch(fresh(), { type: 'EVENT', event: { type: 'final', data: '' } });
      expect(flatBlocks(s)).toHaveLength(0);
    });
    test('deduplicates against earlier text block across interrupt boundary', () => {
      // Simulate: agent emits text + ask_user tool_call → interrupt →
      // agent resumes with same text → text + final events
      let s = fresh();
      s = dispatch(s, { type: 'SET_RUNNING' });
      s = dispatch(s, textEvt('我看了你的项目环境，这是 Kite Code 项目本身'));
      s = dispatch(s, tcEvt('c1', 'ask_user', { question: '你要什么？' }));
      s = dispatch(s, { type: 'EVENT', event: { type: 'need_input', data: question() } });
      // User answers, interrupt resolved
      s = dispatch(s, {
        type: 'RESOLVE_INTERRUPT',
        blockId: (s.interrupt as { blockId: number }).blockId,
        resolution: 'a',
      });
      // Agent resumes, emits same text + final
      s = dispatch(s, textEvt('我看了你的项目环境，这是 Kite Code 项目本身'));
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'final', data: '我看了你的项目环境，这是 Kite Code 项目本身' },
      });
      // Should have only 1 text block with the duplicate content
      const textBlocks = flatBlocks(s).filter(
        (b) => b.kind === 'text' && b.content === '我看了你的项目环境，这是 Kite Code 项目本身',
      );
      expect(textBlocks).toHaveLength(1);
    });
    test('deduplicates final against text block separated by tool_card', () => {
      // Simulate: agent emits text → tool_call → tool_done → final with same text
      let s = fresh();
      s = dispatch(s, { type: 'SET_RUNNING' });
      s = dispatch(s, textEvt('分析完成'));
      s = dispatch(s, tcEvt('c2', 'shell_execute', { command: 'ls' }));
      s = dispatch(s, tdEvt('c2', 'shell_execute', true, 'ok'));
      // final arrives, last block is tool_card (done), not text
      s = dispatch(s, { type: 'EVENT', event: { type: 'final', data: '分析完成' } });
      // Should not create another text block for the same content
      const textBlocks = flatBlocks(s).filter((b) => b.kind === 'text' && b.content === '分析完成');
      expect(textBlocks).toHaveLength(1);
    });
  });

  describe('EVENT.need_approval / need_input + RESOLVE_INTERRUPT', () => {
    function withAllSelectorsOpen(state: TuiState): TuiState {
      return {
        ...state,
        showHelp: true,
        showModelSelector: true,
        showPermissionSelector: true,
        showEffortSelector: true,
        showThemeSelector: true,
        showSessions: true,
        showMcp: true,
        showRewind: true,
      };
    }

    function expectSelectorsClosed(state: TuiState) {
      expect(state.showHelp).toBe(false);
      expect(state.showModelSelector).toBe(false);
      expect(state.showPermissionSelector).toBe(false);
      expect(state.showEffortSelector).toBe(false);
      expect(state.showThemeSelector).toBe(false);
      expect(state.showSessions).toBe(false);
      expect(state.showMcp).toBe(false);
      expect(state.showRewind).toBe(false);
    }

    test('gives every interrupt priority over open selectors', () => {
      const plan = { name: 'Review', description: 'Check', status: 'pending' as const, steps: [] };
      const events: Array<{ event: RenderEvent; kind: InterruptState['kind'] }> = [
        { event: { type: 'need_approval', data: approval() }, kind: 'approval' },
        { event: { type: 'need_input', data: question() }, kind: 'input' },
        { event: { type: 'need_plan_review', data: { plan } }, kind: 'plan_review' },
      ];

      for (const { event, kind } of events) {
        const state = handleEventAction(withAllSelectorsOpen(fresh()), event);
        expect(state.interrupt?.kind).toBe(kind);
        expectSelectorsClosed(state);
      }
    });

    test('keeps approval in the Footer interrupt without appending a message block', () => {
      const a = approval({ command: 'rm -rf /' });
      const s = dispatch(fresh(), { type: 'EVENT', event: { type: 'need_approval', data: a } });
      expect(flatBlocks(s)).toHaveLength(0);
      expect(s.interrupt).toEqual({ kind: 'approval', approval: a });
    });
    test('appends question block and sets interrupt', () => {
      const q = question({ question: 'Choose color' });
      const s = dispatch(fresh(), { type: 'EVENT', event: { type: 'need_input', data: q } });
      expect(flatBlocks(s)[0]!.kind).toBe('question');
      expect(s.interrupt?.kind).toBe('input');
    });
    test('RESOLVE_INTERRUPT clears an off-screen approval', () => {
      let s = fresh();
      const a = approval();
      s = dispatch(s, { type: 'EVENT', event: { type: 'need_approval', data: a } });
      s = dispatch(s, {
        type: 'RESOLVE_INTERRUPT',
        resolution: { action: 'approved', grant: 'approve_once' },
      });
      expect(flatBlocks(s)).toHaveLength(0);
      expect(s.interrupt).toBeNull();
    });
    test('RESOLVE_INTERRUPT marks question as resolved', () => {
      let s = fresh();
      s = dispatch(s, { type: 'EVENT', event: { type: 'need_input', data: question() } });
      const blockId = (s.interrupt as { blockId: number }).blockId;
      s = dispatch(s, { type: 'RESOLVE_INTERRUPT', blockId, resolution: 'my answer' });
      const b = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'question' }>;
      expect(b.resolved).toBe('my answer');
      expect(s.interrupt).toBeNull();
    });
    test('RESOLVE_INTERRUPT pre-fills only the active ask_user card with multi-question answers', () => {
      const answers = {
        intent: 'implement',
        scope: 'tui',
        tests: 'focused',
        review: 'self',
        commit: 'yes',
      };
      const multiQuestion = question({
        question: 'Configure the work',
        questions: Object.keys(answers).map((id) => ({
          id,
          question: `Choose ${id}`,
          options: [],
        })),
      });
      let s = fresh();
      s = dispatch(s, tcEvt('ask-1', 'ask_user', { question: multiQuestion.question }));
      s = dispatch(s, tcEvt('shell-1', 'shell_execute', { command: 'bun test' }));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'user_input.requested',
          interactionId: 'input-1',
          toolCallId: 'ask-1',
          request: multiQuestion,
        },
      });
      const blockId = (s.interrupt as { blockId: number }).blockId;

      s = dispatch(s, {
        type: 'RESOLVE_INTERRUPT',
        blockId,
        resolution: { action: 'answered', text: 'Configured', answers },
      });

      const askCard = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'ask-1',
      );
      const shellCard = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'shell-1',
      );
      expect(askCard).toMatchObject({
        status: 'done',
        userInput: { answer: 'Configured', answers },
      });
      expect(shellCard?.status).toBe('running');
    });
    test('RESOLVE_INTERRUPT uses the input tool identity when ask_user questions are duplicated', () => {
      const duplicateQuestion = question({ question: 'Choose a mode' });
      let s = fresh();
      s = dispatch(s, tcEvt('ask-first', 'ask_user', { question: duplicateQuestion.question }));
      s = dispatch(s, tcEvt('ask-second', 'ask_user', { question: duplicateQuestion.question }));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'user_input.requested',
          interactionId: 'input-first',
          toolCallId: 'ask-first',
          request: duplicateQuestion,
        },
      });
      const blockId = (s.interrupt as { blockId: number }).blockId;

      s = dispatch(s, { type: 'RESOLVE_INTERRUPT', blockId, resolution: 'auto' });

      const first = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'ask-first',
      );
      const second = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'ask-second',
      );
      expect(first).toMatchObject({ status: 'done', userInput: { answer: 'auto' } });
      expect(second?.status).toBe('running');
    });
    test('RESOLVE_INTERRUPT pre-fills a queued ask_user card before tool.started', () => {
      const request = question({ question: 'Choose a mode' });
      let s = dispatch(fresh(), {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.queued',
          toolCallId: 'ask-queued',
          name: 'ask_user',
          args: { question: request.question },
        },
      });
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'user_input.requested',
          interactionId: 'input-queued',
          toolCallId: 'ask-queued',
          request,
        },
      });
      const blockId = (s.interrupt as { blockId: number }).blockId;

      s = dispatch(s, { type: 'RESOLVE_INTERRUPT', blockId, resolution: 'auto' });

      const card = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'ask-queued',
      );
      expect(card).toMatchObject({
        status: 'done',
        args: request,
        detail: 'Choose a mode',
        userInput: { answer: 'auto' },
      });
    });
    test('RESOLVE_INTERRUPT pre-fills the sole active ask_user card for legacy need_input', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('ask-only', 'ask_user', { question: 'Choose a mode' }));
      s = dispatch(s, { type: 'EVENT', event: { type: 'need_input', data: question() } });
      const blockId = (s.interrupt as { blockId: number }).blockId;

      s = dispatch(s, { type: 'RESOLVE_INTERRUPT', blockId, resolution: 'auto' });

      const card = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'ask-only',
      );
      expect(card).toMatchObject({ status: 'done', userInput: { answer: 'auto' } });
    });
    test('RESOLVE_INTERRUPT leaves duplicate legacy ask_user cards active when identity is absent', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('ask-first', 'ask_user', { question: 'Choose a mode' }));
      s = dispatch(s, tcEvt('ask-second', 'ask_user', { question: 'Choose a mode' }));
      s = dispatch(s, { type: 'EVENT', event: { type: 'need_input', data: question() } });
      const blockId = (s.interrupt as { blockId: number }).blockId;

      s = dispatch(s, { type: 'RESOLVE_INTERRUPT', blockId, resolution: 'auto' });

      const cards = flatBlocks(s).filter(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.name === 'ask_user',
      );
      expect(cards.map((card) => card.status)).toEqual(['running', 'running']);
      expect(cards.map((card) => card.userInput)).toEqual([undefined, undefined]);
    });
    test('replay clears an answered ask_user interrupt', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('ask-replay', 'ask_user', { question: 'What color?' }));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'user_input.requested',
          interactionId: 'input-replay',
          toolCallId: 'ask-replay',
          request: question({ question: 'What color?' }),
        },
      });
      expect(s.interrupt?.kind).toBe('input');

      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'user_input.answered',
          interactionId: 'input-replay',
          toolCallId: 'ask-replay',
          answer: 'Blue',
        },
      });

      expect(s.interrupt).toBeNull();
      const questionBlock = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'question' }> =>
          block.kind === 'question' && block.toolCallId === 'ask-replay',
      );
      expect(questionBlock?.resolved).toBe('Blue');
    });

    test('tool_done after RESOLVE_INTERRUPT preserves ask_user answer in userInput', () => {
      // Verify that when tool.finished arrives AFTER the optimistic RESOLVE_INTERRUPT,
      // the answer (userInput) is preserved and the tool_card renders correctly.
      let s = fresh();
      s = dispatch(s, tcEvt('ask-1', 'ask_user', { question: 'What color?' }));
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'user_input.requested',
          interactionId: 'input-1',
          toolCallId: 'ask-1',
          request: question({ question: 'What color?' }),
        },
      });
      const blockId = (s.interrupt as { blockId: number }).blockId;

      // Simulate user selecting option
      s = dispatch(s, {
        type: 'RESOLVE_INTERRUPT',
        blockId,
        resolution: 'Blue',
      });

      // Simulate tool.finished event arriving from kernel
      s = dispatch(s, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.finished',
          toolCallId: 'ask-1',
          name: 'ask_user',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({ answer: 'Blue' }),
            stderr: '',
            userInput: { answer: 'Blue' },
          },
        },
      });

      const card = flatBlocks(s).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'ask-1',
      );
      expect(card).toMatchObject({
        status: 'done',
        userInput: { answer: 'Blue' },
      });
      // The summary should contain the parsed answer, not raw JSON
      expect(card?.summary).toBe('Blue');
      // expanded must be true for answer rendering
      expect(card?.expanded).toBe(true);
    });
    test('need_approval closes active Thought so its timer stops while waiting for the user', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('checking before approval'));
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'a'));

      s = dispatch(s, { type: 'EVENT', event: { type: 'need_approval', data: approval() } });

      const summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary).toBeDefined();
      expect(summary!.active).toBe(false);
      expect(summary!.latestActivity).toBeUndefined();
      expect(s.currentThoughtSummaryId).toBeUndefined();
      expect(s.interrupt?.kind).toBe('approval');
    });
    test('bash approval closes Thought even when an exploration tool is still pending', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('checking before shell'));
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tcEvt('c2', 'shell_execute', { command: 'npm test' }));

      s = dispatch(s, { type: 'EVENT', event: { type: 'need_approval', data: approval() } });

      const summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary).toBeDefined();
      expect(summary!.active).toBe(false);
      expect(summary!.latestActivity).toBeUndefined();
      expect(summary!.tools[0]!.status).toBe('running');
      expect(flatBlocks(s).some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(true);
      expect(s.currentThoughtSummaryId).toBeUndefined();
      expect(s.interrupt?.kind).toBe('approval');
    });
    test('runtime approval stays in Footer and materializes tools only when they start', () => {
      let s = fresh();
      s = handleRuntimeEventAction(s, {
        type: 'tool.queued',
        toolCallId: 'bash-1',
        name: 'shell_execute',
        args: { command: 'bun test' },
      });
      s = handleRuntimeEventAction(s, {
        type: 'tool.queued',
        toolCallId: 'read-1',
        name: 'read_file',
        args: { path: 'run-agent.ts' },
      });
      expect(flatBlocks(s)).toHaveLength(0);

      s = handleRuntimeEventAction(s, {
        type: 'approval.requested',
        interactionId: 'approval-1',
        toolCallId: 'bash-1',
        approval: {
          ...approval({ callId: 'bash-1', command: 'bun test' }),
          callId: 'bash-1',
        },
      });

      expect(
        flatBlocks(s).filter((block) => block.kind === 'tool_card' && block.callId === 'bash-1'),
      ).toHaveLength(0);
      expect(s.interrupt).toMatchObject({
        kind: 'approval',
        approval: { callId: 'bash-1', command: 'bun test' },
      });
      expect(
        flatBlocks(s).some(
          (block) =>
            (block.kind === 'tool_card' && block.callId === 'read-1') ||
            (block.kind === 'tool_summary' && block.tools.some((tool) => tool.callId === 'read-1')),
        ),
      ).toBe(false);

      s = dispatch(s, {
        type: 'RESOLVE_INTERRUPT',
        resolution: { action: 'approved', grant: 'approve_once' },
      });
      expect(s.interrupt).toBeNull();
      expect(flatBlocks(s)).toHaveLength(0);

      s = handleRuntimeEventAction(s, {
        type: 'tool.started',
        toolCallId: 'bash-1',
      });
      expect(
        flatBlocks(s).filter(
          (block) =>
            block.kind === 'tool_card' && block.callId === 'bash-1' && block.status === 'running',
        ),
      ).toHaveLength(1);

      s = handleRuntimeEventAction(s, {
        type: 'tool.started',
        toolCallId: 'read-1',
      });
      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tools[0]).toMatchObject({
        callId: 'read-1',
        status: 'running',
      });
    });
    test('shows the next shell approval while an approved sibling remains running', () => {
      let s = fresh();
      for (const [toolCallId, command] of [
        ['bash-1', 'bun test'],
        ['bash-2', 'bun run typecheck'],
      ] as const) {
        s = handleRuntimeEventAction(s, {
          type: 'tool.queued',
          toolCallId,
          name: 'shell_execute',
          args: { command },
        });
      }
      s = handleRuntimeEventAction(s, { type: 'tool.started', toolCallId: 'bash-1' });
      s = handleRuntimeEventAction(s, {
        type: 'approval.requested',
        interactionId: 'approval-2',
        toolCallId: 'bash-2',
        approval: {
          ...approval({ callId: 'bash-2', command: 'bun run typecheck' }),
          callId: 'bash-2',
        },
      });

      expect(
        flatBlocks(s).filter(
          (block) =>
            block.kind === 'tool_card' && block.callId === 'bash-1' && block.status === 'running',
        ),
      ).toHaveLength(1);
      expect(
        flatBlocks(s).some((block) => block.kind === 'tool_card' && block.callId === 'bash-2'),
      ).toBe(false);
      expect(s.interrupt).toMatchObject({
        kind: 'approval',
        approval: { callId: 'bash-2', command: 'bun run typecheck' },
      });
    });
    test('approving a later shell preserves a running sibling start time', () => {
      let s = fresh();
      for (const [toolCallId, command] of [
        ['bash-1', 'bun test'],
        ['bash-2', 'bun run typecheck'],
      ] as const) {
        s = handleRuntimeEventAction(s, {
          type: 'tool.queued',
          toolCallId,
          name: 'shell_execute',
          args: { command },
        });
      }
      s = handleRuntimeEventAction(s, { type: 'tool.started', toolCallId: 'bash-1' });
      s = {
        ...s,
        toolStartTimes: { 'bash-1': 123 },
        turns: s.turns.map((turn) => ({
          blocks: turn.blocks.map((block) =>
            block.kind === 'tool_card' && block.callId === 'bash-1'
              ? { ...block, startedAt: 123 }
              : block,
          ),
        })),
      };
      s = handleRuntimeEventAction(s, {
        type: 'approval.requested',
        interactionId: 'approval-2',
        toolCallId: 'bash-2',
        approval: {
          ...approval({ callId: 'bash-2', command: 'bun run typecheck' }),
          callId: 'bash-2',
        },
      });
      s = dispatch(s, {
        type: 'RESOLVE_INTERRUPT',
        resolution: { action: 'approved', grant: 'approve_once' },
      });

      const running = flatBlocks(s).find(
        (block) => block.kind === 'tool_card' && block.callId === 'bash-1',
      );
      expect(running).toMatchObject({ kind: 'tool_card', startedAt: 123 });
      expect(s.toolStartTimes).toEqual({ 'bash-1': 123 });
    });
    test('need_input closes active Thought so its timer stops while waiting for the user', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('asking after inspection'));
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'a'));

      s = dispatch(s, { type: 'EVENT', event: { type: 'need_input', data: question() } });

      const summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary).toBeDefined();
      expect(summary!.active).toBe(false);
      expect(summary!.latestActivity).toBeUndefined();
      expect(s.currentThoughtSummaryId).toBeUndefined();
      expect(s.interrupt?.kind).toBe('input');
    });
    test('need_plan_review closes active Thought so its timer stops while waiting for review', () => {
      let s = fresh();
      const plan = {
        name: 'Review plan',
        description: 'Check behavior',
        status: 'pending' as const,
        steps: [{ step: 'Review', status: 'pending' as const }],
      };
      s = dispatch(s, reasonEvt('preparing a plan review'));
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'a'));

      s = dispatch(s, { type: 'EVENT', event: { type: 'need_plan_review', data: { plan } } });

      const summary = flatBlocks(s).find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summary).toBeDefined();
      expect(summary!.active).toBe(false);
      expect(summary!.latestActivity).toBeUndefined();
      expect(s.currentThoughtSummaryId).toBeUndefined();
      expect(s.interrupt?.kind).toBe('plan_review');
    });
  });

  describe('EVENT.error', () => {
    test('appends text block with error message', () => {
      const s = dispatch(fresh(), {
        type: 'EVENT',
        event: { type: 'error', data: { message: 'boom', recoverable: true } },
      });
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toContain(
        'boom',
      );
    });
  });

  describe('EVENT.file_change', () => {
    test('appends file_change block', () => {
      const s = dispatch(fresh(), {
        type: 'EVENT',
        event: { type: 'file_change', data: { path: 'a.ts', kind: 'add' } },
      });
      const fc = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'file_change' }>;
      expect(fc.changes).toHaveLength(1);
      expect(fc.changes[0]!.path).toBe('a.ts');
    });
    test('coalesces consecutive file_change events into one block', () => {
      let s = fresh();
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'file_change', data: { path: 'a.ts', kind: 'add' } },
      });
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'file_change', data: { path: 'b.ts', kind: 'edit' } },
      });
      expect(flatBlocks(s)).toHaveLength(1);
      const fc = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'file_change' }>;
      expect(fc.changes).toHaveLength(2);
    });
  });

  describe('non-event actions', () => {
    test('SET_RUNNING increments runCount', () => {
      let s = fresh();
      s = dispatch(s, { type: 'SET_RUNNING' });
      expect(s.running).toBe(true);
      expect(s.runCount).toBe(1);
    });
    test('SET_IDLE clears running and interrupt', () => {
      let s = fresh();
      s = { ...s, running: true, interrupt: { kind: 'approval', blockId: 1 } };
      s = dispatch(s, { type: 'SET_IDLE' });
      expect(s.running).toBe(false);
      expect(s.interrupt).toBeNull();
    });
    test('TOGGLE_REASON toggles folded on reason block', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('think'));
      const id = (flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'reason' }>).id;
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'reason' }>).folded).toBe(true);
      s = dispatch(s, { type: 'TOGGLE_REASON', id });
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'reason' }>).folded).toBe(false);
    });
    test('TOGGLE_ALL_REASON toggles all reason blocks folded', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('first'));
      s = dispatch(s, textEvt('between'));
      s = dispatch(s, reasonEvt('second'));
      // 布局（ADR-0026 后）：[reason1, text（纯思考已并入题头）, reason2, tool_summary(活跃纯思考)]
      // Layout: [reason1, text (pure thought merged as header), reason2, tool_summary(active pure)]
      // First reason block auto-expanded on non-reason event, second still folded
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'reason' }>).folded).toBe(false);
      expect((flatBlocks(s)[2] as Extract<OutputBlock, { kind: 'reason' }>).folded).toBe(true);
      // Toggle: collapse all (anyExpanded → fold all)
      s = dispatch(s, { type: 'TOGGLE_ALL_REASON' });
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'reason' }>).folded).toBe(true);
      expect((flatBlocks(s)[2] as Extract<OutputBlock, { kind: 'reason' }>).folded).toBe(true);
      // Toggle: expand all (none expanded → unfold all)
      s = dispatch(s, { type: 'TOGGLE_ALL_REASON' });
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'reason' }>).folded).toBe(false);
      expect((flatBlocks(s)[2] as Extract<OutputBlock, { kind: 'reason' }>).folded).toBe(false);
    });
    test('TOGGLE_ALL_REASON is no-op when no reason blocks', () => {
      let s = dispatch(fresh(), textEvt('hello'));
      const prev = flatBlocks(s);
      s = dispatch(s, { type: 'TOGGLE_ALL_REASON' });
      expect(flatBlocks(s)).toEqual(prev);
    });
    test('SET_THINKING_LEVEL updates thinkingMode in status', () => {
      let s = fresh();
      expect(s.status.thinkingMode).toBe('max');
      s = dispatch(s, { type: 'SET_THINKING_LEVEL', level: 'low' });
      expect(s.status.thinkingMode).toBe('low');
      s = dispatch(s, { type: 'SET_THINKING_LEVEL', level: 'high' });
      expect(s.status.thinkingMode).toBe('high');
    });
    test('SELECT_MODEL records whether the selected configuration disables reasoning', () => {
      const s = dispatch(fresh(), {
        type: 'SELECT_MODEL',
        provider: 'openai-compatible',
        modelName: 'plain-chat-model',
        reasoningEnabled: false,
      });
      expect(s.status.reasoningEnabled).toBe(false);
    });
    test('SET_CONTEXT_SNAPSHOT refreshes context without resetting cumulative cache usage', () => {
      const state = {
        ...fresh(),
        status: {
          ...fresh().status,
          cacheHitTokens: 750,
          cacheMissTokens: 250,
          totalTokens: 11_500,
        },
      };
      const next = dispatch(state, {
        type: 'SET_CONTEXT_SNAPSHOT',
        snapshot: {
          estimate: {
            systemTokens: 1_000,
            toolSchemaTokens: 500,
            transcriptTokens: 8_000,
            summaryTokens: 1_000,
            dynamicRuntimeTokens: 100,
            framingTokens: 100,
            totalInputTokens: 10_700,
          },
          status: 'unknown',
        },
      });
      expect(next.status.contextSnapshot?.estimate.totalInputTokens).toBe(10_700);
      expect(next.status.cacheHitTokens).toBe(750);
      expect(next.status.cacheMissTokens).toBe(250);
      expect(next.status.totalTokens).toBe(11_500);
    });
    test('CLEAR_OUTPUT clears blocks', () => {
      let s = dispatch(fresh(), textEvt('hello'));
      s = dispatch(s, { type: 'CLEAR_OUTPUT' });
      expect(flatBlocks(s)).toHaveLength(0);
    });
    test('ESCAPE keeps interrupt until durable Runtime cancellation arrives', () => {
      let s = fresh();
      s = { ...s, interrupt: { kind: 'approval', blockId: 99 } };
      s = dispatch(s, { type: 'ESCAPE' });
      expect(s.interrupt).not.toBeNull();
    });
    test('ESCAPE when running with interrupt keeps the durable interaction visible', () => {
      let s = fresh();
      s = { ...s, running: true, interrupt: { kind: 'approval', blockId: 99 } };
      s = dispatch(s, { type: 'ESCAPE' });
      expect(s.interrupt).not.toBeNull();
      expect(s.running).toBe(true);
    });
    test('ESCAPE when running without interrupt stops the session', () => {
      let s = fresh();
      s = { ...s, running: true };
      s = dispatch(s, { type: 'ESCAPE' });
      expect(s.running).toBe(false);
    });
    test('ESCAPE closes help before modelSelector', () => {
      let s = fresh();
      s = { ...s, showHelp: true, showModelSelector: true };
      s = dispatch(s, { type: 'ESCAPE' });
      expect(s.showHelp).toBe(false);
      expect(s.showModelSelector).toBe(true);
    });
    test('CTRL_C when running sets ctrlCPressed', () => {
      let s = fresh();
      s = { ...s, running: true };
      s = dispatch(s, { type: 'CTRL_C' });
      expect(s.ctrlCPressed).toBe(true);
    });
    test('CTRL_C when not running first press sets ctrlCPressed', () => {
      let s = fresh();
      s = dispatch(s, { type: 'CTRL_C' });
      expect(s.ctrlCPressed).toBe(true);
      expect(s.running).toBe(false);
    });
    test('CTRL_C when not running second press sets exitRequested', () => {
      let s = fresh();
      s = { ...s, ctrlCPressed: true };
      s = dispatch(s, { type: 'CTRL_C' });
      expect(s.exitRequested).toBe(true);
    });
    test('SWITCH_AUTH toggles default <-> full_access', () => {
      let s = fresh();
      s = dispatch(s, { type: 'SWITCH_AUTH', mode: 'toggle' });
      expect(s.status.authorization).toBe('full_access');
      s = dispatch(s, { type: 'SWITCH_AUTH', mode: 'toggle' });
      expect(s.status.authorization).toBe('default');
    });
    test('SWITCH_AUTH with explicit mode sets authorization directly', () => {
      let s = fresh();
      s = dispatch(s, { type: 'SWITCH_AUTH', mode: 'full_access' });
      expect(s.status.authorization).toBe('full_access');
      s = dispatch(s, { type: 'SWITCH_AUTH', mode: 'default' });
      expect(s.status.authorization).toBe('default');
    });
    test('SET_PHASE transitions between planning and building', () => {
      let s = fresh();
      expect(s.status.phase).toBe('building');
      s = dispatch(s, { type: 'SET_PHASE', phase: 'planning' });
      expect(s.status.phase).toBe('planning');
      s = dispatch(s, { type: 'SET_PHASE', phase: 'building' });
      expect(s.status.phase).toBe('building');
    });
    test('planning.exited projects the durable exit back to building', () => {
      const s = handleRuntimeEventAction(
        { ...fresh(), status: { ...fresh().status, phase: 'planning' } },
        {
          type: 'planning.exited',
          taskId: 'task-1',
          reason: 'Exited Plan Mode.',
        },
      );
      expect(s.status.phase).toBe('building');
    });
    test('TOGGLE_PLAN_MODE toggles phase and resets auth', () => {
      let s = fresh();
      // 先设为 full_access / Start with full_access
      s = dispatch(s, { type: 'SWITCH_AUTH', mode: 'full_access' });
      expect(s.status.authorization).toBe('full_access');
      // 切换到 planning / Toggle to planning
      s = dispatch(s, { type: 'TOGGLE_PLAN_MODE' });
      expect(s.status.phase).toBe('planning');
      expect(s.status.authorization).toBe('default');
      // 切回 building，auth 保持 / Toggle back, auth stays
      s = dispatch(s, { type: 'TOGGLE_PLAN_MODE' });
      expect(s.status.phase).toBe('building');
      expect(s.status.authorization).toBe('default');
    });
    test('need_plan_review sets interrupt and pendingPlan, resolved via RESOLVE_PLAN_REVIEW', () => {
      const eventPayload = {
        plan: { name: 'Test', description: 'Desc', status: 'pending' as const, steps: [] },
      };
      const event: LegacyRenderAction = {
        type: 'EVENT',
        event: { type: 'need_plan_review', data: eventPayload } as unknown as RenderEvent,
      };
      let s = dispatch(fresh(), event);
      // No plan_review block created (plan content shown via update_plan tool_card)
      // plan_review 不是块类型（内容由 update_plan tool_card 渲染）：断言无此块
      const block = flatBlocks(s).find((b) => (b.kind as string) === 'plan_review');
      expect(block).toBeUndefined();
      expect(s.interrupt?.kind).toBe('plan_review');
      expect(s.status.pendingPlan).toEqual(eventPayload.plan);
      // Resolve with auto
      s = dispatch(s, {
        type: 'RESOLVE_PLAN_REVIEW',
        resolution: { action: 'approved_auto' },
      });
      expect(s.interrupt).toBeNull();
      // Approved plan promoted to status.plan
      expect(s.status.plan).toEqual(eventPayload.plan);
      expect(s.status.pendingPlan).toBeNull();
    });

    test('RESOLVE_PLAN_REVIEW with approved_accept_edits clears interrupt and promotes plan', () => {
      const eventPayload = {
        plan: { name: 'AcceptEdits', description: 'Desc', status: 'pending' as const, steps: [] },
      };
      let s = dispatch(fresh(), {
        type: 'EVENT',
        event: { type: 'need_plan_review', data: eventPayload } as unknown as RenderEvent,
      });
      expect(s.interrupt?.kind).toBe('plan_review');
      s = dispatch(s, {
        type: 'RESOLVE_PLAN_REVIEW',
        resolution: { action: 'approved_accept_edits' },
      });
      expect(s.interrupt).toBeNull();
      expect(s.status.plan).toEqual(eventPayload.plan);
      expect(s.status.pendingPlan).toBeNull();
    });

    test('replay promotes an approved plan before filtering update_plan', () => {
      const plan = {
        name: 'Replay plan',
        description: 'Plan from runtime events',
        status: 'pending' as const,
        steps: [{ step: 'Entry point', id: 'entry-point', status: 'pending' as const }],
      };
      let s = fresh();
      s = handleRuntimeEventAction(s, {
        type: 'tool.queued',
        toolCallId: 'plan-call',
        name: 'write_plan',
        args: {},
      });
      s = handleRuntimeEventAction(s, {
        type: 'plan.review_requested',
        interactionId: 'review-1',
        toolCallId: 'plan-call',
        plan,
        planSummary: plan.description,
      });
      s = handleRuntimeEventAction(s, {
        type: 'plan.approved',
        interactionId: 'review-1',
        toolCallId: 'plan-call',
        executionMode: 'auto',
      });

      expect(s.status.plan).toEqual(plan);
      expect(s.status.pendingPlan).toBeNull();
      expect(s.interrupt).toBeNull();

      s = handleRuntimeEventAction(s, {
        type: 'tool.queued',
        toolCallId: 'progress-call',
        name: 'update_plan',
        args: { updates: [{ step_id: 'entry-point', status: 'completed' }] },
      });

      expect(
        flatBlocks(s).some((block) => block.kind === 'tool_card' && block.name === 'update_plan'),
      ).toBe(false);
    });

    test('replay clears a rejected plan review', () => {
      const plan = {
        name: 'Rejected plan',
        description: 'Plan from runtime events',
        status: 'pending' as const,
        steps: [],
      };
      let s = handleRuntimeEventAction(fresh(), {
        type: 'plan.review_requested',
        interactionId: 'review-rejected',
        toolCallId: 'plan-rejected',
        plan,
        planSummary: plan.description,
      });
      expect(s.interrupt?.kind).toBe('plan_review');
      s = handleRuntimeEventAction(s, {
        type: 'plan.rejected',
        interactionId: 'review-rejected',
        toolCallId: 'plan-rejected',
        reason: 'User rejected the plan.',
      });
      expect(s.interrupt).toBeNull();
    });

    test('projects a provider recovery requirement into the shared TUI input surface', () => {
      const s = handleRuntimeEventAction(fresh(), {
        type: 'provider.action_required',
        interactionId: 'provider-action',
        providerId: 'github',
        action: 'login',
        originatingToolCallId: 'mcp-call',
      });

      expect(s.interrupt?.kind).toBe('input');
      expect(flatBlocks(s).at(-1)).toMatchObject({
        kind: 'question',
        toolCallId: 'mcp-call',
        question: {
          question: "MCP provider 'github' requires login.",
          recommended: 'recover',
          allow_free_text: false,
        },
      });
    });

    test('replay clears completed provider recovery interactions', () => {
      let actionState = handleRuntimeEventAction(fresh(), {
        type: 'provider.action_required',
        interactionId: 'provider-action',
        providerId: 'github',
        action: 'login',
        originatingToolCallId: 'mcp-call',
      });
      expect(actionState.interrupt?.kind).toBe('input');
      actionState = handleRuntimeEventAction(actionState, {
        type: 'provider.action_started',
        interactionId: 'provider-action',
      });
      expect(actionState.interrupt?.kind).toBe('input');

      actionState = handleRuntimeEventAction(actionState, {
        type: 'provider.action_completed',
        interactionId: 'provider-action',
        originatingToolCallId: 'mcp-call',
      });
      expect(actionState.interrupt).toBeNull();

      let admissionState = handleRuntimeEventAction(fresh(), {
        type: 'provider.admission_required',
        interactionId: 'provider-admission',
        providerId: 'github',
        source: 'user',
        providerStatus: 'login_required',
        retryable: false,
      });
      expect(admissionState.interrupt?.kind).toBe('input');
      admissionState = handleRuntimeEventAction(admissionState, {
        type: 'provider.admission_waived',
        interactionId: 'provider-admission',
        providerId: 'github',
        source: 'user',
        reason: 'user_session_waiver',
        waivedAt: '2026-08-07T00:00:00.000Z',
      });
      expect(admissionState.interrupt).toBeNull();
    });

    test('projects required provider admission without offering an unavailable retry', () => {
      const s = handleRuntimeEventAction(fresh(), {
        type: 'provider.admission_required',
        interactionId: 'provider-admission',
        providerId: 'github',
        source: 'user',
        providerStatus: 'login_required',
        diagnosticCode: 'auth_required',
        retryable: false,
      });

      expect(s.interrupt?.kind).toBe('input');
      expect(flatBlocks(s).at(-1)).toMatchObject({
        kind: 'question',
        question: {
          question: "Required MCP provider 'github' is login_required.",
          recommended: 'waive',
          options: [
            { id: 'waive', label: 'Session Waive' },
            { id: 'cancel', label: 'Cancel Run' },
          ],
        },
      });
    });

    test('need_plan_review populates tool_card summary and expanded', () => {
      // First create a tool_call for update_plan (simulating the agent calling the tool)
      let s = dispatch(fresh(), {
        type: 'EVENT',
        event: {
          type: 'tool_call',
          data: {
            call_id: 'plan-1',
            name: 'update_plan',
            args: {
              name: 'Test Plan',
              description: 'A great plan',
              status: 'pending',
              steps: [{ step: 'Do thing', status: 'pending' }],
            },
          },
        },
      });
      // Verify tool_card created with running status
      const cards = flatBlocks(s).filter((b) => b.kind === 'tool_card' && b.name === 'update_plan');
      expect(cards.length).toBe(1);
      const card = cards[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(card.status).toBe('running');
      expect(card.summary).toBe('');
      expect(card.expanded).toBeUndefined();

      // Then fire need_plan_review
      s = dispatch(s, {
        type: 'EVENT',
        event: {
          type: 'need_plan_review',
          data: {
            plan: {
              name: 'Test Plan',
              description: 'A great plan',
              status: 'pending' as const,
              steps: [{ step: 'Do thing', status: 'pending' as const }],
            },
          },
        } as unknown as RenderEvent,
      });
      const doneCards = flatBlocks(s).filter(
        (b) => b.kind === 'tool_card' && b.name === 'update_plan',
      );
      expect(doneCards.length).toBe(1);
      const doneCard = doneCards[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(doneCard.status).toBe('done');
      expect(doneCard.summary).toContain('A great plan');
      expect(doneCard.summary).toContain('Steps:');
      expect(doneCard.summary).toContain('Do thing');
      expect(doneCard.expanded).toBe(true);
    });
    test('SHOW_MODEL_SELECTOR / HIDE_MODEL_SELECTOR', () => {
      let s = fresh();
      s = dispatch(s, { type: 'SHOW_MODEL_SELECTOR' });
      expect(s.showModelSelector).toBe(true);
      s = dispatch(s, { type: 'HIDE_MODEL_SELECTOR' });
      expect(s.showModelSelector).toBe(false);
    });
    test('SHOW_PERMISSION_SELECTOR / HIDE_PERMISSION_SELECTOR', () => {
      let s = fresh();
      s = dispatch(s, { type: 'SHOW_PERMISSION_SELECTOR' });
      expect(s.showPermissionSelector).toBe(true);
      expect(s.showModelSelector).toBe(false);
      s = dispatch(s, { type: 'HIDE_PERMISSION_SELECTOR' });
      expect(s.showPermissionSelector).toBe(false);
    });
    test('SHOW_EFFORT_SELECTOR and SHOW_THEME_SELECTOR keep one selector active', () => {
      let s = fresh();
      s = dispatch(s, { type: 'SHOW_EFFORT_SELECTOR' });
      expect(s.showEffortSelector).toBe(true);
      s = dispatch(s, { type: 'SHOW_THEME_SELECTOR' });
      expect(s.showThemeSelector).toBe(true);
      expect(s.showEffortSelector).toBe(false);
      s = dispatch(s, { type: 'HIDE_THEME_SELECTOR' });
      expect(s.showThemeSelector).toBe(false);
    });
    test('SELECT_MODEL sets modelName and closes selector', () => {
      let s = fresh();
      s = {
        ...s,
        showModelSelector: true,
        status: {
          ...s.status,
          contextSnapshot: {
            estimate: {
              systemTokens: 1,
              toolSchemaTokens: 1,
              transcriptTokens: 1,
              summaryTokens: 0,
              dynamicRuntimeTokens: 0,
              framingTokens: 0,
              totalInputTokens: 3,
            },
            status: 'normal',
          },
        },
      };
      s = dispatch(s, { type: 'SELECT_MODEL', provider: 'openai', modelName: 'gpt-4o' });
      expect(s.status.modelName).toBe('gpt-4o');
      expect(s.status.modelProvider).toBe('openai');
      expect(s.status.contextSnapshot).toBeUndefined();
      expect(s.showModelSelector).toBe(false);
    });
    test('USER_MESSAGE appends user block', () => {
      let s = fresh();
      s = dispatch(s, { type: 'USER_MESSAGE', text: 'Hello, AI' });
      expect(flatBlocks(s)).toHaveLength(1);
      expect(flatBlocks(s)[0]!.kind).toBe('user');
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'Hello, AI',
      );
    });
    test('SET_SESSION_SERVICE_UNAVAILABLE blocks only the session service state', () => {
      let s = fresh();
      s = dispatch(s, { type: 'SET_SESSION_SERVICE_UNAVAILABLE', unavailable: true });
      expect(s.sessionServiceUnavailable).toBe(true);
      s = dispatch(s, { type: 'SET_SESSION_SERVICE_UNAVAILABLE', unavailable: false });
      expect(s.sessionServiceUnavailable).toBe(false);
    });
    test('NEW_SESSION clears blocks, resets state, increments sessionKey', () => {
      let s = fresh();
      s = {
        ...s,
        turns: [{ blocks: [{ id: 1, kind: 'text', content: 'old' }] }],
        status: {
          ...s.status,
          phase: 'planning',
          contextSnapshot: {
            estimate: {
              systemTokens: 4_000,
              toolSchemaTokens: 5_800,
              transcriptTokens: 0,
              summaryTokens: 0,
              dynamicRuntimeTokens: 0,
              framingTokens: 0,
              totalInputTokens: 9_800,
            },
            status: 'normal',
          },
          pendingPlan: {
            name: 'Outgoing draft',
            description: 'Must stay with the outgoing session',
            status: 'pending',
            steps: [],
          },
        },
        ctrlCPressed: true,
        interrupt: { kind: 'approval', blockId: 1 },
        showHelp: true,
        showModelSelector: true,
        exitRequested: true,
      };
      s = dispatch(s, { type: 'NEW_SESSION', threadId: 'new-session-1' });
      expect(flatBlocks(s)).toHaveLength(0);
      expect(s.interrupt).toBeNull();
      expect(s.ctrlCPressed).toBe(false);
      expect(s.exitRequested).toBe(false);
      expect(s.showHelp).toBe(false);
      expect(s.showModelSelector).toBe(false);
      expect(s.sessionKey).toBe(1);
      expect(s.activeSessionId).toBe('new-session-1');
      expect(s.sessions).toHaveLength(1);
      expect(s.sessions[0]!.threadId).toBe('new-session-1');
      expect(s.sessions[0]!.active).toBe(true);
      expect(s.status.phase).toBe('building');
      expect(s.status.pendingPlan).toBeNull();
      expect(s.status.contextSnapshot).toBeUndefined();
      expect(s.sessions[0]!.status.phase).toBe('building');
      expect(s.sessions[0]!.status.pendingPlan).toBeNull();
    });
    test('SET_RUNNING resets ctrlCPressed and exitRequested', () => {
      let s = fresh();
      s = { ...s, ctrlCPressed: true, exitRequested: true };
      s = dispatch(s, { type: 'SET_RUNNING' });
      expect(s.ctrlCPressed).toBe(false);
      expect(s.exitRequested).toBe(false);
    });
    test('text blocks have streaming=true when state is running', () => {
      let s = fresh();
      s = { ...s, running: true };
      s = dispatch(s, textEvt('hello'));
      const b = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>;
      expect(b.streaming).toBe(true);
    });
    test('SET_IDLE marks streaming blocks as not streaming', () => {
      let s = fresh();
      s = { ...s, running: true };
      s = dispatch(s, textEvt('hello'));
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).streaming).toBe(true);
      s = { ...s, running: true }; // simulate mid-run
      s = dispatch(s, { type: 'SET_IDLE' });
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).streaming).toBe(false);
    });
    test('run.completed reconciles and finalizes the authoritative answer tail before idle', () => {
      let s = { ...fresh(), running: true };
      s = handleRuntimeEventAction(s, {
        type: 'model.responded',
        messageId: 'model-final',
        text: 'First paragraph.\n\nSecond paragraph.',
        toolCalls: [],
      });
      expect(flatBlocks(s).some((block) => block.kind === 'text' && block.streaming)).toBe(false);

      s = handleRuntimeEventAction(s, {
        type: 'run.completed',
        turnId: 'turn-final',
        output:
          'First paragraph.\n\nSecond paragraph.\n\nTAIL_MARKER must be visible before the prompt.',
      });

      const text = flatBlocks(s)
        .filter((block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text')
        .map((block) => block.content)
        .join('\n');
      expect(text).toContain('TAIL_MARKER must be visible before the prompt.');
      expect(flatBlocks(s).some((block) => block.kind === 'text' && block.streaming)).toBe(false);
    });
    test('SET_EXITED preserves streamed paragraph blocks already handed to Static', () => {
      let s = dispatch(fresh(), { type: 'SET_RUNNING' });
      s = handleRuntimeEventAction(s, { type: 'model.requested', requestId: 'stream-request' });
      s = handleRuntimeEventAction(s, {
        type: 'model.text_delta',
        text: 'STREAM_FIRST\n\n',
      });
      s = handleRuntimeEventAction(s, {
        type: 'model.text_delta',
        text: 'STREAM_FIRST\n\nSTREAM_MIDDLE\n\n',
      });
      s = handleRuntimeEventAction(s, {
        type: 'model.text_delta',
        text: 'STREAM_FIRST\n\nSTREAM_MIDDLE\n\nSTREAM_FINAL',
      });
      s = handleRuntimeEventAction(s, {
        type: 'model.responded',
        messageId: 'stream-response',
        text: 'STREAM_FIRST\n\nSTREAM_MIDDLE\n\nSTREAM_FINAL',
      });
      const beforeExit = flatBlocks(s).filter(
        (block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text',
      );

      s = dispatch(s, { type: 'SET_EXITED' });

      const afterExit = flatBlocks(s).filter(
        (block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text',
      );
      expect(afterExit.map((block) => block.id)).toEqual(beforeExit.map((block) => block.id));
      expect(afterExit.map((block) => block.content).join('')).toBe(
        'STREAM_FIRST\n\nSTREAM_MIDDLE\n\nSTREAM_FINAL',
      );
    });
    test('SET_EXITED sets exited flag', () => {
      let s = fresh();
      s = { ...s, running: true, runStartTime: Date.now() - 5000 };
      s = dispatch(s, { type: 'SET_EXITED' });
      expect(s.exited).toBe(true);
    });
    test('SET_EXITED does not add an exit summary block', () => {
      let s = fresh();
      s = { ...s, running: true };
      // Add a file_change block with 2 changes
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'file_change', data: { path: 'a.ts', kind: 'add' } },
      });
      s = dispatch(s, {
        type: 'EVENT',
        event: { type: 'file_change', data: { path: 'b.ts', kind: 'edit' } },
      });
      s = dispatch(s, { type: 'SET_EXITED' });
      // No extra text block appended — only the original file_change blocks remain
      const last = flatBlocks(s).at(-1);
      expect(last!.kind).toBe('file_change');
    });
    test('SET_EXITED + SET_IDLE preserves content blocks', () => {
      let s = fresh();
      s = { ...s, running: true };
      s = dispatch(s, textEvt('AI response'));
      s = dispatch(s, { type: 'SET_EXITED' });
      s = dispatch(s, { type: 'SET_IDLE' });
      // All content blocks preserved, no exit summary appended
      expect(flatBlocks(s)).toHaveLength(1);
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'AI response',
      );
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).streaming).toBe(false);
      expect(s.exited).toBe(false);
      expect(s.running).toBe(false);
    });
    test('consecutive streaming text events replace last block instead of appending', () => {
      let s = fresh();
      s = { ...s, running: true };
      s = dispatch(s, textEvt('Hello'));
      s = dispatch(s, textEvt('Hello, world'));
      s = dispatch(s, textEvt('Hello, world!'));
      // Only 1 block — each event replaced the previous streaming block
      expect(flatBlocks(s)).toHaveLength(1);
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'Hello, world!',
      );
    });
    test('text after an active phase block is absorbed as caption, not a new block (ADR-0030)', () => {
      let s = fresh();
      s = { ...s, running: true };
      // First text: no active Thought → normal text block
      s = dispatch(s, textEvt('Hello'));
      // Exploration tool opens a phase block
      s = dispatch(s, tcEvt('c1', 'read_file'));
      // Next text is absorbed into the active phase block (pending caption)
      s = dispatch(s, textEvt('After tool'));
      expect(flatBlocks(s)).toHaveLength(2);
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe('Hello');
      const summary = flatBlocks(s)[1] as Extract<OutputBlock, { kind: 'tool_summary' }>;
      expect(summary.kind).toBe('tool_summary');
      expect(summary.pendingCaption).toBe('After tool');
    });
    test('SET_EXITED then SET_IDLE clears exited flag', () => {
      let s = fresh();
      s = { ...s, running: true };
      s = dispatch(s, { type: 'SET_EXITED' });
      expect(s.exited).toBe(true);
      s = dispatch(s, { type: 'SET_IDLE' });
      expect(s.exited).toBe(false);
    });
  });

  describe('immutability', () => {
    test('reducer returns new state object', () => {
      const s = fresh();
      const next = dispatch(s, textEvt('hello'));
      expect(next).not.toBe(s);
    });
    test('blocks array is not mutated', () => {
      let s = fresh();
      s = dispatch(s, textEvt('a'));
      const arr1 = flatBlocks(s);
      s = dispatch(s, textEvt('b'));
      expect(flatBlocks(s)).not.toBe(arr1);
      expect(arr1).toHaveLength(1);
    });
  });

  describe('createInitialState', () => {
    test('returns fresh state with empty blocks and no interrupt', () => {
      const s = createInitialState();
      expect(flatBlocks(s)).toEqual([]);
      expect(s.interrupt).toBeNull();
      expect(s.status.modelName).toBe('deepseek-v4');
    });
  });

  describe('LOAD_SESSION', () => {
    test('nextBlockId advances past loaded blocks to prevent ID collisions', () => {
      const blocks: OutputBlock[] = [
        { id: 5, kind: 'text', content: 'old' },
        { id: 10, kind: 'user', content: 'old user' },
      ];
      let s = fresh();
      // Create some blocks first to advance nextBlockId
      s = dispatch(s, textEvt('pre-load block'));
      expect(flatBlocks(s).at(-1)!.id).toBe(1);
      expect(s.nextBlockId).toBe(2);

      s = dispatch(s, {
        type: 'LOAD_SESSION',
        threadId: 't1',
        blocks,
        interrupt: null,
        modelProvider: 'test',
        modelName: 'deepseek-v4',
        thinkingLevel: null,
      });
      // nextBlockId must be > max loaded block ID to avoid collisions
      // when new tool_call blocks reuse IDs already present in loaded turns.
      expect(s.nextBlockId).toBe(11);
      // Loaded blocks have their original IDs
      expect(flatBlocks(s).map((b) => b.id)).toEqual([5, 10]);
      // New block gets an ID beyond all registered blocks
      s = dispatch(s, textEvt('new block after load'));
      expect(s.nextBlockId).toBe(12);
      expect(flatBlocks(s).at(-1)!.id).toBe(11);
    });

    test('preserves interrupt when loading approval block', () => {
      const interrupt: InterruptState = { kind: 'approval', blockId: 42 };
      const blocks: OutputBlock[] = [{ id: 42, kind: 'approval', approval: approval() }];
      const s = dispatch(fresh(), {
        type: 'LOAD_SESSION',
        threadId: 't1',
        blocks,
        interrupt,
        modelProvider: 'test',
        modelName: 'deepseek-v4',
        thinkingLevel: null,
      });
      expect(s.interrupt).toEqual(interrupt);
      expect(flatBlocks(s)[0]!.kind).toBe('approval');
    });

    test('sets activeSessionId and increments sessionKey', () => {
      let s = fresh();
      expect(s.activeSessionId).toBeNull();
      expect(s.sessionKey).toBe(0);
      s = dispatch(s, {
        type: 'LOAD_SESSION',
        threadId: 't1',
        blocks: [{ id: 1, kind: 'text', content: 'hello' }],
        interrupt: null,
        modelProvider: '',
        modelName: '',
        thinkingLevel: null,
      });
      expect(s.activeSessionId).toBe('t1');
      expect(s.sessionKey).toBe(1);
    });

    test('clears ephemeral compaction progress so the restored prompt is usable', () => {
      let s: TuiState = {
        ...fresh(),
        compactionProgress: { phase: 'summarizing', source: 'automatic' },
      };

      s = dispatch(s, {
        type: 'LOAD_SESSION',
        threadId: 't1',
        blocks: [{ id: 1, kind: 'text', content: 'restored' }],
        interrupt: null,
        modelProvider: '',
        modelName: '',
        thinkingLevel: null,
      });

      expect(s.compactionProgress).toBeUndefined();
    });

    test('saves outgoing session turns before overwriting', () => {
      let s: TuiState = {
        ...fresh(),
        activeSessionId: 'old',
        sessions: [
          {
            threadId: 'old',
            name: 'Old',
            workspace: '/tmp',
            active: true,
            running: false,
            pendingInterrupt: false,
            interrupt: null,
            plan: null,
            status: fresh().status,
            turns: [],
          },
        ],
        turns: [{ blocks: [{ id: 1, kind: 'text' as const, content: 'old session content' }] }],
      };
      s = dispatch(s, {
        type: 'LOAD_SESSION',
        threadId: 'new',
        blocks: [{ id: 10, kind: 'text', content: 'new session content' }],
        interrupt: null,
        modelProvider: '',
        modelName: '',
        thinkingLevel: null,
      });
      // old session's turns should be saved
      const savedOld = s.sessions.find((sp) => sp.threadId === 'old')!;
      expect(savedOld.turns[0]!.blocks[0]!.id).toBe(1);
      expect(
        (savedOld.turns[0]!.blocks[0]! as Extract<OutputBlock, { kind: 'text' }>).content,
      ).toBe('old session content');
      expect(savedOld.active).toBe(false);
      // new session should be active with loaded blocks
      expect(s.activeSessionId).toBe('new');
      expect(flatBlocks(s)[0]!.id).toBe(10);
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'new session content',
      );
    });

    test('full chain: load A then load B preserves both sessions', () => {
      let s: TuiState = {
        ...fresh(),
        activeSessionId: 'initial',
        sessions: [
          {
            threadId: 'initial',
            name: 'Init',
            workspace: '/tmp',
            active: true,
            running: false,
            pendingInterrupt: false,
            interrupt: null,
            plan: null,
            status: fresh().status,
            turns: [],
          },
          {
            threadId: 'a',
            name: 'A',
            workspace: '/tmp',
            active: false,
            running: false,
            pendingInterrupt: false,
            interrupt: null,
            plan: null,
            status: fresh().status,
            turns: [],
          },
          {
            threadId: 'b',
            name: 'B',
            workspace: '/tmp',
            active: false,
            running: false,
            pendingInterrupt: false,
            interrupt: null,
            plan: null,
            status: fresh().status,
            turns: [],
          },
        ],
        turns: [{ blocks: [{ id: 1, kind: 'text' as const, content: 'initial content' }] }],
      };

      // Step 1: Load session A
      s = dispatch(s, {
        type: 'LOAD_SESSION',
        threadId: 'a',
        blocks: [{ id: 10, kind: 'text', content: 'A content' }],
        interrupt: null,
        modelProvider: '',
        modelName: 'model-a',
        thinkingLevel: null,
      });
      expect(s.activeSessionId).toBe('a');
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'A content',
      );
      expect(s.status.modelName).toBe('model-a');
      // initial session's turns saved
      const savedInitial = s.sessions.find((sp) => sp.threadId === 'initial')!;
      expect(
        (savedInitial.turns[0]!.blocks[0]! as Extract<OutputBlock, { kind: 'text' }>).content,
      ).toBe('initial content');

      // Step 2: Load session B — A's turns should be saved
      s = dispatch(s, {
        type: 'LOAD_SESSION',
        threadId: 'b',
        blocks: [{ id: 20, kind: 'text', content: 'B content' }],
        interrupt: null,
        modelProvider: '',
        modelName: 'model-b',
        thinkingLevel: null,
      });
      expect(s.activeSessionId).toBe('b');
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'B content',
      );
      expect(s.status.modelName).toBe('model-b');
      // A's turns should be saved
      const savedA = s.sessions.find((sp) => sp.threadId === 'a')!;
      expect((savedA.turns[0]!.blocks[0]! as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'A content',
      );
      expect(savedA.active).toBe(false);

      // Step 3: Load A again — B's turns should be saved, A's restored from DB
      s = dispatch(s, {
        type: 'LOAD_SESSION',
        threadId: 'a',
        blocks: [{ id: 10, kind: 'text', content: 'A content' }],
        interrupt: null,
        modelProvider: '',
        modelName: 'model-a',
        thinkingLevel: null,
      });
      expect(s.activeSessionId).toBe('a');
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'A content',
      );
      // B's turns should be saved
      const savedB = s.sessions.find((sp) => sp.threadId === 'b')!;
      expect((savedB.turns[0]!.blocks[0]! as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'B content',
      );
    });
  });

  describe('LOAD_SESSION_PENDING', () => {
    test('sets loadingSessionId while keeping blocks intact', () => {
      const s = dispatch(fresh(), textEvt('existing'));
      const next = dispatch(s, { type: 'LOAD_SESSION_PENDING', threadId: 't1' });
      expect(next.loadingSessionId).toBe('t1');
      expect(flatBlocks(next)).toEqual(flatBlocks(s)); // blocks unchanged
    });
  });

  // COMPACT_CONTEXT removed (compaction logic removed)

  describe('SHOW_SESSIONS / HIDE_SESSIONS + ESCAPE', () => {
    test('SHOW_SESSIONS sets showSessions=true', () => {
      const s = dispatch(fresh(), { type: 'SHOW_SESSIONS' });
      expect(s.showSessions).toBe(true);
    });
    test('HIDE_SESSIONS clears showSessions', () => {
      let s = fresh();
      s = { ...s, showSessions: true };
      s = dispatch(s, { type: 'HIDE_SESSIONS' });
      expect(s.showSessions).toBe(false);
    });
    test('ESCAPE when showSessions=true clears it', () => {
      let s = fresh();
      s = { ...s, showSessions: true };
      s = dispatch(s, { type: 'ESCAPE' });
      expect(s.showSessions).toBe(false);
    });
  });

  describe('SHOW_REWIND / HIDE_REWIND / SET_CHECKPOINTS + ESCAPE', () => {
    const ck1 = {
      snapshotId: 'snapshot-1',
      eventPosition: 1,
      createdAt: 1_704_067_200,
    };

    test('SHOW_REWIND sets showRewind=true', () => {
      const s = dispatch(fresh(), { type: 'SHOW_REWIND' });
      expect(s.showRewind).toBe(true);
    });
    test('HIDE_REWIND clears showRewind and checkpoints', () => {
      let s = fresh();
      s = { ...s, showRewind: true, checkpoints: [ck1] };
      s = dispatch(s, { type: 'HIDE_REWIND' });
      expect(s.showRewind).toBe(false);
      expect(s.checkpoints).toEqual([]);
    });
    test('SET_CHECKPOINTS stores entries', () => {
      const entries = [ck1, { ...ck1, snapshotId: 'snapshot-2' }];
      const s = dispatch(fresh(), { type: 'SET_CHECKPOINTS', checkpoints: entries });
      expect(s.checkpoints).toEqual(entries);
    });
    test('ESCAPE when showRewind clears it and checkpoints', () => {
      let s = fresh();
      s = { ...s, showRewind: true, checkpoints: [ck1] };
      s = dispatch(s, { type: 'ESCAPE' });
      expect(s.showRewind).toBe(false);
      expect(s.checkpoints).toEqual([]);
    });
  });

  describe('SHOW_MCP / HIDE_MCP + ESCAPE', () => {
    test('SHOW_MCP sets showMcp=true', () => {
      const s = dispatch(fresh(), { type: 'SHOW_MCP' });
      expect(s.showMcp).toBe(true);
    });
    test('HIDE_MCP clears showMcp', () => {
      let s = fresh();
      s = { ...s, showMcp: true };
      s = dispatch(s, { type: 'HIDE_MCP' });
      expect(s.showMcp).toBe(false);
    });
    test('ESCAPE when showMcp clears it', () => {
      let s = fresh();
      s = { ...s, showMcp: true };
      s = dispatch(s, { type: 'ESCAPE' });
      expect(s.showMcp).toBe(false);
    });
  });

  describe('INJECT_MCP_PROMPT', () => {
    test('appends user block with formatted prompt string', () => {
      const s = dispatch(fresh(), {
        type: 'INJECT_MCP_PROMPT',
        server: 'github',
        promptName: 'create-issue',
      });
      expect(flatBlocks(s)).toHaveLength(1);
      expect(flatBlocks(s)[0]!.kind).toBe('user');
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'user' }>).content).toBe(
        '/mcp__github__create-issue',
      );
    });
  });

  describe('EXECUTE_REWIND', () => {
    test('closes the panel and schedules the selected rewind scope', () => {
      let s = fresh();
      s = { ...s, showRewind: true };
      s = dispatch(s, {
        type: 'EXECUTE_REWIND',
        checkpointId: 'ck1',
        scope: 'code_and_conversation',
      });
      expect(s.showRewind).toBe(false);
      expect(s.checkpoints).toEqual([]);
    });
  });

  describe('EVENT.error sessionError flag', () => {
    test('non-recoverable error sets sessionError=true', () => {
      const s = dispatch(fresh(), {
        type: 'EVENT',
        event: { type: 'error', data: { message: 'fatal error', recoverable: false } },
      });
      expect(s.sessionError).toBe(true);
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toContain(
        'Error: fatal error',
      );
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).isError).toBe(true);
    });
    test('recoverable error does NOT set sessionError', () => {
      const s = dispatch(fresh(), {
        type: 'EVENT',
        event: { type: 'error', data: { message: 'rate limit', recoverable: true } },
      });
      expect(s.sessionError).toBe(false);
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toContain(
        'Recoverable error: rate limit',
      );
    });
  });

  describe('LIST_SKILLS', () => {
    test('adds text block listing all skills', () => {
      const state: TuiState = {
        ...createInitialState(),
        skillManifests: [
          { name: 'tdd', description: 'Write tests', source: 'project', origin: '.kite-code' },
        ],
      };
      const next = eventReducer(state, { type: 'LIST_SKILLS' });
      const last = flatBlocks(next)[flatBlocks(next).length - 1]!;
      expect(last.kind).toBe('text');
      if (last.kind === 'text') expect(last.content).toContain('tdd');
    });

    test('shows no-skills message when manifests empty', () => {
      const state = createInitialState();
      const next = eventReducer(state, { type: 'LIST_SKILLS' });
      const last = flatBlocks(next)[flatBlocks(next).length - 1]!;
      expect(last.kind).toBe('text');
      if (last.kind === 'text') expect(last.content).toContain('No skills available');
    });
  });

  describe('SET_SKILL_MANIFESTS', () => {
    test('sets skillManifests in state', () => {
      const state = createInitialState();
      const manifests = [
        {
          name: 'tdd',
          description: 'Write tests',
          source: 'project' as const,
          origin: '.kite-code' as const,
        },
      ];
      const next = eventReducer(state, { type: 'SET_SKILL_MANIFESTS', manifests });
      expect(next.skillManifests).toEqual(manifests);
    });
  });

  describe('multi-session reducer actions', () => {
    const initialState = createInitialState();

    test('initial state has required multi-session fields', () => {
      expect(initialState.sessions).toEqual([]);
      expect(initialState.activeSessionId).toBeNull();
    });

    test('NEW_SESSION saves current blocks to outgoing snapshot', () => {
      const s: TuiState = {
        ...initialState,
        activeSessionId: 't1',
        sessions: [
          {
            threadId: 't1',
            name: 'Session 1',
            workspace: '/tmp',
            active: true,
            running: false,
            pendingInterrupt: false,
            interrupt: null,
            plan: null,
            status: initialState.status,
            turns: [],
          },
        ],
        turns: [{ blocks: [{ id: 1, kind: 'text', content: 'hello' }] }],
      };
      const next = eventReducer(s, { type: 'NEW_SESSION', threadId: 't2' });
      // Old session should have its blocks saved
      expect(next.sessions).toHaveLength(2);
      const oldSnap = next.sessions.find((sp) => sp.threadId === 't1')!;
      expect(oldSnap.turns[0]!.blocks).toHaveLength(1);
      expect((oldSnap.turns[0]!.blocks[0]! as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'hello',
      );
      expect(oldSnap.active).toBe(false);
      // New session should be active with empty blocks
      const newSnap = next.sessions.find((sp) => sp.threadId === 't2')!;
      expect(newSnap.active).toBe(true);
      expect(newSnap.turns).toEqual([]);
      expect(next.activeSessionId).toBe('t2');
      expect(flatBlocks(next)).toEqual([]);
    });

    test('SWITCH_SESSION saves current blocks and restores target', () => {
      const s: TuiState = {
        ...initialState,
        activeSessionId: 't1',
        sessions: [
          {
            threadId: 't1',
            name: 'S1',
            workspace: '/tmp',
            active: true,
            running: false,
            pendingInterrupt: false,
            interrupt: null,
            plan: null,
            status: initialState.status,
            turns: [{ blocks: [{ id: 1, kind: 'text', content: 'A' }] }],
          },
          {
            threadId: 't2',
            name: 'S2',
            workspace: '/tmp',
            active: false,
            running: false,
            pendingInterrupt: false,
            interrupt: null,
            plan: null,
            status: initialState.status,
            turns: [{ blocks: [{ id: 10, kind: 'text', content: 'B' }] }],
          },
        ],
        turns: [{ blocks: [{ id: 2, kind: 'text', content: 'latest in t1' }] }],
      };
      const next = eventReducer(s, { type: 'SWITCH_SESSION', threadId: 't2' });
      // t1 should have latest blocks saved
      const t1 = next.sessions.find((sp) => sp.threadId === 't1')!;
      expect(t1.turns[0]!.blocks).toHaveLength(1);
      expect((t1.turns[0]!.blocks[0]! as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'latest in t1',
      );
      expect(t1.active).toBe(false);
      // t2 should be active and its blocks restored
      const t2 = next.sessions.find((sp) => sp.threadId === 't2')!;
      expect(t2.active).toBe(true);
      expect(t2.turns[0]!.blocks).toHaveLength(1);
      expect((t2.turns[0]!.blocks[0]! as Extract<OutputBlock, { kind: 'text' }>).content).toBe('B');
      expect(next.activeSessionId).toBe('t2');
      expect(flatBlocks(next)).toEqual(t2.turns[0]!.blocks);
      expect(next.interrupt).toBeNull();
    });

    test('SWITCH_SESSION preserves off-screen queued tool metadata per session', () => {
      const snapshot = (
        threadId: string,
        active: boolean,
        turns: TuiState['turns'] = [],
      ): SessionSnapshot => ({
        threadId,
        name: threadId,
        workspace: '/tmp',
        active,
        running: true,
        pendingInterrupt: false,
        interrupt: null,
        plan: null,
        status: initialState.status,
        turns,
      });
      let state: TuiState = {
        ...fresh(),
        activeSessionId: 'a',
        sessions: [snapshot('a', true), snapshot('b', false)],
      };
      state = handleRuntimeEventAction(state, {
        type: 'tool.queued',
        toolCallId: 'read-a',
        name: 'read_file',
        args: { path: 'README.md' },
      });

      state = eventReducer(state, { type: 'SWITCH_SESSION', threadId: 'b' });
      state = eventReducer(state, { type: 'SWITCH_SESSION', threadId: 'a' });
      expect(state.pendingToolCalls['read-a']).toEqual({
        name: 'read_file',
        args: { path: 'README.md' },
      });

      state = handleRuntimeEventAction(state, {
        type: 'tool.started',
        toolCallId: 'read-a',
      });
      state = handleRuntimeEventAction(state, {
        type: 'tool.finished',
        toolCallId: 'read-a',
        name: 'read_file',
        result: {
          ok: true,
          command: '',
          exitCode: 0,
          stdout: 'content',
          stderr: '',
        },
      });
      expect(
        flatBlocks(state).some(
          (block) =>
            block.kind === 'tool_summary' && block.tools.some((tool) => tool.callId === 'read-a'),
        ),
      ).toBe(true);
    });

    test('SWITCH_SESSION to nonexistent session uses default empty blocks', () => {
      const s: TuiState = {
        ...initialState,
        activeSessionId: 't1',
        sessions: [
          {
            threadId: 't1',
            name: 'S1',
            workspace: '/tmp',
            active: true,
            running: false,
            pendingInterrupt: false,
            interrupt: null,
            plan: null,
            status: initialState.status,
            turns: [],
          },
        ],
      };
      const next = eventReducer(s, { type: 'SWITCH_SESSION', threadId: 'missing' });
      expect(flatBlocks(next)).toEqual([]);
      expect(next.activeSessionId).toBe('missing');
    });

    test('SESSION_INTERRUPT_PENDING sets pending flag on session', () => {
      const sessions: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
        {
          threadId: 'b',
          name: 'B',
          workspace: '/tmp',
          active: false,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
      ];
      const next = eventReducer(
        { ...initialState, sessions },
        { type: 'SESSION_INTERRUPT_PENDING', threadId: 'a' },
      );
      expect(next.sessions[0]!.pendingInterrupt).toBe(true);
      expect(next.sessions[1]!.pendingInterrupt).toBe(false);
    });

    test('SET_SESSIONS merges: preserves existing blocks and syncs activeSessionId', () => {
      // Simulate: state has session with blocks, SET_SESSIONS comes in with empty blocks
      const existing: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: { ...initialState.status, totalTokens: 100 },
          turns: [{ blocks: [{ id: 1, kind: 'text' as const, content: 'hello' }] }],
        },
      ];
      const incoming: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A (renamed)',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: { ...initialState.status, totalTokens: 0 },
          turns: [],
        },
      ];
      const state = { ...initialState, sessions: existing, activeSessionId: null };
      const next = eventReducer(state, { type: 'SET_SESSIONS', sessions: incoming });
      // Name/running from incoming, blocks/status preserved from existing, activeSessionId synced
      expect(next.sessions[0]!.name).toBe('A (renamed)');
      expect(next.sessions[0]!.turns[0]!.blocks).toEqual([
        { id: 1, kind: 'text', content: 'hello' },
      ]);
      expect(next.sessions[0]!.status.totalTokens).toBe(100);
      expect(next.activeSessionId).toBe('a'); // synced from incoming.active
    });

    test('SET_SESSIONS handles new session (no existing match)', () => {
      const incoming: SessionSnapshot[] = [
        {
          threadId: 'new',
          name: 'New',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
      ];
      const next = eventReducer(initialState, { type: 'SET_SESSIONS', sessions: incoming });
      expect(next.sessions[0]!.threadId).toBe('new');
      expect(next.activeSessionId).toBe('new');
    });

    test('SWITCH_SESSION preserves blocks on outgoing session and restores from incoming', () => {
      const sessions: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: { ...initialState.status, totalTokens: 100 },
          turns: [{ blocks: [{ id: 1, kind: 'text' as const, content: 'session A content' }] }],
        },
        {
          threadId: 'b',
          name: 'B',
          workspace: '/tmp',
          active: false,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: { ...initialState.status, totalTokens: 200 },
          turns: [{ blocks: [{ id: 1, kind: 'text' as const, content: 'session B content' }] }],
        },
      ];

      let state: TuiState = {
        ...initialState,
        sessions,
        activeSessionId: 'a',
        turns: [{ blocks: [{ id: 2, kind: 'text' as const, content: 'updated A content' }] }],
      };

      // Simulate SWITCH_SESSION to "b"
      const newSessions = state.sessions.map((s) =>
        s.threadId === state.activeSessionId
          ? { ...s, turns: state.turns, status: state.status, active: false }
          : s.threadId === 'b'
            ? { ...s, active: true }
            : s,
      );
      const target = newSessions.find((s) => s.threadId === 'b')!;

      state = {
        ...state,
        sessions: newSessions,
        activeSessionId: 'b',
        turns: target.turns,
        status: target.status,
        interrupt: null,
      };

      // Verify A's blocks were saved
      const savedA = state.sessions.find((s) => s.threadId === 'a')!;
      expect(savedA.turns[0]!.blocks).toEqual([
        { id: 2, kind: 'text', content: 'updated A content' },
      ] as OutputBlock[]);
      expect(savedA.active).toBe(false);

      // Verify B's blocks were restored
      expect(flatBlocks(state)).toEqual([
        { id: 1, kind: 'text', content: 'session B content' },
      ] as OutputBlock[]);
      expect(state.activeSessionId).toBe('b');
      expect(state.status.totalTokens).toBe(200);
    });

    test('full chain: NEW_SESSION saves blocks → SET_SESSIONS preserves → SWITCH_SESSION restores', () => {
      // Setup: session A is active with runtime blocks in flatBlocks(state)
      let state: TuiState = {
        ...initialState,
        sessions: [
          {
            threadId: 'a',
            name: 'A',
            workspace: '/tmp',
            active: true,
            running: false,
            pendingInterrupt: false,
            interrupt: null,
            plan: null,
            status: { ...initialState.status, totalTokens: 100 },
            turns: [],
          },
        ],
        activeSessionId: 'a',
        turns: [
          {
            blocks: [
              { id: 1, kind: 'user' as const, content: 'Hello' },
              { id: 2, kind: 'text' as const, content: 'Hi there!' },
            ],
          },
        ],
      };

      // Step 1: NEW_SESSION — should save session A's blocks
      state = eventReducer(state, { type: 'NEW_SESSION', threadId: 'b' });
      expect(state.sessions.length).toBe(2);
      expect(state.sessions[0]!.threadId).toBe('a');
      expect(state.sessions[0]!.turns[0]!.blocks.length).toBe(2); // blocks saved
      expect((state.sessions[0]!.turns[0]!.blocks[0]! as { content: string }).content).toBe(
        'Hello',
      );
      expect(state.sessions[0]!.active).toBe(false);
      expect(state.sessions[1]!.threadId).toBe('b');
      expect(state.sessions[1]!.active).toBe(true);
      expect(state.activeSessionId).toBe('b');

      // Step 2: SET_SESSIONS from SessionManager.getSnapshot() (blocks are always [])
      // This simulates what happens after dispatchSessionLoad calls SET_SESSIONS
      const runtimeSnapshots: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A',
          workspace: '/tmp',
          active: false,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
        {
          threadId: 'b',
          name: 'B',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
      ];
      state = eventReducer(state, { type: 'SET_SESSIONS', sessions: runtimeSnapshots });
      // Merge must preserve blocks from step 1
      expect(state.sessions[0]!.turns[0]!.blocks.length).toBe(2); // preserved!
      expect((state.sessions[0]!.turns[0]!.blocks[0]! as { content: string }).content).toBe(
        'Hello',
      );
      expect(state.sessions[1]!.turns.length).toBe(0); // new session, no turns
      expect(state.activeSessionId).toBe('b'); // synced from runtime

      // Step 3: Add some blocks to session B's runtime (simulating agent response)
      state = {
        ...state,
        turns: [
          {
            blocks: [
              { id: 3, kind: 'user' as const, content: 'Msg in B' },
              { id: 4, kind: 'text' as const, content: 'Reply in B' },
            ],
          },
        ],
      };

      // Step 4: SWITCH_SESSION back to A — should save B's blocks and restore A's
      state = eventReducer(state, { type: 'SWITCH_SESSION', threadId: 'a' });
      expect(state.activeSessionId).toBe('a');
      // A's blocks restored
      expect(flatBlocks(state).length).toBe(2);
      expect((flatBlocks(state)[0] as { content: string }).content).toBe('Hello');
      expect((flatBlocks(state)[1] as { content: string }).content).toBe('Hi there!');
      // B's blocks saved to snapshot
      expect(state.sessions[1]!.turns[0]!.blocks.length).toBe(2);
      expect((state.sessions[1]!.turns[0]!.blocks[0]! as { content: string }).content).toBe(
        'Msg in B',
      );
    });

    test('SESSION_INTERRUPT_PENDING sets flag on correct session', () => {
      const sessions: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
        {
          threadId: 'b',
          name: 'B',
          workspace: '/tmp',
          active: false,
          running: true,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
      ];

      let state = { ...initialState, sessions, activeSessionId: 'a' };

      // Simulate SESSION_INTERRUPT_PENDING for "b"
      state = {
        ...state,
        sessions: state.sessions.map((s) =>
          s.threadId === 'b' ? { ...s, pendingInterrupt: true } : s,
        ),
      };

      const a = state.sessions.find((s) => s.threadId === 'a')!;
      const b = state.sessions.find((s) => s.threadId === 'b')!;
      expect(a.pendingInterrupt).toBe(false);
      expect(b.pendingInterrupt).toBe(true);
    });

    test('SET_SESSIONS with a new session (not in existing) adds it alongside existing sessions', () => {
      const existing: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
      ];
      const incoming: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A',
          workspace: '/tmp',
          active: false,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
        {
          threadId: 'b',
          name: 'B',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
      ];
      const state = { ...initialState, sessions: existing, activeSessionId: 'a' };
      const next = eventReducer(state, { type: 'SET_SESSIONS', sessions: incoming });
      expect(next.sessions).toHaveLength(2);
      expect(next.sessions[0]!.threadId).toBe('a');
      expect(next.sessions[1]!.threadId).toBe('b');
      expect(next.activeSessionId).toBe('b');
    });

    test('SET_SESSIONS when no incoming session is active preserves existing activeSessionId', () => {
      const existing: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A',
          workspace: '/tmp',
          active: true,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
      ];
      const incoming: SessionSnapshot[] = [
        {
          threadId: 'a',
          name: 'A',
          workspace: '/tmp',
          active: false,
          running: false,
          pendingInterrupt: false,
          interrupt: null,
          plan: null,
          status: initialState.status,
          turns: [],
        },
      ];
      const state = { ...initialState, sessions: existing, activeSessionId: 'a' };
      const next = eventReducer(state, { type: 'SET_SESSIONS', sessions: incoming });
      expect(next.activeSessionId).toBe('a');
    });
  });

  describe('EVENT.subagent_*', () => {
    function saStart(
      id: string,
      role: 'explore' | 'plan' | 'code' | 'review',
      task: string,
    ): LegacyRenderAction {
      return { type: 'EVENT', event: { type: 'subagent_start', data: { id, role, task } } };
    }
    function saStep(
      id: string,
      toolName: string,
      toolArgs: Record<string, unknown> = {},
    ): LegacyRenderAction {
      return { type: 'EVENT', event: { type: 'subagent_step', data: { id, toolName, toolArgs } } };
    }
    function saToolResult(id: string, toolName: string, ok: boolean): LegacyRenderAction {
      return { type: 'EVENT', event: { type: 'subagent_tool_result', data: { id, toolName, ok } } };
    }
    function saDone(
      id: string,
      summary: string,
      toolCallCount: number,
      durationMs: number,
    ): LegacyRenderAction {
      return {
        type: 'EVENT',
        event: {
          type: 'subagent_done',
          data: { id, summary, toolCallCount, durationMs },
        },
      };
    }
    function saError(id: string, error: string): LegacyRenderAction {
      return { type: 'EVENT', event: { type: 'subagent_error', data: { id, error } } };
    }

    test('subagent_start creates running subagent block', () => {
      const s = dispatch(fresh(), saStart('sub-1', 'explore', 'find usages'));
      expect(flatBlocks(s)).toHaveLength(1);
      const b = flatBlocks(s)[0]!;
      expect(b.kind).toBe('subagent');
      if (b.kind !== 'subagent') throw new Error('unexpected kind');
      expect(b.subagentId).toBe('sub-1');
      expect(b.role).toBe('explore');
      expect(b.task).toBe('find usages');
      expect(b.status).toBe('running');
      expect(b.steps).toEqual([]);
      expect(b.toolCallCount).toBe(0);
    });

    test('subagent_step appends step to matching running block', () => {
      let s = dispatch(fresh(), saStart('sub-1', 'code', 'fix bug'));
      s = dispatch(s, saStep('sub-1', 'read_file', { path: 'a.ts' }));
      s = dispatch(s, saStep('sub-1', 'edit_file', { path: 'a.ts' }));
      const b = flatBlocks(s)[0]!;
      if (b.kind !== 'subagent') throw new Error('unexpected kind');
      expect(b.steps).toHaveLength(2);
      expect(b.steps[0]!.toolName).toBe('read_file');
      expect(b.steps[0]!.toolArgs).toEqual({ path: 'a.ts' });
      expect(b.steps[1]!.toolName).toBe('edit_file');
    });

    test('subagent_step does not affect non-matching subagent blocks', () => {
      let s = dispatch(fresh(), saStart('sub-1', 'code', 'fix'));
      s = dispatch(s, saStart('sub-2', 'review', 'review'));
      s = dispatch(s, saStep('sub-1', 'read_file'));
      const b1 = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'subagent' }>;
      const b2 = flatBlocks(s)[1] as Extract<OutputBlock, { kind: 'subagent' }>;
      expect(b1.steps).toHaveLength(1);
      expect(b2.steps).toHaveLength(0);
    });

    test('subagent_tool_result marks matching step by toolName (reverse scan)', () => {
      let s = dispatch(fresh(), saStart('sub-1', 'code', 'fix'));
      s = dispatch(s, saStep('sub-1', 'read_file', { path: 'a.ts' }));
      s = dispatch(s, saStep('sub-1', 'edit_file', { path: 'a.ts' }));
      s = dispatch(s, saToolResult('sub-1', 'read_file', true));
      const b = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'subagent' }>;
      expect(b.steps[0]!.ok).toBe(true); // matched by toolName (reverse scan)
      expect(b.steps[1]!.ok).toBeUndefined(); // not yet resolved
      // second tool_result marks edit_file
      s = dispatch(s, saToolResult('sub-1', 'edit_file', false));
      const b2 = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'subagent' }>;
      expect(b2.steps[0]!.ok).toBe(true); // read_file still ok
      expect(b2.steps[1]!.ok).toBe(false); // edit_file marked
    });

    test('subagent_tool_result updates last step ok', () => {
      let s = dispatch(fresh(), saStart('sub-1', 'explore', 'search'));
      s = dispatch(s, saStep('sub-1', 'read_file'));
      s = dispatch(s, saToolResult('sub-1', 'read_file', true));
      const b = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'subagent' }>;
      expect(b.steps[0]!.ok).toBe(true);
    });

    test('subagent_tool_result handles out-of-order results (reverse scan)', () => {
      // Multiple steps with same toolName — result marks the last matching one
      let s = dispatch(fresh(), saStart('sub-2', 'code', 'multi-read'));
      s = dispatch(s, saStep('sub-2', 'read_file'));
      s = dispatch(s, saStep('sub-2', 'write_file'));
      s = dispatch(s, saStep('sub-2', 'read_file'));
      // Out of order: second read_file result arrives before first
      s = dispatch(s, saToolResult('sub-2', 'read_file', false));
      const b = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'subagent' }>;
      expect(b.steps[0]!.ok).toBeUndefined(); // first read_file not marked
      expect(b.steps[2]!.ok).toBe(false); // last read_file marked (reverse scan)
      // Now first read_file result arrives
      s = dispatch(s, saToolResult('sub-2', 'read_file', true));
      const b2 = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'subagent' }>;
      expect(b2.steps[0]!.ok).toBe(true); // first read_file now marked
      expect(b2.steps[2]!.ok).toBe(false); // last read_file still false
    });

    test('subagent_done updates running block to done', () => {
      let s = dispatch(fresh(), saStart('sub-1', 'review', 'review PR'));
      s = dispatch(s, saDone('sub-1', 'No issues found', 3, 2500));
      const b = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'subagent' }>;
      expect(b.status).toBe('done');
      expect(b.summary).toBe('No issues found');
      expect(b.toolCallCount).toBe(3);
      expect(b.durationMs).toBe(2500);
    });

    test('subagent_error updates running block to error, preserves steps', () => {
      let s = dispatch(fresh(), saStart('sub-1', 'code', 'impl'));
      s = dispatch(s, saError('sub-1', 'timeout'));
      const b = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'subagent' }>;
      expect(b.status).toBe('error');
      expect(b.summary).toBe('timeout');
      expect(b.expanded).toBe(false);
    });

    test('subagent events interleave correctly with other block types', () => {
      let s = fresh();
      s = dispatch(s, textEvt('start working'));
      s = dispatch(s, saStart('sub-1', 'explore', 'search'));
      s = dispatch(s, saStep('sub-1', 'read_file'));
      s = dispatch(s, saToolResult('sub-1', 'read_file', true));
      s = dispatch(s, saDone('sub-1', 'found 3 files', 1, 800));
      s = dispatch(s, textEvt('done'));
      expect(flatBlocks(s)).toHaveLength(3); // text, subagent, text
      expect(flatBlocks(s)[0]!.kind).toBe('text');
      expect(flatBlocks(s)[1]!.kind).toBe('subagent');
      expect(flatBlocks(s)[2]!.kind).toBe('text');
    });

    test('subagent blocks get unique incrementing ids', () => {
      let s = fresh();
      s = dispatch(s, saStart('sub-1', 'explore', 'task1'));
      s = dispatch(s, saStart('sub-2', 'code', 'task2'));
      expect(flatBlocks(s)[0]!.id).toBeLessThan(flatBlocks(s)[1]!.id);
    });

    test('preserves the Runtime concurrency identity for sibling presentation', () => {
      let s = fresh();
      for (const [id, role] of [
        ['sub-1', 'explore'],
        ['sub-2', 'review'],
        ['sub-3', 'code'],
      ] as const) {
        s = handleRuntimeEventAction(s, {
          type: 'subagent.started',
          subagent: { id, role, task: id, concurrencyGroupId: 'batch-1' },
        });
      }
      const children = flatBlocks(s) as Array<Extract<OutputBlock, { kind: 'subagent' }>>;
      expect(children.map((child) => child.concurrencyGroupId)).toEqual([
        'batch-1',
        'batch-1',
        'batch-1',
      ]);
    });

    test('does not infer a group for starts without a Runtime batch identity', () => {
      let s = fresh();
      s = dispatch(s, saStart('sub-1', 'explore', 'task1'));
      s = dispatch(s, saStart('sub-2', 'review', 'task2'));
      const children = flatBlocks(s) as Array<Extract<OutputBlock, { kind: 'subagent' }>>;
      expect(children[0]!.concurrencyGroupId).toBeUndefined();
      expect(children[1]!.concurrencyGroupId).toBeUndefined();
    });
  });

  describe('RUNTIME_EVENT.subagent.*', () => {
    test('renders a RuntimeEvent subagent start without the legacy event path', () => {
      const state = dispatch(fresh(), {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'subagent.started',
          subagent: { id: 'runtime-subagent', role: 'explore', task: 'find runtime callers' },
        },
      });

      const block = flatBlocks(state)[0];
      expect(block?.kind).toBe('subagent');
      if (block?.kind !== 'subagent') throw new Error('expected subagent block');
      expect(block.subagentId).toBe('runtime-subagent');
      expect(block.task).toBe('find runtime callers');
    });

    test('projects every durable Sub-agent suspension without waiting for the active approval', () => {
      let state = handleRuntimeEventAction(fresh(), {
        type: 'subagent.started',
        subagent: { id: 'deferred-subagent', role: 'code', task: 'wait for approval' },
      });
      state = handleRuntimeEventAction(state, {
        type: 'subagent.step',
        subagent: {
          id: 'deferred-subagent',
          toolName: 'shell_execute',
          toolArgs: { command: 'pwd' },
        },
      });
      state = handleRuntimeEventAction(state, {
        type: 'subagent.suspended',
        toolCallId: 'task-deferred',
        snapshot: {
          subagentId: 'deferred-subagent',
          role: 'code',
          task: 'wait for approval',
          messages: [],
          toolCallCount: 1,
          steps: [],
          blockedTool: {
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
            toolCallId: 'nested-shell',
            toolName: 'shell_execute',
            args: { command: 'pwd' },
            command: 'pwd',
          },
        },
      });

      const suspended = flatBlocks(state)[0];
      expect(suspended).toMatchObject({
        kind: 'subagent',
        subagentId: 'deferred-subagent',
        status: 'suspended',
        approvalState: 'queued',
        parentToolCallId: 'task-deferred',
        awaitingApproval: true,
        approvingStepIndex: 0,
        steps: [{ status: 'awaiting_approval' }],
      });

      state = handleRuntimeEventAction(state, {
        type: 'subagent.step',
        subagent: {
          id: 'deferred-subagent',
          toolName: 'read_file',
          toolArgs: { path: 'README.md' },
        },
      });
      expect(flatBlocks(state)[0]).toMatchObject({
        status: 'running',
        approvalState: undefined,
        awaitingApproval: false,
      });
    });

    test('distinguishes queued, automatic, and human child approval phases', () => {
      let state = handleRuntimeEventAction(fresh(), {
        type: 'subagent.started',
        subagent: { id: 'approval-phases', role: 'review', task: 'inspect approval phases' },
      });
      state = handleRuntimeEventAction(state, {
        type: 'subagent.step',
        subagent: {
          id: 'approval-phases',
          toolName: 'shell_execute',
          toolArgs: { command: 'bun test' },
        },
      });
      state = handleRuntimeEventAction(state, {
        type: 'subagent.suspended',
        toolCallId: 'parent-task',
        snapshot: {
          subagentId: 'approval-phases',
          role: 'review',
          task: 'inspect approval phases',
          messages: [],
          toolCallCount: 1,
          steps: [],
          blockedTool: {
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
            toolCallId: 'child-shell',
            toolName: 'shell_execute',
            args: { command: 'bun test' },
            command: 'bun test',
          },
        },
      });
      expect(flatBlocks(state)[0]).toMatchObject({ approvalState: 'queued' });

      state = handleRuntimeEventAction(state, {
        type: 'auto_review.requested',
        reviewId: 'review-child',
        toolCallId: 'parent-task',
        toolName: 'shell_execute',
        reason: 'Automatic review required.',
        approval: approval({ subagentId: 'approval-phases', callId: 'child-shell' }),
      });
      expect(flatBlocks(state)[0]).toMatchObject({
        status: 'suspended',
        approvalState: 'auto_reviewing',
      });

      state = handleRuntimeEventAction(state, {
        type: 'auto_review.completed',
        reviewId: 'review-child',
        toolCallId: 'parent-task',
        result: {
          ok: true,
          approved: true,
          grant: 'approve_once',
          reason: 'safe',
          reviewerModelName: 'fixture',
          durationMs: 1,
        },
      });
      expect(flatBlocks(state)[0]).toMatchObject({
        status: 'running',
        approvalState: undefined,
        awaitingApproval: false,
        steps: [{ status: 'pending' }],
      });

      state = handleRuntimeEventAction(state, {
        type: 'subagent.suspended',
        toolCallId: 'parent-task',
        snapshot: {
          subagentId: 'approval-phases',
          role: 'review',
          task: 'inspect approval phases',
          messages: [],
          toolCallCount: 1,
          steps: [],
          blockedTool: {
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
            toolCallId: 'child-shell',
            toolName: 'shell_execute',
            args: { command: 'bun test' },
            command: 'bun test',
          },
        },
      });
      state = handleRuntimeEventAction(state, {
        type: 'approval.requested',
        interactionId: 'human-child',
        toolCallId: 'parent-task',
        approval: approval({ subagentId: 'approval-phases', callId: 'child-shell' }),
      });
      expect(flatBlocks(state)[0]).toMatchObject({
        status: 'suspended',
        approvalState: 'awaiting_user',
      });
    });

    test('settles a suspended child when automatic review explicitly rejects it', () => {
      let state = handleRuntimeEventAction(fresh(), {
        type: 'subagent.started',
        subagent: {
          id: 'auto-rejected-child',
          role: 'review',
          task: 'run checks',
          concurrencyGroupId: 'batch-auto-reject',
        },
      });
      state = handleRuntimeEventAction(state, {
        type: 'subagent.step',
        subagent: {
          id: 'auto-rejected-child',
          toolName: 'shell_execute',
          toolArgs: { command: 'bun test' },
        },
      });
      state = handleRuntimeEventAction(state, {
        type: 'subagent.suspended',
        toolCallId: 'parent-auto-rejected',
        snapshot: {
          subagentId: 'auto-rejected-child',
          role: 'review',
          task: 'run checks',
          messages: [],
          toolCallCount: 1,
          steps: [],
          blockedTool: {
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
            toolCallId: 'child-shell',
            toolName: 'shell_execute',
            args: { command: 'bun test' },
            command: 'bun test',
          },
        },
      });
      state = handleRuntimeEventAction(state, {
        type: 'auto_review.completed',
        reviewId: 'review-rejected-child',
        toolCallId: 'parent-auto-rejected',
        result: {
          ok: true,
          approved: false,
          reason: 'Command is outside the child policy.',
          reviewerModelName: 'fixture',
          durationMs: 1,
        },
      });

      expect(flatBlocks(state)[0]).toMatchObject({
        kind: 'subagent',
        status: 'error',
        approvalState: undefined,
        awaitingApproval: false,
        error: 'Command is outside the child policy.',
      });
    });

    test('settles every live child when a resource failure aborts the turn', () => {
      let state = fresh();
      for (const [id, role] of [
        ['resource-explore', 'explore'],
        ['resource-review', 'review'],
      ] as const) {
        state = handleRuntimeEventAction(state, {
          type: 'subagent.started',
          subagent: {
            id,
            role,
            task: `run ${role} checks`,
            concurrencyGroupId: 'batch-resource-failure',
          },
        });
      }
      state = handleRuntimeEventAction(state, {
        type: 'run.error',
        message: 'Subagent concurrency budget exhausted.',
        recoverable: false,
      });
      state = handleRuntimeEventAction(state, {
        type: 'turn.aborted',
        turnId: 'turn-resource-failure',
        reason: 'Subagent concurrency budget exhausted.',
        cause: 'error',
      });

      const children = flatBlocks(state).filter(
        (block): block is Extract<OutputBlock, { kind: 'subagent' }> => block.kind === 'subagent',
      );
      expect(children).toHaveLength(2);
      expect(children.every((child) => child.status === 'error')).toBe(true);
      expect(
        children.every((child) => child.error === 'Subagent concurrency budget exhausted.'),
      ).toBe(true);
    });
  });

  describe('RUNTIME_EVENT message-list pipeline', () => {
    test('keeps queued calls off-screen and drops a pre-start cancellation without a block', () => {
      let state = handleRuntimeEventAction(fresh(), {
        type: 'tool.queued',
        toolCallId: 'future-read',
        name: 'read_file',
        args: { path: 'README.md' },
      });

      expect(flatBlocks(state)).toHaveLength(0);
      expect(state.pendingToolCalls['future-read']).toEqual({
        name: 'read_file',
        args: { path: 'README.md' },
      });

      state = handleRuntimeEventAction(state, {
        type: 'tool.cancelled',
        toolCallId: 'future-read',
        reason: 'Earlier sibling opened an interaction.',
      });

      expect(flatBlocks(state)).toHaveLength(0);
      expect(state.pendingToolCalls['future-read']).toBeUndefined();
    });

    test('renders a successor response after a cancelled turn without losing the prompt', () => {
      let state = dispatch(fresh(), { type: 'SET_RUNNING' });
      state = dispatch(state, { type: 'USER_MESSAGE', text: '原始请求' });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: { type: 'user.message_appended', messageId: 'user-1', content: '原始请求' },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.queued',
          toolCallId: 'shell-1',
          name: 'shell_execute',
          args: { command: 'curl' },
        },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: { type: 'tool.cancelled', toolCallId: 'shell-1', reason: 'Cancelled by user.' },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'turn.aborted',
          turnId: 'turn-1',
          reason: 'Cancelled by user.',
          cause: 'user',
        },
      });
      state = dispatch(state, { type: 'USER_MESSAGE', text: '请继续' });
      state = dispatch(state, { type: 'SET_RUNNING' });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: { type: 'user.message_appended', messageId: 'user-2', content: '请继续' },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: { type: 'turn.started', turnId: 'turn-2' },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.requested', requestId: 'request-2' },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: { type: 'model.responded', messageId: 'answer-2', text: '继续完成' },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: { type: 'run.completed', turnId: 'turn-2', output: '继续完成' },
      });
      state = dispatch(state, { type: 'SET_IDLE' });

      expect(flatBlocks(state)).toContainEqual(
        expect.objectContaining({ kind: 'user', content: '请继续' }),
      );
      expect(flatBlocks(state)).toContainEqual(
        expect.objectContaining({ kind: 'text', content: '继续完成' }),
      );
      expect(state.turns).toHaveLength(2);
      expect(state.turns[0]!.blocks[0]).toMatchObject({ kind: 'user', content: '原始请求' });
      expect(state.turns[1]!.blocks[0]).toMatchObject({ kind: 'user', content: '请继续' });
      expect(state.running).toBe(false);
    });
    test('does not duplicate an optimistically rendered prompt when its durable event arrives', () => {
      let state = dispatch(fresh(), { type: 'SET_RUNNING' });
      state = dispatch(state, { type: 'USER_MESSAGE', text: '继续测试' });
      // Runtime diagnostics can arrive between the optimistic prompt and its
      // durable user.message_appended event. Deduplication must cover the
      // active turn rather than only its final block.
      state = dispatch(state, { type: 'LOCAL_TEXT', text: 'Session logging mode: off.' });

      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'user.message_appended',
          messageId: 'u-continue',
          content: '继续测试',
        },
      });

      const userBlocks = flatBlocks(state).filter((block) => block.kind === 'user');
      expect(userBlocks).toHaveLength(1);
      expect(userBlocks[0]).toMatchObject({ kind: 'user', content: '继续测试' });
    });
    test('replays identical consecutive prompts as distinct turns', () => {
      const events: import('../src/core/runtime/events').RuntimeEvent[] = [
        { type: 'user.message_appended', messageId: 'u-1', content: '继续' },
        { type: 'turn.started', turnId: 'turn-1' },
        { type: 'model.requested', requestId: 'request-1' },
        { type: 'model.responded', messageId: 'm-1', text: '第一轮回答' },
        { type: 'run.completed', turnId: 'turn-1', output: '第一轮回答' },
        { type: 'user.message_appended', messageId: 'u-2', content: '继续' },
        { type: 'turn.started', turnId: 'turn-2' },
        { type: 'model.requested', requestId: 'request-2' },
        { type: 'model.responded', messageId: 'm-2', text: '第二轮回答' },
        { type: 'run.completed', turnId: 'turn-2', output: '第二轮回答' },
      ];

      const state = events.reduce(handleRuntimeEventAction, fresh());

      expect(state.turns).toHaveLength(2);
      expect(state.turns.map((turn) => turn.blocks[0])).toEqual([
        expect.objectContaining({ kind: 'user', content: '继续' }),
        expect.objectContaining({ kind: 'user', content: '继续' }),
      ]);
      expect(state.turns[0]!.blocks).toContainEqual(
        expect.objectContaining({ kind: 'text', content: '第一轮回答' }),
      );
      expect(state.turns[1]!.blocks).toContainEqual(
        expect.objectContaining({ kind: 'text', content: '第二轮回答' }),
      );
    });
    test('retains every structured multi-question answer when ask_user finishes with oversized stdout', () => {
      const answers = {
        intent: 'implement',
        scope: 'tui',
        tests: 'focused',
        review: 'self',
        commit: 'yes',
      };
      let state = dispatch(fresh(), {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.queued',
          toolCallId: 'ask-1',
          name: 'ask_user',
          args: { question: 'Configure the work' },
        },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.finished',
          toolCallId: 'ask-1',
          name: 'ask_user',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: 'x'.repeat(500),
            stderr: '',
            userInput: { answer: 'Configured', answers },
          },
        },
      });

      const card = flatBlocks(state).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'ask-1',
      );
      expect(card?.summary).toBe('x'.repeat(200));
      expect(card?.userInput).toEqual({ answer: 'Configured', answers });
    });

    test('renders model text, tool lifecycle, file changes, and terminal errors in event order', () => {
      let state = fresh();
      const events: import('../src/core/runtime/events').RuntimeEvent[] = [
        { type: 'user.message_appended', messageId: 'u1', content: 'Inspect the file' },
        {
          type: 'model.responded',
          messageId: 'm1',
          reasoningText: 'checking',
          text: 'I will inspect it.',
        },
        { type: 'tool.queued', toolCallId: 'read1', name: 'read_file', args: { path: 'a.ts' } },
        { type: 'tool.started', toolCallId: 'read1' },
        {
          type: 'tool.finished',
          toolCallId: 'read1',
          name: 'read_file',
          result: { ok: true, command: '', exitCode: 0, stdout: 'ok', stderr: '' },
        },
        { type: 'tool.file_change', toolCallId: 'read1', path: 'a.ts', kind: 'edit' },
        { type: 'run.error', message: 'network failed', recoverable: true },
      ];
      for (const event of events) state = dispatch(state, { type: 'RUNTIME_EVENT', event });

      const blocks = flatBlocks(state);
      expect(blocks.map((block) => block.kind)).toContain('user');
      expect(blocks.map((block) => block.kind)).toContain('text');
      expect(blocks.map((block) => block.kind)).toContain('tool_summary');
      expect(blocks.map((block) => block.kind)).toContain('file_change');
      expect(blocks.at(-1)).toMatchObject({
        kind: 'text',
        content: '⟳ Recoverable error: network failed',
      });
    });

    test('replays a persisted local command as a user block', () => {
      const state = dispatch(fresh(), {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'user.command_invoked',
          commandId: 'command-1',
          command: '/compact focus on auth changes',
        },
      });

      expect(flatBlocks(state)).toContainEqual(
        expect.objectContaining({
          kind: 'user',
          content: '/compact focus on auth changes',
        }),
      );
    });

    test('keeps approval in Footer while user input and plan review use their own projections', () => {
      const approvalEvent: import('../src/core/runtime/events').RuntimeEvent = {
        type: 'approval.requested',
        interactionId: 'approval-1',
        toolCallId: 'write-1',
        approval: approval(),
      };
      const inputEvent: import('../src/core/runtime/events').RuntimeEvent = {
        type: 'user_input.requested',
        interactionId: 'input-1',
        toolCallId: 'ask-1',
        request: question(),
      };
      const reviewEvent: import('../src/core/runtime/events').RuntimeEvent = {
        type: 'plan.review_requested',
        interactionId: 'plan-1',
        toolCallId: 'plan-call',
        plan: { name: 'Plan', description: 'Do work', status: 'pending', steps: [] },
        planSummary: 'Do work',
      };

      const approvalState = dispatch(fresh(), { type: 'RUNTIME_EVENT', event: approvalEvent });
      expect(flatBlocks(approvalState)).toHaveLength(0);
      expect(approvalState.interrupt).toMatchObject({
        kind: 'approval',
        approval: approvalEvent.approval,
      });

      const inputState = dispatch(fresh(), { type: 'RUNTIME_EVENT', event: inputEvent });
      expect(flatBlocks(inputState).at(-1)?.kind).toBe('question');
      expect(inputState.interrupt?.kind).toBe('input');

      const reviewState = dispatch(fresh(), { type: 'RUNTIME_EVENT', event: reviewEvent });
      expect(reviewState.interrupt?.kind).toBe('plan_review');
      expect(reviewState.status.pendingPlan?.name).toBe('Plan');
    });

    test('durable approval grant clears the Footer interrupt during replay', () => {
      const requested = handleRuntimeEventAction(fresh(), {
        type: 'approval.requested',
        interactionId: 'approval-1',
        toolCallId: 'shell-1',
        approval: approval(),
      });

      const granted = handleRuntimeEventAction(requested, {
        type: 'approval.granted',
        interactionId: 'approval-1',
        toolCallId: 'shell-1',
        grant: 'same_command',
      });

      expect(requested.interrupt?.kind).toBe('approval');
      expect(granted.interrupt).toBeNull();
    });

    test('subagent approval grant clears the parent task Footer interrupt', () => {
      const childApproval = { ...approval(), callId: 'child-shell' };
      const requested = handleRuntimeEventAction(fresh(), {
        type: 'approval.requested',
        interactionId: 'approval-child',
        toolCallId: 'parent-task',
        approval: childApproval,
      });

      expect(requested.interrupt).toMatchObject({
        kind: 'approval',
        interactionId: 'approval-child',
        toolCallId: 'parent-task',
        approval: { callId: 'child-shell' },
      });

      const granted = handleRuntimeEventAction(requested, {
        type: 'approval.granted',
        interactionId: 'approval-child',
        toolCallId: 'parent-task',
        grant: 'same_command',
      });

      expect(granted.interrupt).toBeNull();
    });

    test('subagent approval rejection clears the parent task Footer interrupt', () => {
      let requested = handleRuntimeEventAction(fresh(), {
        type: 'subagent.started',
        subagent: { id: 'human-rejected-child', role: 'review', task: 'run checks' },
      });
      requested = handleRuntimeEventAction(requested, {
        type: 'subagent.suspended',
        toolCallId: 'parent-task',
        snapshot: {
          subagentId: 'human-rejected-child',
          role: 'review',
          task: 'run checks',
          messages: [],
          toolCallCount: 0,
          steps: [],
          blockedTool: {
            reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
            toolCallId: 'child-shell',
            toolName: 'shell_execute',
            args: { command: 'bun test' },
            command: 'bun test',
          },
        },
      });
      requested = handleRuntimeEventAction(requested, {
        type: 'approval.requested',
        interactionId: 'approval-child-rejected',
        toolCallId: 'parent-task',
        approval: {
          ...approval(),
          callId: 'child-shell',
          subagentId: 'human-rejected-child',
        },
      });

      const rejected = handleRuntimeEventAction(requested, {
        type: 'approval.rejected',
        interactionId: 'approval-child-rejected',
        toolCallId: 'parent-task',
        reason: 'Rejected by user.',
      });

      expect(rejected.interrupt).toBeNull();
      expect(flatBlocks(rejected)[0]).toMatchObject({
        kind: 'subagent',
        status: 'cancelled',
        awaitingApproval: false,
      });
    });

    test('a stale approval grant cannot clear a different active approval', () => {
      const requested = handleRuntimeEventAction(fresh(), {
        type: 'approval.requested',
        interactionId: 'approval-current',
        toolCallId: 'shell-current',
        approval: approval(),
      });

      const unchanged = handleRuntimeEventAction(requested, {
        type: 'approval.granted',
        interactionId: 'approval-stale',
        toolCallId: 'shell-stale',
        grant: 'approve_once',
      });

      expect(unchanged.interrupt).toEqual(requested.interrupt);
      expect(unchanged.interrupt).toMatchObject({
        kind: 'approval',
        interactionId: 'approval-current',
      });
    });

    test('a delayed approval terminal with the same interaction but another tool cannot clear it', () => {
      const requested = handleRuntimeEventAction(fresh(), {
        type: 'approval.requested',
        interactionId: 'approval-current',
        toolCallId: 'shell-current',
        approval: approval(),
      });

      const unchanged = handleRuntimeEventAction(requested, {
        type: 'approval.granted',
        interactionId: 'approval-current',
        toolCallId: 'shell-stale',
        grant: 'approve_once',
      });

      expect(unchanged).toEqual(requested);
    });

    test('a stale approval rejection cannot clear or mutate a different active approval', () => {
      const requested = handleRuntimeEventAction(fresh(), {
        type: 'approval.requested',
        interactionId: 'approval-current',
        toolCallId: 'shell-current',
        approval: approval(),
      });

      const unchanged = handleRuntimeEventAction(requested, {
        type: 'approval.rejected',
        interactionId: 'approval-stale',
        toolCallId: 'shell-stale',
        reason: 'Stale rejection.',
      });

      expect(unchanged).toEqual(requested);
    });

    test('delayed input requests cannot overwrite the active interaction identity', () => {
      const requested = handleRuntimeEventAction(fresh(), {
        type: 'user_input.requested',
        interactionId: 'input-current',
        toolCallId: 'ask-current',
        request: question(),
      });

      const unchanged = handleRuntimeEventAction(requested, {
        type: 'user_input.requested',
        interactionId: 'input-stale',
        toolCallId: 'ask-stale',
        request: question(),
      });

      expect(unchanged).toEqual(requested);
    });

    test('a delayed ask_user terminal with a different tool cannot resolve the active question', () => {
      const requested = handleRuntimeEventAction(fresh(), {
        type: 'user_input.requested',
        interactionId: 'input-current',
        toolCallId: 'ask-current',
        request: question(),
      });

      const unchanged = handleRuntimeEventAction(requested, {
        type: 'user_input.cancelled',
        interactionId: 'input-current',
        toolCallId: 'ask-stale',
        reason: 'Stale cancellation.',
      });

      expect(unchanged).toEqual(requested);
    });

    test('stale plan terminal events cannot mutate the current plan review', () => {
      const requested = handleRuntimeEventAction(fresh(), {
        type: 'plan.review_requested',
        interactionId: 'plan-current',
        toolCallId: 'plan-current-call',
        plan: { name: 'Current', description: 'Current plan', status: 'pending', steps: [] },
        planSummary: 'Current plan',
      });

      const unchanged = handleRuntimeEventAction(requested, {
        type: 'plan.rejected',
        interactionId: 'plan-stale',
        toolCallId: 'plan-stale-call',
        reason: 'Stale rejection.',
      });

      expect(unchanged).toEqual(requested);
    });

    test('plan review cancellation has identical live and replay projections without a banner', () => {
      const events: import('../src/core/runtime/events').RuntimeEvent[] = [
        {
          type: 'tool.queued',
          toolCallId: 'plan-call',
          name: 'write_plan',
          args: { plan: 'Draft body' },
        },
        {
          type: 'plan.review_requested',
          interactionId: 'plan-review',
          toolCallId: 'plan-call',
          plan: {
            name: 'Plan',
            description: 'Do the work safely.',
            status: 'pending',
            steps: [{ id: 'step-1', step: 'Implement', status: 'pending' }],
          },
          planSummary: 'Do the work safely.',
        },
        {
          type: 'plan.review_cancelled',
          interactionId: 'plan-review',
          toolCallId: 'plan-call',
          reason: 'Plan execution confirmation cancelled by user.',
        },
        {
          type: 'tool.cancelled',
          toolCallId: 'plan-call',
          reason: 'Plan execution confirmation cancelled by user.',
        },
        {
          type: 'turn.aborted',
          turnId: 'turn-1',
          reason: 'Plan execution confirmation cancelled by user.',
          cause: 'user',
        },
      ];

      let live = fresh();
      live = handleRuntimeEventAction(live, events[0]!);
      live = handleRuntimeEventAction(live, events[1]!);
      live = eventReducer(live, { type: 'ESCAPE' });
      for (const event of events.slice(2)) live = handleRuntimeEventAction(live, event);

      let replay = fresh();
      for (const event of events) replay = handleRuntimeEventAction(replay, event);

      expect(flatBlocks(live)).toEqual(flatBlocks(replay));
      expect(
        flatBlocks(live).some(
          (block) => block.kind === 'text' && block.content.includes('Plan declined'),
        ),
      ).toBe(false);
      expect(flatBlocks(live)).toContainEqual(
        expect.objectContaining({
          kind: 'tool_card',
          callId: 'plan-call',
          status: 'done',
          summary: expect.stringContaining('Do the work safely.'),
        }),
      );
    });

    test('approval rejection keeps the queued shell as a rejected message card', () => {
      let state = dispatch(fresh(), {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.queued',
          toolCallId: 'shell-rejected',
          name: 'shell_execute',
          args: { command: 'rm generated.txt' },
        },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'approval.requested',
          interactionId: 'approval-rejected',
          toolCallId: 'shell-rejected',
          approval: approval(),
        },
      });
      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'approval.rejected',
          interactionId: 'approval-rejected',
          toolCallId: 'shell-rejected',
          reason: 'Rejected by user.',
        },
      });

      const card = flatBlocks(state).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'shell-rejected',
      );
      const approvalBlock = flatBlocks(state).find(
        (block): block is Extract<OutputBlock, { kind: 'approval' }> => block.kind === 'approval',
      );
      expect(card).toMatchObject({
        callId: 'shell-rejected',
        name: 'shell_execute',
        status: 'error',
        summary: 'Rejected by user.',
      });
      expect(approvalBlock).toBeUndefined();
      expect(state.pendingToolCalls['shell-rejected']).toBeUndefined();
      expect(state.interrupt).toBeNull();
    });

    test('canonical approval and auto-review terminals derive TUI status from ToolOutcome', () => {
      const rejectedOutcome = {
        schemaVersion: 1 as const,
        status: 'rejected' as const,
        failure: { kind: 'approval_rejected' as const, detailCode: 'approval_rejected' as const },
        dispatchState: 'not_started' as const,
        externalEffects: 'none' as const,
        replaySafety: 'pre_dispatch' as const,
        recovery: {
          disposition: 'never' as const,
          maximumAdditionalCalls: 0 as const,
          requiresNewModelResponse: false,
          safeAutomaticRetry: false,
        },
        timing: { source: 'runtime_boundary' as const },
      };
      let approvalState = handleRuntimeEventAction(fresh(), {
        type: 'tool.queued',
        toolCallId: 'canonical-approval-rejected',
        name: 'shell_execute',
        args: { command: 'private' },
      });
      approvalState = handleRuntimeEventAction(approvalState, {
        type: 'approval.requested',
        interactionId: 'canonical-approval',
        toolCallId: 'canonical-approval-rejected',
        approval: approval(),
      });
      approvalState = handleRuntimeEventAction(approvalState, {
        type: 'approval.rejected',
        interactionId: 'canonical-approval',
        toolCallId: 'canonical-approval-rejected',
        reason: 'redacted',
        outcomeV1: rejectedOutcome,
      });
      expect(
        flatBlocks(approvalState).find(
          (block) => block.kind === 'tool_card' && block.callId === 'canonical-approval-rejected',
        ),
      ).toMatchObject({ status: 'error' });

      let autoState = handleRuntimeEventAction(fresh(), {
        type: 'tool.queued',
        toolCallId: 'canonical-auto-rejected',
        name: 'shell_execute',
        args: { command: 'private' },
      });
      autoState = handleRuntimeEventAction(autoState, {
        type: 'auto_review.completed',
        reviewId: 'canonical-auto',
        toolCallId: 'canonical-auto-rejected',
        result: {
          ok: true,
          approved: false,
          reviewerModelName: 'test',
          durationMs: 1,
        },
        outcomeV1: {
          ...rejectedOutcome,
          failure: {
            kind: 'auto_review_rejected' as const,
            detailCode: 'auto_review_rejected' as const,
          },
        },
      });
      expect(
        flatBlocks(autoState).find(
          (block) => block.kind === 'tool_card' && block.callId === 'canonical-auto-rejected',
        ),
      ).toMatchObject({ status: 'error' });

      let escalatedState = handleRuntimeEventAction(fresh(), {
        type: 'tool.queued',
        toolCallId: 'auto-risk-escalated',
        name: 'shell_execute',
        args: { command: 'touch /tmp/risk' },
      });
      escalatedState = handleRuntimeEventAction(escalatedState, {
        type: 'auto_review.completed',
        reviewId: 'auto-risk',
        toolCallId: 'auto-risk-escalated',
        result: {
          ok: true,
          approved: false,
          escalatedToUser: true,
          reviewerModelName: 'test',
          durationMs: 1,
        },
      });
      expect(escalatedState.pendingToolCalls['auto-risk-escalated']).toBeDefined();
      expect(
        flatBlocks(escalatedState).find(
          (block) => block.kind === 'tool_card' && block.callId === 'auto-risk-escalated',
        ),
      ).toBeUndefined();
    });

    test('keeps planning shell deferrals out of the message list', () => {
      const events: import('../src/core/runtime/events').RuntimeEvent[] = [
        {
          type: 'tool.queued',
          toolCallId: 'typecheck',
          name: 'shell_execute',
          args: { command: 'bun run typecheck' },
        },
        {
          type: 'tool.rejected',
          toolCallId: 'typecheck',
          reason: 'Deferred shell_execute until building phase.',
          failure: {
            kind: 'phase_deferred',
            message: 'Deferred shell_execute until building phase.',
            retryable: false,
            modelFixable: true,
            needsUserIntervention: false,
            terminatesTurn: false,
            journal: true,
          },
        },
        {
          type: 'tool.queued',
          toolCallId: 'tests',
          name: 'shell_execute',
          args: { command: 'bun test tests/runtime' },
        },
        {
          type: 'tool.rejected',
          toolCallId: 'tests',
          reason: 'Deferred shell_execute until building phase.',
          failure: {
            kind: 'phase_deferred',
            message: 'Deferred shell_execute until building phase.',
            retryable: false,
            modelFixable: true,
            needsUserIntervention: false,
            terminatesTurn: false,
            journal: true,
          },
        },
      ];

      const live = events.reduce(handleRuntimeEventAction, fresh());
      expect(flatBlocks(live)).toEqual([]);
      expect(live.pendingToolCalls).toEqual({});

      const replay = events.reduce(handleRuntimeEventAction, fresh());
      expect(flatBlocks(replay)).toEqual(flatBlocks(live));
    });

    test('renders a planning edit denial as guidance without a tool card', () => {
      const reason =
        'Plan mode is read-only. No file was edited. Describe the intended change in the plan and apply it after plan approval.';
      const events: import('../src/core/runtime/events').RuntimeEvent[] = [
        {
          type: 'tool.queued',
          toolCallId: 'edit-denied',
          name: 'edit_file',
          args: {
            path: 'src/example.ts',
            old_string: 'before',
            new_string: 'after',
          },
        },
        {
          type: 'tool.rejected',
          toolCallId: 'edit-denied',
          reason,
          failure: {
            kind: 'phase_denied',
            message: reason,
            retryable: false,
            modelFixable: true,
            needsUserIntervention: false,
            terminatesTurn: false,
            journal: true,
          },
        },
      ];

      const state = events.reduce(handleRuntimeEventAction, fresh());
      expect(flatBlocks(state)).toEqual([
        expect.objectContaining({
          kind: 'text',
          content: reason,
        }),
      ]);
      expect(flatBlocks(state).some((block) => block.kind === 'tool_card')).toBe(false);
      expect(state.pendingToolCalls).toEqual({});
    });

    test('approval cancellation keeps the rejected target and started siblings visible', () => {
      let state = dispatch(fresh(), { type: 'SET_RUNNING' });
      for (const event of [
        {
          type: 'tool.queued' as const,
          toolCallId: 'shell-running',
          name: 'shell_execute',
          args: { command: 'bun test' },
        },
        {
          type: 'tool.started' as const,
          toolCallId: 'shell-running',
        },
        {
          type: 'tool.queued' as const,
          toolCallId: 'shell-rejected',
          name: 'shell_execute',
          args: { command: 'rm generated.txt' },
        },
        {
          type: 'approval.requested' as const,
          interactionId: 'approval-rejected',
          toolCallId: 'shell-rejected',
          approval: approval(),
        },
        {
          type: 'approval.rejected' as const,
          interactionId: 'approval-rejected',
          toolCallId: 'shell-rejected',
          reason: 'Approval cancelled by user.',
        },
        {
          type: 'tool.cancelled' as const,
          toolCallId: 'shell-running',
          reason: 'Approval cancelled by user.',
        },
        {
          type: 'turn.aborted' as const,
          turnId: 'turn-1',
          reason: 'Approval cancelled by user.',
          cause: 'user' as const,
        },
      ]) {
        state = dispatch(state, { type: 'RUNTIME_EVENT', event });
      }

      expect(flatBlocks(state)).toContainEqual(
        expect.objectContaining({
          kind: 'tool_card',
          callId: 'shell-running',
          status: 'cancelled',
        }),
      );
      expect(flatBlocks(state)).toContainEqual(
        expect.objectContaining({
          kind: 'tool_card',
          callId: 'shell-rejected',
          status: 'error',
          summary: 'Approval cancelled by user.',
        }),
      );
      expect(
        flatBlocks(state).some(
          (block) => block.kind === 'text' && block.content.includes('Run cancelled'),
        ),
      ).toBe(false);
      expect(state.pendingToolCalls['shell-rejected']).toBeUndefined();
      expect(state.interrupt).toBeNull();
      expect(state.running).toBe(false);
    });

    test('keeps a legacy preflighted shell call invisible until it starts', () => {
      let state = dispatch(fresh(), {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'tool.queued',
          toolCallId: 'shell-ready',
          name: 'shell_execute',
          args: { command: 'pwd' },
        },
      });

      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: { type: 'tool.execution_ready', toolCallId: 'shell-ready' },
      });

      const card = flatBlocks(state).find(
        (block): block is Extract<OutputBlock, { kind: 'tool_card' }> =>
          block.kind === 'tool_card' && block.callId === 'shell-ready',
      );
      expect(card).toBeUndefined();
      expect(state.pendingToolCalls['shell-ready']).toEqual({
        name: 'shell_execute',
        args: { command: 'pwd' },
      });
    });

    test('updates cache statistics and keeps non-visual lifecycle facts out of the message list', () => {
      let state = fresh();
      const nonVisual: import('../src/core/runtime/events').RuntimeEvent[] = [
        { type: 'turn.started', turnId: 'turn-1' },
        { type: 'model.requested', requestId: 'request-1' },
        { type: 'authorization.changed', mode: 'default' },
        { type: 'turn.completed', turnId: 'turn-1' },
      ];
      for (const event of nonVisual) state = dispatch(state, { type: 'RUNTIME_EVENT', event });
      expect(flatBlocks(state)).toHaveLength(0);

      state = dispatch(state, {
        type: 'RUNTIME_EVENT',
        event: {
          type: 'model.cache_metrics',
          inputTokens: 100,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          hitRate: 0.8,
        },
      });
      expect(state.status.cacheHitTokens).toBe(80);
      expect(state.status.cacheMissTokens).toBe(20);
      expect(state.status.cacheHitRate).toBe(0.8);
      expect(flatBlocks(state)).toHaveLength(0);
    });
  });

  // ── Interaction Mode ──

  describe('SET_INTERACTION_MODE', () => {
    test('default interactionMode is ask, authorization is default', () => {
      const s = fresh();
      expect(s.interactionMode).toBe('accept_edits');
      expect(s.status.authorization).toBe('default');
    });

    test('sets interactionMode to auto, authorization stays default', () => {
      const s = dispatch(fresh(), { type: 'SET_INTERACTION_MODE', mode: 'auto' });
      expect(s.interactionMode).toBe('auto');
      expect(s.status.authorization).toBe('default');
    });

    test('sets interactionMode to full, authorization becomes full_access', () => {
      const s = dispatch(fresh(), { type: 'SET_INTERACTION_MODE', mode: 'full' });
      expect(s.interactionMode).toBe('full');
      expect(s.status.authorization).toBe('full_access');
    });

    test('switching from full to ask resets authorization to default', () => {
      let s = dispatch(fresh(), { type: 'SET_INTERACTION_MODE', mode: 'full' });
      expect(s.status.authorization).toBe('full_access');
      s = dispatch(s, { type: 'SET_INTERACTION_MODE', mode: 'accept_edits' });
      expect(s.interactionMode).toBe('accept_edits');
      expect(s.status.authorization).toBe('default');
    });

    test('toggle cycles ask → auto → full → ask with correct auth', () => {
      let s = fresh();
      expect(s.interactionMode).toBe('accept_edits');
      expect(s.status.authorization).toBe('default');

      s = dispatch(s, { type: 'SET_INTERACTION_MODE', mode: 'toggle' });
      expect(s.interactionMode).toBe('auto');
      expect(s.status.authorization).toBe('default');

      s = dispatch(s, { type: 'SET_INTERACTION_MODE', mode: 'toggle' });
      expect(s.interactionMode).toBe('full');
      expect(s.status.authorization).toBe('full_access');

      s = dispatch(s, { type: 'SET_INTERACTION_MODE', mode: 'toggle' });
      expect(s.interactionMode).toBe('accept_edits');
      expect(s.status.authorization).toBe('default');
    });

    test('toggle from auto goes to full with full_access', () => {
      let s = dispatch(fresh(), { type: 'SET_INTERACTION_MODE', mode: 'auto' });
      s = dispatch(s, { type: 'SET_INTERACTION_MODE', mode: 'toggle' });
      expect(s.interactionMode).toBe('full');
      expect(s.status.authorization).toBe('full_access');
    });

    test('toggle from full goes to ask with default auth', () => {
      let s = dispatch(fresh(), { type: 'SET_INTERACTION_MODE', mode: 'full' });
      s = dispatch(s, { type: 'SET_INTERACTION_MODE', mode: 'toggle' });
      expect(s.interactionMode).toBe('accept_edits');
      expect(s.status.authorization).toBe('default');
    });
  });
});

describe('model streaming RuntimeEvent rendering', () => {
  test('keeps an incomplete streamed paragraph out of the render tree', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'reasoning',
      reasoningText: 'thinking',
    });
    state = handleRuntimeEventAction(state, { type: 'model.text_delta', text: 'Hel' });
    state = handleRuntimeEventAction(state, { type: 'model.text_delta', text: 'Hello' });

    const blocks = flatBlocks(state);
    const thoughtIndex = blocks.findIndex(
      (block) =>
        block.kind === 'reason' || (block.kind === 'text' && block.thoughtElapsedMs != null),
    );
    expect(thoughtIndex).toBeGreaterThanOrEqual(0);
    expect(blocks.some((block) => block.kind === 'text')).toBe(false);
  });

  test('preserves state identity for hidden streamed tail updates after the first answer delta', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'hidden-tail',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'unfinished',
    });
    const firstAnswerState = state;

    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'unfinished paragraph still growing',
    });

    expect(state).toBe(firstAnswerState);
    expect(flatBlocks(state).filter((block) => block.kind === 'text')).toHaveLength(0);
  });

  test('keeps reasoning deltas hidden until the reasoning stream completes', () => {
    let state = handleRuntimeEventAction(fresh(), {
      type: 'model.responded',
      messageId: 'reasoning',
      reasoningText: 'initial',
    });
    const reasonCount = flatBlocks(state).filter((block) => block.kind === 'reason').length;
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'cumulative preview.',
    });

    expect(flatBlocks(state).find((block) => block.kind === 'tool_summary')).toMatchObject({
      latestActivity: { kind: 'thinking', text: 'initial' },
    });
    expect(flatBlocks(state).filter((block) => block.kind === 'reason')).toHaveLength(reasonCount);
  });

  test('publishes the complete reasoning atomically when answer streaming begins', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'First complete sentence. partial',
    });
    let summary = flatBlocks(state).find(
      (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
        block.kind === 'tool_summary',
    );
    expect(summary).toMatchObject({
      active: true,
      latestActivity: undefined,
    });

    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'First complete sentence. Second complete line\npartial tail',
    });
    summary = flatBlocks(state).find(
      (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
        block.kind === 'tool_summary',
    );
    expect(summary).toMatchObject({
      active: true,
      latestActivity: undefined,
    });

    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'Answer paragraph is still incomplete',
    });
    summary = flatBlocks(state).find(
      (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
        block.kind === 'tool_summary',
    );
    expect(summary).toMatchObject({
      active: false,
      responsePending: true,
      latestActivity: {
        kind: 'thinking',
        text: 'First complete sentence. Second complete line\npartial tail',
      },
    });

    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'First answer paragraph.\n\nSecond paragraph is incomplete',
    });
    summary = flatBlocks(state).find(
      (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
        block.kind === 'tool_summary',
    );
    expect(summary).toBeUndefined();
    expect(
      flatBlocks(state)
        .filter((block) => block.kind === 'text')
        .map((block) => block.content),
    ).toEqual(['First answer paragraph.\n\n']);
    const firstCommittedText = flatBlocks(state).find((block) => block.kind === 'text');
    expect(firstCommittedText).toMatchObject({
      thoughtContent: 'First complete sentence. Second complete line\npartial tail',
    });
    expect(firstCommittedText).not.toHaveProperty('responsePending');
  });

  test('handles repeated complete reasoning segments around exploration tools', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'segment-request-1',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      segmentId: 'segment-1',
      text: 'partial first segment',
    });
    expect(flatBlocks(state).find((block) => block.kind === 'tool_summary')).toMatchObject({
      latestActivity: undefined,
    });

    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_completed',
      segmentId: 'segment-1',
      text: 'complete first segment',
    });
    expect(flatBlocks(state).find((block) => block.kind === 'tool_summary')).toMatchObject({
      latestActivity: { kind: 'thinking', text: 'complete first segment' },
    });

    state = handleRuntimeEventAction(state, {
      type: 'tool.queued',
      toolCallId: 'read-between-segments',
      name: 'read_file',
      args: { path: 'README.md' },
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.started',
      toolCallId: 'read-between-segments',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'segment-request-2',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      segmentId: 'segment-2',
      text: 'partial second segment',
    });
    expect(flatBlocks(state).find((block) => block.kind === 'tool_summary')).toMatchObject({
      latestActivity: { kind: 'tool', callId: 'read-between-segments' },
    });

    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_completed',
      segmentId: 'segment-2',
      text: 'complete second segment',
    });
    const summaries = flatBlocks(state).filter((block) => block.kind === 'tool_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      active: true,
      latestActivity: { kind: 'thinking', text: 'complete second segment' },
    });
  });

  test('publishes ordered and unordered Markdown lists one complete item at a time', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: '- first item\n- second item',
    });
    expect(
      flatBlocks(state)
        .filter((block) => block.kind === 'text')
        .map((block) => block.content),
    ).toEqual(['- first item\n']);

    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: '- first item\n- second item\n1. ordered item\n2. unfinished item',
    });
    expect(
      flatBlocks(state)
        .filter((block) => block.kind === 'text')
        .map((block) => block.content),
    ).toEqual(['- first item\n', '- second item\n1. ordered item\n']);
  });

  test('keeps nested list lines with their parent item until the next top-level item', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: '- first item\n  - nested item\n  continuation\n- second item',
    });
    expect(
      flatBlocks(state)
        .filter((block) => block.kind === 'text')
        .map((block) => block.content),
    ).toEqual(['- first item\n  - nested item\n  continuation\n']);
  });

  test('creates Thought before streamed answer text when reasoning arrives first', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'thinking',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'Hello from the model.',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'streamed',
      reasoningText: 'thinking',
      text: 'Hello from the model.',
      durationMs: 1_000,
    });
    state = handleRuntimeEventAction(state, {
      type: 'run.completed',
      turnId: 'turn-1',
      output: 'Hello from the model.',
    });

    const blocks = flatBlocks(state);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'text',
      content: 'Hello from the model.',
      thoughtElapsedMs: 1_000,
    });
  });

  test('inserts terminal Thought before Markdown prefixes committed by the same response', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'ordered-response',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'complete project reasoning',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'Project overview.\n\nFinal invitation.',
    });

    expect(
      flatBlocks(state)
        .filter((block) => block.kind === 'text')
        .map((block) => block.content),
    ).toEqual(['Project overview.\n\n']);
    expect(state.thoughtPhaseStatus).toBe('awaiting_terminal');
    expect(flatBlocks(state).find((block) => block.kind === 'tool_summary')).toBeUndefined();

    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'complete project reasoning.\n\nlate tail',
    });
    expect(flatBlocks(state).filter((block) => block.kind === 'tool_summary')).toHaveLength(0);
    expect(state.thoughtPhaseStatus).toBe('awaiting_terminal');
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'Project overview.\n\nSecond complete paragraph.\n\nFinal invitation.',
    });
    expect(state.thoughtPhaseStatus).toBe('awaiting_terminal');
    expect(flatBlocks(state).filter((block) => block.kind === 'tool_summary')).toHaveLength(0);
    const publishedPrefix = flatBlocks(state).find(
      (block) => block.kind === 'text' && block.content === 'Project overview.\n\n',
    );

    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'ordered-answer',
      reasoningText: 'complete project reasoning',
      text: 'Project overview.\n\nSecond complete paragraph.\n\nFinal invitation.',
      durationMs: 8_511,
    });

    const blocks = flatBlocks(state);
    const prefixIndex = blocks.findIndex(
      (block) => block.kind === 'text' && block.content === 'Project overview.\n\n',
    );
    const tailIndex = blocks.findIndex(
      (block) => block.kind === 'text' && block.content === 'Final invitation.',
    );
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(tailIndex).toBeGreaterThan(prefixIndex);
    expect(blocks[prefixIndex]).toMatchObject({
      kind: 'text',
      thoughtElapsedMs: expect.any(Number),
      thoughtContent: 'complete project reasoning',
    });
    expect(blocks[prefixIndex]).toBe(publishedPrefix);
  });

  test('keeps one Thought across multiple exploration calls when a complete late reasoning paragraph follows answer text', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'explore-1',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'inspect files',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'explore-answer-1',
      reasoningText: 'inspect files',
      durationMs: 1_512,
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.queued',
      toolCallId: 'search-1',
      name: 'search_files',
      args: { pattern: '*', path: '.' },
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.started',
      toolCallId: 'search-1',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'explore-2',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'read key files',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'explore-answer-2',
      reasoningText: 'read key files',
      durationMs: 1_727,
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.queued',
      toolCallId: 'read-1',
      name: 'read_file',
      args: { path: 'README.md' },
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.started',
      toolCallId: 'read-1',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'final-summary',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'Project overview.\n\nFinal details.',
    });
    expect(state.thoughtPhaseStatus).toBe('awaiting_terminal');
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'final synthesis.\n\nlate reasoning tail',
    });
    expect(flatBlocks(state).filter((block) => block.kind === 'tool_summary')).toHaveLength(1);
    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'final-answer',
      reasoningText: 'final synthesis.',
      text: 'Project overview.\n\nFinal details.',
      durationMs: 7_094,
    });

    const summaries = flatBlocks(state).filter(
      (block): block is Extract<OutputBlock, { kind: 'tool_summary' }> =>
        block.kind === 'tool_summary',
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      active: false,
      totalElapsedMs: 10_333,
    });
  });

  test('moves already streamed text behind Thought when reasoning arrives in a later frame', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'Text arrived first.',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'late thinking',
    });
    const intermediate = flatBlocks(state);
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0]).toMatchObject({
      kind: 'tool_summary',
      active: true,
      latestActivity: undefined,
    });
    expect(
      intermediate.some((block) => block.kind === 'tool_summary' && block.pendingCaption != null),
    ).toBe(false);
    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'late-reasoning',
      reasoningText: 'late thinking',
      text: 'Text arrived first.',
      durationMs: 800,
    });
    state = handleRuntimeEventAction(state, {
      type: 'run.completed',
      turnId: 'turn-1',
      output: 'Text arrived first.',
    });

    const blocks = flatBlocks(state);
    expect(blocks.map((block) => block.kind)).toEqual(['text']);
    expect(blocks[0]).toMatchObject({
      content: 'Text arrived first.',
    });
    expect(blocks[0]).toMatchObject({ kind: 'text', thoughtElapsedMs: 800 });
  });

  test('preserves the frozen reconnect segment when late reasoning reorders the live tail', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'request-1',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'frozen prefix',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.retry',
      attempt: 1,
      maxAttempts: 5,
      error: 'socket disconnected',
      delayMs: 10,
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: ' recovered suffix',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'late recovered reasoning',
    });

    const textBlocks = flatBlocks(state).filter(
      (block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text',
    );
    expect(textBlocks).toEqual([]);
  });

  test('settles terminal reasoning against only the current model response text', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'request-1',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'I will inspect it.',
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.queued',
      toolCallId: 'read-1',
      name: 'read_file',
      args: { path: 'README.md' },
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.started',
      toolCallId: 'read-1',
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.finished',
      toolCallId: 'read-1',
      name: 'read_file',
      result: { ok: true, command: '', exitCode: 0, stdout: 'done', stderr: '' },
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.requested',
      requestId: 'request-2',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'final reasoning',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'Final answer.',
    });
    const currentReasoningCount = (blocks: OutputBlock[]) =>
      blocks.filter(
        (block) =>
          (block.kind === 'reason' && block.content === 'final reasoning') ||
          (block.kind === 'tool_summary' &&
            block.hasThinking === true &&
            block.modelRequestId === 'request-2'),
      ).length;
    const reasonCountBeforeTerminal = currentReasoningCount(flatBlocks(state));

    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'answer-2',
      reasoningText: 'final reasoning',
      text: 'Final answer.',
      durationMs: 500,
    });

    expect(reasonCountBeforeTerminal).toBe(0);
    expect(currentReasoningCount(flatBlocks(state))).toBe(0);
    expect(
      flatBlocks(state).filter(
        (block) => block.kind === 'text' && block.content === 'Final answer.',
      ),
    ).toHaveLength(1);
  });

  test('does not duplicate streamed reasoning when the terminal response settles it', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.reasoning_delta',
      text: 'same thought',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'reasoning-only',
      reasoningText: 'same thought',
      durationMs: 500,
    });

    const summary = flatBlocks(state).find((block) => block.kind === 'tool_summary');
    expect(summary).toMatchObject({
      timeline: [{ kind: 'thinking', text: 'same thought' }],
      totalElapsedMs: 500,
    });
  });

  test('does not publish a paragraph before its boundary', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, { type: 'model.text_delta', text: 'first' });
    state = handleRuntimeEventAction(state, { type: 'model.text_delta', text: 'first line' });
    expect(flatBlocks(state)).toEqual([]);
  });

  test('publishes complete Markdown chunks and keeps the final component hidden', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    const markdown =
      '# Result\n\nA paragraph.\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```';
    state = handleRuntimeEventAction(state, { type: 'model.text_delta', text: '# Result' });
    state = handleRuntimeEventAction(state, { type: 'model.text_delta', text: markdown });

    const textBlocks = flatBlocks(state).filter(
      (block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text',
    );
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]?.streaming).not.toBe(true);
    expect(textBlocks[0]?.content).toBe(markdown.slice(0, markdown.indexOf('```ts')));
    expect(textBlocks.map((block) => block.content).join('')).not.toContain('const x = 1');
  });

  test('renders a closed code shell with only complete streamed rows', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    const markdown = '```ts\nconst first = 1\n\nconst second = 2';
    state = handleRuntimeEventAction(state, { type: 'model.text_delta', text: markdown });

    const textBlocks = flatBlocks(state).filter(
      (block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text',
    );
    expect(textBlocks).toEqual([
      expect.objectContaining({
        content: '```ts\nconst first = 1\n\n',
        streaming: true,
        streamingComponent: 'code',
        streamingSource: markdown,
      }),
    ]);
  });

  test('appends complete rows inside a recognized component and freezes it on closure', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: '```text\nsrc/\n├── app/\n',
    });

    expect(flatBlocks(state)).toEqual([
      expect.objectContaining({
        kind: 'text',
        content: '```text\nsrc/\n├── app/\n',
        streaming: true,
        streamingComponent: 'code',
      }),
    ]);

    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: '```text\nsrc/\n├── app/\n```',
    });
    const blocks = flatBlocks(state);
    expect(blocks).toContainEqual(
      expect.objectContaining({
        kind: 'text',
        content: '```text\nsrc/\n├── app/\n```',
      }),
    );
    expect(
      blocks.some(
        (block) => block.kind === 'text' && (block.streaming || block.streamingComponent != null),
      ),
    ).toBe(false);
  });

  test('recognizes a table shell and appends only complete rows', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    const partial = '| Name | Role |\n| --- | --- |\n| App | entry |\n| Footer | sta';
    state = handleRuntimeEventAction(state, { type: 'model.text_delta', text: partial });

    expect(flatBlocks(state)).toEqual([
      expect.objectContaining({
        kind: 'text',
        content: '| Name | Role |\n| --- | --- |\n| App | entry |\n',
        streaming: true,
        streamingComponent: 'table',
        streamingSource: partial,
      }),
    ]);
  });

  test('terminal response replaces a live component with the authoritative full text', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: '```text\nfirst\nsecond',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'answer',
      text: '```text\nfirst\nsecond\n```',
    });

    expect(flatBlocks(state)).toEqual([
      expect.objectContaining({
        kind: 'text',
        content: '```text\nfirst\nsecond\n```',
      }),
    ]);
    expect(
      flatBlocks(state).some(
        (block) => block.kind === 'text' && (block.streaming || block.streamingComponent != null),
      ),
    ).toBe(false);
  });

  test('deduplicates the legacy final event against paragraph-frozen streaming segments', () => {
    let state = dispatch(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, { type: 'model.requested', requestId: 'req-1' });
    const markdown = 'First paragraph.\n\nSecond paragraph.';
    state = handleRuntimeEventAction(state, { type: 'model.text_delta', text: markdown });
    const blockCount = flatBlocks(state).length;

    state = dispatch(state, { type: 'EVENT', event: { type: 'final', data: markdown } });

    const textBlocks = flatBlocks(state).filter(
      (block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text',
    );
    expect(flatBlocks(state).length).toBeGreaterThan(blockCount);
    expect(textBlocks.map((block) => block.content).join('')).toBe(markdown);
  });

  test('keeps streamed text between the settled Thought and a later exploration tool', () => {
    let state = handleRuntimeEventAction(fresh(), {
      type: 'model.responded',
      messageId: 'reasoning',
      reasoningText: 'thinking',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'I will inspect it.',
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.queued',
      toolCallId: 'read-1',
      name: 'read_file',
      args: { path: 'README.md' },
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.started',
      toolCallId: 'read-1',
    });

    const blocks = flatBlocks(state);
    expect(blocks.map((block) => block.kind)).toEqual(['reason', 'text', 'tool_summary']);
    expect(blocks[1]).toMatchObject({ kind: 'text', content: 'I will inspect it.' });
    expect(
      blocks
        .filter((block) => block.kind === 'tool_summary')
        .every((block) => !block.captions && !block.pendingCaption),
    ).toBe(true);
  });

  test('detaches a streamed caption before a non-exploration tool', () => {
    let state = handleRuntimeEventAction(fresh(), {
      type: 'model.responded',
      messageId: 'reasoning',
      reasoningText: 'thinking',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'I will change it.',
    });
    state = handleRuntimeEventAction(state, {
      type: 'tool.queued',
      toolCallId: 'write-1',
      name: 'write_file',
      args: { path: 'output.txt', content: 'done' },
    });

    expect(
      flatBlocks(state).some(
        (block) => block.kind === 'text' && block.content === 'I will change it.',
      ),
    ).toBe(true);
  });

  test('keeps an idle-race stream delta transient and publishes one terminal line', () => {
    let state = handleRuntimeEventAction(fresh(), {
      type: 'model.requested',
      requestId: 'answer-request',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: '好的，继续测试网络请求',
    });
    expect(flatBlocks(state).filter((block) => block.kind === 'text')).toHaveLength(0);

    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'answer',
      text: '好的，继续测试网络请求。',
    });
    state = handleRuntimeEventAction(state, {
      type: 'run.completed',
      turnId: 'turn-1',
      output: '好的，继续测试网络请求。',
    });

    expect(
      flatBlocks(state).filter(
        (block) => block.kind === 'text' && block.content === '好的，继续测试网络请求。',
      ),
    ).toHaveLength(1);
    expect(flatBlocks(state).filter((block) => block.kind === 'text')).toHaveLength(1);
  });
  test('settles a streamed final answer without duplicating the terminal text', () => {
    let state = handleRuntimeEventAction(fresh(), {
      type: 'model.responded',
      messageId: 'reasoning',
      reasoningText: 'thinking',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'Final answer.',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.responded',
      messageId: 'answer',
      text: 'Final answer.',
    });
    state = handleRuntimeEventAction(state, {
      type: 'run.completed',
      turnId: 'turn-1',
      output: 'Final answer.',
    });

    expect(
      flatBlocks(state).filter(
        (block) => block.kind === 'text' && block.content === 'Final answer.',
      ),
    ).toHaveLength(1);
  });

  test('keeps interrupted incomplete text hidden and publishes the recovered terminal response', () => {
    let state = eventReducer(fresh(), { type: 'SET_RUNNING' });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: { type: 'model.text_delta', text: 'partial answer' },
    });
    expect(flatBlocks(state)).toEqual([]);

    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'model.retry',
        attempt: 1,
        maxAttempts: 5,
        error: 'socket disconnected',
        delayMs: 10,
      },
    });

    expect(state.status.retryState?.attempt).toBe(1);
    expect(flatBlocks(state)).toEqual([]);

    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: { type: 'model.text_delta', text: ' continued' },
    });
    state = eventReducer(state, {
      type: 'RUNTIME_EVENT',
      event: {
        type: 'model.responded',
        messageId: 'recovered',
        text: 'partial answer continued',
      },
    });
    expect(state.status.retryState).toBeNull();
    expect(state.turns.at(-1)?.blocks.at(-1)).toMatchObject({
      content: 'partial answer continued',
    });
  });

  test('preserves interrupted lines and renders divergent regeneration in a new segment', () => {
    let state = eventReducer(fresh(), { type: 'SET_RUNNING' });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'old line one\nold line two',
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.retry',
      attempt: 1,
      maxAttempts: 5,
      error: 'socket disconnected',
      delayMs: 10,
    });
    state = handleRuntimeEventAction(state, {
      type: 'model.text_delta',
      text: 'new line one\nnew line two',
    });

    expect(
      flatBlocks(state).filter(
        (block): block is Extract<OutputBlock, { kind: 'text' }> => block.kind === 'text',
      ),
    ).toEqual([]);
  });
});

describe('context compaction RuntimeEvent rendering', () => {
  const compactionRequest = (
    reason: 'auto' | 'manual',
  ): Extract<RuntimeEvent, { type: 'context.compaction_requested' }> => ({
    type: 'context.compaction_requested',
    compactionId: `${reason}-request`,
    reason,
    requestedAtRevision: 1,
    requestedAtTurnId: 'turn-1',
    force: false,
    estimate: {
      systemTokens: 0,
      toolSchemaTokens: 0,
      transcriptTokens: 0,
      summaryTokens: 0,
      dynamicRuntimeTokens: 0,
      framingTokens: 0,
      totalInputTokens: 0,
    },
  });

  test('renders automatic compaction as a semantic command message', () => {
    const state = handleRuntimeEventAction(fresh(), compactionRequest('auto'));

    expect(flatBlocks(state)).toContainEqual(
      expect.objectContaining({ kind: 'user', content: '/auto-compact' }),
    );
  });

  test('does not duplicate the durable manual /compact command message', () => {
    let state = handleRuntimeEventAction(fresh(), {
      type: 'user.command_invoked',
      commandId: 'manual-command',
      command: '/compact',
    });
    state = handleRuntimeEventAction(state, compactionRequest('manual'));

    expect(
      flatBlocks(state).filter((block) => block.kind === 'user' && block.content === '/compact'),
    ).toHaveLength(1);
    expect(JSON.stringify(flatBlocks(state))).not.toContain('/auto-compact');
  });

  test('renders manual low-gain rejection as a benign actionable notice', () => {
    const state = handleRuntimeEventAction(fresh(), {
      type: 'context.compaction_failed',
      compactionId: 'low-gain',
      sourceRevision: 1,
      errorKind: 'insufficient_reduction',
      message: 'Not enough reducible context to compact.',
      retryable: false,
    });
    const output = JSON.stringify(flatBlocks(state));
    expect(output).toContain('Not enough reducible context');
    expect(output).not.toContain('Recoverable error');
    expect(state.sessionError).toBe(false);
  });

  test('renders failure and reset feedback without exposing summary content', () => {
    let state = handleRuntimeEventAction(fresh(), {
      type: 'context.compaction_failed',
      compactionId: 'compact',
      sourceRevision: 1,
      errorKind: 'invalid_candidate',
      message: 'summary omitted required facts',
      retryable: false,
    });
    expect(JSON.stringify(flatBlocks(state))).not.toContain('summary omitted required facts');
    expect(JSON.stringify(flatBlocks(state))).toContain('original conversation was preserved');

    state = handleRuntimeEventAction(state, {
      type: 'context.compaction_reset',
      checkpointId: 'compact',
      reason: 'manual',
    });
    expect(JSON.stringify(flatBlocks(state))).toContain('original transcript');
  });

  test.each([
    ['stale_context', 'retry /compact', false],
    ['oversized_turn', 'maxSummaryInputTokens', true],
    ['empty_summary', 'unusable compaction summary', true],
    ['truncated_summary', 'unusable compaction summary', true],
    ['unexpected_tool_call', 'unusable compaction summary', true],
    ['provider_admission_denied', 'Provider data policy', true],
    ['summary_aborted', 'was cancelled', false],
  ] as const)('renders typed %s guidance', (errorKind, expected, isError) => {
    const state = handleRuntimeEventAction(fresh(), {
      type: 'context.compaction_failed',
      compactionId: `typed-${errorKind}`,
      sourceRevision: 1,
      errorKind,
      message: 'private Provider detail',
      retryable: errorKind === 'stale_context',
    });
    const output = JSON.stringify(flatBlocks(state));
    expect(output).toContain(expected);
    expect(output).not.toContain('private Provider detail');
    expect(state.sessionError).toBe(isError);
  });

  test('compaction_completed reports token savings without persisting a StatsLine percentage', () => {
    const state = handleRuntimeEventAction(fresh(), {
      type: 'context.compaction_completed',
      compactionId: 'compact',
      sourceRevision: 0,
      checkpoint: {
        compactionId: 'compact',
        version: 1,
        sourceRevision: 0,
        sourceDigest: 'sha256:test',
        coveredThroughMessageId: 'msg-1',
        coveredThroughTurnId: 'turn-1',
        summary: 'Test narrative.',
        inputTokensBefore: 12_345,
        inputTokensAfter: 4_567,
        reason: 'manual',
        createdAt: new Date().toISOString(),
      },
    });
    expect(JSON.stringify(flatBlocks(state))).toContain('12345');
    expect(JSON.stringify(flatBlocks(state))).toContain('4567');
    expect(JSON.stringify(flatBlocks(state))).toContain('tokens');
    expect(state.status).not.toHaveProperty('compactionBefore');
    expect(state.status).not.toHaveProperty('compactionAfter');
  });

  test('renders exactly one terminal notice per compaction id', () => {
    const event = {
      type: 'context.compaction_failed' as const,
      compactionId: 'dedupe',
      sourceRevision: 1,
      errorKind: 'summary_model_failed' as const,
      message: 'secret provider detail',
      retryable: true,
    };
    const once = handleRuntimeEventAction(fresh(), event);
    const twice = handleRuntimeEventAction(once, event);
    expect(flatBlocks(twice)).toEqual(flatBlocks(once));
    expect(JSON.stringify(flatBlocks(twice))).not.toContain('secret provider detail');
    expect(JSON.stringify(flatBlocks(twice))).toContain('credentials');
    expect(JSON.stringify(flatBlocks(twice))).toContain('context/output limits');
    expect(JSON.stringify(flatBlocks(twice))).toContain('/clear');
  });

  test('keeps the first terminal notice when completed, failed, and cancelled race', () => {
    const completed = {
      type: 'context.compaction_completed' as const,
      compactionId: 'race',
      sourceRevision: 0,
      checkpoint: {
        compactionId: 'race',
        version: 1 as const,
        sourceRevision: 0,
        sourceDigest: 'sha256:race',
        coveredThroughMessageId: 'message-1',
        coveredThroughTurnId: 'turn-1',
        summary: 'private narrative',
        inputTokensBefore: 5_000,
        inputTokensAfter: 1_000,
        reason: 'manual' as const,
        createdAt: '2026-07-22T00:00:00.000Z',
      },
    };
    const first = handleRuntimeEventAction(fresh(), completed);
    const failed = handleRuntimeEventAction(first, {
      type: 'context.compaction_failed',
      compactionId: 'race',
      sourceRevision: 0,
      errorKind: 'summary_model_failed',
      message: 'secret',
      retryable: true,
    });
    const cancelled = handleRuntimeEventAction(failed, {
      type: 'context.compaction_failed',
      compactionId: 'race',
      sourceRevision: 0,
      errorKind: 'summary_aborted',
      message: 'secret',
      retryable: false,
    });
    expect(flatBlocks(cancelled)).toEqual(flatBlocks(first));
    expect(JSON.stringify(flatBlocks(cancelled))).not.toContain('private narrative');
  });

  test('replaces Footer context data with each fresh Core projection after completion and reset', () => {
    const metrics = (totalInputTokens: number, utilization: number) => ({
      type: 'model.context_metrics' as const,
      modelName: 'configured-model',
      contextWindowTokens: 10_000,
      contextWindowSource: 'explicit_config' as const,
      reservedOutputTokens: 1_000,
      providerSafetyMarginTokens: 0,
      usableInputTokens: 9_000,
      totalInputTokens,
      utilization,
      status: 'normal' as const,
      estimate: {
        systemTokens: 100,
        toolSchemaTokens: 100,
        transcriptTokens: totalInputTokens - 400,
        summaryTokens: 0,
        dynamicRuntimeTokens: 100,
        framingTokens: 100,
        totalInputTokens,
      },
    });
    let state = handleRuntimeEventAction(fresh(), metrics(8_000, 8 / 9));
    expect(state.status.contextSnapshot?.estimate.totalInputTokens).toBe(8_000);
    state = handleRuntimeEventAction(state, {
      type: 'context.compaction_completed',
      compactionId: 'compact-footer',
      sourceRevision: 0,
      checkpoint: {
        compactionId: 'compact-footer',
        version: 1,
        sourceRevision: 0,
        sourceDigest: 'digest-footer',
        coveredThroughMessageId: 'message-1',
        coveredThroughTurnId: 'turn-1',
        summary: 'private narrative',
        inputTokensBefore: 26_124,
        inputTokensAfter: 11_186,
        reason: 'manual',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
    });
    expect(state.status.contextSnapshot).toMatchObject({
      estimate: { totalInputTokens: 11_186 },
      inputTokensBefore: 26_124,
      inputTokensAfter: 11_186,
      utilization: 11_186 / 9_000,
    });
    state = handleRuntimeEventAction(state, {
      type: 'context.compaction_reset',
      checkpointId: 'old',
      reason: 'manual',
    });
    state = handleRuntimeEventAction(state, metrics(3_000, 1 / 3));
    expect(state.status.contextSnapshot).toMatchObject({
      utilization: 1 / 3,
      estimate: { totalInputTokens: 3_000 },
    });
    expect(state.status.contextSnapshot?.activeCheckpointId).toBeUndefined();
    expect(state.status.contextSnapshot?.inputTokensBefore).toBeUndefined();
  });

  test('projects terminal tool status from ToolOutcomeV1 instead of the legacy result status', () => {
    let state = handleRuntimeEventAction(fresh(), {
      type: 'tool.queued',
      toolCallId: 'timeout-tool',
      name: 'shell_execute',
      args: { command: 'private' },
    });
    state = handleRuntimeEventAction(state, { type: 'tool.started', toolCallId: 'timeout-tool' });
    state = handleRuntimeEventAction(state, {
      type: 'tool.finished',
      toolCallId: 'timeout-tool',
      name: 'shell_execute',
      result: {
        ok: false,
        command: 'private',
        exitCode: 124,
        stdout: '',
        stderr: 'private',
        status: 'error',
      },
      outcomeV1: {
        schemaVersion: 1,
        status: 'timed_out',
        failure: { kind: 'tool_timeout', detailCode: 'timed_out' },
        dispatchState: 'started',
        externalEffects: 'unknown',
        recovery: {
          disposition: 'never',
          maximumAdditionalCalls: 0,
          requiresNewModelResponse: false,
          safeAutomaticRetry: false,
        },
        timing: { source: 'runtime_boundary', totalActiveMs: 25 },
      },
    });
    expect(flatBlocks(state)).toContainEqual(
      expect.objectContaining({
        kind: 'tool_card',
        callId: 'timeout-tool',
        status: 'timeout',
      }),
    );
  });
});
