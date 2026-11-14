import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { AuthorizationDeniedError } from '../../../src/execution/interactions';
import { openSqliteStore } from '../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const reason = 'file_full_access_required';
const cases = [
  { name: 'write', owner: 'builtin.files', id: 'files.write', version: '3', explained: true },
  { name: 'edit', owner: 'builtin.files', id: 'files.edit', version: '2', explained: true },
  { name: 'foreign owner', owner: 'fixture', id: 'files.write', version: '3' },
  { name: 'unknown version', owner: 'builtin.files', id: 'files.write', version: '4' },
  { name: 'read', owner: 'builtin.files', id: 'files.read', version: '5' },
  {
    name: 'protected path',
    owner: 'builtin.files',
    id: 'files.write',
    version: '3',
    denied: 'file_path_protected',
  },
  {
    name: 'adapter lookalike',
    owner: 'builtin.files',
    id: 'files.write',
    version: '3',
    adapterError: true,
  },
];
for (const entry of cases)
  test(`Files scope feedback explains only the exact registered gate refusal: ${entry.name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-files-scope-feedback-'));
    const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
    const denied = entry.denied ?? reason;
    let effects = 0;
    const model = createFixedModel([
      [
        { type: 'tool_call', id: 'original', name: entry.id, arguments: '{}' },
        { ...finish, reason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Report the original result without another operation.' },
        finish,
      ],
    ]);
    const runtime = createRuntime({
      store,
      model,
      permissions: {
        async authorize(request) {
          return request.kind === 'tool' && request.definitionId === entry.id && !entry.adapterError
            ? { allowed: false, revision: 'owned', reason: denied }
            : { allowed: true, revision: 'owned' };
        },
      },
      extensions: [
        {
          id: entry.owner,
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: entry.id,
              version: entry.version,
              description: 'Exact registered operation used to exercise gate feedback only.',
              inputSchema: { type: 'object' },
              async execute() {
                effects++;
                throw new AuthorizationDeniedError('permission_denied', reason);
              },
            },
          ],
        },
      ],
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Owned feedback fixture',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'Scope feedback',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: 'Perform the original operation and report its result.',
          // A selected local path is input data, never an authorization grant.
          files: [{ name: 'selected.txt', uri: pathToFileURL(join(root, 'selected.txt')).href }],
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 4000 });
      const tools = (await store.listExecutions('s')).filter((e) => e.kind === 'tool');
      expect(tools).toHaveLength(1);
      const tool = tools[0]!;
      const result = tool.result as { content: string; details: Record<string, unknown> };
      expect(result.details).toMatchObject({
        code: 'permission_denied',
        adapterAttempted: !!entry.adapterError,
        dispatchCommitted: !!entry.adapterError,
      });
      expect(effects).toBe(entry.adapterError ? 1 : 0);
      expect(tool.status).toBe(entry.adapterError ? 'outcome_unknown' : 'failed');
      expect(tool.authorization?.dispatched).toBe(!!entry.adapterError);
      expect(result.details.reason).toBe(entry.adapterError ? undefined : denied);
      const explanation = 'This is a limitation of this tool entry';
      if (entry.explained) {
        expect(result.content).toContain(explanation);
        expect(result.content).toContain('not a user rejection');
        expect(result.content).toContain('not approval for another tool');
        expect(result.content).toContain('no prior refusal or unknown outcome');
        expect(result.content).toContain('under its existing approval rules');
        expect(result.content).toContain(
          'Preserve the original delivery target and once-only limits',
        );
      } else expect(result.content).not.toContain(explanation);
      if (!entry.adapterError) {
        expect(result.content).toContain(`Reason: ${denied}`);
        expect(result.content).toContain('was not executed');
      }
      expect(model.requests).toHaveLength(2);
      const feedback = model.requests[1]!.messages.find((message) => message.role === 'tool')!;
      expect(feedback.toolCallId).toBe('original');
      expect(feedback.sourceIds).toEqual([tool.id]);
      expect(feedback.content).not.toContain('permission_denied');
      expect(feedback.content).not.toContain(denied);
      if (entry.explained) {
        expect(feedback.content).toContain('requires Full mode');
        expect(feedback.content).toContain('did not change the file');
        expect(feedback.content).toContain('not a user rejection');
        expect(feedback.content).toContain('separately authorized request');
        expect(feedback.content).toContain('within its own permissions');
        expect(feedback.content).toContain('earlier refusal or unknown result prevents it');
      } else {
        expect(feedback.content).not.toContain('requires Full mode');
        expect(feedback.content).not.toContain('separately authorized request');
        if (entry.denied === 'file_path_protected') {
          expect(feedback.content).toContain('path is protected');
          expect(feedback.content).toContain('Approval does not remove');
        } else if (!entry.adapterError) {
          expect(feedback.content).toContain('permissions do not allow');
          expect(feedback.content).toContain('not executed');
        }
      }
      if (entry.adapterError) expect(feedback.content).toContain('may have produced effects');
    } finally {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
