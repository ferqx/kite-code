import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('desktop development pure help and missing built Service never build, launch or write a checkout/profile', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-development-desktop-')));
  const entry = pathToFileURL(
    join(import.meta.dir, '../../../scripts/development/unified-desktop.ts'),
  ).href;
  const execute = async (argv: readonly string[]) => {
    const program = `import {runDevelopmentDesktop} from ${JSON.stringify(entry)};try{process.exitCode=await runDevelopmentDesktop({argv:${JSON.stringify(argv)},root:${JSON.stringify(root)},executable:'/absent-development-runtime'});}catch(error){console.error(error.code??error.message);process.exitCode=1;}`;
    const child = Bun.spawn([process.execPath, '-e', program], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  };
  try {
    const help = await execute(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Kite desktop development');
    expect(help.stderr).toBe('');
    expect(readdirSync(root)).toEqual([]);
    const missing = await execute([]);
    expect(missing).toEqual({
      code: 1,
      stdout: '',
      stderr: 'development_service_asset_unavailable\n',
    });
    expect(readdirSync(root)).toEqual([]);
    const invalid = await execute(['--help', '--watch']);
    expect(invalid.stderr).toBe('desktop_development_arguments_invalid\n');
    expect(invalid.code).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
