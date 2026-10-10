import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LinuxOwnedProgramStartError,
  startLinuxOwnedProgram,
} from '../../../src/platform/process/linux-owned-program';

/** Actual Linux owner only; missing native prerequisites are failures, never availability skips. */
export async function qualifyLinuxOwnedProgram() {
  const compiler = Bun.which('cc'),
    bubblewrap = Bun.which('bwrap');
  assert.ok(compiler, 'linux_stdio_compiler_unavailable');
  assert.ok(bubblewrap, 'linux_stdio_bubblewrap_unavailable');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-linux-stdio-owner-')));
  let owner: ReturnType<typeof startLinuxOwnedProgram> | undefined;
  let failure: unknown;
  const cleanup: unknown[] = [];
  try {
    mkdirSync(join(root, 'cwd'), { mode: 0o700 });
    const init = join(root, 'init');
    const built = spawnSync(
      compiler,
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fstack-protector-strong',
        '-D_FORTIFY_SOURCE=2',
        '-fPIE',
        '-pie',
        '-Wl,-z,relro,-z,now',
        join(import.meta.dir, '../../../native/linux-stdio-init.c'),
        '-o',
        init,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(built.error, undefined);
    assert.equal(built.status, 0, built.stderr);
    const script = join(root, 'server.mjs');
    writeFileSync(
      script,
      `
import {spawn} from 'node:child_process';
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 buffer+=chunk;
 if(!buffer.includes('\\n'))return;
 const request=JSON.parse(buffer.trim());
 spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,env:{},stdio:'ignore'}).unref();
 process.stdout.write(JSON.stringify({request,arg:process.argv[2],env:process.env.ONLY_ORIGINAL,cwd:process.cwd(),full:'x'.repeat(65536)})+'\\n',()=>process.exit(7));
});
`,
    );
    owner = startLinuxOwnedProgram({
      bubblewrapPath: realpathSync(bubblewrap),
      initExecutable: init,
      executable: realpathSync(process.execPath),
      argv: [script, 'literal ; $() original'],
      cwd: join(root, 'cwd'),
      env: { ONLY_ORIGINAL: 'original-value' },
      nonce: 'linux_stdio_original_native',
      graceMs: 200,
    });
    const output = (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const raw of owner!.stdout) {
        const chunk = Buffer.from(raw);
        bytes += chunk.length;
        assert.ok(bytes <= 128 * 1024);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    })();
    const stderr = (async () => {
      let bytes = 0;
      for await (const chunk of owner!.stderr) {
        bytes += chunk.length;
        assert.ok(bytes <= 65536);
      }
    })();
    await owner.ready;
    await owner.writeStdin(Buffer.from('{"original":"RPC once"}\n'));
    await owner.endStdin();
    const completion = await owner.completion;
    const body = JSON.parse(await output);
    await stderr;
    assert.deepEqual(completion, { confirmed: true, code: 7, signal: null, reason: 'natural' });
    assert.deepEqual(body.request, { original: 'RPC once' });
    assert.equal(body.arg, 'literal ; $() original');
    assert.equal(body.env, 'original-value');
    assert.equal(body.cwd, join(root, 'cwd'));
    assert.equal(body.full, 'x'.repeat(65536));
    const evidence = owner.readProcessEvidence();
    assert.equal(evidence.phase, 'terminal');
    assert.equal(evidence.wrapper.closed, true);
    assert.equal(evidence.wrapper.stdoutEof, true);
    assert.equal(evidence.wrapper.stderrEof, true);
    assert.equal(evidence.namespace?.treeStopped, true);
    assert.equal(evidence.namespace?.init.dead, true);
    assert.equal(evidence.namespace?.root?.dead, true);
    assert.equal(evidence.namespace?.root?.waitReceipt?.rawStatus, 7 * 256);
    assert.equal(evidence.fdClosed, true);
    assert.equal(evidence.closeUnknown, false);
  } catch (error) {
    failure = error;
    if (error instanceof LinuxOwnedProgramStartError) owner = error.cleanup;
  } finally {
    if (owner) {
      try {
        assert.equal((await owner.cancel()).confirmed, true);
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (!cleanup.length) rmSync(root, { recursive: true, force: true });
    else console.error('LINUX_STDIO_OWNER_RETAINED', root);
  }
  if (failure || cleanup.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanup],
      'linux_stdio_owner_qualification_failed',
    );
}
