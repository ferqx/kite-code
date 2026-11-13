import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '#kite-test';
import { build as buildFixture } from '../../../../scripts/tooling/build';
import {
  which as findFixtureExecutable,
  spawn as spawnFixtureProcess,
} from '../../../../scripts/tooling/process';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';

test('bundled Native MCP validation runs in actual Node without source modules or loose UMD requires', async () => {
  const root = temporaryDirectory('kite-native-mcp-input-node-');
  try {
    const entry = join(root, 'entry.ts');
    const parser = resolve(import.meta.dirname, '../../electron/mcp-input.ts');
    writeFileSync(
      entry,
      `
      import assert from 'node:assert/strict';
      import {parseNativeUserMcpOperation} from ${JSON.stringify(parser)};
      const operation = {kind:'add',name:'memory',entry:{type:'stdio',command:'npx',args:['-y','@modelcontextprotocol/server-memory']}};
      assert.deepEqual(parseNativeUserMcpOperation(operation), operation);
      assert.throws(()=>parseNativeUserMcpOperation({...operation,entry:{type:'http',url:'invalid'}}));
      assert.equal(typeof Bun,'undefined');
      console.log('native_mcp_node_validated');
    `,
    );
    const built = await buildFixture({
      entrypoints: [entry],
      target: 'node',
      format: 'cjs',
      outdir: root,
      naming: 'parser.cjs',
    });
    expect(built.success).toBe(true);
    const isolated = join(root, 'empty');
    mkdirSync(isolated);
    const node = findFixtureExecutable('node');
    expect(node).not.toBeNull();
    const child = spawnFixtureProcess([node!, join(root, 'parser.cjs')], {
      cwd: isolated,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NODE_PATH: '' },
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('native_mcp_node_validated');
    expect(readFileSync(join(root, 'parser.cjs'), 'utf8')).not.toContain('jsonc-parser/lib/umd');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
