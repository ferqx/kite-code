import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertAgentStateInvariants } from '@kite-ai/agent-kernel';
import { aiMessage } from '@kite-ai/builtin-runtime/model';
import type { RuntimeState } from '@kite-ai/runtime-host/kernel-adapter';
import { committedResourceUsage } from '@kite-ai/runtime-host/kernel-adapter';
import type { AuthorizedExecutionControl } from '#app/bootstrap/runtime/RuntimeSessionCoordinator';
import { readOsProcessStartIdentity } from '../../scripts/runtime/process-start-identity';
import { openStateStoreForTest } from '../../scripts/support/runtime-storage';
import { runTestRuntimeAgent } from '../helpers/runtime-model';
import { createMockModel } from '../mock-model';

interface FaultSoakLifecycleGlobal {
  __KITE_FAULT_SOAK_LIFECYCLE_SEQUENCE__?: number;
}

test('fault soak publishes the actual reconciled Runtime budget ledger', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.openpx-fault-soak-budget-receipt-'));
  let control: AuthorizedExecutionControl | null = null;
  let latestState: ReturnType<AuthorizedExecutionControl['getState']> | undefined;
  try {
    for await (const _event of runTestRuntimeAgent(
      {
        task: 'Return a bounded response.',
        threadId: `fault-soak-budget-receipt-${process.pid}`,
        userId: 'fault-soak',
        workspace,
        openStateRuntimeStorage: () => openStateStoreForTest(join(workspace, 'runtime.db')),
        model: createMockModel([{ message: aiMessage({ content: 'done' }) }]),
        config: {
          providerName: 'fault-soak',
          providerType: 'openai-compatible',
          apiKey: 'unused',
          baseURL: 'https://example.invalid',
          modelName: 'fixture',
          features: { resourceBudget: true },
          sandbox: { enabled: false },
        },
        sandboxBackend: 'unknown',
        onTestExecutionControl: (next) => {
          control = next;
        },
      },
      {
        requestAction: async (effect) => ({ type: 'cancel', interactionId: effect.interactionId }),
      },
    )) {
      const currentControl = control as AuthorizedExecutionControl | null;
      if (!currentControl) throw new Error('Runtime control surface was not installed');
      latestState = currentControl.getState();
      assertAgentStateInvariants(latestState as RuntimeState);
    }

    if (!latestState) throw new Error('Runtime did not expose a final state');
    assertAgentStateInvariants(latestState as RuntimeState);
    if (latestState.resourceBudget.status !== 'active') {
      throw new Error('Expected an active ResourceBudget ledger');
    }
    const committed = committedResourceUsage(latestState.resourceBudget);
    expect(latestState.resourceBudget.reconciledUsage.counters.modelRequests).toBeGreaterThan(0);
    expect(committed.counters.modelRequests).toBeGreaterThan(0);

    const telemetryFile = process.env.KITE_FAULT_SOAK_TELEMETRY_FILE;
    if (telemetryFile) {
      const sequence = (globalThis as FaultSoakLifecycleGlobal)
        .__KITE_FAULT_SOAK_LIFECYCLE_SEQUENCE__;
      if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence <= 0) {
        throw new Error('Fault-soak preload did not publish the current lifecycle sequence');
      }
      const reservationStates: Record<string, number> = {};
      for (const reservation of Object.values(latestState.resourceBudget.reservations)) {
        reservationStates[reservation.state] = (reservationStates[reservation.state] ?? 0) + 1;
      }
      appendFileSync(
        telemetryFile,
        `${JSON.stringify({
          version: 2,
          kind: 'runtime_budget_usage',
          pid: process.pid,
          sequence,
          iteration: Number(process.env.KITE_FAULT_SOAK_ITERATION ?? '0'),
          caseId: process.env.KITE_FAULT_SOAK_CASE_ID ?? 'long_runtime_replay',
          lifecycleId:
            process.env.KITE_FAULT_SOAK_LIFECYCLE_ID ?? 'fault-soak-runtime-budget.test.ts',
          processStartNonce: `${process.env.KITE_FAULT_SOAK_PROCESS_NONCE ?? 'unbound'}:${process.pid}`,
          osProcessStartIdentity: readOsProcessStartIdentity(process.pid),
          lifecycleGroupNonce: process.env.KITE_FAULT_SOAK_LIFECYCLE_GROUP_NONCE ?? 'unbound',
          source: 'actual_runtime_ledger',
          reconciled: latestState.resourceBudget.reconciledUsage,
          committed,
          ceilings: latestState.resourceBudget.budget,
          reservationStates,
        })}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
