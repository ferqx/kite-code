import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Evaluate the actual class without Electron/Office imports. Only bounds() is invoked;
// conversion and native-view creation remain covered by the real Electron fixture.
const source = readFileSync(new URL('../electron/output-preview.ts', import.meta.url), 'utf8');
const emitted = ts
  .transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  .outputText.replace(/^import[\s\S]*?;\n/gm, '')
  .replace(/^export /gm, '');
const Preview = new Function(`${emitted}\nreturn NativeOutputPreview;`)() as new () => {
  active?: { id: string; bounds: Rect; view?: { setBounds(bounds: Rect): void } };
  bounds(id: string, bounds: Rect): void;
};
type Rect = { x: number; y: number; width: number; height: number };

test('pending conversion retains latest bounds for the eventual native view', () => {
  const preview = new Preview();
  const initial = { x: 0, y: 0, width: 400, height: 600 };
  preview.active = { id: 'current', bounds: initial };
  const latest = { x: 700, y: 80, width: 500, height: 640 };
  preview.bounds('current', latest);
  latest.x = -1;
  assert.deepEqual(preview.active.bounds, { x: 700, y: 80, width: 500, height: 640 });
  preview.bounds('old', initial);
  assert.equal(preview.active.bounds.x, 700);
  // Guard the exact initialization site that previously reused input.bounds.
  assert.match(source, /view\.setBounds\(active\.bounds\)/);
  assert.doesNotMatch(source, /view\.setBounds\(input\.bounds\)/);
  const applied: Rect[] = [];
  preview.active.view = {
    setBounds: (bounds) => {
      applied.push(bounds);
    },
  };
  preview.bounds('current', { ...initial, x: 800 });
  assert.equal(preview.active.bounds.x, 800);
  assert.deepEqual(applied, [preview.active.bounds]);
});

test('native view remains hidden until load, interaction install and initial controls finish', () => {
  const steps = [
    'view.setVisible(false)',
    'addNativeWindowView(input.window, view)',
    'await view.webContents.loadURL',
    'officeInteractionInstallScript(officeKind)',
    'const initialControls = input.initialControls ?? []',
    'for (const command of initialControls)',
    'officeInteractionControlScript(command)',
    'view.setVisible(true)',
    "return { kind: 'outputs.preview' as const, status: 'ready' as const }",
  ].map((step) => source.indexOf(step));
  assert.ok(steps.every((position) => position >= 0));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i]! > steps[i - 1]!);
  assert.match(source, /current\(\);\s*view\.setVisible\(true\)/);
  assert.equal(source.match(/view\.setVisible\(true\)/g)?.length, 1);
  assert.match(source, /initialControls\.length > 4/);
});
