import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('private directory preparation pins parent descriptors, checks cancellation and never follows competing names', () => {
  const path = fileURLToPath(
    new URL('../../../src/jobs/linux-private-directory.ts', import.meta.url),
  );
  const identity = fileURLToPath(new URL('../../../src/jobs/launch-identity.ts', import.meta.url));
  const source = `
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const original={...fs};
const descriptors=new Map();
let mkdirs=0,mode='normal',controller;
const translate=path=>{const match=/^\\/proc\\/self\\/fd\\/(\\d+)\\/(.+)$/.exec(String(path));if(!match)return String(path);const parent=descriptors.get(Number(match[1]));assert.ok(parent);return join(parent,match[2]);};
const root=original.realpathSync(original.mkdtempSync(join(tmpdir(),'kite-linux-private-directory-')));
const outside=join(root,'outside');original.mkdirSync(outside);
mock.module('node:fs',()=>({...original,
 openSync(path,flags){assert.ok(flags&original.constants.O_DIRECTORY);assert.ok(flags&original.constants.O_NOFOLLOW);const selected=translate(path);const fd=original.openSync(selected,flags);assert.equal(descriptors.has(fd),false);descriptors.set(fd,selected);return fd;},
 closeSync(fd){assert.equal(descriptors.has(fd),true);descriptors.delete(fd);return original.closeSync(fd);},
 mkdirSync(path,options){assert.match(String(path),/^\\/proc\\/self\\/fd\\/\\d+\\/[^/]+$/);assert.deepEqual(options,{mode:0o700});mkdirs++;const selected=translate(path);if(mode==='symlink')original.symlinkSync(outside,selected);const result=original.mkdirSync(selected,options);if(mode==='cancel')controller.abort(Error('original_cancel'));return result;},
 readSync(){throw Error('private_content_read');},readFileSync(){throw Error('private_content_read');},
}));
const {prepareLinuxPrivateDirectory:prepare}=await import(${JSON.stringify(path)});
const {launchIdentity}=await import(${JSON.stringify(identity)});
try {
 controller=new AbortController();const parent=launchIdentity(root),target=join(root,'new-parent','codex-home');
 const result=prepare(target,parent,controller.signal);assert.equal(result.canonical,target);assert.equal(mkdirs,2);assert.equal(original.statSync(target).mode&0o777,0o700);assert.equal(original.existsSync(join(target,'auth.json')),false);assert.equal(descriptors.size,0);
 original.chmodSync(target,0o750);const before=mkdirs;prepare(target,launchIdentity(target),controller.signal);assert.equal(mkdirs,before);assert.equal(original.statSync(target).mode&0o777,0o750);assert.equal(descriptors.size,0);
 controller.abort(Error('cancel_before_prepare'));const absent=join(root,'cancelled');assert.throws(()=>prepare(absent,parent,controller.signal),/cancel_before_prepare/);assert.equal(mkdirs,before);assert.equal(original.existsSync(absent),false);assert.equal(descriptors.size,0);
 mode='cancel';controller=new AbortController();const partial=join(root,'partial','never-created');assert.throws(()=>prepare(partial,parent,controller.signal),/original_cancel/);assert.equal(original.existsSync(join(root,'partial')),true);assert.equal(original.existsSync(partial),false);assert.equal(descriptors.size,0);
 mode='symlink';controller=new AbortController();const redirected=join(root,'redirected');assert.throws(()=>prepare(redirected,parent,controller.signal),/linux_shell_private_directory_unavailable/);assert.deepEqual(original.readdirSync(outside),[]);assert.equal(descriptors.size,0);
} finally {original.rmSync(root,{recursive:true,force:true});}
`;
  const result = spawnSync(process.execPath, ['--eval', source], {
    timeout: 4000,
    encoding: 'utf8',
  });
  if (result.status !== 0) console.error(result.stderr);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
});
