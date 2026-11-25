import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json } from '@kite-ai/agent/extensions';
import { planningExtensionId } from '@kite-ai/agent/planning';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createLivePermissionHost } from '../../../../tests/e2e/live/model/collaboration-permissions.live';
import { createSummaryCompressor } from '../../src/compression-configuration';

const firstCommand = "printf '%s\\n' intake >> 01-intake.txt";
const secondCommand = "printf '%s\\n' reconciled >> 02-reconciliation.txt";
const inspectionHeader = 'PLAN_INSPECTION_NORTH';
const summary = 'The approved task records two receipts and inspects the north lot.';

test.skipIf(process.platform !== 'darwin')(
  'approved plan compaction blocks a repeated effect before the model reads exact saved progress',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-planning-compaction-progress-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(
      join(workspace, 'inspection.txt'),
      `${inspectionHeader}\n${'Owned north inspection line with stable contents.\n'.repeat(600)}`,
    );
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    const host = await createLivePermissionHost({
      root,
      profile,
      modelId: 'fixed',
      toolIds: [
        'planning.read',
        'planning.write',
        'planning.review',
        'planning.update',
        'files.read',
        'shell.execute',
      ],
      hostModel: {
        configuration: {
          modelId: 'fixed',
          models: [
            {
              id: 'fixed',
              provider: 'compatible',
              model: 'fixed',
              baseURL: 'http://127.0.0.1:1/v1',
              protocol: 'chat-completions',
            },
          ],
        },
      },
    });
    const store = await openSqliteStore(profile);
    const locks = createWorkspaceSerialLocks(profile);
    host.bindWorkspaceSerialLocks?.(locks);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const runRequests: ModelRequest[] = [];
    const summaryRequests: ModelRequest[] = [];
    const getRows = () => store.listExecutions(base.sessionId);
    const readDetails = (result: Json | undefined) =>
      (result as { details?: Record<string, Json> } | undefined)?.details;
    const latestTool = async (definitionId: string) =>
      (await getRows()).filter((row) => row.definitionId === definitionId).at(-1);
    const reference = async (definitionId: string, key: 'plan_ref' | 'progress_ref') => {
      const value = readDetails((await latestTool(definitionId))?.result)?.[key];
      assert(typeof value === 'string', `missing ${key} from ${definitionId}`);
      return value;
    };
    const shell = (cmd: string, description: string) => ({
      name: 'exec_command',
      input: {
        cmd,
        description,
        filesystem: 'workspace_write',
        network: 'none',
        yield_time_ms: 5000,
      },
    });
    let work = false;
    const script = [
      () => ({
        name: 'write_plan',
        input: {
          plan_id: 'intake-reconciliation',
          title: 'Reconcile the intake',
          body: 'Append each receipt once and inspect the north lot before reconciliation.',
          steps: [
            { id: 'intake', title: 'Record intake once' },
            { id: 'reconcile', title: 'Record reconciliation once' },
          ],
        },
      }),
      async () => ({
        name: 'request_plan_review',
        input: { plan_ref: await reference('planning.write', 'plan_ref') },
      }),
      () => shell(firstCommand, 'Append the intake receipt exactly once'),
      async () => ({
        name: 'update_plan_progress',
        input: {
          plan_ref: await reference('planning.write', 'plan_ref'),
          progress_ref: null,
          step_id: 'intake',
          status: 'completed',
          execution_id: (await latestTool('shell.execute'))!.id,
        },
      }),
      () => ({ name: 'read_file', input: { path: 'inspection.txt', limit: 1000 } }),
      () => shell(firstCommand, 'Append the approved intake receipt once'),
      () => ({ name: 'read_file', input: { path: 'inspection.txt', limit: 1 } }),
      () => ({ name: 'read_plan', input: {} }),
      () => shell(secondCommand, 'Append the reconciliation receipt exactly once'),
      async () => ({
        name: 'update_plan_progress',
        input: {
          plan_ref: await reference('planning.read', 'plan_ref'),
          progress_ref: await reference('planning.read', 'progress_ref'),
          step_id: 'reconcile',
          status: 'completed',
          execution_id: (await latestTool('shell.execute'))!.id,
          complete_plan: true,
        },
      }),
    ];
    const model: ModelAdapter = {
      async *stream(request, { signal }) {
        signal.throwIfAborted();
        let call: { name: string; input: unknown } | undefined;
        let content = 'Observed the original receipts.';
        if (!request.tools?.length) {
          summaryRequests.push(structuredClone(request));
          content = summary;
        } else if (work) {
          const index = runRequests.length;
          runRequests.push(structuredClone(request));
          call = await script[index]?.();
        }
        if (call) {
          yield {
            type: 'tool_call',
            id: `plan-tool-${runRequests.length}`,
            name: call.name,
            arguments: JSON.stringify(call.input),
          };
        } else yield { type: 'text_delta', text: content };
        yield {
          type: 'finish',
          reason: call ? 'tool_calls' : 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const standard = createSummaryCompressor({
      automatic: { contextWindowTokens: 96000, thresholdTokens: 65000 },
    });
    let triggered = false;
    const compressor = {
      ...standard,
      windowBudget: { ...standard.windowBudget!, recentHistoryTokens: 0 },
      async shouldCompress(input: Parameters<NonNullable<typeof standard.shouldCompress>>[0]) {
        if (!work || triggered) return false;
        const latest = input.messages.filter((message) => message.role === 'tool').at(-1);
        if (!latest?.content.includes(inspectionHeader)) return false;
        triggered = true;
        return true;
      },
    };
    const runtime = createRuntime({
      ...host,
      store,
      artifacts: createArtifactStore({ profile, store }),
      workspaceSerialLocks: locks,
      permissions: host.permissions!,
      async resolveRunConfiguration(input) {
        const binding = await host.resolveRunConfiguration!(input);
        return { ...binding, model, compressor };
      },
    });
    try {
      const controls = host.permissionManagement!(runtime);
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Owned plan compaction',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        ...base,
        workspaceId: 'w',
        commandId: 'create',
        title: 'Approved plan compaction',
      });
      const mode = await controls.readMode(base);
      await controls.setMode({
        ...base,
        commandId: 'full-mode',
        mode: 'full',
        makeDefault: false,
        ifRevision: mode.revision,
        ifDefaultRevision: mode.defaultRevision,
      });
      const trust = await controls.readTrust({ ...base, workspaceId: 'w' });
      await controls.setTrust({
        ...base,
        commandId: 'trust',
        workspaceId: 'w',
        trusted: true,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
        ifRevision: trust.revision,
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'archive',
        request: {
          kind: 'run.start',
          content: `Archived material unrelated to the plan.\n${'Owned closed inventory record.\n'.repeat(1000)}`,
        },
      });
      await runtime.waitForCommand('archive', { timeoutMs: 8000 });
      work = true;
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content:
            'Append the intake and reconciliation receipts once each after exact plan approval.',
          extensionInputs: [
            { extensionId: planningExtensionId, definitionVersion: '1', input: { mode: 'plan' } },
          ],
        },
      });
      let card:
        | Awaited<ReturnType<typeof runtime.listInteractions>>['interactions'][number]
        | undefined;
      const deadline = Date.now() + 8000;
      while (!card && Date.now() < deadline) {
        card = (await runtime.listInteractions({ ...base, state: 'pending' })).interactions[0];
        if (!card) await Bun.sleep(5);
      }
      if (card?.kind !== 'plan_review')
        throw Error(
          `original_plan_approval_not_reached:${JSON.stringify({
            command: (await store.getCommand('work'))?.receipt,
            requests: runRequests.map((request) => request.tools?.map(({ id }) => id)),
            summaryRequests: summaryRequests.length,
            tools: (await getRows()).map(({ definitionId, status, result }) => ({
              definitionId,
              status,
              details: readDetails(result),
            })),
          })}`,
        );
      expect((await getRows()).some((row) => row.definitionId === 'shell.command')).toBe(false);
      await runtime.answerInteraction({
        ...base,
        commandId: 'approve',
        presentationSessionId: base.sessionId,
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'plan_review', decision: 'approve' },
      });
      const workCommand = await runtime.waitForCommand('work', { timeoutMs: 12000 });
      const runId = (workCommand.receipt as { runId: string }).runId;
      const rows = (await getRows()).filter((row) => row.runId === runId);
      const [first, repeated, second] = rows.filter((row) => row.definitionId === 'shell.execute');
      const progress = rows.find((row) => row.definitionId === 'planning.update')!;
      const read = rows.find((row) => row.definitionId === 'planning.read')!;
      const shellJobs = (await getRows()).filter((row) => row.definitionId === 'shell.command');
      const firstFile = readFileSync(join(workspace, '01-intake.txt'), 'utf8');
      const secondFile = readFileSync(join(workspace, '02-reconciliation.txt'), 'utf8');
      const compression = (
        await store.getModelContext({ expectedStoreId, sessionId: base.sessionId })
      ).compression!;
      const contains = (request: ModelRequest, id: string) =>
        request.messages.some((message) => message.sourceIds?.includes(id));
      console.log(
        JSON.stringify({
          runId,
          compression: compression?.id,
          firstFile,
          secondFile,
          shellCalls: [first, repeated, second].map((row) => [
            row?.id,
            row?.status,
            row?.authorization?.dispatched,
            readDetails(row?.result)?.code,
          ]),
          shellJobs: shellJobs.map((row) => [row.id, row.parentExecutionId, row.status]),
        }),
      );
      expect(summaryRequests).toHaveLength(1);
      expect(compression).toMatchObject({ runId, trigger: 'automatic', recentHistoryTokens: 0 });
      expect(contains(summaryRequests[0]!, first!.id)).toBe(true);
      expect(contains(summaryRequests[0]!, progress.id)).toBe(true);
      expect(contains(runRequests[5]!, compression.id)).toBe(true);
      expect(contains(runRequests[5]!, first!.id)).toBe(false);
      expect(contains(runRequests[5]!, progress.id)).toBe(false);
      expect((repeated!.input as { command: string }).command).toBe(firstCommand);
      expect((repeated!.input as { description: string }).description).not.toBe(
        (first!.input as { description: string }).description,
      );
      expect({
        status: repeated?.status,
        dispatched: repeated?.authorization?.dispatched ?? false,
        code: readDetails(repeated?.result)?.code,
        adapterAttempted: readDetails(repeated?.result)?.adapterAttempted,
      }).toEqual({
        status: 'failed',
        dispatched: false,
        code: 'plan_progress_read_required',
        adapterAttempted: false,
      });
      const inspectionReads = rows.filter((row) => row.definitionId === 'files.read');
      expect(inspectionReads.map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
      expect(contains(runRequests[7]!, inspectionReads[1]!.id)).toBe(true);
      expect(read.status).toBe('succeeded');
      expect(readDetails(read.result)).toMatchObject({
        runId,
        progress: {
          value: {
            steps: { intake: { status: 'completed', receipt: { executionId: first!.id } } },
          },
        },
      });
      expect(contains(runRequests[8]!, read.id)).toBe(true);
      expect(first?.status).toBe('succeeded');
      expect(second?.status).toBe('succeeded');
      expect(shellJobs).toHaveLength(2);
      expect(shellJobs.map((job) => job.parentExecutionId)).toEqual([first!.id, second!.id]);
      expect(firstFile).toBe('intake\n');
      expect(secondFile).toBe('reconciled\n');
      expect(await store.getRun(runId)).toMatchObject({ status: 'completed' });
    } finally {
      try {
        await runtime.close();
        await locks.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  28000,
);
