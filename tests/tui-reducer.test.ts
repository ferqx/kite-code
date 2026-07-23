import { describe, expect, test } from 'bun:test';
import type { Action } from '../src/app/tui/App';
import { createInitialState, eventReducer } from '../src/app/tui/App';
import { buildToolSummaryLine } from '../src/app/tui/reducers/consolidateTools';
import {
  handleEventAction,
  handleRuntimeEventAction,
  type RenderEvent,
} from '../src/app/tui/reducers/handleEvent';
import type { InterruptState, OutputBlock, SessionSnapshot, TuiState } from '../src/app/tui/types';
import type { ToolApprovalPayload, UserInputPayload } from '../src/protocol/events';

function fresh(): TuiState {
  return createInitialState();
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
    event: { type: 'tool_call', data: { call_id: callId, name: name as any, args, status } },
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
      expect((flatBlocks(s)[0] as any).content).toBe('hello');
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

    test('updates the active Thought preview without ending the current exploration summary', () => {
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
        kind: 'thinking',
        text: 'second thought',
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
    test('tool_done marks intentional shell timeout separately from errors', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'shell_execute'));
      s = dispatch(s, tdEvt('c1', 'shell_execute', false, 'Command timed out after 10000ms.'));
      const t = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'tool_card' }>;
      expect(t.status).toBe('timeout');
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

    test('visible assistant text closes the current Thought before the next exploration tool', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }));
      s = dispatch(s, tdEvt('c1', 'read_file', true, 'a'));
      s = dispatch(s, textEvt('I checked that file.'));
      s = dispatch(s, tcEvt('c2', 'read_file', { path: 'b.txt' }));

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(2);
      expect(summaries[0]!.tools.map((t) => t.callId)).toEqual(['c1']);
      expect(summaries[0]!.active).toBe(false);
      expect(summaries[0]!.latestActivity).toBeUndefined();
      expect(summaries[1]!.tools.map((t) => t.callId)).toEqual(['c2']);
      expect(summaries[1]!.active).toBe(true);
    });

    test('late tool_started does not reactivate a Thought closed by assistant text', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('checking files'));
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'a.txt' }, 'queued'));
      s = dispatch(s, textEvt('I checked that file.'));
      s = dispatch(s, tsEvt('c1'));
      s = dispatch(s, tcEvt('c2', 'shell_execute', { command: 'npm test' }));

      const summaries = flatBlocks(s).filter(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.active).toBe(false);
      expect(summaries[0]!.latestActivity).toBeUndefined();
      expect(summaries[0]!.tools[0]!.status).toBe('running');
      expect(s.currentThoughtSummaryId).toBeUndefined();
      expect(flatBlocks(s).some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(true);
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

    test('inspect shell search with search prefix is consolidated into Thought', () => {
      let s = fresh();
      s = dispatch(s, tcEvt('c1', 'read_file', { path: 'ROADMAP.md' }));
      s = dispatch(
        s,
        tcEvt('c2', 'shell_execute', {
          intent: 'inspect',
          command: 'find /Users/chenchao/Code/ai/openpx-new/src -type f | sort',
        }),
      );

      const blocks = flatBlocks(s);
      const summary = blocks.find(
        (b): b is Extract<OutputBlock, { kind: 'tool_summary' }> => b.kind === 'tool_summary',
      );

      // Both c1 and c2 are now exploration tools → consolidated into the same Thought
      expect(summary).toBeDefined();
      expect(summary!.tools.map((t) => t.callId)).toEqual(['c1', 'c2']);
      expect(summary!.active).toBe(true);
      expect(blocks.some((b) => b.kind === 'tool_card' && b.callId === 'c2')).toBe(false);
      expect(s.currentThoughtSummaryId).toBe(summary!.id);
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
    test('appends text block for model_retry', () => {
      const s = dispatch(fresh(), {
        type: 'EVENT',
        event: {
          type: 'model_retry',
          data: { attempt: 2, maxAttempts: 5, error: 'rate limit', delayMs: 1000 },
        },
      });
      expect(flatBlocks(s)[0]!.kind).toBe('text');
      expect((flatBlocks(s)[0] as any).content).toContain('Model retry #2/5');
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
      expect((flatBlocks(s)[0] as any).content).toBe('done');
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
        (b) =>
          b.kind === 'text' && (b as any).content === '我看了你的项目环境，这是 Kite Code 项目本身',
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
      const textBlocks = flatBlocks(s).filter(
        (b) => b.kind === 'text' && (b as any).content === '分析完成',
      );
      expect(textBlocks).toHaveLength(1);
    });
  });

  describe('EVENT.need_approval / need_input + RESOLVE_INTERRUPT', () => {
    test('appends approval block and sets interrupt', () => {
      const a = approval({ command: 'rm -rf /' });
      const s = dispatch(fresh(), { type: 'EVENT', event: { type: 'need_approval', data: a } });
      expect(flatBlocks(s)).toHaveLength(1);
      expect(flatBlocks(s)[0]!.kind).toBe('approval');
      expect(s.interrupt?.kind).toBe('approval');
      expect((s.interrupt as any)?.blockId).toBe(flatBlocks(s)[0]!.id);
    });
    test('appends question block and sets interrupt', () => {
      const q = question({ question: 'Choose color' });
      const s = dispatch(fresh(), { type: 'EVENT', event: { type: 'need_input', data: q } });
      expect(flatBlocks(s)[0]!.kind).toBe('question');
      expect(s.interrupt?.kind).toBe('input');
    });
    test('RESOLVE_INTERRUPT marks approval as resolved and clears interrupt', () => {
      let s = fresh();
      const a = approval();
      s = dispatch(s, { type: 'EVENT', event: { type: 'need_approval', data: a } });
      const blockId = (s.interrupt as { blockId: number }).blockId;
      s = dispatch(s, {
        type: 'RESOLVE_INTERRUPT',
        blockId,
        resolution: { action: 'approved', grant: 'approve_once' },
      });
      const b = flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'approval' }>;
      expect(b.resolved?.action).toBe('approved');
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
      expect(card).toMatchObject({ status: 'done', userInput: { answer: 'auto' } });
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
      expect((flatBlocks(s)[0] as any).content).toContain('boom');
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
      expect((flatBlocks(s)[0] as any).folded).toBe(true);
      s = dispatch(s, { type: 'TOGGLE_REASON', id });
      expect((flatBlocks(s)[0] as any).folded).toBe(false);
    });
    test('TOGGLE_ALL_REASON toggles all reason blocks folded', () => {
      let s = fresh();
      s = dispatch(s, reasonEvt('first'));
      s = dispatch(s, textEvt('between'));
      s = dispatch(s, reasonEvt('second'));
      // First block auto-expanded on non-reason event, second still folded
      expect((flatBlocks(s)[0] as any).folded).toBe(false);
      expect((flatBlocks(s)[2] as any).folded).toBe(true);
      // Toggle: collapse all (anyExpanded → fold all)
      s = dispatch(s, { type: 'TOGGLE_ALL_REASON' });
      expect((flatBlocks(s)[0] as any).folded).toBe(true);
      expect((flatBlocks(s)[2] as any).folded).toBe(true);
      // Toggle: expand all (none expanded → unfold all)
      s = dispatch(s, { type: 'TOGGLE_ALL_REASON' });
      expect((flatBlocks(s)[0] as any).folded).toBe(false);
      expect((flatBlocks(s)[2] as any).folded).toBe(false);
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
    test('ESCAPE clears interrupt without stopping session', () => {
      let s = fresh();
      s = { ...s, interrupt: { kind: 'approval', blockId: 99 } };
      s = dispatch(s, { type: 'ESCAPE' });
      expect(s.interrupt).toBeNull();
    });
    test('ESCAPE when running with interrupt cancels interrupt, keeps running', () => {
      let s = fresh();
      s = { ...s, running: true, interrupt: { kind: 'approval', blockId: 99 } };
      s = dispatch(s, { type: 'ESCAPE' });
      expect(s.interrupt).toBeNull();
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
        event: { type: 'need_plan_review' as any, data: eventPayload },
      };
      let s = dispatch(fresh(), event);
      // No plan_review block created (plan content shown via update_plan tool_card)
      const block = flatBlocks(s).find((b: any) => b.kind === 'plan_review');
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
        event: { type: 'need_plan_review' as any, data: eventPayload },
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
        executionMode: 'auto',
      });

      expect(s.status.plan).toEqual(plan);
      expect(s.status.pendingPlan).toBeNull();

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
          type: 'tool_call' as any,
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
      const cards = flatBlocks(s).filter(
        (b: any) => b.kind === 'tool_card' && b.name === 'update_plan',
      );
      expect(cards.length).toBe(1);
      const card = cards[0] as any;
      expect(card.status).toBe('running');
      expect(card.summary).toBe('');
      expect(card.expanded).toBeUndefined();

      // Then fire need_plan_review
      s = dispatch(s, {
        type: 'EVENT',
        event: {
          type: 'need_plan_review' as any,
          data: {
            plan: {
              name: 'Test Plan',
              description: 'A great plan',
              status: 'pending' as const,
              steps: [{ step: 'Do thing', status: 'pending' as const }],
            },
          },
        },
      });
      const doneCards = flatBlocks(s).filter(
        (b: any) => b.kind === 'tool_card' && b.name === 'update_plan',
      );
      expect(doneCards.length).toBe(1);
      const doneCard = doneCards[0] as any;
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
    test('SELECT_MODEL sets modelName and closes selector', () => {
      let s = fresh();
      s = { ...s, showModelSelector: true };
      s = dispatch(s, { type: 'SELECT_MODEL', modelId: 'gpt-4o' });
      expect(s.status.modelName).toBe('gpt-4o');
      expect(s.showModelSelector).toBe(false);
    });
    test('USER_MESSAGE appends user block', () => {
      let s = fresh();
      s = dispatch(s, { type: 'USER_MESSAGE', text: 'Hello, AI' });
      expect(flatBlocks(s)).toHaveLength(1);
      expect(flatBlocks(s)[0]!.kind).toBe('user');
      expect((flatBlocks(s)[0] as any).content).toBe('Hello, AI');
    });
    test('NEW_SESSION clears blocks, resets state, increments sessionKey', () => {
      let s = fresh();
      s = {
        ...s,
        turns: [{ blocks: [{ id: 1, kind: 'text', content: 'old' }] }],
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
      expect(flatBlocks(s).some((block) => block.kind === 'text' && block.streaming)).toBe(true);

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
    test('streaming text appends new block when last block is not streaming text', () => {
      let s = fresh();
      s = { ...s, running: true };
      // First text (streaming)
      s = dispatch(s, textEvt('Hello'));
      // Tool card interleaved
      s = dispatch(s, tcEvt('c1', 'read_file'));
      // Next text should be a new block (last is tool_card, not streaming text)
      s = dispatch(s, textEvt('After tool'));
      expect(flatBlocks(s)).toHaveLength(3);
      expect((flatBlocks(s)[0] as Extract<OutputBlock, { kind: 'text' }>).content).toBe('Hello');
      expect(
        flatBlocks(s)[1]!.kind === 'tool_card' || flatBlocks(s)[1]!.kind === 'tool_summary',
      ).toBe(true);
      expect((flatBlocks(s)[2] as Extract<OutputBlock, { kind: 'text' }>).content).toBe(
        'After tool',
      );
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

  describe('REVERT_TO_CHECKPOINT / FORK_FROM_CHECKPOINT', () => {
    test('REVERT_TO_CHECKPOINT closes panel and increments rewindCounter', () => {
      let s = fresh();
      s = { ...s, showRewind: true, rewindCounter: 0 };
      s = dispatch(s, { type: 'REVERT_TO_CHECKPOINT', checkpointId: 'ck1' });
      expect(s.showRewind).toBe(false);
      expect(s.rewindCounter).toBe(1);
    });
    test('FORK_FROM_CHECKPOINT closes panel and increments rewindCounter', () => {
      let s = fresh();
      s = { ...s, showRewind: true, rewindCounter: 5 };
      s = dispatch(s, { type: 'FORK_FROM_CHECKPOINT', checkpointId: 'ck1' });
      expect(s.showRewind).toBe(false);
      expect(s.rewindCounter).toBe(6);
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
        event: { type: 'subagent_done', data: { id, summary, toolCallCount, durationMs } },
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
  });

  describe('RUNTIME_EVENT message-list pipeline', () => {
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

    test('renders approval, user input, and plan review as distinct interaction blocks', () => {
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
      expect(flatBlocks(approvalState).at(-1)?.kind).toBe('approval');
      expect(approvalState.interrupt?.kind).toBe('approval');

      const inputState = dispatch(fresh(), { type: 'RUNTIME_EVENT', event: inputEvent });
      expect(flatBlocks(inputState).at(-1)?.kind).toBe('question');
      expect(inputState.interrupt?.kind).toBe('input');

      const reviewState = dispatch(fresh(), { type: 'RUNTIME_EVENT', event: reviewEvent });
      expect(reviewState.interrupt?.kind).toBe('plan_review');
      expect(reviewState.status.pendingPlan?.name).toBe('Plan');
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

describe('context compaction RuntimeEvent rendering', () => {
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
    expect(JSON.stringify(flatBlocks(twice))).toContain('contextWindowTokens');
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
});
