import { createHash } from 'node:crypto';
import type { Execution, Message, ModelOutputSnapshot, SessionView } from '@kite-ai/client';
import { TuiSession, type TuiSnapshot } from '@kite-ai/ui/tui';
import { render } from 'ink';
import {
  displayExecution as baseDisplayExecution,
  createPresentationController,
  DISPLAY_SESSION,
  DISPLAY_STORE,
  displayMessage,
  displayRun,
  displaySnapshot,
  displayView,
} from './new-ui-presentation-port';

// This is the original synthetic display-material journey. Its port supplies qualified
// UI snapshots; it neither runs a model nor claims production business completion.
const mode = process.env.KITE_LIVE_SCROLL_CASE ?? 'mixed';
// These are synthetic display facts, using the public Core ownership contract.
// In particular ordinary Job carriers are runless and retain their original work.
const displayExecution = (id: string, extra: Partial<Execution> = {}) =>
  baseDisplayExecution(id, { rootWorkCommandId: 'display-origin', rootWorkSeq: '1', ...extra });
const startedAt = Date.now();
const history = Array.from({ length: 70 }, (_, index) =>
  displayMessage(`history-${index}`, index + 1, `HISTORY_${index} immutable line`),
);
let tick = 0;
function read(): TuiSnapshot {
  const settled = tick === 8;
  const messages: Message[] = [...history];
  const executions: Execution[] = [];
  const childViews: NonNullable<TuiSnapshot['childViews']>[number][] = [];
  const jobTails: NonNullable<TuiSnapshot['jobTails']>[number][] = [];
  const executionTimings: Record<string, NonNullable<TuiSnapshot['executionTimings']>[string]> = {};
  const modelMessages = (
    id: string,
    calls: NonNullable<Message['toolCalls']>,
    reasoning = '',
    active = false,
  ) => {
    const model = displayExecution(id, {
      kind: 'model',
      definitionId: 'fixture-model',
      status: active ? 'running' : 'succeeded',
      result: active ? null : { content: '', reasoning, toolCalls: calls, complete: true },
    });
    executions.push(model);
    messages.push(
      displayMessage(`message-${id}`, messages.length + 1, '', {
        runId: 'display-run',
        sourceIds: [id],
        toolCalls: calls,
        status: active ? 'incomplete' : 'complete',
        firstOutput: reasoning ? 'reasoning' : 'tool_calls',
      }),
    );
    executionTimings[id] = {
      availability: 'recorded_dispatch',
      startedAt: startedAt + tick * 600,
      ...(!active ? { finishedAt: startedAt + tick * 600 } : {}),
    };
    return model;
  };
  let liveModelOutput: ModelOutputSnapshot | undefined;
  if (mode === 'thinking' || mode === 'tools' || mode === 'mixed') {
    // Each source is an independent invocation. Earlier invocations are sealed,
    // while the current display source alternates thinking and tool activity.
    for (let generation = 0; generation <= tick; generation++) {
      const current = generation === tick;
      const readCount = generation % 2 === 0 ? 1 : 7;
      const calls = Array.from({ length: readCount }, (_, index) => ({
        id: `read-${generation}-${index}`,
        name: 'read_file',
        arguments: JSON.stringify({ path: `read-${generation}-${index}.ts` }),
      }));
      const reasoning =
        mode !== 'tools' && generation % 2 === 0
          ? Array.from({ length: 7 }, (_, index) => `THINKING_${generation}_${index}`).join('\n')
          : '';
      const activeReason = current && !settled && reasoning.length > 0;
      const model = modelMessages(`thinking-model-${generation}`, calls, reasoning, activeReason);
      executionTimings[model.id] = {
        availability: 'recorded_dispatch',
        startedAt: startedAt + generation * 600,
        ...(!activeReason
          ? {
              finishedAt:
                startedAt +
                generation * 600 +
                Math.min(600, Math.max(0, Date.now() - startedAt - generation * 600)),
            }
          : {}),
      };
      for (const call of calls)
        executions.push(
          displayExecution(call.id, {
            toolCallId: call.id,
            toolInput: JSON.parse(call.arguments),
            status: !current || settled || activeReason ? 'succeeded' : 'running',
            result: !current || settled || activeReason ? { content: 'Read fixture' } : null,
            parentExecutionId: model.id,
          }),
        );
      if (activeReason)
        liveModelOutput = {
          storeId: DISPLAY_STORE,
          sessionId: DISPLAY_SESSION,
          rootSessionId: DISPLAY_SESSION,
          runId: 'display-run',
          executionId: model.id,
          originCommandId: 'display-origin',
          rootWorkCommandId: 'display-origin',
          rootWorkSeq: '1',
          attempt: 1,
          status: 'running',
          snapshotCursor: '1',
          bodyHash: 'a'.repeat(64),
          bodyBytes: '0',
          contentBytes: '0',
          reasoningBytes: String(Buffer.byteLength(reasoning)),
          output: { content: '', reasoning, toolCalls: calls, complete: false },
        };
    }
  }
  if (mode === 'shell' || mode === 'mixed' || mode === 'approved-shells') {
    const count = mode === 'approved-shells' ? 3 : 1;
    const calls = Array.from({ length: count }, (_, index) => ({
      id: `shell-${index}`,
      name: 'shell_execute',
      arguments: JSON.stringify({
        command: mode === 'approved-shells' ? `SHELL_${index}` : 'fixture',
      }),
    }));
    modelMessages('shell-model', calls);
    for (const [index, call] of calls.entries()) {
      const started = mode !== 'approved-shells' || tick >= index * 2;
      const done = settled || (mode === 'approved-shells' && index === 0 && tick >= 6);
      const parent = displayExecution(call.id, {
        definitionId: 'builtin.shell/shell.launch',
        toolCallId: call.id,
        toolInput: JSON.parse(call.arguments),
        status: 'succeeded',
        result: { content: 'Job started' },
        parentExecutionId: 'shell-model',
      });
      const job = displayExecution(`job-${index}`, {
        kind: 'job',
        runId: null,
        definitionId: 'builtin.shell/shell.command',
        parentExecutionId: parent.id,
        status: done ? 'succeeded' : started ? 'running' : 'planned',
        result: done ? { content: 'Completed' } : null,
      });
      executions.push(parent, job);
      if (started) {
        executionTimings[job.id] = {
          availability: 'recorded_dispatch',
          startedAt: startedAt + index * 1200,
          ...(done ? { finishedAt: startedAt + index * 1200 + 3600 } : {}),
        };
        jobTails.push({
          executionId: job.id,
          content:
            mode === 'approved-shells'
              ? `OUTPUT_${index}_${tick}`
              : Array.from(
                  { length: tick % 2 === 0 ? 8 : 1 },
                  (_, line) => `LIVE_${tick}_${line}`,
                ).join('\n'),
          totalLines: tick % 2 === 0 ? 8 : 1,
        });
      }
    }
  }
  if (mode === 'subagents' || mode === 'mixed') {
    const calls = Array.from({ length: 4 }, (_, index) => ({
      id: `task-${index}`,
      name: 'task',
      arguments: JSON.stringify({
        role: 'explore',
        key: `child-${index}`,
        input: `Child ${index}`,
      }),
    }));
    modelMessages('children-model', calls);
    for (const [index, call] of calls.entries()) {
      const childId = `child-${index}`;
      executions.push(
        displayExecution(call.id, {
          definitionId: 'builtin.task/task',
          toolCallId: call.id,
          toolInput: JSON.parse(call.arguments),
          status: 'succeeded',
          result: { content: 'Agent started' },
          parentExecutionId: 'children-model',
        }),
      );
      const carrier = displayExecution(`carrier-${index}`, {
        kind: 'job',
        runId: null,
        definitionId: 'fixture-child',
        parentExecutionId: call.id,
        childSessionId: childId,
        status: settled ? 'succeeded' : 'running',
        result: settled ? { content: 'Done' } : null,
      });
      executions.push(carrier);
      const step = displayExecution(`child-step-${index}`, {
        sessionId: childId,
        toolCallId: `child-call-${index}`,
        toolInput: { path: `file-${tick}.ts` },
        status: settled ? 'succeeded' : 'running',
      });
      const child: SessionView = {
        ...displayView([], [step]),
        session: {
          ...displayView().session,
          id: childId,
          parentSessionId: DISPLAY_SESSION,
          rootSessionId: DISPLAY_SESSION,
        },
      };
      childViews.push({ executionId: carrier.id, view: child });
      executionTimings[carrier.id] = {
        availability: 'recorded_dispatch',
        startedAt,
        ...(settled ? { finishedAt: startedAt + 4800 } : {}),
      };
    }
  }
  if (settled)
    messages.push(
      displayMessage('settled', messages.length + 1, 'SETTLED_DONE', { runId: 'display-run' }),
    );
  const interactions: TuiSnapshot['interactions'] =
    mode === 'approved-shells' && tick < 4
      ? [
          {
            id: tick < 2 ? 'approval-1' : 'approval-2',
            originStoreId: DISPLAY_STORE,
            sessionId: DISPLAY_SESSION,
            runId: 'display-run',
            executionId: tick < 2 ? 'job-1' : 'job-2',
            attempt: 1,
            presentationSessionId: DISPLAY_SESSION,
            ancestry: [],
            kind: 'approval',
            definitionId: 'fixture-shell',
            definitionVersion: '1',
            inputDigest: createHash('sha256').update(`approval-${tick}`).digest('hex'),
            policyRevision: 'fixture-policy',
            requiredRefs: [],
            request: {
              command: `Approve shell-${tick < 2 ? 1 : 2}`,
              title: 'shell_execute',
              summary: 'Approve this command',
            },
            answer: null,
            revision: String(tick),
            acceptedDecisionRevision: null,
            state: 'pending',
          },
        ]
      : [];
  return {
    ...displaySnapshot(messages, executions, [displayRun(!settled, startedAt)]),
    interactions,
    executionTimings,
    childViews,
    jobTails,
    ...(liveModelOutput
      ? {
          liveModelOutput: {
            ...liveModelOutput,
            bodyHash: createHash('sha256')
              .update(JSON.stringify(liveModelOutput.output))
              .digest('hex'),
            bodyBytes: String(Buffer.byteLength(JSON.stringify(liveModelOutput.output))),
          },
        }
      : {}),
  };
}
const controller = createPresentationController(read);
await controller.select(DISPLAY_SESSION);
const app = render(<TuiSession controller={controller} onQuit={() => app.unmount()} />, {
  interactive: true,
  incrementalRendering: false,
  exitOnCtrlC: true,
});
const timer = setInterval(() => {
  tick++;
  void controller.select(DISPLAY_SESSION);
  if (tick === 8) clearInterval(timer);
}, 600);
await app.waitUntilExit();
clearInterval(timer);
controller.dispose();
