import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { type OfficeRunner, verifyOfficeRuntimeAssets } from './office-runtime';
export const officeRendererVersion = 'officecli-1.0.160';
// Internal rendering/cache identity; not a tool or wire-protocol version.
export const officePreviewRecipeVersion = 'offline-author-fonts';
export const officePreviewFontCss =
  '@font-face{font-family:KiteDocument;src:url("font.ttf") format("truetype");font-display:swap}';
export interface OfficePreviewManifest {
  entry: string;
  files: { path: string; absolutePath: string; mimeType: string; sha256: string; size: number }[];
  rendererVersion: string;
  recipeVersion: string;
}
const wordPaginationRuntime = `
(function(run){
  var root=document.documentElement, generation=0, state='pending', start=0, passes=0;
  var ticket=0, timeout=0, disposed=false, waiting=false, verifying=false;
  function mark(value){state=value;root.setAttribute('data-kite-word-pagination-state',value);root.setAttribute('data-kite-word-pagination-generation',String(generation));}
  function unavailable(){disposed=true;clearTimeout(timeout);mark('unavailable');}
  function current(g){return !disposed&&g===generation;}
  function resources(){
    var fonts=document.fonts;
    var images=Array.from(document.images);
    return Promise.all([
      fonts?fonts.ready:Promise.resolve(),
      ...images.map(function(img){if(img.complete)return Promise.resolve();return new Promise(function(resolve){img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true});});})
    ]);
  }
  function invalidate(){
    if(disposed)return;
    if(state!=='pending'||!start)start=performance.now();
    generation++;passes=0;verifying=false;mark('pending');clearTimeout(timeout);
    timeout=setTimeout(unavailable,Math.max(0,15000-(performance.now()-start)));
    var g=generation;waiting=true;
    resources().then(function(){
      if(!current(g))return;
      waiting=false;
      requestAnimationFrame(function(){if(current(g)){ticket=g;run();}});
    },function(){if(current(g))unavailable();});
  }
  function step(){
    if(window._wpSync){unavailable();return true;}
    if(disposed||waiting||ticket!==generation)return false;
    if(++passes>256||performance.now()-start>15000||document.querySelectorAll('.page').length>500){unavailable();return false;}
    return true;
  }
  function next(fn){
    if(window._wpSync){fn();return;}
    var g=ticket;
    setTimeout(function(){if(current(g)&&ticket===g)fn();},0);
  }
  function finish(g){
    if(window._wpSync)return;
    if(!current(g))return;
    // The preceding final-pass tasks and scale execute before this resource/frame barrier.
    resources().then(function(){requestAnimationFrame(function(){requestAnimationFrame(function(){
      if(!current(g)||waiting)return;
      if(document.fonts&&document.fonts.status!=='loaded'){invalidate();return;}
      if(document.querySelectorAll('.page').length>500){unavailable();return;}
      clearTimeout(timeout);start=0;mark('settled');
    });});},function(){if(current(g))unavailable();});
  }
  function final(fn){
    var g=ticket;
    setTimeout(function(){if(current(g)&&ticket===g){fn();observer.takeRecords();verifying=true;finish(g);}},0);
  }
  var observer=new MutationObserver(function(changes){
    if(state!=='settled'&&!verifying)return;
    if(changes.some(function(change){
      var el=change.target.nodeType===1?change.target:change.target.parentElement;
      if(el&&el.closest('.page'))return true;
      return change.type==='childList'&&Array.from(change.addedNodes).concat(Array.from(change.removedNodes)).some(function(node){return node.nodeType===1&&(node.matches('.page,.page-wrapper')||node.querySelector('.page,.page-wrapper'));});
    }))invalidate();
  });
  observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['src','style','class','width','height']});
  window.addEventListener('resize',invalidate);
  document.addEventListener('load',function(e){if(e.target instanceof HTMLImageElement)invalidate();},true);
  document.addEventListener('error',function(e){if(e.target instanceof HTMLImageElement)invalidate();},true);
  if(document.fonts){document.fonts.addEventListener('loading',invalidate);document.fonts.addEventListener('loadingdone',invalidate);document.fonts.addEventListener('loadingerror',invalidate);}
  window.addEventListener('pagehide',function(){disposed=true;clearTimeout(timeout);observer.disconnect();},{once:true});
  mark('pending');
  return {start:invalidate,step:step,next:next,final:final};
})(function(){paginate();})
`;

/** Exact locked Word renderer anchors. Missing/ambiguous recipes keep preview, not page authority. */
function wordPaginationHtml(html: string) {
  const replacements: [string, string][] = [
    [
      'function _wordInit(){',
      `function _wordInit(){var _kiteWordPagination=${wordPaginationRuntime};`,
    ],
    ['function paginate(){', 'function paginate(){if(!_kiteWordPagination.step())return;'],
    [
      'if(again){if(window._wpSync)paginate();else setTimeout(paginate,0);}',
      'if(again){_kiteWordPagination.next(paginate);}',
    ],
    [
      'else{setTimeout(positionFootnotes,0);setTimeout(wrapFloats,0);setTimeout(applyLineNumbers,0);setTimeout(applyPageFilter,0);setTimeout(function(){scalePages(false);},0);}',
      'else{_kiteWordPagination.final(function(){positionFootnotes();wrapFloats();applyLineNumbers();applyPageFilter();scalePages(false);});}',
    ],
    [
      'window._wordPaginate=function(){renderNewContent();setTimeout(paginate,0);};',
      'window._wordPaginate=function(){renderNewContent();_kiteWordPagination.start();};',
    ],
    ['_resizeTimer=setTimeout(function(){scalePages(true);},100);', '_resizeTimer=0;'],
    ['}else{setTimeout(paginate,100);}', '}else{_kiteWordPagination.start();}'],
  ];
  const valid =
    Buffer.byteLength(html) <= 32 * 1024 * 1024 &&
    replacements.every(([anchor]) => html.split(anchor).length === 2);
  let result = html;
  if (valid)
    for (const [anchor, replacement] of replacements) result = result.replace(anchor, replacement);
  return result.replace(
    /<head([^>]*)>/i,
    `<head$1><script>document.documentElement.setAttribute('data-kite-word-pagination-state','${valid ? 'pending' : 'unavailable'}');document.documentElement.setAttribute('data-kite-word-pagination-generation','0');</script>`,
  );
}

