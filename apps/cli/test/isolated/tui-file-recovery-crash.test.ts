import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFileRecoveryTUI, fileRecoveryProfile } from '../fixtures/file-recovery-profile';
import { runFileRecoveryPTY } from '../fixtures/file-recovery-pty';

const repo = resolve(import.meta.dir, '../../../..');
for (const window of ['before_post', 'between_legs'] as const)
  test(`80x24 compiled TUI SIGKILL ${window} reopens original journal and cold lookup only GET`, async () => {
    const f = await fileRecoveryProfile();
    try {
      const runner = join(f.root, 'tui.ts'),
        wire = join(f.root, 'wire'),
        marker = join(f.root, 'marker'),
        observations = join(f.root, 'recovery-observations');
      writeFileSync(
        runner,
        `import {appendFileSync,writeFileSync} from 'node:fs';
const actual=globalThis.fetch;
let observedView: unknown;
globalThis.fetch=Object.assign(async(...args:Parameters<typeof fetch>)=>{
  const opts=args[1],path=new URL(String(args[0])).pathname,body=opts?.body?JSON.parse(String(opts.body)):null;
  const request={method:opts?.method??'GET',path,body};
  appendFileSync(${JSON.stringify(wire)},JSON.stringify(request)+'\\n');
  if(process.env.WINDOW==='before_post'&&opts?.method==='POST'&&body?.kind==='extension.invoke'){
    writeFileSync(${JSON.stringify(marker)},'durable-submitting');
    await new Promise(()=>{});
  }
  const observed=observedView;
  const response=await actual(...args);
  if(path==='/v1/sessions/s/view'&&request.method==='GET'&&response.ok){
    const view=await response.clone().json();
    observedView={path,status:response.status,storeId:view.storeId,session:view.session};
  }else if((path==='/v1/sessions/s/reconcile'&&request.method==='POST')||(path.startsWith('/v1/commands/')&&request.method==='GET')){
    appendFileSync(${JSON.stringify(observations)},JSON.stringify({request,observed,status:response.status,response:await response.clone().json()})+'\\n');
  }
  return response;
},{preconnect:actual.preconnect});
import {runTUIHost} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/host/tui.tsx')).href)};
await runTUIHost({testDiagnostics:true,dataRoot:${JSON.stringify(f.profile.dataRoot)},profile:'owned',thread:'s',cwd:${JSON.stringify(f.workspace)},artifact:${JSON.stringify(f.artifact)},onLaunched:({pid})=>writeFileSync(${JSON.stringify(join(f.root, 'service.pid'))},String(pid),{mode:0o600})});`,
      );
      expect((await compileFileRecoveryTUI(f.root, runner)).success).toBe(true);
      const transcript = join(tmpdir(), `kite-file-recovery-crash-${randomUUID()}.pty.log`);
      const { code, out, err } = await runFileRecoveryPTY(f, { mode: window, transcript });
      if (code !== 0) console.error(err, 'PTY_TRANSCRIPT', transcript);
      expect(code).toBe(0);
      expect(out).toContain('TUI_ORIGINAL_COLD_ONLY_GET');
      expect(readFileSync(f.file, 'utf8')).toBe(
        window === 'before_post' ? 'actual changed bytes\r\n' : 'original bytes\r\n',
      );
      expect(f.calls()).toBe(3);
    } finally {
      f.close();
    }
  }, 80000);
