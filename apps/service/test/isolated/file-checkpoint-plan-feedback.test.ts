import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import {
  createPlanFiles,
  createPlanningValidation,
  planningExtensionId,
} from '@kite-ai/agent/planning';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createDefaultFileCheckpointConfiguration } from '../../src/file-checkpoint-configuration';

const object = (value: unknown) => value as Record<string, Json>;
const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

for (const fault of [
  'succeeded',
  'denied',
  'approval',
  'cancelled',
  'cancelled-dispatched',
  'domain',
  'unknown',
  'missing',
  'nonterminal',
  'foreign',
  'throw',
] as const)
  test(`Plan file delegation retains ${fault} action feedback through its original Tool and next Model`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-plan-feedback-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'fixture' });
    const store = await openSqliteStore(profile);
    const locks = createWorkspaceSerialLocks(profile);
    let runtime!: ReturnType<typeof createRuntime>;
    const files = createDefaultFileCheckpointConfiguration({
      profile,
      runtime: () => runtime,
      runtimeAssets: () => [],
    });
    const planning = createPlanningValidation({}, createPlanFiles(profile.profilePath));
    const requests: ModelRequest[] = [];
    let path = '',
      step = 0,
      active = false,
      observedActionId: string | null = null;
    const privateMarker = 'PRIVATE_PLAN_ADAPTER_FAILURE_MUST_NOT_LEAK';
    const denial = 'explicit_plan_update_forbidden';
    let invokes = 0;
    runtime = createRuntime({
      store,
      workspaceSerialLocks: locks,
      extensions: [files.extension, planning.extension],
      modelId: 'fixed',
      model: {
        async *stream(request) {
          requests.push(structuredClone(request));
          if (step < 2) {
            let input: Json = { path };
            if (step === 1) {
              const read = (await store.listExecutions('s')).find(
                (e) => e.definitionId === 'files.read',
              )!;
              const result = JSON.parse(String(object(read.result).content));
              input = { path, content: 'Requested plan', base: result.baseline };
            }
            yield {
              type: 'tool_call',
              id: step === 0 ? 'read-plan' : 'write-plan',
              name: step === 0 ? 'read_file' : 'write_file',
              arguments: JSON.stringify(input),
            };
            step++;
            yield { ...finish, reason: 'tool_calls' };
          } else yield finish;
        },
      },
      permissions: {
        async authorize(request) {
          if (
            active &&
            fault === 'denied' &&
            request.definitionId === `${planningExtensionId}/planning.write`
          )
            return { allowed: false, revision: 'fixture-denial', reason: denial };
          if (
            active &&
            ['approval', 'cancelled'].includes(fault) &&
            request.definitionId === `${planningExtensionId}/planning.write`
          )
            return {
              allowed: false,
              revision: 'fixture-manual',
              approval: { request: { reason: 'Plan write requires an explicit decision' } },
            };
          const capability = await files.describeRequest(request);
          return {
            allowed: true,
            revision: capability?.revision ?? 'fixture-permission',
            ...(capability
              ? {
                  snapshot: {
                    namespace: 'builtin.permissions',
                    version: '1',
                    data: { capability } as unknown as Json,
                  },
                }
              : {}),
          };
        },
      },
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const invoke = runtime.invokeActionFromTool.bind(runtime);
    const getExecution = runtime.getExecution.bind(runtime);
    const writeRecord = store.writeExtensionRecord.bind(store);
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'Plan feedback',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'seed',
        request: {
          kind: 'extension.invoke',
          extensionId: planningExtensionId,
          actionId: 'planning.write',
          definitionVersion: '1',
          input: {
            planId: 'p',
            expectedVersion: null,
            title: 'Plan',
            body: 'Original plan',
            steps: [{ id: 'one', title: 'Update Plan' }],
          },
        },
      });
      await runtime.waitForCommand('seed', { timeoutMs: 5000 });
      const views = await runtime.queryExtension({
        ...base,
        extensionId: planningExtensionId,
        queryId: 'planning.file',
        input: {},
      });
      path = String(object(views[0]!.payload).path);
      active = true;
      runtime.invokeActionFromTool = async (input) => {
        invokes++;
        if (fault === 'throw') throw new Error(privateMarker);
        if (fault === 'domain') {
          await invoke({
            ...input,
            commandId: `${input.commandId}-competing`,
            request: {
              ...input.request,
              input: { ...object(object(input.request).input), body: 'Concurrent plan' },
            } as typeof input.request,
          });
        }
        const receipt = await invoke(input);
        observedActionId = String(object(receipt.receipt).executionId);
        return receipt;
      };
      runtime.getExecution = async (id) => {
        const actual = await getExecution(id);
        if (id !== observedActionId || !actual) return actual;
        // Vary only host observations; the original Runtime records and real file effects remain intact.
        if (fault === 'missing') return null;
        if (fault === 'nonterminal') return { ...actual, status: 'running' };
        if (fault === 'cancelled-dispatched') return { ...actual, status: 'cancelled' };
        if (fault === 'foreign') return { ...actual, parentExecutionId: 'foreign-tool' };
        return actual;
      };
      let conflicted = false;
      store.writeExtensionRecord = async (input) => {
        if (
          active &&
          fault === 'unknown' &&
          !conflicted &&
          input.extensionId === planningExtensionId &&
          input.write.key === 'plan.current'
        ) {
          conflicted = true;
          expect(readFileSync(path, 'utf8')).toBe('Requested plan');
          await writeRecord(input);
        }
        return writeRecord(input);
      };
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: { kind: 'run.start', content: 'Update only the current Plan file.' },
      });
      if (fault === 'approval' || fault === 'cancelled') {
        const deadline = Date.now() + 5000;
        let card:
          | Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number]
          | undefined;
        do {
          card = (
            await runtime.listInteractions({ expectedStoreId, sessionId: 's', state: 'pending' })
          ).interactions[0];
          if (!card) await Bun.sleep(5);
          if (Date.now() > deadline) throw new Error('Plan feedback approval deadline');
        } while (!card);
        expect(readFileSync(path, 'utf8')).toBe('Original plan');
        if (fault === 'approval')
          await runtime.answerInteraction({
            expectedStoreId,
            presentationSessionId: 's',
            subjectId: 'owner',
            commandId: 'deny-plan',
            interactionId: card.id,
            expectedRevision: card.revision,
            answer: { kind: 'approval', decision: 'deny' },
          });
        else
          await runtime.cancelExecution({
            ...base,
            commandId: 'cancel-plan',
            executionId: card.executionId,
          });
      }
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      const rows = await store.listExecutions('s');
      const tool = rows.find((e) => e.kind === 'tool' && e.definitionId === 'files.write')!;
      const action =
        rows.find((e) => e.id === observedActionId) ??
        rows.find(
          (e) =>
            e.parentExecutionId === tool.id &&
            e.definitionId === `${planningExtensionId}/planning.write`,
        );
      const result = object(tool.result);
      const content = String(result.content);
      const next = requests
        .at(-1)!
        .messages.find((m) => m.role === 'tool' && m.toolCallId === 'write-plan')!;
      expect(invokes).toBe(1);
      expect(requests).toHaveLength(3);
      expect(tool).toMatchObject({
        callId: 'write-plan',
        sessionId: 's',
        originStoreId: expectedStoreId,
        definitionVersion: '3',
      });
      expect(next.sourceIds).toEqual([tool.id]);
      if (fault === 'approval' || fault === 'domain') {
        const code = fault === 'approval' ? 'approval_denied' : 'plan_version_conflict';
        expect(content).toBe(code);
        expect(object(action!.result).content).toBe(code);
        expect(object(result.details).code).toBe(code);
        expect(action).toMatchObject({
          parentExecutionId: tool.id,
          sessionId: 's',
          originStoreId: expectedStoreId,
          definitionId: `${planningExtensionId}/planning.write`,
          definitionVersion: '1',
          status: 'failed',
        });
        expect(next.content).toBe(
          `The operation failed.\n${
            fault === 'approval'
              ? 'Approval was not obtained for this invocation. Check its original approval receipt, respect a verified refusal and do not bypass it using another tool, path or expanded scope.'
              : 'The supplied plan version no longer matches the expected version. Read the current plan before deciding on another authorized update.'
          }`,
        );
      } else expect(next.content).toContain(content);
      expect(JSON.stringify([rows, requests])).not.toContain(privateMarker);
      const interactions = (await runtime.listInteractions({ expectedStoreId, sessionId: 's' }))
        .interactions;
      expect(interactions.filter((card) => card.state === 'pending')).toEqual([]);
      expect(interactions).toHaveLength(fault === 'approval' || fault === 'cancelled' ? 1 : 0);
      if (fault === 'succeeded') {
        expect(action!.status).toBe('succeeded');
        expect(tool.status).toBe('succeeded');
        expect(result.outcome).toBe('succeeded');
        expect(readFileSync(path, 'utf8')).toBe('Requested plan');
      } else if (fault === 'denied' || fault === 'domain' || fault === 'approval') {
        expect(action!.status).toBe('failed');
        expect(tool.status).toBe('failed');
        expect(content).toContain(
          fault === 'denied'
            ? denial
            : fault === 'approval'
              ? 'approval_denied'
              : 'plan_version_conflict',
        );
        expect(readFileSync(path, 'utf8')).toBe(
          fault === 'domain' ? 'Concurrent plan' : 'Original plan',
        );
      } else if (fault === 'cancelled') {
        expect(action!.status).toBe('cancelled');
        expect(action!.authorization?.dispatched).toBe(false);
        expect(readFileSync(path, 'utf8')).toBe('Original plan');
        expect(content).toContain('cancelled before dispatch');
      } else {
        expect(tool.status).toBe('outcome_unknown');
        expect(result.outcome).toBe('outcome_unknown');
        expect(content).toContain('Do not repeat');
        expect(content).not.toContain('not executed');
        expect(readFileSync(path, 'utf8')).toBe(
          fault === 'throw' ? 'Original plan' : 'Requested plan',
        );
        if (fault === 'unknown') expect(content).toContain(String(object(action!.result).content));
      }
    } finally {
      runtime.getExecution = getExecution;
      runtime.invokeActionFromTool = invoke;
      store.writeExtensionRecord = writeRecord;
      await runtime.close();
      await locks.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
