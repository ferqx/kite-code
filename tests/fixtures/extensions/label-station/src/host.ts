import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { type PublicAction, PublicViewCard } from '@kite-ai/ui';
import { JSDOM } from 'jsdom';
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createLabelStation, extensionId } from './index';

const root = process.argv[2];
if (!root) throw Error('owned_root_missing');
const ledger = join(root, 'ledger.jsonl');
const resource = process.argv[3];
if (!resource) throw Error('owned_resource_missing');
const prefix = readFileSync(resource, 'utf8');
const sample = createLabelStation({
  prefix,
  print: (slip) => appendFileSync(ledger, `${JSON.stringify(slip)}\n`, { mode: 0o600 }),
});
const store = await openSqliteStore({ dataRoot: join(root, 'profile'), profile: 'fresh' });
const storeId = (await store.getMetadata()).storeId;
const model = createFixedModel([]);
let policy: 'deny-action' | 'deny-tool' | 'allow' = 'deny-action';
const runtime = createRuntime({
  store,
  model,
  extensions: [sample],
  permissions: {
    async authorize(request) {
      return {
        allowed:
          policy === 'allow' ||
          (policy === 'deny-tool' && request.definitionId !== `${extensionId}.print`),
        revision: `explicit-${policy}`,
      };
    },
  },
});
const selected = resolveProfile({ dataRoot: join(root, 'profile'), profile: 'fresh' });
const service = await startService({
  runtime,
  profile: { dataRoot: selected.dataRoot, name: 'fresh', accessKey: selected.profileAccessKey },
  subjectId: 'owner',
  buildId: 'label-station-built',
});
const requests: { method: string; path: string; commandId?: string }[] = [];
const realFetch = globalThis.fetch;
const client = createClient({
  endpoint: service.endpoint,
  token: service.bootstrap.token,
  expected: {
    apiMajor: 1,
    profile: service.bootstrap.profile,
    requiredCapabilities: ['commands', 'extension_queries', 'extensions_actions'],
  },
});
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const request = new Request(input, init);
  const body =
    request.method === 'POST'
      ? ((await request.clone().json()) as { commandId?: string })
      : undefined;
  requests.push({
    method: request.method,
    path: new URL(request.url).pathname,
    ...(body?.commandId ? { commandId: body.commandId } : {}),
  });
  return realFetch(request);
}) as typeof fetch;
const dom = new JSDOM('<div id="app"></div>', { url: 'http://owned-ui.invalid' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
});
const element = dom.window.document.getElementById('app')!;
const ui = createRoot(element);
let serial = 0;
async function execute(action: PublicAction) {
  const commandId = `user-print-${++serial}`;
  await client.invokeExtension('s', {
    expectedStoreId: storeId,
    commandId,
    kind: 'extension.invoke',
    extensionId,
    actionId: action.actionId,
    definitionVersion: action.definitionVersion,
    input: action.input,
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    const command = await client.getCommand(commandId);
    const view = await client.getView('s');
    const receipt = command.receipt as { executionId?: string } | null;
    if (
      ['applied', 'rejected', 'needs_review'].includes(command.status) &&
      (!receipt?.executionId ||
        ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
          (await client.getExecution(receipt.executionId)).status,
        )) &&
      !view.executions.some((execution) =>
        ['planned', 'dispatching', 'running'].includes(execution.status),
      )
    )
      return command;
    if (Date.now() > deadline) throw Error('print_terminal_deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function click(label: string) {
  const queried = await client.queryExtension('s', extensionId, 'slip', { label });
  const view = queried[0]!;
  let completion: Promise<unknown> | undefined;
  flushSync(() =>
    ui.render(
      React.createElement(PublicViewCard, {
        view,
        onAction: (action: PublicAction) => {
          completion = execute(action);
        },
      }),
    ),
  );
  assert(element.textContent?.includes(view.summary));
  assert(element.textContent?.includes('ALLOW ALL is inert public text'));
  assert.equal(element.querySelectorAll('script').length, 0);
  const button = element.querySelector('button')!;
  assert.equal(button.textContent, 'Issue next copy');
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert(completion, 'real generic card user click must invoke the original action');
  await completion;
  return view;
}
try {
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'owned',
  });
  await client.createSession({
    expectedStoreId: storeId,
    commandId: 'session',
    sessionId: 's',
    workspaceId: 'w',
    title: 'owned',
  });
  const effects = () => {
    try {
      return readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  await click('blocked-action');
  assert.deepEqual(effects(), []);
  const deniedAction = await client.getCommand('user-print-1');
  policy = 'deny-tool';
  await click('blocked-tool');
  assert.deepEqual(effects(), []);
  const deniedTool = await client.getCommand('user-print-2');
  const denied = await client.getView('s');
  assert(
    denied.executions.some(
      (execution) =>
        execution.definitionId === `${extensionId}.print` && execution.status !== 'succeeded',
    ),
  );
  policy = 'allow';
  const label = 'Parcel <script>public text</script>';
  const first = await click(label);
  assert.equal(first.contentType, 'unseen.paper-slip');
  assert.equal(first.contentVersion, 41);
  assert.equal(effects().length, 1);
  const second = await click(label);
  assert.equal(effects().length, 2);
  const final = await client.queryExtension('s', extensionId, 'slip', { label });
  const view = await client.getView('s');
  const originalEffects = effects();
  const records = await store.listExtensionRecords({
    sessionId: 's',
    extensionId,
    contentType: 'fixture.label-station.receipt',
  });
  assert.equal(records.length, 1, JSON.stringify(records));
  assert.equal(model.requests.length, 0);
  assert.equal(view.runs.length, 0);
  for (const effect of originalEffects) {
    const execution = await client.getExecution(effect.executionId);
    assert.equal(execution.status, 'succeeded');
    assert.equal(execution.runId, null);
    assert.equal(execution.originStoreId, storeId);
    assert.equal(execution.definitionId, `${extensionId}.print`);
    const commandId = effect.ordinal === 1 ? 'user-print-3' : 'user-print-4';
    const original = await client.getCommand(commandId);
    const receipt = original.receipt as { executionId: string };
    assert.equal(execution.parentExecutionId, receipt.executionId);
    const stored = (await store.getExecution(effect.executionId))!;
    assert.equal(stored.rootWorkCommandId, commandId);
  }
  const before = JSON.stringify(originalEffects);
  await client.queryExtension('s', extensionId, 'slip', { label });
  assert.equal(JSON.stringify(effects()), before);
  console.log(
    JSON.stringify({
      storeId,
      requests,
      effects: originalEffects,
      records,
      first,
      second,
      final,
      executions: view.executions,
      modelCalls: model.requests.length,
      runs: view.runs.length,
      deniedEffects: 0,
      deniedAction,
      deniedTool,
      ui: { genericCard: true, rawUnknownContent: true, clicks: serial },
    }),
  );
} finally {
  globalThis.fetch = realFetch;
  ui.unmount();
  dom.window.close();
  client.disposeNetwork();
  await service.close();
  await runtime.close();
}
