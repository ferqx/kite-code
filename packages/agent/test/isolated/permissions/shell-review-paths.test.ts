import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthorizationRequest } from '../../../src/extensions';
import { createShellConfiguration } from '../../../src/permissions/shell';

test.skipIf(process.platform !== 'darwin')(
  'ordinary Shell review reads Workspace scripts without added protected-path rejection',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell-review-paths-')));
    try {
      const workspace = join(root, 'workspace');
      const formerlyProtected = join(workspace, 'private');
      mkdirSync(formerlyProtected, { recursive: true });
      const control = join(root, 'control');
      mkdirSync(control);
      const supervisor = join(workspace, 'supervisor.js');
      writeFileSync(supervisor, '// fixed asset, never launched');
      const script = '#!/bin/sh\nprintf must-not-run\n';
      writeFileSync(join(formerlyProtected, 'script.sh'), script);
      writeFileSync(join(root, 'external.sh'), 'outside workspace');
      const configuration = await createShellConfiguration({
        workspaceRoot: workspace,
        toolIds: ['shell.launch'],
        options: {
          platform: 'darwin',
          configurationId: 'review-paths',
          env: { PATH: '/usr/bin:/bin' },
          supervisorPath: supervisor,
          bunExecutable: process.execPath,
          shellExecutable: '/bin/sh',
          host: {
            controlBase: control,
            protectedRoots: [formerlyProtected],
            readonlyAssets: [],
            runtimeReadOnlyRoots: [],
          },
        },
      });
      const request = (command: string): AuthorizationRequest => ({
        kind: 'tool',
        sessionId: 's',
        runId: 'r',
        executionId: 'tool',
        definitionId: 'shell.launch',
        definitionVersion: '1',
        input: { key: 'review', command, filesystem: 'full_access' },
        signal: new AbortController().signal,
      });
      const result = await configuration.prepareRiskReview(request('./private/script.sh'));
      expect(result?.material).toMatchObject({
        directScripts: [{ path: './private/script.sh', text: script, complete: true }],
      });
      const asset = await configuration.prepareRiskReview(request('./supervisor.js'));
      expect(asset?.material).toMatchObject({
        directScripts: [{ text: '// fixed asset, never launched', complete: true }],
      });
      const external = await configuration.prepareRiskReview(request(join(root, 'external.sh')));
      expect(external?.material).toMatchObject({
        directScripts: [{ availability: 'unavailable', complete: false }],
      });
    } finally {
      // Ordinary script fixtures only; no process or Git worktree is created.
      rmSync(root, { recursive: true, force: true });
    }
  },
);
