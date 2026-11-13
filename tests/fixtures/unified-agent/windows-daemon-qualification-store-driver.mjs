import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const [root, options, expectedVersion, expectedSource] = process.argv.slice(2);
const agent = (leaf) => pathToFileURL(join(root, 'node_modules', '@kite-ai', 'agent', leaf)).href;
const { openSqliteStore } = await import(agent('sqlite.js'));
const { getLoadedSqliteEngine } = await import(agent('sqlite-engine.js'));
const methods = new Set([
  'createSession',
  'createWorkspace',
  'getCommand',
  'getExecution',
  'getMetadata',
  'getModelOutputSnapshot',
  'getView',
  'listExecutions',
  'listMessages',
]);
const store = await openSqliteStore(JSON.parse(options));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closed = false;
async function reply(id, value) {
  const line = `${JSON.stringify([id, value === undefined ? [] : [value]])}\n`;
  assert(Buffer.byteLength(line) <= 16 * 1024 * 1024, 'qualification_store_result_limit');
  if (!process.stdout.write(line)) await once(process.stdout, 'drain');
}
try {
  const engine = getLoadedSqliteEngine();
  assert.equal(engine.version, expectedVersion);
  assert.equal(engine.sourceId, expectedSource);
  await reply(0, null);
  for await (const line of input) {
    const [id, method, args] = JSON.parse(line);
    assert(Number.isSafeInteger(id) && id > 0 && Array.isArray(args));
    if (method === 'close') {
      assert.equal(args.length, 0);
      closed = true;
      await store.close();
      await reply(id, null);
      break;
    }
    assert(methods.has(method), 'qualification_store_method_invalid');
    await reply(id, await store[method](...args));
  }
  assert(closed, 'qualification_store_close_missing');
} catch (error) {
  if (!closed) {
    try {
      await store.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'qualification_store_close_unknown');
    }
  }
  throw error;
} finally {
  input.close();
  process.stdin.destroy();
}
