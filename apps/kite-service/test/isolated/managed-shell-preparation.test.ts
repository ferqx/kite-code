import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxPreparationArtifactStore } from '@kite-ai/builtin-runtime/sandbox';
import {
  createRuntimeHostStateInitialState,
  planRuntimeBudgetAdmission,
  UNBOUNDED_PRIMARY_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { SandboxPreparationLifecycle } from '@kite-ai/runtime-spi';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { executeTestRuntimeTool } from '../../../../tests/helpers/runtime-model';
import {
  ManagedShellRuntime,
  managedShellOwnerKey,
  managedShellRuntime,
} from '../../src/bootstrap/runtime/managed-shell';
import { composeAppSandboxExecutor } from '../../src/sandbox/composition';
import { appPreparedShellExecutionPort } from '../../src/sandbox/prepared-tool-pipeline';

async function executeApprovedShell(request: Parameters<typeof executeTestRuntimeTool>[0]) {
  const pending = await executeTestRuntimeTool(request);
  if (pending.result) return pending;
  const approval = pending.events.find((event) => event.type === 'approval.requested');
  if (approval?.type !== 'approval.requested') throw new Error(JSON.stringify(pending.events));
  const prompt = pending.state.pendingApprovals.get(approval.interactionId)!;
  const approved = reduceRuntimeState(pending.state, {
    type: 'approval.granted',
    interactionId: approval.interactionId,
    toolCallId: pending.toolCallId,
    grant: 'approve_once',
    receiptId: `receipt:${approval.interactionId}:${prompt.generation}`,
    generation: prompt.generation,
    owner: approval.owner,
  });
  return executeTestRuntimeTool({ ...request, state: approved });
}

test.skipIf(process.platform !== 'darwin')(
  'main Run without an explicit timeout dispatches and cleans up a Native finite Shell',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-main-native-no-deadline-')));
    const threadId = 'main-native-no-deadline';
    const ownerKey = managedShellOwnerKey(threadId, root);
    try {
      let state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0'.repeat(64),
        threadId,
        userId: 'test',
        workspace: root,
        interactionMode: 'full',
      });
      state = reduceRuntimeState(state, {
        type: 'resource_budget.configured',
        runId: state.turn.turnId,
        startedAt: new Date().toISOString(),
        deadlineAt: null,
        budget: UNBOUNDED_PRIMARY_RESOURCE_BUDGET_,
      });
      const artifacts = new SandboxPreparationArtifactStore({
        root: join(root, 'sandbox-preparations'),
      });
      const shellExecutor = composeAppSandboxExecutor({
        entrypoint: 'tui',
        workspace: root,
        config: { sandbox: { enabled: true } },
      });
      const execution = {
        shellExecutor,
        sandboxPreparationArtifacts: artifacts,
        sandboxAvailable: true,
      };
      const args = { command: 'sleep 0.05; printf main-native-without-deadline', yield_ms: 0 };
      state.tools.calls['main-native-shell'] = {
        toolCallId: 'main-native-shell',
        name: 'shell_execute',
        args,
        status: 'queued',
        modelMessageId: 'main-model-message',
        modelInvocationId: 'main-model',
        createdAtTurnId: state.turn.turnId,
      };
      state.tools.queue = ['main-native-shell'];
      const admission = planRuntimeBudgetAdmission(state, {
        type: 'run_tools',
        toolCallIds: ['main-native-shell'],
      });
      if (admission.status !== 'admitted') throw new Error('Main Shell was not admitted.');
      state = [...admission.preparationEvents, ...admission.dispatchEvents].reduce(
        reduceRuntimeState,
        state,
      );
      const launched = await executeApprovedShell({
        workspace: root,
        state,
        toolName: 'shell_execute',
        toolCallId: 'main-native-shell',
        args,
        execution,
      });
      if (!launched.result) throw new Error(JSON.stringify(launched.events));
      expect(launched.result).toMatchObject({ ok: true, resultMeta: { shellStatus: 'running' } });
      const capability = Object.values(launched.state.capabilities.invocations).find(
        (invocation) => invocation.toolCallId === launched.toolCallId,
      )!;
      expect(capability.sandboxExecutionDispatch?.status).toBe('supervisor_started');
      const read = await managedShellRuntime.readWaiting({
        ownerKey,
        shellId: launched.result!.resultMeta!.shellId!,
        waitUntil: 'terminal',
      });
      expect(read.stdout).toContain('main-native-without-deadline');
      expect(launched.events).toContainEqual(
        expect.objectContaining({
          type: 'capability.sandbox_disposal_completed',
          disposed: true,
        }),
      );
    } finally {
      await managedShellRuntime.disposeOwner(ownerKey);
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform !== 'darwin')(
  'yield zero waits for durable Native supervisor acknowledgement and retains managed cleanup',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-managed-preparation-')));
    const workspace = root;
    const shellExecutor = composeAppSandboxExecutor({
      entrypoint: 'tui',
      workspace,
      config: { sandbox: { enabled: true } },
    });
    const artifacts = new SandboxPreparationArtifactStore({
      root: join(root, 'sandbox-preparations'),
    });
    const execution = {
      shellExecutor,
      sandboxPreparationArtifacts: artifacts,
      sandboxAvailable: true,
    };
    try {
      const launched = await executeApprovedShell({
        workspace,
        toolName: 'shell_execute',
        toolCallId: 'native-yield-zero',
        args: { command: 'sleep 1; printf managed-command-completed', yield_ms: 0 },
        execution,
      });
      if (!launched.result) throw new Error(JSON.stringify(launched.events));
      expect(launched.result).toMatchObject({ ok: true, resultMeta: { shellStatus: 'running' } });
      const call = launched.result!.resultMeta!;
      if (!call.shellId) throw new Error('Managed Shell did not return its handle.');
      const capability = Object.values(launched.state.capabilities.invocations).find(
        (invocation) => invocation.toolCallId === launched.toolCallId,
      )!;
      expect(capability.sandboxPreparationReady).toBeDefined();
      expect(capability.sandboxExecutionDispatch?.status).toBe('supervisor_started');
      const completed = await executeTestRuntimeTool({
        workspace,
        toolName: 'shell_read',
        state: launched.state,
        args: { shell_id: call.shellId, wait_until: 'terminal' },
        execution,
      });
      expect(completed.result?.stdout).toContain('managed-command-completed');
      expect(completed.result?.stdout).not.toContain('acknowledgement failed');
      expect(
        launched.events.filter((event) => event.type === 'capability.sandbox_disposal_completed'),
      ).toHaveLength(1);
      const live = await executeApprovedShell({
        workspace,
        toolName: 'shell_execute',
        toolCallId: 'native-stop-zero',
        args: { command: 'sleep 30; printf must-not-complete', yield_ms: 0 },
        execution,
      });
      expect(live.result).toMatchObject({ ok: true, resultMeta: { shellStatus: 'running' } });
      const liveId = live.result?.resultMeta?.shellId;
      if (!liveId) throw new Error('Managed Shell did not return its stop handle.');
      const cancelled = await executeTestRuntimeTool({
        workspace,
        toolName: 'shell_stop',
        state: live.state,
        args: { shell_id: liveId },
        execution,
      });
      expect(cancelled.result?.stdout).toContain('cancelled');
      expect(
        live.events.filter((event) => event.type === 'capability.sandbox_disposal_completed'),
      ).toHaveLength(1);
      const stopped = await executeTestRuntimeTool({
        workspace,
        toolName: 'shell_stop',
        state: completed.state,
        args: { shell_id: call.shellId },
        execution,
      });
      expect(stopped.result?.ok).toBe(true);
    } finally {
      await managedShellRuntime.disposeOwner(
        managedShellOwnerKey('test-thread:native-yield-zero', workspace),
      );
      await managedShellRuntime.disposeOwner(
        managedShellOwnerKey('test-thread:native-stop-zero', workspace),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);

test.skipIf(process.platform !== 'darwin')(
  'rejected Native preparation acknowledgement never publishes a running handle or sends GO',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-managed-preparation-failed-')));
    try {
      const shellExecutor = composeAppSandboxExecutor({
        entrypoint: 'tui',
        workspace: root,
        config: { sandbox: { enabled: true } },
      });
      const artifacts = new SandboxPreparationArtifactStore({
        root: join(root, 'sandbox-preparations'),
      });
      const result = await executeApprovedShell({
        workspace: root,
        toolName: 'shell_execute',
        toolCallId: 'native-ack-rejected',
        args: { command: 'printf GO > go-marker', yield_ms: 0 },
        execution: {
          shellExecutor,
          sandboxPreparationArtifacts: artifacts,
          sandboxAvailable: true,
          persistRuntimeEvents: async (events) =>
            !events.some((event) => event.type === 'capability.sandbox_preparation_ready'),
        },
      });
      expect(result.result).toMatchObject({ ok: false, resultMeta: { shellStatus: 'exited' } });
      expect(result.result?.stderr).toContain('preparation-ready acknowledgement failed');
      expect(existsSync(join(root, 'go-marker'))).toBe(false);
      expect(
        result.events.some(
          (event) => event.type === 'capability.sandbox_execution_dispatch_intent_recorded',
        ),
      ).toBe(false);
      expect(
        result.events.some(
          (event) => event.type === 'capability.sandbox_execution_supervisor_started',
        ),
      ).toBe(false);
      expect(
        result.events.filter(
          (event) => event.type === 'capability.sandbox_preparation_abandonment_completed',
        ),
      ).toHaveLength(1);
    } finally {
      await managedShellRuntime.disposeOwner(
        managedShellOwnerKey('test-thread:native-ack-rejected', root),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);

test.skipIf(process.platform === 'win32')(
  'explicit disabled Host Shell retains asynchronous yield without a sandbox supervisor receipt',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-managed-host-selected-')));
    const runtime = new ManagedShellRuntime();
    try {
      const shellExecutor = composeAppSandboxExecutor({
        entrypoint: 'tui',
        workspace: root,
        config: { sandbox: { enabled: false } },
      });
      const port = appPreparedShellExecutionPort(shellExecutor)!;
      let selected!: () => void;
      const started = new Promise<void>((resolve) => {
        selected = resolve;
      });
      let hostSelections = 0;
      const unavailable = async (): Promise<never> => {
        throw new Error('Host Shell must not issue sandbox lifecycle acknowledgements.');
      };
      const lifecycle: SandboxPreparationLifecycle = {
        recordPreparationIntent: unavailable,
        recordPreparationReady: unavailable,
        recordExecutionDispatchIntent: unavailable,
        recordExecutionSupervisorStarted: unavailable,
        recordDisposalIntent: unavailable,
        recordDisposalReceipt: unavailable,
      };
      const running = await runtime.start({
        ownerKey: 'disabled-host',
        yieldMs: 0,
        started,
        execute: async (signal, onProgress) => {
          const result = await port.execute({
            workspace: root,
            command: 'sleep 1; printf host-command-completed',
            signal,
            onProgress,
            identity: {
              toolCallId: 'host-call',
              capabilityId: 'builtin:shell_execute',
              capabilityRevision: 'host-shell',
              invocationId: 'host-invocation',
              attempt: 1,
              effectiveEffectsDigest: 'host-effects',
              admissionDigest: 'host-admission',
              cancellationCorrelation: 'host-cancellation',
            },
            lifecycle,
            onHostShellSelected: () => {
              hostSelections += 1;
              selected();
            },
          });
          if (result.status === 'running')
            throw new Error('Host port returned a nested running handle.');
          return result;
        },
      });
      expect(running.status).toBe('running');
      expect(hostSelections).toBe(1);
      const completed = await runtime.wait(running.shellId, 'disabled-host');
      expect(completed.result?.ok).toBe(true);
      expect(runtime.read(running.shellId, 'disabled-host').stdout).toContain(
        'host-command-completed',
      );
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
