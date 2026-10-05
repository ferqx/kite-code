import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let bundle = '';
let runner = '';
let directory = '';
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'kite-browser-csp-'));
  const entry = join(directory, 'public-browser.ts');
  // Resolve the public package export, then bundle it; no private decode import or validator replacement.
  const publicEntry = fileURLToPath(import.meta.resolve('@kite-ai/client/browser'));
  writeFileSync(
    entry,
    `import { createBrowserClient } from ${JSON.stringify(publicEntry)}; globalThis.createPublicBrowserClient = createBrowserClient;`,
  );
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
  expect(build.success).toBe(true);
  if (!build.success) throw new Error('public_browser_bundle_failed');
  bundle = await build.outputs[0]!.text();
});
afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const identity = 'a'.repeat(64);
const serverInfo = {
  pageIdentity: identity,
  storeId: 'original',
  instanceId: 'instance',
  buildId: 'build',
  dataAvailability: 'available',
  capabilities: ['workspaces', 'sessions', 'history', 'context'],
  futureServer: { protocol: 'additive', retained: true },
};
const selected = {
  selection: {
    id: 'selected',
    sessionId: 's',
    previousSelectionId: null,
    boundaryMessageId: null,
    boundarySeq: '0',
    tailFromSeq: '0',
    ranges: [],
    futureSelection: { retained: true },
  },
  highWaterSeq: '9007199254740993',
  messages: [],
  resultSources: [],
  nextAfterSeq: null,
  nextAfterSourceId: null,
  snapshotCursor: '9223372036854775807',
  futurePage: ['retained'],
};
const nodeRunner = `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext,Script} from 'node:vm';
const bundle=readFileSync(process.argv[2],'utf8');
const {identity,serverInfo,selected}=JSON.parse(readFileSync(process.argv[3],'utf8'));
let checks=0;
const equal=(actual,expected)=>{assert.deepStrictEqual(actual && typeof actual==='object'?JSON.parse(JSON.stringify(actual)):actual,expected);checks++;};
async function errorCode(action){try{await action();return null;}catch(error){return error.code??'non-client-error';}}
function fixture(read=()=>[]){
 const requests=[];
 const transport=async(input,init={})=>{
  const url=new URL(String(input));requests.push({url,options:init});
  if(init.method!=='GET')throw new Error('CSP fixture permits only GET');
  return new Response(JSON.stringify(url.pathname.endsWith('/server')?serverInfo:read(url)),{headers:{'x-kite-web-identity':identity,'content-type':'application/json'}});
 };
 const context=createContext({URL,URLSearchParams,Headers,Response,Request,AbortController,DOMException,TextDecoder,TextEncoder,structuredClone},{codeGeneration:{strings:false,wasm:false}});
 assert.throws(()=>runInContext('eval("1")',context),{name:'EvalError'});checks++;
 assert.throws(()=>runInContext('Function("return 1")()',context),{name:'EvalError'});checks++;
 new Script(bundle,{filename:'actual-public-browser-bundle.js'}).runInContext(context);
 return {client:context.createPublicBrowserClient({origin:'https://same-origin.invalid',pageIdentity:identity,fetch:transport}),requests};
}
const mode=process.argv[4];
if(mode==='reads'){
 const workspace={id:'w',name:'Workspace',futureWorkspace:{retained:['all','fields']}};
 const f=fixture(url=>url.pathname.endsWith('/context')?selected:[workspace]);
 try{
  equal(await f.client.connect(),serverInfo);equal(f.client.serverInfo,serverInfo);
  equal(await f.client.listWorkspaces(),[workspace]);
  equal(await f.client.getContext('s',{contextSelectionId:'selected',afterSeq:'9007199254740993',upperSeq:'9223372036854775807'}),selected);
  equal(f.requests.length,3);
  const query=f.requests[2].url.searchParams;
  equal(query.get('afterSeq'),'9007199254740993');equal(query.get('upperSeq'),'9223372036854775807');equal(query.has('storeId'),false);
  equal(f.requests.every(({options})=>options.method==='GET'&&options.credentials==='same-origin'&&options.redirect==='error'&&!new Headers(options.headers).has('authorization')),true);
 }finally{f.client.disposeNetwork();}
}else if(mode==='closed'){
 let malformed=false;
 const f=fixture(()=>malformed?{...selected,selection:{...selected.selection,ranges:[{afterSeq:1,throughSeq:'2'}]}}:selected);
 try{
  await f.client.connect();const before=f.requests.length;
  equal(await errorCode(()=>f.client.getContext('s',{storeId:'forged'})),'invalid_request');
  equal(await errorCode(()=>f.client.getContext('s',{sourceLimit:101})),'invalid_request');equal(f.requests.length,before);
  malformed=true;equal(await errorCode(()=>f.client.getContext('s')),'invalid_response');equal(f.requests.length,before+1);
  malformed=false;equal(await f.client.getContext('s'),selected);equal(f.requests.every(({options})=>options.method==='GET'),true);
 }finally{f.client.disposeNetwork();}
}else if(mode==='nested'){
 let invalid=true;
 const f=fixture(()=>[{id:'w',name:invalid?{invalidNestedType:true}:'Workspace',futureField:{preserved:true}}]);
 try{
  await f.client.connect();equal(await errorCode(()=>f.client.listWorkspaces()),'invalid_response');invalid=false;
  equal(await f.client.listWorkspaces(),[{id:'w',name:'Workspace',futureField:{preserved:true}}]);equal(f.requests.length,3);equal(f.requests.every(({options})=>options.method==='GET'),true);
 }finally{f.client.disposeNetwork();}
}else{throw new Error('unknown CSP test mode');}
process.stdout.write(JSON.stringify({mode,checks,node:process.version}));
`;
async function runNode(mode: string, checks: number) {
  const executable = Bun.which('node');
  if (!executable) throw new Error('Actual Node/V8 is required for CSP qualification');
  if (!runner) {
    runner = join(directory, 'node-csp.mjs');
    writeFileSync(runner, nodeRunner);
    writeFileSync(join(directory, 'browser-bundle.js'), bundle);
    writeFileSync(
      join(directory, 'fixtures.json'),
      JSON.stringify({ identity, serverInfo, selected }),
    );
  }
  const child = Bun.spawn({
    cmd: [
      executable,
      runner,
      join(directory, 'browser-bundle.js'),
      join(directory, 'fixtures.json'),
      mode,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`CSP Node ${mode} failed: ${error}`);
  expect(JSON.parse(output)).toMatchObject({ mode, checks });
}
test('actual public browser bundle admits/reads under Node V8 codeGeneration disabled and retains additive fields', () =>
  runNode('reads', 11));
test('static browser query validators remain closed and malformed nested context is rejected under CSP', () =>
  runNode('closed', 9));
test('browser list validation retains nested types without runtime compilation', () =>
  runNode('nested', 6));
