import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { officeCliReleaseAsset } from '../../../src/jobs/officecli-runtime';
import { readOfficeCliRelease } from '../../../src/jobs/prepare-officecli';
import { prepareShellTools } from '../../../src/jobs/prepare-shell-tools';
import { ripgrepAsset } from '../../../src/jobs/ripgrep';

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

test('restores missing Shell metadata and corrupt rg while reusing a verified OfficeCLI', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kite-repair-shell-tools-'));
  try {
    const office = officeCliReleaseAsset();
    const executable = join(directory, office.executable);
    copyFileSync(
      resolve(import.meta.dir, '../../../dist/platform/process/tools', office.executable),
      executable,
    );
    const installedAt = new Date('2020-01-01T00:00:00Z');
    utimesSync(executable, installedAt, installedAt);
    const sourceRg = ripgrepAsset();
    const rg = join(directory, basename(sourceRg));
    const rgBytes = readFileSync(sourceRg);
    const corrupted = Buffer.from(rgBytes);
    corrupted[0] = corrupted[0]! ^ 1;
    writeFileSync(rg, corrupted, { mode: 0o755 });

    await prepareShellTools(directory);

    expect(statSync(executable).mtimeMs).toBe(installedAt.getTime());
    expect(readFileSync(rg).equals(rgBytes)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      rg: { sha256: createHash('sha256').update(rgBytes).digest('hex') },
      officecli: { version: office.version, upstreamSha256: office.sha256, sha256: office.sha256 },
    });
    expect(readFileSync(join(directory, 'LICENSE.vscode-ripgrep'), 'utf8')).toBe(
      readFileSync(resolve(sourceRg, '../../LICENSE'), 'utf8'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('replaces a corrupt OfficeCLI cache only after the fixed download verifies', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'kite-officecli-repair-cache-'));
  const release = officeCliReleaseAsset();
  const bytes = readFileSync(
    resolve(import.meta.dir, '../../../dist/platform/process/tools', release.executable),
  );
  const path = join(cache, release.sha256);
  const invalid = Buffer.from(bytes);
  invalid[0] = invalid[0]! ^ 1;
  const fetchRelease = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(invalid))
    .mockResolvedValueOnce(new Response(bytes));
  try {
    writeFileSync(path, invalid);
    await expect(readOfficeCliRelease(release, cache)).rejects.toThrow(
      'officecli_checksum_mismatch',
    );
    expect(readFileSync(path).equals(invalid)).toBe(true);

    expect(Buffer.from(await readOfficeCliRelease(release, cache)).equals(bytes)).toBe(true);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(Buffer.from(await readOfficeCliRelease(release, cache)).equals(bytes)).toBe(true);
    expect(fetchRelease.mock.calls.map(([url]) => url)).toEqual([release.url, release.url]);
    expect(readdirSync(cache)).toEqual([release.sha256]);
  } finally {
    fetchRelease.mockRestore();
    rmSync(cache, { recursive: true, force: true });
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
