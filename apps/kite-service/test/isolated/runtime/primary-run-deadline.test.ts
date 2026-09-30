import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { aiMessage } from '@kite-ai/builtin-runtime/model';
import {
  createRuntimeHostStateInitialState,
  LIMITED_RESOURCE_BUDGET_,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { StateHostSessionHarness } from '../../../../../scripts/support/runtime-host-state';
import { openHomeStateStoreForTest } from '../../../../../scripts/support/runtime-storage';
import { createMockModel } from '../../../../../tests/helpers/mock-model';
import { runTestRuntimeAgent } from '../../../../../tests/helpers/runtime-model';

for (const resume of [false, true]) {
  test(`main Run ${resume ? 'resumes beyond its old deadline' : 'starts without a total deadline'}`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-main-run-deadline-'));
    const storePath = join(workspace, 'kite.sqlite');
    const threadId = `main-deadline-${resume}`;
    const previousDeadlineAt = new Date(Date.now() - 1_800_000).toISOString();
    const originalSetTimeout = globalThis.setTimeout;
    let runDeadlineTimers = 0;
    try {
      if (resume) {
        const seed = new StateHostSessionHarness({
          store: openHomeStateStoreForTest(storePath, workspace),
          initialState: createRuntimeHostStateInitialState({
            recoveryIdentityKey: '0'.repeat(64),
            threadId,
            userId: 'test',
            workspace,
          }),
          interactionMode: 'accept_edits',
        });
        seed.processEventBatch([
          { type: 'user.message_appended', messageId: 'original-user', content: 'Keep working.' },
          { type: 'turn.started', turnId: 'original-main-run' },
          {
            type: 'resource_budget.configured',
            runId: 'original-main-run',
            startedAt: new Date(Date.parse(previousDeadlineAt) - 1_800_000).toISOString(),
            deadlineAt: previousDeadlineAt,
            budget: LIMITED_RESOURCE_BUDGET_,
          },
        ]);
        seed.close();
      }
      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        const [callback, delay, ...rest] = args;
        if (delay !== undefined && delay >= 1_700_000 && delay <= 1_800_000) {
          runDeadlineTimers += 1;
          return originalSetTimeout(callback, 1, ...rest);
        }
        return originalSetTimeout(callback, delay, ...rest);
      }) as typeof setTimeout;
      const model = createMockModel([
        { message: aiMessage({ content: 'Completed without a main Run deadline.' }), delay: 25 },
      ]);
      const events: RuntimeEvent[] = [];
      for await (const event of runTestRuntimeAgent(
        {
          task: 'Keep working.',
          threadId,
          userId: 'test',
          workspace,
          openStateRuntimeStorage: () => openHomeStateStoreForTest(storePath, workspace),
          model,
          ...(resume ? { resumeCommittedInteraction: true } : {}),
          config: {
            providerName: 'test',
            providerType: 'openai-compatible',
            apiKey: 'test',
            baseURL: 'http://localhost:1',
            modelName: 'test',
            sandbox: { enabled: false },
            features: { resourceBudget: true, boundedCancellation: true },
          },
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      ))
        events.push(event);
      expect(runDeadlineTimers).toBe(0);
      expect(events.some((event) => event.type === 'run.error')).toBe(false);
      expect(events.at(-1)?.type).toBe('turn.completed');
      const store = openHomeStateStoreForTest(storePath, workspace);
      try {
        const state = store.loadSnapshot<RuntimeState>(threadId)!;
        expect(state.resourceBudget).toMatchObject({
          status: 'active',
          deadlineAt: null,
          budget: {
            unboundedRunDuration: true,
            unboundedCumulativeUsage: true,
            maxRunDurationMs: 0,
          },
        });
        if (resume) {
          expect(state.turn.turnId).toBe('original-main-run');
          expect(state.resourceBudget).toMatchObject({ previousDeadlineAt });
          expect(
            events.filter((event) => event.type === 'resource_budget.run_deadline_removed'),
          ).toHaveLength(1);
          expect(
            events.filter((event) => event.type === 'resource_budget.configured'),
          ).toHaveLength(0);
          expect(
            state.transcript.messages.filter((message) => message.kind === 'user'),
          ).toHaveLength(1);
        } else {
          expect(events.find((event) => event.type === 'resource_budget.configured')).toMatchObject(
            {
              deadlineAt: null,
              budget: { unboundedRunDuration: true },
            },
          );
        }
      } finally {
        store.close();
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}
