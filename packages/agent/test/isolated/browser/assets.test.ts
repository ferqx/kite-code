import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { builtinCapability } from '../../../src/permissions/capabilities';
import {
  agentBrowserExecutableAsset,
  agentBrowserRuntimeAssets,
  agentBrowserVersion,
} from '../../../src/tools/browser/assets';

test('installed browser assets resolve exact pinned package without executing a browser', () => {
  const assets = agentBrowserRuntimeAssets();
  expect(assets).toHaveLength(3);
  expect(assets.every((path) => existsSync(path))).toBe(true);
  expect(agentBrowserExecutableAsset()).toBe(assets[1]!);
  expect(JSON.parse(readFileSync(assets[0]!, 'utf8')).version).toBe(agentBrowserVersion);
  expect(agentBrowserVersion).toBe('0.39.4');
});

test('browser process and website mutations never inherit safe read admission', () => {
  expect(builtinCapability('builtin.browser', 'browser.snapshot', 'tool', '', '1')).toEqual({
    effects: ['read'],
    safeRead: true,
  });
  expect(builtinCapability('builtin.browser', 'browser.open', 'tool', '', '1').effects).toContain(
    'process',
  );
  expect(builtinCapability('builtin.browser', 'browser.session', 'job', '', '1').effects).toContain(
    'network',
  );
  for (const id of [
    'browser.navigate',
    'browser.click',
    'browser.fill',
    'browser.scroll',
    'browser.close',
  ])
    expect(builtinCapability('builtin.browser', id, 'tool', '', '1').safeRead).toBe(false);
  for (const kind of ['tool', 'job', 'action'] as const) {
    expect(builtinCapability('foreign', 'browser.snapshot', kind, '', '1').safeRead).toBe(false);
    expect(builtinCapability('builtin.browser', 'browser.snapshot', kind, '', '2').safeRead).toBe(
      false,
    );
  }
});
