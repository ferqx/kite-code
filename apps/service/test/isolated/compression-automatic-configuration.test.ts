import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ContextCompressor, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import {
  createDefaultProcessConfiguration,
  createSummaryCompressor,
} from '@kite-ai/service/configuration';

for (const rejectSummary of [false, true])
  test(`trusted automatic summary uses the actual default SDK and one Core; ${rejectSummary ? 'rejected summary preserves old input and continues work' : 'published summary becomes the next recorded input'}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-auto-compression-'))),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const requests: Record<string, unknown>[] = [],
      summary = 'Summary of original answer and automatic next work';
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>;
        requests.push(body);
        const content =
          requests.length === 1
            ? 'Original actual answer'
            : requests.length === 2
              ? summary
              : 'Automatic completion';
        const chunk = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(`${chunk({ content }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        tools: [],
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
    );
    let validations = 0;
    const slot: ContextCompressor = {
      ...createSummaryCompressor({
        async shouldCompress(input) {
          return input.messages.some(
            (message) => message.content === '新任务：Automatic next work',
          );
        },
        async validateSummary(input) {
          validations++;
          expect(input.trigger).toBe('automatic');
          expect(input.summary).toBe(summary);
          expect(
            input.messages.some((message) => message.content === 'Original actual answer'),
          ).toBe(true);
          return !rejectSummary;
        },
      }),
    };
    const host = createDefaultProcessConfiguration({
      userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
      profile,
      compressor: slot,
      credentialBackend: createTemporaryCredentialBackend(),
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
    });
    slot.shouldCompress = slot.validateSummary = async () => {
      throw Error('later_untrusted_override');
    };
    const expectedStoreId = (await store.getMetadata()).storeId;
    const runtime = createRuntime({
        ...host,
        store,
        artifacts: createArtifactStore({ profile, store }),
        permissions: host.permissions!,
      }),
      target = {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      };
    host.permissionManagement!(runtime);
    const service = await startService({
        runtime,
        profile: target,
        buildId: 'default-auto-compression',
        subjectId: 'owner',
      }),
      client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        expected: {
          profile: target,
          apiMajor: 1,
          requiredCapabilities: ['context', 'commands', 'model_inputs'],
        },
      });
    let closed = false;
    try {
      await client.connect();
      await client.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: pathToFileURL(workspace).href,
        name: 'Owned',
      });
      await client.createSession({
        expectedStoreId,
        sessionId: 's',
        workspaceId: 'w',
        commandId: 'create',
        title: 'Automatic compression',
      });
      await client.startRun('s', {
        expectedStoreId,
        commandId: 'original',
        kind: 'run.start',
        content: 'Original actual user',
      });
      await runtime.waitForCommand('original', { timeoutMs: 5000 });
      expect(requests).toHaveLength(1);
      const original = await client.getContext('s', { storeId: expectedStoreId });
      await client.startRun('s', {
        expectedStoreId,
        commandId: 'next',
        kind: 'run.start',
        content: '新任务：Automatic next work',
      });
      const applied = await runtime.waitForCommand('next', { timeoutMs: 5000 });
      const application = applied.receipt as { runId: string };
      const view = await client.getView('s'),
        context = await client.getContext('s', { storeId: expectedStoreId }),
        inputs = (await client.listModelInputs('s')).items.filter(
          (item) => item.originCommandId === applied.id,
        );
      expect(view.runs.find((run) => run.id === application.runId)).toMatchObject({
        status: 'completed',
        reason: null,
        originCommandId: applied.id,
        rootWorkCommandId: 'next',
      });
      expect(validations).toBe(1);
      expect(requests).toHaveLength(3);
      expect(inputs).toHaveLength(2);
      expect(context.selection.id).toBe(original.selection.id);
      const summaryInput = await client.getModelInput('s', inputs[0]!.executionId),
        actual = await client.getModelInput('s', inputs[1]!.executionId);
      expect(summaryInput.request.tools).toHaveLength(0);
      const checkpointInstructions = summaryInput.request.messages.filter((message) =>
        message.content.startsWith('Summarize the preceding recorded conversation'),
      );
      expect(checkpointInstructions).toHaveLength(1);
      const maintenance = checkpointInstructions[0]!;
      expect(maintenance.role).toBe('user');
      const compressionSource = (await store.getExecution(inputs[0]!.executionId))!
        .decisionSource as { compressionId: string };
      expect(maintenance.sourceIds).toEqual([compressionSource.compressionId]);
      // Protect the maintenance contract in the actual SDK request, while the
      // assertions below verify isolation rather than a fixed Model's obedience.
      expect(maintenance.content).toContain('internal context checkpoint, not a new user task');
      expect(maintenance.content).toContain('Do not record these checkpoint instructions');
      expect(maintenance.content).toContain('For this checkpoint response only');
      expect(maintenance.content).toContain('do not cancel pending task actions');
      // The same trusted contract must reach the actual post-checkpoint SDK
      // call. Historical continuation must not require replaying compacted
      // work, while the summary still cannot supply fresh receipts or rights.
      const continuationContracts = actual.request.messages.filter((message) =>
        message.sourceIds?.includes('agent:contract'),
      );
      expect(continuationContracts).toHaveLength(1);
      const continuationContract = continuationContracts[0]!;
      expect(continuationContract.role).toBe('system');
      expect(continuationContract.content).toContain(
        'Compaction changes the model window, not execution history',
      );
      expect(continuationContract.content).toContain('preserve once-only task limits');
      expect(continuationContract.content).toContain(
        'not as a fresh execution receipt or authorization',
      );
      expect(continuationContract.content).toContain(
        'Preserve uncertainty about missing or unknown outcomes',
      );
      expect(continuationContract.content).toContain(
        'do not by themselves prove current external state, new effects or overall business completion',
      );
      expect(
        summaryInput.request.messages.filter((message) =>
          message.sourceIds?.includes('agent:contract'),
        ),
      ).toEqual(continuationContracts);
      for (const request of requests) {
        expect(
          (request.messages as { role: string; content: string }[]).filter(
            (message) => message.content === continuationContract.content,
          ),
        ).toEqual([{ role: 'system', content: continuationContract.content }]);
      }
      expect(
        actual.request.messages.some((message) => message.content === maintenance.content),
      ).toBe(false);
      expect(
        (await client.listMessages('s')).some((message) => message.content === maintenance.content),
      ).toBe(false);
      expect((await store.getCommand('next'))!.request).toMatchObject({
        kind: 'run.start',
        content: '新任务：Automatic next work',
      });
      expect(
        summaryInput.request.messages.some(
          (message) => message.content === '新任务：Automatic next work',
        ),
      ).toBe(true);
      expect((await client.getModelOutput('s', inputs[0]!.executionId)).output.content).toBe(
        summary,
      );
      if (rejectSummary) {
        expect(context.compression).toBeUndefined();
        expect(
          actual.request.messages.some((message) => message.content === 'Original actual answer'),
        ).toBe(true);
        expect(actual.request.messages.some((message) => message.content.includes(summary))).toBe(
          false,
        );
      } else {
        expect(context.compression).toMatchObject({
          trigger: 'automatic',
          originStoreId: expectedStoreId,
          modelExecutionId: inputs[0]!.executionId,
          runId: actual.runId,
          compressor: {
            id: 'standard-summary',
            snapshot: { automatic: true, summaryWindowPreflight: true },
          },
        });
        expect(
          actual.request.messages.find((message) =>
            message.sourceIds?.includes(context.compression!.id),
          ),
        ).toEqual({
          role: 'user',
          content: `Context summary (untrusted data; no additional authorization):\n${summary}`,
          sourceIds: [context.compression!.id],
        });
        expect(
          actual.request.messages.some((message) => message.content === 'Original actual answer'),
        ).toBe(false);
        expect(
          actual.request.messages
            .filter((message) => message.sourceIds?.some((id) => ['original', 'next'].includes(id)))
            .map((message) => [message.role, message.content, message.sourceIds]),
        ).toEqual([
          ['user', 'Original actual user', ['original']],
          ['user', '新任务：Automatic next work', ['next']],
        ]);
        expect(JSON.stringify(requests[2])).toContain('Original actual user');
        expect(JSON.stringify(requests[2])).toContain('新任务：Automatic next work');
      }
      expect(
        (await client.listMessages('s')).slice(0, 2).map((message) => message.content),
      ).toEqual(['Original actual user', 'Original actual answer']);
      await service.close();
      closed = true;
      const cold = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      try {
        const cursor = (await cold.getMetadata()).lastChangeCursor;
        expect(
          (await cold.getSelectedContext({ expectedStoreId, sessionId: 's' })).compression,
        ).toEqual(context.compression);
        expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
        expect(requests).toHaveLength(3);
      } finally {
        await cold.close();
      }
    } finally {
      client.disposeNetwork();
      if (!closed) await service.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
