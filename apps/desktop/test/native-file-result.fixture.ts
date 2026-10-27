import { strict as assert } from 'node:assert';
import type { Json } from '@kite-ai/agent/extensions';

/** Consume the current public read_file model result, including its exact full-file baseline. */
export function nativeFileReadBaseline(content: string, expectedPath: string): Json {
  const [header, baseline] = content.split('\n');
  assert.ok(header?.startsWith(`Read ${JSON.stringify(expectedPath)}; `));
  assert.ok(header!.endsWith('complete file.'));
  assert.ok(baseline?.startsWith('baseline='));
  const value: Json = JSON.parse(baseline!.slice('baseline='.length));
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(typeof value.hash, 'string');
  assert.match(String(value.hash), /^[a-f0-9]{64}$/);
  assert.equal(typeof value.device, 'string');
  assert.equal(typeof value.inode, 'string');
  assert.equal(typeof value.size, 'number');
  return value;
}