/** Fixed upstream renderer recipe, not a general HTML sanitizer. The isolated viewer enforces CSP/network denial. */
export function offlineOfficeHtml(html: string, word = false) {
  if (word) html = wordPaginationHtml(html);
  let result = html
    .replaceAll('https://d.officecli.ai/assets/katex-0.16.11/', 'katex/')
    .replaceAll('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/', 'katex/')
    .replaceAll('https://d.officecli.ai/fonts/css2?', 'font.css?')
    .replaceAll('https://fonts.googleapis.com/css2?', 'font.css?');
  // No 3D engine is bundled. Keep authored fallback images/text and name the limitation.
  result = result.replace(
    /<script\b[^>]*src=["'][^"']*(?:three(?:\.min)?\.js|three@)[^"']*["'][^>]*>\s*<\/script>/gi,
    '',
  );
  result = result.replace(/<script\b[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi, '');
  result = result.replace(
    /<script\b[^>]*type=["']module["'][^>]*>[\s\S]*?<\/script>/gi,
    (script) =>
      /(?:from\s*["']three|import\s*\(["']three)/.test(script)
        ? '<!-- Complex 3D unavailable in offline preview. -->'
        : script,
  );
  const notice =
    '<details role="note" style="position:fixed;top:8px;right:8px;z-index:10000;max-width:calc(100vw - 16px);padding:6px;border-radius:4px;background:#fff;color:#222;box-shadow:0 1px 5px #0004;font:12px sans-serif"><summary style="cursor:pointer">Kite 离线预览说明</summary>排版可能与 Office 不同；复杂 3D 与动画不受支持。</details>';
  return result
    .replace(/<head([^>]*)>/i, '<head$1><link rel="stylesheet" href="font.css">')
    .replace(/<body([^>]*)>/i, `<body$1>${notice}`);
}
/** Caller supplies an existing host-owned process runner. No model call, Shell tool or network request. */
export async function renderOfficePreview(input: {
  sourcePath: string;
  /** Trusted verified installation path, needed when embedded in Electron main.cjs. */
  assetsRoot?: string;
  outputDirectory: string;
  signal: AbortSignal;
  run: OfficeRunner;
}): Promise<OfficePreviewManifest> {
  input.signal.throwIfAborted();
  if (!['.docx', '.xlsx', '.pptx'].includes(extname(input.sourcePath).toLowerCase()))
    throw Error('office_preview_format_invalid');
  const info = await lstat(input.sourcePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024)
    throw Error('office_preview_source_invalid');
  const assets = await verifyOfficeRuntimeAssets(input.assetsRoot);
  await mkdir(input.outputDirectory, { recursive: false, mode: 0o700 });
  const entry = join(input.outputDirectory, 'index.html');
  const result = await input.run(['view', input.sourcePath, 'html', '-o', entry], input.signal);
  input.signal.throwIfAborted();
  if (result.code !== 0) throw Error('office_preview_conversion_failed');
  const htmlInfo = await lstat(entry);
  if (!htmlInfo.isFile() || htmlInfo.isSymbolicLink() || htmlInfo.size > 32 * 1024 * 1024)
    throw Error('office_preview_output_invalid');
  await writeFile(
    entry,
    offlineOfficeHtml(
      await readFile(entry, 'utf8'),
      extname(input.sourcePath).toLowerCase() === '.docx',
    ),
  );
  await cp(assets.previewAssets, join(input.outputDirectory, 'katex'), { recursive: true });
  await copyFile(assets.font, join(input.outputDirectory, 'font.ttf'));
  await writeFile(join(input.outputDirectory, 'font.css'), officePreviewFontCss);
  const files: OfficePreviewManifest['files'] = [];
  let total = 0;
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  async function visit(root: string, prefix = '') {
    for (const item of await readdir(root, { withFileTypes: true })) {
      input.signal.throwIfAborted();
      const path = prefix + item.name,
        absolutePath = join(root, item.name);
      if (item.isSymbolicLink()) throw Error('office_preview_link_denied');
      if (item.isDirectory()) await visit(absolutePath, `${path}/`);
      else {
        const stat = await lstat(absolutePath);
        total += stat.size;
        if (
          !stat.isFile() ||
          stat.size > 32 * 1024 * 1024 ||
          total > 96 * 1024 * 1024 ||
          files.length >= 256
        )
          throw Error('office_preview_budget_exceeded');
        const mimeType = types[extname(path).toLowerCase()];
        // Source maps and KaTeX package metadata are not served.
        if (!mimeType) continue;
        const bytes = await readFile(absolutePath);
        files.push({
          path,
          absolutePath,
          mimeType,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  await visit(input.outputDirectory);
  return {
    entry: 'index.html',
    files,
    rendererVersion: officeRendererVersion,
    recipeVersion: officePreviewRecipeVersion,
  };
}
