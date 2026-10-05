import { pathToFileURL } from 'node:url';

const [mode, dataRoot, profile, ledgerPath, extensionPath] = process.argv.slice(2);
if (!mode || !dataRoot || !profile)
  throw new Error('Explicit fixture mode/dataRoot/profile required.');

if (mode === 'import') {
  const root = await import('@kite-ai/agent');
  console.log(JSON.stringify({ exportedKeys: Object.keys(root) }));
  process.exit(0);
}

const { openSqliteStore } = await import('@kite-ai/agent/sqlite');
const store = await openSqliteStore({
  dataRoot,
  profile,
  mode: mode === 'read' ? 'readonly' : 'readwrite',
});
if (mode === 'read') {
  try {
    const metadata = await store.getMetadata();
    const command = await store.getCommand('work-1');
    const view = await store.getView('session-1');
    console.log(JSON.stringify({ metadata, command, view, modelRequests: 0 }));
  } finally {
    await store.close();
  }
} else {
  if (!ledgerPath || !extensionPath)
    throw new Error('Explicit ledger and compiled extension required.');
  const { createRuntime } = await import('@kite-ai/agent');
  const { createFixedModel } = await import('@kite-ai/ai');
  const { countedTool } = await import(pathToFileURL(extensionPath).href);
  const events = [
    {
      type: 'tool_call' as const,
      id: 'call-1',
      name: 'fixture.count',
      arguments: JSON.stringify({ value: 'hello', ...(mode === 'fail' ? { fail: true } : {}) }),
    },
  ];
  const model = createFixedModel(
    mode === 'no-tool'
      ? [
          [
            { type: 'text_delta', text: 'plain answer' },
            { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
        ]
      : mode === 'partial'
        ? [events]
        : mode === 'model-error'
          ? [[...events, new Error('Fixture model stream failed')]]
          : [
              [
                ...events,
                {
                  type: 'finish',
                  reason: 'tool_calls',
                  usage: { inputTokens: 1, outputTokens: 1 },
                },
              ],
              [
                { type: 'text_delta', text: 'finished' },
                { type: 'finish', reason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } },
              ],
              [
                { type: 'text_delta', text: 'other session still works' },
                { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
              ],
            ],
  );
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: mode === 'no-tool' ? [] : [countedTool(ledgerPath)],
    permissions: {
      async authorize(request) {
        return {
          allowed: !(mode === 'deny' && request.definitionId === 'fixture.count'),
          revision: 'permission-1',
        };
      },
    },
  });
  try {
    const metadata = await store.getMetadata();
    const expectedStoreId = metadata.storeId;
    await runtime.createWorkspace({
      id: 'workspace-1',
      rootUri: pathToFileURL(dataRoot).href,
      name: 'Disposable',
      expectedStoreId,
    });
    await runtime.createSession({
      commandId: 'create-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      title: 'Counted fixture',
      subjectId: 'test',
      expectedStoreId,
    });
    const commandInput = {
      commandId: 'work-1',
      sessionId: 'session-1',
      subjectId: 'test',
      expectedStoreId,
      request: { kind: 'run.start' as const, content: 'Run the external counted fixture.' },
    };
    await runtime.submitCommand(commandInput);
    await runtime.waitForCommand('work-1', { timeoutMs: 10_000 });
    const original = await runtime.getCommand('work-1');
    const view = await runtime.getView('session-1');
    const requestCount = model.requests.length;
    await runtime.submitCommand(commandInput);
    await runtime.waitForCommand('work-1', { timeoutMs: 10_000 });
    let conflict: string | null = null;
    try {
      await runtime.submitCommand({
        ...commandInput,
        request: { ...commandInput.request, content: 'Different semantic input' },
      });
    } catch (error) {
      conflict = error instanceof Error && 'code' in error ? String(error.code) : String(error);
    }
    let otherRunStatus: string | undefined;
    if (mode === 'fail') {
      await runtime.createSession({
        commandId: 'create-2',
        sessionId: 'session-2',
        workspaceId: 'workspace-1',
        title: 'Unrelated session',
        subjectId: 'test',
        expectedStoreId,
      });
      await runtime.submitCommand({
        ...commandInput,
        commandId: 'work-2',
        sessionId: 'session-2',
        request: { kind: 'run.start', content: 'A plain unrelated conversation' },
      });
      await runtime.waitForCommand('work-2', { timeoutMs: 10_000 });
      otherRunStatus = (await runtime.getView('session-2')).runs[0]?.status;
    }
    console.log(
      JSON.stringify({
        metadata,
        command: original,
        view,
        modelRequests: model.requests.length,
        requestCount,
        conflict,
        otherRunStatus,
      }),
    );
  } finally {
    await runtime.close();
  }
}
