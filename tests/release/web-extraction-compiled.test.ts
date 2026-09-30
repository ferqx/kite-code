import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileOssReleaseExecutable } from '../../scripts/release/oss-candidate';

test('native release executable extracts passive HTML without runtime jsdom worker files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-compiled-web-'));
  try {
    const entrypoint = join(root, 'web.ts');
    const executable = join(root, process.platform === 'win32' ? 'web.exe' : 'web');
    writeFileSync(
      entrypoint,
      `
import { fetchAndExtract } from ${JSON.stringify(resolve('packages/builtin-runtime/src/web/extractor.ts'))};
import { JSDOM } from ${JSON.stringify(resolve('packages/builtin-runtime/node_modules/jsdom/lib/api.js'))};
const html = '<!doctype html><html><head><title>Compiled article</title></head><body><article><h1>Compiled article</h1><p>' +
  'Readable native release content with a <strong>bold phrase</strong> and <a href="/guide">guide</a>. '.repeat(12) +
  '</p><script>document.title="SCRIPT EXECUTED";fetch("https://unexpected.example.com")</script>' +
  '<script src="https://unexpected.example.com/script.js"></script>' +
  '<link rel="stylesheet" href="https://unexpected.example.com/style.css">' +
  '<iframe src="https://unexpected.example.com/frame"></iframe>' +
  '<img src="https://unexpected.example.com/image.png"></article></body></html>';
const calls = [];
globalThis.fetch = () => { throw new Error('Unexpected ungoverned fetch'); };
const transport = async (url) => {
  calls.push(String(url));
  return String(url).endsWith('/robots.txt')
    ? new Response('User-agent: *\\nDisallow:')
    : new Response(html, { headers: { 'content-type': 'text/html' } });
};
const result = await fetchAndExtract('https://compiled.example.com/article', { fetch: transport });
if (!result.ok) throw new Error(JSON.stringify(result));
if (result.title !== 'Compiled article' || !result.content.includes('**bold phrase**') ||
    !result.content.includes('https://compiled.example.com/guide') || result.content.includes('SCRIPT EXECUTED')) {
  throw new Error('Invalid extraction: ' + JSON.stringify(result));
}
if (calls.length !== 2) throw new Error('Unexpected extraction requests: ' + JSON.stringify(calls));
const dom = new JSDOM('<p>Passive parser</p>', { url: 'https://compiled.example.com' });
const xhr = new dom.window.XMLHttpRequest();
xhr.open('GET', 'https://unexpected.example.com', false);
let refused = false;
try { xhr.send(); } catch (error) {
  refused = error.message.includes('Synchronous XMLHttpRequest is unavailable');
}
dom.window.close();
if (!refused) throw new Error('Native synchronous XHR was not explicitly refused');
console.log(JSON.stringify({ title: result.title, calls, native: !import.meta.path.endsWith('.ts') }));
`,
    );
    await compileOssReleaseExecutable(entrypoint, executable);
    rmSync(entrypoint);
    const child = Bun.spawn([executable], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const deadline = setTimeout(() => child.kill(), 10_000);
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(deadline));
    expect(stderr).toBe('');
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ title: 'Compiled article', native: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
