import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../../../../..');
type Manifest = {
  name: string;
  version: string;
  exports: Record<string, string>;
  dependencies: Record<string, string>;
  scripts: { build: string };
};
async function run(args: string[], cwd: string): Promise<string> {
  const processHandle = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => processHandle.kill('SIGKILL'), 20000);
  try {
    const [exit, out, error] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    if (exit !== 0) throw new Error(`built_large_fixture_failed:${exit}:${error}`);
    return out;
  } finally {
    clearTimeout(timer);
    if (processHandle.exitCode === null) {
      processHandle.kill('SIGKILL');
      await processHandle.exited;
    }
  }
}
test('fresh complete package outside source runs large file and streamed Artifact operations without source fallback', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-built-large-')));
  const modules = join(root, 'node_modules');
  try {
    const manifests: Manifest[] = [];
    for (const name of ['agent', 'ai']) {
      const source = join(repository, 'packages', name);
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Manifest;
      manifests.push(manifest);
      const destination = join(modules, manifest.name);
      mkdirSync(destination, { recursive: true });
      for (const segment of manifest.scripts.build.split(/\s*&&\s*/)) {
        const words = segment.trim().split(/\s+/);
        if (words.shift() !== 'bun') throw new Error('unsupported_manifest_build');
        const args = words.map((word) =>
          word === 'dist' || word === './dist'
            ? destination
            : word.replace(/^--outdir=(?:\.\/)?dist$/, `--outdir=${destination}`),
        );
        const flag = args.indexOf('--outdir');
        if (flag >= 0) args[flag + 1] = destination;
        await run(args, source);
      }
      const exports = Object.fromEntries(
        Object.entries(manifest.exports).map(([key, path]) => [
          key,
          path.replace(/^\.\/src\//, './').replace(/\.ts$/, '.js'),
        ]),
      );
      writeFileSync(
        join(destination, 'package.json'),
        JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', exports }),
      );
      for (const path of Object.values(exports))
        expect(existsSync(join(destination, path))).toBe(true);
      expect(existsSync(join(destination, 'src'))).toBe(false);
    }
    for (const dependency of new Set(
      manifests.flatMap((manifest) => Object.keys(manifest.dependencies)),
    )) {
      if (dependency.startsWith('@kite-ai/')) continue;
      const installed = [
        join(repository, 'node_modules', dependency),
        join(repository, 'packages/agent/node_modules', dependency),
        join(repository, 'packages/ai/node_modules', dependency),
      ].find(existsSync);
      if (!installed) throw new Error(`missing_installed_dependency:${dependency}`);
      const destination = join(modules, dependency);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(realpathSync(installed), destination, 'dir');
    }
    const fixture = join(root, 'verify.mjs');
    writeFileSync(
      fixture,
      `
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const base=import.meta.dir;
const pkg=join(base,'node_modules/@kite-ai/agent');
const manifest=JSON.parse(readFileSync(join(pkg,'package.json'),'utf8'));
for(const key of Object.keys(manifest.exports)){const spec=key==='.'?'@kite-ai/agent':'@kite-ai/agent/'+key.slice(2);const resolved=Bun.resolveSync(spec,base);assert(resolved.startsWith(pkg+'/')&&!resolved.includes('/src/'));await import(spec);}
const {createRuntime}=await import('@kite-ai/agent');
const {createWorkspaceFiles,createFileTools}=await import('@kite-ai/agent/files');
const {openSqliteStore}=await import('@kite-ai/agent/sqlite');
const {createArtifactStore}=await import('@kite-ai/agent/artifacts');
const {createFixedModel}=await import('@kite-ai/ai');
const working=join(base,'working');mkdirSync(working);
const files=createWorkspaceFiles({root:working});
const body='start\\n'+'x'.repeat(9*1024*1024)+'\\nend\\n';
const written=await files.write({path:'large',content:body,base:null});assert.equal(written.content,body);assert.equal(written.baseline.hash,createHash('sha256').update(body).digest('hex'));
const store=await openSqliteStore({dataRoot:join(base,'data'),profile:'new'});const storeId=(await store.getMetadata()).storeId;
await store.createWorkspace({expectedStoreId:storeId,id:'w',name:'w',rootUri:'file://'+working});await store.createSession({expectedStoreId:storeId,sessionId:'s',commandId:'create',workspaceId:'w',title:'s',subjectId:'owner'});
const artifacts=createArtifactStore({profile:{dataRoot:join(base,'data'),profile:'new'},store});
const finish={type:'finish',reason:'stop',usage:{inputTokens:1,outputTokens:1}};
const model=createFixedModel([[{type:'tool_call',id:'call',name:'files.read',arguments:'{"path":"large"}'},{...finish,reason:'tool_calls'}],[finish]]);
const runtime=createRuntime({store,artifacts,model,modelId:'fixed',permissions:{async authorize(){return {allowed:true,revision:'p1'}}},extensions:[{id:'files',version:'2',apiMajor:1,tools:createFileTools(files)}]});
try{
 await runtime.submitCommand({expectedStoreId:storeId,commandId:'read',sessionId:'s',subjectId:'owner',request:{kind:'run.start',content:'complete large read'}});await runtime.waitForCommand('read');
 const execution=(await store.listExecutions('s')).find(x=>x.definitionId==='files.read');assert.equal(execution.status,'succeeded');assert.equal(execution.definitionVersion,'3');const ref=execution.result.artifactRefs[0];assert.equal(Buffer.from(await artifacts.read({expectedStoreId:storeId,sessionId:'s',subjectId:'owner',scope:ref.scope,refId:ref.id})).toString('utf8'),body);
 const chunk=Buffer.from('stream body\\n'.repeat(4096));let bytes=0;async function* stream(){for(let i=0;i<400;i++){bytes+=chunk.length;yield chunk;}}
 const streamInput={expectedStoreId:storeId,sessionId:'s',subjectId:'owner',scope:{kind:'session',id:'s'},refId:'stream',mediaType:'text/plain'};const streamed=await artifacts.publishStream({...streamInput,content:stream()});let count=0;for await(const part of artifacts.readStream(streamInput)){assert(part.length<=65536);count+=part.length;}assert.equal(count,bytes);assert(bytes>16*1024*1024);
 console.log(JSON.stringify({fileBytes:written.baseline.size,artifactBytes:streamed.size,modelCalls:model.requests.length,inlineBody:JSON.parse(execution.result.content).inlineBody}));
}finally{await runtime.close();await files.close();}
`,
    );
    const result = JSON.parse(await run([fixture], root)) as {
      fileBytes: number;
      artifactBytes: string;
      modelCalls: number;
      inlineBody: boolean;
    };
    expect(result.fileBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(BigInt(result.artifactBytes)).toBeGreaterThan(16n * 1024n * 1024n);
    expect(result.modelCalls).toBe(2);
    expect(result.inlineBody).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
