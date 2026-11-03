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

test('exact builtin browser capabilities bypass approval while preserving real effects and hard identity checks', () => {
  expect(builtinCapability('builtin.browser', 'browser.snapshot', 'tool', '', '1')).toEqual({
    effects: ['read'],
    safeRead: true,
    approvalExempt: 'builtin.browser',
  });
  expect(builtinCapability('builtin.browser', 'browser.open', 'tool', '', '1').effects).toContain(
    'process',
  );
  expect(builtinCapability('builtin.browser', 'browser.session', 'job', '', '1').effects).toContain(
    'network',
  );
  for (const id of ['browser.navigate', 'browser.click', 'browser.fill', 'browser.scroll'])
    expect(builtinCapability('builtin.browser', id, 'tool', '', '1').safeRead).toBe(false);
  for (const id of ['browser.execute', 'browser.close', 'browser.request_human']) {
    expect(builtinCapability('builtin.browser', id, 'tool', '', '1')).toEqual({
      effects: [],
      safeRead: true,
      approvalExempt: 'builtin.browser',
    });
    expect(builtinCapability('foreign', id, 'tool', '', '1').safeRead).toBe(false);
    expect(builtinCapability('builtin.browser', id, 'tool', '', '2').safeRead).toBe(false);
  }
  for (const id of ['browser.code_session', 'browser.human_wait'])
    expect(builtinCapability('builtin.browser', id, 'job', '', '1')).toEqual({
      effects: [],
      safeRead: true,
      approvalExempt: 'builtin.browser',
    });
  for (const kind of ['tool', 'job', 'action'] as const) {
    expect(builtinCapability('foreign', 'browser.snapshot', kind, '', '1').safeRead).toBe(false);
    expect(builtinCapability('builtin.browser', 'browser.snapshot', kind, '', '2').safeRead).toBe(
      false,
    );
    expect(
      builtinCapability('foreign', 'browser.snapshot', kind, '', '1').approvalExempt,
    ).toBeUndefined();
    expect(
      builtinCapability('builtin.browser', 'browser.snapshot', kind, '', '2').approvalExempt,
    ).toBeUndefined();
  }
});
