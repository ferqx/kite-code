import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '#kite-test';
import { spawn as spawnProcess } from '../../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';

test('built package supplies its own rg outside the repository with no ambient PATH or npm platform package', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-packaged-rg-')));
  const target = join(root, 'agent');
  try {
    cpSync(resolve(import.meta.dirname, '../../../dist'), target, { recursive: true });
    const source = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8'),
    );
    writeFileSync(
      join(target, 'package.json'),
      JSON.stringify({
        name: source.name,
        type: 'module',
        exports: Object.fromEntries(
          Object.entries(source.exports).map(([key, value]) => [
            key,
            (value as string).replace('./src/', './').replace(/\.ts$/, '.js'),
          ]),
        ),
      }),
    );
    writeFileSync(join(root, 'source.txt'), 'packaged-search-needle\n');
    const code = `import {spawnSync as spawnProcessSync} from ${JSON.stringify(new URL('../../../../../scripts/tooling/process.ts', import.meta.url).href)};
import {which as findExecutable} from ${JSON.stringify(new URL('../../../../../scripts/tooling/process.ts', import.meta.url).href)};
const {withBundledRipgrep,ripgrepAsset}=await import(${JSON.stringify(pathToFileURL(join(target, 'jobs/shell.js')).href)});
const executable=ripgrepAsset();const {env}=withBundledRipgrep({PATH:'',SystemRoot:process.env.SystemRoot??'',PATHEXT:'.EXE'});
const selected=findExecutable('rg',{PATH:env.PATH});if(selected!==executable)throw Error('packaged_rg_lookup_mismatch');
const argv=[selected,'--no-config','-n','packaged-search-needle','source.txt'];
const result=spawnProcessSync(argv,{env,cwd:${JSON.stringify(root)}});if(result.exitCode!==0)throw Error(result.stderr.toString());
console.log(JSON.stringify({executable,path:env.PATH,output:result.stdout.toString()}));`;
    const child = spawnProcess(
      [process.execPath, ...testRuntimeFlags, '--input-type=module-typescript', '-e', code],
      {
        cwd: root,
        env: { SystemRoot: process.env.SystemRoot ?? '', PATH: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.executable).toBe(
      join(target, 'platform/process/tools', process.platform === 'win32' ? 'rg.exe' : 'rg'),
    );
    expect(result.path).toBe(join(target, 'platform/process/tools'));
    expect(result.output).toBe('1:packaged-search-needle\n');
    for (const name of ['LICENSE-MIT.txt', 'LICENSE-PCRE2.txt', 'LICENSE-SLJIT.txt'])
      expect(
        readFileSync(join(target, 'platform/process/tools', name), 'utf8').length,
      ).toBeGreaterThan(300);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
