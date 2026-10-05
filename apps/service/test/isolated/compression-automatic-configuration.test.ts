import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
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
          return input.messages.some((message) => message.content === 'Automatic next work');
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
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
      expectedStoreId = (await store.getMetadata()).storeId;
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
        rootUri: `file://${workspace}`,
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
        content: 'Automatic next work',
      });
      await runtime.waitForCommand('next', { timeoutMs: 5000 });
      const view = await client.getView('s'),
        context = await client.getContext('s', { storeId: expectedStoreId }),
        inputs = (await client.listModelInputs('s')).items.filter(
          (item) => item.originCommandId === 'next',
        );
      expect(view.runs.find((run) => run.originCommandId === 'next')).toMatchObject({
        status: 'completed',
        reason: null,
      });
      expect(validations).toBe(1);
      expect(requests).toHaveLength(3);
      expect(inputs).toHaveLength(2);
      expect(context.selection.id).toBe(original.selection.id);
      const summaryInput = await client.getModelInput('s', inputs[0]!.executionId),
        actual = await client.getModelInput('s', inputs[1]!.executionId);
      expect(summaryInput.request.tools).toHaveLength(0);
      expect(
        summaryInput.request.messages.some((message) => message.content === 'Automatic next work'),
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
