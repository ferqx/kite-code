import { expect, test } from 'bun:test';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { officeCliReleaseAsset } from '../../../src/jobs/officecli-runtime';

test('built package supplies rg and OfficeCLI outside the repository with no ambient PATH', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-packaged-rg-')));
  const target = join(root, 'agent');
  try {
    cpSync(resolve(import.meta.dir, '../../../dist'), target, { recursive: true });
    const source = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../../../package.json'), 'utf8'),
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
    const code = `const {bundledOfficeCliAsset,withBundledRipgrep,ripgrepAsset}=await import(${JSON.stringify(pathToFileURL(join(target, 'jobs/shell.js')).href)});
const executable=ripgrepAsset();const {env}=withBundledRipgrep({PATH:'',SystemRoot:process.env.SystemRoot??'',PATHEXT:'.EXE'});
const selected=Bun.which('rg',{PATH:env.PATH});if(selected!==executable)throw Error('packaged_rg_lookup_mismatch');
const argv=[selected,'--no-config','-n','packaged-search-needle','source.txt'];
const result=Bun.spawnSync(argv,{env,cwd:${JSON.stringify(root)}});if(result.exitCode!==0)throw Error(result.stderr.toString());
const officecli=bundledOfficeCliAsset();
if(Bun.which('officecli',{PATH:env.PATH})!==officecli)throw Error('packaged_officecli_lookup_mismatch');
const office=Bun.spawnSync([officecli,'--version'],{env,cwd:${JSON.stringify(root)}});
if(office.exitCode!==0)throw Error(office.stderr.toString());
console.log(JSON.stringify({executable,officecli,officeCliVersion:office.stdout.toString().trim(),path:env.PATH,output:result.stdout.toString()}));`;
    const child = Bun.spawn([process.execPath, '-e', code], {
      cwd: root,
      env: { SystemRoot: process.env.SystemRoot ?? '', PATH: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
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
    const office = officeCliReleaseAsset();
    const tools = join(target, 'platform/process/tools');
    expect(result.officecli).toBe(join(tools, office.executable));
    expect(result.officeCliVersion).toBe(office.version);
    const manifest = JSON.parse(readFileSync(join(tools, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      officecli: { asset: office.name, upstreamSha256: office.sha256, sha256: office.sha256 },
    });
    expect(readdirSync(tools).filter((file) => file.startsWith('officecli'))).toEqual([
      office.executable,
    ]);
    const officeAssets = join(target, 'skills/office');
    const skillDirectories = ['docx', 'pdf', 'pptx', 'xlsx'];
    const notices = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt'];
    expect(readdirSync(officeAssets).sort()).toEqual([...notices, ...skillDirectories]);
    for (const format of skillDirectories)
      expect(readFileSync(join(officeAssets, format, 'SKILL.md'), 'utf8')).not.toBe('');
    for (const name of notices) {
      expect(readFileSync(join(officeAssets, name), 'utf8')).not.toBe('');
    }
    for (const name of ['LICENSE-MIT.txt', 'LICENSE-PCRE2.txt', 'LICENSE-SLJIT.txt'])
      expect(
        readFileSync(join(target, 'platform/process/tools', name), 'utf8').length,
      ).toBeGreaterThan(300);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test.each([
  ['win32', 'x64', 'officecli-win-x64.exe'],
  ['darwin', 'arm64', 'officecli-mac-arm64'],
  ['darwin', 'x64', 'officecli-mac-x64'],
  ['linux', 'arm64', 'officecli-linux-arm64'],
  ['linux', 'x64', 'officecli-linux-x64'],
] as const)('selects the OfficeCLI release for %s %s', (platform, arch, name) => {
  const asset = officeCliReleaseAsset(platform, arch);
  expect(asset.name).toBe(name);
  expect(asset.url).toEndWith(`/v${asset.version}/${name}`);
  expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
});
