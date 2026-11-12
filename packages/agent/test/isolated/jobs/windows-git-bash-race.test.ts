import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./windows-git-bash-race.fixture.ts', import.meta.url));
function installation() {
  const root = mkdtempSync(join(tmpdir(), 'kite-staging-race-'));
  const write = (name: string, bytes: string | Buffer) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  const pe = Buffer.alloc(1024);
  pe.writeUInt32LE(128, 0x3c);
  pe.write('PE\0\0', 128);
  pe.writeUInt16LE(0x8664, 132);
  pe.writeUInt16LE(1, 134);
  pe.writeUInt16LE(240, 148);
  pe.writeUInt16LE(0x20b, 152);
  pe.writeUInt32LE(0x1000, 272);
  pe.writeUInt32LE(40, 276);
  pe.writeUInt32LE(0x1000, 404);
  pe.writeUInt32LE(512, 408);
  pe.writeUInt32LE(512, 412);
  pe.writeUInt32LE(0x1100, 524);
  pe.write('ntdll.dll\0', 768);
  write('git/cmd/git.exe', 'git');
  write('git/usr/bin/bash.exe', 'bash');
  write('git/usr/bin/ls.exe', 'ls');
  write('git/usr/bin/msys-2.0.dll', pe);
  write('ktipc.dll', 'compatibility');
  return root;
}
function start(root: string, role: string, target = '', failure = '') {
  const child = spawn(process.execPath, [fixture, root, role, target, failure], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const wait = async (line: string) => {
    const deadline = Date.now() + 10000;
    while (!output.includes(`${line}\n`)) {
      if (child.exitCode !== null || Date.now() >= deadline)
        throw Error(`Waiting for ${line}: ${output} ${stderr}`);
      await Bun.sleep(5);
    }
  };
  return { child, exited, wait, output: () => output, stderr: () => stderr };
}

for (const target of [
  '/usr/bin/bash.exe',
  '/usr/bin/msys-2.0.dll',
  '/full/usr/bin/bash.exe',
  '/manifest.json',
]) {
  test(`same-directory preparations wait for the complete ${target} publication`, async () => {
    const root = installation();
    const owner = start(root, 'owner', target);
    let waiter: ReturnType<typeof start> | undefined;
    try {
      await owner.wait('paused');
      waiter = start(root, 'waiter');
      await waiter.wait('busy');
      expect(waiter.output()).not.toContain('result:');
      expect(waiter.output()).not.toContain('error:');
      owner.child.stdin.end('go');
      expect(await owner.exited).toBe(0);
      expect(await waiter.exited).toBe(0);
      expect(owner.stderr()).toBe('');
      expect(waiter.stderr()).toBe('');
      expect(waiter.output().split('result:')[1]).toBe(owner.output().split('result:')[1]);
      const runtime = join(root, 'state/runtime', readdirSync(join(root, 'state/runtime'))[0]!);
      expect(readFileSync(join(runtime, 'usr/bin/bash.exe'), 'utf8')).toBe('bash');
      expect(readFileSync(join(runtime, 'full/usr/bin/bash.exe'), 'utf8')).toBe('bash');
      expect(JSON.parse(readFileSync(join(runtime, 'manifest.json'), 'utf8')).files).toHaveLength(
        4,
      );
    } finally {
      owner.child.kill();
      waiter?.child.kill();
      await Promise.all([owner.exited, waiter?.exited]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 25000);
}

test('failed preparation releases its lock, preserves partial bytes, and permits explicit missing-file repair', async () => {
  const root = installation();
  const owner = start(root, 'owner', '/usr/bin/bash.exe', 'settle');
  let waiter: ReturnType<typeof start> | undefined;
  let retry: ReturnType<typeof start> | undefined;
  try {
    await owner.wait('paused');
    waiter = start(root, 'waiter');
    await waiter.wait('busy');
    expect(owner.output()).not.toContain('error:');
    expect(waiter.output()).not.toContain('error:');
    owner.child.stdin.end('go');
    expect(await owner.exited).toBe(1);
    expect(await waiter.exited).toBe(1);
    expect(owner.output()).toContain('error:injected_write_failure');
    expect(waiter.output()).toContain('error:windows_git_bash_asset_changed');
    const runtime = join(root, 'state/runtime', readdirSync(join(root, 'state/runtime'))[0]!);
    const partial = join(runtime, 'usr/bin/msys-2.0.dll');
    expect(readFileSync(partial, 'utf8')).toBe('partial');
    expect(readdirSync(runtime)).not.toContain('manifest.json');
    rmSync(partial);
    retry = start(root, 'retry');
    expect(await retry.exited).toBe(0);
    expect(retry.output()).toContain('result:');
  } finally {
    owner.child.kill();
    waiter?.child.kill();
    retry?.child.kill();
    await Promise.all([owner.exited, waiter?.exited, retry?.exited]);
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test('two preparations in one process share the same publication lock', async () => {
  const root = installation();
  const owner = start(root, 'owner', '/usr/bin/msys-2.0.dll', 'same-process');
  try {
    await owner.wait('paused');
    await owner.wait('busy');
    expect(owner.output()).not.toContain('result:');
    owner.child.stdin.end('go');
    expect(await owner.exited).toBe(0);
    expect(owner.stderr()).toBe('');
  } finally {
    owner.child.kill();
    await owner.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test('a killed preparation releases its OS lock without accepting its partial file', async () => {
  const root = installation();
  const owner = start(root, 'owner', '/usr/bin/msys-2.0.dll');
  let waiter: ReturnType<typeof start> | undefined;
  let retry: ReturnType<typeof start> | undefined;
  try {
    await owner.wait('paused');
    waiter = start(root, 'waiter');
    await waiter.wait('busy');
    owner.child.kill('SIGKILL');
    await owner.exited;
    expect(await waiter.exited).toBe(1);
    expect(waiter.output()).toContain('error:windows_git_bash_asset_changed');
    const runtime = join(root, 'state/runtime', readdirSync(join(root, 'state/runtime'))[0]!);
    const partial = join(runtime, 'usr/bin/msys-2.0.dll');
    expect(readFileSync(partial, 'utf8')).toBe('partial');
    expect(readdirSync(runtime)).not.toContain('manifest.json');
    rmSync(partial);
    retry = start(root, 'retry');
    expect(await retry.exited).toBe(0);
  } finally {
    owner.child.kill();
    waiter?.child.kill();
    retry?.child.kill();
    await Promise.all([owner.exited, waiter?.exited, retry?.exited]);
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);
