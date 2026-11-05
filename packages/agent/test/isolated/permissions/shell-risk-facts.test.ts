import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuthorizationRequest } from '../../../src/extensions';
import { ripgrepAsset } from '../../../src/jobs/ripgrep';
import { createShellConfiguration } from '../../../src/permissions/shell';
import { createShellCommandPolicy } from '../../../src/permissions/shell-command-policy';
import {
  createShellRiskPreparer,
  ripgrepRiskFacts,
} from '../../../src/permissions/shell-risk-facts';

const scope = { filesystem: 'workspace_write', network: 'none' } as const;
const signal = () => new AbortController().signal;
const texts = ['#!/bin/sh\ncat -- "$1"\n', '#!/bin/sh\nrm -rf -- /home/user\n'];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-risk-facts-')));
  const rg = ripgrepAsset();
  const shell = process.platform === 'win32' ? Bun.which('bash')! : '/bin/sh';
  return { root, rg, shell, close: () => rmSync(root, { recursive: true, force: true }) };
}
async function preparer(
  f: ReturnType<typeof fixture>,
  options: { env?: Record<string, string>; protectedPaths?: string[] } = {},
) {
  const policy = await createShellCommandPolicy({ cwd: f.root, shellExecutable: f.shell });
  return createShellRiskPreparer({
    cwd: f.root,
    rgPath: f.rg,
    interpreterPaths: [realpathSync(f.shell)],
    env: options.env ?? {
      PATH: `${dirname(f.rg)}${process.platform === 'win32' ? ';' : ':'}${dirname(f.shell)}`,
    },
    protectedPaths: options.protectedPaths ?? [],
    binding: { fixture: 'fixed' },
    sanitizedEnvironment: true,
    classify: (command) => policy.classify(command),
    rewritten: async () => false,
  });
}

test('rg facts consume attached, equals and next-token values before recognizing terminators', async () => {
  const f = fixture();
  try {
    const policy = await createShellCommandPolicy({ cwd: f.root, shellExecutable: f.shell });
    const examples = [
      ['rg -e -- input.txt', false],
      ['rg -e -- --pre=./scan-hook input.txt', true],
      ['rg -e -- -- --pre=./scan-hook input.txt', false],
      ['rg --regexp -- --pre ./format-reader -- input.txt', true],
      ['rg --regexp=-- -- --pre=./format-reader input.txt', false],
      ['rg -e-- --pre ./filter input.txt', true],
      ['rg --pre=./filter --file=./patterns.txt input.txt', true],
      ["rg -F -e'--pre=./filter' input.txt", false],
      ['rg -F needle -- ./--pre=filter', false],
      ['rg -n --regexp=needle input.txt', false],
      ['rg -f -- --pre ./filter input.txt', true],
    ] as const;
    for (const [command, invokes] of examples) {
      const parsed = await policy.classify(command);
      const facts = ripgrepRiskFacts(parsed.plainCommands![0]!);
      expect(facts.availability, command).toBe('available');
      expect((facts.configuredPreprocessors as unknown[]).length > 0, command).toBe(invokes);
      expect((facts.tokens as unknown[]).length, command).toBe(parsed.plainCommands![0]!.length);
    }
    const attached = ripgrepRiskFacts(['rg', '-e--', '--pre', './filter', 'input.txt']);
    expect(attached.optionTerminatorIndex).toBeNull();
    expect(attached.consumedOptionValues).toContainEqual({
      optionIndex: 1,
      valueIndex: 1,
      option: '-e',
      value: '--',
      valueKind: 'pattern',
      form: 'attached',
    });
    for (const argv of [
      ['rg', '--pr', './hook', 'x'],
      ['rg', '--pre'],
      ['rg', '--pre=', 'x'],
      ['rg', '-nF', 'x'],
      ['rg', '--hostname-bin', './hook', 'x'],
    ])
      expect(ripgrepRiskFacts(argv).availability).toBe('unavailable');
  } finally {
    f.close();
  }
});

test('real bundled rg identity and unchanged argv yield equal facts while entry bytes change fingerprint', async () => {
  const f = fixture();
  try {
    const review = await preparer(f);
    const command = 'rg -e-- --pre ./filter input.txt';
    writeFileSync(join(f.root, 'filter'), texts[0]!);
    const low = await review.prepare(command, scope, signal());
    writeFileSync(join(f.root, 'filter'), texts[1]!);
    const high = await review.prepare(command, scope, signal());
    expect(low.material.commandFacts).toEqual(high.material.commandFacts);
    expect(low.fingerprint).not.toBe(high.fingerprint);
    expect(low.reusable).toBe(false);
    expect(high.material.directScripts).toMatchObject([
      {
        path: './filter',
        text: texts[1],
        complete: true,
        byteLength: Buffer.byteLength(texts[1]!),
        hash: createHash('sha256').update(texts[1]!).digest('hex'),
      },
    ]);
    const literal = await review.prepare('rg -e -- -- --pre=./filter input.txt', scope, signal());
    expect(literal.material.directScripts).toEqual([]);
    expect(literal.reusable).toBe(true);
    expect(readFileSync(join(f.root, 'filter'), 'utf8')).toBe(texts[1]!);
  } finally {
    f.close();
  }
});

