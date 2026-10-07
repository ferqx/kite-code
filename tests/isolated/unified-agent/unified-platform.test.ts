import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTerminalBundle } from '../../../scripts/release/terminal-bundle';
import {
  parseUnifiedPlatformArgs,
  runUnifiedPlatformProbe,
  sealUnifiedPlatform,
} from '../../../scripts/release/unified-platform-probe';
import {
  parseUnifiedPlatformVerifyArgs,
  verifyUnifiedPlatformReport,
} from '../../../scripts/release/unified-platform-verify';

test('platform argv is closed and cannot enable Shell, providers or capability claims', () => {
  for (const args of [
    [],
    ['--candidate=/x'],
    ['--candidate=relative', '--output=/x'],
    ['--candidate=/x', '--output=/x', '--effectful'],
    ['--candidate=/x', '--candidate=/y'],
  ])
    expect(() => parseUnifiedPlatformArgs(args)).toThrow();
  expect(parseUnifiedPlatformArgs(['--candidate=/x', '--output=/y'])).toEqual({
    candidate: '/x',
    output: '/y',
  });
  expect(() => parseUnifiedPlatformVerifyArgs(['--report=/x', '--mode=full'])).toThrow();
});
test('malformed/future report and unsupported production declarations are rejected', () => {
  expect(verifyUnifiedPlatformReport(null, 'diagnostic')).toEqual([
    'platform_report_structure_invalid',
  ]);
  const forged = sealUnifiedPlatform({
    version: 1,
    status: 'passed',
    effectfulQualified: true,
    productionQualified: true,
  });
  expect(verifyUnifiedPlatformReport(forged, 'diagnostic')).toContain(
    'unsupported_production_claim',
  );
  expect(verifyUnifiedPlatformReport(forged, 'formal')).toContain(
    'default_effectful_platform_not_qualified',
  );
});
test('actual invalid argv performs no profile, candidate or report I/O', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-platform-invalid-')));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, '../../../scripts/release/unified-platform-probe.ts'),
        `--candidate=${join(home, 'candidate')}`,
        `--output=${join(home, 'report.json')}`,
        '--effectful',
      ],
      {
        cwd: home,
        // Bun otherwise writes its TypeScript transpiler cache before this script executes.
        env: { HOME: home, PATH: process.env.PATH ?? '', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const output = new Response(child.stdout).text();
    const error = new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(await output).toBe('');
    expect(await error).toContain('unified_platform_arguments_invalid');
    expect(readdirSync(home)).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'actual relocated default platform diagnostic proves macOS default Shell, Files, runtime denial, SQLite and two shared leases',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-platform-test-')));
    try {
      const candidate = await buildTerminalBundle({ destination: join(root, 'candidate') });
      const report = await runUnifiedPlatformProbe(candidate.root);
      if (report.status !== 'passed') throw Error(JSON.stringify(report));
      expect(report.status).toBe('passed');
      expect(verifyUnifiedPlatformReport(report, 'diagnostic')).toEqual([]);
      expect(verifyUnifiedPlatformReport(report, 'formal')).toEqual([
        'default_effectful_platform_not_qualified',
      ]);
      expect(report.effectfulQualified).toBe(false);
      expect(report.productionQualified).toBe(false);
      const { digest: _digest, ...body } = report;
      const widened = sealUnifiedPlatform({ ...body, effectfulQualified: true });
      expect(verifyUnifiedPlatformReport(widened, 'diagnostic')).toContain(
        'unsupported_production_claim',
      );
      const future = sealUnifiedPlatform({ ...body, future: { raw: 'not qualification' } });
      expect(verifyUnifiedPlatformReport(future, 'diagnostic')).toContain(
        'platform_report_fields_invalid',
      );
      const corrupt = { ...report, digest: '0'.repeat(64) };
      expect(verifyUnifiedPlatformReport(corrupt, 'diagnostic')).toContain(
        'platform_report_digest_mismatch',
      );
      if (process.platform === 'darwin') {
        const evidence = body.evidence as Record<string, unknown>;
        const shell = evidence.shell as Record<string, unknown>;
        expect(shell).toMatchObject({
          status: 'passed',
          jobs: 1,
          processTreeStopped: true,
          coldRead: true,
          noReplay: true,
        });
        for (const field of ['processTreeStopped', 'coldRead', 'noReplay']) {
          const forged = sealUnifiedPlatform({
            ...body,
            evidence: { ...evidence, shell: { ...shell, [field]: false } },
          });
          expect(verifyUnifiedPlatformReport(forged, 'diagnostic')).toContain(
            'platform_shell_case_invalid',
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
