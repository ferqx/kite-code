import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  candidatePreparationV1,
  createCandidateSupervisorLifecycleV1,
  fullChainFixtureSourceV1,
  LINUX_FULL_CHAIN_ARTIFACT_CLASS_V1,
  LINUX_FULL_CHAIN_SCHEMA_V1,
  type LinuxFullChainHostV1,
  type LinuxFullChainSupervisedResultV1,
  preparedPlanV1,
  requireExplicitLinuxFullChainOutputV1,
  resolveLinuxFullChainWorktreeRootV1,
  runLinuxFullChainCandidateV1,
  writeLinuxFullChainArtifactV1,
} from '../../scripts/evals/linux-full-chain';
import { parseCanonicalJson } from '../../scripts/release/canonical-json';

const canonicalTempDir = realpathSync.native(tmpdir());

describe('Linux full-chain candidate eval', () => {
  test('does not allocate anything without explicit native opt-in', async () => {
    let calls = 0;
    const host = fakeHost({ onCall: () => (calls += 1) });
    const result = await runLinuxFullChainCandidateV1({ host });
    expect(result).toMatchObject({
      schema: LINUX_FULL_CHAIN_SCHEMA_V1,
      artifactClass: LINUX_FULL_CHAIN_ARTIFACT_CLASS_V1,
      status: 'unavailable',
      reason: 'native_opt_in_required',
      nativeOptIn: false,
      productionEvidence: false,
      productionSupported: false,
    });
    expect(calls).toBe(0);
  });

  test('requires an explicit output path and never defaults to cwd/worktree', () => {
    expect(() => requireExplicitLinuxFullChainOutputV1(['bun', 'linux-full-chain.ts'])).toThrow(
      'exactly one --output path',
    );
    expect(() =>
      requireExplicitLinuxFullChainOutputV1(['bun', 'linux-full-chain.ts', '--output']),
    ).toThrow('explicit --output path');
    expect(requireExplicitLinuxFullChainOutputV1(['--output', '/tmp/candidate.json'])).toBe(
      resolve('/tmp/candidate.json'),
    );
  });

  test('returns structured unavailable on non-Linux before probing binaries', async () => {
    let calls = 0;
    const host = fakeHost({
      platform: 'darwin',
      onCall: () => (calls += 1),
    });
    const result = await runLinuxFullChainCandidateV1({ host, nativeOptIn: true });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'non_linux' });
    expect(calls).toBe(0);
  });

  test.each([
    ['bubblewrap_unavailable', { bubblewrap: null }],
    ['fixture_interpreter_unavailable', { python: null }],
  ] as const)('returns structured unavailable for missing %s', async (reason, options) => {
    const result = await runLinuxFullChainCandidateV1({
      host: fakeHost(options),
      nativeOptIn: true,
    });
    expect(result).toMatchObject({ status: 'unavailable', reason });
  });

  test('passes the fake contract only when both compiled entrypoints and supervisor-helper cleanup pass', async () => {
    const host = fakeHost();
    const result = await runLinuxFullChainCandidateV1({ host, nativeOptIn: true });
    expect(result).toMatchObject({
      coverage: 'bubblewrap_supervisor_release_entrypoints_only',
      status: 'passed',
      reason: 'none',
      checks: {
        bubblewrapAvailable: true,
        pidNamespace: true,
        networkNamespace: true,
        workspaceIsolation: true,
        cliCompiledEntrypoint: true,
        tuiCompiledEntrypoint: true,
        cliSupervisorEntrypoint: true,
        tuiSupervisorEntrypoint: true,
        fullDescendantExit: true,
        cleanupConfirmed: true,
      },
    });
  });

  test('maps a supervisor cleanup failure to unsupported and never reports a pass', async () => {
    const host = fakeHost({
      supervisedResult: {
        outcomeOk: false,
        timedOut: true,
        cleanupConfirmed: false,
        descendantObserved: true,
      },
    });
    const result = await runLinuxFullChainCandidateV1({ host, nativeOptIn: true });
    expect(result.status).toBe('unsupported');
    expect(result.reason).toBe('cleanup_unconfirmed');
    expect(result.checks.cleanupConfirmed).toBe(false);
  });

  test('maps runtime removal failure to cleanup_unconfirmed even after a passing probe', async () => {
    const result = await runLinuxFullChainCandidateV1({
      host: fakeHost({ removePathFails: true }),
      nativeOptIn: true,
    });
    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'cleanup_unconfirmed',
      checks: { cleanupConfirmed: false },
    });
  });

  test('keeps detached fixture stdio closed while preserving setsid, double-fork, and identity observability', () => {
    const source = fullChainFixtureSourceV1();
    expect(source).toContain('os.setsid()');
    expect(source).toContain('descendant = os.fork()');
    expect(source).toContain('os.open("/dev/null", os.O_RDWR)');
    expect(source).toContain('os.dup2(devnull, fd)');
    expect(source).toContain('"token": token');
    expect(source).toContain('"pid": os.getpid()');
  });

  test('enforces exact candidate lifecycle ordering and rejects tampered identities', async () => {
    const prepared = preparedPlanV1({
      workspace: '/tmp/kite-full-chain-workspace',
      controlRoot: '/tmp/kite-full-chain-runtime/control',
      dataRoot: '/tmp/kite-full-chain-runtime/data',
      argv: ['/usr/bin/bwrap', '--', '/usr/bin/python3', 'fixture.py'],
    });
    const preparation = candidatePreparationV1(prepared);
    const lifecycle = createCandidateSupervisorLifecycleV1();

    expect(lifecycle.durability).toBe('in_memory_non_durable');
    expect(lifecycle.state).toBe('empty');
    expect(await lifecycle.recordPreparationReady(prepared)).toBe(false);
    await expect(
      lifecycle.recordExecutionDispatchIntent(prepared, {
        dispatchId: 'dispatch-before-ready',
        supervisorNonce: 'nonce-before-ready',
      }),
    ).rejects.toThrow('preparation-ready');

    const intent = await lifecycle.recordPreparationIntent(preparation);
    expect(intent.intentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(lifecycle.state).toBe('intent_recorded');

    const tampered = { ...prepared, commandDigest: 'tampered-command' };
    expect(await lifecycle.recordPreparationReady(tampered)).toBe(false);
    expect(lifecycle.state).toBe('intent_recorded');
    expect(await lifecycle.recordPreparationReady(prepared)).toBe(true);
    expect(lifecycle.state).toBe('ready');
    expect(
      await lifecycle.recordExecutionSupervisorStarted(prepared, {
        dispatchId: 'dispatch-before-dispatch',
        dispatchIntentDigest: `sha256:${'0'.repeat(64)}`,
        supervisorPid: 123,
        processGroupId: 123,
        processStartIdentity: 'start-identity',
      }),
    ).toBe(false);

    await expect(
      lifecycle.recordExecutionDispatchIntent(
        { ...prepared, argv: [...prepared.argv, '--tampered'] },
        { dispatchId: 'dispatch-tampered', supervisorNonce: 'nonce-tampered' },
      ),
    ).rejects.toThrow('prepared identity');
    const dispatch = await lifecycle.recordExecutionDispatchIntent(prepared, {
      dispatchId: 'dispatch-exact',
      supervisorNonce: 'nonce-exact',
    });
    expect(lifecycle.state).toBe('dispatch_recorded');
    expect(
      await lifecycle.recordExecutionSupervisorStarted(
        { ...prepared, argv: [...prepared.argv, '--tampered'] },
        {
          dispatchId: 'dispatch-exact',
          dispatchIntentDigest: dispatch.dispatchIntentDigest,
          supervisorPid: 123,
          processGroupId: 123,
          processStartIdentity: 'start-identity',
        },
      ),
    ).toBe(false);
    expect(
      await lifecycle.recordExecutionSupervisorStarted(prepared, {
        dispatchId: 'dispatch-exact',
        dispatchIntentDigest: dispatch.dispatchIntentDigest,
        supervisorPid: 123,
        processGroupId: 123,
        processStartIdentity: 'start-identity',
      }),
    ).toBe(true);
    expect(lifecycle.state).toBe('supervisor_started');
  });

  test.skipIf(process.platform === 'win32')(
    'writes a canonical owner-only artifact and never overwrites stale output',
    async () => {
      const root = mkdtempSync(join(canonicalTempDir, 'kite-linux-full-chain-artifact-'));
      const output = join(root, 'candidate.json');
      try {
        const result = await runLinuxFullChainCandidateV1({
          host: fakeHost({ platform: 'darwin' }),
        });
        writeLinuxFullChainArtifactV1(output, result);
        expect(parseCanonicalJson(readFileSync(output))).toEqual(result);
        expect(statSync(output).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(result)).not.toContain('platform-capability-evidence');
        expect(JSON.stringify(result)).not.toContain('supportMatrix');
        expect(JSON.stringify(result)).not.toContain('approvedRegistry');

        chmodSync(output, 0o600);
        expect(() => writeLinuxFullChainArtifactV1(output, result)).toThrow();
        expect(existsSync(output)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('rejects worktree-internal and wide-permission artifact parents', async () => {
    const result = await runLinuxFullChainCandidateV1({ host: fakeHost({ platform: 'darwin' }) });
    const worktreeOutput = join(
      resolveLinuxFullChainWorktreeRootV1(),
      'linux-full-chain-test.json',
    );
    expect(() => writeLinuxFullChainArtifactV1(worktreeOutput, result)).toThrow(
      'outside the worktree',
    );

    if (process.platform !== 'win32') {
      const root = mkdtempSync(join(canonicalTempDir, 'kite-linux-full-chain-artifact-wide-'));
      const output = join(root, 'candidate.json');
      try {
        chmodSync(root, 0o755);
        expect(() => writeLinuxFullChainArtifactV1(output, result)).toThrow('POSIX mode 0700');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('rejects report digest tampering and symlink parents before publication', async () => {
    const root = mkdtempSync(join(canonicalTempDir, 'kite-linux-full-chain-artifact-negative-'));
    const targetDirectory = join(root, 'target');
    const symlinkParent = join(root, 'linked-parent');
    mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    symlinkSync(targetDirectory, symlinkParent, 'dir');
    try {
      const result = await runLinuxFullChainCandidateV1({ host: fakeHost({ platform: 'darwin' }) });
      const tampered = { ...result, digest: `sha256:${'0'.repeat(64)}` as const };
      expect(() => writeLinuxFullChainArtifactV1(join(root, 'tampered.json'), tampered)).toThrow(
        'digest',
      );
      expect(() =>
        writeLinuxFullChainArtifactV1(join(symlinkParent, 'candidate.json'), result),
      ).toThrow('canonical directory');
      expect(existsSync(join(targetDirectory, 'candidate.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface FakeHostOptions {
  readonly platform?: NodeJS.Platform;
  readonly bubblewrap?: string | null;
  readonly python?: string | null;
  readonly supervisedResult?: LinuxFullChainSupervisedResultV1;
  readonly removePathFails?: boolean;
  readonly onCall?: () => void;
}

function fakeHost(options: FakeHostOptions = {}): LinuxFullChainHostV1 {
  let root: string | undefined;
  const processTokens = new Map<string, boolean>();
  const defaultSupervisedResult: LinuxFullChainSupervisedResultV1 = {
    outcomeOk: false,
    timedOut: true,
    cleanupConfirmed: true,
    descendantObserved: true,
  };
  return {
    platform: options.platform ?? 'linux',
    findExecutable: (name) => {
      options.onCall?.();
      if (name === 'bwrap')
        return options.bubblewrap === null ? undefined : (options.bubblewrap ?? '/usr/bin/bwrap');
      if (name === 'python3')
        return options.python === null ? undefined : (options.python ?? '/usr/bin/python3');
      return undefined;
    },
    pathExists: (path) => existsSync(path),
    readText: (path) => readFileSync(path, 'utf8'),
    readLink: () => 'namespace:host',
    createTempDirectory: () => {
      root ??= mkdtempSync(join(canonicalTempDir, 'kite-linux-full-chain-fake-'));
      return root;
    },
    writeText: (path, contents, mode = 0o600) => writeFileSync(path, contents, { mode }),
    removePath: (path) => {
      if (options.removePathFails) throw new Error('fake removal failure');
      rmSync(path, { recursive: true, force: true });
    },
    compileReleaseEntrypoint: async (_entrypoint, outfile) => {
      writeFileSync(outfile, 'compiled-entrypoint', { mode: 0o700 });
    },
    run: async (argv) => ({
      exitCode: 0,
      stdout: argv[0]?.endsWith('kite-tui') ? 'Kite Code TUI 0.8.0\n' : 'Kite Code 0.8.0\n',
      stderr: '',
      timedOut: false,
    }),
    runSupervised: async ({ fixtureFactsPath, descendantToken }) => {
      writeFileSync(
        fixtureFactsPath,
        JSON.stringify({
          ready: true,
          pidNamespace: true,
          networkNamespace: true,
          workspaceIsolation: true,
        }),
      );
      processTokens.set(descendantToken, true);
      return options.supervisedResult ?? defaultSupervisedResult;
    },
    findOwnedProcesses: (token) => (processTokens.get(token) ? [4242] : []),
    readProcessStartIdentity: () => 'fake-start-identity',
    killOwnedProcess: () => {
      for (const token of processTokens.keys()) processTokens.set(token, false);
      return true;
    },
    sleep: async () => undefined,
  };
}
