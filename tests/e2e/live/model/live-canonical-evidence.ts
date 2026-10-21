import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { createRuntime } from '@kite-ai/agent';
import type { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelRequest } from '@kite-ai/ai';

/** Private original inspector evidence; no Provider calls or synthesized model outputs. */
export async function saveLiveCanonicalModelEvidence(options: {
  runtime: ReturnType<typeof createRuntime>;
  store: Awaited<ReturnType<typeof openSqliteStore>>;
  requests: readonly ModelRequest[];
  root: string;
  subjectId: string;
}) {
  const expectedStoreId = (await options.store.getMetadata()).storeId;
  const records = [];
  let complete = true;
  for (const executionId of new Set(options.requests.map((request) => request.requestId))) {
    const execution = await options.store.getExecution(executionId);
    if (execution?.kind !== 'model') {
      records.push({ executionId, executionUnavailable: true });
      complete = false;
      continue;
    }
    const scope = {
      expectedStoreId,
      sessionId: execution.sessionId,
      subjectId: options.subjectId,
      executionId,
    };
    try {
      const input = await options.runtime.readModelInput(scope);
      const output =
        execution.status === 'succeeded' ? await options.runtime.readModelOutput(scope) : undefined;
      records.push({ scope, execution, input, ...(output ? { output } : {}) });
      if (output && !output.output.complete) complete = false;
    } catch {
      // The original Store remains retained if an active/failed request has no inspector body.
      records.push({ scope, execution, inspectorUnavailable: true });
      complete = false;
    }
  }
  const body = `${JSON.stringify(records, null, 2)}\n`;
  writeFileSync(join(options.root, 'canonical-model-evidence.json'), body, { mode: 0o600 });
  return {
    file: 'canonical-model-evidence.json',
    sha256: createHash('sha256').update(body).digest('hex'),
    models: records.length,
    complete,
  };
}
