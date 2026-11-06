import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistentWorktreeDirectory } from '../../fixtures/worktree-filesystem';

const helper = new URL('../../e2e/live/model/git-worktree-native-preflight.ts', import.meta.url)
  .href;

async function probe(root: string, body: string) {
  const fixtureHome = `${root}.home`;
  expect(existsSync(fixtureHome)).toBe(false);
  const driver = join(root, 'driver.ts');
  writeFileSync(
    driver,
    `
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runGitWorktreeNativePreflight } from ${JSON.stringify(helper)};
const root = ${JSON.stringify(root)};
const fixtureHome = ${JSON.stringify(fixtureHome)};
assert.equal(homedir(), fixtureHome);
if (!existsSync(fixtureHome)) mkdirSync(fixtureHome, { mode: 0o700 });
chmodSync(fixtureHome, 0o700);
for (const name of ['source', 'control', 'evidence']) mkdirSync(join(root, name), { mode: 0o700 });
${body}
`,
    { mode: 0o600 },
  );
  const child = Bun.spawn([process.execPath, driver], {
    env: { ...process.env, HOME: fixtureHome, USERPROFILE: fixtureHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  writeFileSync(
    join(root, 'driver-output.json'),
    JSON.stringify({ code, stdout, stderr }, null, 2),
    {
      mode: 0o600,
    },
  );
  expect(code, `${root}\n${stdout}\n${stderr}`).toBe(0);
  return JSON.parse(readFileSync(join(root, 'native-preflight/report.json'), 'utf8'));
}

for (const reasonKind of ['error', 'null'] as const)
  test.skipIf(process.platform !== 'darwin')(
    `native worktree preflight preserves ${reasonKind} cancellation after original stop through capture and close`,
    async () => {
      const root = persistentWorktreeDirectory(`kite-native-preflight-cancel-${reasonKind}-`);
      const built = await Bun.build({
        entrypoints: [
          fileURLToPath(
            new URL(
              '../../../packages/agent/src/platform/process/shell-supervisor.ts',
              import.meta.url,
            ),
          ),
        ],
        outdir: join(root, 'assets'),
        naming: 'shell-supervisor.js',
        target: 'bun',
      });
      expect(built.success).toBe(true);
      const report = await probe(
        root,
        `
const controller = new AbortController();
const reason = ${reasonKind === 'null' ? 'null' : "new Error('native-preflight-cancel-after-persisted-original-stop')"};
const reportPath = join(root, 'native-preflight/report.json');
let observation;
const pending = runGitWorktreeNativePreflight({
  root, source: join(root, 'source'), control: join(root, 'control'), fixtureHome,
  supervisorPath: ${JSON.stringify(built.outputs[0]!.path)}, signal: controller.signal,
});
const observe = () => {
  if (controller.signal.aborted) return;
  let report;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return; }
  if (report.originalStopConfirmed === true && report.status === 'running' && report.closeConfirmed === false) {
    observation = {
      observedAt: new Date().toISOString(), status: report.status,
      originalStopConfirmed: report.originalStopConfirmed,
      closeConfirmed: report.closeConfirmed, coldReadConfirmed: report.coldReadConfirmed ?? false,
      jobIds: report.executions.filter(row => row.kind === 'job').map(row => row.id),
    };
    controller.abort(reason);
  }
};
const watcher = watch(join(root, 'native-preflight'), observe);
const polling = setInterval(observe, 1);
let rejected;
try { await pending; } catch (error) { rejected = error; }
finally { watcher.close(); clearInterval(polling); }
assert(observation, 'cancellation timing was not proven; retain this original fixture without retry');
assert.equal(rejected, reason, 'the original cancellation reason must be thrown');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
assert.equal(report.status, 'failed');
assert.equal(report.originalStopConfirmed, true);
assert.equal(report.closeConfirmed, true);
assert.equal(report.coldReadConfirmed, true);
assert.equal(report.coldSafety.quiescent, true);
assert.equal(report.providerRequests, 0);
assert.equal(report.gitCommands, 0);
assert.equal(report.executions.filter(row => row.kind === 'job').length, 1);
assert(report.errors.some(error => error.phase === 'cancelled-after-close'));
writeFileSync(join(root, 'cancel-observation.json'), JSON.stringify({
  observation, reasonKind: ${JSON.stringify(reasonKind)}, originalCancellationThrown: rejected === reason,
  failedAfterClose: true, closeConfirmed: report.closeConfirmed,
  coldReadConfirmed: report.coldReadConfirmed, quiescent: report.coldSafety.quiescent,
  providerRequests: 0, gitCommands: 0,
}, null, 2) + '\\n', { mode: 0o600 });
`,
      );
      expect(report).toMatchObject({
        status: 'failed',
        closeConfirmed: true,
        coldReadConfirmed: true,
        originalStopConfirmed: true,
        gitCommands: 0,
        providerRequests: 0,
      });
      expect(report.dispatches).toHaveLength(1);
      expect(report.dispatches[0].scope).toEqual({
        filesystem: 'workspace_write',
        network: 'none',
      });
      const observed = JSON.parse(readFileSync(join(root, 'cancel-observation.json'), 'utf8'));
      expect(observed.observation).toMatchObject({
        status: 'running',
        originalStopConfirmed: true,
        closeConfirmed: false,
        coldReadConfirmed: false,
      });
      expect(observed.originalCancellationThrown).toBe(true);
    },
    30_000,
  );

test.skipIf(process.platform !== 'darwin')(
  'native worktree preflight retains a missing-asset failure before any Execution',
  async () => {
    const root = persistentWorktreeDirectory('kite-native-preflight-missing-asset-');
    const report = await probe(
      root,
      `
await assert.rejects(runGitWorktreeNativePreflight({
  root, source: join(root, 'source'), control: join(root, 'control'), fixtureHome,
  supervisorPath: join(root, 'missing-supervisor.js'), signal: new AbortController().signal,
}), /git_worktree_native_preflight_failed/);
const report = JSON.parse(readFileSync(join(root, 'native-preflight/report.json'), 'utf8'));
assert.equal(report.status, 'failed');
assert.equal(report.closeConfirmed, true);
assert.equal(report.providerRequests, 0);
assert.equal(report.gitCommands, 0);
assert.equal(report.executions, undefined);
assert.equal(report.errors.length, 1);
`,
    );
    expect(report).toMatchObject({
      status: 'failed',
      closeConfirmed: true,
      providerRequests: 0,
      gitCommands: 0,
    });
    expect(report.executions).toBeUndefined();
    expect(report.errors).toHaveLength(1);
  },
  30_000,
);
