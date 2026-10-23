import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each process owns its mocks, real SQLite worker and Files resources. No user
// configuration, credentials or Provider are consulted by the replaced fixture.
const probe = `
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { basename } from 'node:path';
import * as agent from '@kite-ai/agent';
import * as sqlite from '@kite-ai/agent/sqlite';
import * as files from '@kite-ai/agent/files';
const actualFs = { ...fs }, actualAgent = { ...agent }, actualSqlite = { ...sqlite }, actualFiles = { ...files };
const mode = process.env.QUALITY_CLEANUP_CASE;
const closed = [], nestedCloses = [];
let closingRuntime = false;
let providerAttempts = 0;
globalThis.fetch = () => { providerAttempts++; throw Error('provider_forbidden_in_cleanup_test'); };
const requests = [];
const model = { async *stream(request) { requests.push(request); throw Error('isolated_model_failure_without_provider'); } };
const closeProxy = (target, name, overrides = {}) => new Proxy(target, { get(object, key) {
  if (Object.hasOwn(overrides, key)) return overrides[key];
  if (key === 'close') return async () => {
    // Runtime itself closes its Store; distinguish that nested real close from
    // the runner's defensive final Store close after Files.
    (closingRuntime ? nestedCloses : closed).push(name);
    if (name === 'runtime') closingRuntime = true;
    try { await object.close(); } finally { if (name === 'runtime') closingRuntime = false; }
    if (mode === 'close' && name === 'runtime') throw Error('injected_runtime_close_failure_after_real_close');
  };
  const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
}});
mock.module(new URL('../../e2e/live/model/live-model-fixture.ts', import.meta.url).href, () => ({
  createLiveModelFixture: async () => ({ model, modelId:'isolated', signal:AbortSignal.timeout(10000), requests, calls:[], usage:[], wire:[], metadata:{} }),
  summarizeLiveToolCalls: () => [],
}));
mock.module('node:fs', () => ({ ...actualFs, writeFileSync(path, ...args) {
  if (mode === 'evidence-write' && basename(String(path)) === 'original-requests.json') throw Error('injected_evidence_write_failure');
  return actualFs.writeFileSync(path, ...args);
}}));
mock.module('@kite-ai/agent/sqlite', () => ({ ...actualSqlite, async openSqliteStore(options) {
  const store = await actualSqlite.openSqliteStore(options);
  let observedTerminal = false;
  return closeProxy(store, 'store', { getView: async (...args) => {
    if (mode === 'evidence-read' && observedTerminal) throw Error('injected_evidence_read_failure');
    const view = await store.getView(...args);
    if (view.runs.some(run => !run.isActive && run.status !== 'completed')) observedTerminal = true;
    return view;
  }});
}}));
mock.module('@kite-ai/agent/files', () => ({ ...actualFiles,
  createWorkspaceFiles(options) {
    if (mode === 'files-setup') throw Error('injected_files_setup_failure');
    return closeProxy(actualFiles.createWorkspaceFiles(options), 'files');
  },
  createFileTools(...args) {
    if (mode === 'tools-setup') throw Error('injected_tools_setup_failure');
    return actualFiles.createFileTools(...args);
  },
}));
mock.module('@kite-ai/agent', () => ({ ...actualAgent, createRuntime(options) {
  if (mode === 'runtime-setup') throw Error('injected_runtime_setup_failure');
  return closeProxy(actualAgent.createRuntime(options), 'runtime');
}}));
const { runAgentTaskQualityTrial } = await import(new URL('../../e2e/live/model/agent-task-quality.live.ts', import.meta.url).href);
const result = await runAgentTaskQualityTrial({ scenario:'search', trial:1, evidenceRoot:process.env.QUALITY_CLEANUP_ROOT });
console.log(JSON.stringify({ result, closed, nestedCloses, providerAttempts }));
`;

for (const mode of [
  'evidence-write',
  'evidence-read',
  'close',
  'files-setup',
  'tools-setup',
  'runtime-setup',
]) {
  test(`task quality runner settles real resources after ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-quality-cleanup-'));
    try {
      // Resolve fixture URLs relative to this file, keeping the subprocess mock
      // entirely outside the live runner and its product-facing configuration.
      const script = probe.replaceAll('import.meta.url', JSON.stringify(import.meta.url));
      const child = Bun.spawn([process.execPath, '--eval', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KITE_RUN_LIVE_TASK_QUALITY: '1',
          QUALITY_CLEANUP_CASE: mode,
          QUALITY_CLEANUP_ROOT: join(root, 'trial'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      let budgetExpired = false;
      const budget = setTimeout(() => {
        budgetExpired = true;
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 12000);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(budgetExpired).toBe(false);
        expect(stderr).toBe('');
        expect(exitCode).toBe(0);
        const { result, closed, nestedCloses, providerAttempts } = JSON.parse(
          stdout.trim().split('\n').at(-1)!,
        );
        expect(result.status).toBe('failed');
        expect(result.manualReviewRequired).toBe(true);
        expect(providerAttempts).toBe(0);
        expect(closed).toEqual(
          mode === 'files-setup'
            ? ['store']
            : ['tools-setup', 'runtime-setup'].includes(mode)
              ? ['files', 'store']
              : ['runtime', 'files', 'store'],
        );
        expect(nestedCloses).toEqual(mode.endsWith('-setup') ? [] : ['store']);
        if (mode.startsWith('evidence-'))
          expect(result.evidenceErrors).toContain(`injected_${mode.replace('-', '_')}_failure`);
        if (mode === 'close')
          expect(result.cleanupErrors).toContain(
            'runtime: Error: injected_runtime_close_failure_after_real_close',
          );
        if (mode.endsWith('-setup'))
          expect(result.failure).toBe(`injected_${mode.replace('-', '_')}_failure`);
      } finally {
        // A leaked worker must fail this fixture without leaking its probe.
        clearTimeout(budget);
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
}
