import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { InteractionRecord } from '@kite-ai/agent/storage';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createDefaultProcessConfiguration } from '../../../apps/service/src/configuration';
import { initializeLivePermissionFixture } from '../../../apps/service/test/fixtures/live-permission-fixture';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../fixtures/test-filesystem';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: object): ModelEvent => ({
  type: 'tool_call',
  id: crypto.randomUUID(),
  name,
  arguments: JSON.stringify(input),
});
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Real default policies and native file engine, not paid live providers or UI.
// Active-parent continuation and independent public input roots are separate cases.
const cases = (['accept_edits', 'auto'] as const).flatMap((mode) =>
  (['active_parent', 'run.start', 'input.follow_up'] as const).map((followupKind) => ({
    mode,
    followupKind,
  })),
);
for (const { mode, followupKind } of cases) {
  test(`current window file tools preserve exact two-child approvals: ${mode}, ${followupKind}`, async () => {
    const root = temporaryDirectory('kite-window-file-tools-');
    const workspace = join(root, 'workspace');
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    privateDirectory(workspace);
    privateDirectory(profile.profilePath);
    const targets = ['A', 'B', 'C'].map((label) => join(root, `external-${label}.txt`));
    const bodies = ['A', 'B', 'C'].map((label) => `exact-${label}-${crypto.randomUUID()}\n`);
    const configPath = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      configPath,
      JSON.stringify({
        modelId: 'controlled',
        models: [
          {
            id: 'controlled',
            provider: 'compatible',
            model: 'never-network',
            baseURL: 'http://127.0.0.1:1/v1',
          },
        ],
        tools: ['files.write', 'task.spawn', 'task.follow_up', 'task.events'].map((id) => ({ id })),
      }),
    );
    const reviews: string[] = [];
    const reviewer: ModelAdapter = {
      async *stream(request) {
        const input = request.messages.flatMap((message) => {
          if (message.role !== 'user') return [];
          try {
            const value = JSON.parse(message.content);
            return value.purpose === 'authorization_check' ? [value] : [];
          } catch {
            return [];
          }
        });
        expect(request.tools).toEqual([]);
        expect(input).toHaveLength(1);
        expect(['files.write', 'task.follow_up']).toContain(input[0].target.definitionId);
        reviews.push(input[0].target.definitionId);
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            decision: 'ask_user',
            reason: 'Confirm this exact synthetic operation.',
          }),
        };
        yield finish;
      },
    };
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: configPath,
      localCodex: false,
      browser: false,
      credentialBackend: createTemporaryCredentialBackend(),
      authorizationCheck: {
        id: 'controlled-review',
        version: '1',
        modelId: 'controlled',
        model: reviewer,
      },
    });
    const store = await openSqliteStore(profile);
    const locks = createWorkspaceSerialLocks(profile);
    host.bindWorkspaceSerialLocks?.(locks);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const identity = { expectedStoreId, subjectId: 'owner' };
    const modelSteps = new Map<string, number>();
    let childA = '';
    let followupDispatched = false;
    let parentPaused = false;
    let releaseFollowup!: () => void;
    const followupReady = new Promise<void>((resolve) => {
      releaseFollowup = resolve;
    });
    const seenInputs: { path: string; input: object }[] = [];
    const model: ModelAdapter = {
      async *stream(request, context) {
        const execution = (await store.getExecution(request.requestId))!;
        const runId = execution.runId!;
        const step = modelSteps.get(runId) ?? 0;
        modelSteps.set(runId, step + 1);
        expect(step).toBeLessThan(12);
        const tools = request.tools.map((tool) => tool.id);
        expect(tools).not.toContain('write_user_file');
        if (execution.sessionId !== 'parent') {
          expect(tools).toContain('write_file');
          expect(tools).not.toContain('spawn_agent');
          const users = request.messages.filter((message) => message.role === 'user');
          const marker = users.at(-1)!.content;
          const index = marker.includes('WRITE:C') ? 2 : marker.includes('WRITE:A') ? 0 : 1;
          if (step === 0) {
            const write = request.tools.find((tool) => tool.id === 'write_file')!;
            expect(object(write.inputSchema.properties)).toHaveProperty('base_ref');
            expect(object(write.inputSchema.properties)).not.toHaveProperty('base');
            const input = { path: targets[index]!, content: bodies[index]! };
            seenInputs.push({ path: input.path, input });
            yield call('write_file', input);
            yield { ...finish, reason: 'tool_calls' };
          } else {
            const result = request.messages.filter((message) => message.role === 'tool').at(-1)!;
            expect(result.content).toContain(targets[index]!);
            expect(JSON.parse(result.content)).toHaveProperty('base_ref');
            yield { type: 'text_delta', text: `WROTE ${bodies[index]}` };
            yield finish;
          }
          return;
        }
        if (step === 0 && execution.originCommandId === 'second') {
          expect(
            request.messages.some(
              (message) =>
                message.role === 'user' &&
                message.content === 'Continue the same child with WRITE:C.' &&
                message.sourceIds?.includes('second'),
            ),
          ).toBe(true);
          followupDispatched = true;
          yield call('follow_up_agent', { agent_id: childA, content: 'WRITE:C' });
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (step === 0) {
          yield call('spawn_agent', { prompt: 'WRITE:A', task_name: 'A' });
          yield call('spawn_agent', { prompt: 'WRITE:B', task_name: 'B' });
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        const receipts = request.messages
          .filter((message) => message.role === 'tool')
          .flatMap((message) => {
            try {
              const value = JSON.parse(message.content);
              return typeof value.work_ref === 'string' ? [value] : [];
            } catch {
              return [];
            }
          });
        const refs = followupDispatched ? receipts.slice(-1) : receipts;
        expect(refs).toHaveLength(followupDispatched ? 1 : 2);
        const allCarriers = (await store.listExecutions('parent')).filter(
          (entry) => entry.childSessionId,
        );
        const carriers = refs
          .map(
            (value) =>
              allCarriers.filter((entry) => value.agent_id === entry.childSessionId).at(-1)!,
          )
          .filter(Boolean);
        const currentCarriers = [];
        for (const entry of carriers) {
          const parent = entry.parentExecutionId
            ? await store.getExecution(entry.parentExecutionId)
            : null;
          if (parent?.runId === runId) currentCarriers.push(entry);
        }
        if (
          currentCarriers.length === refs.length &&
          currentCarriers.every((entry) =>
            ['succeeded', 'failed', 'cancelled'].includes(entry.status),
          )
        ) {
          if (!followupDispatched && followupKind !== 'active_parent') {
            yield finish;
          } else if (!followupDispatched) {
            parentPaused = true;
            await new Promise<void>((resolve, reject) => {
              const aborted = () => reject(context.signal.reason);
              context.signal.addEventListener('abort', aborted, { once: true });
              void followupReady.then(() => {
                context.signal.removeEventListener('abort', aborted);
                resolve();
              });
              if (context.signal.aborted) aborted();
            });
            context.signal.throwIfAborted();
            followupDispatched = true;
            yield call('follow_up_agent', { agent_id: childA, content: 'WRITE:C' });
            yield { ...finish, reason: 'tool_calls' };
          } else yield finish;
        } else {
          const wait = request.tools.find((tool) => tool.id === 'wait_agent_events')!;
          expect(object(wait.inputSchema.properties)).toHaveProperty('work_refs');
          expect(object(wait.inputSchema.properties)).toHaveProperty('wait_ms');
          expect(object(wait.inputSchema.properties)).not.toHaveProperty('timeout_ms');
          yield call('wait_agent_events', {
            work_refs: refs.map((value) => value.work_ref),
            wait_ms: 5000,
          });
          yield { ...finish, reason: 'tool_calls' };
        }
      },
    };
    const runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      artifacts: createArtifactStore({ profile, store }),
      workspaceSerialLocks: locks,
      modelConcurrency: 4,
      async resolveRunConfiguration(input) {
        return { ...(await host.resolveRunConfiguration!(input)), model };
      },
      async resolveChildRunConfiguration(input) {
        return { ...(await host.resolveChildRunConfiguration!(input)), model };
      },
    });
    const controls = host.permissionManagement!(runtime);
    const until = async <T>(read: () => Promise<T | undefined>) => {
      const deadline = Date.now() + 12000;
      for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= deadline) throw Error('window_file_tools_deadline');
        await Bun.sleep(5);
      }
    };
    const pending = async () =>
      (await runtime.listInteractions({ expectedStoreId, sessionId: 'parent', state: 'pending' }))
        .interactions;
    const answer = (card: InteractionRecord, approve: boolean) =>
      runtime.answerInteraction({
        ...identity,
        commandId: `answer-${card.id}`,
        presentationSessionId: 'parent',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: approve
          ? { kind: 'approval', decision: 'approve', optionId: 'once' }
          : { kind: 'approval', decision: 'deny' },
      });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        ...identity,
        commandId: 'create',
        sessionId: 'parent',
        workspaceId: 'w',
        title: 'Window tools',
      });
      await initializeLivePermissionFixture({
        runtime,
        profile,
        ...identity,
        sessionId: 'parent',
        workspaceId: 'w',
        mode,
        trusted: true,
      });
      await runtime.submitCommand({
        ...identity,
        commandId: 'first',
        sessionId: 'parent',
        request: { kind: 'run.start', content: 'Two exact child writes.' },
      });
      const cards = await until(async () => {
        const value = await pending();
        return value.length === 2 ? value : undefined;
      });
      const byPath = (card: InteractionRecord) => String(object(object(card.request).input).path);
      const a = cards.find((card) => byPath(card) === targets[0])!;
      const b = cards.find((card) => byPath(card) === targets[1])!;
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a.sessionId).not.toBe(b.sessionId);
      await until(async () =>
        (await store.listExecutions('parent')).some(
          (entry) =>
            entry.definitionId === 'task.events' &&
            entry.authorization?.dispatched === true &&
            ['dispatching', 'running'].includes(entry.status) &&
            entry.result === null,
        )
          ? true
          : undefined,
      );
      expect((await store.getView('parent')).runs.some((run) => run.isActive)).toBe(true);
      expect(targets.every((target) => !existsSync(target))).toBe(true);
      const originalCarriers = (await store.listExecutions('parent')).filter(
        (entry) => entry.childSessionId,
      );
      expect(originalCarriers).toHaveLength(2);
      for (const card of cards) {
        const tool = (await store.getExecution(card.executionId))!;
        expect(card).toMatchObject({
          definitionId: 'files.write',
          definitionVersion: '3',
          presentationSessionId: 'parent',
          originStoreId: expectedStoreId,
        });
        expect(tool).toMatchObject({
          definitionId: 'files.write',
          definitionVersion: '3',
          sessionId: card.sessionId,
          runId: card.runId,
          status: 'planned',
        });
        expect(tool.authorization?.dispatched).not.toBe(true);
        expect(tool.input).toEqual({
          path: byPath(card),
          content: bodies[targets.indexOf(byPath(card))]!,
        });
        expect(object(card.request).input).toEqual(tool.input);
        expect((await store.getSession(card.sessionId))?.parentSessionId).toBe('parent');
        const carrier = originalCarriers.find((entry) => entry.childSessionId === card.sessionId)!;
        const spawn = (await store.getExecution(carrier.parentExecutionId!))!;
        expect(spawn).toMatchObject({
          sessionId: 'parent',
          definitionId: 'task.spawn',
          definitionVersion: '1',
          status: 'succeeded',
        });
        expect(object(carrier.reference).runId).toBe(card.runId);
        expect(carrier.rootWorkCommandId).toBe(tool.rootWorkCommandId);
        expect(carrier.rootWorkSeq).toBe(tool.rootWorkSeq);
      }
      expect((await controls.readMode({ ...identity, sessionId: 'parent' })).mode).toBe(mode);
      await answer(a, true);
      await until(async () =>
        (await store.getExecution(a.executionId))?.status === 'succeeded' ? true : undefined,
      );
      expect(readFileSync(targets[0]!, 'utf8')).toBe(bodies[0]!);
      expect(
        (
          await runtime.getInteraction({
            expectedStoreId,
            sessionId: 'parent',
            interactionId: b.id,
          })
        )?.state,
      ).toBe('pending');
      expect((await store.getExecution(b.executionId))?.authorization?.dispatched).not.toBe(true);
      expect(existsSync(targets[1]!)).toBe(false);
      await answer(b, false);
      await until(async () => {
        const settled = await Promise.all(
          originalCarriers.map((entry) => store.getExecution(entry.id)),
        );
        return settled.every(
          (entry) => entry && ['succeeded', 'failed', 'cancelled'].includes(entry.status),
        )
          ? true
          : undefined;
      });
      expect((await store.getExecution(b.executionId))?.result).toMatchObject({
        content: 'approval_denied',
      });
      expect(existsSync(targets[1]!)).toBe(false);
      const originalCarrier = originalCarriers.find(
        (entry) => entry.childSessionId === a.sessionId,
      )!;
      const originalSource = (await store.getExecution(originalCarrier.parentExecutionId!))!;
      const originalParentRunId = originalSource.runId!;
      if (followupKind === 'active_parent') {
        await until(async () => (parentPaused ? true : undefined));
      } else {
        await runtime.waitForCommand('first', { timeoutMs: 10000 });
        await until(async () =>
          (await store.getView('parent')).runs.every((run) => !run.isActive) ? true : undefined,
        );
      }
      const oldParentRun = await store.getRun(originalParentRunId);
      const oldChildRun = await store.getRun(a.runId!);
      const oldCarrier = await store.getExecution(originalCarrier.id);
      const oldTool = await store.getExecution(a.executionId);
      const oldCard = await runtime.getInteraction({
        expectedStoreId,
        sessionId: 'parent',
        interactionId: a.id,
      });
      childA = a.sessionId;
      if (followupKind === 'active_parent') {
        releaseFollowup();
      } else {
        expect(oldParentRun).toMatchObject({ status: 'completed', isActive: false });
        await runtime.submitCommand({
          ...identity,
          commandId: 'second',
          sessionId: 'parent',
          request:
            followupKind === 'input.follow_up'
              ? {
                  kind: 'input.follow_up',
                  content: 'Continue the same child with WRITE:C.',
                  afterRunId: originalParentRunId,
                  contextSelectionId: (await store.getView('parent')).session.contextSelectionId,
                }
              : { kind: 'run.start', content: 'Continue the same child with WRITE:C.' },
        });
      }
      let delegationCard: InteractionRecord | undefined;
      const next = await until(async () => {
        const value = await pending();
        for (const card of value)
          if (card.definitionId === 'task.follow_up') {
            delegationCard = card;
            expect(object(object(card.request).input)).toMatchObject({
              agentId: childA,
              content: 'WRITE:C',
            });
            await answer(card, true);
          }
        return value.find((card) => card.definitionId === 'files.write');
      });
      expect(next).toMatchObject({
        sessionId: childA,
        definitionId: 'files.write',
        definitionVersion: '3',
        presentationSessionId: 'parent',
      });
      expect(next.id).not.toBe(a.id);
      expect(next.runId).not.toBe(a.runId);
      expect(next.executionId).not.toBe(a.executionId);
      expect(object(next.request).input).toEqual({ path: targets[2], content: bodies[2] });
      expect(existsSync(targets[2]!)).toBe(false);
      expect((await store.getExecution(next.executionId))?.authorization?.dispatched).not.toBe(
        true,
      );
      expect(await store.getExecution(a.executionId)).toEqual(oldTool);
      expect(
        await runtime.getInteraction({ expectedStoreId, sessionId: 'parent', interactionId: a.id }),
      ).toEqual(oldCard);
      // Repeating the original answer receipt cannot approve a later child call.
      await answer(a, true);
      expect(
        (
          await runtime.getInteraction({
            expectedStoreId,
            sessionId: 'parent',
            interactionId: next.id,
          })
        )?.state,
      ).toBe('pending');
      expect(existsSync(targets[2]!)).toBe(false);
      const nextCarrier = (await store.listExecutions('parent')).find(
        (entry) => object(entry.reference).runId === next.runId,
      )!;
      const source = (await store.getExecution(nextCarrier.parentExecutionId!))!;
      const parentRun = (await store.getRun(source.runId!))!;
      const parentCommand = (await store.getCommand(parentRun.originCommandId))!;
      const childRun = (await store.getRun(next.runId!))!;
      const childCommand = (await store.getCommand(childRun.originCommandId))!;
      const nextTool = (await store.getExecution(next.executionId))!;
      expect(nextCarrier.id).not.toBe(originalCarrier.id);
      expect(nextCarrier.childSessionId).toBe(childA);
      expect(source).toMatchObject({
        sessionId: 'parent',
        definitionId: 'task.follow_up',
        definitionVersion: '1',
        status: 'succeeded',
        input: { agentId: childA, content: 'WRITE:C' },
      });
      expect(delegationCard).toBeDefined();
      const delegationAnswer = (await runtime.getInteraction({
        expectedStoreId,
        sessionId: 'parent',
        interactionId: delegationCard!.id,
      }))!;
      expect(delegationAnswer).toMatchObject({
        state: 'answered',
        executionId: source.id,
        runId: parentRun.id,
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
      });
      expect(delegationAnswer.acceptedDecisionRevision).not.toBeNull();
      expect(source.interactionBinding).toEqual({
        interactionId: delegationAnswer.id,
        decisionRevision: delegationAnswer.acceptedDecisionRevision,
      });
      expect(source.authorization?.human).toMatchObject({
        interactionId: delegationAnswer.id,
        accepted: true,
        decision: 'approve',
        optionId: 'once',
      });
      expect(childRun.carrierExecutionId).toBe(nextCarrier.id);
      expect(childCommand).toMatchObject({
        id: `child-start-${nextCarrier.id}`,
        sessionId: childA,
        kind: 'input.follow_up',
        request: { kind: 'input.follow_up', afterRunId: a.runId, content: 'WRITE:C' },
      });
      for (const fact of [source, parentRun, nextCarrier, childRun, childCommand, nextTool]) {
        expect(fact.originStoreId).toBe(expectedStoreId);
        expect(fact.rootWorkCommandId).toBe(parentCommand.id);
        expect(fact.rootWorkSeq).toBe(parentCommand.seq);
      }
      if (followupKind === 'active_parent') {
        expect(parentRun.id).toBe(originalParentRunId);
        expect(parentCommand.id).toBe('first');
      } else {
        expect(parentRun.id).not.toBe(originalParentRunId);
        expect(parentCommand).toMatchObject({
          id: 'second',
          kind: followupKind,
          sessionId: 'parent',
          status: 'applied',
          rootWorkCommandId: 'second',
          receipt: { runId: parentRun.id },
          request: { kind: followupKind, content: 'Continue the same child with WRITE:C.' },
        });
        if (followupKind === 'input.follow_up') {
          expect(parentCommand.request).toMatchObject({
            afterRunId: originalParentRunId,
            contextSelectionId: oldParentRun!.contextSelectionId,
          });
        }
        expect(parentCommand.rootWorkCommandId).not.toBe(originalCarrier.rootWorkCommandId);
        expect(parentCommand.rootWorkSeq).not.toBe(originalCarrier.rootWorkSeq);
        expect(await store.getRun(originalParentRunId)).toEqual(oldParentRun);
      }
      expect(await store.getRun(a.runId!)).toEqual(oldChildRun);
      expect(await store.getExecution(originalCarrier.id)).toEqual(oldCarrier);
      await answer(next, true);
      await runtime.waitForCommand(followupKind === 'active_parent' ? 'first' : 'second', {
        timeoutMs: 10000,
      });
      expect(await store.getExecution(a.executionId)).toEqual(oldTool);
      expect(await store.getRun(a.runId!)).toEqual(oldChildRun);
      expect(await store.getExecution(originalCarrier.id)).toEqual(oldCarrier);
      expect(
        await runtime.getInteraction({ expectedStoreId, sessionId: 'parent', interactionId: a.id }),
      ).toEqual(oldCard);
      if (followupKind !== 'active_parent')
        expect(await store.getRun(originalParentRunId)).toEqual(oldParentRun);
      const completedCarrier = (await store.getExecution(nextCarrier.id))!;
      expect(completedCarrier.status).toBe('succeeded');
      expect(completedCarrier.resultAcceptance).toMatchObject({
        runId: parentRun.id,
        resultRevision: completedCarrier.resultRevision,
        selectionId: parentRun.contextSelectionId,
      });
      expect(String(object(completedCarrier.result).content)).toContain(bodies[2]!);
      expect(readFileSync(targets[2]!, 'utf8')).toBe(bodies[2]!);
      expect(
        (await store.listExecutions(childA)).filter(
          (entry) => entry.definitionId === 'files.write',
        ),
      ).toHaveLength(2);
      expect(
        (await store.listExecutions('parent')).filter((entry) => entry.childSessionId),
      ).toHaveLength(3);
      expect(seenInputs).toHaveLength(3);
      expect(
        seenInputs.every(
          ({ input }) => !Object.hasOwn(input, 'base') && !Object.hasOwn(input, 'base_ref'),
        ),
      ).toBe(true);
      expect((await controls.readMode({ ...identity, sessionId: 'parent' })).mode).toBe(mode);
      expect(reviews.filter((id) => id === 'files.write')).toHaveLength(mode === 'auto' ? 3 : 0);
    } finally {
      await runtime.close();
      releaseFollowup();
      await locks.close();
      await store.close();
      removeTemporaryDirectory(root);
    }
  }, 40000);
}
