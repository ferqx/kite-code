import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '#kite-test';
import type { AuthorizationRequest, ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles, withPlanFileTools } from '../../../src/files';

for (const fault of ['missing', 'cancelled'] as const)
  test(`a completed delegated Plan write followed by ${fault} native readback is unknown rather than a retryable write failure`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-plan-readback-')));
    const profile = join(root, 'profile');
    const path = join(profile, 'files', 's', 'plan.md');
    const moved = join(dirname(path), 'published-plan.md');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, 'Original plan', { mode: 0o600 });
    const native = createWorkspaceFiles({ root: dirname(path), strictReads: true });
    let writes = 0;
    const controller = new AbortController();
    try {
      const original = await native.read('plan.md');
      const input = { path, content: 'Published plan', base: { ...original.baseline } };
      const request: AuthorizationRequest = {
        kind: 'tool',
        sessionId: 's',
        executionId: 'write-plan',
        runId: 'r',
        definitionId: 'files.write',
        definitionVersion: '3',
        input,
        signal: controller.signal,
      };
      const adapter = withPlanFileTools({
        profilePath: profile,
        tools: createFileTools(native, { snapshot: false }),
        async current() {
          return {
            path,
            planId: 'plan',
            version: 1,
            digest: 'original-plan-digest',
            title: 'Plan',
            steps: [],
            file: { path, hash: original.baseline.hash, size: original.baseline.size },
          };
        },
        async write() {
          writes++;
          await native.write({
            path: 'plan.md',
            content: 'Published plan',
            base: original.baseline,
          });
          // The write completed. Interference or cancellation now prevents its follow-up read.
          if (fault === 'missing') renameSync(path, moved);
          else controller.abort();
        },
      });
      const capability = await adapter.describeRequest(request);
      const context = {
        sessionId: 's',
        executionId: request.executionId,
        runId: 'r',
        signal: request.signal,
        dispatchAuthorization: {
          revision: capability!.revision,
          snapshot: { namespace: 'builtin.permissions', version: '1', data: { capability } },
        },
      } as unknown as ToolContext;
      const result = await adapter.tools
        .find((tool) => tool.id === 'files.write')!
        .execute(input, context);
      expect(writes).toBe(1);
      expect(readFileSync(fault === 'missing' ? moved : path, 'utf8')).toBe('Published plan');
      expect(result.outcome).toBe('outcome_unknown');
      expect(result.content).toContain('Do not repeat the write');
      expect(result.content).not.toContain('before another attempt');
      expect(result.details).toMatchObject({ code: 'file_publish_outcome_unknown' });
    } finally {
      await native.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
