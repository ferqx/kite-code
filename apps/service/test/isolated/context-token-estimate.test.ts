import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type CompressionInput, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createSummaryCompressor } from '../../src/compression-configuration';
import { apiSchemas } from '../../src/http/schema';

for (const mode of ['high', 'zero', 'missing', 'many'] as const)
  test(`measured context projection, actual accounting and cold read remain separate: ${mode}`, async () => {
    const parent = realpathSync(tmpdir()),
      root = realpathSync(mkdtempSync(join(parent, 'kite-token-projection-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile),
      expectedStoreId = (await store.getMetadata()).storeId;
    let calls = 0,
      normal = 0,
      summaries = 0;
    const observations: { baseline: number | undefined; compress: boolean }[] = [];
    const base = createSummaryCompressor({ automatic: {} });
    const model: ModelAdapter = {
      async *stream(request) {
        calls++;
        const summary = request.messages.some((message) =>
          message.content.startsWith('Summarize the preceding recorded conversation'),
        );
        if (summary) summaries++;
        else normal++;
        const inputTokens = summary
          ? 3
          : normal === 1
            ? mode === 'high'
              ? 50000
              : mode === 'zero'
                ? 0
                : mode === 'many'
                  ? 5
                  : null
            : 5;
        if (!summary && normal < (mode === 'many' ? 205 : 2)) {
          yield { type: 'tool_call', id: `call-${normal}`, name: 'fixture.read', arguments: '{}' };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens, outputTokens: 5000, reasoningTokens: 2000 },
          };
        } else {
          yield {
            type: 'text_delta',
            text: summary ? 'Original task summarized with exact evidence.' : 'Finished.',
          };
          yield {
            type: 'finish',
            reason: 'stop',
            usage: { inputTokens, outputTokens: 5000, reasoningTokens: 2000 },
          };
        }
      },
    };
    const artifacts = createArtifactStore({ profile, store });
    const runtime = createRuntime({
      store,
      artifacts,
      model,
      modelId: 'unknown/custom-v9',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.read',
              version: '1',
              description: 'Read fixture evidence',
              inputSchema: { type: 'object', additionalProperties: false },
              async execute() {
                return { outcome: 'succeeded', content: 'New tool evidence.' };
              },
            },
          ],
        },
      ],
      compressor: {
        ...base,
        async shouldCompress(input: CompressionInput) {
          const compress = await base.shouldCompress!(input);
          observations.push({ baseline: input.tokenBaseline?.inputTokens, compress });
          return compress;
        },
      },
    });
    const target = { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'fixture' };
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    try {
      const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'w',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...scope,
        commandId: 'create',
        workspaceId: 'w',
        title: 'tokens',
      });
      await runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: mode === 'zero' ? '中'.repeat(40000) : 'Read the evidence.',
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: mode === 'many' ? 45000 : 10000 });
      const view = await runtime.getView('s');
      expect(view.runs[0]?.status).toBe('completed');
      expect(normal).toBe(mode === 'many' ? 205 : 2);
      expect(summaries).toBe(mode === 'high' ? 1 : 0);
      expect(
        observations.some(
          (value) =>
            value.baseline === (mode === 'high' ? 50000 : mode === 'zero' ? 0 : undefined) &&
            value.compress === (mode === 'high'),
        ),
      ).toBe(true);
      const latest = view.executions.filter((execution) => execution.kind === 'model').at(-1)!;
      const query = { storeId: expectedStoreId, executionId: latest.id };
      const direct = await runtime.readContextEstimate({ ...scope, executionId: latest.id });
      const validated = apiSchemas.ContextEstimate.safeParse(direct);
      if (!validated.success) throw Error(validated.error.message);
      service = await startService({
        runtime,
        profile: target,
        buildId: 'token-projection',
        subjectId: 'owner',
      });
      const client = createClient({
        endpoint: service.endpoint,
        token: service.bootstrap.token,
        expected: { profile: target, apiMajor: 1, requiredCapabilities: ['context'] },
      });
      await client.connect();
      const cursor = (await runtime.getMetadata()).lastChangeCursor;
      const projected = await client.getContextEstimate('s', query);
      expect(projected.measuredInputTokens).toBe(5);
      expect(projected.totalInputTokens).toBeGreaterThan(5);
      expect(projected.totalInputTokens).toBeLessThan(1000);
      expect(projected.cumulativeUsage).toMatchObject({
        executionCount: calls,
        outputTokens: 5000 * calls,
        missingInputCount: mode === 'missing' ? 1 : 0,
      });
      expect(projected.cumulativeUsage.inputTokens).toBe(
        mode === 'high' ? 50008 : mode === 'many' ? 1025 : 5,
      );
      if (mode === 'many')
        expect(projected.cumulativeUsage.executionCount).toBeGreaterThan(
          view.executions.filter((e) => e.kind === 'model').length,
        );
      expect(projected.contextWindowTokens).toBeUndefined();
      await expect(client.getContextEstimate('other', query)).rejects.toThrow();
      if (mode === 'high') {
        let distortion: 'sum' | 'scope' | 'coverage' = 'sum';
        const endpoint = service.endpoint;
        const proxy = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(request) {
            const url = new URL(request.url);
            const headers = new Headers(request.headers);
            headers.delete('host');
            const response = await fetch(new URL(url.pathname + url.search, endpoint), {
              headers,
              signal: request.signal,
            });
            if (!url.pathname.endsWith('/context/estimate')) return response;
            const body = await response.json();
            if (distortion === 'sum') body.totalInputTokens++;
            if (distortion === 'scope') body.sessionId = 'other';
            if (distortion === 'coverage')
              body.cumulativeUsage.missingInputCount = body.cumulativeUsage.executionCount + 1;
            return Response.json(body);
          },
        });
        const guarded = createClient({
          endpoint: proxy.url.href,
          token: service.bootstrap.token,
          expected: { profile: target, apiMajor: 1, requiredCapabilities: ['context'] },
        });
        try {
          await guarded.connect();
          for (const fault of ['sum', 'scope', 'coverage'] as const) {
            distortion = fault;
            await expect(guarded.getContextEstimate('s', query)).rejects.toThrow(
              'invalid_response',
            );
          }
        } finally {
          guarded.disposeNetwork();
          proxy.stop(true);
        }
      }
      expect((await runtime.getMetadata()).lastChangeCursor).toBe(cursor);
      const before = calls;
      client.disposeNetwork();
      await service.close();
      service = undefined;
      const coldStore = await openSqliteStore({ ...profile, mode: 'readonly' });
      const cold = createRuntime({
        store: coldStore,
        artifacts: createArtifactStore({ profile, store: coldStore }),
        permissions: {
          async authorize() {
            throw Error('read-only forecast must not authorize');
          },
        },
      });
      try {
        const restored = await cold.readContextEstimate({ ...scope, executionId: latest.id });
        expect(restored).toEqual(projected);
        expect(calls).toBe(before);
      } finally {
        await cold.close();
      }
    } finally {
      if (service) await service.close();
      else await runtime.close();
      expect(dirname(root).toLowerCase()).toBe(parent.toLowerCase());
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
