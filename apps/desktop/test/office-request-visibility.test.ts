import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../electron/office-request-view.ts', import.meta.url), 'utf8');
const emitted = ts
  .transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  .outputText.replace(/^import[\s\S]*?;\n/gm, '')
  .replace(/^export /gm, '');
const Request = new Function(`${emitted}\nreturn NativeOfficeRequestView;`)();
test('request visibility waits for ready and hides without retiring pending input', () => {
  const request = new Request({}, { x: 0, y: 0, width: 1, height: 1 });
  const calls: boolean[] = [];
  request.view = {
    setVisible: (value: boolean) => calls.push(value),
    webContents: { isDestroyed: () => false },
  };
  request.visible(true);
  assert.deepEqual(calls, [false]);
  request.visible(false);
  request.ready = true;
  request.visible(request.shown);
  assert.equal(calls.at(-1), false);
  assert.equal(request.closed, false);
  request.visible(true);
  assert.equal(calls.at(-1), true);
  request.closed = true;
  const length = calls.length;
  request.visible(false);
  assert.equal(calls.length, length);
  request.closed = false;
  request.view.webContents.isDestroyed = () => true;
  request.visible(true);
  assert.equal(calls.length, length);
  assert.match(source, /this.ready = true;\s*this.visible\(this.shown\)/);
});
