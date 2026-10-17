import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultWindowsPathSecurity } from '../../../../packages/agent/src/platform/windows-path-security';
import { copyWindowsSystemExecutable } from '../../../../scripts/release/build-windows-terminal-launcher';
import {
  releaseDirectory,
  releaseScratch,
} from '../../../../tests/fixtures/unified-agent/release-filesystem';
import { windowsTerminalRuntimeArguments } from '../../../service/src/runtime-assets';

test.skipIf(process.platform !== 'win32')(
  'actual Electron Node paired adapter forwards only fixed candidate Bun config arguments and executes the Service body',
  async () => {
    const root = releaseScratch(join(tmpdir(), 'kite-node-paired-argv-'));
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
    try {
      const runtime = join(root, 'runtime'),
        input = join(root, 'input'),
        cwd = join(root, 'cwd');
      releaseDirectory(runtime);
      releaseDirectory(input);
      releaseDirectory(cwd);
      const security = defaultWindowsPathSecurity()!;
      const executable = join(runtime, 'bun.exe'),
        entry = join(root, 'service.js'),
        poison = join(root, 'poison.js'),
        marker = join(root, 'preload-ran');
      const rawInput = join(input, 'bun.exe');
      security.writePrivateArtifactFile(rawInput, readFileSync(process.execPath));
      copyWindowsSystemExecutable(rawInput, executable);
      security.writePrivateFile(join(runtime, 'windows-bunfig.toml'), Buffer.from(''));
      security.writePrivateFile(
        join(runtime, 'windows-tsconfig.json'),
        Buffer.from('{"compilerOptions":{}}'),
      );
      security.writePrivateFile(
        entry,
        Buffer.from(
          `if(process.cwd()!==${JSON.stringify(cwd)})throw Error('original_cwd_lost');console.log('NATIVE_PAIRED_CONFIG_ARGV_EXECUTED');`,
        ),
      );
      security.writePrivateFile(
        poison,
        Buffer.from(
          `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unsafe');throw Error('POISON_PRELOAD_EXECUTED');`,
        ),
      );
      security.writePrivateFile(
        join(cwd, 'bunfig.toml'),
        Buffer.from(`preload=[${JSON.stringify(poison)}]\n`),
      );
      security.writePrivateFile(
        join(cwd, 'tsconfig.json'),
        Buffer.from(JSON.stringify({ compilerOptions: { paths: { '*': [poison] } } })),
      );
      const adapter = resolve(import.meta.dir, '../../electron/node-process.ts');
      const paired = resolve(import.meta.dir, '../../../service/src/paired.ts');
      const profile = resolve(import.meta.dir, '../../../../packages/agent/src/profile.ts');
      const fixed = windowsTerminalRuntimeArguments(root);
      const command = [executable, ...fixed, entry];
      const source = join(root, 'driver.ts');
      security.writePrivateFile(
        source,
        Buffer.from(`import assert from 'node:assert/strict';
import {spawnNodePairedChild} from ${JSON.stringify(adapter)};
import {launchPairedService} from ${JSON.stringify(paired)};
import {selectProfile} from ${JSON.stringify(profile)};
const env={SystemRoot:process.env.SystemRoot,PATH:'',HOME:${JSON.stringify(cwd)},USERPROFILE:${JSON.stringify(cwd)}};
const command=${JSON.stringify(command)};
for(const invalid of [command.slice(0,-1),[command[0],'--preload',${JSON.stringify(poison)},command.at(-1)],command.map(arg=>arg.startsWith('--config=')?'--config=relative':arg),command.map(arg=>arg.startsWith('--tsconfig-override=')?'--tsconfig-override='+${JSON.stringify(poison)}:arg),command.map(arg=>arg.startsWith('--config=')?arg.replace('--config=','--config'):arg)])assert.throws(()=>spawnNodePairedChild(invalid,{env}),/invalid_paired_command/);
const child=spawnNodePairedChild(command,{env});child.stdin.end();
const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
assert.equal(code,0);assert.equal(stdout.trim(),'NATIVE_PAIRED_CONFIG_ARGV_EXECUTED');assert.equal(stderr,'');
// Native host admission must not import the Bun-only default, and must stay
// borrowed until the original child exit is fulfilled, even on bad bootstrap.
for(const unknown of [false,true]){
 let releases=0,stopping,resolveExit,rejectExit;
 const stop=new Promise(done=>stopping=done),exited=new Promise((done,reject)=>{resolveExit=done;rejectExit=reject;});
 const startup=launchPairedService({entrypoint:command.at(-1),executable:command[0],profile:selectProfile({dataRoot:${JSON.stringify(join(root, 'data'))},profile:'default'}),instanceId:'native-port',buildId:'fixed',apiMajor:1,requiredCapabilities:[],runtimeProtection:{kind:'terminal.candidate',root:${JSON.stringify(root)},manifestSha256:'a'.repeat(64)},
 retainWindowsArtifact(proof,actual){assert.equal(proof.root,${JSON.stringify(root)});assert.equal(actual.executable,command[0]);return {arguments:command.slice(1,-1),release(){releases++;}};},
 spawnChild(argv){assert.deepEqual(argv,command);return {pid:42,exited,stdin:{write(){},flush(){},end(){stopping();}},stdout:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{}\\n'));c.close();}}),stderr:new ReadableStream({start(c){c.close();}}),kill(){}};}});
 void startup.catch(()=>{});await stop;assert.equal(releases,0);
 if(unknown)rejectExit(Error('original_exit_unknown'));else resolveExit(0);
 await assert.rejects(startup);assert.equal(releases,unknown?0:1);
}
console.log('NODE_PAIRED_FIXED_CONFIG_OK');`),
      );
      const built = await Bun.build({
        entrypoints: [source],
        target: 'node',
        format: 'esm',
        packages: 'bundle',
        outdir: root,
        naming: 'driver.mjs',
      });
      if (!built.success) throw new AggregateError(built.logs, 'node_paired_driver_build_failed');
      const electron = createRequire(resolve(import.meta.dir, '../../package.json'))(
        'electron',
      ) as string;
      child = Bun.spawn([electron, join(root, 'driver.mjs')], {
        cwd,
        env: { SystemRoot: process.env.SystemRoot, PATH: '', ELECTRON_RUN_AS_NODE: '1' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => child!.kill('SIGKILL'), 15000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw Error(`node_paired_fixed_config_failed:${stderr}`);
        expect(stdout.trim()).toBe('NODE_PAIRED_FIXED_CONFIG_OK');
        expect(existsSync(marker)).toBe(false);
        expect(readFileSync(entry, 'utf8')).toContain('NATIVE_PAIRED_CONFIG_ARGV_EXECUTED');
      } finally {
        clearTimeout(timer);
      }
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
