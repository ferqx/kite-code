import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { PermissionDecision } from '@kite-ai/agent/extensions';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { render } from 'ink';
import { TuiController, type TuiPort, TuiSession } from '../../../src/tui';

type Offer = NonNullable<PermissionDecision['grantOffers']>[number];
type Option = NonNullable<NonNullable<PermissionDecision['approval']>['options']>[number];
const { approvalOptions, grantDigest, grantScopeDigest } = (await import(
  join(import.meta.dir, '../../../../agent/src/permission-grants')
)) as {
  approvalOptions(offers: readonly Offer[]): readonly Option[];
  grantDigest(value: unknown): string;
  grantScopeDigest(value: Omit<Offer, 'scopeDigest' | 'policyBindings'>): string;
};

const root = process.argv[2]!;
const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
const candidate = {
  ruleId: 'fixture.command',
  contractId: 'fixture.exact-command',
  scope: { command: 'harmless' },
  bindings: [{ kind: 'tool' as const, definitionId: 'fixture.command', definitionVersion: '1' }],
  presentation: {
    label: '本会话内相同命令',
    details: Array.from({ length: 35 }, (_, n) => `完整范围第${n + 1}行：原命令与会话边界保持。`),
  },
};
const offer = {
  ...candidate,
  scopeDigest: grantScopeDigest(candidate),
  policyBindings: candidate.bindings.map((capability) => ({
    capability,
    reuseRevision: grantDigest(candidate.scope),
  })),
};
let effects = 0,
  posts = 0;
const runtime = createRuntime({
  store,
  modelId: 'fixed',
  model: {
    async *stream() {
      yield { type: 'text_delta', text: 'Original material before approval' };
      yield {
        type: 'tool_call',
        id: 'call',
        name: 'fixture.command',
        arguments: '{"command":"harmless"}',
      };
      yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  },
  permissions: {
    async authorize(request) {
      return request.kind === 'model'
        ? { allowed: true, revision: 'fixture' }
        : {
            allowed: false,
            revision: 'fixture',
            grantOffers: [offer],
            approval: {
              request: { input: request.input },
              options: approvalOptions([offer]),
            },
          };
    },
  },
  extensions: [
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.command',
          version: '1',
          description: 'Harmless test command',
          inputSchema: { type: 'object' },
          async execute() {
            effects++;
            return { outcome: 'succeeded', content: 'done' };
          },
        },
      ],
    },
  ],
});
const storeId = (await store.getMetadata()).storeId;
await runtime.createWorkspace({
  expectedStoreId: storeId,
  id: 'w',
  name: 'temporary',
  rootUri: pathToFileURL(root).href,
});
await runtime.createSession({
  expectedStoreId: storeId,
  subjectId: 'owner',
  commandId: 'create',
  sessionId: 'a',
  workspaceId: 'w',
  title: 'Original approval',
});
const service = await startService({
  runtime,
  profile: { dataRoot: join(root, 'data'), name: 'test', accessKey: 'private-fixture' },
  buildId: 'test',
  subjectId: 'owner',
});
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  bootstrap: service.bootstrap,
  expected: {
    profile: service.bootstrap.profile,
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'commands', 'history', 'interactions'],
    instanceId: service.bootstrap.instanceId,
    buildId: 'test',
  },
});
await client.connect();
let next = 0;
const port: TuiPort = {
  storeId,
  nextCommandId: () => `intent-${++next}`,
  listSessions: (signal) => client.listAllSessions({ signal }),
  async readSession(id, signal) {
    const view = await client.getView(id, { signal });
    const messages = await client.listMessages(id, {
      afterSeq: '0',
      upperSeq: view.session.nextSeq,
      limit: 100,
      signal,
    });
    const { interactions } = await client.listInteractions(
      id,
      { storeId, state: 'pending', limit: 100 },
      { signal },
    );
    return { storeId, view, messages, interactions };
  },
  readModelOutput: (id, executionId, signal) => client.getModelOutput(id, executionId, { signal }),
  submit: (id, intent) =>
    intent.kind === 'run.start'
      ? client.startRun(id, intent)
      : intent.kind === 'input.follow_up'
        ? client.followUp(id, intent)
        : client.steer(id, intent),
  answer: (id, card, intent) => {
    posts++;
    return client.answerInteraction(id, card, intent);
  },
  cancel: (id, intent) => client.cancelCommand(id, intent),
  getCommand: (id) => client.getCommand(id),
};
const controller = new TuiController(port);
await controller.select('a');
process.stdin.setRawMode(true);
const terminal = render(<TuiSession controller={controller} availableRows={23} />, {
  exitOnCtrlC: false,
});
let reading = false;
const abort = new AbortController();
const timer = setInterval(() => {
  if (reading) return;
  reading = true;
  void port
    .readSession('a', abort.signal)
    .then(async (snapshot) => {
      if (JSON.stringify(snapshot) !== JSON.stringify(controller.state.snapshot))
        await controller.select('a');
    })
    .catch(() => {})
    .finally(() => {
      reading = false;
    });
}, 80);
await new Promise<void>((resolve) => process.once('SIGTERM', resolve));
clearInterval(timer);
abort.abort();
controller.dispose();
terminal.unmount();
writeFileSync(
  join(root, 'facts.json'),
  JSON.stringify({
    effects,
    posts,
    interactions: (await runtime.listInteractions({ expectedStoreId: storeId, sessionId: 'a' }))
      .interactions,
  }),
);
client.disposeNetwork();
await service.close();
await runtime.close();
await store.close();
