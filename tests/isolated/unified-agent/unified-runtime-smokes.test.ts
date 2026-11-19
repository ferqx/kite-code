import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseUnifiedMcpSmoke,
  runUnifiedMcpSmoke,
} from '../../../scripts/runtime/unified-mcp-smoke';
import {
  parseSessionLogAclArgs,
  runUnifiedSessionLogAcl,
} from '../../../scripts/runtime/unified-session-log-acl';
import { privateDirectory } from '../../fixtures/test-filesystem';

test('owned MCP smoke crosses the public Service, preserves tool outcomes and closes its peers', async () => {
  expect(parseUnifiedMcpSmoke([])).toBeNull();
  const evidence = await runUnifiedMcpSmoke();
  expect(evidence.status, String(evidence.reason)).toBe('passed');
  expect(evidence.cleanup).toBe('confirmed');
  expect(evidence.modelRequests).toBe(5);
  expect(evidence.toolExecutions).toMatchObject([
    { source: 'alpha', outcome: 'succeeded' },
    { source: 'beta', outcome: 'succeeded' },
    { source: 'alpha', outcome: 'failed' },
    { source: 'alpha', outcome: 'outcome_unknown' },
  ]);
}, 60000);
test('smoke argument refusal occurs before filesystem creation or network admission', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-smoke-argv-'));
  const absent = join(root, 'absent');
  try {
    for (const args of [
      ['--endpoint=https://example.com'],
      ['--output=relative'],
      [`--output=${absent}`, '--force'],
      ['--output='],
    ]) {
      expect(() => parseUnifiedMcpSmoke(args)).toThrow();
      expect(() => parseSessionLogAclArgs(args)).toThrow();
    }
    expect(existsSync(absent)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('actual native private SQLite session log and cold observer preserve original identities', async () => {
  const evidence = await runUnifiedSessionLogAcl();
  if (
    process.platform === 'darwin' ||
    process.platform === 'linux' ||
    (process.platform === 'win32' && process.arch === 'x64')
  ) {
    expect(evidence.status).toBe('passed');
    expect(evidence.qualified).toBe(true);
    if (evidence.status !== 'passed' || !evidence.sqlite || !evidence.objectIds || !evidence.checks)
      throw Error(JSON.stringify(evidence));
    expect(evidence.driver).toBe('bun:sqlite');
    expect(evidence.sqlite.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(evidence.sqlite.sourceId.length).toBeGreaterThan(10);
    expect(evidence.objectIds).toContain('original-work');
    expect(evidence.checks).toContain('cold_original_ids_fixed_upper');
    expect(evidence.checks).toContain('hardlink_rejected');
    expect(evidence.checks).toContain('foreign_store_and_subject_rejected');
    expect(evidence.checks).toContain(
      process.platform === 'win32'
        ? 'private_native_windows_owner_dacl_identity'
        : 'private_posix_owner_modes',
    );
    expect(evidence.checks).toContain(
      process.platform === 'win32' ? 'profile_junction_rejected' : 'profile_symlink_rejected',
    );
    expect(evidence.checks).toContain(
      process.platform === 'win32'
        ? 'broadened_dacl_rejected_without_repair'
        : 'public_mode_rejected_without_repair',
    );
    expect(evidence.cleanup).toBe('confirmed');
  } else {
    expect(evidence.status).toBe('unsupported');
    expect(evidence.qualified).toBe(false);
  }
}, 30000);

// The two new scripts must resolve the emitted public package graph, including
// SQLite Worker/engine assets, rather than falling back to repository TypeScript.
test('source-free runtime smokes use the candidate Bun and actual public SQLite assets', async () => {
  const { buildTerminalBundle } = await import('../../../scripts/release/terminal-bundle');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-runtime-smokes-built-')));
  const repository = resolve(import.meta.dir, '../../..');
  async function child(argv: string[], cwd: string, home: string, expectedCode = 0) {
    const process = Bun.spawn(argv, {
      cwd,
      env: { HOME: home, PATH: globalThis.process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => process.kill('SIGKILL'), 30000);
    try {
      const [code, out, error] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      if (code !== expectedCode) throw Error(`built_runtime_smoke_failed:${code}:${error}`);
      return out;
    } finally {
      clearTimeout(timer);
      if (process.exitCode === null) {
        process.kill('SIGKILL');
        await process.exited;
      }
    }
  }
  try {
    const candidate = await buildTerminalBundle({
      destination: join(root, 'candidate'),
      repositoryRoot: repository,
    });
    const app = join(root, 'app'),
      home = join(root, 'home');
    privateDirectory(app);
    privateDirectory(home);
    symlinkSync(
      join(candidate.root, 'node_modules'),
      join(app, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await child(
      [
        process.execPath,
        'build',
        join(repository, 'scripts/runtime/unified-session-log-acl.ts'),
        join(repository, 'scripts/runtime/unified-mcp-smoke.ts'),
        '--target=bun',
        '--packages=external',
        `--outdir=${app}`,
      ],
      repository,
      home,
    );
    const acl = JSON.parse(
      await child(
        [join(candidate.root, 'runtime/bun'), join(app, 'unified-session-log-acl.js')],
        app,
        home,
        process.platform === 'win32' && process.arch !== 'x64' ? 1 : 0,
      ),
    );
    if (
      process.platform === 'darwin' ||
      process.platform === 'linux' ||
      (process.platform === 'win32' && process.arch === 'x64')
    ) {
      expect(acl.status).toBe('passed');
      expect(acl.qualified).toBe(true);
      expect(acl.objectIds).toContain('original-work');
      expect(acl.sqlite.sourceId).toBeString();
      expect(acl.sqlite.version).toBe(candidate.manifest.sqlite.version);
      expect(acl.sqlite.sourceId).toBe(candidate.manifest.sqlite.sourceId);
      expect(acl.sqlite.manifestSha256).toBe(candidate.manifest.sqlite.manifestSha256);
    } else {
      expect(acl.status).toBe('unsupported');
      expect(acl.qualified).toBe(false);
    }
    const mcp = JSON.parse(
      await child(
        [join(candidate.root, 'runtime/bun'), join(app, 'unified-mcp-smoke.js')],
        app,
        home,
      ),
    );
    expect(mcp.status).toBe('passed');
    expect(mcp.cleanup).toBe('confirmed');
    expect(mcp.transport).toBe('streamable-http');
    expect(mcp.toolExecutions).toHaveLength(4);
    expect(existsSync(join(candidate.root, 'node_modules/@kite-ai/agent/src'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test('actual entrypoint invalid argv exits nonzero before creating evidence or profiles', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-runtime-smokes-invalid-')));
  try {
    for (const script of ['unified-mcp-smoke.ts', 'unified-session-log-acl.ts']) {
      const output = join(root, `${script}.json`);
      const owned = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, '../../../scripts/runtime', script),
          `--output=${output}`,
          '--force',
        ],
        {
          cwd: root,
          env: {
            HOME: root,
            PATH: process.env.PATH ?? '',
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const timer = setTimeout(() => owned.kill('SIGKILL'), 10000);
      try {
        const [code, out, error] = await Promise.all([
          owned.exited,
          new Response(owned.stdout).text(),
          new Response(owned.stderr).text(),
        ]);
        expect(code).not.toBe(0);
        expect(out).toBe('');
        expect(error).toContain('arguments_invalid');
        expect(existsSync(output)).toBe(false);
        expect(readdirSync(root)).toEqual([]);
      } finally {
        clearTimeout(timer);
        if (owned.exitCode === null) {
          owned.kill('SIGKILL');
          await owned.exited;
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'MCP JUnit requires actual assertions from every owner and the native stdio case on macOS',
  () => {
    const script = resolve(import.meta.dir, '../../../scripts/ci/verify-mcp-junit.py');
    const root = mkdtempSync(join(tmpdir(), 'kite-mcp-junit-'));
    try {
      const owner = 'apps/service/test/isolated/mcp-resources-prompts.test.ts';
      const native =
        'default stdio resources/prompts use real original live connection, complete low-trust Model body and ordinary records';
      const original = `<testsuites failures="0"><testsuite file="${owner}" failures="0"><testcase name="http" assertions="4"/><testcase name="${native}" assertions="1"/></testsuite></testsuites>`;
      const check = (xml: string, host: string) => {
        writeFileSync(join(root, 'report.xml'), xml);
        return Bun.spawnSync(
          [
            'python3',
            '-c',
            "import runpy,sys; runpy.run_path(sys.argv[1])['verify'](sys.argv[2], [sys.argv[3]], sys.argv[4])",
            script,
            join(root, 'report.xml'),
            owner,
            host,
          ],
          { stdout: 'ignore', stderr: 'ignore' },
        ).exitCode;
      };
      expect(check(original, 'darwin')).toBe(0);
      const skipped = original.replace('assertions="1"/>', 'assertions="0"><skipped/></testcase>');
      expect(check(skipped, 'linux')).toBe(0);
      expect(check(skipped, 'darwin')).not.toBe(0);
      for (const xml of [
        '',
        '<broken',
        '<testsuites/>',
        skipped.replace('assertions="4"', 'assertions="0"'),
        skipped.replace(owner, 'other.test.ts'),
        original.replace(native, 'other case'),
        original.replace('assertions="4"/>', 'assertions="0"><skipped/></testcase>'),
        original.replace('assertions="4"/>', 'assertions="0"><failure/></testcase>'),
      ])
        expect(check(xml, 'linux')).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
