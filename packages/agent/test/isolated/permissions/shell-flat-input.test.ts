import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthorizationRequest } from '../../../src/extensions';
import { createPermissionPolicy, type PermissionPolicySnapshot } from '../../../src/permissions';
import {
  createShellConfiguration,
  inspectShellAssets,
  type ShellConfigurationOptions,
} from '../../../src/permissions/shell';
import type { Json } from '../../../src/storage/types';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell-flat-policy-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  mkdirSync(join(root, 'control'));
  mkdirSync(join(root, 'protected'));
  const supervisor = join(root, 'supervisor.js');
  writeFileSync(supervisor, '// metadata only; never launched');
  const options: ShellConfigurationOptions = {
    platform: 'darwin',
    configurationId: 'flat-input-policy',
    env: { PATH: '/usr/bin:/bin', FIXED: 'original' },
    supervisorPath: supervisor,
    bunExecutable: process.execPath,
    shellExecutable: '/bin/sh',
    host: {
      controlBase: join(root, 'control'),
      protectedRoots: [join(root, 'protected')],
      readonlyAssets: [],
      runtimeReadOnlyRoots: [],
    },
  };
  try {
    const configuration = await createShellConfiguration({
      workspaceRoot: workspace,
      toolIds: ['shell.execute', 'shell.launch'],
      options,
    });
    if (!('assets' in configuration.snapshot)) throw new Error('expected_shell_configuration');
    const parserAssets = configuration.snapshot.assets.parser;
    const request = (
      input: Record<string, unknown>,
      definitionId = 'shell.execute',
    ): AuthorizationRequest => ({
      kind: 'tool',
      sessionId: 's',
      runId: 'r',
      executionId: 'tool',
      definitionId,
      definitionVersion: '1',
      input: input as Json,
      signal: new AbortController().signal,
    });
    return {
      configuration,
      options,
      workspace,
      parserAssets,
      request,
      close: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test.skipIf(process.platform !== 'darwin')(
  'flat Shell requests default each dimension independently and preserve policy modes',
  async () => {
    const f = await fixture();
    try {
      for (const [fields, scope] of [
        [{}, { filesystem: 'workspace_write', network: 'none' }],
        [{ filesystem: 'full_access' }, { filesystem: 'full_access', network: 'none' }],
        [{ network: 'internet' }, { filesystem: 'workspace_write', network: 'internet' }],
        [
          { filesystem: 'full_access', network: 'internet' },
          { filesystem: 'full_access', network: 'internet' },
        ],
      ] as const) {
        const request = f.request({ key: 'one', command: 'printf original', ...fields });
        const described = await f.configuration.describeRequest(request);
        expect(described?.executionScope).toEqual(scope);
        for (const mode of ['accept_edits', 'auto', 'full'] as const) {
          const snapshot: PermissionPolicySnapshot = {
            mode,
            workspaceTrust: true,
            revision: 'policy-1',
            allowed: [{ kind: 'tool', definitionId: 'shell.execute', definitionVersion: '1' }],
          };
          const permissions = createPermissionPolicy({
            readPolicy: () => snapshot,
            describeCapability: () => ({
              ...f.configuration.describe('shell.execute'),
              ...described,
              kind: 'tool',
              definitionId: 'shell.execute',
              definitionVersion: '1',
              revision: 'shell-1',
              hardAllowed: described?.hardAllowed === true,
              commandDigest: f.configuration.commandDigest(request),
            }),
          });
          const decision = await permissions.authorize(request);
          const capability = (
            decision.snapshot!.data as { capability: { executionScope: unknown } }
          ).capability;
          expect(capability.executionScope).toEqual(
            mode === 'full' ? { filesystem: 'full_access', network: 'internet' } : scope,
          );
          if (mode === 'auto') expect(decision.check).toBeDefined();
          else if (mode === 'full') expect(decision.allowed).toBe(true);
          else if (scope.filesystem === 'workspace_write' && scope.network === 'none')
            expect(decision.allowed).toBe(true);
          else {
            expect(decision.allowed).toBe(false);
            expect(decision.approval).toBeDefined();
          }
        }
      }
    } finally {
      f.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'Shell legacy digest bytes stay stable; description is excluded and scope or execution semantics change authority',
  async () => {
    const f = await fixture();
    try {
      const assets = await inspectShellAssets(f.options);
      for (const definitionId of ['shell.execute', 'shell.launch']) {
        const original = f.request({ key: 'one', command: 'printf original' }, definitionId);
        const expectedLegacyDigest = createHash('sha256')
          .update(
            JSON.stringify({
              namespace: 'builtin.shell.command-permission',
              version: 1,
              kind: original.kind,
              definitionId,
              definitionVersion: '1',
              configurationId: f.options.configurationId,
              command: 'printf original',
              cancellation: 'attached',
              timeoutMs: null,
              executionScope: { filesystem: 'workspace_write', network: 'none' },
              cwd: f.workspace,
              env: Object.entries(f.options.env).sort(([a], [b]) => a.localeCompare(b)),
              assets,
              parserAssets: f.parserAssets,
              host: f.options.host,
              graceMs: 200,
              maxQueuedBytes: 256 * 1024,
            }),
          )
          .digest('hex');
        expect(f.configuration.commandDigest(original)).toBe(expectedLegacyDigest);
      }
      const baseline = f.request({ key: 'one', command: 'printf original' });
      const digest = f.configuration.commandDigest(baseline);
      const originalDescription = await f.configuration.describeRequest(baseline);
      const originalReview = await f.configuration.prepareRiskReview(baseline);
      for (const input of [
        { key: 'other', command: 'printf original', description: 'Check current files' },
        {
          key: 'other',
          command: 'printf original',
          description: 'Another purpose, not authorization',
          background: false,
          filesystem: 'workspace_write',
          network: 'none',
        },
        {
          key: 'other',
          command: 'printf original',
          permissions: { filesystem: 'workspace_write', network: 'none' },
        },
      ]) {
        const changed = f.request(input);
        expect(f.configuration.commandDigest(changed)).toBe(digest);
        expect((await f.configuration.describeRequest(changed))?.autoReviewKey).toBe(
          originalDescription?.autoReviewKey,
        );
        const review = await f.configuration.prepareRiskReview(changed);
        expect(review?.fingerprint).toBe(originalReview?.fingerprint);
        expect(review?.material).toEqual(originalReview?.material);
      }
      for (const fields of [
        { background: true },
        { timeoutMs: 1000 },
        { execution_timeout_ms: 1000 },
        { cancellation: 'detached' },
        { filesystem: 'full_access' },
        { network: 'internet' },
      ])
        expect(
          f.configuration.commandDigest(
            f.request({ key: 'one', command: 'printf original', ...fields }),
          ),
        ).not.toBe(digest);
      expect(
        f.configuration.commandDigest(
          f.request({ command: 'printf original', execution_timeout_ms: 1000 }),
        ),
      ).toBe(
        f.configuration.commandDigest(
          f.request({ key: 'legacy', command: 'printf original', timeoutMs: 1000 }),
        ),
      );
      for (const fields of [{ filesystem: 'full_access' }, { network: 'internet' }]) {
        const changed = f.request({ key: 'one', command: 'printf original', ...fields });
        expect((await f.configuration.describeRequest(changed))?.autoReviewKey).not.toBe(
          originalDescription?.autoReviewKey,
        );
        expect((await f.configuration.prepareRiskReview(changed))?.fingerprint).not.toBe(
          originalReview?.fingerprint,
        );
      }
    } finally {
      f.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'invalid or ambiguous flat requests cannot get a digest, risk material or permission scope',
  async () => {
    const f = await fixture();
    try {
      for (const fields of [
        { filesystem: 'outside' },
        { filesystem: ['full_access'] },
        { filesystem: null },
        { network: true },
        { network: ['internet'] },
        { network: null },
        { background: 'true' },
        { description: { authorized: true } },
        { background: true, timeoutMs: 1000 },
        { background: true, execution_timeout_ms: 1000 },
        { execution_timeout_ms: null },
        { execution_timeout_ms: 1000, timeoutMs: 1000 },
        { timeoutMs: 0 },
        { timeoutMs: 3_600_001 },
        {
          filesystem: 'full_access',
          permissions: { filesystem: 'workspace_write', network: 'none' },
        },
      ]) {
        const request = f.request({ key: 'one', command: 'printf original', ...fields });
        expect(f.configuration.commandDigest(request)).toBeUndefined();
        expect(await f.configuration.prepareRiskReview(request)).toBeNull();
        expect(await f.configuration.describeRequest(request)).toEqual({
          hardAllowed: false,
          denialReason: 'invalid_shell_arguments',
        });
      }
    } finally {
      f.close();
    }
  },
);
