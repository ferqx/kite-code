import { expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { chinesePagedPdf, simplePdf } from '../../../../tests/fixtures/pdf';

/** Execute only the candidate's public Files export and its real offline Worker. */
export async function verifyTerminalPdfAssets(input: {
  candidate: string;
  executable: string;
  scratch: string;
}): Promise<void> {
  privateDirectory(input.scratch);
  writeFileSync(join(input.scratch, 'simple.pdf'), simplePdf());
  writeFileSync(join(input.scratch, 'chinese.pdf'), chinesePagedPdf());
  const entry = join(input.scratch, 'probe.mjs');
  writeFileSync(
    entry,
    `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute,join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.argv[2];
const require=createRequire(join(root,'node_modules/@kite-ai/agent/package.json'));
const {pdfAssets}=await import(pathToFileURL(require.resolve('@kite-ai/agent/files')).href);
const assets=pdfAssets();
for(const path of [assets.worker,assets.checksum,...assets.dependencies]){
  const part=relative(root,path);
  assert(part && !isAbsolute(part) && part!=='..' && !part.startsWith('..\\\\') && !part.startsWith('../'));
}
const worker=new Worker(pathToFileURL(assets.worker).href,{type:'module'});
const read=(name,start,count,mode)=>new Promise((resolve,reject)=>{
  worker.onmessage=event=>resolve(event.data);
  worker.onerror=reject;
  worker.postMessage({bytes:new Uint8Array(readFileSync(new URL(name,import.meta.url))),start,count,mode});
});
const timeout=setTimeout(()=>{worker.terminate();throw Error('candidate_pdf_probe_timeout');},15000);
try{
  const simple=await read('simple.pdf',1,1,'text');
  assert.equal(simple.pages[0].text,'Hello PDF');
  const chinese=await read('chinese.pdf',1,1,'text');
  assert.equal(chinese.totalPages,2);
  assert.equal(chinese.pages[0].text,'中文');
  assert.equal(chinese.pages[0].label,'i');
  assert.equal(chinese.nextPage,2);
  const rendered=await read('chinese.pdf',2,1,'image');
  const png=Buffer.from(rendered.pages[0].image);
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),1024);
  assert.equal(png.readUInt32BE(20),2048);
  assert.equal(rendered.pages[0].label,'ii');
  assert.equal(rendered.nextPage,null);
  assert.equal((await read('simple.pdf',2,1,'text')).error,'pdf_page_out_of_range');
  assert.equal((await read('simple.pdf',1,1,'text')).pages[0].text,'Hello PDF');
  console.log('CANDIDATE_PDF_OFFLINE_TEXT_CMAP_ROTATED_PNG_RECOVERY');
}finally{
  clearTimeout(timeout);
  await worker.terminate();
}
`,
  );
  const child = Bun.spawn([input.executable, '--no-install', entry, input.candidate], {
    cwd: input.scratch,
    env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '', BUN_OPTIONS: '' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
  expect(stdout.trim()).toBe('CANDIDATE_PDF_OFFLINE_TEXT_CMAP_ROTATED_PNG_RECOVERY');
}