test('custom rg, ambient config and dynamic Shell do not acquire verified program semantics or cache reuse', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, process.platform === 'win32' ? 'rg.exe' : 'rg'), texts[0]!);
    chmodSync(join(f.root, process.platform === 'win32' ? 'rg.exe' : 'rg'), 0o700);
    const custom = await preparer(f, { env: { PATH: f.root } });
    const unknown = await custom.prepare('rg -e -- --pre ./filter input.txt', scope, signal());
    expect(unknown.material.commandFacts).toMatchObject({
      availability: 'unavailable',
      reason: 'program_semantics_unverified',
    });
    expect(unknown.reusable).toBe(false);
    const configured = await preparer(f, {
      env: { PATH: dirname(f.rg), RIPGREP_CONFIG_PATH: join(f.root, 'config') },
    });
    expect(
      (await configured.prepare('rg -e x input.txt', scope, signal())).material.commandFacts,
    ).toMatchObject({ availability: 'unavailable', reason: 'ambient_rg_configuration' });
    const dynamic = await custom.prepare('rg "$PATTERN" input.txt', scope, signal());
    expect(dynamic.material.commandFacts).toMatchObject({
      availability: 'unavailable',
      reason: 'not_single_literal_invocation',
    });
    expect(dynamic.reusable).toBe(false);
  } finally {
    f.close();
  }
});

test('script capture is bounded, protected, nonrecursive, cancelable and never executes code', async () => {
  const f = fixture();
  const other = fixture();
  try {
    writeFileSync(join(f.root, 'script.sh'), '#!/bin/sh\nprintf executed > marker\n');
    writeFileSync(join(f.root, 'protected.sh'), 'PRIVATE MUST NOT APPEAR');
    writeFileSync(join(other.root, 'outside.sh'), 'OUTSIDE MUST NOT APPEAR');
    writeFileSync(join(f.root, 'large.sh'), 'x'.repeat(65537));
    symlinkSync(join(other.root, 'outside.sh'), join(f.root, 'link.sh'));
    symlinkSync(f.root, join(other.root, 'workspace-alias'), 'dir');
    const review = await preparer(f, {
      protectedPaths: [join(other.root, 'workspace-alias', 'protected.sh')],
    });
    const captured = await review.prepare('./script.sh', scope, signal());
    expect(captured.material.directScripts).toMatchObject([{ complete: true }]);
    expect(() => readFileSync(join(f.root, 'marker'))).toThrow();
    for (const command of [
      './missing.sh',
      './protected.sh',
      './large.sh',
      './link.sh',
      join(other.root, 'outside.sh'),
    ]) {
      const result = await review.prepare(command, scope, signal());
      expect(result.material.directScripts, command).toMatchObject([
        { availability: 'unavailable', complete: false },
      ]);
      expect(JSON.stringify(result.material)).not.toContain('MUST NOT APPEAR');
      expect(result.reusable).toBe(false);
    }
    expect(
      (await review.prepare('sh script.sh', scope, signal())).material.directScripts,
    ).toMatchObject([{ path: 'script.sh', complete: true }]);
    expect(
      (await review.prepare('python3 -c "print(1)"', scope, signal())).material.directScripts,
    ).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(review.prepare('./script.sh', scope, controller.signal)).rejects.toThrow();
    writeFileSync(join(f.root, 'script.sh'), '#!/bin/sh\nprintf changed\n');
    await expect(review.verify(captured.snapshots, signal())).rejects.toThrow(
      'shell_review_entry_changed',
    );
  } finally {
    f.close();
    other.close();
  }
});

test.skipIf(process.platform !== 'darwin')(
  'Shell API shares Tool/Job fingerprint and checks only genuinely reviewed Job entries before any launch',
  async () => {
    const f = fixture();
    try {
      const supervisor = join(f.root, 'supervisor.js');
      writeFileSync(supervisor, '// never launched');
      writeFileSync(join(f.root, 'script.sh'), texts[0]!);
      const configuration = await createShellConfiguration({
        workspaceRoot: f.root,
        toolIds: ['shell.launch'],
        options: {
          platform: 'darwin',
          configurationId: 'risk-review-test',
          env: { PATH: dirname(f.rg) },
          supervisorPath: supervisor,
          bunExecutable: process.execPath,
          shellExecutable: '/bin/sh',
        },
      });
      const tool: AuthorizationRequest = {
        kind: 'tool',
        sessionId: 's',
        runId: 'r',
        executionId: 'tool',
        definitionId: 'shell.launch',
        definitionVersion: '1',
        input: { command: './script.sh' },
        signal: signal(),
      };
      const jobRequest: AuthorizationRequest = {
        ...tool,
        kind: 'job',
        executionId: 'job',
        definitionId: 'shell.command',
      };
      const first = await configuration.prepareRiskReview(tool);
      const second = await configuration.prepareRiskReview(jobRequest);
      await configuration.prepareRiskReview({ ...jobRequest, executionId: 'timeout-job' });
      expect(first?.fingerprint).toBe(second?.fingerprint);
      writeFileSync(join(f.root, 'script.sh'), texts[1]!);
      writeFileSync(supervisor, '// changed to force original asset check without launching');
      const job = configuration.extensions[0]!.jobs![0]!;
      const start = (executionId: string, approved: boolean) =>
        job.start(
          { command: './script.sh' },
          {
            sessionId: 's',
            executionId,
            signal: signal(),
            dispatchAuthorization: {
              revision: 'r',
              ...(approved ? { riskReviewApproved: true as const } : {}),
            },
          },
        );
      await expect(start('job', true)).rejects.toThrow('shell_review_entry_changed');
      // Start consumed the saved snapshot; neither a timeout nor a job without
      // prepare gains this additional check. Original fixed-asset checks still run.
      await expect(start('timeout-job', false)).rejects.toThrow('shell_asset_changed');
      await expect(start('unprepared', true)).rejects.toThrow('shell_asset_changed');
    } finally {
      f.close();
    }
  },
);
