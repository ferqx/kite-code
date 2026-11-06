import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistentWorktreeDirectory } from '../../fixtures/worktree-filesystem';

const runner = fileURLToPath(new URL('../../e2e/live/model/git-worktree.live.ts', import.meta.url));

for (const selectedCase of ['primary', 'child-default'])
  test.skipIf(process.platform !== 'darwin')(
    `full live launcher isolates ${selectedCase} before native readiness, Git and Provider`,
    async () => {
      const root = persistentWorktreeDirectory('kite-live-launch-regression-');
      const bootstrapHome = join(root, 'bootstrap-home');
      mkdirSync(bootstrapHome, { mode: 0o700 });
      const output = join(root, 'case');
      const execute = async () => {
        const child = Bun.spawn(
          [
            process.execPath,
            runner,
            `--case=${selectedCase}`,
            `--output=${output}`,
            '--launch-preflight',
          ],
          {
            // Acceptance storage belongs to the runner repository, not the caller cwd.
            cwd: selectedCase === 'primary' ? tmpdir() : process.cwd(),
            env: {
              HOME: bootstrapHome,
              USERPROFILE: bootstrapHome,
              PATH: '/usr/bin:/bin',
              KITE_RUN_LIVE_GIT_WORKTREE: '1',
              ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { code, stdout, stderr };
        } finally {
          if (child.exitCode === null) child.kill('SIGINT');
          await child.exited;
        }
      };
      const first = await execute();
      writeFileSync(join(root, 'stdout.log'), first.stdout);
      writeFileSync(join(root, 'stderr.log'), first.stderr);
      expect(first.code, first.stderr).toBe(0);
      const reportPath = join(output, 'launch-preflight.json');
      const original = readFileSync(reportPath, 'utf8');
      expect(JSON.parse(original)).toMatchObject({
        status: 'launch_preflight_passed',
        fixtureHome: `${output}.home`,
        homeMatchesStartup: true,
        providerConstructed: false,
        gitCommands: 0,
        nativeSupervision: 'closed_and_verified',
      });
      expect(readdirSync(join(output, 'source'))).toEqual([]);
      expect(existsSync(join(output, 'source', '.git'))).toBe(false);
      expect(existsSync(join(bootstrapHome, '.kite-code', 'worktrees'))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(output, 'native-preflight', 'report.json'), 'utf8')),
      ).toMatchObject({
        status: 'passed',
        closeConfirmed: true,
        providerRequests: 0,
        gitCommands: 0,
        requestedScope: { filesystem: 'workspace_write', network: 'none' },
      });
      const duplicate = await execute();
      expect(duplicate.code).not.toBe(0);
      expect(duplicate.stderr).toContain(
        'live-worktree-new-absolute-acceptance-directory-required',
      );
      expect(readFileSync(reportPath, 'utf8')).toBe(original);
      expect(readdirSync(join(output, 'source'))).toEqual([]);
    },
    60000,
  );
