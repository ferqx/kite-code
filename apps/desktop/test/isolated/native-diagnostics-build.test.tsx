import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { startDesktopRenderer } from '../../scripts/development-renderer';

const root = resolve(import.meta.dir, '../../../..');
const provider = resolve(import.meta.dir, '../../src/native-diagnostics.tsx');
const sharedDiagnostics = resolve(root, 'packages/ui/src/desktop/diagnostics.tsx');
const attempts = ['development', 'production', 'test'];

// The true build is a control: this must exercise the original context and hook,
// rather than pass because a fixture always renders the ordinary presentation.
const probe = `
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeDiagnosticsProvider, useNativeDiagnostics } from ${JSON.stringify(provider)};
function ReadMode() {
  return createElement('span', null, useNativeDiagnostics() ? 'test-detail' : 'ordinary');
}
export function render(enabled = true) {
  return renderToStaticMarkup(createElement(NativeDiagnosticsProvider, { enabled }, createElement(ReadMode)));
}
`;

function directory() {
  const cache = join(root, '.cache');
  mkdirSync(cache, { recursive: true });
  return mkdtempSync(join(cache, 'native-diagnostics-build-'));
}

function spoofedGlobals(environment: string) {
  const url = new URL('https://fixture.invalid/?testDiagnostics=true&debug=1&environment=test');
  return {
    process: {
      env: {
        NODE_ENV: environment,
        KITE_DESKTOP_TEST_DIAGNOSTICS: '1',
        __KITE_DESKTOP_TEST_DIAGNOSTICS__: 'true',
      },
    },
    __KITE_DESKTOP_TEST_DIAGNOSTICS__: true,
    location: url,
    window: { location: url },
  };
}

test('the real development renderer fixes diagnostics off despite explicit component opt-in', async () => {
  const temporary = directory();
  const entry = join(temporary, 'probe.tsx');
  writeFileSync(entry, probe);
  let renderer: Awaited<ReturnType<typeof startDesktopRenderer>> | undefined;
  const environment = process.env.NODE_ENV;
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__');
  try {
    // Spoofing the runtime global cannot replace the value compiled by Vite.
    Object.defineProperty(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__', {
      configurable: true,
      value: true,
    });
    renderer = await startDesktopRenderer(root);
    const loaded = (await renderer.server.ssrLoadModule(entry)) as {
      render(enabled: boolean): string;
    };
    expect(loaded.render(true)).toBe('<span>ordinary</span>');
    expect(loaded.render(false)).toBe('<span>ordinary</span>');
  } finally {
    if (previous) Object.defineProperty(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__', previous);
    else Reflect.deleteProperty(globalThis, '__KITE_DESKTOP_TEST_DIAGNOSTICS__');
    await renderer?.close();
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
    rmSync(temporary, { recursive: true, force: true });
  }
}, 20000);

test('the original provider compiled off resists runtime env, URL and prop overrides; an explicit test build still works', async () => {
  const temporary = directory();
  const entry = join(temporary, 'probe.tsx');
  writeFileSync(entry, probe);
  const environment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    for (const permitted of [false, true]) {
      const result = await build({
        configFile: false,
        plugins: [react()],
        logLevel: 'silent',
        // Only the two diagnostics exports are needed; both come from their real owner.
        resolve: { alias: [{ find: '@kite-ai/ui/desktop', replacement: sharedDiagnostics }] },
        define: { __KITE_DESKTOP_TEST_DIAGNOSTICS__: String(permitted) },
        build: {
          write: false,
          minify: false,
          lib: { entry, formats: ['iife'], name: 'DiagnosticsProbe' },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const script = outputs
        .flatMap((output) => ('output' in output ? output.output : []))
        .find((output) => output.type === 'chunk');
      if (script?.type !== 'chunk') throw Error('diagnostics_probe_bundle_missing');
      for (const environment of attempts) {
        const context = {
          ...spoofedGlobals(environment),
          MessageChannel,
          TextEncoder,
          TextDecoder,
          ReadableStream,
          TransformStream,
          setTimeout,
          clearTimeout,
          console,
        };
        const loaded = runInNewContext(`${script.code}\nDiagnosticsProbe`, context) as {
          render(enabled: boolean): string;
        };
        expect(loaded.render(true)).toBe(
          permitted ? '<span>test-detail</span>' : '<span>ordinary</span>',
        );
        expect(loaded.render(false)).toBe('<span>ordinary</span>');
      }
    }
  } finally {
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
    rmSync(temporary, { recursive: true, force: true });
  }
}, 20000);
