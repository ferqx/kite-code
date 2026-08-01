import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@/core/config';
import { aiMessage } from '@/core/messages';
import { runRuntimeAgent } from '@/core/runtime/agent';
import type { RuntimeEvent } from '@/core/runtime/events';
import { resolveFailureModeV1 } from '@/core/runtime/failure-mode-conformance';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { LIMITED_RESOURCE_BUDGET_V1 } from '@/core/runtime/resource-budget';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';
import { createMockModel } from '../mock-model';

describe('Runtime run deadline', () => {
  test('aborts the unified execution signal and persists an error-caused turn abort', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-runtime-deadline-'));
    const storePath = join(directory, 'runtime.db');
    const threadId = 'deadline-run';
    try {
      const startedAt = new Date();
      // The provider must first receive the unified signal for this test to
      // prove propagation. A 300ms wall-clock window can expire while a busy
      // CI worker has descheduled this process, which only proves admission
      // stopped before the provider call. Match the interaction fixture's
      // scheduling margin so the intended boundary is deterministic.
      const deadlineAt = new Date(startedAt.getTime() + 1_500);
      const state = reduceRuntimeState(
        createInitialRuntimeState({ threadId, userId: 'u', workspace: directory }),
        {
          type: 'resource_budget.configured',
          runId: 'deadline-budget',
          startedAt: startedAt.toISOString(),
          deadlineAt: deadlineAt.toISOString(),
          budget: LIMITED_RESOURCE_BUDGET_V1,
        },
      );
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const model = createMockModel([]);
      let providerObservedAbort = false;
      let providerCalls = 0;
      model.model.doGenerate = async (options: { abortSignal?: AbortSignal }) => {
        providerCalls += 1;
        return new Promise((_, reject) => {
          const abort = () => {
            providerObservedAbort = true;
            reject(new DOMException('Runtime deadline exceeded.', 'AbortError'));
          };
          if (options.abortSignal?.aborted) abort();
          else options.abortSignal?.addEventListener('abort', abort, { once: true });
        });
      };
      const config: AgentConfig = {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'deadline-model',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        features: {
          resourceBudgetV1: true,
          boundedCancellationV1: true,
        },
        sandbox: { enabled: false },
      };
      const events: RuntimeEvent[] = [];

      for await (const event of runRuntimeAgent(
        {
          task: 'Wait until the bounded deadline.',
          userId: 'u',
          threadId,
          workspace: directory,
          runtimeStorePath: storePath,
          config,
          model,
          sandboxBackend: 'unknown',
        },
        {
          requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
        },
      )) {
        events.push(event);
      }

      expect(providerObservedAbort).toBe(true);
      expect(providerCalls).toBe(1);
      expect(events.some((event) => event.type === 'model.responded')).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.aborted',
          cause: 'error',
          reason: expect.stringContaining('deadline exceeded'),
        }),
      );
      const deadlineTerminal = events.find((event) => event.type === 'run.error');
      expect(deadlineTerminal?.type === 'run.error' ? deadlineTerminal.outcome : undefined).toEqual(
        resolveFailureModeV1('budget_exhausted', {
          knownExternalEffects: 'unknown',
        }).terminalOutcome!,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'run.error',
          failure: expect.objectContaining({ kind: 'budget_exceeded' }),
          outcome: expect.objectContaining({
            status: 'budget_exhausted',
            reasonCode: 'budget_exhausted',
          }),
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('wakes a pending interaction wait and emits one deadline terminal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-runtime-deadline-interaction-'));
    const storePath = join(directory, 'runtime.db');
    const threadId = 'deadline-interaction';
    try {
      const startedAt = new Date();
      // This fixture must reach requestAction before the deadline fires. The
      // full suite runs files concurrently on CI, so a 300ms wall-clock window
      // could expire while the process was descheduled and only prove the
      // earlier model-stage deadline path covered by the previous test.
      const deadlineAt = new Date(startedAt.getTime() + 1_500);
      const state = reduceRuntimeState(
        createInitialRuntimeState({ threadId, userId: 'u', workspace: directory }),
        {
          type: 'resource_budget.configured',
          runId: 'deadline-interaction-budget',
          startedAt: startedAt.toISOString(),
          deadlineAt: deadlineAt.toISOString(),
          budget: LIMITED_RESOURCE_BUDGET_V1,
        },
      );
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const model = createMockModel([
        {
          message: aiMessage({
            content: '',
            tool_calls: [
              {
                id: 'ask-before-deadline',
                name: 'ask_user',
                args: {
                  questions: [
                    {
                      question: 'Continue waiting?',
                      options: [
                        { label: 'Continue', description: 'Continue the run.' },
                        { label: 'Stop', description: 'Stop the run.' },
                      ],
                    },
                  ],
                },
              },
            ],
          }),
        },
      ]);
      const config: AgentConfig = {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'deadline-model',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        features: {
          resourceBudgetV1: true,
          boundedCancellationV1: true,
        },
        sandbox: { enabled: false },
      };
      let waiting = false;
      const events: RuntimeEvent[] = [];
      const consume = async () => {
        for await (const event of runRuntimeAgent(
          {
            task: 'Ask and wait.',
            userId: 'u',
            threadId,
            workspace: directory,
            runtimeStorePath: storePath,
            config,
            model,
            sandboxBackend: 'unknown',
          },
          {
            requestAction: async () => {
              waiting = true;
              return new Promise(() => {});
            },
          },
        )) {
          events.push(event);
        }
      };

      await Promise.race([
        consume(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Interaction deadline did not terminate.')), 5_000),
        ),
      ]);

      expect(waiting).toBe(true);
      expect(events.filter((event) => event.type === 'run.error')).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'run.error',
          failure: expect.objectContaining({ kind: 'budget_exceeded' }),
          outcome: expect.objectContaining({ reasonCode: 'budget_exhausted' }),
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('does not let a slow consumer abort an atomically completed turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openpx-runtime-deadline-complete-'));
    const storePath = join(directory, 'runtime.db');
    const threadId = 'deadline-completed';
    try {
      const startedAt = new Date();
      const state = reduceRuntimeState(
        createInitialRuntimeState({ threadId, userId: 'u', workspace: directory }),
        {
          type: 'resource_budget.configured',
          runId: 'deadline-completed-budget',
          startedAt: startedAt.toISOString(),
          deadlineAt: new Date(startedAt.getTime() + 300).toISOString(),
          budget: LIMITED_RESOURCE_BUDGET_V1,
        },
      );
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();
      const config: AgentConfig = {
        apiKey: 'unused',
        baseURL: 'https://example.invalid',
        modelName: 'deadline-model',
        providerName: 'fixture',
        providerType: 'openai-compatible',
        features: {
          resourceBudgetV1: true,
          boundedCancellationV1: true,
        },
        sandbox: { enabled: false },
      };
      const events: RuntimeEvent[] = [];

      for await (const event of runRuntimeAgent(
        {
          task: 'Finish before the deadline.',
          userId: 'u',
          threadId,
          workspace: directory,
          runtimeStorePath: storePath,
          config,
          model: createMockModel([{ message: aiMessage({ content: 'Done.' }) }]),
          sandboxBackend: 'unknown',
        },
        {
          requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
        },
      )) {
        events.push(event);
        if (event.type === 'run.completed') {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }

      expect(events.some((event) => event.type === 'run.error')).toBe(false);
      expect(events.some((event) => event.type === 'turn.aborted')).toBe(false);
      expect(events.at(-2)).toMatchObject({ type: 'run.completed' });
      expect(events.at(-1)).toMatchObject({ type: 'turn.completed' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
