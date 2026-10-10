import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observeNativeProcess,
  observeNativeProcessResources,
  observeOwnedProcessExit,
  observeProcessListeners,
  parseLinuxProcessStat,
  parseLinuxResidentBytes,
  sameNativeProcess,
} from '../../../scripts/runtime/unified-soak-native';

test('Linux native start ticks stay decimal and comm parentheses do not shift stat fields', () => {
  const fields = [
    'S',
    '33',
    ...Array.from({ length: 17 }, () => '0'),
    '9007199254740993',
    '0',
    '7',
  ];
  expect(parseLinuxProcessStat(`44 (a strange ) name)) ${fields.join(' ')}`, 44)).toEqual({
    parentPid: 33,
    startTicks: '9007199254740993',
  });
  expect(() => parseLinuxProcessStat(`45 (x) ${fields.join(' ')}`, 44)).toThrow(
    'native_process_stat_invalid',
  );
  expect(() => parseLinuxProcessStat('44 (x) S 33', 44)).toThrow('native_process_stat_invalid');
  expect(() => observeNativeProcess(-1)).toThrow('native_process_pid_invalid');
});

test('process listener observation counts four actual registrations and their complete removal', () => {
  const before = observeProcessListeners();
  expect(before.unavailable).toEqual([]);
  expect(before.listeners).not.toBeNull();
  const name = Symbol('owned-soak-process-listener');
  const listeners = Array.from({ length: 4 }, () => () => {});
  try {
    for (const listener of listeners) process.on(name, listener);
    const during = observeProcessListeners();
    expect(during.unavailable).toEqual([]);
    expect(during.listeners).toBe(before.listeners! + 4);
    for (const listener of listeners) process.removeListener(name, listener);
    expect(observeProcessListeners()).toEqual(before);
  } finally {
    for (const listener of listeners) process.removeListener(name, listener);
  }
});

