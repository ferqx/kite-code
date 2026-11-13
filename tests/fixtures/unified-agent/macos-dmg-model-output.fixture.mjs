import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [terminal, scratch] = process.argv.slice(2);
assert(terminal && scratch && !process.versions.bun);
const agent = pathToFileURL(join(terminal, 'code/@kite-ai/agent/'));
const { createRuntime } = await import(new URL('index.js', agent));
const { openSqliteStore } = await import(new URL('sqlite.js', agent));
const { createArtifactStore } = await import(new URL('artifacts.js', agent));
const { createOsCredentialBackend } = await import(new URL('config/index.js', agent));

const credentialBackend = createOsCredentialBackend({
  service: `kite-node-qualification-${randomUUID()}`,
  accountNamespace: 'read-only-fixture',
});
assert.equal(await credentialBackend.resolve(`credential:${randomUUID()}`), null);
console.log('PACKAGED_NODE_KEYCHAIN_LOOKUP_OK');

const dataRoot = mkdtempSync(join(realpathSync(scratch), 'kite-node-model-output-'));
const profile = { dataRoot, profile: 'fixture' };
const reasoning = 'First reasoning 中文';
const content = 'Verified answer';
const usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14, reasoningTokens: 1 };
const ciphertext = 'fixture-encrypted-reasoning';
const { promise: reasoningStored, resolve: confirmReasoning } = Promise.withResolvers();
const { promise: finishAllowed, resolve: allowFinish } = Promise.withResolvers();
const model = {
  async *stream() {
    yield { type: 'reasoning_delta', text: reasoning };
    confirmReasoning();
    await finishAllowed;
    yield { type: 'text_delta', text: content };
    yield { type: 'usage', usage };
    yield {
      type: 'finish',
      reason: 'stop',
      usage,
      continuation: {
        version: 1,
        protocol: 'responses',
        content: [{ type: 'reasoning', encrypted_content: ciphertext }],
      },
    };
  },
};
const permissions = { authorize: async () => ({ allowed: true, revision: 'fixture' }) };
let store;
let runtime;
try {
  store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  let publicationError;
  runtime = createRuntime({
    store,
    model,
    permissions,
    artifacts: {
      ...artifacts,
      async publish(input) {
        try {
          return await artifacts.publish(input);
        } catch (error) {
          publicationError = error;
          throw error;
        }
      },
    },
  });
  const { storeId: expectedStoreId } = await store.getMetadata();
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'fixture' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'fixture',
    rootUri: pathToFileURL(dataRoot).href,
  });
  await runtime.createSession({
    ...scope,
    commandId: 'create',
    workspaceId: 'w',
    title: 'fixture',
  });
  await runtime.submitCommand({
    ...scope,
    commandId: 'work',
    request: { kind: 'run.start', content: 'Exercise packaged Store publication' },
  });
  await reasoningStored;
  const { executionId } = (await runtime.listModelInputs(scope)).items[0];
  const outputScope = { ...scope, executionId };
  const partial = await runtime.readModelOutput(outputScope);
  assert.equal(partial.status, 'dispatching');
  assert.deepEqual(partial.output, { content: '', reasoning, toolCalls: [], complete: false });

  allowFinish();
  await runtime.waitForCommand('work', { timeoutMs: 10_000 });
  if (publicationError) throw publicationError;
  const execution = await store.getExecution(executionId);
  assert.equal(execution.status, 'succeeded');
  assert.equal(execution.result.firstOutput, 'reasoning');
  assert.deepEqual(execution.result.usage, usage);
  const sealed = (await store.getModelOutputSnapshot(outputScope)).output;
  assert(sealed?.complete && sealed.seq === '3');

  await runtime.close();
  runtime = undefined;
  store = undefined;
  store = await openSqliteStore({ ...profile, mode: 'readonly' });
  const coldArtifacts = createArtifactStore({ profile, store });
  runtime = createRuntime({ store, model, permissions, artifacts: coldArtifacts });
  const final = await runtime.readModelOutput(outputScope);
  assert.deepEqual(final.output, { content, reasoning, toolCalls: [], complete: true });
  assert(!JSON.stringify(final).includes(ciphertext));
  const bytes = await coldArtifacts.readReference({ expectedStoreId, reference: sealed.head });
  const segment = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(segment.delta.kind, 'continuation');
  assert.equal(JSON.parse(segment.delta.text).content[0].encrypted_content, ciphertext);
  console.log('PACKAGED_NODE_MODEL_OUTPUT_OK');
} finally {
  allowFinish();
  if (runtime) await runtime.close();
  else await store?.close();
  rmSync(dataRoot, { recursive: true, force: true });
}
