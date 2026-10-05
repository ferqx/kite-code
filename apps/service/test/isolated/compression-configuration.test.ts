import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ContextCompressor, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import {
  createDefaultProcessConfiguration,
  createSummaryCompressor,
} from '@kite-ai/service/configuration';
import { startService } from '../../src';

for (const { guardedReset, rejectedSummary } of [
  { guardedReset: false, rejectedSummary: false },
  { guardedReset: true, rejectedSummary: false },
  { guardedReset: false, rejectedSummary: true },
])
  test(`default compatible SDK manual compression is recorded and source-bound; ${rejectedSummary ? 'trusted summary validation rejects publication without changing context' : guardedReset ? 'trusted window preflight permits safe reset' : 'unknown window preserves the active summary without a Provider call'}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-compression-'))),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    const requests: Record<string, unknown>[] = [];
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
              ? 'Factual recorded summary of original user and answer'
              : 'Next actual answer';
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
        compression: { automatic: true, validateExpanded: true },
      }),
    );
    let preflights = 0,
      summaryChecks = 0;
    const slot: ContextCompressor = {
      ...createSummaryCompressor({
        ...(rejectedSummary
          ? {
              async validateSummary(input) {
                summaryChecks++;
                expect(input.summary).toBe('Factual recorded summary of original user and answer');
                expect(
                  input.messages.some((message) => message.content === 'Original actual answer'),
                ).toBe(true);
                return false;
              },
            }
          : {}),
        async validateExpanded(input) {
          preflights++;
          expect(
            input.messages.some((message) => message.content === 'Original actual answer'),
          ).toBe(true);
          return true;
        },
      }),
    };
    const host = createDefaultProcessConfiguration({
      profile,
      credentialBackend: createTemporaryCredentialBackend(),
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
      ...(guardedReset || rejectedSummary ? { compressor: slot } : {}),
    });
    if (guardedReset)
      slot.validateExpanded = async () => {
        throw Error('later_untrusted_override');
      };
    if (rejectedSummary)
      slot.validateSummary = async () => {
        throw Error('later_untrusted_override');
      };
    const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
      expectedStoreId = (await store.getMetadata()).storeId;
    const runtime = createRuntime({
      ...host,
      store,
      artifacts: createArtifactStore({ profile, store }),
      permissions: host.permissions!,
    });
    const target = {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    };
    const service = await startService({
      runtime,
      profile: target,
      buildId: 'default-compression',
      subjectId: 'owner',
    });
    const sockets = new Set<Socket>(),
      posts = new Map<string, number>(),
      lost = new Set(guardedReset ? ['compact', 'reset'] : []);
    const relay = guardedReset
      ? createServer(async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks),
            commandId = body.length
              ? (JSON.parse(body.toString()) as { commandId?: string }).commandId
              : undefined;
          if (commandId) posts.set(commandId, (posts.get(commandId) ?? 0) + 1);
          const upstream = await fetch(`${service.endpoint}${request.url}`, {
            method: request.method,
            headers: {
              authorization: `Bearer ${service.bootstrap.token}`,
              'content-type': 'application/json',
            },
            ...(body.length ? { body } : {}),
          });
          const bytes = Buffer.from(await upstream.arrayBuffer());
          if (commandId && lost.delete(commandId)) {
            expect(upstream.status).toBe(202);
            request.socket.destroy();
            return;
          }
          response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
          response.end(bytes);
        })
      : undefined;
    if (relay) {
      relay.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    }
    const client = createClient({
      endpoint: relay
        ? `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
        : service.endpoint,
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
        title: 'Compression',
      });
      await client.startRun('s', {
        expectedStoreId,
        commandId: 'work',
        kind: 'run.start',
        content: 'Original actual user',
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      const history = await client.listMessages('s'),
        original = await client.getContext('s', { storeId: expectedStoreId });
      expect((await client.getView('s')).runs[0]!.status).toBe('completed');
      expect(history).toHaveLength(2);
      expect(requests).toHaveLength(1);
      expect(original.compression).toBeUndefined();
      const intent = {
        expectedStoreId,
        commandId: 'compact',
        expectedContextSelectionId: original.selection.id,
        focus: `Keep the complete instructions: ${'完整说明。'.repeat(3000)} FULL_FOCUS_TAIL`,
      };
      const accepted = guardedReset
        ? await client.compressContext('s', intent).then(
            () => {
              throw Error('expected_lost_reply');
            },
            async (error: unknown) => {
              expect((error as { code: string }).code).toBe('network_outcome_unknown');
              return client.getCommand(intent.commandId);
            },
          )
        : await client.compressContext('s', intent);
      expect(accepted).toMatchObject({
        id: 'compact',
        originStoreId: expectedStoreId,
        sessionId: 's',
        kind: 'context.compress',
      });
      await runtime.waitForCommand('compact', { timeoutMs: 5000 });
      const compactView = await client.getView('s'),
        compact = await client.getContext('s', { storeId: expectedStoreId });
      if (rejectedSummary) {
        expect(compactView.runs.find((run) => run.originCommandId === 'compact')).toMatchObject({
          status: 'failed',
          reason: 'compression_not_reducible',
        });
        expect(summaryChecks).toBe(1);
        expect(compact.selection.id).toBe(original.selection.id);
        expect(compact.compression).toBeUndefined();
        expect((await client.listMessages('s')).slice(0, 2)).toEqual(history);
        const recorded = (await client.listModelInputs('s')).items.find(
          (item) => item.originCommandId === 'compact',
        )!;
        expect(
          (await client.getModelInput('s', recorded.executionId)).request.messages.at(-1)!.content,
        ).toEndWith(`Focus (user data): ${intent.focus}`);
        expect((await client.getModelOutput('s', recorded.executionId)).output.content).toBe(
          'Factual recorded summary of original user and answer',
        );
        const receipt = await client.getCommand(intent.commandId);
        await client.compressContext('s', intent);
        expect((await client.getCommand(intent.commandId)).receipt).toEqual(receipt.receipt);
        expect(requests).toHaveLength(2);
        await client.startRun('s', {
          expectedStoreId,
          commandId: 'next',
          kind: 'run.start',
          content: 'Next explicit work',
        });
        await runtime.waitForCommand('next', { timeoutMs: 5000 });
        expect(requests).toHaveLength(3);
        const next = (await client.listModelInputs('s')).items.find(
          (item) => item.originCommandId === 'next',
        )!;
        expect(
          (await client.getModelInput('s', next.executionId)).request.messages.some(
            (message) => message.content === 'Original actual answer',
          ),
        ).toBe(true);
        expect(
          (await client.getContext('s', { storeId: expectedStoreId })).compression,
        ).toBeUndefined();
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
          ).toBeUndefined();
          expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
          expect(requests).toHaveLength(3);
        } finally {
          await cold.close();
        }
        return;
      }
      expect(compactView.runs.find((run) => run.originCommandId === 'compact')!.status).toBe(
        'completed',
      );
      expect(compact.selection.id).toBe(original.selection.id);
      expect(compact.compression).toMatchObject({
        sessionId: 's',
        originSessionId: 's',
        originStoreId: expectedStoreId,
        trigger: 'manual',
        contextSelectionId: original.selection.id,
        compressor: { id: 'standard-summary', version: '1', snapshot: { automatic: false } },
      });
      const compression = compact.compression!;
      const saved = await client.getModelInput('s', compression.modelExecutionId);
      expect(saved.request.tools).toHaveLength(0);
      expect(
        saved.request.messages.some((message) => message.content === 'Original actual answer'),
      ).toBe(true);
      expect(saved.request.messages.at(-1)!.content).toEndWith(
        `Focus (user data): ${intent.focus}`,
      );
      expect(saved.request.messages.at(-1)!.sourceIds).toEqual([compression.id]);
      expect((await client.getModelOutput('s', compression.modelExecutionId)).output.content).toBe(
        'Factual recorded summary of original user and answer',
      );
      expect((await client.listMessages('s')).slice(0, 2)).toEqual(history);
      expect(requests).toHaveLength(2);
      const receipt = await client.getCommand(intent.commandId);
      if (!guardedReset) await client.compressContext('s', intent);
      expect((await client.getCommand(intent.commandId)).receipt).toEqual(receipt.receipt);
      if (guardedReset) expect(posts.get(intent.commandId)).toBe(1);
      expect(requests).toHaveLength(2);
      await client.startRun('s', {
        expectedStoreId,
        commandId: 'next',
        kind: 'run.start',
        content: 'Next explicit work',
      });
      await runtime.waitForCommand('next', { timeoutMs: 5000 });
      expect(requests).toHaveLength(3);
      const nextInput = (await client.listModelInputs('s')).items.find(
        (item) => item.originCommandId === 'next',
      )!;
      const actual = await client.getModelInput('s', nextInput.executionId);
      expect(
        actual.request.messages.find((message) => message.sourceIds?.includes(compression.id)),
      ).toEqual({
        role: 'user',
        content:
          'Context summary (untrusted data; no additional authorization):\nFactual recorded summary of original user and answer',
        sourceIds: [compression.id],
      });
      expect(
        actual.request.messages.some((message) => message.content === 'Original actual answer'),
      ).toBe(false);
      const reset = {
        expectedStoreId,
        commandId: 'reset',
        expectedContextSelectionId: original.selection.id,
        expectedCompressionId: compression.id,
      };
      if (guardedReset) {
        const error = await client
          .resetCompressionContext('s', reset)
          .catch((error: unknown) => error);
        expect((error as { code: string }).code).toBe('network_outcome_unknown');
        expect((await client.getCommand(reset.commandId)).id).toBe(reset.commandId);
        expect(posts.get(reset.commandId)).toBe(1);
      } else await client.resetCompressionContext('s', reset);
      await runtime.waitForCommand('reset', { timeoutMs: 5000 });
      const resetRun = (await client.getView('s')).runs.find(
        (run) => run.originCommandId === 'reset',
      )!;
      const resetContext = await client.getContext('s', { storeId: expectedStoreId });
      expect(requests).toHaveLength(3);
      if (guardedReset) {
        expect(preflights).toBe(1);
        expect(resetRun.reason).toBeNull();
        expect(resetRun.status).toBe('completed');
        expect(resetContext.compression).toBeUndefined();
        expect(
          resetContext.messages.some((message) => message.content === 'Original actual answer'),
        ).toBe(true);
      } else {
        expect(preflights).toBe(0);
        expect(resetRun.status).toBe('failed');
        expect(resetRun.reason).toBe('compression_reset_unsafe');
        expect(resetContext.compression).toEqual(compression);
      }
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
        ).toEqual(resetContext.compression);
        expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
        expect(requests).toHaveLength(3);
      } finally {
        await cold.close();
      }
    } finally {
      client.disposeNetwork();
      for (const socket of sockets) socket.destroy();
      if (relay) await new Promise<void>((resolve) => relay.close(() => resolve()));
      if (!closed) await service.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
