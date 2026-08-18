import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1,
  MODEL_REPLAY_GATE_RISK_COVERAGE_V1,
  MODEL_REPLAY_REQUIRED_CASE_IDS_V1,
  parseModelReplayGateManifestV1,
  verifyModelReplayGateQualificationFilesV1,
} from '../../../scripts/evals/contracts/model-replay-gate';
import { computeModelReplayImportClosureV1 } from '../../../scripts/evals/contracts/qualification-import-closure';
import { runRequiredModelReplayGateV1 } from '../../../scripts/evals/model-replay-gate';
import { buildRequiredReplayIsolationCommandV1 } from '../../../scripts/evals/run-model-replay-required';

const MANIFEST_URL = new URL(
  '../../../scripts/evals/manifests/model-replay-gate-v1.json',
  import.meta.url,
);

describe('RP-03 approved keyless replay gate', () => {
  test('keeps the metadata-only gate in Required CI without any record command', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync(
      new URL('../../../.github/workflows/required.yml', import.meta.url),
      'utf8',
    );
    expect(packageJson.scripts['eval:replay:required']).toBe(
      '/usr/bin/env -u BUN_OPTIONS -u NODE_OPTIONS bun --no-env-file run scripts/evals/run-model-replay-required.ts',
    );
    const requiredJob = (
      parseYaml(workflow) as {
        jobs?: Record<string, unknown>;
      }
    ).jobs?.['model-replay-required'];
    expect(requiredJob).toEqual({
      name: 'model-replay-required',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 10,
      steps: [
        { uses: 'actions/checkout@v4' },
        { uses: 'oven-sh/setup-bun@v2', with: { 'bun-version': '1.3.14' } },
        { run: 'bun install --frozen-lockfile' },
        {
          name: 'Install Linux replay isolation boundary',
          run: 'sudo apt-get update && sudo apt-get install --yes bubblewrap',
        },
        {
          run: '/usr/bin/env -u BUN_OPTIONS -u NODE_OPTIONS bun --no-env-file run eval:replay:required',
        },
      ],
    });
    expect(JSON.stringify(requiredJob)).not.toMatch(
      /(?:secrets\.|api[_-]?key|token|credential|:live|replay:record|provider:smoke)/iu,
    );
  });

  test('installs a selected in-process outbound deny guard as defense in depth', async () => {
    if (
      (globalThis as unknown as Record<string, unknown>).__KITE_MODEL_REPLAY_NETWORK_DENY_V1__ ===
      true
    ) {
      await expectNetworkPrimitivesDenied();
      return;
    }
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--no-env-file',
        '--preload=./scripts/evals/replay-network-deny.ts',
        '-e',
        "const n=await import('node:net');const calls=[()=>fetch('x'),()=>n.connect(9,'127.0.0.1'),()=>new n.Socket().connect(9,'127.0.0.1'),()=>Bun.connect({hostname:'127.0.0.1',port:9,socket:{data(){}}})];for(const call of calls){let denied=false;try{call()}catch(error){denied=error instanceof Error&&error.message==='MODEL_REPLAY_REQUIRED_NETWORK_DENIED'}if(!denied)process.exit(91)}",
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
  });

  test('builds exact macOS and Linux isolation commands with irreversible Linux privilege drop', () => {
    const common = {
      environment: { PATH: '/usr/bin:/bin', HOME: '/tmp/private' },
      runtimePath: '/runtime/bun',
      isolatedRunnerPath: '/repo/scripts/evals/run-model-replay-required-isolated.ts',
      uid: 1001,
      gid: 1002,
    } as const;
    expect(buildRequiredReplayIsolationCommandV1({ ...common, platform: 'darwin' })).toEqual([
      '/usr/bin/sandbox-exec',
      '-p',
      '(version 1)(allow default)(deny network*)',
      '/usr/bin/env',
      '-i',
      'PATH=/usr/bin:/bin',
      'HOME=/tmp/private',
      '/runtime/bun',
      '--no-env-file',
      '/repo/scripts/evals/run-model-replay-required-isolated.ts',
    ]);
    expect(buildRequiredReplayIsolationCommandV1({ ...common, platform: 'linux' })).toEqual([
      '/usr/bin/bwrap',
      '--ro-bind',
      '/',
      '/',
      '--bind',
      '/tmp/private',
      '/tmp/private',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--unshare-pid',
      '--unshare-net',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--',
      '/usr/bin/env',
      '-i',
      'PATH=/usr/bin:/bin',
      'HOME=/tmp/private',
      '/runtime/bun',
      '--no-env-file',
      '/repo/scripts/evals/run-model-replay-required-isolated.ts',
    ]);
    expect(() =>
      buildRequiredReplayIsolationCommandV1({
        ...common,
        platform: 'linux',
        environment: { PATH: '/usr/bin:/bin' },
      }),
    ).toThrow('private HOME');
  });

  test('strictly binds the approved authority, case set, risk matrix and G0 evidence', () => {
    const manifest = parseModelReplayGateManifestV1(readFileSync(MANIFEST_URL));
    expect(manifest).toMatchObject({
      status: 'approved',
      authority: { approver: 'github:@ferqx', decision: 'ADR-0112' },
      suite: {
        suiteId: 'model-replay-required-suite-v1',
        suiteRevision: 1,
        caseIds: MODEL_REPLAY_REQUIRED_CASE_IDS_V1,
      },
      riskCoverage: MODEL_REPLAY_GATE_RISK_COVERAGE_V1,
      gate: {
        command:
          '/usr/bin/env -u BUN_OPTIONS -u NODE_OPTIONS bun --no-env-file run eval:replay:required',
        ciRecord: false,
        liveFallback: false,
        contentLogged: false,
      },
    });
    expect(() =>
      verifyModelReplayGateQualificationFilesV1({
        manifest,
        repositoryRoot: process.cwd(),
      }),
    ).not.toThrow();
    expect(Object.isFrozen(manifest.bindings.routes)).toBe(true);
    expect(Object.isFrozen(manifest.qualificationFiles[0])).toBe(true);
    const closure = computeModelReplayImportClosureV1({ repositoryRoot: process.cwd() });
    expect(manifest.qualificationImportClosure).toEqual({
      algorithm: closure.algorithm,
      entrypoints: [...closure.entrypoints],
      fileCount: closure.paths.length,
      digest: closure.digest,
    });
    expect(closure.paths).toContain('src/core/runtime/state.ts');
    expect(closure.paths).toContain('src/core/controllers/tool-controller.ts');
    expect(closure.paths).toContain('src/core/subagent/child-runtime-driver.ts');
  });

  test('executes the PS-03 strict propagation qualification in Required isolation', () => {
    const isolatedRunner = readFileSync(
      new URL('../../../scripts/evals/run-model-replay-required-isolated.ts', import.meta.url),
      'utf8',
    );
    expect(isolatedRunner).toContain('tests/evals/agent-tasks/replay-subagent-journey.test.ts');
    expect(isolatedRunner).not.toContain('replay-record.test.ts');
    const qualificationPaths = parseModelReplayGateManifestV1(
      readFileSync(MANIFEST_URL),
    ).qualificationFiles.map((entry) => entry.path);
    expect(qualificationPaths).toContain('scripts/evals/model-replay-subagent-journey.ts');
    expect(qualificationPaths).toContain('tests/evals/agent-tasks/replay-subagent-journey.test.ts');
  });

  test('runs the approved suite twice keylessly and returns metadata-only evidence', async () => {
    const report = await runRequiredModelReplayGateV1({
      repositoryRoot: process.cwd(),
    });
    expect(report).toEqual({
      schema: 'ModelReplayGateEvidenceV1',
      status: 'passed',
      suiteId: 'model-replay-required-suite-v1',
      suiteRevision: 1,
      manifestDigest: MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1,
      caseCount: 6,
      keyless: true,
      providerTransportAttempts: 0,
      contentLogged: false,
    });
    expect(JSON.stringify(report)).not.toContain('Synthetic');
    expect(JSON.stringify(report)).not.toContain('toolCall');
    expect(JSON.stringify(report)).not.toContain('networkIsolated');
  });

  test('fails closed for authority, unknown-field, coverage and qualification drift', () => {
    const base = JSON.parse(readFileSync(MANIFEST_URL, 'utf8')) as Record<string, unknown>;
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.status = 'candidate';
      },
      (value: Record<string, unknown>) => {
        value.fallback = 'live';
      },
      (value: Record<string, unknown>) => {
        const suite = value.suite as { caseIds: string[] };
        suite.caseIds = suite.caseIds.slice(0, -1);
      },
      (value: Record<string, unknown>) => {
        const risk = value.riskCoverage as { attempts: string[] };
        risk.attempts = risk.attempts.filter((entry) => entry !== 'aborted');
      },
    ]) {
      const changed = structuredClone(base);
      mutate(changed);
      expect(() => parseModelReplayGateManifestV1(JSON.stringify(changed))).toThrow(
        'MODEL_REPLAY_GATE_MANIFEST_INVALID',
      );
    }

    const manifest = structuredClone(parseModelReplayGateManifestV1(readFileSync(MANIFEST_URL)));
    manifest.qualificationFiles[0]!.sha256 = `sha256:${'9'.repeat(64)}`;
    expect(() =>
      verifyModelReplayGateQualificationFilesV1({
        manifest,
        repositoryRoot: process.cwd(),
      }),
    ).toThrow('MODEL_REPLAY_GATE_QUALIFICATION_INVALID');
  });

  test('keeps OS isolation authority out of the directly callable Core gate evidence', () => {
    const source = readFileSync(
      new URL('../../../scripts/evals/model-replay-gate.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('networkIsolationAcknowledged');
    expect(source).not.toContain('KITE_MODEL_REPLAY_OS_NETWORK_DENY_V1');
    expect(source).not.toContain('networkIsolated: true');
    for (const runner of [
      '../../../scripts/evals/run-model-replay-required.ts',
      '../../../scripts/evals/run-model-replay-required-isolated.ts',
    ]) {
      const runnerSource = readFileSync(new URL(runner, import.meta.url), 'utf8');
      expect(runnerSource).not.toContain("stdout: 'inherit'");
      expect(runnerSource).not.toContain("stderr: 'inherit'");
    }
  });
});

async function expectNetworkPrimitivesDenied(): Promise<void> {
  const net = await import('node:net');
  const calls = [
    () => fetch('x'),
    () => net.connect(9, '127.0.0.1'),
    () => new net.Socket().connect(9, '127.0.0.1'),
    () => Bun.connect({ hostname: '127.0.0.1', port: 9, socket: { data() {} } }),
  ];
  for (const call of calls) expect(call).toThrow('MODEL_REPLAY_REQUIRED_NETWORK_DENIED');
}
