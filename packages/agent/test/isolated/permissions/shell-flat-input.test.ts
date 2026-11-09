import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
import { createShellToolBehaviors } from '../../../src/tools/shell-approval';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-shell-flat-policy-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  mkdirSync(join(root, 'control'));
  mkdirSync(join(root, 'protected'));
  const supervisor = join(root, 'supervisor.js');
  writeFileSync(supervisor, '// metadata only; never launched');
  const options: ShellConfigurationOptions = {
    platform: process.platform === 'linux' ? 'linux' : 'darwin',
    ...(process.platform === 'linux' ? { linux: { bubblewrapPath: '/usr/bin/bwrap' } } : {}),
    configurationId: 'flat-input-policy',
    env: { PATH: '/usr/bin:/bin', FIXED: 'original' },
    supervisorPath: process.platform === 'linux' ? '/bin/true' : supervisor,
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
  'literal search && chains bypass Auto review only in the original workspace offline scope',
  async () => {
    const f = await fixture();
    let reviewContexts = 0;
    try {
      for (const [command, scope, safe] of [
        ['pwd && ls && rg needle .', {}, true],
        ['pwd && ls', { filesystem: 'full_access' }, false],
        ['pwd && ls', { network: 'internet' }, false],
        ['pwd || ls', {}, false],
        ['pwd; ls', {}, false],
        ['pwd && printf changed', {}, false],
        ['pwd && rg --pre=helper needle .', {}, false],
      ] as const) {
        const request = f.request({ key: 'one', command, ...scope });
        const described = await f.configuration.describeRequest(request);
        expect(described?.safeRead === true, command).toBe(safe);
        const policy = createPermissionPolicy({
          readPolicy: () => ({
            mode: 'auto',
            workspaceTrust: true,
            revision: 'auto-chain',
            allowed: [{ kind: 'tool', definitionId: 'shell.execute', definitionVersion: '1' }],
          }),
          describeCapability: async () => ({
            ...f.configuration.describe('shell.execute'),
            ...described,
            kind: 'tool',
            definitionId: 'shell.execute',
            definitionVersion: '1',
            revision: 'shell-chain',
            hardAllowed: described?.hardAllowed === true,
          }),
          readCheckContext: () => {
            reviewContexts++;
            return { task: 'search', plan: null, rejectionReasons: [] };
          },
        });
        const before = reviewContexts;
        const decision = await policy.authorize(request);
        if (safe) {
          expect(decision.allowed).toBe(true);
          expect(decision.check).toBeUndefined();
          expect(reviewContexts).toBe(before);
        } else expect(decision.check).toBeDefined();
      }
    } finally {
      f.close();
    }
  },
);

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
            describeCapability: async () => ({
              ...f.configuration.describe('shell.execute'),
              ...described,
              kind: 'tool',
              definitionId: 'shell.execute',
              definitionVersion: '1',
              revision: 'shell-1',
              hardAllowed: described?.hardAllowed === true,
              commandDigest: await f.configuration.commandDigest(request),
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

test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'Shell command digest binds workdir, scope and execution semantics while excluding display and operation keys',
  async () => {
    const f = await fixture();
    try {
      const assets = await inspectShellAssets(f.options);
      for (const definitionId of ['shell.execute', 'shell.launch']) {
        const original = f.request({ key: 'one', command: 'printf original' }, definitionId);
        const expectedDigest = createHash('sha256')
          .update(
            JSON.stringify({
              namespace: 'builtin.shell.command-permission',
              version: 1,
              kind: original.kind,
              definitionId,
              definitionVersion: '1',
              configurationId: f.options.configurationId,
              command: 'printf original',
              workdir: null,
              cancellation: 'attached',
              timeoutMs: null,
              executionScope: { filesystem: 'workspace_write', network: 'none' },
              cwd: {
                path: f.workspace,
                dev: String(lstatSync(f.workspace).dev),
                ino: String(lstatSync(f.workspace).ino),
              },
              env: Object.entries(f.options.env).sort(([a], [b]) => a.localeCompare(b)),
              assets,
              parserAssets: f.parserAssets,
              host: f.options.host,
              graceMs: 200,
              maxQueuedBytes: 256 * 1024,
            }),
          )
          .digest('hex');
        expect(await f.configuration.commandDigest(original)).toBe(expectedDigest);
      }
      const baseline = f.request({ key: 'one', command: 'printf original' });
      const digest = await f.configuration.commandDigest(baseline);
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
        expect(await f.configuration.commandDigest(changed)).toBe(digest);
        expect((await f.configuration.describeRequest(changed))?.autoReviewKey).toBe(
          originalDescription?.autoReviewKey,
        );
        const review = await f.configuration.prepareRiskReview(changed);
        expect(review?.fingerprint).toBe(originalReview?.fingerprint);
        expect(review?.material).toEqual(originalReview?.material);
      }
      mkdirSync(join(f.workspace, 'another-directory'));
      for (const fields of [
        { background: true },
        { timeoutMs: 1000 },
        { execution_timeout_ms: 1000 },
        { cancellation: 'detached' },
        { filesystem: 'full_access' },
        { network: 'internet' },
        { workdir: 'another-directory' },
      ])
        expect(
          await f.configuration.commandDigest(
            f.request({ key: 'one', command: 'printf original', ...fields }),
          ),
        ).not.toBe(digest);
      expect(
        await f.configuration.commandDigest(
          f.request({ command: 'printf original', execution_timeout_ms: 1000 }),
        ),
      ).toBe(
        await f.configuration.commandDigest(
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
        expect(await f.configuration.commandDigest(request)).toBeUndefined();
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

// Metadata-only fixture: no native Job or command is launched.
test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'Shell session grant scope changes when the same workdir resolves to a new directory',
  async () => {
    const f = await fixture();
    try {
      const first = join(f.workspace, 'first');
      const second = join(f.workspace, 'second');
      const link = join(f.workspace, 'current');
      mkdirSync(first);
      mkdirSync(second);
      symlinkSync(first, link);
      const behavior = createShellToolBehaviors(f.configuration).find(
        (entry) => entry.capability.definitionId === 'shell.execute',
      )!;
      const request = f.request({ command: 'printf effect > effect', workdir: 'current' });
      const offers = () => behavior.grantOffers!(request);
      const originalReviewKey = (await f.configuration.describeRequest(request))!.autoReviewKey;
      expect(
        (await f.configuration.describeRequest({
          ...request,
          kind: 'job',
          definitionId: 'shell.command',
        }))!.autoReviewKey,
      ).toBe(originalReviewKey);
      const original = await offers();
      expect(original).toHaveLength(1);
      expect((await offers())[0]!.scopeDigest).toBe(original[0]!.scopeDigest);
      unlinkSync(link);
      symlinkSync(second, link);
      const redirected = await offers();
      expect((await f.configuration.describeRequest(request))!.autoReviewKey).not.toBe(
        originalReviewKey,
      );
      expect(redirected[0]!.scopeDigest).not.toBe(original[0]!.scopeDigest);
      renameSync(second, `${second}-old`);
      mkdirSync(second);
      expect((await offers())[0]!.scopeDigest).not.toBe(redirected[0]!.scopeDigest);
      unlinkSync(link);
      expect(await offers()).toEqual([]);
    } finally {
      f.close();
    }
  },
);

// Pause between final policy acceptance and the configured Job's real start method.
// No process starts: the changed directory must be rejected before native launch.
test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'Shell Job rejects workdir changes after the accepted dispatch snapshot',
  async () => {
    const f = await fixture();
    try {
      const first = join(f.workspace, 'approved');
      const second = join(f.workspace, 'unapproved');
      const link = join(f.workspace, 'current');
      mkdirSync(first);
      mkdirSync(second);
      symlinkSync(first, link);
      const job = f.configuration.extensions
        .flatMap((extension) => extension.jobs ?? [])
        .find((definition) => definition.id === 'shell.command')!;
      const input = { command: 'printf forbidden > effect', workdir: 'current' };
      const request: AuthorizationRequest = {
        ...f.request(input),
        kind: 'job',
        definitionId: 'shell.command',
      };
      const policy = createPermissionPolicy({
        readPolicy: () => ({
          mode: 'full',
          workspaceTrust: true,
          revision: 'fixture',
          allowed: [{ kind: 'job', definitionId: 'shell.command', definitionVersion: '1' }],
        }),
        describeCapability: async () => ({
          ...f.configuration.describe('shell.command'),
          ...(await f.configuration.describeRequest(request)),
          kind: 'job',
          definitionId: 'shell.command',
          definitionVersion: '1',
          revision: 'fixture',
          effects: ['process'],
          hardAllowed: true,
          commandDigest: await f.configuration.commandDigest(request),
        }),
      });
      const accepted = await policy.authorize(request);
      expect(accepted.allowed).toBe(true);
      const context = {
        sessionId: request.sessionId,
        executionId: request.executionId,
        signal: request.signal,
        dispatchAuthorization: accepted,
      };
      unlinkSync(link);
      symlinkSync(second, link);
      await expect(job.start(input, context)).rejects.toThrow('shell_workdir_changed');
      unlinkSync(link);
      symlinkSync(first, link);
      renameSync(first, `${first}-old`);
      mkdirSync(first);
      await expect(job.start(input, context)).rejects.toThrow('shell_workdir_changed');
    } finally {
      f.close();
    }
  },
);
