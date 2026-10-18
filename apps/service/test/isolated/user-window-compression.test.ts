import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';

for (const mode of ['legacy-1m', 'default-256k', 'explicit-threshold'] as const)
  test(`user provider window and compression threshold survive default SDK assembly: ${mode}`, async () => {
    const contextWindow = mode === 'default-256k' ? undefined : 1048576;
    const expectedWindow = contextWindow ?? 262144;
    const shouldCompress = mode === 'explicit-threshold';
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-user-window-compression-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const evidence = 'Original user-window tool evidence, retained without compression.\n'.repeat(
      5000,
    );
    writeFileSync(join(workspace, 'evidence.txt'), evidence);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    let summaries = 0;
    let decisions = 0;
    const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as (typeof requests)[number];
        requests.push(body);
        const summary = body.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.startsWith('Summarize the preceding recorded conversation'),
        );
        if (summary) summaries++;
        else decisions++;
        const delta = summary
          ? { content: 'Original evidence summarized.' }
          : decisions === 1
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'read-evidence',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'evidence.txt', max_lines: 5000 }),
                    },
                  },
                ],
              }
            : { content: 'Understood the current project from the original evidence.' };
        const reason = !summary && decisions === 1 ? 'tool_calls' : 'stop';
        const frame = (value: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
        return new Response(`${frame(delta, null)}${frame({}, reason)}data: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const configurationPath = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      configurationPath,
      JSON.stringify({
        provider: {
          ds: {
            type: 'openai-compatible',
            baseURL: `${provider.url.href}v1`,
            apiKey: 'OWNED_LOCAL_FIXTURE',
            models: [{ name: 'deepseek-v4-flash', ...(contextWindow ? { contextWindow } : {}) }],
          },
        },
        model: 'ds:deepseek-v4-flash',
        ...(shouldCompress ? { compression: { thresholdTokens: 32768 } } : {}),
        tools: [{ id: 'files.read', definitionVersion: '4' }],
      }),
    );
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: configurationPath,
      credentialBackend: createTemporaryCredentialBackend(),
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
    });
    const runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      artifacts: createArtifactStore({ profile, store }),
    });
    host.permissionManagement!(runtime);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'w',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        ...scope,
        workspaceId: 'w',
        commandId: 'create',
        title: 'user model window',
      });
      await runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: 'Understand the current project from evidence.txt.',
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 15000 });
      const view = await store.getView('s');
      expect(view.runs).toHaveLength(1);
      expect(view.runs[0]).toMatchObject({ status: 'completed', isActive: false, reason: null });
      expect(summaries).toBe(shouldCompress ? 1 : 0);
      expect(decisions).toBe(2);
      expect(requests).toHaveLength(shouldCompress ? 3 : 2);
      const evidenceRequest = requests.find((request) =>
        request.messages.some(
          (message) =>
            message.role === 'tool' &&
            typeof message.content === 'string' &&
            JSON.parse(message.content).content === evidence,
        ),
      );
      expect(evidenceRequest).toBeDefined();
      const configuration = view.runs[0]!.configuration as {
        snapshot: {
          configuration: {
            models: { model: string; modelCapabilities?: { contextWindowTokens?: number } }[];
          };
        };
      };
      expect(
        configuration.snapshot.configuration.models.find(
          (model) => model.model === 'deepseek-v4-flash',
        )?.modelCapabilities?.contextWindowTokens,
      ).toBe(expectedWindow);
      const models = view.executions.filter((execution) => execution.kind === 'model');
      expect(models).toHaveLength(shouldCompress ? 3 : 2);
      const estimate = await runtime.readContextEstimate({
        ...scope,
        executionId: models.at(-1)!.id,
      });
      expect(estimate.contextWindowTokens).toBe(expectedWindow);
      if (!shouldCompress) {
        expect(estimate.totalInputTokens).toBeGreaterThan(32768);
        expect(estimate.totalInputTokens).toBeLessThan(262144 * 0.75);
      }
      const compression = (await store.getSelectedContext({ expectedStoreId, sessionId: 's' }))
        .compression;
      if (shouldCompress)
        expect(compression).toMatchObject({ trigger: 'automatic', runId: view.runs[0]!.id });
      else expect(compression).toBeUndefined();
      expect(view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(1);
      expect(view.executions.every((execution) => execution.status === 'succeeded')).toBe(true);
      const executionIds = view.executions.map((execution) => execution.id);
      await Bun.sleep(100);
      expect((await store.getView('s')).executions.map((execution) => execution.id)).toEqual(
        executionIds,
      );
      expect(requests).toHaveLength(shouldCompress ? 3 : 2);
      await runtime.close();
      // Cold historical estimates use the original Run, even after the user's file changes.
      writeFileSync(
        configurationPath,
        JSON.stringify({ model: null, compression: { thresholdTokens: 1 } }),
      );
      const coldStore = await openSqliteStore({
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        mode: 'readonly',
      });
      const cold = createRuntime({
        store: coldStore,
        artifacts: createArtifactStore({ profile, store: coldStore }),
        permissions: {
          async authorize() {
            throw Error('Historical estimate must not authorize or dispatch');
          },
        },
      });
      try {
        const coldEstimate = await cold.readContextEstimate({
          ...scope,
          executionId: models.at(-1)!.id,
        });
        expect(coldEstimate.contextWindowTokens).toBe(expectedWindow);
        expect(coldEstimate.totalInputTokens).toBe(estimate.totalInputTokens);
        expect((await coldStore.getView('s')).executions.map((execution) => execution.id)).toEqual(
          executionIds,
        );
        expect(requests).toHaveLength(shouldCompress ? 3 : 2);
      } finally {
        await cold.close();
      }
    } finally {
      await runtime.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
