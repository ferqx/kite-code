import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createSummaryCompressor } from '../../src/compression-configuration';

const previousInput = 'Independent historical user task.';
const currentInput = 'Use the current request only.';
const currentCorrection = 'Use the current request with this corrected scope.';
const previousOutput = 'Earlier settled evidence. '.repeat(3600);
const toolOutput = 'Read evidence still needed by the Model. '.repeat(2200);
const checkpointText = 'The independent task was completed.';

for (const mode of [
  'reduced',
  'in-band-overflow',
  'still-overflow',
  'protected-tool',
  'maintenance-rejected',
  'steered',
  'unclassified-provider',
] as const) {
  test(`explicit Provider overflow has one bounded recovery: ${mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-agent-window-')));
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    const store = await openSqliteStore(profile);
    const scope = {
      expectedStoreId: (await store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
    };
    const requests: {
      summary: boolean;
      status: number;
      streamOverflow: boolean;
      hasPrevious: boolean;
      hasCurrent: boolean;
      hasCorrection: boolean;
      hasTool: boolean;
      bytes: number;
    }[] = [];
    const summaryEntered = Promise.withResolvers<void>();
    const releaseSummary = Promise.withResolvers<void>();
    const seedOutput = mode === 'maintenance-rejected' ? previousOutput.repeat(2) : previousOutput;
    const modelId = 'fixture';
    const binding = createCompatibleModelBinding({
      name: modelId,
      baseURL: 'https://model.fixture.invalid/v1',
      modelId,
      apiKey: 'local-fixture-only',
      fetch: Object.assign(
        async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const raw = String(init?.body);
          const body = JSON.parse(raw) as { messages: { role: string; content?: string }[] };
          const messages = body.messages.map(({ content }) => content ?? '');
          const summary = messages.some((content) =>
            content.startsWith('Summarize the preceding recorded conversation'),
          );
          const hasCheckpoint = messages.some((content) => content.includes(checkpointText));
          const hasTool = body.messages.some(
            ({ role, content }) =>
              role === 'tool' && content?.includes('Read evidence still needed'),
          );
          const rejected =
            mode === 'unclassified-provider'
              ? requests.length === 1
              : ((!summary || mode === 'maintenance-rejected') && raw.length > 25_000) ||
                (mode === 'still-overflow' && hasCheckpoint);
          const streamOverflow = rejected && mode === 'in-band-overflow';
          requests.push({
            summary,
            status: rejected && !streamOverflow ? 400 : 200,
            streamOverflow,
            hasPrevious: messages.includes(previousInput),
            hasCurrent: messages.includes(currentInput),
            hasCorrection: messages.includes(currentCorrection),
            hasTool,
            bytes: raw.length,
          });
          if (rejected && mode === 'unclassified-provider')
            return new Response('The configured private deployment could not accept the input.', {
              status: 400,
              headers: { 'content-type': 'text/plain' },
            });
          if (rejected) {
            const response = {
              error: {
                message: 'The input exceeds the fixture window.',
                code: 'context_length_exceeded',
              },
            };
            if (streamOverflow)
              return new Response(`data: ${JSON.stringify(response)}\n\n`, {
                headers: { 'content-type': 'text/event-stream' },
              });
            return Response.json(response, { status: 400 });
          }
          if (mode === 'steered' && summary && requests.length === 3) {
            summaryEntered.resolve();
            await releaseSummary.promise;
          }
          const call = mode === 'protected-tool' && requests.length === 1;
          const chunk = (delta: object, finish_reason: string | null = null) =>
            `data: ${JSON.stringify({
              id: 'fixture',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`;
          const content = summary
            ? checkpointText
            : requests.length === 1
              ? seedOutput
              : 'Completed the current task.';
          return new Response(
            chunk(
              call
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'fixture-observation',
                        type: 'function',
                        function: { name: 'observe_fixture', arguments: '{}' },
                      },
                    ],
                  }
                : { content },
            ) +
              chunk({}, call ? 'tool_calls' : 'stop') +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
        { preconnect: fetch.preconnect },
      ),
    });
    let observations = 0;
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      modelId,
      model: createSdkModelAdapter({ models: new Map([[modelId, binding]]) }),
      compressor: createSummaryCompressor({
        automatic: {
          contextWindowTokens: 128_000,
          maxOutputTokens: 8_000,
          ...(mode === 'maintenance-rejected' ? { thresholdTokens: 6_000 } : {}),
        },
      }),
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.observe',
              model: { name: 'observe_fixture' },
              version: '1',
              description: 'Read the fixture observation.',
              inputSchema: { type: 'object', additionalProperties: false, properties: {} },
              async execute() {
                observations++;
                return { outcome: 'succeeded', content: toolOutput };
              },
            },
          ],
        },
      ],
    });
    const run = async (commandId: string, content: string) => {
      await runtime.submitCommand({ ...scope, commandId, request: { kind: 'run.start', content } });
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 8000 });
      return (await store.getRun((command.receipt as { runId: string }).runId))!;
    };
    try {
      await runtime.createWorkspace({
        expectedStoreId: scope.expectedStoreId,
        id: 'w',
        name: 'Fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...scope,
        commandId: 'create',
        workspaceId: 'w',
        title: 'Fixture',
      });
      if (mode !== 'protected-tool')
        expect(await run('previous', previousInput)).toMatchObject({ status: 'completed' });
      await runtime.submitCommand({
        ...scope,
        commandId: 'current',
        request: { kind: 'run.start', content: currentInput },
      });
      if (mode === 'steered') {
        const terminal = runtime.waitForCommand('current', { timeoutMs: 8_000 });
        await Promise.race([
          summaryEntered.promise,
          terminal.then(() => {
            throw Error('The Run ended before the recovery summary started.');
          }),
        ]);
        const activeRun = (await store.getView('s')).runs.find(
          ({ originCommandId }) => originCommandId === 'current',
        )!;
        await runtime.submitCommand({
          ...scope,
          commandId: 'correction',
          request: {
            kind: 'input.steer',
            targetRunId: activeRun.id,
            contextSelectionId: activeRun.contextSelectionId,
            content: currentCorrection,
          },
        });
        releaseSummary.resolve();
      }
      const command = await runtime.waitForCommand('current', { timeoutMs: 8_000 });
      const work = (await store.getRun((command.receipt as { runId: string }).runId))!;
      const active = (await store.getModelContext(scope)).compression;
      const models = (await store.listExecutions('s', 100)).filter(
        ({ kind, runId }) => kind === 'model' && runId === work.id,
      );
      const failed = models.filter(({ status }) => status === 'failed');
      if (mode === 'unclassified-provider') {
        expect(work.status).toBe('completed');
        expect(active).toBeUndefined();
        expect(requests.map(({ status, summary }) => [status, summary])).toEqual([
          [200, false],
          [400, false],
          [200, false],
        ]);
        expect(failed).toHaveLength(1);
        expect(failed[0]?.result).toMatchObject({
          modelFailure: {
            providerMessage:
              'HTTP 400 · The configured private deployment could not accept the input.',
          },
        });
        return;
      }
      expect(failed).toHaveLength(
        mode === 'still-overflow' || mode === 'maintenance-rejected' ? 2 : 1,
      );
      for (const rejection of failed)
        expect(rejection.result).toMatchObject({
          code: 'model_context_overflow',
          incomplete: true,
          content: '',
        });
      if (mode === 'protected-tool') {
        expect(work).toMatchObject({ status: 'failed', reason: 'compression_insufficient_space' });
        expect(observations).toBe(1);
        expect(active).toBeUndefined();
        expect(requests.map(({ status }) => status)).toEqual([200, 400]);
        expect(requests.at(-1)?.hasTool).toBe(true);
      } else {
        expect(work).toMatchObject(
          mode === 'still-overflow'
            ? { status: 'failed', reason: 'model_context_overflow' }
            : { status: 'completed' },
        );
        expect(active?.trigger).toBe('automatic');
        expect(BigInt(active!.inputHighWaterSeq!)).toBeGreaterThan(
          BigInt(active!.coveredThroughSeq),
        );
        expect(requests.map(({ status }) => status)).toEqual([
          200,
          mode === 'in-band-overflow' ? 200 : 400,
          ...(mode === 'maintenance-rejected' ? [400] : []),
          ...(mode === 'steered' ? [200] : []),
          200,
          mode === 'still-overflow' ? 400 : 200,
        ]);
        if (mode === 'in-band-overflow') expect(requests[1]?.streamOverflow).toBe(true);
        expect(requests.at(-2)).toMatchObject({
          summary: true,
          hasPrevious: true,
          hasCurrent: false,
        });
        expect(requests.at(-1)).toMatchObject({
          summary: false,
          hasPrevious: false,
          hasCurrent: true,
          hasCorrection: mode === 'steered',
        });
        if (mode === 'maintenance-rejected') expect(requests[1]?.summary).toBe(true);
        if (mode === 'steered') {
          expect(requests[2]).toMatchObject({ summary: true, hasCorrection: false });
          expect(await store.getCommand('correction')).toMatchObject({ status: 'applied' });
        }
        expect(requests.at(-1)!.bytes).toBeLessThan(
          requests[mode === 'maintenance-rejected' ? 2 : 1]!.bytes,
        );
        expect(
          models.filter(
            ({ decisionSource }) =>
              (decisionSource as { overflowRecovery?: unknown }).overflowRecovery,
          ),
        ).toHaveLength(mode === 'steered' ? 3 : 2);
      }
    } finally {
      releaseSummary.resolve();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