test('native self observation measures four real open FDs and original process start identity', () => {
  const before = observeNativeProcess();
  if (!['darwin', 'linux'].includes(process.platform)) {
    expect(before.fileDescriptors).toBeNull();
    expect(before.startIdentity).toBeNull();
    expect(before.unavailable).toEqual(['native_process_platform_unsupported']);
    return;
  }
  // Supported OS must execute the native syscall; absence is a failure, not an availability skip.
  expect(before.unavailable).toEqual([]);
  expect(before.pid).toBe(process.pid);
  expect(before.parentPid).toBe(process.ppid);
  expect(before.fileDescriptors).not.toBeNull();
  expect(before.startIdentity).not.toBeNull();
  const root = mkdtempSync(join(tmpdir(), 'kite-soak-native-fds-'));
  const handles: number[] = [];
  try {
    const path = join(root, 'owned');
    writeFileSync(path, 'owned native FD observation', { mode: 0o600 });
    for (let index = 0; index < 4; index++) handles.push(openSync(path, 'r'));
    const during = observeNativeProcess();
    expect(during.unavailable).toEqual([]);
    expect(sameNativeProcess(before, during)).toBe(true);
    expect(during.fileDescriptors).toBe(before.fileDescriptors! + 4);
    for (const fd of handles.splice(0)) closeSync(fd);
    const after = observeNativeProcess();
    expect(sameNativeProcess(before, after)).toBe(true);
    expect(after.fileDescriptors).toBe(before.fileDescriptors);
    expect(sameNativeProcess(before, { ...before, pid: before.pid + 1 })).toBe(false);
    expect(sameNativeProcess(before, { ...before, startIdentity: null })).toBe(false);
  } finally {
    for (const fd of handles) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('native owned child start identity is observed while alive and never replaced with a supported zero after exit', async () => {
  if (!['darwin', 'linux'].includes(process.platform)) {
    expect(observeNativeProcess().startIdentity).toBeNull();
    const resources = observeNativeProcessResources(process.pid);
    expect(resources.rssBytes).toBeNull();
    expect(resources.unavailable).toContain('native_process_rss_unavailable');
    return;
  }
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify({pid:process.pid,parentPid:process.ppid})+"\\n");process.stdin.resume()',
    ],
    {
      env: {
        ...process.env,
        NODE_PATH: '',
        NODE_OPTIONS: '',
        BUN_OPTIONS: '',
        ELECTRON_RUN_AS_NODE: '',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = child.stdout.getReader();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('\n')) {
      const next = await output.read();
      if (next.done) throw Error('native_child_ready_missing');
      text += decoder.decode(next.value, { stream: true });
      if (text.length > 1024) throw Error('native_child_ready_invalid');
    }
    const ready = JSON.parse(text);
    expect(ready).toEqual({ pid: child.pid, parentPid: process.pid });
    const original = observeNativeProcess(child.pid);
    expect(original.unavailable).toEqual([]);
    expect(original.parentPid).toBe(process.pid);
    expect(original.startIdentity).not.toBeNull();
    expect(original.fileDescriptors).toBeGreaterThanOrEqual(3);
    expect(sameNativeProcess(original, observeNativeProcess(child.pid))).toBe(true);
    const resources = observeNativeProcessResources(child.pid);
    expect(resources.pid).toBe(child.pid);
    expect(sameNativeProcess(original, resources.before)).toBe(true);
    expect(sameNativeProcess(original, resources.after)).toBe(true);
    expect(resources.before.parentPid).toBe(process.pid);
    expect(resources.after.parentPid).toBe(process.pid);
    expect(resources.after.fileDescriptors).toBeGreaterThanOrEqual(3);
    expect(resources.activeResources).toBeNull();
    expect(resources.handles).toBeNull();
    expect(resources.unsupported).toEqual(['activeResources', 'handles']);
    if (process.platform === 'darwin') {
      expect(resources.unavailable).toEqual([]);
      expect(resources.rssBytes).toBeGreaterThan(0);
      expect(resources.fileDescriptors).toBe(resources.after.fileDescriptors);
    } else {
      expect(resources.version).toBe(2);
      expect(resources.unavailable).toEqual([]);
      expect(resources.rssBytes).toBeGreaterThan(0);
      expect(resources.fileDescriptors).toBe(resources.after.fileDescriptors);
    }
    child.stdin.end();
    expect(await child.exited).toBe(0);
    const ended = observeNativeProcess(child.pid);
    expect(ended.startIdentity).toBeNull();
    expect(ended.fileDescriptors).toBeNull();
    expect(ended.unavailable).toEqual(['native_process_observation_unavailable']);
    expect(sameNativeProcess(original, ended)).toBe(false);
    expect(observeOwnedProcessExit(child.pid, original)).toBe('absent');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await output.cancel();
  }
}, 10000);

test('Linux resident bytes require a single complete bounded KiB field', () => {
  expect(parseLinuxResidentBytes('Name:\towned\nVmRSS:\t1234 kB\n')).toBe(1234 * 1024);
  expect(parseLinuxResidentBytes('VmRSS: 0 kB\n')).toBe(0);
  for (const text of [
    'Name: owned\n',
    'VmRSS: 1 kB\nVmRSS: 2 kB\n',
    'VmRSS: -1 kB\n',
    'VmRSS: 1 MB\n',
    'VmRSS: 9007199254740992 kB\n',
    `VmRSS: 1 kB\n${'x'.repeat(65536)}`,
  ])
    expect(() => parseLinuxResidentBytes(text)).toThrow('native_process_rss_invalid');
});

test('Linux resource sampling brackets RSS and FD reads in one original proc directory and rejects uncertain close', () => {
  const modulePath = new URL('../../../scripts/runtime/unified-soak-native.ts', import.meta.url)
    .pathname;
  const source = `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import * as fs from 'node:fs';
Object.defineProperty(process,'platform',{value:'linux'});
let closeUnknown=false, changed=false, next=10, statReads=0;
const paths=new Map(), offsets=new Map(), opened=[], closed=[];
const fields=()=>['S','50',...Array(17).fill('0'),String(changed&&statReads>1?124:123),'0','7'].join(' ');
mock.module('node:fs',()=>({...fs,
 openSync(path){opened.push(path);if(path==='/proc/60')return 7;const fd=next++;paths.set(fd,path);offsets.set(fd,0);return fd;},
 readSync(fd,bytes,offset,length){const path=paths.get(fd);let text;if(path==='/proc/sys/kernel/random/boot_id')text='12345678-1234-1234-1234-123456789abc\\n';else if(path==='/proc/self/fd/7/stat'){if(offsets.get(fd)===0)statReads++;text='60 (owned) '+fields();}else if(path==='/proc/self/fd/7/status')text='VmRSS: 1234 kB\\n';else throw Error('path replaced');const at=offsets.get(fd);const value=Buffer.from(text);const count=Math.min(length,value.length-at);value.copy(bytes,offset,at,at+count);offsets.set(fd,at+count);return count;},
 opendirSync(path){assert.equal(path,'/proc/self/fd/7/fd');let i=0;return{readSync(){return i++<4?{name:String(i)}:null;},closeSync(){}};},
 closeSync(fd){closed.push(fd);if(fd===7&&closeUnknown)throw Error('original_close_unknown');}
}));
const {observeNativeProcessResources}=await import(${JSON.stringify(modulePath)});
let observed=observeNativeProcessResources(60);assert.equal(observed.version,2);assert.equal(observed.rssBytes,1234*1024);assert.equal(observed.fileDescriptors,4);assert.equal(observed.before.startIdentity.value,'12345678-1234-1234-1234-123456789abc:123');assert.deepEqual(observed.unavailable,[]);assert.equal(opened.filter(path=>path==='/proc/60').length,1);assert.equal(closed.filter(fd=>fd===7).length,1);
closeUnknown=true;observed=observeNativeProcessResources(60);assert.equal(observed.rssBytes,null);assert.equal(observed.fileDescriptors,null);assert.ok(observed.unavailable.length);closeUnknown=false;changed=true;statReads=0;observed=observeNativeProcessResources(60);assert.equal(observed.rssBytes,null);assert.ok(observed.unavailable.length);
`;
  const result = spawnSync(process.execPath, ['--eval', source], {
    encoding: 'utf8',
    timeout: 4000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
